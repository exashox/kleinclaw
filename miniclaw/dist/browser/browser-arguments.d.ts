export declare function isLoopbackDebuggingHost(host: string): boolean;
/**
 * Loopback or RFC 1918 address. A browser in a sibling container (for example
 * a Home Assistant add-on) is reachable only through such an address.
 */
export declare function isPrivateIPv4(address: string): boolean;
export declare function remoteDebuggingHostFromArguments(args: string[]): string;
/**
 * Chrome rejects DevTools HTTP requests whose Host header is neither an IP
 * address nor localhost, so hostnames are resolved before connecting. The
 * resolved address must stay private; public browsers are never attached.
 */
export declare function resolveRemoteDebuggingHost(host: string): Promise<string>;
/**
 * Access token for a protected DevTools endpoint (for example the KleinClaw
 * Browser add-on proxy). It is sent as `?token=` because the WebSocket client
 * cannot set headers. The value is never echoed in errors.
 */
export declare function remoteDebuggingTokenFromArguments(args: string[]): string | null;
export declare function isRemoteDebuggingTokenArgument(arg: string): boolean;
/** Builds `<origin><path>` for a DevTools endpoint and keeps its access token. */
export declare function devtoolsEndpointUrl(endpoint: string, pathAndQuery: string): string;
/** Hides access tokens in URLs before they reach logs or error messages. */
export declare function redactDevtoolsUrl(text: string): string;
export declare function remoteDebuggingPortFromArguments(args: string[]): number | null;
