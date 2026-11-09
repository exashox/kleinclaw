"""DevTools proxy that makes Chromium reachable by hostname, behind a token.

Chromium only accepts DevTools requests whose Host header is an IP address or
localhost, and it answers with WebSocket URLs pointing at its own loopback
listener. This proxy sits on the add-on's network port, rewrites the Host
header for Chromium, and rewrites the URLs in JSON answers back to the host
the client used. Clients can then use a stable name such as
http://<add-on hostname>:9223 instead of the add-on's changing IP address.

Every request must carry the access token from the CDP_TOKEN environment
variable, as `?token=<token>`, `Authorization: Bearer <token>`, or as the
password of HTTP Basic auth. Without a configured token all requests are
refused: an open DevTools port would let any container on the internal
network control the logged-in browser. The token is removed before the
request reaches Chromium. Clients that sent it as a query parameter get it
appended to the WebSocket URLs in JSON answers, because WebSocket clients
often cannot set headers.
"""

import asyncio
import base64
import hmac
import json
import os
import re
import sys
from urllib.parse import quote, unquote

LISTEN_PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 9223
UPSTREAM_HOST = "127.0.0.1"
UPSTREAM_PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 9222
UPSTREAM = f"{UPSTREAM_HOST}:{UPSTREAM_PORT}"
HEADER_LIMIT = 64 * 1024
TOKEN = os.environ.get("CDP_TOKEN", "").strip()


def log(message):
    print(f"cdp_proxy: {message}", file=sys.stderr, flush=True)


async def read_head(reader):
    """Reads an HTTP head up to the blank line; returns (head, rest)."""
    data = b""
    while b"\r\n\r\n" not in data:
        chunk = await reader.read(4096)
        if not chunk:
            return None, b""
        data += chunk
        if len(data) > HEADER_LIMIT:
            return None, b""
    head, _, rest = data.partition(b"\r\n\r\n")
    return head.decode("latin-1"), rest


def header_value(lines, name):
    prefix = name.lower() + ":"
    for line in lines[1:]:
        if line.lower().startswith(prefix):
            return line.split(":", 1)[1].strip()
    return None


def set_header(lines, name, value):
    prefix = name.lower() + ":"
    kept = [line for line in lines if not line.lower().startswith(prefix)]
    return kept + [f"{name}: {value}"]


def remove_header(lines, name):
    prefix = name.lower() + ":"
    return [line for line in lines if not line.lower().startswith(prefix)]


def split_token_from_target(target):
    """Returns (target without token parameters, list of tokens found).

    Only `token=` parameters are removed; other query parts such as the page
    URL in `/json/new?about:blank` stay exactly as they were.
    """
    path, separator, query = target.partition("?")
    if not separator:
        return target, []
    kept, tokens = [], []
    for part in query.split("&"):
        name, _, value = part.partition("=")
        if name == "token":
            tokens.append(unquote(value))
        else:
            kept.append(part)
    return (f"{path}?{'&'.join(kept)}" if kept else path), tokens


def header_tokens(lines):
    value = header_value(lines, "Authorization") or ""
    scheme, _, credentials = value.partition(" ")
    credentials = credentials.strip()
    if scheme.lower() == "bearer" and credentials:
        return [credentials]
    if scheme.lower() == "basic" and credentials:
        try:
            decoded = base64.b64decode(credentials, validate=True).decode("utf-8")
        except (ValueError, UnicodeDecodeError):
            return []
        return [decoded.partition(":")[2]]
    return []


def token_matches(candidates):
    expected = TOKEN.encode("utf-8")
    return any(
        hmac.compare_digest(candidate.encode("utf-8"), expected)
        for candidate in candidates
    )


async def refuse(writer, status, reason, message):
    body = json.dumps({"error": message}).encode("utf-8")
    head = [
        f"HTTP/1.1 {status} {reason}",
        "Content-Type: application/json; charset=UTF-8",
        f"Content-Length: {len(body)}",
        "Connection: close",
    ]
    if status == 401:
        head.append('WWW-Authenticate: Bearer realm="KleinClaw Browser"')
    writer.write("\r\n".join(head).encode("latin-1") + b"\r\n\r\n" + body)
    await writer.drain()


def rewrite_json(text, client_host, query_token):
    text = re.sub(
        rf"(?<![\w.-]){re.escape(UPSTREAM)}|localhost:{UPSTREAM_PORT}",
        client_host,
        text,
    )
    if query_token:
        suffix = "?token=" + quote(query_token, safe="")
        text = re.sub(
            rf'(wss?://{re.escape(client_host)}/devtools/[^"?\s]*)',
            lambda match: match.group(1) + suffix,
            text,
        )
    return text


async def pipe(reader, writer):
    try:
        while chunk := await reader.read(65536):
            writer.write(chunk)
            await writer.drain()
    except (ConnectionError, asyncio.CancelledError):
        pass
    finally:
        writer.close()


async def handle(client_reader, client_writer):
    upstream_writer = None
    peer = client_writer.get_extra_info("peername")
    peer_host = peer[0] if peer else "unknown"
    try:
        head, rest = await read_head(client_reader)
        if head is None:
            return
        lines = head.split("\r\n")
        method, _, remainder = lines[0].partition(" ")
        target, _, version = remainder.partition(" ")
        target, query_tokens = split_token_from_target(target)

        if not TOKEN:
            await refuse(
                client_writer, 403, "Forbidden",
                "DevTools access is disabled: set cdp_token in the add-on options.",
            )
            return
        if not token_matches(query_tokens + header_tokens(lines)):
            log(f"refused request from {peer_host}: missing or wrong token")
            await refuse(
                client_writer, 401, "Unauthorized",
                "Missing or wrong DevTools access token.",
            )
            return

        lines[0] = f"{method} {target} {version}"
        lines = remove_header(lines, "Authorization")
        client_host = header_value(lines, "Host") or f"localhost:{LISTEN_PORT}"
        upgrade = (header_value(lines, "Upgrade") or "").lower() == "websocket"

        lines = set_header(lines, "Host", UPSTREAM)
        if not upgrade:
            # One request per connection keeps response rewriting simple.
            lines = set_header(lines, "Connection", "close")

        upstream_reader, upstream_writer = await asyncio.open_connection(
            UPSTREAM_HOST, UPSTREAM_PORT,
        )
        upstream_writer.write("\r\n".join(lines).encode("latin-1") + b"\r\n\r\n" + rest)
        await upstream_writer.drain()

        if upgrade:
            await asyncio.gather(
                pipe(client_reader, upstream_writer),
                pipe(upstream_reader, client_writer),
            )
            return

        response_head, body = await read_head(upstream_reader)
        if response_head is None:
            return
        response_lines = response_head.split("\r\n")
        # Chromium keeps the connection open, so read exactly the announced body.
        length = header_value(response_lines, "Content-Length")
        if length is not None and length.isdigit():
            missing = int(length) - len(body)
            if missing > 0:
                body += await upstream_reader.readexactly(missing)
        else:
            body += await asyncio.wait_for(upstream_reader.read(), timeout=5)
        content_type = header_value(response_lines, "Content-Type") or ""
        if "json" in content_type:
            query_token = next((t for t in query_tokens if token_matches([t])), None)
            body = rewrite_json(body.decode("utf-8"), client_host, query_token).encode("utf-8")
        response_lines = set_header(response_lines, "Content-Length", str(len(body)))
        response_lines = set_header(response_lines, "Connection", "close")
        client_writer.write(
            "\r\n".join(response_lines).encode("latin-1") + b"\r\n\r\n" + body,
        )
        await client_writer.drain()
    except (
        ConnectionError, OSError, UnicodeDecodeError,
        asyncio.IncompleteReadError, asyncio.TimeoutError,
    ) as error:
        log(str(error))
    finally:
        client_writer.close()
        if upstream_writer is not None:
            upstream_writer.close()


async def main():
    if not TOKEN:
        log("no access token configured; all DevTools requests are refused")
    server = await asyncio.start_server(handle, "0.0.0.0", LISTEN_PORT)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
