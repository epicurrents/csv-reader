CSV signal reader for Epicurrents
=================================

A signal reader for time-aligned CSV (and TSV) recordings.  Parses the whole file on `setupStudy`, materialises one `Float32Array` per channel, and exposes the parsed signals through the standard `GenericSignalReader` cache machinery — so cascade montage, trends, and derivations work the same as for binary formats like EDF.

Non-streaming by design.  CSV row layout is variable-length and the time column has to be fully read to establish the sampling-rate contract; loading the entire file up front is the only honest answer.  Accelerometry use cases (minutes-to-hours at 100 Hz) sit well within the cache budget; a future streaming variant could land alongside without changing the importer contract.

Wire format
-----------

```
# optional: key: value metadata block (lines starting with '#')
# subject_id: 042
# sensor: wrist-imu
time,wrist_x[g],wrist_y[g],wrist_z[g]
0,0.01,-0.03,0.98
0.01,0.02,-0.02,0.97
...
```

- **Time column** — required; must be called `time` or `t` (case-insensitive, configurable via `CsvParseOptions.timeColumnNames`).  Values in seconds, monotonic.  Sampling rate is inferred from the median inter-row delta; spread beyond `samplingJitterTolerance` (default 10 %) earns a warning but isn't fatal.
- **Channel columns** — `<label>[<unit>]` syntax.  Bracketed unit is optional; an unannotated column gets `unit: ''` and the resource treats it as unitless (no `getSignalScale` conversion).
- **Metadata block** — optional `#`-prefixed lines at the top, parsed as `key: value` pairs into `CsvHeader.metadata`.

Public surface
--------------

- `parseHeader(text, options?)` — read the metadata block + column header row only.  Cheap; the importer uses it on the first ~4 KB to populate `study.meta` without materialising signals.
- `parseFile(text, options?)` — full parse with per-column `Float32Array`s and the time vector.
- `CsvImporter` — extends `GenericStudyImporter`.  Default file extensions: `.csv`, `.tsv`.  Use a `tab` delimiter via `CsvParseOptions.delimiter = '\t'`.
- `CsvReader` — extends `GenericSignalReader`.  Overrides `_readSignalPart` to slice from the parsed arrays directly; no binary decoder, no further IO during cache fill.
- `CsvWorkerSubstitute` — main-thread fallback when no SAB is available. It answers a subset of the worker's commissions and reports the rest as unsupported, so a path that needs one of them fails visibly rather than waiting.

Constraints
-----------

- Single sampling rate per file.  Multi-rate CSVs need a manual split.
- Whole file loaded in memory.  Adequate for typical signal recordings; not a streaming reader.
- No interruption handling.  CSV doesn't carry an annotation channel, and gap-aware time vectors aren't yet inferred from non-uniform deltas — the jitter warning is the only signal.

See `src/types/index.ts` for `CsvParseOptions`, `CsvHeader`, `CsvParseResult`, and `CsvColumn`.
