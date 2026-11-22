/*
 * SPDX-FileCopyrightText: © KleinClaw contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Access to the Kleinanzeigen message box from a logged-in page.
 *
 * The web app reads conversations from gateway.kleinanzeigen.de with a bearer
 * token that www.kleinanzeigen.de/m-access-token.json hands out in its
 * `authorization` response header, scoped to the user id from
 * /messagebox-api/view. Replies are a POST to the conversation, marking as read
 * a POST to /conversations/read. The script below runs inside a
 * www.kleinanzeigen.de page, so the session cookies apply; the token never
 * leaves the page. Reading a conversation does not mark it as read.
 *
 * Accepting or declining "Direkt kaufen" price offers is deliberately not
 * supported: it commits real money and stays with the account owner.
 */

export interface MessageboxRequest {
  /** Read one conversation instead of the list. */
  conversationId?: string | null;
  /** Conversations (list) or latest messages (one conversation) to return. */
  limit?: number;
  /** Also list conversations where the account is the buyer. */
  includeBuyerConversations?: boolean;
}

export interface MessageboxSendRequest {
  action: "send";
  conversationId: string;
  text: string;
  /** Newest message the reply answers; the send is refused if anything is newer. */
  afterMessageId: string;
  /** The conversation must be about this ad. */
  expectedAdId: string;
  /** Lowest price the reply may name, in euros; amounts the buyer named are exempt. */
  minPrice: number | null;
  markRead: boolean;
}

export interface MessageboxConversationSummary {
  id: string;
  adId: string | null;
  adTitle: string;
  adStatus: string | null;
  role: "seller" | "buyer" | null;
  counterpart: string;
  unread: boolean;
  unreadCount: number;
  lastActivity: string | null;
  preview: string;
}

export interface MessageboxOffer {
  kind: string;
  offeredPrice: number | null;
  itemPrice: number | null;
  shippingCost: number | null;
}

export interface MessageboxMessage {
  id: string | null;
  direction: "in" | "out" | "system";
  at: string | null;
  text: string;
  attachments: number;
  offer: MessageboxOffer | null;
}

export type MessageboxResult =
  | { status: "not_logged_in" }
  | { status: "error"; step: string; httpStatus: number | null; message: string }
  | {
    status: "ok";
    mode: "list";
    total: number | null;
    skippedBuyerConversations: number;
    conversations: MessageboxConversationSummary[];
  }
  | {
    status: "ok";
    mode: "conversation";
    conversation: MessageboxConversationSummary;
    messages: MessageboxMessage[];
    truncated: boolean;
    newestMessageId: string | null;
    awaitingReply: boolean;
    latestOffer: (MessageboxOffer & { at: string | null }) | null;
    offerStatus: string | null;
    paid: boolean;
  };

export type MessageboxSendResult =
  | { status: "not_logged_in" }
  | { status: "error"; step: string; httpStatus: number | null; message: string }
  | {
    status: "refused";
    reason: "not_seller" | "ad_mismatch" | "conversation_moved_on" | "awaiting_buyer" | "below_min_price";
    message: string;
    newestMessageId?: string | null;
    recentMessages?: MessageboxMessage[];
  }
  | { status: "sent"; conversationId: string; adId: string | null; markedRead: boolean };

export const MESSAGEBOX_MAX_LIST = 100;
export const MESSAGEBOX_MAX_MESSAGES = 100;
export const MESSAGE_MAX_CHARS = 1000;

/**
 * Page function for reading (default) and sending (`action: "send"`); call it
 * with a {@link MessageboxRequest} or a {@link MessageboxSendRequest}.
 */
export const MESSAGEBOX_JS = String.raw`async (request) => {
  const GATEWAY = "https://gateway.kleinanzeigen.de";
  const PAGE_SIZE = 30;
  const fail = (step, httpStatus, message) => ({ status: "error", step, httpStatus, message });
  const refuse = (reason, message, extra) => Object.assign({ status: "refused", reason, message }, extra || {});
  const str = (value) => (value === undefined || value === null ? "" : String(value));
  const cents = (value) => (typeof value === "number" ? value / 100 : null);

  let tokenResponse;
  try {
    tokenResponse = await fetch("/m-access-token.json", { credentials: "include" });
  } catch (error) {
    return fail("access-token", null, str(error && error.message));
  }
  const authorization = tokenResponse.headers.get("authorization");
  if (!authorization) {
    return { status: "not_logged_in" };
  }

  let userId;
  try {
    const view = await fetch("/messagebox-api/view", {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!view.ok) {
      return fail("user-context", view.status, "message box user context not available");
    }
    const body = await view.json();
    userId = body && body.user && body.user.id;
  } catch (error) {
    return fail("user-context", null, str(error && error.message));
  }
  if (userId === undefined || userId === null || !/^\d+$/.test(String(userId))) {
    return fail("user-context", null, "message box user context contained no user id");
  }

  const gateway = async (path, step, init) => {
    const response = await fetch(GATEWAY + "/messagebox/api/users/" + userId + path, Object.assign({
      headers: { Authorization: authorization, Accept: "application/json" },
    }, init || {}));
    if (!response.ok) {
      throw { step, httpStatus: response.status };
    }
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  };
  const post = (path, step, body) => gateway(path, step, {
    method: "POST",
    headers: Object.assign(
      { Authorization: authorization, Accept: "application/json" },
      body === undefined ? {} : { "Content-Type": "application/json" },
    ),
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const summarize = (entry) => {
    const role = str(entry.role).toUpperCase();
    return {
      id: str(entry.id),
      adId: entry.adId === undefined || entry.adId === null ? null : str(entry.adId),
      adTitle: str(entry.adTitle),
      adStatus: entry.adStatus ? str(entry.adStatus) : null,
      role: role === "SELLER" ? "seller" : role === "BUYER" ? "buyer" : null,
      counterpart: role === "SELLER" ? str(entry.buyerName) : str(entry.sellerName),
      unread: Boolean(entry.unread) || Number(entry.unreadMessagesCount || 0) > 0,
      unreadCount: Number(entry.unreadMessagesCount || 0),
      lastActivity: entry.receivedDate ? str(entry.receivedDate) : null,
      preview: str(entry.textShortTrimmed || entry.textShort || "").slice(0, 160),
    };
  };

  const longestText = (message) => {
    const content = message.unichatMessage && message.unichatMessage.payload &&
      message.unichatMessage.payload.content;
    return [message.textShort, content && content.text, message.text]
      .map(str)
      .reduce((longest, value) => (value.length > longest.length ? value : longest), "")
      .trim();
  };

  const conversationMessages = (detail) => (Array.isArray(detail.messages) ? detail.messages : [])
    .map((message) => {
      const isOffer = str(message.type) === "PAYMENT_AND_SHIPPING_MESSAGE";
      const boundness = str(message.boundness).toUpperCase();
      const at = message.receivedDate ? str(message.receivedDate) : null;
      return {
        id: message.messageId ? str(message.messageId)
          : message.offerId ? "offer:" + str(message.offerId) + ":" + str(message.paymentAndShippingMessageType)
          : at ? "at:" + at : null,
        direction: isOffer ? "system" : boundness === "OUTBOUND" ? "out" : "in",
        at,
        text: longestText(message),
        attachments: Array.isArray(message.attachments) ? message.attachments.length : 0,
        offer: isOffer
          ? {
            kind: str(message.paymentAndShippingMessageType),
            offeredPrice: cents(message.offeredPriceInEuroCent),
            itemPrice: cents(message.itemPriceInEuroCent),
            shippingCost: cents(message.shippingCostInEuroCent),
          }
          : null,
      };
    })
    // The API returns blank inbound entries next to one's own messages.
    .filter((message) => message.text || message.attachments || message.offer)
    .sort((a, b) => str(a.at).localeCompare(str(b.at)));

  // Euro amounts in a text; amounts next to shipping words are left out.
  const AMOUNT = /(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?\s*(?:€|euro\b|eur\b)/gi;
  const SHIPPING = /versand|porto|dhl|hermes|dpd|gls|paket|zzgl|shipping/i;
  const amountsIn = (text, skipShipping) => {
    const amounts = [];
    for (const match of String(text).matchAll(AMOUNT)) {
      const around = String(text).slice(Math.max(0, match.index - 25), match.index + match[0].length + 25);
      if (skipShipping && SHIPPING.test(around)) {
        continue;
      }
      amounts.push(Number(match[1].replace(/\./g, "")) + (match[2] ? Number(match[2].padEnd(2, "0")) / 100 : 0));
    }
    return amounts;
  };

  try {
    if (request.action === "send") {
      const detail = await gateway(
        "/conversations/" + encodeURIComponent(request.conversationId) + "?contentWarnings=true",
        "conversation",
      );
      const conversation = summarize(detail);
      if (conversation.role !== "seller") {
        return refuse("not_seller", "replies are only sent in conversations about the account's own ads");
      }
      if (conversation.adId !== request.expectedAdId) {
        return refuse("ad_mismatch", "the conversation is about a different ad");
      }
      const all = conversationMessages(detail);
      const newest = all.length ? all[all.length - 1] : null;
      const recentMessages = all.slice(-5);
      if (!newest || newest.id !== request.afterMessageId) {
        return refuse("conversation_moved_on", "the conversation has newer messages; read it again", {
          newestMessageId: newest ? newest.id : null,
          recentMessages,
        });
      }
      if (newest.direction === "out") {
        return refuse("awaiting_buyer", "the last message is already from the seller; wait for the buyer", {
          newestMessageId: newest.id,
          recentMessages,
        });
      }
      if (typeof request.minPrice === "number") {
        const named = new Set();
        for (const message of all) {
          if (message.direction !== "out") {
            amountsIn(message.text, false).forEach((value) => named.add(value));
          }
          if (message.offer && message.offer.offeredPrice !== null) {
            named.add(message.offer.offeredPrice);
          }
        }
        const tooLow = amountsIn(request.text, true)
          .filter((value) => value < request.minPrice && !named.has(value));
        if (tooLow.length) {
          return refuse(
            "below_min_price",
            "the reply names " + tooLow.join(", ") + " EUR, below the minimum price for this ad",
          );
        }
      }
      await post(
        "/conversations/" + encodeURIComponent(request.conversationId) + "?warnPhoneNumber=true",
        "send",
        { message: request.text },
      );
      let markedRead = false;
      if (request.markRead) {
        try {
          await post("/conversations/read?ids=" + encodeURIComponent(request.conversationId), "mark-read");
          markedRead = true;
        } catch {
          // The reply is out; an unread marker is not worth failing for.
        }
      }
      return { status: "sent", conversationId: request.conversationId, adId: conversation.adId, markedRead };
    }

    if (request.conversationId) {
      const detail = await gateway(
        "/conversations/" + encodeURIComponent(request.conversationId) + "?contentWarnings=true",
        "conversation",
      );
      const all = conversationMessages(detail);
      const messages = all.slice(-request.limit);
      const newest = all.length ? all[all.length - 1] : null;
      const offers = all.filter((message) => message.offer);
      const priced = offers.filter((message) => message.offer.offeredPrice !== null);
      const latest = priced.length ? priced[priced.length - 1] : null;
      return {
        status: "ok",
        mode: "conversation",
        conversation: summarize(detail),
        messages,
        truncated: messages.length < all.length,
        newestMessageId: newest ? newest.id : null,
        awaitingReply: Boolean(newest && newest.direction !== "out"),
        latestOffer: latest ? Object.assign({ at: latest.at }, latest.offer) : null,
        offerStatus: offers.length ? offers[offers.length - 1].offer.kind : null,
        paid: Boolean(detail.paymentAnalyticsData && detail.paymentAnalyticsData.paymentId),
      };
    }

    const conversations = [];
    let skippedBuyerConversations = 0;
    let total = null;
    for (let page = 0; page < 20 && conversations.length < request.limit; page += 1) {
      const body = await gateway("/conversations?page=" + page + "&size=" + PAGE_SIZE, "conversations");
      const entries = Array.isArray(body && body.conversations) ? body.conversations : [];
      if (body && body._meta && typeof body._meta.numFound === "number") {
        total = body._meta.numFound;
      }
      for (const entry of entries) {
        const summary = summarize(entry);
        if (summary.role === "buyer" && !request.includeBuyerConversations) {
          skippedBuyerConversations += 1;
          continue;
        }
        if (conversations.length < request.limit) {
          conversations.push(summary);
        }
      }
      const pageSize = (body && body._meta && body._meta.pageSize) || PAGE_SIZE;
      if (entries.length < pageSize || (total !== null && (page + 1) * pageSize >= total)) {
        break;
      }
    }
    return { status: "ok", mode: "list", total, skippedBuyerConversations, conversations };
  } catch (error) {
    if (error && error.step) {
      return fail(error.step, error.httpStatus, "message box request failed");
    }
    return fail("gateway", null, str(error && error.message));
  }
}`;

/** @deprecated Same script as {@link MESSAGEBOX_JS}; kept for readers of 0.4.0. */
export const MESSAGEBOX_READ_JS = MESSAGEBOX_JS;

const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9:_-]{3,100}$/;
const MESSAGE_ID_PATTERN = /^[A-Za-z0-9:@._+-]{1,200}$/;

const PHONE_SEPARATORS = String.raw`[\s\-/(). ]`;
const MESSAGE_CHECKS: ReadonlyArray<readonly [RegExp, string]> = [
  [new RegExp(String.raw`(?:\+|00)\d{1,3}${PHONE_SEPARATORS}*\d(?:${PHONE_SEPARATORS}*\d){6,}`), "a phone number"],
  // Without "." as separator, so dates such as 08.11.2026 do not count.
  [/\b0\d[\s\-/() ]*\d(?:[\s\-/() ]*\d){5,}/, "a phone number"],
  [/\d{9,}/, "a long number (phone or account number)"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, "an email address"],
  [/\bhttps?:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:de|com|net|org|info|eu|io|me|ly)\b/i, "a link"],
  [/\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}\b/, "an IBAN"],
];

/**
 * Reasons a reply must not go out unattended: contact data, links, and
 * account numbers are what scams and accidental oversharing look like.
 */
export function findMessageProblems(text: string): string[] {
  const problems: string[] = [];
  const trimmed = text.trim();
  if (!trimmed) {
    problems.push("the reply is empty");
  }
  if (trimmed.length > MESSAGE_MAX_CHARS) {
    problems.push(`the reply is longer than ${MESSAGE_MAX_CHARS} characters`);
  }
  for (const [pattern, label] of MESSAGE_CHECKS) {
    if (pattern.test(trimmed) && !problems.includes(`the reply contains ${label}`)) {
      problems.push(`the reply contains ${label}`);
    }
  }
  return problems;
}

export function normalizeMessageboxRequest(request: MessageboxRequest): Required<MessageboxRequest> {
  const conversationId = request.conversationId?.trim() || null;
  if (conversationId !== null && !CONVERSATION_ID_PATTERN.test(conversationId)) {
    throw new Error("conversation id must contain only letters, digits, ':', '_' or '-'");
  }
  const max = conversationId ? MESSAGEBOX_MAX_MESSAGES : MESSAGEBOX_MAX_LIST;
  const limit = Math.min(Math.max(Math.trunc(request.limit ?? (conversationId ? 30 : 20)), 1), max);
  return {
    conversationId,
    limit,
    includeBuyerConversations: request.includeBuyerConversations === true,
  };
}

export interface MessageboxSendInput extends Omit<MessageboxSendRequest, "action"> {
  /**
   * Exact block the account owner configured (their own bank details). It is
   * exempt from the content checks; everything else in the text is checked.
   */
  allowedText?: string | null;
}

export function normalizeMessageboxSendRequest(request: MessageboxSendInput): MessageboxSendRequest {
  const conversationId = request.conversationId?.trim() ?? "";
  if (!CONVERSATION_ID_PATTERN.test(conversationId)) {
    throw new Error("conversation id must contain only letters, digits, ':', '_' or '-'");
  }
  const afterMessageId = request.afterMessageId?.trim() ?? "";
  if (!MESSAGE_ID_PATTERN.test(afterMessageId)) {
    throw new Error("the id of the newest message the reply answers is required");
  }
  const expectedAdId = request.expectedAdId?.trim() ?? "";
  if (!/^\d{6,15}$/.test(expectedAdId)) {
    throw new Error("the numeric ad id of the conversation is required");
  }
  const text = request.text?.trim() ?? "";
  const allowedText = request.allowedText?.trim() || null;
  if (allowedText !== null && !text.includes(allowedText)) {
    throw new Error("the allowed block is not part of the reply");
  }
  const checked = allowedText === null ? text : text.split(allowedText).join(" ");
  const problems = [
    ...(text.length > MESSAGE_MAX_CHARS ? [`the reply is longer than ${MESSAGE_MAX_CHARS} characters`] : []),
    ...findMessageProblems(checked),
  ].filter((problem, index, all) => all.indexOf(problem) === index);
  if (problems.length) {
    throw new Error(`reply not sent: ${problems.join("; ")}`);
  }
  if (request.minPrice !== null && (!Number.isFinite(request.minPrice) || request.minPrice < 0)) {
    throw new Error("minimum price must be a non-negative number");
  }
  return {
    action: "send",
    conversationId,
    text,
    afterMessageId,
    expectedAdId,
    minPrice: request.minPrice,
    markRead: request.markRead,
  };
}
