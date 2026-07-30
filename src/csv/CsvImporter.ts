/**
 * CSV study importer — entry point invoked by `Epicurrents.loadStudy()` for
 * `.csv` (and `.tsv`) URLs. Reads and parses the full file at import time so
 * `study.meta` carries the channel descriptors and biosignal header that
 * downstream resources (e.g. {@link AccRecording}) need at construction time
 * to declare source channels, build setups, and budget memory before
 * activation. The worker still re-parses during {@link CsvReader.setupStudy}
 * to populate its own per-column Float32Arrays for the cache-fill path.
 *
 * @package    epicurrents/csv-reader
 * @copyright  2026 Sampsa Lohi
 * @license    Apache-2.0
 */

import { GenericStudyImporter } from '@epicurrents/core'
import { detectTextEncoding } from '@epicurrents/core/dist/util'
import type {
    AssociatedFileType,
    BiosignalChannel,
    ConfigReadUrl,
    SignalStudyImporter,
    StudyContextFile,
    StudyFileContext,
} from '@epicurrents/core/dist/types'
import { Log } from 'scoped-event-log'
import { parseFile, parseHeader } from './CsvParser'
import { headerToBiosignalHeader } from '#root/src/util'
import type {
    CsvHeader,
    CsvParseOptions,
    CsvParseResult,
} from '#types'

const SCOPE = 'CsvImporter'

export default class CsvImporter extends GenericStudyImporter implements SignalStudyImporter {

    protected _parseOptions: CsvParseOptions

    constructor (parseOptions: CsvParseOptions = {}) {
        const fileTypeAssocs = [
            {
                accept: {
                    'text/csv': ['.csv'],
                    'text/tab-separated-values': ['.tsv'],
                },
                description: 'CSV / TSV signal file',
            },
        ] as AssociatedFileType[]
        super(SCOPE, [], fileTypeAssocs)
        this._parseOptions = parseOptions
    }

    /**
     * Run the full-file parse and write `header`, `channels`, the bundled
     * `BiosignalHeaderRecord`, plus the convenience fields needed by ACC-style
     * loaders (`samplingRate`, `duration`, `nChannels`) into `_study.meta`.
     *
     * Splitting this out from `importFile` / `importUrl` keeps the encoding
     * detection + parse + meta population logic in one place; the file/url
     * variants only differ in how they obtain the source bytes.
     */
    protected _applyParseResult (
        parsed: CsvParseResult,
        sourceName: string,
        encodingLabel: string,
    ): void {
        const header = parsed.header
        // The literal carries the fields downstream code reads (label, name,
        // modality, samplingRate, sampleCount, unit, visible). Method-shaped
        // members of `BiosignalChannel` (`addMarkers`, etc.) and the marker /
        // filter state are layered on by `GenericBiosignalChannel`'s constructor
        // when `AccRecording` wraps each entry in `AccSourceChannel` — the cast
        // through `unknown` reflects that we're producing a descriptor for that
        // wrapping, not a fully-constructed channel.
        const channels: BiosignalChannel[] = header.columns.map(col => ({
            averaged: false,
            displayPolarity: 0,
            highpassFilter: 0,
            label: col.label,
            laterality: '',
            lowpassFilter: 0,
            modality: 'signal',
            name: col.label,
            notchFilter: 0,
            offset: { baseline: 0, bottom: 0, top: 0 },
            sampleCount: header.sampleCount,
            samplingRate: header.samplingRate,
            // Per-channel sensitivity is left at 0 so the consumer's
            // `chan.sensitivity || resource.sensitivity` fallback always
            // resolves to the resource-level sensitivity — overriding here
            // would freeze the displayed amplitude per channel even when the
            // user changes the resource setting.
            sensitivity: 0,
            signal: new Float32Array(),
            unit: col.unit,
            visible: true,
        }) as unknown as BiosignalChannel)
        const biosignalHeader = headerToBiosignalHeader(header, sourceName)
        this._study.meta = {
            channels,
            columns: header.columns,
            duration: header.duration,
            encoding: encodingLabel,
            header: biosignalHeader,
            metadata: header.metadata,
            nChannels: header.columns.length,
            samplingRate: header.samplingRate,
            timeColumnIndex: header.timeColumnIndex,
        }
        Log.debug(
            `CSV import parsed ${sourceName}: ${header.columns.length} channels, ` +
            `${header.sampleCount} samples at ${header.samplingRate.toFixed(2)} Hz.`,
            SCOPE,
        )
    }

    /**
     * Parse the header portion of a CSV source and stash the result on
     * `_study.meta`. Returns the parsed header (or null on failure) for
     * caller-side validation. Used only by {@link readHeader} — the
     * full-file paths take care of populating the rest of `meta`.
     */
    protected async _readHeaderInfo (source: ArrayBuffer): Promise<CsvHeader | null> {
        const encoding = detectTextEncoding(source)
        const decoder = new TextDecoder(encoding.label)
        const text = decoder.decode(source)
        const header = parseHeader(text, this._parseOptions)
        if (!header) {
            Log.error(`CSV header could not be parsed.`, SCOPE)
            return null
        }
        this._study.meta = {
            columns: header.columns,
            metadata: header.metadata,
            timeColumnIndex: header.timeColumnIndex,
            encoding: encoding.label,
        }
        return header
    }

    getFileTypeWorker (override?: string): Worker | null {
        const workerOverride = this._workerOverrides.get(override || 'csv')
        const worker = workerOverride ? workerOverride() : new Worker(
            /* webpackChunkName: 'csv.worker' */
            new URL('../workers/csv.worker', import.meta.url),
            { type: 'module' },
        )
        Log.registerWorker(worker)
        return worker
    }

    async importFile (source: File | StudyFileContext, config?: ConfigReadUrl): Promise<StudyContextFile | null> {
        const file = (source as StudyFileContext).file || source as File
        Log.debug(`Loading CSV from file ${file.name}.`, SCOPE)
        const fileName = config?.name || file.name || ''
        const studyFile = {
            file,
            format: 'csv',
            mime: config?.mime || file.type || null,
            name: fileName,
            partial: false,
            range: [],
            role: 'data',
            modality: 'signal',
            url: config?.url || URL.createObjectURL(file),
        } as StudyContextFile
        try {
            const buffer = await file.arrayBuffer()
            const encoding = detectTextEncoding(buffer.slice(0, 4))
            const text = new TextDecoder(encoding.label).decode(buffer)
            const parsed = parseFile(text, this._parseOptions)
            if (!parsed) {
                Log.error(`Could not parse CSV from the given file.`, SCOPE)
                return null
            }
            this._applyParseResult(parsed, fileName, encoding.label)
        } catch (e: unknown) {
            Log.error(`CSV parse error: ${(e as Error).message}.`, SCOPE, e as Error)
            return null
        }
        this._study.files.push(studyFile)
        return studyFile
    }

    async importUrl (source: string | StudyFileContext, config?: ConfigReadUrl): Promise<StudyContextFile | null> {
        const url = (source as StudyFileContext).url || source as string
        Log.debug(`Loading CSV from url ${url}.`, SCOPE)
        const fileName = config?.name || url.split('/').pop() || ''
        const studyFile = {
            file: null,
            format: 'csv',
            mime: config?.mime || null,
            name: fileName,
            partial: false,
            range: [],
            role: 'data',
            modality: 'signal',
            url,
        } as StudyContextFile
        try {
            const buffer = await this._fetchArrayBuffer(url, { authHeader: config?.authHeader })
            const encoding = detectTextEncoding(buffer.slice(0, 4))
            const text = new TextDecoder(encoding.label).decode(buffer)
            const parsed = parseFile(text, this._parseOptions)
            if (!parsed) {
                Log.error(`Could not parse CSV from the given URL.`, SCOPE)
                return null
            }
            this._applyParseResult(parsed, fileName, encoding.label)
        } catch (e: unknown) {
            Log.error(`CSV parse error: ${(e as Error).message}.`, SCOPE, e as Error)
            return null
        }
        this._study.files.push(studyFile)
        return studyFile
    }

    async readHeader (source: ArrayBuffer, _config?: unknown): Promise<CsvHeader | null> {
        return this._readHeaderInfo(source)
    }
}
