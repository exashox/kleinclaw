/** One search result as read from the Kleinanzeigen result list. */
export interface MarketListing {
    id: string | null;
    title: string;
    description: string;
    /** Asking price in euros; null for "VB" without amount or unknown, 0 for giveaways. */
    price: number | null;
    priceText: string;
    /** Struck-through earlier price when the seller reduced it. */
    oldPriceText: string;
    negotiable: boolean;
    giveaway: boolean;
    location: string;
    date: string;
    shipping: boolean;
    topAd: boolean;
    /** True for commercial sellers, null when the page did not say. */
    commercial: boolean | null;
    url: string | null;
}
export interface MarketPriceStats {
    listings: number;
    priced: number;
    min: number | null;
    p25: number | null;
    median: number | null;
    p75: number | null;
    max: number | null;
    mean: number | null;
    negotiableShare: number | null;
    giveaways: number;
}
export interface ParsedPrice {
    price: number | null;
    negotiable: boolean;
    giveaway: boolean;
}
/**
 * Reads German Kleinanzeigen price labels such as "120 €", "1.250 € VB",
 * "12,50 €", "VB" and "Zu verschenken". Only the first amount is used, so the
 * struck-through old price must not be part of the text.
 */
export declare function parsePriceText(text: string): ParsedPrice;
/** Price spread of the listings; giveaways and listings without amount are left out. */
export declare function summarizeMarketPrices(listings: readonly MarketListing[]): MarketPriceStats;
export interface MarketSearchRequest {
    query: string;
    categoryId?: number | null;
    minPrice?: number | null;
    maxPrice?: number | null;
    page?: number;
}
/**
 * Search URL in the site's path form, e.g. `/s-seite:2/preis:50:100/ipad-air/k0c225`.
 * Every filter is a path segment after `/s-`; the keyword slug uses dashes.
 */
export declare function buildMarketSearchUrl({ query, categoryId, minPrice, maxPrice, page }: MarketSearchRequest, rootUrl?: string): string;
export interface RawMarketListing {
    id: string | null;
    title: string;
    description: string;
    priceText: string;
    oldPriceText: string;
    location: string;
    date: string;
    shipping: boolean;
    topAd: boolean;
    commercial: boolean | null;
    url: string | null;
}
/** Page result of {@link MARKET_SEARCH_EXTRACT_JS}. */
export interface MarketSearchPageResult {
    source: "astro" | "dom" | "none";
    summary: string;
    noResults: boolean;
    listings: RawMarketListing[];
}
/**
 * Runs in the search result page. Prefers the Astro island props, which hold
 * exactly the organic results (TOP ads included, sponsored and "other places"
 * results excluded); falls back to the result cards in `#srchrslt-adtable`.
 */
export declare const MARKET_SEARCH_EXTRACT_JS: string;
/** Turns page results into listings with parsed prices, without duplicates. */
export declare function toMarketListings(pages: readonly MarketSearchPageResult[]): MarketListing[];
