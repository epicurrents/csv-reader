# @epicurrents/csv-reader — roadmap

Work left open by the audit pass that landed the SI normalisation, plus findings carried in from the sibling packages. The package has not had a full audit, so this is not a complete list of what is open — only of what is already known.

## The worker substitute answers five of the thirteen commissions the worker does

`CsvWorkerSubstitute` implements `cache-signals`, `get-signals`, `set-signal-polarity`, `setup-cache` and `setup-worker`. The worker it stands in for answers those plus `release-cache`, `release-signal-arrays`, `request-signals`, `reset-network`, `set-buffer-range`, `set-interruptions`, `shutdown` and `update-settings`, the last of which core's base substitute now answers for every substitute. The other seven reach the base, which warns and returns a failure.

A failed commission rejects rather than resolving false, so this is not a silent degradation. `GenericService.shutdown` awaits the `shutdown` reply before terminating the worker and clearing its commissions, and `unload` awaits `release-cache` before releasing from the memory manager: both throw on the substitute path, and neither tear-down runs. The substitute is the fallback for an origin without cross-origin isolation, so a deployment that cannot use `SharedArrayBuffer` is the one that cannot close a CSV study.

The same gap is in `wav-reader` and `nic-reader`, which implement the same five. `edf-reader` implements ten and `natus-reader` eight, so no two substitutes in the family agree on the vocabulary — which is the actual defect. The convergent fix belongs in core: a signal-reader substitute base that answers the reader vocabulary by delegating to the reader it wraps, mirroring `SignalReaderWorker` on the worker side, leaving each package's substitute with `setup-worker` and whatever its format adds.

## The importer creates an object URL per file and never revokes it

`importFile` stores `URL.createObjectURL(file)` on the study file whenever the caller supplies no URL of its own, and nothing in the family revokes one. The blob it pins stays alive for the life of the document, including on the failure path, where the URL is minted before the parse that then returns null. The reader never reads it back — the parse happens on the buffer already in hand — so the question to settle is whether a study file needs the URL at all, rather than where to revoke it.

## A UTF-32 source fails three different ways

`detectTextEncoding` recognises a UTF-32 byte-order mark and returns the label `utf-32`, for which the encoding standard registers no decoder, so `new TextDecoder('utf-32')` throws a `RangeError`. This package constructs a decoder directly at three sites and each answers differently: `importFile` and `importUrl` catch it and log a CSV parse error, which names the wrong cause; `readHeader` propagates it as a rejection; `CsvReader.setupStudy` takes the encoding from `fetchTextFile` and never constructs one itself.

Core already has the guarded form — `textDecoderFor` logs the unsupported encoding and returns null — but it is module-private in core's text utilities and not exported, so no package can reach it. Exporting it and routing these three sites through it is the fix, and it belongs to core rather than here, since every reader that decodes text has the same three sites.

## The empty-slice branch in `_readSignalPart` cannot be reached

`_readSignalPart` floors the requested start to a sample index and ceilings the end, then returns `{ signals: [], start, end }` when the end index is not past the start. The guards above it make that impossible: the start is already known to be inside the recording, so its floored index is at most `totalSamples - 1`, and an end strictly greater than the start ceilings to at least one index past the floored start. The branch is the one uncovered line the coverage report names in [src/csv/CsvReader.ts](src/csv/CsvReader.ts), and the test that used to cover it was asserting a rounding rule the reader does not apply.

Nothing is wrong with the reader — a window narrower than one sampling interval returns the sample it falls in, which is what a caller asking for a sub-sample range wants. The open question is whether to keep the guard as a statement of the invariant or drop it so the coverage report stops naming a line no input reaches.

## The worker and the substitute are untested

`CsvImporter`, `CsvParser` and `CsvReader` are covered; `CsvWorkerSubstitute` and `csv.worker.ts` are at zero. The commission vocabulary above is exactly what a test here would pin — that every action the worker answers, the substitute answers too — so the two are worth writing together with whatever shape the fix takes.
