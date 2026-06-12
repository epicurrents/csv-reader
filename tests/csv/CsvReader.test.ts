/**
 * Unit tests for CsvReader's cache bridge — `setupStudy` populates the inherited
 * data-unit fields from the parsed CsvHeader, and `_readSignalPart` returns
 * Float32Array slices over the parsed signals without any further IO.
 *
 * @package    epicurrents/csv-reader
 * @copyright  2026 Sampsa Lohi
 * @license    Apache-2.0
 */

import { Log } from 'scoped-event-log'
import CsvReader from '../../src/csv/CsvReader'

vi.mock('scoped-event-log', () => ({
    Log: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

vi.mock('@epicurrents/core', () => ({
    GenericSignalReader: class {
        SETTINGS: any
        protected _mutex: any = null
        protected _fallbackCache: any = null
        protected _decoder: any = null
        protected _header: any = null
        protected _isMutexReady = false
        protected _dataUnitDuration = 0
        protected _dataUnitCount = 0
        protected _dataUnitSize = 0
        protected _chunkUnitCount = 0
        protected _totalDataLength = 0
        protected _totalRecordingLength = 0
        protected _discontinuous = false
        protected _url = ''
        protected _authHeader = ''
        constructor(_encoding: any, settings: any) {
            this.SETTINGS = settings || { app: { dataChunkSize: 1024 * 1024 } }
        }
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

vi.mock('@epicurrents/core/dist/util', () => ({
    detectTextEncoding: () => ({ label: 'utf-8', constructor: Uint8Array }),
    fetchTextFile: vi.fn(),
}))

// The CSV body the mocked fetch returns to setupStudy.
const CSV_BODY = [
    'time,wrist_x[g],wrist_y[g],wrist_z[g]',
    '0,1,2,3',
    '0.01,4,5,6',
    '0.02,7,8,9',
    '0.03,10,11,12',
].join('\n')

const makeMockedFile = (body: string): File => {
    // jsdom's File works for our needs; we only need `.text()`.
    return {
        text: async () => body,
    } as unknown as File
}

const APP_SETTINGS = { app: { dataChunkSize: 1024 * 1024 } } as any

describe('CsvReader.setupStudy', () => {
    let fetchTextFile: ReturnType<typeof vi.fn>

    beforeEach(async () => {
        vi.clearAllMocks()
        const util = await import('@epicurrents/core/dist/util')
        fetchTextFile = util.fetchTextFile as ReturnType<typeof vi.fn>
    })

    it('populates the BiosignalHeaderRecord from the parsed CSV header', async () => {
        fetchTextFile.mockResolvedValue({
            file: makeMockedFile(CSV_BODY),
            encoding: { label: 'utf-8', constructor: Uint8Array },
        })
        const reader = new CsvReader(APP_SETTINGS)
        const ok = await reader.setupStudy('https://example.com/x.csv')
        expect(ok).toBe(true)
        const header = (reader as any)._header
        expect(header).toBeDefined()
        expect(header.signalCount).toBe(3)
        expect(header.signals).toHaveLength(3)
        // Unit annotation flows through verbatim.
        expect(header.signals[0].physicalUnit).toBe('g')
        // Sampling rate inferred from median delta = 0.01 s → 100 Hz.
        expect(header.maxSamplingRate).toBeCloseTo(100, 3)
    })

    it('wires data-unit fields for the cache-fill loop', async () => {
        fetchTextFile.mockResolvedValue({
            file: makeMockedFile(CSV_BODY),
            encoding: { label: 'utf-8', constructor: Uint8Array },
        })
        const reader = new CsvReader(APP_SETTINGS)
        await reader.setupStudy('https://example.com/x.csv')
        const r = reader as any
        expect(r._dataUnitDuration).toBe(1)
        // duration = 0.03 s → ceil to 1.
        expect(r._dataUnitCount).toBe(1)
        // 100 Hz × 3 channels × 4 bytes/sample.
        expect(r._dataUnitSize).toBe(100 * 3 * 4)
        // Total length is the time-vector span (last - first) = 0.03 s.
        expect(r._totalDataLength).toBeCloseTo(0.03, 6)
        expect(r._totalRecordingLength).toBeCloseTo(0.03, 6)
        expect(r._discontinuous).toBe(false)
    })

    it('refuses to set up twice without a release in between', async () => {
        fetchTextFile.mockResolvedValue({
            file: makeMockedFile(CSV_BODY),
            encoding: { label: 'utf-8', constructor: Uint8Array },
        })
        const reader = new CsvReader(APP_SETTINGS)
        await reader.setupStudy('https://example.com/x.csv')
        // Mark the cache as already initialised.
        ;(reader as any)._fallbackCache = {}
        const second = await reader.setupStudy('https://example.com/y.csv')
        expect(second).toBe(false)
        expect(Log.error).toHaveBeenCalled()
    })

    it('returns false when fetchTextFile fails', async () => {
        fetchTextFile.mockResolvedValue(null)
        const reader = new CsvReader(APP_SETTINGS)
        const ok = await reader.setupStudy('https://example.com/missing.csv')
        expect(ok).toBe(false)
    })

    it('returns false when the parser fails (empty body)', async () => {
        fetchTextFile.mockResolvedValue({
            file: makeMockedFile('time,x\n'),  // no sample rows → parser returns null
            encoding: { label: 'utf-8', constructor: Uint8Array },
        })
        const reader = new CsvReader(APP_SETTINGS)
        const ok = await reader.setupStudy('https://example.com/x.csv')
        expect(ok).toBe(false)
        expect(Log.error).toHaveBeenCalled()
    })
})

describe('CsvReader._readSignalPart', () => {
    let fetchTextFile: ReturnType<typeof vi.fn>

    beforeEach(async () => {
        vi.clearAllMocks()
        const util = await import('@epicurrents/core/dist/util')
        fetchTextFile = util.fetchTextFile as ReturnType<typeof vi.fn>
        fetchTextFile.mockResolvedValue({
            file: makeMockedFile(CSV_BODY),
            encoding: { label: 'utf-8', constructor: Uint8Array },
        })
    })

    const makeReader = async () => {
        const reader = new CsvReader(APP_SETTINGS)
        await reader.setupStudy('https://example.com/x.csv')
        return reader as any
    }

    it('returns one channel slice per CSV column', async () => {
        const reader = await makeReader()
        const part = await reader._readSignalPart(0, 0.04)
        expect(part).not.toBeNull()
        expect(part.signals).toHaveLength(3)
    })

    it('slices the correct sample range for the requested time window', async () => {
        const reader = await makeReader()
        // 100 Hz × [0.01, 0.03) → samples 1..3.
        const part = await reader._readSignalPart(0.01, 0.03)
        expect(Array.from(part.signals[0].data)).toEqual([4, 7])
        expect(Array.from(part.signals[1].data)).toEqual([5, 8])
        expect(Array.from(part.signals[2].data)).toEqual([6, 9])
    })

    it('clamps the requested end to the recording length', async () => {
        const reader = await makeReader()
        // Recording duration is 0.03 s; request beyond that clamps.
        const part = await reader._readSignalPart(0, 1.0)
        expect(part).not.toBeNull()
        // All samples returned.
        expect(part.signals[0].data.length).toBe(4)
    })

    it('returns an empty signal list when the slice is empty after clamping', async () => {
        const reader = await makeReader()
        const part = await reader._readSignalPart(0.029, 0.0291)
        // 100 Hz × [0.029, 0.0291) ≈ samples 2.9..2.91 → ceil rounding folds
        // to the same sample index; signals[] should be empty.
        expect(part).not.toBeNull()
        expect(part.signals).toEqual([])
    })

    it('returns null on an invalid range (start < 0)', async () => {
        const reader = await makeReader()
        const part = await reader._readSignalPart(-0.1, 0.01)
        expect(part).toBeNull()
        expect(Log.error).toHaveBeenCalled()
    })

    it('returns null on an out-of-bounds start', async () => {
        const reader = await makeReader()
        const part = await reader._readSignalPart(100, 200)
        expect(part).toBeNull()
        expect(Log.error).toHaveBeenCalled()
    })

    it('returns null on an empty range', async () => {
        const reader = await makeReader()
        const part = await reader._readSignalPart(0.01, 0.01)
        expect(part).toBeNull()
        expect(Log.error).toHaveBeenCalled()
    })

    it('returns null when called before setupStudy', async () => {
        const reader = new CsvReader(APP_SETTINGS) as any
        const part = await reader._readSignalPart(0, 0.01)
        expect(part).toBeNull()
        expect(Log.error).toHaveBeenCalled()
    })
})
