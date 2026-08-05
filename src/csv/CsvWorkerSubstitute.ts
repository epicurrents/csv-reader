/**
 * Epicurrents CSV worker substitute. Drives the CSV reader on the main thread
 * for environments without SharedArrayBuffer / cross-origin isolation. Same
 * action vocabulary as the dedicated worker — the service can swap one for
 * the other without behavioural change.
 *
 * @package    epicurrents/csv-reader
 * @copyright  2026 Sampsa Lohi
 * @license    Apache-2.0
 */

import { ServiceWorkerSubstitute } from '@epicurrents/core'
import { validateCommissionProps } from '@epicurrents/core/dist/util'
import type {
    BiosignalCacheDerivationSlot,
    ConfigChannelFilter,
    GetSignalsResponse,
    WorkerMessage,
    WorkerSubstitute,
} from '@epicurrents/core/dist/types'
import { Log } from 'scoped-event-log'
import CsvReader from './CsvReader'
import type { CsvParseOptions } from '#types'

const SCOPE = 'CsvWorkerSubstitute'

export default class CsvWorkerSubstitute extends ServiceWorkerSubstitute implements WorkerSubstitute {
    protected _reader: CsvReader

    constructor (parseOptions: CsvParseOptions = {}) {
        super()
        if (!window.__EPICURRENTS__?.RUNTIME) {
            Log.error(`Reference to main application was not found!`, SCOPE)
        }
        this._reader = new CsvReader(window.__EPICURRENTS__!.RUNTIME!.SETTINGS, parseOptions)
        const updateCallback = (update: { [prop: string]: unknown }) => {
            if (update.action === 'cache-signals') {
                this.returnMessage(update as WorkerMessage['data'])
            }
        }
        this._reader.setUpdateCallback(updateCallback)
    }

    async postMessage (message: WorkerMessage['data']) {
        if (!message?.action) {
            return
        }
        const action = message.action
        Log.debug(`Received message with action ${action}.`, SCOPE)
        switch (action) {
            case 'cache-signals': {
                try {
                    const success = await this._reader.cacheSignals()
                    return this.returnSuccess({
                        ...message,
                        complete: success,
                    })
                } catch (e: unknown) {
                    Log.error(
                        `An error occurred while trying to cache signals, operation was aborted: ${
                            (e as Error).message
                        }.`,
                        SCOPE,
                        e as Error,
                    )
                    return this.returnFailure(message)
                }
            }
            case 'get-signals': {
                const data = validateCommissionProps(
                    message as WorkerMessage['data'] & {
                        config?: ConfigChannelFilter
                        range: number[]
                    },
                    {
                        config: 'Object?',
                        range: ['Number', 'Number'],
                    },
                    true,
                    this.returnMessage.bind(this),
                )
                if (!data) {
                    return
                }
                try {
                    const sigs = await this._reader.getSignals(data.range, data.config)
                    if (sigs) {
                        return this.returnSuccess({
                            ...message,
                            ...sigs,
                        } as WorkerMessage['data'] & Omit<GetSignalsResponse, 'success'>)
                    } else {
                        return this.returnFailure(message)
                    }
                } catch (e: unknown) {
                    Log.error(`Getting signals failed: ${(e as Error).message}.`, SCOPE, e as Error)
                    return this.returnFailure(message)
                }
            }
            case 'setup-cache': {
                const duration = (message.dataDuration as number) || 0
                const derivationSlots = (message.derivationSlots as BiosignalCacheDerivationSlot[]) || []
                const cache = this._reader.setupCache(duration, derivationSlots)
                return this.returnSuccess({
                    ...message,
                    cacheProperties: cache,
                })
            }
            case 'setup-worker': {
                const data = validateCommissionProps(
                    message as WorkerMessage['data'] & {
                        url?: string
                        authHeader?: string
                        file?: File
                    },
                    {
                        // A local study is read from the File and a remote one from the URL, so neither
                        // can be required on its own; `setupStudy` rejects a source that has neither.
                        url: 'String?',
                        authHeader: 'String?',
                        file: 'File?',
                    },
                    true,
                    this.returnMessage.bind(this),
                )
                if (!data) {
                    return
                }
                const result = await this._reader.setupStudy(
                    { authHeader: data.authHeader, file: data.file, url: data.url }
                )
                if (result) {
                    return this.returnSuccess({
                        ...message,
                        dataLength: this._reader.dataLength,
                        recordingLength: this._reader.totalLength,
                    })
                } else {
                    return this.returnFailure(message)
                }
            }
            default: {
                super.postMessage(message)
            }
        }
    }
}
