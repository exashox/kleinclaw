export declare const PAGE_STRUCTURE_PREFIX = "Page structure for ad";
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
/** Prints the page structure on stderr; never fails the download. */
export declare function reportPageStructure(controller: PageStructureController, adId: number, missing: string[], log?: (line: string) => void): Promise<void>;
export {};
