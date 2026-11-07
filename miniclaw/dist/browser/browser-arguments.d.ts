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
export declare function remoteDebuggingPortFromArguments(args: string[]): number | null;
