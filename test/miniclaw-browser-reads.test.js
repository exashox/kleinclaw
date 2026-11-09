import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runMarketSearch, runMessages, RESULT_MARKER } from "../miniclaw/dist/cli/browser-reads.js";
import { parseArgs } from "../miniclaw/dist/cli/parser.js";
import {
  buildMarketSearchUrl,
  parsePriceText,
  summarizeMarketPrices,
  toMarketListings,
} from "../miniclaw/dist/market-research.js";
import {
  MESSAGEBOX_READ_JS,
  normalizeMessageboxRequest,
} from "../miniclaw/dist/messagebox.js";

async function captureConsole(run) {
  const stdout = [];
  const stderr = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => stdout.push(args.join(" "));
  console.error = (...args) => stderr.push(args.join(" "));
  try {
    const code = await run();
    return { code, stdout, stderr };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function resultFrom(stdout) {
  const line = stdout.find((entry) => entry.startsWith(RESULT_MARKER));
  return line ? JSON.parse(line.slice(RESULT_MARKER.length)) : null;
}

function rawListing(id, priceText, extra = {}) {
  return {
    id,
    title: `Schreibtischlampe ${id}`,
    description: "",
    priceText,
    oldPriceText: "",
    location: "12345 Musterstadt",
    date: "Heute, 10:00",
    shipping: false,
    topAd: false,
    commercial: false,
    url: `https://www.kleinanzeigen.de/s-anzeige/x/${id}`,
    ...extra,
  };
}

describe("market research helpers", () => {
  it("parses German price labels", () => {
    assert.deepEqual(parsePriceText("120 €"), { price: 120, negotiable: false, giveaway: false });
    assert.deepEqual(parsePriceText("1.250 € VB"), { price: 1250, negotiable: true, giveaway: false });
    assert.deepEqual(parsePriceText("12,5 €"), { price: 12.5, negotiable: false, giveaway: false });
    assert.deepEqual(parsePriceText(" VB"), { price: null, negotiable: true, giveaway: false });
    assert.deepEqual(parsePriceText("Zu verschenken"), { price: 0, negotiable: false, giveaway: true });
  });

  it("builds search URLs in the path form the site uses", () => {
    assert.equal(
      buildMarketSearchUrl({ query: "iPad Air" }),
      "https://www.kleinanzeigen.de/s-ipad-air/k0",
    );
    assert.equal(
      buildMarketSearchUrl({ query: "ipad air", categoryId: 225, minPrice: 50, maxPrice: 100, page: 2 }),
      "https://www.kleinanzeigen.de/s-seite:2/preis:50:100/ipad-air/k0c225",
    );
    assert.equal(
      buildMarketSearchUrl({ query: "Kühlschrank", maxPrice: 300 }),
      "https://www.kleinanzeigen.de/s-preis::300/k%C3%BChlschrank/k0",
    );
    assert.throws(() => buildMarketSearchUrl({ query: "  " }), /non-empty query/);
  });

  it("summarizes prices without giveaways, amounts missing, or duplicates", () => {
    const listings = toMarketListings([
      {
        source: "astro",
        summary: "",
        noResults: false,
        listings: [
          rawListing("1", "10 €"),
          rawListing("2", "20 € VB"),
          rawListing("3", "30 €"),
          rawListing("4", "VB"),
          rawListing("5", "Zu verschenken"),
        ],
      },
      { source: "astro", summary: "", noResults: false, listings: [rawListing("3", "30 €")] },
    ]);
    assert.equal(listings.length, 5);
    assert.deepEqual(summarizeMarketPrices(listings), {
      listings: 5,
      priced: 3,
      min: 10,
      p25: 15,
      median: 20,
      p75: 25,
      max: 30,
      mean: 20,
      negotiableShare: 0.4,
      giveaways: 1,
    });
  });
});

describe("miniclaw market-search command", () => {
  it("reads pages until a short page and prints one structured result", async () => {
    const visited = [];
    const pages = [
      Array.from({ length: 25 }, (_, index) => rawListing(String(index + 1), `${(index + 1) * 10} €`)),
      [rawListing("26", "500 €"), rawListing("1", "10 €")],
    ];
    let closed = false;
    const openSession = async () => ({
      page: {
        url: "about:blank",
        async goto(url) {
          visited.push(url);
        },
        async evaluate() {
          return { source: "astro", summary: "1 - 25 von 26", noResults: false, listings: pages[visited.length - 1] };
        },
      },
      async close() {
        closed = true;
      },
    });
    const parsed = parseArgs([
      "node", "miniclaw", "market-search", "--allow-live-browser",
      "--query=schreibtischlampe", "--category-id=80", "--pages=3",
    ]);

    const { code, stdout } = await captureConsole(() => runMarketSearch(parsed, null, openSession));

    assert.equal(code, 0);
    assert.equal(closed, true);
    assert.deepEqual(visited, [
      "https://www.kleinanzeigen.de/s-schreibtischlampe/k0c80",
      "https://www.kleinanzeigen.de/s-seite:2/schreibtischlampe/k0c80",
    ]);
    const result = resultFrom(stdout);
    assert.equal(result.pagesRead, 2);
    assert.equal(result.listings.length, 26, "the repeated listing is counted once");
    assert.equal(result.stats.max, 500);
  });

  it("refuses to run without --allow-live-browser or a query", async () => {
    const openSession = async () => assert.fail("must not open a browser");
    const noFlag = await captureConsole(() =>
      runMarketSearch(parseArgs(["node", "miniclaw", "market-search", "--query=lampe"]), null, openSession));
    assert.equal(noFlag.code, 2);
    assert.match(noFlag.stderr.join("\n"), /--allow-live-browser/);

    const noQuery = await captureConsole(() =>
      runMarketSearch(parseArgs(["node", "miniclaw", "market-search", "--allow-live-browser"]), null, openSession));
    assert.equal(noQuery.code, 2);
    assert.throws(
      () => parseArgs(["node", "miniclaw", "market-search", "--pages=zwei"]),
      /--pages must be a non-negative whole number/,
    );
  });
});

describe("miniclaw messages command", () => {
  it("opens a kleinanzeigen page and passes the normalized request to the page script", async () => {
    let received = null;
    const openSession = async () => ({
      page: {
        url: "about:blank",
        async goto(url) {
          this.url = url;
        },
        async evaluate(script, request) {
          received = { script, request };
          return { status: "ok", mode: "list", total: 0, skippedBuyerConversations: 0, conversations: [] };
        },
      },
      async close() {},
    });
    const parsed = parseArgs(["node", "miniclaw", "messages", "--allow-live-browser", "--limit=500"]);

    const { code, stdout } = await captureConsole(() => runMessages(parsed, null, openSession));

    assert.equal(code, 0);
    assert.equal(received.script, MESSAGEBOX_READ_JS);
    assert.deepEqual(received.request, {
      conversationId: null,
      limit: 100,
      includeBuyerConversations: false,
    });
    assert.equal(resultFrom(stdout).status, "ok");
  });

  it("reports a login redirect as not logged in", async () => {
    const openSession = async () => ({
      page: {
        url: "about:blank",
        async goto() {
          this.url = "https://login.kleinanzeigen.de/u/login";
        },
        async evaluate() {
          assert.fail("must not query the message box");
        },
      },
      async close() {},
    });
    const parsed = parseArgs(["node", "miniclaw", "messages", "--allow-live-browser"]);
    const { stdout } = await captureConsole(() => runMessages(parsed, null, openSession));
    assert.deepEqual(resultFrom(stdout), { status: "not_logged_in" });
  });

  it("validates conversation ids", () => {
    assert.throws(
      () => normalizeMessageboxRequest({ conversationId: "../../x" }),
      /conversation id must contain only/,
    );
    assert.deepEqual(normalizeMessageboxRequest({ conversationId: "5p1:2:3" }), {
      conversationId: "5p1:2:3",
      limit: 30,
      includeBuyerConversations: false,
    });
  });
});

describe("message box page script", () => {
  const TOKEN = "Bearer secret-gateway-token";

  function fakeFetch(routes, calls) {
    return async (url, init = {}) => {
      calls.push({ url: String(url), init });
      const route = routes.find(([pattern]) => pattern.test(String(url)));
      if (!route) {
        return new Response("not found", { status: 404 });
      }
      const [, status, body, headers = {}] = route;
      return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json", ...headers },
      });
    };
  }

  async function runScript(routes, request) {
    const calls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fakeFetch(routes, calls);
    try {
      // eslint-disable-next-line no-eval
      const pageFunction = (0, eval)(`(${MESSAGEBOX_READ_JS})`);
      return { result: await pageFunction(request), calls };
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  const sessionRoutes = [
    [/\/m-access-token\.json$/, 200, { expiration: 1 }, { authorization: TOKEN }],
    [/\/messagebox-api\/view$/, 200, { user: { id: 4711 } }],
  ];

  it("lists seller conversations and skips buyer conversations", async () => {
    const { result, calls } = await runScript([
      ...sessionRoutes,
      [/\/conversations\?page=0&size=30$/, 200, {
        conversations: [
          {
            id: "c1", adId: "3210987654", adTitle: "Schreibtischlampe", role: "SELLER",
            buyerName: "Erika", sellerName: "Ich", unread: true, unreadMessagesCount: 2,
            receivedDate: "2026-11-08T14:21:39.123+0100", adStatus: "ACTIVE",
          },
          { id: "c2", adId: "999", adTitle: "Privatkauf", role: "BUYER", sellerName: "Max" },
        ],
        _meta: { numFound: 2, pageSize: 30 },
      }],
    ], { conversationId: null, limit: 20, includeBuyerConversations: false });

    assert.equal(result.status, "ok");
    assert.equal(result.skippedBuyerConversations, 1);
    assert.deepEqual(result.conversations, [{
      id: "c1",
      adId: "3210987654",
      adTitle: "Schreibtischlampe",
      adStatus: "ACTIVE",
      role: "seller",
      counterpart: "Erika",
      unread: true,
      unreadCount: 2,
      lastActivity: "2026-11-08T14:21:39.123+0100",
      preview: "",
    }]);
    const gatewayCall = calls.find((call) => call.url.startsWith("https://gateway.kleinanzeigen.de"));
    assert.equal(gatewayCall.url, "https://gateway.kleinanzeigen.de/messagebox/api/users/4711/conversations?page=0&size=30");
    assert.equal(gatewayCall.init.headers.Authorization, TOKEN);
    assert.doesNotMatch(JSON.stringify(result), /secret-gateway-token/);
  });

  it("returns a conversation oldest first without blank entries and with offers", async () => {
    const { result } = await runScript([
      ...sessionRoutes,
      [/\/conversations\/c1\?contentWarnings=true$/, 200, {
        id: "c1", adId: "3210987654", adTitle: "Schreibtischlampe", role: "SELLER", buyerName: "Erika",
        messages: [
          {
            messageId: "m3", boundness: "OUTBOUND", textShort: "Ja, ist",
            unichatMessage: { payload: { content: { text: "Ja, ist noch da." } } },
            receivedDate: "2026-11-08T15:00:00.000+0100", type: "MESSAGE",
          },
          { messageId: "m2", boundness: "INBOUND", textShort: "", receivedDate: "2026-11-08T14:59:00.000+0100" },
          {
            type: "PAYMENT_AND_SHIPPING_MESSAGE", paymentAndShippingMessageType: "BUYER_OFFER_MADE_SELLER_MESSAGE",
            offeredPriceInEuroCent: 1800, itemPriceInEuroCent: 2500, shippingCostInEuroCent: 499,
            receivedDate: "2026-11-08T14:30:00.000+0100",
          },
          {
            messageId: "m1", boundness: "INBOUND", textShort: "Ist das noch",
            unichatMessage: { payload: { content: { text: "Ist das noch verfügbar?" } } },
            receivedDate: "2026-11-08T14:21:39.123+0100", attachments: [{ url: "x" }],
          },
        ],
      }],
    ], { conversationId: "c1", limit: 30, includeBuyerConversations: false });

    assert.equal(result.mode, "conversation");
    assert.equal(result.conversation.counterpart, "Erika");
    assert.deepEqual(result.messages.map((message) => [message.direction, message.text]), [
      ["in", "Ist das noch verfügbar?"],
      ["system", ""],
      ["out", "Ja, ist noch da."],
    ]);
    assert.equal(result.messages[0].attachments, 1);
    assert.deepEqual(result.messages[1].offer, {
      kind: "BUYER_OFFER_MADE_SELLER_MESSAGE",
      offeredPrice: 18,
      itemPrice: 25,
      shippingCost: 4.99,
    });
    assert.equal(result.truncated, false);
  });

  it("reports a missing session and gateway failures without the token", async () => {
    const loggedOut = await runScript(
      [[/\/m-access-token\.json$/, 200, { expiration: 1 }]],
      { conversationId: null, limit: 20, includeBuyerConversations: false },
    );
    assert.deepEqual(loggedOut.result, { status: "not_logged_in" });

    const refused = await runScript(
      [...sessionRoutes, [/\/conversations\?/, 401, {}]],
      { conversationId: null, limit: 20, includeBuyerConversations: false },
    );
    assert.deepEqual(refused.result, {
      status: "error",
      step: "conversations",
      httpStatus: 401,
      message: "message box request failed",
    });
  });
});

describe("read options", () => {
  it("parses read-only command options", () => {
    const parsed = parseArgs([
      "node", "miniclaw", "messages", "--conversation", "5p1:2:3", "--limit=5", "--include-buyer",
    ]);
    assert.equal(parsed.command, "messages");
    assert.deepEqual(parsed.read, {
      conversationId: "5p1:2:3",
      limit: 5,
      includeBuyerConversations: true,
    });
  });
});
