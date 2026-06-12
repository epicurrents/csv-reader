/**
 * Global property type declarations for the CSV reader.
 * @package    @epicurrents/csv-reader
 * @copyright  2026 Sampsa Lohi
 * @license    Apache-2.0
 */

/* eslint-disable */
type EpicurrentsGlobal = {
    /** The main Epicurrents application instance. */
    APP: unknown | null
    /** Master event bus for broadcasting application events. */
    EVENT_BUS: import('scoped-event-bus').ScopedEventBus | null
    /**
     * Runtime state manager of the initiated application (must be initiated
     * before creating resources).
     */
    RUNTIME: import('@epicurrents/core/dist/types/application').StateManager
}

declare global {
    /** Path where WebPack serves its public assets (js) from. */
    let __webpack_public_path__: string
    interface Window {
        /**
         * Runtime state manager of the initiated application. Having the
         * runtime accessible on the window is the workaround for the case
         * where different reader modules may bundle different versions of
         * the core package — the imported `SETTINGS` then doesn't point to
         * the same object. Hosts that build all modules against the same
         * core dependency keep the runtimes in sync without this hop.
         */
        __EPICURRENTS__: EpicurrentsGlobal
    }
}
export {}
