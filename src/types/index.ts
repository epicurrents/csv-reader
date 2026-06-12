/**
 * CSV reader types.
 * @package    epicurrents/csv-reader
 * @copyright  2026 Sampsa Lohi
 * @license    Apache-2.0
 */

/**
 * One channel column parsed from a CSV file.
 *
 * Column label and physical unit are extracted from the header-row syntax
 * `<label>[<unit>]` — e.g. `wrist_x[g]` becomes `{ label: "wrist_x", unit: "g" }`.
 * A column without a unit annotation gets `unit: ""`, and downstream consumers
 * are expected to handle the unitless case (typically falling back to a per-file
 * default declared in the metadata block).
 */
export type CsvColumn = {
    /** Zero-based index of this column in the CSV file's row layout (time-column index = 0). */
    columnIndex: number
    /** Display label for the channel. */
    label: string
    /** Physical unit string as written in the header annotation (e.g. `"g"`, `"uV"`, `""`). */
    unit: string
}

/**
 * Result of parsing a CSV file's header — column metadata, the inferred sampling
 * rate, the time column's index, and any free-form key/value pairs from the `#`
 * metadata block. Sample data is materialised separately to keep header sniffing
 * cheap (the importer reads only the first ~4 KB to populate this).
 */
export type CsvHeader = {
    /** Column descriptors for non-time channels, in row order. */
    columns: CsvColumn[]
    /** Total recording duration in seconds, inferred from the time column when fully parsed. */
    duration: number
    /** Sampling rate in Hz, inferred from the median time-column delta. */
    samplingRate: number
    /** Sample count per column (= total rows minus the header). Zero until full parse. */
    sampleCount: number
    /** Free-form metadata key/value pairs from the `#`-prefixed block at the top of the file. */
    metadata: Record<string, string>
    /** Index of the column carrying time stamps. */
    timeColumnIndex: number
}

/**
 * Output of a full CSV parse — header info plus per-column sample data and the
 * time vector. Sample arrays are typed as `Float32Array` to match the cache
 * layout used by `GenericSignalReader`.
 */
export type CsvParseResult = {
    header: CsvHeader
    /** One Float32Array per non-time column, indexed parallel to `header.columns`. */
    signals: Float32Array[]
    /** Sample timestamps in seconds. Length matches each entry in `signals`. */
    timestamps: Float32Array
}

/**
 * Configurable knobs for the parser. Defaults are sensible for the canonical
 * accelerometry layout; adjust per source format as needed.
 */
export type CsvParseOptions = {
    /** Field delimiter. Defaults to `,`. Use `"\t"` for TSV. */
    delimiter?: string
    /**
     * Names that identify the time column (matched case-insensitively against
     * the header label). Defaults to `["time", "t"]`.
     */
    timeColumnNames?: string[]
    /**
     * Maximum allowed relative spread (max-min / median) of inter-row time deltas
     * before the parser logs a warning. Default `0.1` (= 10 %). Strict-uniform
     * sampling is a precondition for a meaningful single sampling rate; loose
     * timing earns a warning but isn't fatal.
     */
    samplingJitterTolerance?: number
}
