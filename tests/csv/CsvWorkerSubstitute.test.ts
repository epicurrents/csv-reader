/**
 * Unit tests for CsvWorkerSubstitute — the main-thread stand-in used where the environment has no
 * SharedArrayBuffer.
 *
 * What is tested here is the wiring, not the commission handlers: those come from core's
 * `SignalReaderWorkerSubstitute`, which runs the worker's own. The property that matters to this
 * package is that the substitute answers the whole vocabulary rather than the handful it used to
 * implement, because a service awaits `shutdown` and `release-cache` before tearing a study down.
 *
 * @package    epicurrents/csv-reader
 * @copyright  2026 Sampsa Lohi
 * @license    Apache-2.0
 */

import type { WorkerMessage } from '@epicurrents/core/types'
import CsvWorkerSubstitute from '../../src/csv/CsvWorkerSubstitute'

vi.mock('scoped-event-log', () => ({
    Log: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn(), registerWorker: vi.fn() },
}))

const reader = {
    cacheReady: true,
    dataLength: 10,
    totalLength: 9.5,
    cacheSignals: vi.fn().mockResolvedValue(true),
    destroy: vi.fn().mockResolvedValue(undefined),
    getSignals: vi.fn().mockResolvedValue({ start: 0, end: 1, signals: [] }),
    releaseCache: vi.fn().mockResolvedValue(undefined),
    releaseSignalArrays: vi.fn().mockResolvedValue(undefined),
    requestSignals: vi.fn().mockResolvedValue({ status: 'ready', part: { start: 0, end: 1, signals: [] } }),
    setBufferRange: vi.fn().mockReturnValue(true),
    setInterruptions: vi.fn(),
    setSignalPolarityInverted: vi.fn().mockResolvedValue(true),
    setUpdateCallback: vi.fn(),
    setupCache: vi.fn().mockReturnValue({ start: 0, end: 10 }),
    setupMutex: vi.fn().mockResolvedValue(null),
    setupStudy: vi.fn().mockResolvedValue(true),
}

vi.mock('../../src/csv/CsvReader', () => ({
    default: class {
        constructor () {
            return reader
        }
    },
}))

const makeSubstitute = () => {
    const substitute = new CsvWorkerSubstitute()
    const replies = [] as WorkerMessage['data'][]
    substitute.onmessage = (message) => replies.push(message.data)
    return { substitute, replies }
}

describe('CsvWorkerSubstitute', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        ;(window as unknown as { __EPICURRENTS__: unknown }).__EPICURRENTS__ = {
            RUNTIME: { SETTINGS: { app: {}, modules: {} } },
        }
    })

    it.each([
        'cache-signals',
        'release-cache',
        'release-signal-arrays',
        'set-interruptions',
        'setup-cache',
        'shutdown',
        'update-settings',
    ])('answers the shared commission %s', async (action) => {
        const { substitute, replies } = makeSubstitute()
        await substitute.postMessage({
            action,
            rn: 1,
            interruptions: [],
            settings: { app: {}, modules: {} },
        })
        expect(replies).toHaveLength(1)
        expect(replies[0]).toMatchObject({ action, rn: 1, success: true })
    })

    it('tears the reader down on shutdown, which the service awaits before terminating', async () => {
        const { substitute, replies } = makeSubstitute()
        await substitute.postMessage({ action: 'shutdown', rn: 2 })
        expect(reader.destroy).toHaveBeenCalled()
        expect(replies[0].success).toBe(true)
    })

    it('opens the study on setup-worker and reports both lengths', async () => {
        const { substitute, replies } = makeSubstitute()
        await substitute.postMessage({ action: 'setup-worker', rn: 3, url: 'https://example.com/x.csv' })
        expect(reader.setupStudy).toHaveBeenCalledWith({
            authHeader: undefined,
            file: undefined,
            url: 'https://example.com/x.csv',
        })
        expect(replies[0]).toMatchObject({ success: true, dataLength: 10, recordingLength: 9.5 })
    })

    it('reports a study that would not open as a failure', async () => {
        reader.setupStudy.mockResolvedValueOnce(false)
        const { substitute, replies } = makeSubstitute()
        await substitute.postMessage({ action: 'setup-worker', rn: 4, url: 'https://example.com/x.csv' })
        expect(replies[0].success).toBe(false)
    })

    it('relays the reader cache-fill updates to the service', async () => {
        const { substitute, replies } = makeSubstitute()
        const update = (reader.setUpdateCallback.mock.calls[0] as unknown[])[0] as (u: unknown) => void
        update({ action: 'cache-signals', range: [0, 5] })
        expect(replies[0]).toMatchObject({ action: 'cache-signals', range: [0, 5] })
    })
})
