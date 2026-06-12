/**
 * Unit tests for CsvParser.
 * @package    epicurrents/csv-reader
 * @copyright  2026 Sampsa Lohi
 * @license    Apache-2.0
 */

import { Log } from 'scoped-event-log'
import { parseFile, parseHeader } from '../../src/csv/CsvParser'

vi.mock('scoped-event-log', () => ({
    Log: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() }
}))

describe('parseHeader', () => {
    beforeEach(() => { vi.clearAllMocks() })

    it('returns null for empty input', () => {
        expect(parseHeader('')).toBeNull()
        expect(Log.error).toHaveBeenCalled()
    })

    it('extracts column labels and units from `label[unit]` syntax', () => {
        const csv = 'time,wrist_x[g],wrist_y[g],wrist_z[g]\n0,0,0,0\n'
        const header = parseHeader(csv)!
        expect(header.columns.map(c => c.label)).toEqual(['wrist_x', 'wrist_y', 'wrist_z'])
        expect(header.columns.every(c => c.unit === 'g')).toBe(true)
    })

    it('leaves unit empty when no `[...]` is present', () => {
        const csv = 'time,ch1,ch2\n0,1,2\n'
        const header = parseHeader(csv)!
        expect(header.columns.map(c => c.unit)).toEqual(['', ''])
    })

    it('records the time column index when time is not the first column', () => {
        const csv = 'ch1,time,ch2\n1,0,2\n'
        const header = parseHeader(csv)!
        expect(header.timeColumnIndex).toBe(1)
        // Non-time columns retain their original CSV row index.
        expect(header.columns.map(c => c.columnIndex)).toEqual([0, 2])
    })

    it('accepts the alternate time-column name "t"', () => {
        const csv = 't,signal\n0,1\n'
        const header = parseHeader(csv)!
        expect(header.timeColumnIndex).toBe(0)
        expect(header.columns[0].label).toBe('signal')
    })

    it('matches the time-column name case-insensitively', () => {
        const csv = 'TIME,signal\n0,1\n'
        const header = parseHeader(csv)!
        expect(header.timeColumnIndex).toBe(0)
    })

    it('returns null when no time column is present', () => {
        const csv = 'ch1,ch2\n1,2\n'
        expect(parseHeader(csv)).toBeNull()
        expect(Log.error).toHaveBeenCalled()
    })

    it('parses a `#`-prefixed metadata block above the header row', () => {
        const csv = [
            '# subject_id: 42',
            '# sensor: wrist-imu',
            '# notes: post-coffee tremor recording',
            'time,wrist_x[g]',
            '0,0',
        ].join('\n')
        const header = parseHeader(csv)!
        expect(header.metadata).toEqual({
            subject_id: '42',
            sensor: 'wrist-imu',
            notes: 'post-coffee tremor recording',
        })
    })

    it('handles CRLF line endings', () => {
        const csv = 'time,signal\r\n0,1\r\n0.01,2\r\n'
        const header = parseHeader(csv)!
        expect(header.columns).toHaveLength(1)
    })

    it('honours a custom delimiter (TSV)', () => {
        const csv = 'time\tsignal\n0\t1\n'
        const header = parseHeader(csv, { delimiter: '\t' })!
        expect(header.columns[0].label).toBe('signal')
    })

    it('honours custom time-column names', () => {
        const csv = 'timestamp_us,signal\n0,1\n'
        const header = parseHeader(csv, { timeColumnNames: ['timestamp_us'] })!
        expect(header.timeColumnIndex).toBe(0)
    })
})

describe('parseFile', () => {
    beforeEach(() => { vi.clearAllMocks() })

    it('materialises one Float32Array per non-time column', () => {
        const csv = 'time,wrist_x[g],wrist_y[g]\n0,1,2\n0.01,3,4\n0.02,5,6\n'
        const result = parseFile(csv)!
        expect(result.signals).toHaveLength(2)
        expect(Array.from(result.signals[0])).toEqual([1, 3, 5])
        expect(Array.from(result.signals[1])).toEqual([2, 4, 6])
    })

    it('returns the time vector parallel to the signal arrays', () => {
        const csv = 'time,x\n0,1\n0.01,2\n0.02,3\n'
        const result = parseFile(csv)!
        expect(Array.from(result.timestamps)).toEqual([0, 0.01, 0.02])
    })

    it('infers sampling rate from the median inter-row delta', () => {
        const csv = 'time,x\n0,1\n0.01,2\n0.02,3\n0.03,4\n'
        const result = parseFile(csv)!
        // Median delta = 0.01 s → 100 Hz.
        expect(result.header.samplingRate).toBeCloseTo(100, 3)
    })

    it('records duration as last minus first timestamp', () => {
        const csv = 'time,x\n0,1\n0.5,2\n1.0,3\n'
        const result = parseFile(csv)!
        expect(result.header.duration).toBeCloseTo(1.0, 6)
    })

    it('warns when time-column jitter exceeds tolerance', () => {
        // 10 ms, 10 ms, 30 ms — large spread.
        const csv = 'time,x\n0,1\n0.01,2\n0.02,3\n0.05,4\n'
        parseFile(csv, { samplingJitterTolerance: 0.05 })
        expect(Log.warn).toHaveBeenCalled()
    })

    it('does not warn when jitter is within tolerance', () => {
        const csv = 'time,x\n0,1\n0.01,2\n0.02,3\n0.03,4\n'
        parseFile(csv, { samplingJitterTolerance: 0.1 })
        expect(Log.warn).not.toHaveBeenCalled()
    })

    it('returns null when no sample rows follow the header', () => {
        const csv = 'time,x\n'
        expect(parseFile(csv)).toBeNull()
        expect(Log.error).toHaveBeenCalled()
    })

    it('skips a metadata block before the header row', () => {
        const csv = [
            '# subject: 42',
            'time,x',
            '0,1',
            '0.01,2',
        ].join('\n')
        const result = parseFile(csv)!
        expect(result.header.metadata.subject).toBe('42')
        expect(Array.from(result.signals[0])).toEqual([1, 2])
    })

    it('records sampleCount from the data rows', () => {
        const csv = 'time,x\n0,1\n0.01,2\n0.02,3\n'
        const result = parseFile(csv)!
        expect(result.header.sampleCount).toBe(3)
    })

    it('handles a non-leftmost time column correctly', () => {
        const csv = 'x,time,y\n1,0,2\n3,0.01,4\n5,0.02,6\n'
        const result = parseFile(csv)!
        expect(Array.from(result.timestamps)).toEqual([0, 0.01, 0.02])
        // signals[0] should be the 'x' column, signals[1] the 'y' column.
        expect(Array.from(result.signals[0])).toEqual([1, 3, 5])
        expect(Array.from(result.signals[1])).toEqual([2, 4, 6])
    })
})
