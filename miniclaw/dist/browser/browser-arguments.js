/*
 * SPDX-FileCopyrightText: © Jens Bergmann and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * SPDX-ArtifactOfProjectHomePage: https://github.com/Second-Hand-Friends/kleinanzeigen-bot/
 */
import { lookup } from "node:dns/promises";
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1", "[::1]"];
const IPV4_PATTERN = /^\d{1,3}(\.\d{1,3}){3}$/;
const HOSTNAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;
export function isLoopbackDebuggingHost(host) {
    return LOOPBACK_HOSTS.includes(host);
}
/**
 * Loopback or RFC 1918 address. A browser in a sibling container (for example
 * a Home Assistant add-on) is reachable only through such an address.
 */
export function isPrivateIPv4(address) {
    if (!IPV4_PATTERN.test(address)) {
        return false;
    }
    const [a, b] = address.split(".").map(Number);
    return a === 10 ||
        a === 127 ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168);
}
export function remoteDebuggingHostFromArguments(args) {
    for (const arg of args) {
        if (arg.startsWith("--remote-debugging-host=")) {
            const host = arg.split("=", 2)[1]?.trim() ?? "127.0.0.1";
            const allowed = isLoopbackDebuggingHost(host) ||
                (IPV4_PATTERN.test(host)
                    ? isPrivateIPv4(host)
                    : HOSTNAME_PATTERN.test(host));
            if (!allowed) {
                throw new Error(`Invalid --remote-debugging-host value: ${host}. ` +
                    "Use localhost, a private IPv4 address, or a local hostname.");
            }
            return host;
        }
    }
    return "127.0.0.1";
}
/**
 * Chrome rejects DevTools HTTP requests whose Host header is neither an IP
 * address nor localhost, so hostnames are resolved before connecting. The
 * resolved address must stay private; public browsers are never attached.
 */
export async function resolveRemoteDebuggingHost(host) {
    if (isLoopbackDebuggingHost(host) || isPrivateIPv4(host)) {
        return host;
    }
    const { address } = await lookup(host, { family: 4 });
    if (!isPrivateIPv4(address)) {
        throw new Error(`--remote-debugging-host ${host} resolved to non-private address ${address}.`);
    }
    return address;
}
const DEBUGGING_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const DEBUGGING_TOKEN_FLAG = "--remote-debugging-token=";
/**
 * Access token for a protected DevTools endpoint (for example the KleinClaw
 * Browser add-on proxy). It is sent as `?token=` because the WebSocket client
 * cannot set headers. The value is never echoed in errors.
 */
export function remoteDebuggingTokenFromArguments(args) {
    for (const arg of args) {
        if (!arg.startsWith(DEBUGGING_TOKEN_FLAG)) {
            continue;
        }
        const token = arg.slice(DEBUGGING_TOKEN_FLAG.length).trim().replace(/^["']|["']$/g, "");
        if (!DEBUGGING_TOKEN_PATTERN.test(token)) {
            throw new Error("Invalid --remote-debugging-token value: use 16 to 128 letters, digits, '-' or '_'.");
        }
        return token;
    }
    return null;
}
export function isRemoteDebuggingTokenArgument(arg) {
    return arg.startsWith(DEBUGGING_TOKEN_FLAG);
}
/** Builds `<origin><path>` for a DevTools endpoint and keeps its access token. */
export function devtoolsEndpointUrl(endpoint, pathAndQuery) {
    const base = new URL(endpoint);
    const token = base.searchParams.get("token");
    const url = `${base.protocol}//${base.host}${pathAndQuery}`;
    if (!token) {
        return url;
    }
    const separator = pathAndQuery.includes("?") ? "&" : "?";
    return `${url}${separator}token=${encodeURIComponent(token)}`;
}
/** Hides access tokens in URLs before they reach logs or error messages. */
export function redactDevtoolsUrl(text) {
    return text.replace(/([?&]token=)[^&#\s"']+/g, "$1[redacted]");
}
export function remoteDebuggingPortFromArguments(args) {
    for (const arg of args) {
        if (!arg.startsWith("--remote-debugging-port=")) {
            continue;
        }
        const raw = arg.split("=", 2)[1] ?? "";
        const valueText = raw.trim();
        if (!/^[+-]?\d+$/.test(valueText)) {
            throw new Error(`Invalid --remote-debugging-port value: ${raw}`);
        }
        const value = Number(valueText);
        if (value > 0) {
            return value;
        }
    }
    return null;
}
