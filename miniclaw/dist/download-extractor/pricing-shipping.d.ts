import { type AdInput } from "../model/ad-model.js";
import { type Config } from "../model/config-model.js";
import { By, type WebResponse } from "../web-primitives.js";
import { type ProbingController } from "./probe.js";
/**
 * Layout of 2026-11: the shipping line ("+ Versand ab 7,69 €", "Nur Abholung")
 * is a span in the main info box; the similar-ads list below has its own
 * "Versand möglich" labels and stays out.
 */
export declare const MAIN_INFO_SHIPPING_SCRIPT: string;
interface PricingShippingController extends ProbingController {
    webText(type: By, value: string): Promise<string>;
    webExecute?(jscode: string): Promise<unknown>;
    webRequest(url: string, method?: string, validResponseCodes?: number | Iterable<number>, headers?: Record<string, string> | null): Promise<WebResponse>;
}
export declare function extractPricingInfoFromAdPage(controller: PricingShippingController): Promise<[
    AdInput["price"],
    NonNullable<AdInput["price_type"]>
]>;
export declare function extractShippingInfoFromAdPage(config: Config, controller: PricingShippingController): Promise<[
    NonNullable<AdInput["shipping_type"]>,
    number | null,
    string[] | null
]>;
export {};
