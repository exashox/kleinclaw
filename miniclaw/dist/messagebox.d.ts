/**
 * Read-only access to the Kleinanzeigen message box from a logged-in page.
 *
 * The web app reads conversations from gateway.kleinanzeigen.de with a bearer
 * token that www.kleinanzeigen.de/m-access-token.json hands out in its
 * `authorization` response header, scoped to the user id from
 * /messagebox-api/view. The script below runs inside a www.kleinanzeigen.de
 * page, so the session cookies apply; the token never leaves the page.
 * Reading a conversation does not mark it as read.
 */
export interface MessageboxRequest {
    /** Read one conversation instead of the list. */
    conversationId?: string | null;
    /** Conversations (list) or latest messages (one conversation) to return. */
    limit?: number;
    /** Also list conversations where the account is the buyer. */
    includeBuyerConversations?: boolean;
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
export interface MessageboxMessage {
    id: string | null;
    direction: "in" | "out" | "system";
    at: string | null;
    text: string;
    attachments: number;
    offer: {
        kind: string;
        offeredPrice: number | null;
        itemPrice: number | null;
        shippingCost: number | null;
    } | null;
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
};
export declare const MESSAGEBOX_MAX_LIST = 100;
export declare const MESSAGEBOX_MAX_MESSAGES = 100;
/** Page function; call with a {@link MessageboxRequest}. */
export declare const MESSAGEBOX_READ_JS: string;
export declare function normalizeMessageboxRequest(request: MessageboxRequest): Required<MessageboxRequest>;
