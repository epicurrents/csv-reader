/**
 * Unit tests for CsvImporter — the entry point `loadStudy` calls for a `.csv` source. What it
 * owes its caller is a populated `study.meta`: the resource that wraps the study reads the
 * channel descriptors, the biosignal header and the sampling rate from it at construction time,
 * before any worker has run.
 *
 * @package    epicurrents/csv-reader
 * @copyright  2026 Sampsa Lohi
 * @license    Apache-2.0
 */

import { Log } from 'scoped-event-log'
import CsvImporter from '../../src/csv/CsvImporter'

vi.mock('scoped-event-log', () => ({
    Log: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn(), registerWorker: vi.fn() },
}))

// The inlined worker bundle is produced by the build, so the test stands in for it. Constructing
// one is all `getFileTypeWorker` does with it.
vi.mock('../../src/workers/csv.worker.ts?worker&inline', () => ({
    default: class InlineWorkerStub {},
}))

vi.mock('@epicurrents/core', () => ({
    GenericStudyImporter: class {
        protected _study: any = { files: [], meta: {} }
        protected _workerOverrides = new Map<string, (() => Worker) | null>()
        constructor (
            public name: string,
            public modalities: string[],
            public fileTypes: any[],
        ) {}
        protected _fetchArrayBuffer = vi.fn()
    },
    GenericBiosignalHeader: class {
        constructor(
            public fileType: string,
            public patientId: string,
            public recordingId: string,
            public totalDuration: number,
            public dataUnitDuration: number,
            public maxSamplingRate: number,
            public signalCount: number,
            public signals: any[],
        ) {}
    },
}))

const CSV_BODY = [
    'time,wrist_x[g],wrist_y[g],wrist_z[g]',
    '0,1,2,3',
    '0.01,4,5,6',
    '0.02,7,8,9',
    '0.03,10,11,12',
].join('\n')

const toBuffer = (body: string) => new TextEncoder().encode(body).buffer as ArrayBuffer

const makeMockedFile = (body: string, name = 'wrist.csv'): File => {
    return {
        arrayBuffer: async () => toBuffer(body),
        name,
        type: 'text/csv',
    } as unknown as File
}

describe('CsvImporter.importFile', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        // jsdom has no object-URL implementation and the importer stores one on the study file.
        global.URL.createObjectURL = vi.fn(() => 'blob:csv')
    })

    it('populates the study meta the wrapping resource reads at construction', async () => {
        const importer = new CsvImporter()
        const studyFile = await importer.importFile(makeMockedFile(CSV_BODY))
        expect(studyFile).not.toBeNull()
        const meta = (importer as any)._study.meta
        expect(meta.nChannels).toBe(3)
        expect(meta.channels).toHaveLength(3)
        expect(meta.channels[0].label).toBe('wrist_x')
        expect(meta.channels[0].unit).toBe('g')
        // The sample count and rate come from the parse, not from the channel literal's defaults.
        expect(meta.channels[0].sampleCount).toBe(4)
        expect(meta.samplingRate).toBeCloseTo(100, 3)
        expect(meta.timeColumnIndex).toBe(0)
        expect(meta.header).toBeDefined()
        expect(meta.header.signalCount).toBe(3)
    })

    it('registers the parsed file on the study context', async () => {
        const importer = new CsvImporter()
        const studyFile = await importer.importFile(makeMockedFile(CSV_BODY))
        const files = (importer as any)._study.files
        expect(files).toHaveLength(1)
        expect(files[0]).toBe(studyFile)
        expect(studyFile!.format).toBe('csv')
        expect(studyFile!.name).toBe('wrist.csv')
        expect(studyFile!.modality).toBe('signal')
    })

    it('takes the name from the config over the file own name', async () => {
        const importer = new CsvImporter()
        const studyFile = await importer.importFile(makeMockedFile(CSV_BODY), { name: 'renamed.csv' } as any)
        expect(studyFile!.name).toBe('renamed.csv')
    })

    it('registers no file and reports the failure when the body will not parse', async () => {
        const importer = new CsvImporter()
        // A header row with no samples under it: the parser has nothing to derive a rate from.
        const studyFile = await importer.importFile(makeMockedFile('time,x\n'))
        expect(studyFile).toBeNull()
        expect((importer as any)._study.files).toHaveLength(0)
        expect(Log.error).toHaveBeenCalled()
    })
})

describe('CsvImporter.importUrl', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('parses what the fetch returns and names the file from the url tail', async () => {
        const importer = new CsvImporter()
        const fetchBuffer = (importer as any)._fetchArrayBuffer as ReturnType<typeof vi.fn>
        fetchBuffer.mockResolvedValue(toBuffer(CSV_BODY))
        const studyFile = await importer.importUrl('https://example.com/data/wrist.csv')
        expect(studyFile).not.toBeNull()
        expect(studyFile!.name).toBe('wrist.csv')
        expect(studyFile!.file).toBeNull()
        expect((importer as any)._study.meta.nChannels).toBe(3)
    })

    it('passes the authorisation header on to the fetch', async () => {
        const importer = new CsvImporter()
        const fetchBuffer = (importer as any)._fetchArrayBuffer as ReturnType<typeof vi.fn>
        fetchBuffer.mockResolvedValue(toBuffer(CSV_BODY))
        await importer.importUrl('https://example.com/wrist.csv', { authHeader: 'Bearer t' } as any)
        expect(fetchBuffer).toHaveBeenCalledWith('https://example.com/wrist.csv', { authHeader: 'Bearer t' })
    })

    it('registers no file and reports the failure when the fetch throws', async () => {
        const importer = new CsvImporter()
        const fetchBuffer = (importer as any)._fetchArrayBuffer as ReturnType<typeof vi.fn>
        fetchBuffer.mockRejectedValue(new Error('network down'))
        const studyFile = await importer.importUrl('https://example.com/wrist.csv')
        expect(studyFile).toBeNull()
        expect((importer as any)._study.files).toHaveLength(0)
        expect(Log.error).toHaveBeenCalled()
    })
})

describe('CsvImporter.readHeader', () => {
    it('returns the parsed header without reading the samples', async () => {
        const importer = new CsvImporter()
        const header = await importer.readHeader(toBuffer(CSV_BODY))
        expect(header).not.toBeNull()
        expect(header!.columns).toHaveLength(3)
        const meta = (importer as any)._study.meta
        expect(meta.columns).toHaveLength(3)
        expect(meta.encoding).toBe('utf-8')
        // A header read populates no channel descriptors; that is the full-file path's job.
        expect(meta.channels).toBeUndefined()
    })

    it('rejects rather than throwing when the platform has no decoder for the encoding', async () => {
        const importer = new CsvImporter()
        // A UTF-32 byte-order mark. The encoding standard registers no label for it, so
        // constructing the decoder throws; a caller awaiting the read must see a rejection
        // rather than a throw from the call itself.
        const utf32 = new Uint8Array([0xFF, 0xFE, 0x00, 0x00]).buffer
        expect(() => importer.readHeader(utf32)).not.toThrow()
        await expect(importer.readHeader(utf32)).rejects.toThrow()
    })

    it('returns null and reports when the header will not parse', async () => {
        const importer = new CsvImporter()
        const header = await importer.readHeader(toBuffer(''))
        expect(header).toBeNull()
        expect(Log.error).toHaveBeenCalled()
    })
})

describe('CsvImporter.getFileTypeWorker', () => {
    it('constructs the inlined worker when no override is registered', () => {
        const importer = new CsvImporter()
        expect(importer.getFileTypeWorker()).not.toBeNull()
    })

    it('prefers a registered override over the inlined worker', () => {
        const importer = new CsvImporter()
        const override = { name: 'override' } as unknown as Worker
        ;(importer as any)._workerOverrides.set('csv', () => override)
        expect(importer.getFileTypeWorker()).toBe(override)
    })
})
