"""DevTools proxy that makes Chromium reachable by hostname.

Chromium only accepts DevTools requests whose Host header is an IP address or
localhost, and it answers with WebSocket URLs pointing at its own loopback
listener. This proxy sits on the add-on's network port, rewrites the Host
header for Chromium, and rewrites the URLs in JSON answers back to the host
the client used. Clients can then use a stable name such as
http://<add-on hostname>:9223 instead of the add-on's changing IP address.
"""

import asyncio
import re
import sys

LISTEN_PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 9223
UPSTREAM_HOST = "127.0.0.1"
UPSTREAM_PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 9222
UPSTREAM = f"{UPSTREAM_HOST}:{UPSTREAM_PORT}"
HEADER_LIMIT = 64 * 1024


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
    try:
        head, rest = await read_head(client_reader)
        if head is None:
            return
        lines = head.split("\r\n")
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
            text = body.decode("utf-8")
            text = re.sub(
                rf"(?<![\w.-]){re.escape(UPSTREAM)}|localhost:{UPSTREAM_PORT}",
                client_host,
                text,
            )
            body = text.encode("utf-8")
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
        print(f"cdp_proxy: {error}", file=sys.stderr, flush=True)
    finally:
        client_writer.close()
        if upstream_writer is not None:
            upstream_writer.close()


async def main():
    server = await asyncio.start_server(handle, "0.0.0.0", LISTEN_PORT)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
