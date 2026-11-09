"""Lets only Home Assistant ingress reach the noVNC web interface.

websockify serves noVNC without authentication. Home Assistant authenticates
users at its ingress gateway, which connects from 172.30.32.2; other add-ons
on the internal network could otherwise open the interface directly and
control the logged-in browser. This guard listens on the ingress port and
forwards connections from allowed addresses to websockify on loopback.

Usage: ingress_guard.py <listen port> <upstream port> [allowed address ...]
"""

import asyncio
import sys

LISTEN_PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 6080
UPSTREAM_PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 6081
ALLOWED = set(sys.argv[3:]) or {"172.30.32.2", "127.0.0.1"}


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
    peer = client_writer.get_extra_info("peername")
    peer_host = peer[0] if peer else ""
    if peer_host.startswith("::ffff:"):
        peer_host = peer_host[len("::ffff:"):]
    if peer_host not in ALLOWED:
        print(
            f"ingress_guard: refused connection from {peer_host or 'unknown'}",
            file=sys.stderr, flush=True,
        )
        client_writer.close()
        return
    try:
        upstream_reader, upstream_writer = await asyncio.open_connection(
            "127.0.0.1", UPSTREAM_PORT,
        )
    except OSError:
        client_writer.close()
        return
    await asyncio.gather(
        pipe(client_reader, upstream_writer),
        pipe(upstream_reader, client_writer),
    )


async def main():
    server = await asyncio.start_server(handle, "0.0.0.0", LISTEN_PORT)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
