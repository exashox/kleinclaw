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
export type MessageboxResult = {
    status: "not_logged_in";
} | {
    status: "error";
    step: string;
    httpStatus: number | null;
    message: string;
} | {
    status: "ok";
    mode: "list";
    total: number | null;
    skippedBuyerConversations: number;
    conversations: MessageboxConversationSummary[];
} | {
    status: "ok";
    mode: "conversation";
    conversation: MessageboxConversationSummary;
    messages: MessageboxMessage[];
    truncated: boolean;
    newestMessageId: string | null;
    awaitingReply: boolean;
    latestOffer: (MessageboxOffer & {
        at: string | null;
    }) | null;
    offerStatus: string | null;
    paid: boolean;
};
export type MessageboxSendResult = {
    status: "not_logged_in";
} | {
    status: "error";
    step: string;
    httpStatus: number | null;
    message: string;
} | {
    status: "refused";
    reason: "not_seller" | "ad_mismatch" | "conversation_moved_on" | "awaiting_buyer" | "below_min_price";
    message: string;
    newestMessageId?: string | null;
    recentMessages?: MessageboxMessage[];
} | {
    status: "sent";
    conversationId: string;
    adId: string | null;
    markedRead: boolean;
};
export declare const MESSAGEBOX_MAX_LIST = 100;
export declare const MESSAGEBOX_MAX_MESSAGES = 100;
export declare const MESSAGE_MAX_CHARS = 1000;
/**
 * Page function for reading (default) and sending (`action: "send"`); call it
 * with a {@link MessageboxRequest} or a {@link MessageboxSendRequest}.
 */
export declare const MESSAGEBOX_JS: string;
/** @deprecated Same script as {@link MESSAGEBOX_JS}; kept for readers of 0.4.0. */
export declare const MESSAGEBOX_READ_JS: string;
/**
 * Reasons a reply must not go out unattended: contact data, links, and
 * account numbers are what scams and accidental oversharing look like.
 */
export declare function findMessageProblems(text: string): string[];
export declare function normalizeMessageboxRequest(request: MessageboxRequest): Required<MessageboxRequest>;
export declare function normalizeMessageboxSendRequest(request: Omit<MessageboxSendRequest, "action">): MessageboxSendRequest;
