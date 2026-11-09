/*
 * SPDX-FileCopyrightText: © KleinClaw contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
export const MESSAGEBOX_MAX_LIST = 100;
export const MESSAGEBOX_MAX_MESSAGES = 100;
/** Page function; call with a {@link MessageboxRequest}. */
export const MESSAGEBOX_READ_JS = String.raw `async (request) => {
  const GATEWAY = "https://gateway.kleinanzeigen.de";
  const PAGE_SIZE = 30;
  const fail = (step, httpStatus, message) => ({ status: "error", step, httpStatus, message });
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

  const gateway = async (path, step) => {
    const response = await fetch(GATEWAY + "/messagebox/api/users/" + userId + path, {
      headers: { Authorization: authorization, Accept: "application/json" },
    });
    if (!response.ok) {
      throw { step, httpStatus: response.status };
    }
    return await response.json();
  };

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

  try {
    if (request.conversationId) {
      const detail = await gateway(
        "/conversations/" + encodeURIComponent(request.conversationId) + "?contentWarnings=true",
        "conversation",
      );
      const all = (Array.isArray(detail.messages) ? detail.messages : [])
        .map((message) => {
          const isOffer = str(message.type) === "PAYMENT_AND_SHIPPING_MESSAGE";
          const boundness = str(message.boundness).toUpperCase();
          return {
            id: message.messageId ? str(message.messageId) : null,
            direction: isOffer ? "system" : boundness === "OUTBOUND" ? "out" : "in",
            at: message.receivedDate ? str(message.receivedDate) : null,
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
      const messages = all.slice(-request.limit);
      return {
        status: "ok",
        mode: "conversation",
        conversation: summarize(detail),
        messages,
        truncated: messages.length < all.length,
      };
    }

    const conversations = [];
    let skippedBuyerConversations = 0;
    let total = null;
    for (let page = 0; page < 20 && conversations.length < request.limit; page += 1) {
      const body = await gateway("/conversations?page=" + page + "&size=" + PAGE_SIZE, "conversations");
      const entries = Array.isArray(body.conversations) ? body.conversations : [];
      if (body._meta && typeof body._meta.numFound === "number") {
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
      const pageSize = (body._meta && body._meta.pageSize) || PAGE_SIZE;
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
export function normalizeMessageboxRequest(request) {
    const conversationId = request.conversationId?.trim() || null;
    if (conversationId !== null && !/^[A-Za-z0-9:_-]{3,100}$/.test(conversationId)) {
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
