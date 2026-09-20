# @epicurrents/csv-reader — roadmap

Work left open by the audit pass that landed the SI normalisation, plus findings carried in from the sibling packages. The package has not had a full audit, so this is not a complete list of what is open — only of what is already known.

## Three tests are red, and all three are stale expectations

`npm run test` reports 38 passing and 3 failing, every one of them in [tests/csv/CsvReader.test.ts](tests/csv/CsvReader.test.ts). None of the three describes a defect in the reader.

**Two encode pre-normalisation sample values.** The fixture's columns are headed `wrist_x[g]`, and the parser now multiplies by `getSignalScale('g')` so the reader emits m/s². The slice test still expects `[4, 7]` where the reader produces `[39.2266, 68.6466]`, and the empty-slice test reports the same values in its diff. Update the expectations to the normalised values rather than reverting the scaling — the normalisation is the behaviour the ACC module was built against.

**One asserts the recording length where the code documents a data length.** `wires data-unit fields for the cache-fill loop` expects `_totalDataLength` to be the 0.03 s time-vector span and gets 1. The reader is right: the comment above the assignment in [src/csv/CsvReader.ts](src/csv/CsvReader.ts) sets out why `_totalDataLength` is padded up to whole one-second data units while `_totalRecordingLength` carries the true extent, and the test's own next line — asserting `_totalRecordingLength` is 0.03 — passes. Change the expectation to 1 and keep the second assertion as the one that pins the real duration.

The empty-slice test also encodes a rounding rule the reader does not use. Its comment reasons from ceiling both ends of the window; `_readSignalPart` floors the start and ceilings the end, so `[0.029, 0.0291)` covers sample 2 rather than nothing. Flooring the start is what makes a slice cover the window it was asked for, so the test is what should move.

## The lint script checks nothing

There is no eslint configuration file in the package, and the declared eslint is `^8.55.0`. Two independent reasons the script is inert: `eslint src` under eslint 8 matches only `.js` files, of which `src/` has none, so it exits reporting no files matched; and adding `--ext .ts` gets as far as "ESLint couldn't find a configuration file".

The fix is the migration the audited packages took — core's flat config, eslint 9, the current `@typescript-eslint`. Budget the triage separately from the setup; the first working run on acc-module reported findings in the dozens after the stylistic rules were reconciled.

## The declared core range excludes the core this builds against

`package.json` asks for `@epicurrents/core: ^1.0.0` in both `devDependencies` and `peerDependencies`, and core is at 2.0.0. The workspace symlink resolves core from the checkout regardless, so nothing fails locally and the range is only load-bearing for a consumer installing from the registry.

Fifteen of the seventeen dependent packages carry the same stale range; only the two opened by the current audit sweep have been moved to `^2.0.0`. The family view of it is in the builder's roadmap.
