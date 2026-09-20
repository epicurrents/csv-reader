# @epicurrents/csv-reader — architecture notes for AI coding assistants

This file is the entry point for AI coding assistants working in the `@epicurrents/csv-reader` package: a reader for time-aligned CSV and TSV signal recordings. It is tool-agnostic.

The package follows the reader pattern that [edf-reader's AGENTS.md](../edf-reader/AGENTS.md) documents as the reference implementation — the same `src/` layout, the same importer / reader / worker / substitute decomposition and the same worker-bundle contract. Read that file for the shared pattern; this file covers only what CSV adds, and [README.md](README.md) carries the wire format and the public surface.

## Toolchain compliance — HIGH PRIORITY

This package depends on `@epicurrents/core` and shares a single toolchain with it. **Never pin package-specific versions that diverge from the canonical set** — a divergent TypeScript produces structurally incompatible `.d.ts` files that type-check locally but corrupt data at runtime, because the worker bundle and the main-thread code can then disagree on data layouts while everything still compiles.

| Tool | Version |
|---|---|
| `@epicurrents/core` | `^2.0.0` |
| TypeScript | `^5.7.0` |
| Vite | `^7.3.1` |
| ESLint | `^9.19.0`, flat config in [eslint.config.mjs](eslint.config.mjs) |
| tsconfig base | extends `@epicurrents/core/tsconfig.base.json` |

```bash
npm run build          # build:workers then build:tsc — produces BOTH outputs
npm run build:workers  # vite → umd/csv.worker.js, the standalone bundle
npm run build:tsc      # vite + epicurrents-build-types → dist/, carrying the worker inlined
npm run lint           # eslint src — currently clean, keep it that way
npm test               # vitest run --coverage
```

Both outputs must be regenerated together after any shared-code change: `dist/` carries the worker inlined and `umd/` holds the standalone bundle, so rebuilding one leaves a mismatch the type system cannot see.

The core version appears in `devDependencies`, `peerDependencies` and in the APIs the source actually calls, and the three must agree. The workspace symlinks core rather than installing it, so a stale range builds perfectly against whatever is checked out and only an external consumer sees the mismatch. Bump the range in the same commit as any change that depends on a new core API.

## Non-streaming by design

Every other reader in the family decodes a file part at a time: a binary format exposes fixed-size data units, so `_readSignalPart` can fetch and decode the range it was asked for. CSV cannot. Row layout is variable-length, and the sampling rate is inferred from the time column, which means the column has to be read in full before any part of the recording can be placed on a timeline.

So the file is parsed once, at `setupStudy`, into one `Float32Array` per channel, and `_readSignalPart` returns `subarray` views over those. There is no decoder and no IO during cache fill. The consequence to keep in mind when editing: **the file is parsed twice per study**, once by `CsvImporter` on the main thread so `study.meta` carries the channel descriptors a resource needs at construction, and once inside the worker so it has its own copy of the arrays. That is deliberate — the parsed arrays are not transferable across the thread boundary at the point the importer runs — but it means a change to the parser affects both, and a parse that succeeds in one place and fails in the other is a contradiction worth chasing rather than patching on one side.

## Samples are normalised to SI on parse

`CsvParser` multiplies every sample by `getSignalScale(column.unit)`, so a column headed `[g]` is stored in m/s² and one headed `[uV]` in volts — the same normalisation every other reader applies on decode. The column's `unit` field keeps the annotation **as written**, because that is what a consumer displays against.

The trap this sets for tests and fixtures: a fixture headed in `g` and a test asserting the CSV's own numbers disagree by a factor of 9.80665, and the failure reads as a parser bug rather than a stale expectation. Assert against the scaled value, with the scale named, as [tests/csv/CsvReader.test.ts](tests/csv/CsvReader.test.ts) does.

An unannotated column gets `unit: ''`, whose scale is 1.

## Two lengths, derived differently

`_totalDataLength` and `_totalRecordingLength` answer different questions and are computed from different quantities. The cache extent is padded up to whole one-second data units, because the mutex stores its range end as an `Int32` and the cache-fill loop compares a `Float32` round-trip against it; the reported extent is `sampleCount / samplingRate`, the true data extent, which may end mid-unit.

Reporting the padded length as the recording length advertises a phantom partial-second tail, and the per-page filter then rings across the data-to-empty boundary inside it. The full reasoning is in the comment above the assignment in [src/csv/CsvReader.ts](src/csv/CsvReader.ts); keep the two fields distinct when touching that block, and note that a test asserting one against the other's value is asserting the bug.

## The worker and the substitute run the same handlers

`CsvWorker` extends core's `SignalReaderWorker` and `CsvWorkerSubstitute` extends core's `SignalReaderWorkerSubstitute`, which runs those same handlers on the main thread with the reply transport redirected. The shared vocabulary therefore cannot differ between the two, which is the property that matters: an unanswered commission is reported as a failure, a failed commission rejects, and the service awaits one before tearing a study down, so a substitute missing a handler does not degrade a study but makes it impossible to close.

What each class adds is `setup-worker`, the one commission where formats differ because it is where the file is opened. **Those two method bodies are identical and must stay so** — they are the only place a divergence is still possible here. Write the handler against `this._validate`, `this._success` and `this._failure`, which both bases provide with the same signatures, and it can be moved between them unchanged.

## Internal path aliases

Two alias tables have to agree, and they are not written the same way. [tsconfig.json](tsconfig.json) maps `#*` to `src/*` — a wildcard, so any name resolves. `ALIASES` in [vite.shared.mjs](vite.shared.mjs) enumerates the directories in a regular expression, because the package declares no `imports` field and an unlisted alias has nothing to fall through to.

The asymmetry means **a new top-level directory under `src/` type-checks and fails to build**: `tsc` resolves `#newdir` through the wildcard while Vite and Vitest do not. Add the name to the regex in [vite.shared.mjs](vite.shared.mjs) in the same commit that creates the directory.

## Tests

`npm test` runs Vitest; `vitest` and `@vitest/coverage-v8` come from the workspace root rather than this package's own `devDependencies`. Coverage is configured with `all: true` over `src/**`, so an untested file reports zero rather than vanishing from the report — the percentage describes the package, not the tested corner of it.

The suites mock `@epicurrents/core` with minimal stand-ins for the base classes rather than booting the real ones. When a mock is missing an export the source reaches for, the failure arrives as a parse error logged by the code under test rather than as a module-resolution error, so read what `Log.error` was called with before concluding the production code is wrong.

## Code comment conventions

Comments and docstrings describe the code's **current contract** — what it does and the invariants it upholds, for a reader who has never seen an earlier version.

- **No change history, migration state or roadmap phases.** Don't narrate what the code used to do or what a change replaced; a reader has no way to date the remark. That belongs in the commit message, where `git blame` surfaces it.
- **Describe the layer's own contract, not its consumers.** State the invariant the layer guarantees so it holds regardless of who calls it.
- **Keep the `@package` / `@copyright` / `@license` header** on every source file.
- **Wrap TypeScript source at a 120-column soft cap** — code, docstrings and comments alike. The one exception: `@param` docstrings stay on a single line regardless of length, because wrapping them renders poorly in the VS Code hover. Do not hard-wrap Markdown prose: one line per paragraph, since docs are read as rendered output at varying widths.
