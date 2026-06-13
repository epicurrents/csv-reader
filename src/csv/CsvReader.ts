/**
 * CSV signal reader. Extends `GenericSignalReader` for the SAB / cache / derivation
 * machinery; uses the pure {@link CsvParser} for the actual parsing and
 * `@epicurrents/core/util`'s text utilities for fetch + decode.
 *
 * Design — CSV is non-streaming. Unlike binary formats (EDF, WAV) that expose
 * fixed-size data units and can be read progressively via HTTP `Range:`, a CSV
 * file's row layout is variable-length and the time column must be fully read to
 * establish the sampling-rate contract. So this reader loads the file once on
 * `setupStudy`, parses it into per-column `Float32Array`s, and `_readSignalPart`
 * just slices those arrays — no further IO during cache fill. For accelerometry
 * (typical use case: minutes-to-hours of 100 Hz data) this is well below the
 * memory budget; for very large files a future streaming variant could land
 * alongside this one without changing the importer/header contract.
 *
 * @package    epicurrents/csv-reader
 * @copyright  2026 Sampsa Lohi
 * @license    Apache-2.0
 */

import {
    GenericSignalReader,
} from '@epicurrents/core'
import { detectTextEncoding, fetchTextFile } from '@epicurrents/core/dist/util'
import type {
    AppSettings,
    SignalCachePart,
    SignalDataReader,
    SignalDecodeResult,
} from '@epicurrents/core/dist/types'
import { Log } from 'scoped-event-log'
import { parseFile } from './CsvParser'
import { headerToBiosignalHeader } from '#root/src/util'
import type {
    CsvHeader,
    CsvParseOptions,
    CsvParseResult,
} from '#types'

const SCOPE = 'CsvReader'

export default class CsvReader extends GenericSignalReader implements SignalDataReader {

    /** Fully parsed CSV — populated once during `setupStudy`. */
    protected _csvData: CsvParseResult | null = null
    /** Parsed CSV header, retained alongside `_csvData` for convenient access. */
    protected _fileTypeHeader: CsvHeader | null = null
    /** Parser knobs (delimiter, time-column candidates, jitter tolerance). */
    protected _parseOptions: CsvParseOptions
    /** Update channel back to the main thread (set by the worker). */
    protected _updateCallback: ((update: { [prop: string]: unknown }) => void) | null = null

    constructor (settings: AppSettings, parseOptions: CsvParseOptions = {}) {
        // The reader's `dataEncoding` slot is the typed-array used for the raw
        // file bytes; CSV is text so we use Uint8Array (overridden to UTF-16/32
        // by the encoding-detection step on first read). `SETTINGS` is set on
        // the base class by passing it through the constructor.
        super(Uint8Array, settings)
        this._parseOptions = parseOptions
    }

    /**
     * Fetch + parse the entire CSV, then populate the inherited data-unit
     * fields so the base reader's cache-fill loop can drive `_readSignalPart`
     * (which we override to slice from the parsed Float32Arrays — no further
     * IO during cache fill). After this returns true, the resource can call
     * `setupCache` / `setupMutex` and signal serving works.
     *
     * @param url - Source URL of the CSV file.
     * @param authHeader - Optional `Authorization` header to forward on the fetch.
     */
    async setupStudy (url: string, authHeader?: string): Promise<boolean> {
        if (this._mutex || this._fallbackCache) {
            Log.error(
                [`Could not set study parameters.`, `Signal cache has already been initialized.`],
                SCOPE,
            )
            return false
        }
        const fetched = await fetchTextFile(url, { authHeader })
        if (!fetched) {
            return false
        }
        const text = await fetched.file.text()
        const parsed = parseFile(text, this._parseOptions)
        if (!parsed) {
            Log.error(`CSV parse failed for ${url}.`, SCOPE)
            return false
        }
        this._csvData = parsed
        this._fileTypeHeader = parsed.header
        // Translate the parsed CSV header into the BiosignalHeaderRecord the
        // base class drives its cache layout off of. From this point the
        // inherited `setupCache`/`setupMutex`/`cacheSignals` machinery treats
        // the CSV like any other reader-backed source.
        this._header = headerToBiosignalHeader(parsed.header, url)
        // Data-unit shape — same 1-second granularity wav-reader uses. The
        // exact `_dataUnitSize` isn't byte-meaningful for CSV (rows are
        // variable-length text), but the cache-fill loop needs a non-zero
        // value as a precondition; we set it to the equivalent uncompressed
        // Float32 byte count per second so the rolling-cache budgeter sees
        // the right memory footprint.
        this._dataUnitDuration = 1
        this._dataUnitSize = parsed.header.samplingRate*parsed.header.columns.length*4
        this._chunkUnitCount = this._dataUnitSize*2 < this.SETTINGS.app.dataChunkSize
            ? Math.floor(this.SETTINGS.app.dataChunkSize/this._dataUnitSize) - 1
            : 1
        // `_totalDataLength`, `_totalRecordingLength`, and `_dataUnitCount`
        // must all be derived from the same number — every bound check downstream
        // ratios one against another and any disagreement turns into an
        // out-of-bounds error. Two independent constraints make the answer
        // non-obvious:
        //
        //   1. The SAB mutex's `RANGE_END` is stored as `Int32` (see
        //      `BiosignalMutex` range field declarations). A fractional value
        //      gets truncated, and any insert that crosses the truncated
        //      boundary trips an out-of-bounds warning.
        //   2. The cache-fill loop in `GenericSignalReader.cacheSignals`
        //      targets `_totalDataLength`; the loop's `getSignalUpdatedRange`
        //      step reads per-signal `SIGNAL_UPDATED_END` (sample count,
        //      `Float32`) from the mutex and divides by the stored sampling
        //      rate (also `Float32`). When `parsed.header.samplingRate` is the
        //      reciprocal of an inter-row median that doesn't divide evenly
        //      (e.g. 99.9977 Hz from a nominally-100 Hz file with sub-sample
        //      jitter), the round-trip can yield a value slightly *greater*
        //      than `sampleCount / samplingRate`, which then trips
        //      `_cacheTimeToRecordingTime`'s `time > _totalDataLength` check.
        //
        // Pick the unit count as `max(ceil(duration), ceil(sampleCount/samplingRate))`
        // so the read-back can't overshoot and the integer-Int32 store still
        // covers the data. `_readSignalPart` returns the actual sample slice
        // for any over-range request, so no zero padding is invented past
        // the real data.
        const durationFloor = Math.ceil(parsed.header.duration)
        const sampleDerivedLength = parsed.header.samplingRate
            ? Math.ceil(parsed.header.sampleCount/parsed.header.samplingRate)
            : durationFloor
        this._dataUnitCount = Math.max(durationFloor, sampleDerivedLength)
        this._totalDataLength = this._dataUnitCount*this._dataUnitDuration
        this._totalRecordingLength = this._totalDataLength
        this._discontinuous = false
        this._url = url
        if (authHeader) {
            this._authHeader = authHeader
        }
        Log.debug(
            `CSV setup complete for ${url}: ${parsed.header.columns.length} channels, ` +
            `${parsed.header.sampleCount} samples at ${parsed.header.samplingRate.toFixed(2)} Hz ` +
            `(encoding ${fetched.encoding.label}).`,
            SCOPE,
        )
        return true
    }

    /**
     * Slice the parsed CSV signals for the requested time range. Overrides the
     * base implementation which would call `_decoder.decodeData` on a binary
     * file part — CSV's "decoder" already ran during `setupStudy`, so there's
     * no further work beyond a subarray view per channel.
     *
     * `unknownData` and `raw` are accepted for signature compatibility but
     * ignored: CSV has no per-call uncertainty about data extent (we know the
     * full sample count) and no separate raw/derived distinction at the file
     * level.
     */
    override async _readSignalPart (start: number, end: number)
        : Promise<SignalCachePart & Omit<SignalDecodeResult, 'signals'> | null>
    {
        if (!this._csvData || !this._fileTypeHeader) {
            Log.error(`Cannot read signal part: CSV data has not been loaded.`, SCOPE)
            return null
        }
        if (start < 0 || start >= this._totalRecordingLength) {
            Log.error(`Requested signal range ${start} - ${end} was out of recording bounds.`, SCOPE)
            return null
        }
        if (start >= end) {
            Log.error(`Requested signal range ${start} - ${end} was empty or invalid.`, SCOPE)
            return null
        }
        if (end > this._totalRecordingLength) {
            end = this._totalRecordingLength
        }
        const sr = this._fileTypeHeader.samplingRate
        const startSample = Math.max(0, Math.floor(start*sr))
        const totalSamples = this._csvData.signals[0]?.length ?? 0
        const endSample = Math.min(totalSamples, Math.ceil(end*sr))
        if (endSample <= startSample) {
            return { signals: [], start, end }
        }
        // `subarray` shares the underlying buffer — cheap. Downstream cache
        // insertion (`combineSignalParts`) copies into the destination as
        // needed, so we don't need to materialise a fresh Float32Array here.
        const signals: SignalCachePart['signals'] = this._csvData.signals.map(col => ({
            data: new Float32Array(col.subarray(startSample, endSample)),
            samplingRate: sr,
        }))
        // Materialise setup-declared derivations after the source slots so the
        // buffer count matches what `setupMutex` / `setupCache` allocated.
        // Mirrors the base-class fast path (see `GenericSignalReader._readSignalPart`).
        for (const slot of this._derivationSlots) {
            signals.push({
                data: this._materialiseDerivation(slot, signals),
                samplingRate: slot.samplingRate,
            })
        }
        return {
            signals,
            start,
            end,
        }
    }

    /**
     * Re-detect the encoding of a buffer. Exposed for tests and for callers that
     * want to validate a file before instantiating a full reader.
     */
    static detectEncoding = detectTextEncoding
}
