# Specs

These documents describe how Living-Room Karaoke works **today** and the rules for changing it. Treat them as the source of truth: when code and a spec disagree, either the code has a bug or the spec needs updating in the same PR.

| # | Spec | What it covers |
|---|---|---|
| 00 | [Product](00-product.md) | Goals, users, principles, non-goals |
| 01 | [Architecture](01-architecture.md) | Processes, ports, audio graph, state, file layout |
| 02 | [Protocol](02-protocol.md) | Every WebSocket message and REST endpoint |
| 03 | [DSP engine](03-dsp.md) | Rust/WASM ABI, algorithms, parameters, latency |
| 04 | [Playback & sources](04-playback-and-sources.md) | Local files, Spotify, karaoke-version finder, lyrics |
| 05 | [Singing trainer](05-training.md) | Scoring, reports, tuner, drills, key suggestion, loop/speed |
| 06 | [Testing](06-testing.md) | Unit, DSP, end-to-end and manual device tests |
| 07 | [Roadmap](07-roadmap.md) | Known limitations and prioritised backlog |
| 08 | [YouTube](08-youtube.md) | YouTube search, links, embedded player |
| — | [Template](TEMPLATE.md) | Copy this to propose a new feature |

## Working with specs

1. **New feature:** copy `TEMPLATE.md` to `NN-feature-name.md` (or add a section to an existing spec if it's small). Set `Status: Draft`, open a PR with the spec alone or together with the code.
2. **Change behaviour:** update the relevant spec in the same PR. Protocol changes (02) must list the new or changed messages and stay backward compatible within a release, because phones may have an old page cached.
3. **Numbers are contracts.** Thresholds, tolerances and limits in these specs (e.g. "on the note = within 0.75 semitones") are what tests assert. Change both together.
4. **Status values:** `Draft` → `Accepted` → `Implemented` → (`Deprecated`).

Spec language: **MUST** = required, **SHOULD** = expected unless there's a stated reason, **MAY** = optional.
