/*
 * SPDX-FileCopyrightText: © KleinClaw contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

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
export function parsePriceText(text: string): ParsedPrice {
  const normalized = text.replace(/\s+/g, " ").trim();
  const giveaway = /zu verschenken/i.test(normalized);
  const negotiable = /\bVB\b/.test(normalized);
  const match = /(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?\s*€/.exec(normalized);
  if (giveaway) {
    return { price: 0, negotiable, giveaway };
  }
  if (!match) {
    return { price: null, negotiable, giveaway };
  }
  const euros = Number(match[1]!.replace(/\./g, ""));
  const cents = match[2] ? Number(match[2].padEnd(2, "0")) / 100 : 0;
  return { price: euros + cents, negotiable, giveaway };
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 1) {
    return sorted[0]!;
  }
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const value = sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
  return Math.round(value * 100) / 100;
}

/** Price spread of the listings; giveaways and listings without amount are left out. */
export function summarizeMarketPrices(listings: readonly MarketListing[]): MarketPriceStats {
  const prices = listings
    .filter((listing) => !listing.giveaway && listing.price !== null && listing.price > 0)
    .map((listing) => listing.price!)
    .sort((a, b) => a - b);
  const giveaways = listings.filter((listing) => listing.giveaway).length;
  const negotiableShare = listings.length
    ? Math.round((listings.filter((listing) => listing.negotiable).length / listings.length) * 100) / 100
    : null;
  if (!prices.length) {
    return {
      listings: listings.length,
      priced: 0,
      min: null,
      p25: null,
      median: null,
      p75: null,
      max: null,
      mean: null,
      negotiableShare,
      giveaways,
    };
  }
  const mean = prices.reduce((sum, value) => sum + value, 0) / prices.length;
  return {
    listings: listings.length,
    priced: prices.length,
    min: prices[0]!,
    p25: quantile(prices, 0.25),
    median: quantile(prices, 0.5),
    p75: quantile(prices, 0.75),
    max: prices.at(-1)!,
    mean: Math.round(mean * 100) / 100,
    negotiableShare,
    giveaways,
  };
}

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
export function buildMarketSearchUrl(
  { query, categoryId = null, minPrice = null, maxPrice = null, page = 1 }: MarketSearchRequest,
  rootUrl = "https://www.kleinanzeigen.de",
): string {
  const slug = query.trim().toLowerCase()
    .replace(/[\s/]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!slug) {
    throw new Error("market search needs a non-empty query");
  }
  const segments: string[] = [];
  if (page > 1) {
    segments.push(`seite:${page}`);
  }
  if (minPrice !== null || maxPrice !== null) {
    segments.push(`preis:${minPrice ?? ""}:${maxPrice ?? ""}`);
  }
  segments.push(encodeURIComponent(slug));
  segments.push(categoryId ? `k0c${categoryId}` : "k0");
  return `${rootUrl.replace(/\/$/, "")}/s-${segments.join("/")}`;
}

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
export const MARKET_SEARCH_EXTRACT_JS = String.raw`(() => {
  const text = (node) => (node && node.textContent ? node.textContent.replace(/\s+/g, " ").trim() : "");
  const absolute = (href) => href ? new URL(href, location.origin).href : null;
  const decode = (value) => {
    if (Array.isArray(value) && value.length === 2 && typeof value[0] === "number") {
      const [kind, inner] = value;
      if (kind === 0 && inner && typeof inner === "object" && !Array.isArray(inner)) {
        return Object.fromEntries(Object.entries(inner).map(([k, v]) => [k, decode(v)]));
      }
      if (kind === 1 && Array.isArray(inner)) {
        return inner.map(decode);
      }
      return inner;
    }
    return value;
  };
  const summary = text(document.querySelector("#srp-breadcrumb-summary"));
  const noResults = /Es wurden keine Ergebnisse/i.test(document.body ? document.body.innerText : "");
  const listings = [];
  let source = "none";
  for (const island of document.querySelectorAll("astro-island[props*='sortingDate']")) {
    let props;
    try {
      const raw = JSON.parse(island.getAttribute("props") || "{}");
      props = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, decode(v)]));
    } catch {
      continue;
    }
    for (const entry of Array.isArray(props.resultAds) ? props.resultAds : []) {
      const ad = entry && !entry.sponsoredAdPresent ? entry.organicAdPreview : null;
      if (!ad || ad.id === undefined || ad.id === null) {
        continue;
      }
      source = "astro";
      listings.push({
        id: String(ad.id),
        title: String(ad.title || ""),
        description: String(ad.description || "").replace(/\s+/g, " ").trim().slice(0, 200),
        priceText: String(ad.price || "").trim(),
        oldPriceText: String(ad.startingPrice || "").trim(),
        location: [ad.locationName, ad.parentLocationName].filter(Boolean).join(" "),
        date: String(ad.sortingDate || ""),
        shipping: /versand/i.test(String(ad.shippingAvailableValue || "")),
        topAd: Boolean(ad.topAd) ||
          (Array.isArray(ad.appliedFeatures) && ad.appliedFeatures.includes("TOP_AD")),
        commercial: typeof ad.posterType === "string" ? ad.posterType !== "PRIVATE" : null,
        url: absolute(ad.seoLink),
      });
    }
  }
  if (!listings.length) {
    for (const article of document.querySelectorAll("#srchrslt-adtable > li > article[data-adid]")) {
      source = "dom";
      const priceNode = Array.from(article.querySelectorAll("p.font-strong"))
        .find((node) => !node.classList.contains("line-through") &&
          /€|VB|verschenken/i.test(node.textContent || ""));
      const spans = Array.from(article.querySelectorAll("span")).map(text);
      listings.push({
        id: article.getAttribute("data-adid"),
        title: text(article.querySelector("h3")),
        description: text(article.querySelector("h3 + p")).slice(0, 200),
        priceText: text(priceNode),
        oldPriceText: text(article.querySelector("p.line-through")),
        location: spans[0] || "",
        date: spans.find((value) =>
          /^(Heute|Gestern), \d{2}:\d{2}$|^\d{2}\.\d{2}\.\d{4}$/.test(value)) || "",
        shipping: spans.some((value) => /Versand möglich/i.test(value)),
        topAd: Boolean(article.parentElement && article.parentElement.querySelector(":scope > svg")),
        commercial: null,
        url: absolute(article.getAttribute("data-href")),
      });
    }
  }
  return { source, summary, noResults, listings };
})()`;

/** Turns page results into listings with parsed prices, without duplicates. */
export function toMarketListings(pages: readonly MarketSearchPageResult[]): MarketListing[] {
  const seen = new Set<string>();
  const listings: MarketListing[] = [];
  for (const page of pages) {
    for (const raw of page.listings) {
      const key = raw.id ?? raw.url ?? `${raw.title}|${raw.priceText}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const parsed = parsePriceText(raw.priceText);
      listings.push({
        ...raw,
        price: parsed.price,
        negotiable: parsed.negotiable,
        giveaway: parsed.giveaway,
      });
    }
  }
  return listings;
}
