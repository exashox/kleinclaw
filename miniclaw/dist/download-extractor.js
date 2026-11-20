/*
 * SPDX-FileCopyrightText: © Sebastian Thomschke and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * SPDX-ArtifactOfProjectHomePage: https://github.com/Second-Hand-Friends/kleinanzeigen-bot/
 */
import fs from "node:fs/promises";
import path from "node:path";
import { extractAdIdFromAdUrl as parseAdIdFromAdUrl } from "./ad-identity.js";
import { extractCategoryFromAdPage as extractPageCategory, extractSpecialAttributesFromAdPage as extractPageSpecialAttributes, extractSpecialAttributesFromDom as extractPageSpecialAttributesFromDom, } from "./download-extractor/classification.js";
import { extractContactFromAdPage as extractPageContact, extractSellDirectlyFromAdPage as extractPageSellDirectly, } from "./download-extractor/contact.js";
import { downloadAndSaveImage as downloadImageFile, downloadImagesFromAdPage as downloadPageImages, } from "./download-extractor/images.js";
import { dimensionsFromBelenConf, parseGermanCreationDate, textAttribute, translateDamageAttribute, } from "./download-extractor/page-data.js";
import { extractPricingInfoFromAdPage as extractPagePricingInfo, extractShippingInfoFromAdPage as extractPageShippingInfo, } from "./download-extractor/pricing-shipping.js";
import { renderDownloadAdFileStem as renderConfiguredDownloadAdFileStem, renderDownloadFolderName as renderConfiguredDownloadFolderName, renderDownloadNameWithBudget as renderConfiguredDownloadNameWithBudget, } from "./download-extractor/naming.js";
import { fileExists, removeTreeWithRetries, saveDownloadedAd, STAGING_DIR_PREFIX, } from "./download-extractor/persistence.js";
import { elementPresent, } from "./download-extractor/probe.js";
import { contentHashForLoadedAd, toAd, } from "./model/ad-model.js";
import { By, TimeoutError, } from "./web-primitives.js";
export { sanitizeFolderName, } from "./download-extractor/naming.js";
export { AD_SCHEMA_HEADER, FileExistsError, } from "./download-extractor/persistence.js";
const LOG_SNIPPET_LIMIT = 120;
const ELLIPSIS = "...";
export class DownloadAdExtractor {
    controller;
    config;
    publishedAdsById;
    downloadDir;
    downloadImage;
    constructor({ controller, config, downloadDir, downloadImage = DownloadAdExtractor.downloadAndSaveImage, publishedAdsById = new Map(), }) {
        this.controller = controller;
        this.config = config;
        this.downloadDir = downloadDir;
        this.downloadImage = downloadImage;
        this.publishedAdsById = publishedAdsById;
    }
    static truncateLogSnippet(value, maxLength = LOG_SNIPPET_LIMIT) {
        if (maxLength <= 0) {
            return "";
        }
        if (value.length <= maxLength) {
            return value;
        }
        if (maxLength <= ELLIPSIS.length) {
            return ELLIPSIS.slice(0, maxLength);
        }
        return value.slice(0, maxLength - ELLIPSIS.length) + ELLIPSIS;
    }
    static async downloadAndSaveImage(url, directory, filenamePrefix, imageNumber, options) {
        return downloadImageFile(url, directory, filenamePrefix, imageNumber, options);
    }
    renderDownloadNameWithBudget(template, adId, title, maxLength) {
        return renderConfiguredDownloadNameWithBudget(template, adId, title, maxLength);
    }
    renderDownloadAdFileStem(adId, title) {
        return renderConfiguredDownloadAdFileStem(this.config, adId, title);
    }
    renderDownloadFolderName(adId, title) {
        return renderConfiguredDownloadFolderName(this.config, adId, title);
    }
    async downloadImagesFromAdPage(directory, adFileStem) {
        return downloadPageImages(this.controller, this.downloadImage, directory, adFileStem, { imageDownloadTimeout: this.config.timeouts.resolve("imageDownload") });
    }
    async extractTitleFromAdPage() {
        return this.controller.webText(By.ID, "viewad-title");
    }
    extractAdIdFromAdUrl(url) {
        return parseAdIdFromAdUrl(url);
    }
    async extractCategoryFromAdPage() {
        return extractPageCategory(this.controller);
    }
    async extractSpecialAttributesFromAdPage(belenConf) {
        return extractPageSpecialAttributes(this.controller, belenConf);
    }
    async extractSpecialAttributesFromDom() {
        return extractPageSpecialAttributesFromDom(this.controller);
    }
    async extractPricingInfoFromAdPage() {
        return extractPagePricingInfo(this.controller);
    }
    async extractShippingInfoFromAdPage() {
        return extractPageShippingInfo(this.config, this.controller);
    }
    async extractSellDirectlyFromAdPage() {
        return extractPageSellDirectly(this.controller.page?.url ?? "", this.publishedAdsById);
    }
    async extractContactFromAdPage() {
        return extractPageContact(this.controller);
    }
    async extractAdPageInfo(directory, adId, adFileStem, options = {}) {
        const active = options.active ?? true;
        const title = await this.extractTitleFromAdPage();
        const belenConf = await this.controller.webExecute("window.BelenConf");
        const dimensions = dimensionsFromBelenConf(belenConf);
        const adType = textAttribute(dimensions, "ad_type");
        const pageUrl = this.controller.page?.url ?? "";
        const info = {
            active,
            type: adType === "OFFER" || adType === "WANTED"
                ? adType
                : pageUrl.includes("s-anzeige")
                    ? "OFFER"
                    : "WANTED",
            category: await this.extractCategoryFromAdPage(),
            title,
        };
        const thirdCategoryId = textAttribute(dimensions, "l3_category_id");
        if (thirdCategoryId) {
            info.category = `${info.category}/${thirdCategoryId}`;
        }
        const rawDescription = (await this.controller.webText(By.ID, "viewad-description-text")).trim();
        let descriptionText = rawDescription;
        const prefix = this.config.adDefaults.descriptionPrefix.trim();
        const suffix = this.config.adDefaults.descriptionSuffix.trim();
        if (prefix && descriptionText.startsWith(prefix)) {
            descriptionText = descriptionText.slice(prefix.length);
        }
        if (suffix && descriptionText.endsWith(suffix)) {
            descriptionText = descriptionText.slice(0, -suffix.length);
        }
        info.description = descriptionText.trim();
        const specialAttributes = await this.extractSpecialAttributesFromAdPage(belenConf);
        if (typeof specialAttributes.schaden_s === "string") {
            specialAttributes.schaden_s = translateDamageAttribute(specialAttributes.schaden_s);
        }
        info.special_attributes = specialAttributes;
        const [price, priceType] = await this.extractPricingInfoFromAdPage();
        info.price = price;
        info.price_type = priceType;
        const [shippingType, shippingCosts, shippingOptions] = await this.extractShippingInfoFromAdPage();
        info.shipping_type = shippingType;
        info.shipping_costs = shippingCosts;
        info.shipping_options = shippingOptions;
        info.sell_directly = await this.extractSellDirectlyFromAdPage();
        info.images = await this.downloadImagesFromAdPage(directory, adFileStem);
        info.contact = await this.extractContactFromAdPage();
        info.id = adId;
        info.created_on = await this.extractCreationDateFromAdPage();
        info.updated_on = null;
        info.content_hash = contentHashForLoadedAd(toAd(info, this.config.adDefaults));
        return info;
    }
    /**
     * Reads the creation date best effort. Its position on the page changes with
     * every layout update, and the date is metadata only (not part of the content
     * hash), so a missing date must not fail the download.
     */
    async extractCreationDateFromAdPage() {
        const selectors = [
            [
                By.XPATH,
                "/html/body/div[1]/div[2]/div/section[2]/section/section/" +
                    "article/div[3]/div[2]/div[2]/div[1]/span",
            ],
            [By.CSS_SELECTOR, "#viewad-extra-info > div:nth-child(1) > span:nth-child(2)"],
        ];
        const candidates = [];
        for (const [type, value] of selectors) {
            if (!(await elementPresent(this.controller, type, value))) {
                continue;
            }
            try {
                candidates.push(await this.controller.webText(type, value));
            }
            catch (error) {
                if (!(error instanceof TimeoutError)) {
                    throw error;
                }
            }
        }
        // Fallback: the first German date in the extra-info box, wherever it sits now.
        const extraInfo = await this.controller.webExecute("document.querySelector('#viewad-extra-info')?.innerText ?? ''").catch(() => "");
        candidates.push(String(extraInfo ?? ""));
        for (const candidate of candidates) {
            const match = /\b(\d{2}\.\d{2}\.\d{4})\b/.exec(candidate);
            if (!match) {
                continue;
            }
            try {
                return parseGermanCreationDate(match[1]);
            }
            catch {
                continue;
            }
        }
        return null;
    }
    async extractAdPageInfoWithDirectoryHandling(relativeDirectory, adId, options = {}) {
        const title = await this.extractTitleFromAdPage();
        const adFileStem = this.renderDownloadAdFileStem(adId, title);
        const finalDir = path.join(relativeDirectory, this.renderDownloadFolderName(adId, title));
        const stagingDir = path.join(relativeDirectory, `${STAGING_DIR_PREFIX}${adFileStem}`);
        if (await fileExists(stagingDir)) {
            await removeTreeWithRetries(stagingDir);
        }
        await fs.mkdir(stagingDir, { recursive: true });
        try {
            const adConfig = await this.extractAdPageInfo(stagingDir, adId, adFileStem, options);
            return { adConfig, adFileStem, finalDir, stagingDir };
        }
        catch (error) {
            if (await fileExists(stagingDir)) {
                await removeTreeWithRetries(stagingDir);
            }
            throw error;
        }
    }
    async downloadAd(adId, options = {}) {
        const { adConfig, adFileStem, finalDir, stagingDir, } = await this.extractAdPageInfoWithDirectoryHandling(this.downloadDir, adId, options);
        await saveDownloadedAd({
            adConfig,
            adFileStem,
            adId,
            finalDir,
            stagingDir,
        });
    }
}
