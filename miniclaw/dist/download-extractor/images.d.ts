import { type ProbingController } from "./probe.js";
import { By, type WebElement, type WebLocator } from "../web-primitives.js";
export type DownloadImage = (url: string, directory: string, filenamePrefix: string, imageNumber: number, options?: DownloadImageOptions) => Promise<string | null> | string | null;
export interface DownloadImageOptions {
    timeout?: number;
}
export interface DownloadImagesFromAdPageOptions {
    imageDownloadTimeout?: number;
}
interface DownloadImagesController extends ProbingController {
    webExecute?(jscode: string): Promise<unknown>;
    webFind(type: By, value: string, options?: {
        parent?: WebLocator | WebElement | null;
        timeout?: number;
    }): Promise<WebLocator>;
    webFindAll(type: By, value: string, options?: {
        parent?: WebLocator | WebElement | null;
        timeout?: number;
    }): Promise<WebElement[]>;
}
/**
 * Layout of 2026-11: the gallery sits next to #viewad-main-info in the same
 * column. Ad images come from the prod-ads image API; the thumbnails in the
 * seller's other ads and the similar ads (list items) stay out. Returns the
 * image URLs in page order as a JSON array.
 */
export declare const MAIN_GALLERY_SCRIPT: string;
export declare function downloadAndSaveImage(url: string, directory: string, filenamePrefix: string, imageNumber: number, { timeout }?: DownloadImageOptions): Promise<string | null>;
export declare function downloadImagesFromAdPage(controller: DownloadImagesController, downloadImage: DownloadImage, directory: string, adFileStem: string, { imageDownloadTimeout }?: DownloadImagesFromAdPageOptions): Promise<string[]>;
export {};
