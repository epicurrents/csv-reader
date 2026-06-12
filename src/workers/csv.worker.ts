/**
 * Epicurrents CSV file worker. Handles the `setup-worker`, `setup-cache`,
 * `cache-signals`, `get-signals`, `release-cache`, `shutdown`, and
 * `update-settings` commissions for a `CsvReader` running off the main
 * thread. Matches the wav-reader/edf-reader action vocabulary so the
 * service layer treats CSV like any other signal source.
 *
 * @package    epicurrents/csv-reader
 * @copyright  2026 Sampsa Lohi
 * @license    Apache-2.0
 */

import { SETTINGS } from '@epicurrents/core'
import type {
    BiosignalCacheDerivationSlot,
    ConfigChannelFilter,
    WorkerMessage,
} from '@epicurrents/core/dist/types'
import { validateCommissionProps } from '@epicurrents/core/dist/util'
import { Log } from 'scoped-event-log'
import CsvReader from '#csv/CsvReader'

const SCOPE = 'csv.worker'

const READER = new CsvReader(SETTINGS)

onmessage = async (message: WorkerMessage) => {
    if (!message?.data?.action) {
        return
    }
    const { action, rn } = message.data
    const returnSuccess = (results?: { [key: string]: unknown }) => {
        postMessage({
            rn,
            action,
            success: true,
            ...results,
        })
    }
    const returnFailure = (error: string | string[]) => {
        postMessage({
            rn,
            action,
            success: false,
            error,
        })
    }
    Log.debug(`Received message with action ${action}.`, SCOPE)
    switch (action) {
        case 'cache-signals': {
            try {
                const success = await READER.cacheSignals()
                return returnSuccess({ complete: success })
            } catch (e: unknown) {
                Log.error(
                    `An error occurred while trying to cache signals, operation was aborted: ${
                        (e as Error).message
                    }.`,
                    SCOPE,
                    e as Error,
                )
                return returnFailure((e as Error).message)
            }
        }
        case 'get-signals': {
            if (!READER.cacheReady) {
                return returnFailure(`Cannot return signals if signal cache is not yet initialized.`)
            }
            const data = validateCommissionProps(
                message.data as WorkerMessage['data'] & {
                    config?: ConfigChannelFilter
                    range: number[]
                },
                {
                    config: 'Object?',
                    range: ['Number', 'Number'],
                },
            )
            if (!data) {
                return
            }
            try {
                const sigs = await READER.getSignals(data.range, data.config)
                if (sigs) {
                    return returnSuccess({
                        range: message.data.range,
                        ...sigs,
                    })
                } else {
                    return returnFailure(`Reader did not return any signals.`)
                }
            } catch (e: unknown) {
                return returnFailure((e as Error).message)
            }
        }
        case 'release-cache': {
            await READER.releaseCache()
            return returnSuccess()
        }
        case 'setup-cache': {
            const derivationSlots =
                (message.data.derivationSlots as BiosignalCacheDerivationSlot[]) || []
            if (message.data.useMemoryManager) {
                const data = validateCommissionProps(
                    message.data as WorkerMessage['data'] & {
                        buffer: SharedArrayBuffer
                        range: { start: number }
                    },
                    {
                        buffer: 'SharedArrayBuffer',
                        range: 'Object',
                    },
                )
                if (!data) {
                    return
                }
                const exportProps = await READER.setupMutex(
                    data.buffer,
                    data.range.start,
                    derivationSlots,
                )
                if (exportProps) {
                    return returnSuccess({
                        cacheProperties: exportProps,
                    })
                } else {
                    return returnFailure(`Mutex setup failed.`)
                }
            } else {
                const duration = (message.data.dataDuration as number) || 0
                const success = READER.setupCache(duration, derivationSlots)
                if (success) {
                    return returnSuccess()
                } else {
                    return returnFailure(`Cache setup failed.`)
                }
            }
        }
        case 'setup-worker': {
            const data = validateCommissionProps(
                message.data as WorkerMessage['data'] & {
                    url: string
                    authHeader?: string
                },
                {
                    url: 'String',
                    authHeader: 'String?',
                },
            )
            if (!data) {
                return returnFailure(`Validating commission props failed.`)
            }
            if (await READER.setupStudy(data.url, data.authHeader)) {
                return returnSuccess({
                    dataLength: READER.dataLength,
                    recordingLength: READER.totalLength,
                })
            } else {
                return returnFailure(`Setting up study failed.`)
            }
        }
        case 'shutdown': {
            await READER.destroy()
            close()
            return returnSuccess()
        }
        case 'update-settings': {
            Object.assign(SETTINGS, message.data.settings)
            return returnSuccess()
        }
    }
}
