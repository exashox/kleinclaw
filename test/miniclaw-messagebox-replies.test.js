import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RESULT_MARKER, runSendMessage } from "../miniclaw/dist/cli/browser-reads.js";
import { parseArgs } from "../miniclaw/dist/cli/parser.js";
import {
  findMessageProblems,
  MESSAGEBOX_JS,
  normalizeMessageboxSendRequest,
} from "../miniclaw/dist/messagebox.js";

const TOKEN = "Bearer secret-gateway-token";
const CONVERSATION = {
  id: "c1",
  adId: "3210987654",
  adTitle: "Schreibtischlampe",
  role: "SELLER",
  buyerName: "Erika",
  messages: [
    {
      messageId: "m2",
      boundness: "INBOUND",
      textShort: "Würden Sie 40 € nehmen?",
      receivedDate: "2026-11-08T14:30:00.000+0100",
    },
    {
      messageId: "m1",
      boundness: "INBOUND",
      textShort: "Ist die Lampe noch da?",
      receivedDate: "2026-11-08T14:21:00.000+0100",
    },
  ],
};

async function runPageScript(request, { conversation = CONVERSATION, sendStatus = 204 } = {}) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    calls.push({ url: target, method: init.method ?? "GET", body: init.body ?? null, headers: init.headers });
    if (target.endsWith("/m-access-token.json")) {
      return new Response("{}", { status: 200, headers: { authorization: TOKEN } });
    }
    if (target.endsWith("/messagebox-api/view")) {
      return new Response(JSON.stringify({ user: { id: 4711 } }), { status: 200 });
    }
    if (init.method === "POST") {
      return new Response(null, { status: sendStatus });
    }
    return new Response(JSON.stringify(conversation), { status: 200 });
  };
  try {
    // eslint-disable-next-line no-eval
    const pageFunction = (0, eval)(`(${MESSAGEBOX_JS})`);
    return { result: await pageFunction(request), calls };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function sendRequest(overrides = {}) {
  return {
    action: "send",
    conversationId: "c1",
    text: "Hallo Erika, ja, sie ist noch da. Für 55 € gehört sie Ihnen.",
    afterMessageId: "m2",
    expectedAdId: "3210987654",
    minPrice: 50,
    markRead: true,
    ...overrides,
  };
}

const posts = (calls) => calls.filter((call) => call.method === "POST");

describe("message box replies in the page", () => {
  it("re-reads the conversation, sends the reply, and marks it read", async () => {
    const { result, calls } = await runPageScript(sendRequest());

    assert.deepEqual(result, { status: "sent", conversationId: "c1", adId: "3210987654", markedRead: true });
    const [reply, markRead] = posts(calls);
    assert.equal(
      reply.url,
      "https://gateway.kleinanzeigen.de/messagebox/api/users/4711/conversations/c1?warnPhoneNumber=true",
    );
    assert.deepEqual(JSON.parse(reply.body), {
      message: "Hallo Erika, ja, sie ist noch da. Für 55 € gehört sie Ihnen.",
    });
    assert.equal(reply.headers.Authorization, TOKEN);
    assert.equal(
      markRead.url,
      "https://gateway.kleinanzeigen.de/messagebox/api/users/4711/conversations/read?ids=c1",
    );
    assert.doesNotMatch(JSON.stringify(result), /secret-gateway-token/);
  });

  it("refuses when the buyer wrote something newer or it is the buyer's turn", async () => {
    const movedOn = await runPageScript(sendRequest({ afterMessageId: "m1" }));
    assert.equal(movedOn.result.reason, "conversation_moved_on");
    assert.equal(movedOn.result.newestMessageId, "m2");
    assert.equal(posts(movedOn.calls).length, 0);

    const answered = {
      ...CONVERSATION,
      messages: [
        {
          messageId: "m3",
          boundness: "OUTBOUND",
          textShort: "Ja.",
          receivedDate: "2026-11-08T15:00:00.000+0100",
        },
        ...CONVERSATION.messages,
      ],
    };
    const buyersTurn = await runPageScript(sendRequest({ afterMessageId: "m3" }), { conversation: answered });
    assert.equal(buyersTurn.result.reason, "awaiting_buyer");
    assert.equal(posts(buyersTurn.calls).length, 0);
  });

  it("refuses conversations where the account buys or that belong to another ad", async () => {
    const buyer = await runPageScript(sendRequest(), { conversation: { ...CONVERSATION, role: "BUYER" } });
    assert.equal(buyer.result.reason, "not_seller");
    const otherAd = await runPageScript(sendRequest({ expectedAdId: "1111111111" }));
    assert.equal(otherAd.result.reason, "ad_mismatch");
  });

  it("refuses prices below the minimum unless the buyer named them or they are shipping", async () => {
    const tooLow = await runPageScript(sendRequest({ text: "Für 45 € können Sie sie haben." }));
    assert.equal(tooLow.result.reason, "below_min_price");
    assert.match(tooLow.result.message, /45/);
    assert.equal(posts(tooLow.calls).length, 0);

    const quoting = await runPageScript(sendRequest({
      text: "40 € ist mir zu wenig, 55 € wäre okay. Versand kostet 4,99 € extra.",
    }));
    assert.equal(quoting.result.status, "sent");

    const noFloor = await runPageScript(sendRequest({ text: "Für 20 € gehört sie Ihnen.", minPrice: null }));
    assert.equal(noFloor.result.status, "sent");
  });

  it("reports a failed send without the token", async () => {
    const { result } = await runPageScript(sendRequest(), { sendStatus: 400 });
    assert.deepEqual(result, {
      status: "error",
      step: "send",
      httpStatus: 400,
      message: "message box request failed",
    });
  });

  it("returns the reply context when reading a conversation", async () => {
    const { result } = await runPageScript(
      { conversationId: "c1", limit: 30, includeBuyerConversations: false },
      {
        conversation: {
          ...CONVERSATION,
          paymentAnalyticsData: { paymentId: "p1" },
          messages: [
            ...CONVERSATION.messages,
            {
              type: "PAYMENT_AND_SHIPPING_MESSAGE",
              paymentAndShippingMessageType: "BUYER_OFFER_MADE_SELLER_MESSAGE",
              offerId: "o1",
              offeredPriceInEuroCent: 4200,
              receivedDate: "2026-11-08T14:25:00.000+0100",
            },
          ],
        },
      },
    );

    assert.equal(result.newestMessageId, "m2");
    assert.equal(result.awaitingReply, true);
    assert.deepEqual(result.latestOffer, {
      at: "2026-11-08T14:25:00.000+0100",
      kind: "BUYER_OFFER_MADE_SELLER_MESSAGE",
      offeredPrice: 42,
      itemPrice: null,
      shippingCost: null,
    });
    assert.equal(result.offerStatus, "BUYER_OFFER_MADE_SELLER_MESSAGE");
    assert.equal(result.paid, true);
    assert.equal(result.messages[1].id, "offer:o1:BUYER_OFFER_MADE_SELLER_MESSAGE");
  });
});

describe("reply content checks", () => {
  it("flags contact data, links, and account numbers but not prices or dates", () => {
    assert.deepEqual(
      findMessageProblems("Abholung am 08.11.2026 um 18:30, 1.250 € VB, Maße 40 x 25 cm."),
      [],
    );
    for (const [text, label] of [
      ["Ruf mich an: 0151 23456789", /phone number/],
      ["Meine Nummer +49 151 2345678", /phone number/],
      ["Schreib an max@example.de", /email address/],
      ["Siehe https://example.com/zahlung", /link/],
      ["Bezahlen über kleinanzeigen-sicher.de", /link/],
      ["IBAN DE89 3704 0044 0532 0130 00", /IBAN|long number/],
    ]) {
      assert.match(findMessageProblems(text).join("; "), label, text);
    }
    assert.match(findMessageProblems("  ").join(), /empty/);
    assert.match(findMessageProblems("x".repeat(1001)).join(), /longer than 1000/);
  });

  it("validates send requests before a browser opens", () => {
    const valid = {
      conversationId: "c1:2:3",
      text: " Hallo! ",
      afterMessageId: "m2",
      expectedAdId: "3210987654",
      minPrice: 50,
      markRead: true,
    };
    assert.equal(normalizeMessageboxSendRequest(valid).text, "Hallo!");
    assert.throws(() => normalizeMessageboxSendRequest({ ...valid, afterMessageId: "" }), /newest message/);
    assert.throws(() => normalizeMessageboxSendRequest({ ...valid, expectedAdId: "abc" }), /ad id/);
    assert.throws(
      () => normalizeMessageboxSendRequest({ ...valid, text: "0151 23456789" }),
      /reply not sent: .*phone/,
    );
  });
});

describe("miniclaw send-message command", () => {
  async function captureConsole(run) {
    const stdout = [];
    const stderr = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...args) => stdout.push(args.join(" "));
    console.error = (...args) => stderr.push(args.join(" "));
    try {
      return { code: await run(), stdout, stderr };
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
  }

  it("passes a complete request to the page and refuses an incomplete one", async () => {
    let evaluated = null;
    const openSession = async () => ({
      page: {
        url: "about:blank",
        async goto(url) {
          this.url = url;
        },
        async evaluate(_script, request) {
          evaluated = request;
          return {
            status: "sent",
            conversationId: request.conversationId,
            adId: request.expectedAdId,
            markedRead: true,
          };
        },
      },
      async close() {},
    });
    const argv = [
      "node", "miniclaw", "send-message", "--allow-live-browser", "--conversation=c1:2:3",
      "--text=Hallo Erika, ja.", "--after=m2", "--ad-id=3210987654", "--min-price=50", "--mark-read",
    ];

    const { code, stdout } = await captureConsole(() => runSendMessage(parseArgs(argv), null, openSession));

    assert.equal(code, 0);
    const line = stdout.find((entry) => entry.startsWith(RESULT_MARKER));
    assert.equal(JSON.parse(line.slice(RESULT_MARKER.length)).status, "sent");
    assert.deepEqual(evaluated, {
      action: "send",
      conversationId: "c1:2:3",
      text: "Hallo Erika, ja.",
      afterMessageId: "m2",
      expectedAdId: "3210987654",
      minPrice: 50,
      markRead: true,
    });

    const missing = await captureConsole(() =>
      runSendMessage(
        parseArgs(argv.filter((arg) => !arg.startsWith("--after"))),
        null,
        async () => assert.fail("must not open a browser"),
      ));
    assert.equal(missing.code, 2);
  });
});
