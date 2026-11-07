//! Real-time karaoke DSP, compiled to WebAssembly and run inside AudioWorklets.
//!
//! * `music_*`  – stereo STFT engine: spectral centre-channel vocal removal + phase-vocoder key change
//! * `voice_*`  – mono engine for each phone mic: YIN pitch tracking + optional pitch correction ("auto-tune")
//!
//! Each AudioWorklet creates its own WebAssembly instance, so the globals below are per-instance.
//! No allocator, no std: everything is fixed-size and lives in static memory, so the audio
//! thread never allocates.
#![cfg_attr(not(test), no_std)]
#![allow(static_mut_refs)]

use core::f32::consts::PI;
use libm::{atan2f, cosf, expf, floorf, log2f, powf, roundf, sinf, sqrtf};

#[cfg(not(test))]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    #[cfg(target_arch = "wasm32")]
    core::arch::wasm32::unreachable();
    #[cfg(not(target_arch = "wasm32"))]
    loop {}
}

pub const BLOCK: usize = 128; // Web Audio render quantum
const TWO_PI: f32 = 2.0 * PI;

// ───────────────────────────── FFT ─────────────────────────────
pub struct Fft<const N: usize> {
    cos: [f32; N],
    sin: [f32; N],
    rev: [u16; N],
}
impl<const N: usize> Fft<N> {
    pub const fn new() -> Self {
        Self { cos: [0.0; N], sin: [0.0; N], rev: [0; N] }
    }
    pub fn init(&mut self) {
        let bits = N.trailing_zeros();
        for i in 0..N {
            let a = TWO_PI * i as f32 / N as f32;
            self.cos[i] = cosf(a);
            self.sin[i] = sinf(a);
            self.rev[i] = ((i as u32).reverse_bits() >> (32 - bits)) as u16;
        }
    }
    /// In-place radix-2 complex FFT. `inverse` is unnormalised.
    pub fn run(&self, re: &mut [f32; N], im: &mut [f32; N], inverse: bool) {
        for i in 0..N {
            let j = self.rev[i] as usize;
            if j > i {
                re.swap(i, j);
                im.swap(i, j);
            }
        }
        let sign = if inverse { 1.0 } else { -1.0 };
        let mut len = 2;
        while len <= N {
            let half = len / 2;
            let step = N / len;
            let mut start = 0;
            while start < N {
                for k in 0..half {
                    let wr = self.cos[k * step];
                    let wi = sign * self.sin[k * step];
                    let a = start + k;
                    let b = a + half;
                    let xr = re[b] * wr - im[b] * wi;
                    let xi = re[b] * wi + im[b] * wr;
                    re[b] = re[a] - xr;
                    im[b] = im[a] - xi;
                    re[a] += xr;
                    im[a] += xi;
                }
                start += len;
            }
            len <<= 1;
        }
    }
}

fn hann<const N: usize>(w: &mut [f32; N]) {
    for i in 0..N {
        w[i] = 0.5 - 0.5 * cosf(TWO_PI * i as f32 / N as f32);
    }
}

// ─────────────────────── phase vocoder (one channel) ───────────────────────
/// Bin-shifting phase vocoder (Laroche/Dolson style, after S. M. Bernsee).
/// Works on a half spectrum (0..=N/2) in place.
pub struct PitchShifter<const N: usize> {
    last_phase: [f32; N],
    sum_phase: [f32; N],
    ana_mag: [f32; N],
    ana_freq: [f32; N],
    syn_mag: [f32; N],
    syn_freq: [f32; N],
}
impl<const N: usize> PitchShifter<N> {
    pub const fn new() -> Self {
        Self {
            last_phase: [0.0; N], sum_phase: [0.0; N], ana_mag: [0.0; N],
            ana_freq: [0.0; N], syn_mag: [0.0; N], syn_freq: [0.0; N],
        }
    }
    /// `osamp` = N / hop. `ratio` = frequency multiplier.
    pub fn process(&mut self, re: &mut [f32], im: &mut [f32], ratio: f32, osamp: f32) {
        let half = N / 2;
        let expct = TWO_PI / osamp;
        // analysis: true frequency of each bin, expressed in bins
        for k in 0..=half {
            let mag = sqrtf(re[k] * re[k] + im[k] * im[k]);
            let phase = atan2f(im[k], re[k]);
            let mut d = phase - self.last_phase[k] - k as f32 * expct;
            self.last_phase[k] = phase;
            d -= TWO_PI * roundf(d / TWO_PI); // wrap to [-pi, pi]
            self.ana_mag[k] = mag;
            self.ana_freq[k] = k as f32 + d * osamp / TWO_PI;
        }
        if (ratio - 1.0).abs() < 1e-4 {
            // Pass through, but keep the synthesis phase in step so a later shift starts cleanly.
            for k in 0..=half {
                self.sum_phase[k] = self.last_phase[k];
            }
            return;
        }
        for k in 0..=half {
            self.syn_mag[k] = 0.0;
            self.syn_freq[k] = k as f32;
        }
        for k in 0..=half {
            let idx = roundf(k as f32 * ratio) as usize;
            if idx <= half {
                // keep the strongest contributor's frequency, sum the energy
                if self.ana_mag[k] >= self.syn_mag[idx] {
                    self.syn_freq[idx] = self.ana_freq[k] * ratio;
                }
                self.syn_mag[idx] += self.ana_mag[k];
            }
        }
        for k in 0..=half {
            let dev = self.syn_freq[k] - k as f32;
            self.sum_phase[k] += k as f32 * expct + dev * TWO_PI / osamp;
            self.sum_phase[k] -= TWO_PI * floorf(self.sum_phase[k] / TWO_PI);
            re[k] = self.syn_mag[k] * cosf(self.sum_phase[k]);
            im[k] = self.syn_mag[k] * sinf(self.sum_phase[k]);
        }
        im[0] = 0.0;
        im[half] = 0.0;
    }
}

// ─────────────────────────── MUSIC ENGINE ───────────────────────────
const MN: usize = 2048;
const MHOP: usize = 512;
const MOSAMP: f32 = (MN / MHOP) as f32;
const MLAT: usize = MN - MHOP;

pub struct Music {
    fft: Fft<MN>,
    win: [f32; MN],
    in_l: [f32; MN], in_r: [f32; MN],
    out_l: [f32; MN], out_r: [f32; MN],
    acc_l: [f32; MN], acc_r: [f32; MN],
    re: [f32; MN], im: [f32; MN],
    lr: [f32; MN], li: [f32; MN], rr: [f32; MN], ri: [f32; MN],
    mask: [f32; MN],
    band: [f32; MN],
    ps_l: PitchShifter<MN>, ps_r: PitchShifter<MN>,
    rover: usize,
    sr: f32,
    pub cut: f32,       // 0..1 how much centre-panned vocal to remove
    pub width: f32,     // 0..1 how "centred" a bin must be to count as vocal (higher = stricter)
    pub ratio: f32,     // pitch ratio
    pub io_l: [f32; BLOCK], pub io_r: [f32; BLOCK],
}

impl Music {
    pub const fn new() -> Self {
        Self {
            fft: Fft::new(), win: [0.0; MN],
            in_l: [0.0; MN], in_r: [0.0; MN], out_l: [0.0; MN], out_r: [0.0; MN],
            acc_l: [0.0; MN], acc_r: [0.0; MN], re: [0.0; MN], im: [0.0; MN],
            lr: [0.0; MN], li: [0.0; MN], rr: [0.0; MN], ri: [0.0; MN],
            mask: [0.0; MN], band: [0.0; MN],
            ps_l: PitchShifter::new(), ps_r: PitchShifter::new(),
            rover: MLAT, sr: 48000.0, cut: 0.0, width: 0.6, ratio: 1.0,
            io_l: [0.0; BLOCK], io_r: [0.0; BLOCK],
        }
    }
    pub fn init(&mut self, sr: f32) {
        // all-zero is a valid state for every field; avoids a 300 KB temporary on the stack
        unsafe { core::ptr::write_bytes(self as *mut Self, 0, 1) };
        self.rover = MLAT;
        self.width = 0.6;
        self.ratio = 1.0;
        self.sr = sr;
        self.fft.init();
        hann(&mut self.win);
        self.set_band(110.0, 8000.0);
    }
    /// Vocal band with soft (half-octave) edges so kick, bass and cymbals survive.
    pub fn set_band(&mut self, lo: f32, hi: f32) {
        let bin_hz = self.sr / MN as f32;
        for k in 0..=MN / 2 {
            let f = (k as f32 * bin_hz).max(1.0);
            let lo_w = ((log2f(f / lo) + 0.5).clamp(0.0, 1.0)) as f32;
            let hi_w = ((log2f(hi / f) + 0.5).clamp(0.0, 1.0)) as f32;
            self.band[k] = lo_w * hi_w;
        }
    }
    pub fn latency(&self) -> usize { MN } // samples of delay through the engine

    pub fn process(&mut self, n: usize) {
        for i in 0..n {
            self.in_l[self.rover] = self.io_l[i];
            self.in_r[self.rover] = self.io_r[i];
            self.io_l[i] = self.out_l[self.rover - MLAT];
            self.io_r[i] = self.out_r[self.rover - MLAT];
            self.rover += 1;
            if self.rover >= MN {
                self.rover = MLAT;
                self.frame();
            }
        }
    }

    fn frame(&mut self) {
        let half = MN / 2;
        // Two real FFTs for the price of one: z = L + iR
        for k in 0..MN {
            self.re[k] = self.in_l[k] * self.win[k];
            self.im[k] = self.in_r[k] * self.win[k];
        }
        self.fft.run(&mut self.re, &mut self.im, false);
        for k in 0..=half {
            let nk = (MN - k) % MN;
            let (zr, zi, nr, ni) = (self.re[k], self.im[k], self.re[nk], self.im[nk]);
            self.lr[k] = 0.5 * (zr + nr);
            self.li[k] = 0.5 * (zi - ni);
            self.rr[k] = 0.5 * (zi + ni);
            self.ri[k] = -0.5 * (zr - nr);
        }

        // ── spectral centre extraction ──
        if self.cut > 0.0 {
            let t0 = 0.35 + 0.6 * self.width; // centre-ness threshold
            for k in 0..=half {
                let (lr, li, rr, ri) = (self.lr[k], self.li[k], self.rr[k], self.ri[k]);
                let pl = lr * lr + li * li;
                let pr = rr * rr + ri * ri;
                // 1.0 = identical in both channels (same level & phase) -> centre-panned
                let c = 2.0 * (lr * rr + li * ri) / (pl + pr + 1e-12);
                let mut m = ((c - t0) / (1.0 - t0)).clamp(0.0, 1.0);
                m = m * m * (3.0 - 2.0 * m); // smoothstep
                m *= self.band[k];
                // fast attack, slower release reduces "musical noise"
                let a = if m > self.mask[k] { 0.7 } else { 0.25 };
                self.mask[k] += (m - self.mask[k]) * a;
                let g = 1.0 - self.cut * self.mask[k];
                // mid/side: shrink only the mid part of centred bins, keep the side (stereo) intact
                let (mr, mi) = (0.5 * (lr + rr), 0.5 * (li + ri));
                let (sr_, si) = (0.5 * (lr - rr), 0.5 * (li - ri));
                self.lr[k] = sr_ + g * mr;
                self.li[k] = si + g * mi;
                self.rr[k] = -sr_ + g * mr;
                self.ri[k] = -si + g * mi;
            }
        }

        // ── key change ──
        self.ps_l.process(&mut self.lr, &mut self.li, self.ratio, MOSAMP);
        self.ps_r.process(&mut self.rr, &mut self.ri, self.ratio, MOSAMP);
        self.li[0] = 0.0; self.ri[0] = 0.0; self.li[half] = 0.0; self.ri[half] = 0.0;

        // Rebuild z = L' + iR' over the full (Hermitian) spectrum and inverse FFT
        for k in 0..=half {
            let (lr, li, rr, ri) = (self.lr[k], self.li[k], self.rr[k], self.ri[k]);
            self.re[k] = lr - ri;
            self.im[k] = li + rr;
            if k != 0 && k != half {
                self.re[MN - k] = lr + ri;
                self.im[MN - k] = -li + rr;
            }
        }
        self.fft.run(&mut self.re, &mut self.im, true);
        // hann² at 75% overlap sums to 1.5
        let scale = 1.0 / (MN as f32 * 1.5);
        for k in 0..MN {
            let w = self.win[k] * scale;
            self.acc_l[k] += self.re[k] * w;
            self.acc_r[k] += self.im[k] * w;
        }
        self.out_l[..MHOP].copy_from_slice(&self.acc_l[..MHOP]);
        self.out_r[..MHOP].copy_from_slice(&self.acc_r[..MHOP]);
        self.acc_l.copy_within(MHOP.., 0);
        self.acc_r.copy_within(MHOP.., 0);
        for k in MN - MHOP..MN {
            self.acc_l[k] = 0.0;
            self.acc_r[k] = 0.0;
        }
        self.in_l.copy_within(MHOP.., 0);
        self.in_r.copy_within(MHOP.., 0);
    }
}

// ─────────────────────────── YIN pitch tracker ───────────────────────────
const YBUF: usize = 1024; // decimated ring
const YW: usize = 512; // integration window
const YHOP: usize = 256;

pub struct Yin {
    buf: [f32; YBUF],
    lin: [f32; YBUF],
    d: [f32; YBUF],
    pos: usize,
    since: usize,
    // 2nd-order low-pass before 2:1 decimation
    b0: f32, b1: f32, b2: f32, a1: f32, a2: f32,
    x1: f32, x2: f32, y1: f32, y2: f32,
    phase: bool,
    sr_d: f32,
    pub pitch: f32,
    pub clarity: f32,
    pub rms: f32,
    pub threshold: f32,
}
impl Yin {
    pub const fn new() -> Self {
        Self {
            buf: [0.0; YBUF], lin: [0.0; YBUF], d: [0.0; YBUF], pos: 0, since: 0,
            b0: 0.0, b1: 0.0, b2: 0.0, a1: 0.0, a2: 0.0, x1: 0.0, x2: 0.0, y1: 0.0, y2: 0.0,
            phase: false, sr_d: 24000.0, pitch: 0.0, clarity: 0.0, rms: 0.0, threshold: 0.15,
        }
    }
    pub fn init(&mut self, sr: f32) {
        unsafe { core::ptr::write_bytes(self as *mut Self, 0, 1) };
        self.threshold = 0.15;
        self.sr_d = sr / 2.0;
        // RBJ low-pass at 4.5 kHz, Q = 0.707
        let w = TWO_PI * 4500.0 / sr;
        let alpha = sinf(w) / (2.0 * 0.7071);
        let cw = cosf(w);
        let a0 = 1.0 + alpha;
        self.b0 = (1.0 - cw) / 2.0 / a0;
        self.b1 = (1.0 - cw) / a0;
        self.b2 = self.b0;
        self.a1 = -2.0 * cw / a0;
        self.a2 = (1.0 - alpha) / a0;
    }
    /// Feed samples; returns true when a new estimate is ready.
    pub fn push(&mut self, x: &[f32]) -> bool {
        let mut fresh = false;
        for &s in x {
            let y = self.b0 * s + self.b1 * self.x1 + self.b2 * self.x2 - self.a1 * self.y1 - self.a2 * self.y2;
            self.x2 = self.x1; self.x1 = s; self.y2 = self.y1; self.y1 = y;
            self.phase = !self.phase;
            if !self.phase { continue; }
            self.buf[self.pos] = y;
            self.pos = (self.pos + 1) % YBUF;
            self.since += 1;
            if self.since >= YHOP {
                self.since = 0;
                self.analyse();
                fresh = true;
            }
        }
        fresh
    }
    fn analyse(&mut self) {
        for i in 0..YBUF {
            self.lin[i] = self.buf[(self.pos + i) % YBUF];
        }
        let x = &self.lin;
        let mut e = 0.0;
        for i in YBUF - YW..YBUF { e += x[i] * x[i]; }
        self.rms = sqrtf(e / YW as f32);
        let tau_min = (self.sr_d / 1100.0) as usize;
        let tau_max = ((self.sr_d / 65.0) as usize).min(YBUF - YW - 1);
        if self.rms < 0.004 {
            self.pitch = 0.0;
            self.clarity = 0.0;
            return;
        }
        // difference function + cumulative-mean normalisation
        self.d[0] = 1.0;
        let mut running = 0.0;
        for tau in 1..=tau_max {
            let mut s = 0.0;
            for j in 0..YW {
                let v = x[j] - x[j + tau];
                s += v * v;
            }
            running += s;
            self.d[tau] = if running > 0.0 { s * tau as f32 / running } else { 1.0 };
        }
        // absolute threshold, then walk to the local minimum
        let mut best = 0;
        let mut tau = tau_min.max(2);
        while tau < tau_max {
            if self.d[tau] < self.threshold {
                while tau + 1 < tau_max && self.d[tau + 1] < self.d[tau] { tau += 1; }
                best = tau;
                break;
            }
            tau += 1;
        }
        if best == 0 {
            self.pitch = 0.0;
            self.clarity = 0.0;
            return;
        }
        // parabolic interpolation
        let (a, b, c) = (self.d[best - 1], self.d[best], self.d[best + 1]);
        let den = a + c - 2.0 * b;
        let shift = if den.abs() > 1e-9 { 0.5 * (a - c) / den } else { 0.0 };
        self.pitch = self.sr_d / (best as f32 + shift);
        self.clarity = (1.0 - b).clamp(0.0, 1.0);
    }
}

// ─────────────────────────── VOICE ENGINE ───────────────────────────
const VN: usize = 1024;
const VHOP: usize = 256;
const VOSAMP: f32 = (VN / VHOP) as f32;
const VLAT: usize = VN - VHOP;
const MAJOR: [u8; 7] = [0, 2, 4, 5, 7, 9, 11];

pub struct Voice {
    yin: Yin,
    fft: Fft<VN>,
    win: [f32; VN],
    inf: [f32; VN], outf: [f32; VN], acc: [f32; VN],
    re: [f32; VN], im: [f32; VN],
    ps: PitchShifter<VN>,
    rover: usize,
    ratio: f32,
    pub tune: f32,   // 0 = off, 1 = full correction
    pub speed: f32,  // 0 = slow/natural .. 1 = instant "robot"
    pub key: i32,    // -1 chromatic, 0..11 = major key root (C..B)
    pub target: f32,
    pub io: [f32; BLOCK],
}
impl Voice {
    pub const fn new() -> Self {
        Self {
            yin: Yin::new(), fft: Fft::new(), win: [0.0; VN],
            inf: [0.0; VN], outf: [0.0; VN], acc: [0.0; VN], re: [0.0; VN], im: [0.0; VN],
            ps: PitchShifter::new(), rover: VLAT, ratio: 1.0,
            tune: 0.0, speed: 0.6, key: -1, target: 0.0, io: [0.0; BLOCK],
        }
    }
    pub fn init(&mut self, sr: f32) {
        unsafe { core::ptr::write_bytes(self as *mut Self, 0, 1) };
        self.rover = VLAT;
        self.ratio = 1.0;
        self.speed = 0.6;
        self.key = -1;
        self.yin.init(sr);
        self.fft.init();
        hann(&mut self.win);
    }
    fn snap(&self, hz: f32) -> f32 {
        let midi = 69.0 + 12.0 * log2f(hz / 440.0);
        let mut best = roundf(midi);
        if self.key >= 0 {
            let mut bd = 99.0;
            let base = floorf(midi) as i32;
            for cand in base - 2..=base + 2 {
                let pc = (cand - self.key).rem_euclid(12) as u8;
                if MAJOR.contains(&pc) {
                    let d = (cand as f32 - midi).abs();
                    if d < bd { bd = d; best = cand as f32; }
                }
            }
        }
        440.0 * powf(2.0, (best - 69.0) / 12.0)
    }
    pub fn process(&mut self, n: usize) {
        if self.yin.push(&self.io[..n]) {
            let p = self.yin.pitch;
            let want = if p > 0.0 && self.yin.clarity > 0.6 && self.tune > 0.0 {
                self.target = self.snap(p);
                let full = self.target / p;
                powf(full, self.tune) // partial correction = fraction of the way (in log space)
            } else {
                self.target = 0.0;
                1.0
            };
            // glide: speed 1 -> instant, 0 -> ~150 ms
            let coef = 1.0 - expf(-(0.05 + 4.0 * self.speed * self.speed));
            self.ratio += (want - self.ratio) * coef;
        }
        if self.tune <= 0.0 && (self.ratio - 1.0).abs() < 1e-3 {
            return; // bypass: zero added latency when correction is off
        }
        for i in 0..n {
            self.inf[self.rover] = self.io[i];
            self.io[i] = self.outf[self.rover - VLAT];
            self.rover += 1;
            if self.rover >= VN {
                self.rover = VLAT;
                self.frame();
            }
        }
    }
    fn frame(&mut self) {
        for k in 0..VN {
            self.re[k] = self.inf[k] * self.win[k];
            self.im[k] = 0.0;
        }
        self.fft.run(&mut self.re, &mut self.im, false);
        self.ps.process(&mut self.re, &mut self.im, self.ratio, VOSAMP);
        for k in 1..VN / 2 {
            self.re[VN - k] = self.re[k];
            self.im[VN - k] = -self.im[k];
        }
        self.fft.run(&mut self.re, &mut self.im, true);
        let scale = 1.0 / (VN as f32 * 1.5);
        for k in 0..VN {
            self.acc[k] += self.re[k] * self.win[k] * scale;
        }
        self.outf[..VHOP].copy_from_slice(&self.acc[..VHOP]);
        self.acc.copy_within(VHOP.., 0);
        for k in VN - VHOP..VN { self.acc[k] = 0.0; }
        self.inf.copy_within(VHOP.., 0);
    }
}

// ─────────────────────────── C ABI exports ───────────────────────────
static mut MUSIC: Music = unsafe { core::mem::zeroed() }; // lives in .bss, set up by music_init
static mut VOICE: Voice = unsafe { core::mem::zeroed() };

#[unsafe(no_mangle)] pub extern "C" fn music_init(sr: f32) { unsafe { MUSIC.init(sr) } }
#[unsafe(no_mangle)] pub extern "C" fn music_left() -> *mut f32 { unsafe { MUSIC.io_l.as_mut_ptr() } }
#[unsafe(no_mangle)] pub extern "C" fn music_right() -> *mut f32 { unsafe { MUSIC.io_r.as_mut_ptr() } }
#[unsafe(no_mangle)] pub extern "C" fn music_process(n: u32) { unsafe { MUSIC.process((n as usize).min(BLOCK)) } }
#[unsafe(no_mangle)] pub extern "C" fn music_set_cut(v: f32) { unsafe { MUSIC.cut = v.clamp(0.0, 1.0) } }
#[unsafe(no_mangle)] pub extern "C" fn music_set_width(v: f32) { unsafe { MUSIC.width = v.clamp(0.0, 1.0) } }
#[unsafe(no_mangle)] pub extern "C" fn music_set_semitones(st: f32) { unsafe { MUSIC.ratio = powf(2.0, st.clamp(-12.0, 12.0) / 12.0) } }
#[unsafe(no_mangle)] pub extern "C" fn music_set_band(lo: f32, hi: f32) { unsafe { MUSIC.set_band(lo, hi) } }
#[unsafe(no_mangle)] pub extern "C" fn music_latency() -> u32 { unsafe { MUSIC.latency() as u32 } }

#[unsafe(no_mangle)] pub extern "C" fn voice_init(sr: f32) { unsafe { VOICE.init(sr) } }
#[unsafe(no_mangle)] pub extern "C" fn voice_io() -> *mut f32 { unsafe { VOICE.io.as_mut_ptr() } }
#[unsafe(no_mangle)] pub extern "C" fn voice_process(n: u32) { unsafe { VOICE.process((n as usize).min(BLOCK)) } }
#[unsafe(no_mangle)] pub extern "C" fn voice_pitch() -> f32 { unsafe { VOICE.yin.pitch } }
#[unsafe(no_mangle)] pub extern "C" fn voice_clarity() -> f32 { unsafe { VOICE.yin.clarity } }
#[unsafe(no_mangle)] pub extern "C" fn voice_rms() -> f32 { unsafe { VOICE.yin.rms } }
#[unsafe(no_mangle)] pub extern "C" fn voice_target() -> f32 { unsafe { VOICE.target } }
#[unsafe(no_mangle)] pub extern "C" fn voice_set_tune(amount: f32, speed: f32, key: i32) {
    unsafe { VOICE.tune = amount.clamp(0.0, 1.0); VOICE.speed = speed.clamp(0.0, 1.0); VOICE.key = key.clamp(-1, 11); }
}

// ─────────────────────────── tests (native) ───────────────────────────
#[cfg(test)]
mod tests {
    use super::*;
    extern crate std;
    use std::boxed::Box;

    fn run_music(m: &mut Music, l: &[f32], r: &[f32]) -> (std::vec::Vec<f32>, std::vec::Vec<f32>) {
        let (mut ol, mut or) = (std::vec![], std::vec![]);
        for c in 0..l.len() / BLOCK {
            m.io_l.copy_from_slice(&l[c * BLOCK..(c + 1) * BLOCK]);
            m.io_r.copy_from_slice(&r[c * BLOCK..(c + 1) * BLOCK]);
            m.process(BLOCK);
            ol.extend_from_slice(&m.io_l);
            or.extend_from_slice(&m.io_r);
        }
        (ol, or)
    }
    fn rms(x: &[f32]) -> f32 { (x.iter().map(|v| v * v).sum::<f32>() / x.len() as f32).sqrt() }
    fn tone(f: f32, n: usize, sr: f32) -> std::vec::Vec<f32> { (0..n).map(|i| (TWO_PI * f * i as f32 / sr).sin() * 0.5).collect() }

    #[test]
    fn passthrough_is_transparent() {
        let mut m = Box::new(Music::new());
        m.init(48000.0);
        let sr = 48000.0; let n = 48000;
        let l = tone(440.0, n, sr); let r = tone(660.0, n, sr);
        let (ol, or) = run_music(&mut m, &l, &r);
        let lat = m.latency();
        let err: f32 = (8000..40000).map(|i| (ol[i] - l[i - lat]).abs() + (or[i] - r[i - lat]).abs()).fold(0.0, f32::max);
        assert!(err < 1e-3, "max err {err}");
    }

    #[test]
    fn removes_centre_keeps_sides() {
        let mut m = Box::new(Music::new());
        m.init(48000.0);
        m.cut = 1.0;
        let sr = 48000.0; let n = 48000;
        let voc = tone(523.0, n, sr);            // centre-panned "vocal"
        let gtr = tone(330.0, n, sr);            // hard-left "guitar"
        let l: std::vec::Vec<f32> = voc.iter().zip(&gtr).map(|(a, b)| a + b).collect();
        let r = voc.clone();
        let (ol, or) = run_music(&mut m, &l, &r);
        let (o_l, o_r) = (&ol[16000..44000], &or[16000..44000]);
        // right channel had only the vocal -> should be strongly attenuated
        assert!(rms(o_r) < 0.25 * rms(&r[16000..44000]), "right rms {}", rms(o_r));
        // left keeps most of the guitar
        assert!(rms(o_l) > 0.6 * rms(&gtr[16000..44000]), "left rms {}", rms(o_l));
    }

    #[test]
    fn pitch_shift_up_an_octave() {
        let mut m = Box::new(Music::new());
        m.init(48000.0);
        m.ratio = 2.0;
        let mut y = Box::new(Yin::new()); y.init(48000.0);
        let x = tone(220.0, 48000, 48000.0);
        let (ol, _) = run_music(&mut m, &x, &x);
        y.push(&ol[20000..30000]);
        assert!((y.pitch - 440.0).abs() < 8.0, "got {}", y.pitch);
    }

    #[test]
    fn yin_detects_voice_range() {
        for f in [82.0, 196.0, 440.0, 880.0] {
            let mut y = Box::new(Yin::new()); y.init(48000.0);
            // harmonic-rich tone
            let x: std::vec::Vec<f32> = (0..9600).map(|i| {
                let t = TWO_PI * f * i as f32 / 48000.0;
                0.3 * t.sin() + 0.2 * (2.0 * t).sin() + 0.1 * (3.0 * t).sin()
            }).collect();
            y.push(&x);
            assert!((y.pitch - f).abs() / f < 0.01, "f {f} got {}", y.pitch);
        }
    }

    #[test]
    fn autotune_pulls_to_semitone() {
        let mut v = Box::new(Voice::new());
        v.init(48000.0);
        v.tune = 1.0; v.speed = 1.0;
        let f = 452.0; // between A4 (440) and A#4 (466) - nearer A
        let x = tone(f, 48000, 48000.0);
        let mut out = std::vec![];
        for c in 0..x.len() / BLOCK {
            v.io.copy_from_slice(&x[c * BLOCK..(c + 1) * BLOCK]);
            v.process(BLOCK);
            out.extend_from_slice(&v.io);
        }
        let mut y = Box::new(Yin::new()); y.init(48000.0);
        y.push(&out[30000..40000]);
        assert!((y.pitch - 440.0).abs() < 4.0, "got {}", y.pitch);
    }
}
