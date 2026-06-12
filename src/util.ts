/**
 * Epicurrents CSV reader utilities.
 *
 * Conversion from {@link CsvHeader} (parser output) to {@link GenericBiosignalHeader}
 * (the shape `GenericSignalReader` expects to drive its cache layout and memory
 * budget). Kept in a standalone file so the reader, the importer, and any tests
 * can share the same translation.
 *
 * @package    epicurrents/csv-reader
 * @copyright  2026 Sampsa Lohi
 * @license    Apache-2.0
 */

import { GenericBiosignalHeader } from '@epicurrents/core'
import type { BiosignalHeaderSignal } from '@epicurrents/core/dist/types'
import type { CsvHeader } from '#types'

/**
 * Translate a parsed CSV header into a `GenericBiosignalHeader` that
 * `GenericSignalReader` can consume.
 *
 * - `dataUnitDuration` is fixed at 1 s (same convention as wav-reader). The
 *   choice doesn't affect signal accuracy — it sets the "block" granularity
 *   the base reader uses to size cache chunks and report progress.
 * - Per-channel `physicalUnit` comes verbatim from the parsed column's unit
 *   annotation (`label[unit]`). Empty when no unit was annotated; downstream
 *   `getSignalScale` falls back to `1` for unknown units.
 * - Modality stays at `'signal'` for all channels by default; the caller can
 *   stamp something more specific if the host knows what's in the file (e.g.
 *   `'acc'` for accelerometry).
 *
 * @param header - Parsed CSV header.
 * @param name - Human-readable name of the recording (used for the header
 *               record's patient/recording fields, which CSV doesn't carry).
 * @param defaultModality - Optional override for per-channel `modality`.
 *                          Defaults to `'signal'`.
 */
export const headerToBiosignalHeader = (
    header: CsvHeader,
    name = 'CSV recording',
    defaultModality = 'signal',
): GenericBiosignalHeader => {
    const channels: BiosignalHeaderSignal[] = header.columns.map((col) => ({
        label: col.label,
        modality: defaultModality,
        name: col.label,
        physicalUnit: col.unit,
        prefiltering: { bandreject: [], highpass: 0, lowpass: 0, notch: 0 },
        sampleCount: header.sampleCount,
        samplingRate: header.samplingRate,
        sensitivity: 1,
        sensor: '',
    }))
    return new GenericBiosignalHeader(
        'csv',
        name,
        name,
        // Fixed 1-second data units (see WAV reader convention).
        header.duration,
        1,
        header.samplingRate,
        channels.length,
        channels,
    )
}
