/*
 * SPDX-FileCopyrightText: © Sebastian Thomschke and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * SPDX-ArtifactOfProjectHomePage: https://github.com/Second-Hand-Friends/kleinanzeigen-bot/
 */
import fs from "node:fs/promises";
import path from "node:path";
import { elementAttribute } from "./browser-elements.js";
import { elementPresent } from "./probe.js";
import { By, TimeoutError, } from "../web-primitives.js";
const DEFAULT_IMAGE_DOWNLOAD_TIMEOUT = 60;
/**
 * Layout of 2026-11: the gallery sits next to #viewad-main-info in the same
 * column. Ad images come from the prod-ads image API; the thumbnails in the
 * seller's other ads and the similar ads (list items) stay out. Returns the
 * image URLs in page order as a JSON array.
 */
export const MAIN_GALLERY_SCRIPT = String.raw `(() => {
  const main = document.querySelector("#viewad-main-info");
  const scope = (main && main.parentElement) || document;
  const seen = new Set();
  const urls = [];
  for (const img of scope.querySelectorAll("img")) {
    if (img.closest("li, [id$='-ads-list']")) {
      continue;
    }
    const src = img.currentSrc || img.src || img.dataset.src || img.dataset.imgsrc || "";
    if (!/^https:\/\/img\.kleinanzeigen\.de\/api\/v1\/prod-ads\/images\//.test(src)) {
      continue;
    }
    const key = src.split("?")[0];
    if (!seen.has(key)) {
      seen.add(key);
      urls.push(src);
    }
  }
  return JSON.stringify(urls);
})()`;
async function mainGalleryImageUrls(controller) {
    if (typeof controller.webExecute !== "function") {
        return [];
    }
    const raw = await controller.webExecute(MAIN_GALLERY_SCRIPT).catch(() => "[]");
    try {
        const urls = JSON.parse(String(raw ?? "[]"));
        return Array.isArray(urls)
            ? urls.filter((url) => typeof url === "string")
            : [];
    }
    catch {
        return [];
    }
}
function contentTypeExtension(contentType) {
    const normalized = (contentType ?? "").split(";", 1)[0]?.trim().toLowerCase();
    switch (normalized) {
        case "image/jpeg":
            return ".jpg";
        case "image/png":
            return ".png";
        case "image/gif":
            return ".gif";
        case "image/webp":
            return ".webp";
        case "image/avif":
            return ".avif";
        default:
            return "";
    }
}
export async function downloadAndSaveImage(url, directory, filenamePrefix, imageNumber, { timeout = DEFAULT_IMAGE_DOWNLOAD_TIMEOUT } = {}) {
    const controller = new AbortController();
    const timeoutMs = Math.max(1, Math.trunc(timeout * 1000));
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) {
            return null;
        }
        const fileEnding = contentTypeExtension(response.headers.get("content-type"));
        const imagePath = path.join(directory, `${filenamePrefix}${imageNumber}${fileEnding}`);
        await fs.writeFile(imagePath, Buffer.from(await response.arrayBuffer()));
        return imagePath;
    }
    catch {
        return null;
    }
    finally {
        clearTimeout(timer);
    }
}
export async function downloadImagesFromAdPage(controller, downloadImage, directory, adFileStem, { imageDownloadTimeout } = {}) {
    const imagePaths = [];
    const imageFilenamePrefix = `${adFileStem}__img`;
    if (!(await elementPresent(controller, By.CLASS_NAME, "galleryimage-large"))) {
        let imageNumber = 1;
        for (const url of await mainGalleryImageUrls(controller)) {
            const imagePath = await downloadImage(url, directory, imageFilenamePrefix, imageNumber, { timeout: imageDownloadTimeout });
            if (imagePath) {
                imagePaths.push(path.basename(imagePath));
            }
            imageNumber += 1;
        }
        return imagePaths;
    }
    try {
        const imageBox = await controller.webFind(By.CLASS_NAME, "galleryimage-large");
        const images = await controller.webFindAll(By.CSS_SELECTOR, ".galleryimage-element[data-ix] > img", { parent: imageBox });
        let imageNumber = 1;
        for (const imageElement of images) {
            const currentImageUrl = await elementAttribute(imageElement, "src");
            if (currentImageUrl === null) {
                continue;
            }
            const imagePath = await downloadImage(currentImageUrl, directory, imageFilenamePrefix, imageNumber, { timeout: imageDownloadTimeout });
            if (imagePath) {
                imagePaths.push(path.basename(imagePath));
            }
            imageNumber += 1;
        }
    }
    catch (error) {
        if (!(error instanceof TimeoutError)) {
            throw error;
        }
    }
    return imagePaths;
}
