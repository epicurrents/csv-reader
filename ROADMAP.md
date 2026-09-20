# @epicurrents/csv-reader — roadmap

Work left open by the audit pass that landed the SI normalisation, plus findings carried in from the sibling packages. The package has not had a full audit, so this is not a complete list of what is open — only of what is already known.

## The importer creates an object URL per file and never revokes it

`importFile` stores `URL.createObjectURL(file)` on the study file whenever the caller supplies no URL of its own, and nothing in the family revokes one. The blob it pins stays alive for the life of the document, including on the failure path, where the URL is minted before the parse that then returns null. The reader never reads it back — the parse happens on the buffer already in hand — so the question to settle is whether a study file needs the URL at all, rather than where to revoke it.

## A UTF-32 source fails three different ways

`detectTextEncoding` recognises a UTF-32 byte-order mark and returns the label `utf-32`, for which the encoding standard registers no decoder, so `new TextDecoder('utf-32')` throws a `RangeError`. This package constructs a decoder directly at three sites and each answers differently: `importFile` and `importUrl` catch it and log a CSV parse error, which names the wrong cause; `readHeader` propagates it as a rejection; `CsvReader.setupStudy` takes the encoding from `fetchTextFile` and never constructs one itself.

Core already has the guarded form — `textDecoderFor` logs the unsupported encoding and returns null — but it is module-private in core's text utilities and not exported, so no package can reach it. Exporting it and routing these three sites through it is the fix, and it belongs to core rather than here, since every reader that decodes text has the same three sites.

## The empty-slice branch in `_readSignalPart` cannot be reached

`_readSignalPart` floors the requested start to a sample index and ceilings the end, then returns `{ signals: [], start, end }` when the end index is not past the start. The guards above it make that impossible: the start is already known to be inside the recording, so its floored index is at most `totalSamples - 1`, and an end strictly greater than the start ceilings to at least one index past the floored start. The branch is the one uncovered line the coverage report names in [src/csv/CsvReader.ts](src/csv/CsvReader.ts), and the test that used to cover it was asserting a rounding rule the reader does not apply.

Nothing is wrong with the reader — a window narrower than one sampling interval returns the sample it falls in, which is what a caller asking for a sub-sample range wants. The open question is whether to keep the guard as a statement of the invariant or drop it so the coverage report stops naming a line no input reaches.

## The worker is untested

`CsvImporter`, `CsvParser`, `CsvReader` and `CsvWorkerSubstitute` are covered; `csv.worker.ts` is at zero. Its `setup-worker` is the same method the substitute's tests exercise, so what is left uncovered is the worker's own wiring — that the reader's cache-fill updates are posted, and that the class registers `setup-worker` against the reader it was constructed with.
