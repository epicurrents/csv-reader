/**
 * Epicurrents CSV file worker. The commissions a signal reader answers alike come from
 * {@link SignalReaderWorker}; what is added here is `setup-worker`, which opens the study.
 * @package    epicurrents/csv-reader
 * @copyright  2026 Sampsa Lohi
 * @license    Apache-2.0
 */

import { SETTINGS } from '@epicurrents/core'
import { SignalReaderWorker } from '@epicurrents/core/workers'
import type { WorkerMessage } from '@epicurrents/core/types'
import { validateCommissionProps } from '@epicurrents/core/util'
import { Log } from 'scoped-event-log'
import CsvReader from '#csv/CsvReader'

const SCOPE = 'csv.worker'

class CsvWorker extends SignalReaderWorker<CsvReader> {
    constructor () {
        super(new CsvReader(SETTINGS))
        this._reader.setUpdateCallback((update: { [prop: string]: unknown }) => {
            if (update.action === 'cache-signals') {
                postMessage(update)
            }
        })
        this.extendActionMap([['setup-worker', this.setupWorker]])
    }

    /**
     * Open the study the commission describes.
     * @param msgData - Data property from the message to the worker.
     */
    async setupWorker (msgData: WorkerMessage['data']) {
        const data = validateCommissionProps(
            msgData as WorkerMessage['data'] & {
                authHeader?: string
                file?: File
                url?: string
            },
            {
                // A local study is read from the File and a remote one from the URL, so neither can
                // be required on its own; `setupStudy` rejects a source that has neither.
                authHeader: 'String?',
                file: 'File?',
                url: 'String?',
            }
        )
        if (!data) {
            return this._failure(msgData, `Validating commission props failed.`)
        }
        if (!await this._reader.setupStudy({ authHeader: data.authHeader, file: data.file, url: data.url })) {
            return this._failure(msgData, `Setting up study failed.`)
        }
        return this._success(msgData, {
            dataLength: this._reader.dataLength,
            recordingLength: this._reader.totalLength,
        })
    }
}

const WORKER = new CsvWorker()

onmessage = async (message: WorkerMessage) => {
    if (!message?.data?.action) {
        return
    }
    Log.debug(`Received message with action ${message.data.action}.`, SCOPE)
    WORKER.handleMessage(message)
}
