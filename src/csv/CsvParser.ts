/**
 * Pure CSV parser. The parser is stateless and side-effect-free — it takes a
 * text string in and returns header info or a fully-materialised
 * `CsvParseResult`. All IO (file fetch, encoding detection, range reads) is
 * handled upstream in the importer / reader using `@epicurrents/core/util`'s
 * text utilities.
 *
 * Two entry points:
 *  - {@link parseHeader} — cheap; only consumes lines up to and including the
 *    column header row. Used by the importer to populate `study.meta` without
 *    materialising sample data.
 *  - {@link parseFile} — full parse with per-column sample arrays, used by the
 *    reader during cache fill.
 *
 * Wire-format conventions (documented in the package README):
 *  - Optional `#`-prefixed metadata block at the top (`# key: value` lines).
 *    Stops at the first non-`#` non-empty line.
 *  - First non-comment row is the column header. Column labels follow the
 *    `<label>[<unit>]` syntax; a missing `[...]` means no unit annotation.
 *  - One time column required. Time is in seconds (float).
 *  - Remaining columns are sample values (float).
 *  - Empty lines after the header are silently skipped.
 *
 * @package    epicurrents/csv-reader
 * @copyright  2026 Sampsa Lohi
 * @license    Apache-2.0
 */

import { Log } from 'scoped-event-log'
import type {
    CsvColumn,
    CsvHeader,
    CsvParseOptions,
    CsvParseResult,
} from '#types'

const SCOPE = 'CsvParser'

const DEFAULT_DELIMITER = ','
const DEFAULT_TIME_NAMES = ['time', 't']
const DEFAULT_JITTER_TOLERANCE = 0.1

/**
 * Parse a column-header cell like `wrist_x[g]` into a label and unit.
 * A cell without `[...]` returns the trimmed cell as label and empty unit.
 */
function parseHeaderCell (cell: string): { label: string, unit: string } {
    const trimmed = cell.trim()
    const match = trimmed.match(/^(.*?)\s*\[\s*(.*?)\s*\]\s*$/)
    if (match) {
        return { label: match[1].trim(), unit: match[2].trim() }
    }
    return { label: trimmed, unit: '' }
}

/**
 * Compute the median of a numeric array without mutating it.
 */
function median (values: number[]): number {
    if (!values.length) {
        return 0
    }
    const sorted = [...values].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length/2)
    if (sorted.length % 2 === 0) {
        return (sorted[mid - 1] + sorted[mid])/2
    }
    return sorted[mid]
}

/**
 * Split the text into trimmed lines and drop fully empty ones. Handles `\r\n`,
 * `\n`, and `\r` line endings. Comment lines (`#`-prefixed) are preserved so the
 * metadata-block reader can pick them up.
 */
function splitLines (text: string): string[] {
    return text.split(/\r\n|\n|\r/).map(l => l.trim()).filter(l => l.length > 0)
}

/**
 * Read the metadata block at the start of a lines array. Returns the parsed
 * key/value map plus the index of the first non-metadata line (i.e. where the
 * column-header row should be).
 */
function readMetadataBlock (lines: string[]): { metadata: Record<string, string>, nextIndex: number } {
    const metadata: Record<string, string> = {}
    let i = 0
    while (i < lines.length && lines[i].startsWith('#')) {
        const body = lines[i].slice(1).trim()
        const colonIdx = body.indexOf(':')
        if (colonIdx > 0) {
            const key = body.slice(0, colonIdx).trim()
            const value = body.slice(colonIdx + 1).trim()
            if (key) {
                metadata[key] = value
            }
        }
        i++
    }
    return { metadata, nextIndex: i }
}

/**
 * Identify the time column among the parsed header cells. Returns its index, or
 * -1 if no candidate matches (the caller should treat that as fatal).
 */
function findTimeColumn (
    headerCells: Array<{ label: string }>,
    candidates: string[],
): number {
    const normalised = candidates.map(c => c.toLowerCase())
    for (let i = 0; i < headerCells.length; i++) {
        if (normalised.includes(headerCells[i].label.toLowerCase())) {
            return i
        }
    }
    return -1
}

/**
 * Parse only the metadata block + column header row of a CSV. Returns header
 * info with `sampleCount=0` and `duration=0` (those are populated only by a
 * full parse). Returns null when the header can't be resolved — typically
 * because the time column is missing.
 *
 * Callers that need sampling-rate info from the header alone should call
 * `parseFile` instead; we deliberately don't infer the rate from a partial slice
 * because the median across two rows is meaningless.
 */
export function parseHeader (text: string, options: CsvParseOptions = {}): CsvHeader | null {
    const delimiter = options.delimiter ?? DEFAULT_DELIMITER
    const timeNames = options.timeColumnNames ?? DEFAULT_TIME_NAMES
    const lines = splitLines(text)
    if (!lines.length) {
        Log.error(`Cannot parse CSV header: input is empty.`, SCOPE)
        return null
    }
    const { metadata, nextIndex } = readMetadataBlock(lines)
    if (nextIndex >= lines.length) {
        Log.error(`Cannot parse CSV header: no column header row found after metadata block.`, SCOPE)
        return null
    }
    const headerCells = lines[nextIndex].split(delimiter).map(parseHeaderCell)
    const timeColumnIndex = findTimeColumn(headerCells, timeNames)
    if (timeColumnIndex < 0) {
        Log.error(
            `Cannot parse CSV header: no time column found. ` +
            `Expected one of [${timeNames.join(', ')}].`,
            SCOPE,
        )
        return null
    }
    const columns: CsvColumn[] = headerCells
        .map((cell, idx) => ({ columnIndex: idx, label: cell.label, unit: cell.unit }))
        .filter((_, idx) => idx !== timeColumnIndex)
    return {
        columns,
        duration: 0,
        metadata,
        samplingRate: 0,
        sampleCount: 0,
        timeColumnIndex,
    }
}

/**
 * Full parse — header + per-column Float32Arrays + the time vector. The time
 * column is consumed to infer the sampling rate (median of inter-row deltas).
 * Logs a warning when delta spread exceeds {@link CsvParseOptions.samplingJitterTolerance};
 * the inferred rate is still returned (downstream cache layout uses it
 * verbatim, so the warning is the user's prompt to inspect their file).
 */
export function parseFile (text: string, options: CsvParseOptions = {}): CsvParseResult | null {
    const delimiter = options.delimiter ?? DEFAULT_DELIMITER
    const jitterTolerance = options.samplingJitterTolerance ?? DEFAULT_JITTER_TOLERANCE
    const header = parseHeader(text, options)
    if (!header) {
        return null
    }
    const lines = splitLines(text)
    const { nextIndex } = readMetadataBlock(lines)
    const dataLines = lines.slice(nextIndex + 1)
    if (!dataLines.length) {
        Log.error(`Cannot parse CSV: no sample rows after the column header.`, SCOPE)
        return null
    }
    const sampleCount = dataLines.length
    const timestamps = new Float32Array(sampleCount)
    const signals = header.columns.map(() => new Float32Array(sampleCount))
    for (let row = 0; row < sampleCount; row++) {
        const cells = dataLines[row].split(delimiter)
        timestamps[row] = parseFloat(cells[header.timeColumnIndex])
        for (let sigIdx = 0; sigIdx < header.columns.length; sigIdx++) {
            const colIdx = header.columns[sigIdx].columnIndex
            signals[sigIdx][row] = parseFloat(cells[colIdx])
        }
    }
    // Sampling-rate inference: median of inter-row deltas, with a spread check.
    if (sampleCount >= 2) {
        const deltas: number[] = []
        for (let i = 1; i < sampleCount; i++) {
            deltas.push(timestamps[i] - timestamps[i - 1])
        }
        const med = median(deltas)
        if (med > 0) {
            header.samplingRate = 1/med
            const minD = Math.min(...deltas)
            const maxD = Math.max(...deltas)
            const spread = (maxD - minD)/med
            if (spread > jitterTolerance) {
                Log.warn(
                    `CSV time-column jitter ${(spread*100).toFixed(1)}% exceeds tolerance ` +
                    `${(jitterTolerance*100).toFixed(1)}% — inferred sampling rate may be inaccurate.`,
                    SCOPE,
                )
            }
        }
        header.duration = timestamps[sampleCount - 1] - timestamps[0]
    }
    header.sampleCount = sampleCount
    return { header, signals, timestamps }
}
