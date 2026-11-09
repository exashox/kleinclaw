/*
 * SPDX-FileCopyrightText: © KleinClaw contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import path from "node:path";

import { createBrowserSession, type BrowserSession } from "../browser-session.js";
import { loadConfigFile } from "../io.js";
import {
  buildMarketSearchUrl,
  MARKET_SEARCH_EXTRACT_JS,
  summarizeMarketPrices,
  toMarketListings,
  type MarketSearchPageResult,
} from "../market-research.js";
import {
  MESSAGEBOX_READ_JS,
  normalizeMessageboxRequest,
  type MessageboxResult,
} from "../messagebox.js";
import { errorMessage } from "../value-guards.js";
import { type Workspace } from "../workspace.js";
import { type ParsedArgs } from "./types.js";

/** Machine-readable result line on stdout; everything else goes to stderr. */
export const RESULT_MARKER = "KLEINCLAW_RESULT ";
const ROOT_URL = "https://www.kleinanzeigen.de";
const MAX_SEARCH_PAGES = 3;
const PAGE_TIMEOUT_MS = 30000;

interface ReadPage {
  goto(url: string, options?: { timeout?: number; waitUntil?: "load" | "domcontentloaded" }): Promise<void>;
  evaluate(pageFunction: string, arg?: unknown): Promise<unknown>;
  url: string;
}

export type OpenReadSession = (parsed: ParsedArgs, workspace: Workspace | null) => Promise<{
  page: ReadPage;
  close(): Promise<void>;
}>;

async function openLiveReadSession(parsed: ParsedArgs, workspace: Workspace | null) {
  const config = await loadConfigFile(parsed.configPath);
  const session: BrowserSession = await createBrowserSession(config, {
    allowLiveBrowser: parsed.allowLiveBrowser,
    cwd: path.dirname(parsed.configPath),
    defaultUserDataDir: workspace?.browserProfileDir ?? null,
    timeout: PAGE_TIMEOUT_MS / 1000,
  });
  // A tab of our own keeps the user's tabs untouched; closing the session
  // closes only tabs miniclaw opened.
  const page = await session.context.newPage() as unknown as ReadPage;
  return { page, close: () => session.close() };
}

function printResult(result: unknown): void {
  console.log(`${RESULT_MARKER}${JSON.stringify(result)}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withReadSession(
  parsed: ParsedArgs,
  workspace: Workspace | null,
  openSession: OpenReadSession,
  task: (page: ReadPage) => Promise<unknown>,
): Promise<number> {
  if (!parsed.allowLiveBrowser) {
    console.error(
      `${parsed.command} reads Kleinanzeigen in the browser; rerun with --allow-live-browser.`,
    );
    return 2;
  }
  const session = await openSession(parsed, workspace);
  try {
    printResult(await task(session.page));
    return 0;
  } catch (error) {
    console.error(`${parsed.command} failed: ${errorMessage(error)}`);
    return 1;
  } finally {
    await session.close().catch(() => undefined);
  }
}

export async function runMarketSearch(
  parsed: ParsedArgs,
  workspace: Workspace | null,
  openSession: OpenReadSession = openLiveReadSession,
): Promise<number> {
  const options = parsed.read ?? {};
  const query = options.query?.trim() ?? "";
  if (!query) {
    console.error("market-search needs --query");
    return 2;
  }
  const pages = Math.min(Math.max(options.pages ?? 1, 1), MAX_SEARCH_PAGES);
  return await withReadSession(parsed, workspace, openSession, async (page) => {
    const results: MarketSearchPageResult[] = [];
    const urls: string[] = [];
    for (let pageNumber = 1; pageNumber <= pages; pageNumber += 1) {
      const url = buildMarketSearchUrl({
        query,
        categoryId: options.categoryId ?? null,
        minPrice: options.minPrice ?? null,
        maxPrice: options.maxPrice ?? null,
        page: pageNumber,
      }, ROOT_URL);
      if (pageNumber > 1) {
        // Read like a person would, not as fast as possible.
        await sleep(1500 + Math.floor(Math.random() * 1500));
      }
      await page.goto(url, { timeout: PAGE_TIMEOUT_MS, waitUntil: "load" });
      urls.push(url);
      const result = await page.evaluate(MARKET_SEARCH_EXTRACT_JS) as MarketSearchPageResult;
      results.push(result);
      if (result.noResults || result.listings.length < 25) {
        break;
      }
    }
    const listings = toMarketListings(results);
    return {
      query,
      categoryId: options.categoryId ?? null,
      minPrice: options.minPrice ?? null,
      maxPrice: options.maxPrice ?? null,
      pagesRead: results.length,
      urls,
      summary: results[0]?.summary ?? "",
      source: results.find((result) => result.source !== "none")?.source ?? "none",
      noResults: results[0]?.noResults ?? false,
      stats: summarizeMarketPrices(listings),
      listings,
    };
  });
}

export async function runMessages(
  parsed: ParsedArgs,
  workspace: Workspace | null,
  openSession: OpenReadSession = openLiveReadSession,
): Promise<number> {
  let request;
  try {
    request = normalizeMessageboxRequest({
      conversationId: parsed.read?.conversationId ?? null,
      limit: parsed.read?.limit,
      includeBuyerConversations: parsed.read?.includeBuyerConversations,
    });
  } catch (error) {
    console.error(errorMessage(error));
    return 2;
  }
  return await withReadSession(parsed, workspace, openSession, async (page) => {
    // Any www.kleinanzeigen.de page works; this one is small and needs a session.
    await page.goto(`${ROOT_URL}/m-nachrichten.html`, {
      timeout: PAGE_TIMEOUT_MS,
      waitUntil: "domcontentloaded",
    });
    if (!/^https:\/\/(www\.)?kleinanzeigen\.de\//.test(page.url)) {
      return { status: "not_logged_in" } satisfies MessageboxResult;
    }
    return await page.evaluate(MESSAGEBOX_READ_JS, request) as MessageboxResult;
  });
}
