/*
 * SPDX-FileCopyrightText: © Jens Bergmann and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * SPDX-ArtifactOfProjectHomePage: https://github.com/Second-Hand-Friends/kleinanzeigen-bot/
 */

import { lookup } from "node:dns/promises";

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1", "[::1]"];
const IPV4_PATTERN = /^\d{1,3}(\.\d{1,3}){3}$/;
const HOSTNAME_PATTERN =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

export function isLoopbackDebuggingHost(host: string): boolean {
  return LOOPBACK_HOSTS.includes(host);
}

/**
 * Loopback or RFC 1918 address. A browser in a sibling container (for example
 * a Home Assistant add-on) is reachable only through such an address.
 */
export function isPrivateIPv4(address: string): boolean {
  if (!IPV4_PATTERN.test(address)) {
    return false;
  }
  const [a, b] = address.split(".").map(Number) as [number, number];
  return a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168);
}

export function remoteDebuggingHostFromArguments(args: string[]): string {
  for (const arg of args) {
    if (arg.startsWith("--remote-debugging-host=")) {
      const host = arg.split("=", 2)[1]?.trim() ?? "127.0.0.1";
      const allowed = isLoopbackDebuggingHost(host) ||
        (IPV4_PATTERN.test(host)
          ? isPrivateIPv4(host)
          : HOSTNAME_PATTERN.test(host));
      if (!allowed) {
        throw new Error(
          `Invalid --remote-debugging-host value: ${host}. ` +
            "Use localhost, a private IPv4 address, or a local hostname.",
        );
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
export async function resolveRemoteDebuggingHost(host: string): Promise<string> {
  if (isLoopbackDebuggingHost(host) || isPrivateIPv4(host)) {
    return host;
  }
  const { address } = await lookup(host, { family: 4 });
  if (!isPrivateIPv4(address)) {
    throw new Error(
      `--remote-debugging-host ${host} resolved to non-private address ${address}.`,
    );
  }
  return address;
}

export function remoteDebuggingPortFromArguments(args: string[]): number | null {
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
