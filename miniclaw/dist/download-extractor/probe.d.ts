import { type By, type WebElement, type WebLocator } from "../web-primitives.js";
export interface ProbingController {
    webProbe?(type: By, value: string, options?: {
        parent?: WebLocator | WebElement | null;
        timeout?: number;
    }): Promise<WebLocator | null>;
}
/**
 * Checks once and briefly whether an optional element exists.
 *
 * The ad page is already loaded when optional fields are read (the title is
 * awaited first), so a missing element will not appear later. The regular
 * lookup would wait through every retry (about 24 seconds) for each missing
 * field. Controllers without `webProbe` keep the regular lookup.
 */
export declare function elementPresent(controller: ProbingController, type: By, value: string, options?: {
    parent?: WebLocator | WebElement | null;
}): Promise<boolean>;
