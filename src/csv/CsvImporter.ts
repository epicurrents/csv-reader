/**
 * CSV study importer — entry point invoked by `Epicurrents.loadStudy()` for
 * `.csv` (and `.tsv`) URLs. Reads only enough of the file to populate
 * `study.meta` with column metadata; the full parse runs later in
 * {@link CsvReader.setupStudy} on the worker side.
 *
 * @package    epicurrents/csv-reader
 * @copyright  2026 Sampsa Lohi
 * @license    Apache-2.0
 */

import { GenericStudyImporter } from '@epicurrents/core'
import { detectTextEncoding } from '@epicurrents/core/dist/util'
import type {
    AssociatedFileType,
    ConfigReadUrl,
    SignalStudyImporter,
    StudyContextFile,
    StudyFileContext,
} from '@epicurrents/core/dist/types'
import { Log } from 'scoped-event-log'
import { parseHeader } from './CsvParser'
import type {
    CsvHeader,
    CsvParseOptions,
} from '#types'

const SCOPE = 'CsvImporter'

/**
 * Number of bytes to read from the start of a file when sniffing the header.
 * 4 KB comfortably covers any plausible metadata block + column-header row.
 */
const HEADER_PEEK_BYTES = 4096

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
     * Parse the header portion of a CSV source and stash the result on
     * `_study.meta`. Returns the parsed header (or null on failure) for
     * caller-side validation.
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

    async readHeader (source: ArrayBuffer, _config?: unknown): Promise<CsvHeader | null> {
        return this._readHeaderInfo(source)
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
            const slice = await file.slice(0, Math.min(file.size, HEADER_PEEK_BYTES)).arrayBuffer()
            const header = await this.readHeader(slice)
            if (!header) {
                Log.error(`Could not parse CSV header from the given file.`, SCOPE)
                return null
            }
        } catch (e: unknown) {
            Log.error(`CSV header parsing error: ${(e as Error).message}.`, SCOPE, e as Error)
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
            const headers = new Headers()
            headers.set('range', `bytes=0-${HEADER_PEEK_BYTES - 1}`)
            if (config?.authHeader) {
                headers.set('Authorization', config.authHeader)
            }
            const response = await fetch(url, { headers })
            const header = await this.readHeader(await response.arrayBuffer())
            if (!header) {
                Log.error(`Could not parse CSV header from the given URL.`, SCOPE)
                return null
            }
        } catch (e: unknown) {
            Log.error(`CSV header parsing error: ${(e as Error).message}.`, SCOPE, e as Error)
            return null
        }
        this._study.files.push(studyFile)
        return studyFile
    }
}
