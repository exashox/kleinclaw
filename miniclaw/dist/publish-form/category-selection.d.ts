import { type PublishingFormController, type PublishingFormOptions, type SetCategoryOptions } from "./types.js";
export declare function resolveCategorySuggestions(controller: Pick<PublishingFormController, "webClick" | "webFindAll" | "webProbe" | "webSleep">, category: string, { quickDomTimeout }?: PublishingFormOptions): Promise<boolean>;
/**
 * Kleinanzeigen lists categories by display name, so configured IDs such as
 * "210/211/bootszubehoer" are mapped back to their most specific name path.
 */
export declare function categoryNamePath(category: string): string[];
export declare function setCategory(controller: Pick<PublishingFormController, "webClick" | "webExecute" | "webFind" | "webFindAll" | "webOpen" | "webProbe" | "webSleep">, { adFile, category, rootUrl, quickDomTimeout }: SetCategoryOptions): Promise<void>;
