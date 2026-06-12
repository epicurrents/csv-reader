/**
 * Public surface of the CSV reader package.
 *
 * @package    epicurrents/csv-reader
 * @copyright  2026 Sampsa Lohi
 * @license    Apache-2.0
 */

import CsvImporter from '#csv/CsvImporter'
import CsvReader from '#csv/CsvReader'
import { parseFile, parseHeader } from '#csv/CsvParser'
import CsvWorkerSubstitute from '#csv/CsvWorkerSubstitute'
import { headerToBiosignalHeader } from '#root/src/util'

export {
    CsvImporter,
    CsvReader,
    CsvWorkerSubstitute,
    headerToBiosignalHeader,
    parseFile,
    parseHeader,
}
export type {
    CsvColumn,
    CsvHeader,
    CsvParseOptions,
    CsvParseResult,
} from '#types'
