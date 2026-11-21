/*
 * SPDX-FileCopyrightText: © Sebastian Thomschke and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * SPDX-ArtifactOfProjectHomePage: https://github.com/Second-Hand-Friends/kleinanzeigen-bot/
 */
import { OPTION_NAME_BY_CARRIER_CODE } from "../model/ad-model.js";
import { By, TimeoutError, } from "../web-primitives.js";
import { parseGermanDecimal, parsePriceAmount, shippingOptionsFromResponse, } from "./page-data.js";
import { elementPresent } from "./probe.js";
const SHIPPING_OPTIONS_URL = "https://gateway.kleinanzeigen.de/postad/api/v1/" +
    "shipping-options?posterType=PRIVATE";
/**
 * Layout of 2026-11: the shipping line ("+ Versand ab 7,69 €", "Nur Abholung")
 * is a span in the main info box; the similar-ads list below has its own
 * "Versand möglich" labels and stays out.
 */
export const MAIN_INFO_SHIPPING_SCRIPT = String.raw `(() => {
  const ownText = (el) => Array.from(el.childNodes)
    .filter((node) => node.nodeType === 3)
    .map((node) => node.textContent)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const hit = Array.from(document.querySelectorAll("#viewad-main-info span"))
    .map(ownText)
    .find((text) => /^\+?\s*(Versand|Nur Abholung)/i.test(text));
  return hit ? hit.replace(/^\+\s*/, "") : "";
})()`;
async function readShippingText(controller) {
    if (await elementPresent(controller, By.CLASS_NAME, "boxedarticle--details--shipping")) {
        return controller.webText(By.CLASS_NAME, "boxedarticle--details--shipping");
    }
    if (typeof controller.webExecute !== "function") {
        return null;
    }
    const text = String((await controller.webExecute(MAIN_INFO_SHIPPING_SCRIPT).catch(() => "")) ?? "").trim();
    return text || null;
}
export async function extractPricingInfoFromAdPage(controller) {
    if (!(await elementPresent(controller, By.ID, "viewad-price"))) {
        return [null, "NOT_APPLICABLE"];
    }
    try {
        const priceText = await controller.webText(By.ID, "viewad-price");
        const lastToken = priceText.trim().split(/\s+/).at(-1);
        if (lastToken === "€") {
            return [parsePriceAmount(priceText), "FIXED"];
        }
        if (lastToken === "VB") {
            const price = priceText.trim() === "VB" ? null : parsePriceAmount(priceText);
            return [price, "NEGOTIABLE"];
        }
        if (lastToken === "verschenken") {
            return [null, "GIVE_AWAY"];
        }
        return [null, "NOT_APPLICABLE"];
    }
    catch (error) {
        if (error instanceof TimeoutError) {
            return [null, "NOT_APPLICABLE"];
        }
        throw error;
    }
}
export async function extractShippingInfoFromAdPage(config, controller) {
    try {
        const shippingText = await readShippingText(controller);
        if (shippingText === null) {
            return ["NOT_APPLICABLE", null, null];
        }
        if (shippingText === "Nur Abholung") {
            return ["PICKUP", null, null];
        }
        if (shippingText === "Versand möglich") {
            return ["SHIPPING", null, null];
        }
        if (!shippingText.includes("€")) {
            return ["NOT_APPLICABLE", null, null];
        }
        const priceParts = shippingText.split(" ");
        const shippingCosts = parseGermanDecimal(priceParts.at(-2) ?? "");
        const priceInCent = Math.round(shippingCosts * 100);
        const response = await controller.webRequest(SHIPPING_OPTIONS_URL);
        const options = shippingOptionsFromResponse(response);
        if (config.download.includeAllMatchingShippingOptions) {
            const matchingOptions = options.filter((option) => option.priceInEuroCent === priceInCent);
            if (!matchingOptions.length) {
                return ["SHIPPING", shippingCosts, null];
            }
            const matchingSize = matchingOptions[0].packageSize;
            const shippingOptions = options
                .filter((option) => option.packageSize === matchingSize)
                .map((option) => OPTION_NAME_BY_CARRIER_CODE[option.id])
                .filter((option) => {
                if (!option) {
                    return false;
                }
                return !config.download.excludedShippingOptions.includes(option);
            });
            return ["SHIPPING", shippingCosts, shippingOptions];
        }
        const matchingOption = options.find((option) => option.priceInEuroCent === priceInCent);
        if (!matchingOption) {
            return ["SHIPPING", shippingCosts, null];
        }
        const shippingOption = OPTION_NAME_BY_CARRIER_CODE[matchingOption.id];
        if (!shippingOption ||
            config.download.excludedShippingOptions.includes(shippingOption)) {
            return ["SHIPPING", shippingCosts, null];
        }
        return ["SHIPPING", shippingCosts, [shippingOption]];
    }
    catch (error) {
        if (error instanceof TimeoutError) {
            return ["NOT_APPLICABLE", null, null];
        }
        throw error;
    }
}
