import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const addonDir = path.join(root, "homeassistant", "kleinclaw_browser");
const TOKEN = "test-token_0123456789abcdef";

function findPython() {
  for (const command of ["python3", "python"]) {
    const probe = spawnSync(command, ["--version"], { encoding: "utf8" });
    if (probe.status === 0 && /Python 3\./.test(`${probe.stdout}${probe.stderr}`)) {
      return command;
    }
  }
  return null;
}

const python = findPython();

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForPort(port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await new Promise((resolve) => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (open) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`port ${port} did not open`);
}

/** Minimal stand-in for Chromium's DevTools HTTP endpoint and WebSocket upgrade. */
async function startFakeChromium() {
  const requests = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("latin1");
      if (!buffer.includes("\r\n\r\n")) {
        return;
      }
      const [head, ...rest] = buffer.split("\r\n\r\n");
      const lines = head.split("\r\n");
      const headers = Object.fromEntries(lines.slice(1).map((line) => {
        const index = line.indexOf(":");
        return [line.slice(0, index).toLowerCase(), line.slice(index + 1).trim()];
      }));
      const target = lines[0].split(" ")[1];
      requests.push({ target, headers });
      buffer = "";
      if ((headers.upgrade ?? "").toLowerCase() === "websocket") {
        socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
        socket.on("data", (data) => socket.write(Buffer.concat([Buffer.from("echo:"), data])));
        if (rest.join("")) {
          socket.write(`echo:${rest.join("")}`);
        }
        return;
      }
      const port = server.address().port;
      const body = JSON.stringify({
        Browser: "Chrome/140.0.0.0",
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/abc`,
        devtoolsFrontendUrl: `/devtools/inspector.html?ws=127.0.0.1:${port}/devtools/page/1`,
      });
      // Chromium keeps the connection open after the response.
      socket.write(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=UTF-8\r\n" +
          `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    requests,
    close: () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      server.close();
    },
  };
}

async function startPython(script, args, env = {}) {
  const child = spawn(python, ["-I", path.join(addonDir, script), ...args.map(String)], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  await waitForPort(args[0]);
  return { child, stderr: () => stderr };
}

async function rawRequest(port, lines, { body = "", waitMs = 3000 } = {}) {
  return await new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let data = "";
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(data);
    }, waitMs);
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
    });
    socket.on("end", () => {
      clearTimeout(timer);
      resolve(data);
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      // A closed connection with unread data shows up as a reset on Windows.
      if (error.code === "ECONNRESET") {
        resolve(data);
      } else {
        reject(error);
      }
    });
    socket.write(`${lines.join("\r\n")}\r\n\r\n${body}`);
  });
}

function jsonBody(response) {
  return JSON.parse(response.slice(response.indexOf("\r\n\r\n") + 4));
}

describe("KleinClaw Browser add-on DevTools proxy", { skip: python ? false : "python 3 not found" }, () => {
  let chromium;
  let proxyPort;
  let proxy;

  before(async () => {
    chromium = await startFakeChromium();
    proxyPort = await freePort();
    proxy = await startPython("cdp_proxy.py", [proxyPort, chromium.port], { CDP_TOKEN: TOKEN });
  });

  after(() => {
    proxy?.child.kill();
    chromium?.close();
  });

  test("refuses requests without or with a wrong token", async () => {
    const before = chromium.requests.length;
    const missing = await rawRequest(proxyPort, [
      "GET /json/version HTTP/1.1",
      "Host: kleinclaw-browser:9223",
    ]);
    const wrong = await rawRequest(proxyPort, [
      "GET /json/version?token=not-the-right-token-123 HTTP/1.1",
      "Host: kleinclaw-browser:9223",
    ]);

    assert.match(missing, /^HTTP\/1\.1 401 /);
    assert.match(missing, /WWW-Authenticate: Bearer/);
    assert.match(wrong, /^HTTP\/1\.1 401 /);
    assert.equal(chromium.requests.length, before, "nothing reached Chromium");
    assert.match(proxy.stderr(), /refused request from 127\.0\.0\.1/);
    assert.doesNotMatch(proxy.stderr(), /not-the-right-token/);
  });

  test("forwards a query-token request without the token and rewrites URLs", async () => {
    const response = await rawRequest(proxyPort, [
      `GET /json/version?token=${TOKEN} HTTP/1.1`,
      "Host: kleinclaw-browser:9223",
    ]);

    assert.match(response, /^HTTP\/1\.1 200 /);
    const forwarded = chromium.requests.at(-1);
    assert.equal(forwarded.target, "/json/version");
    assert.equal(forwarded.headers.host, `127.0.0.1:${chromium.port}`);
    const body = jsonBody(response);
    assert.equal(
      body.webSocketDebuggerUrl,
      `ws://kleinclaw-browser:9223/devtools/browser/abc?token=${TOKEN}`,
    );
    assert.equal(
      body.devtoolsFrontendUrl,
      "/devtools/inspector.html?ws=kleinclaw-browser:9223/devtools/page/1",
    );
  });

  test("keeps other query parts such as the page URL for /json/new", async () => {
    const response = await rawRequest(proxyPort, [
      `PUT /json/new?about%3Ablank&token=${TOKEN} HTTP/1.1`,
      "Host: kleinclaw-browser:9223",
    ]);

    assert.match(response, /^HTTP\/1\.1 200 /);
    assert.equal(chromium.requests.at(-1).target, "/json/new?about%3Ablank");
  });

  test("accepts Bearer and Basic auth and strips the Authorization header", async () => {
    const bearer = await rawRequest(proxyPort, [
      "GET /json/list HTTP/1.1",
      "Host: kleinclaw-browser:9223",
      `Authorization: Bearer ${TOKEN}`,
    ]);
    assert.match(bearer, /^HTTP\/1\.1 200 /);
    assert.equal(chromium.requests.at(-1).headers.authorization, undefined);
    assert.equal(
      jsonBody(bearer).webSocketDebuggerUrl,
      "ws://kleinclaw-browser:9223/devtools/browser/abc",
      "header clients keep using the header, so no token is added to URLs",
    );

    const basic = await rawRequest(proxyPort, [
      "GET /json/version HTTP/1.1",
      "Host: kleinclaw-browser:9223",
      `Authorization: Basic ${Buffer.from(`kleinclaw:${TOKEN}`).toString("base64")}`,
    ]);
    assert.match(basic, /^HTTP\/1\.1 200 /);
  });

  test("pipes an authorized WebSocket upgrade and refuses one without token", async () => {
    const upgradeLines = (target) => [
      `GET ${target} HTTP/1.1`,
      "Host: kleinclaw-browser:9223",
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      "Sec-WebSocket-Version: 13",
    ];
    const refused = await rawRequest(proxyPort, upgradeLines("/devtools/browser/abc"));
    assert.match(refused, /^HTTP\/1\.1 401 /);

    const accepted = await rawRequest(
      proxyPort,
      upgradeLines(`/devtools/browser/abc?token=${TOKEN}`),
      { body: "ping", waitMs: 1000 },
    );
    assert.match(accepted, /^HTTP\/1\.1 101 /);
    assert.match(accepted, /echo:ping/);
    assert.equal(chromium.requests.at(-1).target, "/devtools/browser/abc");
  });

  test("refuses everything when no token is configured", async () => {
    const port = await freePort();
    const open = await startPython("cdp_proxy.py", [port, chromium.port], { CDP_TOKEN: "" });
    try {
      const response = await rawRequest(port, [
        "GET /json/version?token=anything-at-all-123 HTTP/1.1",
        "Host: kleinclaw-browser:9223",
      ]);
      assert.match(response, /^HTTP\/1\.1 403 /);
      assert.match(response, /set cdp_token in the add-on options/);
    } finally {
      open.child.kill();
    }
  });
});

describe("KleinClaw Browser add-on ingress guard", { skip: python ? false : "python 3 not found" }, () => {
  test("forwards allowed peers and drops everyone else", async () => {
    const upstream = net.createServer((socket) => {
      // The probe in waitForPort closes early; the guard then resets this side.
      socket.on("error", () => {});
      socket.end("novnc");
    });
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamPort = upstream.address().port;
    const allowedPort = await freePort();
    const blockedPort = await freePort();
    const allowed = await startPython("ingress_guard.py", [allowedPort, upstreamPort, "127.0.0.1"]);
    const blocked = await startPython("ingress_guard.py", [blockedPort, upstreamPort, "172.30.32.2"]);
    try {
      assert.equal(await rawRequest(allowedPort, ["GET / HTTP/1.1"], { waitMs: 1000 }), "novnc");
      assert.equal(await rawRequest(blockedPort, ["GET / HTTP/1.1"], { waitMs: 1000 }), "");
      assert.match(blocked.stderr(), /refused connection from 127\.0\.0\.1/);
    } finally {
      allowed.child.kill();
      blocked.child.kill();
      upstream.close();
    }
  });
});
