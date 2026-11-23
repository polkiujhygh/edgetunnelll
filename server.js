// server.js
// Adapter that runs a Cloudflare Worker (_worker.js) as a standard Node.js
// HTTP server, so the project can be deployed on Hostless (or any PaaS that
// expects a long-running process bound to process.env.PORT).
//
// How it works:
//   1. Node 20+ provides global Request / Response / Headers / fetch / URL.
//   2. We create an http.Server that listens on $PORT.
//   3. For each incoming request we build a web Request, call the worker's
//      fetch(request, env, ctx) handler, then stream the Response back.
//   4. Minimal stubs are provided for Cloudflare-only globals/bindings
//      (caches, WebSocketPair, HTMLRewriter, env.ASSETS, ctx.waitUntil ...).
//
// Limitations:
//   - Bindings that need a real Cloudflare account (KV, D1, R2, Durable
//     Objects, Queues, Email) will NOT work — the worker will see them as
//     empty/stub objects. If your worker relies on them, migrate to a
//     Node-native equivalent (e.g. a Hostless managed Postgres/Redis).
//   - HTMLRewriter is stubbed to a no-op pass-through. If the worker uses it
//     for real transformations, install 'htmlrewriter' shim and re-export.

import http from 'node:http';
import { Readable } from 'node:stream';

// ---------- Cloudflare global polyfills (best-effort) ----------

// Minimal Cache API stub (caches.default / caches.open)
class CacheStub {
  async match() { return undefined; }
  async put() {}
  async delete() { return false; }
}
const caches = {
  default: new CacheStub(),
  async open() { return new CacheStub(); }
};

// Minimal WebSocketPair stub (only useful if worker never actually uses WS)
class WebSocketStub {
  constructor() {
    this.readyState = 0;
  }
  accept() {}
  send() {}
  close() {}
  addEventListener() {}
  removeEventListener() {}
}
class WebSocketPairStub {
  constructor() {
    this[0] = new WebSocketStub(); // client
    this[1] = new WebSocketStub(); // server
  }
}

// HTMLRewriter stub — passes response through unchanged
class HTMLRewriterStub {
  on() { return this; }
  transform(response) { return response; }
}

// Expose as globals so the worker (which may reference them unguardedly) sees them
globalThis.caches = caches;
globalThis.WebSocketPair = WebSocketPairStub;
globalThis.HTMLRewriter = HTMLRewriterStub;

// ---------- Worker loader ----------

let workerModule;
try {
  // _worker.js is expected to be ESM with `export default { fetch }`
  workerModule = await import('./_worker.js');
} catch (err) {
  console.error('[server] Failed to import ./_worker.js:');
  console.error(err);
  process.exit(1);
}

const defaultExport = workerModule?.default;
const fetchHandler =
  (typeof defaultExport?.fetch === 'function' && defaultExport.fetch) ||
  (typeof defaultExport === 'function' && defaultExport) ||            // export default async (request, env, ctx) => ...
  (typeof workerModule.fetch === 'function' && workerModule.fetch) || // named export { fetch }
  null;

if (!fetchHandler) {
  console.error(
    '[server] No fetch handler found in _worker.js.\n' +
    'Expected one of:\n' +
    '  - export default { async fetch(request, env, ctx) { ... } }\n' +
    '  - export default async function fetch(request, env, ctx) { ... }\n' +
    '  - export { fetch }'
  );
  process.exit(1);
}

// ---------- env / ctx stubs ----------

const env = {
  // Cloudflare Pages binds ASSETS to the static-asset CDN. On Hostless we
  // don't have that, so any asset fetch returns a 404 with a clear hint.
  ASSETS: {
    fetch: async (request) => new Response(
      'ASSETS binding is not available on Hostless. ' +
      'Static assets must be served by your worker code or moved to Hostless Sites.',
      { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } }
    )
  },
  // Common Cloudflare env vars — read from process.env so you can set them
  // in the Hostless Configuration > Build / Runtime section.
  ...Object.fromEntries(
    Object.entries(process.env).filter(([k]) =>
      /^(CF_|CLOUDFLARE_|PUBLIC_|SECRET_|API_|DB_|KV_|EDGEPANEL_)/.test(k)
    )
  )
};

const ctx = {
  waitUntil(promise) {
    if (promise && typeof promise.catch === 'function') {
      promise.catch(err => console.error('[waitUntil] promise rejected:', err));
    }
  },
  passThroughOnException() {},
  abortController: new AbortController()
};

// ---------- HTTP server ----------

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  try {
    const protocol = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
    const host = req.headers.host || `${HOST}:${PORT}`;
    const url = new URL(req.url, `${protocol}://${host}`);

    // Build web Headers from Node's req.headers (handles multi-value)
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const v of value) headers.append(key, v);
      } else {
        headers.set(key, value);
      }
    }

    // Build body for methods that have one
    let body = null;
    if (!['GET', 'HEAD'].includes(req.method)) {
      body = Readable.toWeb(req);
    }

    const request = new Request(url.toString(), {
      method: req.method,
      headers,
      ...(body ? { body, duplex: 'half' } : {})
    });

    // Call the worker
    const response = await fetchHandler(request, env, ctx);

    // Status & headers
    res.statusCode = response.status || 200;
    response.headers.forEach((value, key) => {
      try { res.setHeader(key, value); } catch { /* ignore invalid header */ }
    });

    // Body
    if (response.body) {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    }
    res.end();
  } catch (err) {
    console.error('[server] request error:', err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
    }
    res.end(JSON.stringify({ error: 'internal_server_error', message: String(err?.message || err) }));
  } finally {
    console.log(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms`);
  }
});

server.on('error', (err) => {
  console.error('[server] server error:', err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`[server] Edgepanel listening on http://${HOST}:${PORT}`);
  console.log(`[server] Worker handler: ${fetchHandler.name || '<anonymous>'}`);
  console.log(`[server] Cloudflare bindings on Hostless are stubbed (KV/D1/R2/ASSETS unavailable).`);
});

// Graceful shutdown
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`[server] received ${sig}, shutting down...`);
    server.close(() => process.exit(0));
  });
}
