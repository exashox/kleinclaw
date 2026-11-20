import { type ContactInput } from "../model/ad-model.js";
import { By, type WebElement, type WebLocator } from "../web-primitives.js";
import { type ProbingController } from "./probe.js";
interface ContactController extends ProbingController {
    webFind(type: By, value: string, options?: {
        parent?: WebLocator | WebElement | null;
        timeout?: number;
    }): Promise<WebLocator>;
    webText(type: By, value: string, options?: {
        parent?: WebLocator | WebElement | null;
        timeout?: number;
    }): Promise<string>;
}
export declare function extractSellDirectlyFromAdPage(pageUrl: string, publishedAdsById: ReadonlyMap<number, unknown>): boolean | null;
/**
 * Reads the seller's contact box. Every field is best effort: the box layout
 * changes now and then, and a missing name must not fail the whole download.
 */
export declare function extractContactFromAdPage(controller: ContactController): Promise<ContactInput>;
export {};
