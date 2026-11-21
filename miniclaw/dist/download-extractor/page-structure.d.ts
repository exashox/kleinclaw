export declare const PAGE_STRUCTURE_PREFIX = "Page structure for ad";
/** When set, the structure is saved there as page-structure-<adId>.json. */
export declare const PAGE_STRUCTURE_DIR_ENV = "MINICLAW_PAGE_STRUCTURE_DIR";
interface PageStructureController {
    webExecute(jscode: string): Promise<unknown>;
}
/**
 * Collects where images, the shipping line, the date, and state labels sit on
 * the ad page: element paths (tag, id, up to three classes) plus at most 60
 * characters of the element's own text. The description is skipped. Used to
 * find selectors when Kleinanzeigen changes the layout.
 */
export declare const PAGE_STRUCTURE_SCRIPT: string;
export interface ReportPageStructureOptions {
    log?: (line: string) => void;
    directory?: string;
}
/**
 * Saves the page structure to `directory` (default: the
 * MINICLAW_PAGE_STRUCTURE_DIR environment variable), otherwise prints it on
 * stderr; never fails the download.
 */
export declare function reportPageStructure(controller: PageStructureController, adId: number, missing: string[], { log, directory, }?: ReportPageStructureOptions): Promise<void>;
export {};
