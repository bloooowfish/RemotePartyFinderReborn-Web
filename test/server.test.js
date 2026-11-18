const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const fs = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const zlib = require('node:zlib');

const {
  createServer,
  isAllowedWsOrigin,
  isRelayPath,
  isValidRequestTarget,
  SERVICE_UNAVAILABLE,
  pickLanguage,
  stripHopByHopHeaders,
  timingSafeEqualString,
} = require('../server');

let server;
let baseUrl;

const FETCH_BAD_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43,
  53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113,
  115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563,
  587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659,
  4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6679, 6697, 10080,
]);

function isFetchBadPort(port) {
  return FETCH_BAD_PORTS.has(Number(port));
}

before(async () => {
  server = createServer();
  baseUrl = await listen(server);
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

async function listen(app) {
  while (true) {
    const url = await new Promise((resolve) => {
      app.listen(0, '127.0.0.1', () => {
        const address = app.address();
        resolve(`http://${address.address}:${address.port}`);
      });
    });

    if (!isFetchBadPort(new URL(url).port)) {
      return url;
    }

    await close(app);
  }
}

function close(app) {
  return new Promise((resolve, reject) => {
    app.close((error) => (error ? reject(error) : resolve()));
  });
}

test('test listener skips ports blocked by fetch', () => {
  assert.equal(isFetchBadPort(4190), true);
  assert.equal(isFetchBadPort(6679), true);
  assert.equal(isFetchBadPort(54321), false);
});

test('serves the listings page from the public web app', async () => {
  const response = await fetch(`${baseUrl}/listings`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Remote Party Finder Reborn/);
});

test('localized HTML responses vary by language headers and cookies', async () => {
  const response = await fetch(`${baseUrl}/listings`, {
    headers: {
      'accept-language': 'ja,en;q=0.5',
      cookie: 'lang=de',
    },
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('vary'), 'Accept-Language, Cookie, Accept-Encoding');
});

test('uses immutable caching only for explicitly versioned assets', async () => {
  const unversioned = await fetch(`${baseUrl}/assets/translations.js`);
  assert.equal(unversioned.status, 200);
  assert.equal(unversioned.headers.get('cache-control'), 'no-cache');
  assert.equal(unversioned.headers.get('vary'), 'Accept-Encoding');
  assert.equal(unversioned.headers.get('x-content-type-options'), 'nosniff');

  const versioned = await fetch(`${baseUrl}/assets/listings.js?v=20`);
  assert.equal(versioned.status, 200);
  assert.equal(
    versioned.headers.get('cache-control'),
    'public, max-age=31536000, immutable',
  );
});

test('rejects static paths that normalize into public sibling directories', async () => {
  const siblingDir = path.join(__dirname, '..', 'public2');
  const siblingFile = path.join(siblingDir, 'secret.txt');
  await fs.mkdir(siblingDir, { recursive: true });
  await fs.writeFile(siblingFile, 'sibling secret');

  try {
    const response = await fetch(`${baseUrl}/../public2/secret.txt`);

    assert.equal(response.status, 404);
    assert.notEqual(await response.text(), 'sibling secret');
  } finally {
    await fs.rm(siblingDir, { recursive: true, force: true });
  }
});

test('rejects malformed encoded static paths without crashing', async () => {
  const response = await fetch(`${baseUrl}/%E0%A4%A`);

  assert.equal(response.status, 404);
});

test('serves the listings app shell while the configured origin is unavailable', async () => {
  const origin = http.createServer((_req, res) => {
    res.writeHead(503).end('origin unavailable');
  });
  const originUrl = await listen(origin);
  const app = createServer({
    originBaseUrl: originUrl,
    originTimeoutMs: 50,
  });
  const appUrl = await listen(app);

  try {
    const response = await fetch(`${appUrl}/listings`, {
      headers: { accept: 'text/html' },
    });
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(body, /id="listings-bootstrap-status"/);
    assert.doesNotMatch(body, /<title>Service unavailable<\/title>/);
  } finally {
    await close(app);
    await close(origin);
  }
});

test('relays sequential origin requests through a reusable keep-alive connection', async () => {
  const sockets = new Set();
  const origin = http.createServer((req, res) => {
    if (req.url !== '/api/listings/revision') {
      res.writeHead(404).end('not found');
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ revision: 1 }));
  });
  origin.on('connection', (socket) => sockets.add(socket));

  const originUrl = await listen(origin);
  const app = createServer({
    originBaseUrl: originUrl,
    originTimeoutMs: 1000,
  });
  const appUrl = await listen(app);

  try {
    const first = await fetch(`${appUrl}/api/listings/revision`);
    assert.equal(first.status, 200);
    await first.text();

    const second = await fetch(`${appUrl}/api/listings/revision`);
    assert.equal(second.status, 200);
    await second.text();

    assert.equal(sockets.size, 1);
  } finally {
    await close(app);
    await close(origin);
  }
});

test('uses the configured HTTP keep-alive agent for origin relay requests', async () => {
  class TrackingAgent extends http.Agent {
    addRequest(req, options) {
      this.addRequestCount += 1;
      return super.addRequest(req, options);
    }
  }

  const httpAgent = new TrackingAgent({ keepAlive: true });
  httpAgent.addRequestCount = 0;
  const origin = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ revision: 1 }));
  });

  const originUrl = await listen(origin);
  const app = createServer({
    originBaseUrl: originUrl,
    originTimeoutMs: 1000,
    httpAgent,
  });
  const appUrl = await listen(app);

  try {
    const response = await fetch(`${appUrl}/api/listings/revision`);

    assert.equal(response.status, 200);
    await response.text();
    assert.equal(httpAgent.addRequestCount, 1);
  } finally {
    await close(app);
    await close(origin);
    httpAgent.destroy();
  }
});

test('relays API POST bodies to origin while returning 404 for /contribute*', async () => {
  let captured = null;
  let originContributeHits = 0;
  const origin = http.createServer(async (req, res) => {
    if (req.url.startsWith('/contribute')) {
      originContributeHits += 1;
      res.writeHead(200).end('should-not-hit');
      return;
    }

    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }

    captured = {
      method: req.method,
      url: req.url,
      body: Buffer.concat(chunks).toString('utf8'),
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
  });

  const originUrl = await listen(origin);
  const app = createServer({
    originBaseUrl: originUrl,
    originTimeoutMs: 1000,
  });
  const appUrl = await listen(app);

  try {
    const payload = { test: 'value' };
    const contributePost = await fetch(`${appUrl}/contribute/detail`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(contributePost.status, 404);

    const contributeRoot = await fetch(`${appUrl}/contribute`, { method: 'POST' });
    assert.equal(contributeRoot.status, 404);

    const contributeGet = await fetch(`${appUrl}/contribute/multiple`);
    assert.equal(contributeGet.status, 404);
    assert.equal(originContributeHits, 0);

    const apiResponse = await fetch(`${appUrl}/api/test-relay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    assert.equal(apiResponse.status, 200);
    await apiResponse.text();
    assert.equal(captured.method, 'POST');
    assert.equal(captured.url, '/api/test-relay');
    assert.deepEqual(JSON.parse(captured.body), payload);
  } finally {
    await close(app);
    await close(origin);
  }
});

test('reports origin outage using the requested supported language', async () => {
  const response = await fetch(`${baseUrl}/api/listings/snapshot`, {
    headers: {
      cookie: 'lang=ja',
    },
  });

  assert.equal(response.status, 503);
  assert.equal(await response.text(), SERVICE_UNAVAILABLE.ja);
});

test('localized origin outage HTML varies by language headers and cookies', async () => {
  const response = await fetch(`${baseUrl}/api/listings/snapshot`, {
    headers: {
      accept: 'text/html',
      'accept-language': 'ja,en;q=0.5',
      cookie: 'lang=de',
    },
  });
  const body = await response.text();

  assert.equal(response.status, 503);
  assert.equal(response.headers.get('vary'), 'Accept-Language, Cookie');
  assert.match(body, /Der Remote-Party-Finder-Reborn-Server/);
});

test('reports origin outage using the highest q-value accept-language match', async () => {
  const response = await fetch(`${baseUrl}/api/listings/snapshot`, {
    headers: {
      'accept-language': 'ja;q=0.2, fr-FR;q=0.9, en;q=0.1',
    },
  });

  assert.equal(response.status, 503);
  assert.equal(await response.text(), SERVICE_UNAVAILABLE.fr);
});

test('reports origin outage without selecting zero-q accepted languages', async () => {
  const response = await fetch(`${baseUrl}/api/listings/snapshot`, {
    headers: {
      'accept-language': 'ja;q=0, de;q=0.4, en;q=0.7',
    },
  });

  assert.equal(response.status, 503);
  assert.equal(await response.text(), SERVICE_UNAVAILABLE.en);
});

test('ignores malformed language cookies when choosing outage language', () => {
  assert.equal(
    pickLanguage({
      headers: {
        cookie: 'lang=%E0%A4%A',
        'accept-language': 'de-DE,de;q=0.8,en;q=0.2',
      },
    }),
    'de',
  );
});

test('localizes first page language hints from accept-language', async () => {
  for (const pathname of ['/listings', '/stats']) {
    const response = await fetch(`${baseUrl}${pathname}`, {
      headers: {
        'accept-language': 'de-DE,de;q=0.8,en;q=0.2',
      },
    });
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(body, /<html lang="de"/);
    assert.match(body, /id="language" data-accept="de"/);
    assert.match(body, /aria-haspopup="listbox"[^>]*>Deutsch<\/a>/);
  }
});

function onceWebSocketMessage(ws, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('timed out waiting for websocket message'));
    }, 2000);

    function cleanup() {
      clearTimeout(timeout);
      ws.removeEventListener('message', onMessage);
      ws.removeEventListener('error', onError);
    }

    function onMessage(event) {
      const message = JSON.parse(event.data);
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    }

    function onError(error) {
      cleanup();
      reject(error);
    }

    ws.addEventListener('message', onMessage);
    ws.addEventListener('error', onError);
  });
}

test('broadcasts authenticated listing revision webhooks to subscribed websocket clients', async () => {
  const app = createServer({
    revisionWebhookSecret: 'webhook-secret',
  });
  let appUrl;
  await new Promise((resolve) => {
    app.listen(0, '127.0.0.1', () => {
      const address = app.address();
      appUrl = `http://${address.address}:${address.port}`;
      resolve();
    });
  });

  let ws;
  try {
    ws = new WebSocket(appUrl.replace(/^http:/, 'ws:') + '/api/ws');
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    ws.send(JSON.stringify({ type: 'subscribe', channel: 'listing_changes' }));
    await onceWebSocketMessage(ws, (message) => message.type === 'subscribed');

    const revisionMessage = onceWebSocketMessage(
      ws,
      (candidate) => candidate.type === 'listings_revision_changed',
    );
    const response = await fetch(`${appUrl}/internal/listings/revision`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer webhook-secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ revision: 77 }),
    });

    assert.equal(response.status, 200);
    const message = await revisionMessage;
    assert.equal(message.revision, 77);
  } finally {
    if (ws && ws.readyState < WebSocket.CLOSING) {
      const closed = new Promise((resolve) => {
        ws.addEventListener('close', resolve, { once: true });
      });
      ws.close();
      await closed;
    }
    await new Promise((resolve, reject) => {
      app.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('applies strictly monotonic listing revisions and rejects stale or replayed revisions', async () => {
  const app = createServer({
    revisionWebhookSecret: 'webhook-secret',
  });
  let appUrl;
  await new Promise((resolve) => {
    app.listen(0, '127.0.0.1', () => {
      const address = app.address();
      appUrl = `http://${address.address}:${address.port}`;
      resolve();
    });
  });

  let ws;
  try {
    ws = new WebSocket(appUrl.replace(/^http:/, 'ws:') + '/api/ws');
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    ws.send(JSON.stringify({ type: 'subscribe', channel: 'listing_changes' }));
    await onceWebSocketMessage(ws, (message) => message.type === 'subscribed');

    const postRevision = async (revision) => {
      const response = await fetch(`${appUrl}/internal/listings/revision`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer webhook-secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ revision }),
      });
      return {
        status: response.status,
        body: await response.json(),
      };
    };

    const higherMessage = onceWebSocketMessage(
      ws,
      (candidate) => candidate.type === 'listings_revision_changed',
    );
    assert.deepEqual(await postRevision(9), {
      status: 200,
      body: { ok: true, revision: 9, applied: true },
    });
    assert.equal((await higherMessage).revision, 9);

    assert.deepEqual(await postRevision(9), {
      status: 200,
      body: { ok: true, revision: 9, applied: false },
    });

    assert.deepEqual(await postRevision(2), {
      status: 200,
      body: { ok: true, revision: 9, applied: false },
    });

    const nextHigherMessage = onceWebSocketMessage(
      ws,
      (candidate) => candidate.type === 'listings_revision_changed',
    );
    assert.deepEqual(await postRevision(12), {
      status: 200,
      body: { ok: true, revision: 12, applied: true },
    });
    assert.equal((await nextHigherMessage).revision, 12);

  } finally {
    if (ws && ws.readyState < WebSocket.CLOSING) {
      const closed = new Promise((resolve) => {
        ws.addEventListener('close', resolve, { once: true });
      });
      ws.close();
      await closed;
    }
    await new Promise((resolve, reject) => {
      app.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('rejects unauthenticated listing revision webhooks', async () => {
  const app = createServer({
    revisionWebhookSecret: 'webhook-secret',
  });
  let appUrl;
  await new Promise((resolve) => {
    app.listen(0, '127.0.0.1', () => {
      const address = app.address();
      appUrl = `http://${address.address}:${address.port}`;
      resolve();
    });
  });

  try {
    const response = await fetch(`${appUrl}/internal/listings/revision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ revision: 78 }),
    });

    assert.equal(response.status, 403);
  } finally {
    await new Promise((resolve, reject) => {
      app.close((error) => (error ? reject(error) : resolve()));
    });
  }
});


function sendRawHttp(port, rawRequest) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const chunks = [];
    socket.on('connect', () => {
      socket.end(rawRequest);
    });
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.on('error', reject);
  });
}

function httpGetRaw(url, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

test('SSRF and open-proxy request targets are blocked early on HTTP and WS upgrade', async () => {
  assert.equal(isValidRequestTarget('/listings?page=2'), true);
  assert.equal(isValidRequestTarget('//evil.com/listings'), false);
  assert.equal(isValidRequestTarget('///evil.com/listings'), false);
  assert.equal(isValidRequestTarget('http://evil.com/api/listings'), false);
  assert.equal(isValidRequestTarget('evil.com'), false);
  assert.equal(isValidRequestTarget('/listings\r\nx'), false);

  const port = Number(new URL(baseUrl).port);
  const protoRelative = await sendRawHttp(port, 'GET //evil.com/listings HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
  assert.match(protoRelative, /^HTTP\/1\.1 400 Bad Request/);

  const absoluteUri = await sendRawHttp(port, 'GET http://evil.com/api/listings HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
  assert.match(absoluteUri, /^HTTP\/1\.1 400 Bad Request/);

  const badWsTarget = await sendRawHttp(
    port,
    'GET //evil.com/api/ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
  );
  assert.match(badWsTarget, /^HTTP\/1\.1 400 Bad Request/);
});

test('relay path validation enforces exact /api and /api/* boundaries and blocks /contribute*', async () => {
  assert.equal(isRelayPath('/api'), true);
  assert.equal(isRelayPath('/api/listings'), true);
  assert.equal(isRelayPath('/api-evil'), false);
  assert.equal(isRelayPath('/contribute'), false);
  assert.equal(isRelayPath('/contribute/multiple'), false);
  assert.equal(isRelayPath('/contribute-evil'), false);

  const notRelay = await fetch(`${baseUrl}/contribute-evil`);
  assert.equal(notRelay.status, 404);
  assert.equal((await fetch(`${baseUrl}/contribute`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/contribute/multiple`)).status, 404);

  const plainWsHttp = await fetch(`${baseUrl}/api/ws`);
  assert.equal(plainWsHttp.status, 426);
  assert.equal(plainWsHttp.headers.get('upgrade'), 'websocket');

  const port = Number(new URL(baseUrl).port);
  const badUpgrade = await sendRawHttp(
    port,
    'GET /listings HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: h2c\r\nConnection: Upgrade\r\n\r\n',
  );
  assert.match(badUpgrade, /^HTTP\/1\.1 426 Upgrade Required/);
});

test('proxy strips hop-by-hop headers, sets X-RPF-Forwarded-For from socket IP, and aborts upstream on client disconnect', async () => {
  let lastRequest = null;
  let upstreamAborted = false;
  let releaseDelayedResponse = null;

  const origin = http.createServer((req, res) => {
    lastRequest = {
      url: req.url,
      headers: { ...req.headers },
    };
    if (req.url === '/api/slow') {
      req.on('close', () => {
        if (!res.writableEnded) upstreamAborted = true;
      });
      releaseDelayedResponse = () => {
        if (!res.destroyed) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{}');
        }
      };
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json', connection: 'keep-alive', 'keep-alive': 'timeout=5' });
    res.end(JSON.stringify({ ok: true }));
  });

  const originUrl = await listen(origin);
  const app = createServer({ originBaseUrl: originUrl });
  const appUrl = await listen(app);

  try {
    const cleaned = stripHopByHopHeaders({
      host: 'proxy.test',
      connection: 'x-hop-secret, keep-alive',
      'keep-alive': 'timeout=5',
      'proxy-authorization': 'Basic abc',
      'x-hop-secret': 'secret',
      accept: 'application/json',
    });
    assert.equal(cleaned.connection, undefined);
    assert.equal(cleaned['keep-alive'], undefined);
    assert.equal(cleaned['proxy-authorization'], undefined);
    assert.equal(cleaned['x-hop-secret'], undefined);
    assert.equal(cleaned.accept, 'application/json');

    const proxyRes = await httpGetRaw(`${appUrl}/api/listings`, {
      Connection: 'x-custom-hop',
      'x-custom-hop': 'strip-me',
      'x-rpf-forwarded-for': '8.8.8.8',
    });
    assert.equal(proxyRes.status, 200);
    assert.equal(lastRequest.headers['x-custom-hop'], undefined);
    assert.equal(lastRequest.headers['x-rpf-forwarded-for'], '127.0.0.1');

    const target = new URL(appUrl);
    await new Promise((resolve) => {
      const slowReq = http.request({
        hostname: target.hostname,
        port: target.port,
        path: '/api/slow',
        method: 'GET',
      });
      slowReq.on('error', () => {});
      slowReq.end();
      setTimeout(() => {
        slowReq.destroy();
        setTimeout(resolve, 60);
      }, 40);
    });

    assert.equal(upstreamAborted, true);
  } finally {
    if (releaseDelayedResponse) releaseDelayedResponse();
    await close(app);
    await close(origin);
  }
});

test('serves security headers, redirects / to 302 /listings, and supports ETag 304, HEAD, and br/gzip compression', async () => {
  const rootRedirect = await fetch(`${baseUrl}/`, { redirect: 'manual' });
  assert.equal(rootRedirect.status, 302);
  assert.equal(rootRedirect.headers.get('location'), '/listings');
  assert.equal(rootRedirect.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(rootRedirect.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(rootRedirect.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.match(rootRedirect.headers.get('content-security-policy'), /default-src 'self'/);

  const rawAsset = await httpGetRaw(`${baseUrl}/assets/listings.js`);
  assert.equal(rawAsset.status, 200);
  const etag = rawAsset.headers.etag;
  assert.ok(etag, 'static assets should emit ETag');

  const notModified = await httpGetRaw(`${baseUrl}/assets/listings.js`, { 'If-None-Match': etag });
  assert.equal(notModified.status, 304);
  assert.equal(notModified.body.length, 0);

  const headAsset = await httpGetRaw(`${baseUrl}/assets/listings.js`, {}, 'HEAD');
  assert.equal(headAsset.status, 200);
  assert.equal(headAsset.body.length, 0);

  const brListings = await httpGetRaw(`${baseUrl}/listings`, { 'Accept-Encoding': 'br, gzip' });
  assert.equal(brListings.status, 200);
  assert.equal(brListings.headers['content-encoding'], 'br');
  assert.match(zlib.brotliDecompressSync(brListings.body).toString('utf8'), /Remote Party Finder Reborn/);

  const gzListings = await httpGetRaw(`${baseUrl}/listings`, { 'Accept-Encoding': 'gzip' });
  assert.equal(gzListings.status, 200);
  assert.equal(gzListings.headers['content-encoding'], 'gzip');
  assert.match(zlib.gunzipSync(gzListings.body).toString('utf8'), /Remote Party Finder Reborn/);

  const headListings = await httpGetRaw(`${baseUrl}/listings`, {}, 'HEAD');
  assert.equal(headListings.status, 200);
  assert.equal(headListings.body.length, 0);
});

test('webhook uses constant-time auth comparison and rejects oversized payloads with 413', async () => {
  assert.equal(timingSafeEqualString('secret-1', 'secret-1'), true);
  assert.equal(timingSafeEqualString('secret-1', 'secret-2'), false);
  assert.equal(timingSafeEqualString('short', 'much-longer-secret'), false);

  const app = createServer({
    revisionWebhookSecret: 'webhook-secret',
    webhookMaxBytes: 64,
  });
  const appUrl = await listen(app);
  try {
    const oversized = await fetch(`${appUrl}/internal/listings/revision`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer webhook-secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ revision: 100, pad: 'x'.repeat(256) }),
    }).catch((err) => err);

    if (oversized instanceof Error) {
      assert.ok(oversized.cause || oversized.message);
    } else {
      assert.equal(oversized.status, 413);
    }
  } finally {
    await close(app);
  }
});

test('WebSocket enforces allowed Origin, connection cap, and maxPayload limit', async () => {
  assert.equal(
    isAllowedWsOrigin(
      { headers: { host: 'example.test', origin: 'https://example.test' } },
      { requireOrigin: true },
    ),
    true,
  );
  assert.equal(
    isAllowedWsOrigin(
      { headers: { host: 'example.test', origin: 'https://evil.test' } },
      { requireOrigin: true },
    ),
    false,
  );

  const app = createServer({
    maxWsClients: 1,
    wsMaxPayload: 64,
    requireWsOrigin: true,
    allowedWsOrigins: ['http://allowed.test'],
  });
  const appUrl = await listen(app);
  const port = Number(new URL(appUrl).port);

  let ws;
  try {
    const rejectedOrigin = await sendRawHttp(
      port,
      'GET /api/ws HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: http://evil.test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
    );
    assert.match(rejectedOrigin, /^HTTP\/1\.1 403 Forbidden/);

    const WebSocketClient = require('ws');
    ws = new WebSocketClient(appUrl.replace(/^http:/, 'ws:') + '/api/ws', {
      headers: { Origin: 'http://allowed.test' },
    });
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    const overCapacity = await sendRawHttp(
      port,
      'GET /api/ws HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: http://allowed.test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
    );
    assert.match(overCapacity, /^HTTP\/1\.1 503 Service Unavailable/);

    const closedPromise = new Promise((resolve) => {
      ws.once('close', (code) => resolve(code));
    });
    ws.send(JSON.stringify({ type: 'subscribe', channel: 'listing_changes', pad: 'x'.repeat(200) }));
    const closeCode = await closedPromise;
    assert.equal(closeCode, 1009);
  } finally {
    if (ws && ws.readyState < 2) ws.terminate();
    await close(app);
  }
});

test('proxy strips spoofed relay secret, forwards configured secret, and honors trustProxy for client IP', async () => {
  let lastHeaders = null;
  const origin = http.createServer((req, res) => {
    lastHeaders = { ...req.headers };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const originUrl = await listen(origin);

  const untrustedProxyApp = createServer({
    originBaseUrl: originUrl,
    revisionWebhookSecret: 'webhook-fallback-secret',
    trustProxy: false,
  });
  const untrustedUrl = await listen(untrustedProxyApp);

  const trustedProxyApp = createServer({
    originBaseUrl: originUrl,
    revisionWebhookSecret: 'webhook-fallback-secret',
    originRelaySecret: 'explicit-relay-secret',
    trustProxy: true,
  });
  const trustedUrl = await listen(trustedProxyApp);

  try {
    const resUntrusted = await httpGetRaw(`${untrustedUrl}/api/stats`, {
      'x-rpf-relay-secret': 'attacker-spoof',
      'x-envoy-external-address': '198.51.100.42',
      'x-forwarded-for': '203.0.113.99',
    });
    assert.equal(resUntrusted.status, 200);
    assert.equal(lastHeaders['x-rpf-relay-secret'], 'webhook-fallback-secret');
    assert.equal(lastHeaders['x-rpf-forwarded-for'], '127.0.0.1');

    const resTrustedEnvoy = await httpGetRaw(`${trustedUrl}/api/stats`, {
      'x-rpf-relay-secret': 'attacker-spoof',
      'x-envoy-external-address': '::ffff:198.51.100.42',
      'x-forwarded-for': '203.0.113.99, 10.0.0.1',
    });
    assert.equal(resTrustedEnvoy.status, 200);
    assert.equal(lastHeaders['x-rpf-relay-secret'], 'explicit-relay-secret');
    assert.equal(lastHeaders['x-rpf-forwarded-for'], '198.51.100.42');

    const resTrustedXff = await httpGetRaw(`${trustedUrl}/api/stats`, {
      'x-forwarded-for': 'not-an-ip, 203.0.113.77, 10.0.0.2',
    });
    assert.equal(resTrustedXff.status, 200);
    assert.equal(lastHeaders['x-rpf-forwarded-for'], '203.0.113.77');
  } finally {
    await close(trustedProxyApp);
    await close(untrustedProxyApp);
    await close(origin);
  }
});

test('snapshot singleflight cache deduplicates concurrent fetches, serves gzip/plain + 304 from RAM, and invalidates on revision or TTL', async () => {
  let originRevision = 10;
  let originListings = [{ id: 1 }];
  let snapshotHits = 0;
  let releaseFetch = null;

  const origin = http.createServer((req, res) => {
    if (req.url !== '/api/listings/snapshot') {
      res.writeHead(404).end('not found');
      return;
    }
    snapshotHits += 1;
    const hitIndex = snapshotHits;
    const etag = `"snap-rev-${originRevision}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-store' }).end();
      return;
    }

    const respond = () => {
      const json = JSON.stringify({ revision: originRevision, listings: originListings });
      const gz = zlib.gzipSync(Buffer.from(json, 'utf8'));
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Encoding': 'gzip',
        ETag: etag,
        'Cache-Control': 'no-store',
      });
      res.end(gz);
    };

    if (hitIndex === 1) {
      releaseFetch = respond;
    } else {
      respond();
    }
  });

  const originUrl = await listen(origin);
  const app = createServer({
    originBaseUrl: originUrl,
    revisionWebhookSecret: 'webhook-secret',
    snapshotCacheTtlMs: 80,
  });
  const appUrl = await listen(app);

  try {
    const concurrentPromises = Array.from({ length: 25 }, (_, i) => (
      httpGetRaw(
        `${appUrl}/api/listings/snapshot`,
        i % 2 === 0 ? { 'Accept-Encoding': 'gzip' } : {},
      )
    ));

    await new Promise((resolve) => {
      const check = () => (releaseFetch ? resolve() : setTimeout(check, 5));
      check();
    });
    assert.equal(snapshotHits, 1);
    releaseFetch();
    releaseFetch = null;

    const results = await Promise.all(concurrentPromises);
    assert.equal(snapshotHits, 1, 'all 25 concurrent requests must share 1 upstream fetch');

    let plainEtag = null;
    let gzipEtag = null;
    for (let i = 0; i < results.length; i += 1) {
      const res = results[i];
      assert.equal(res.status, 200);
      if (i % 2 === 0) {
        assert.equal(res.headers['content-encoding'], 'gzip');
        gzipEtag = res.headers.etag;
        assert.deepEqual(JSON.parse(zlib.gunzipSync(res.body).toString('utf8')), {
          revision: 10,
          listings: [{ id: 1 }],
        });
      } else {
        assert.equal(res.headers['content-encoding'], undefined);
        plainEtag = res.headers.etag;
        assert.deepEqual(JSON.parse(res.body.toString('utf8')), {
          revision: 10,
          listings: [{ id: 1 }],
        });
      }
    }
    assert.notEqual(plainEtag, gzipEtag);

    // Warm cache hit & 304 conditional responses directly from RAM (0 origin hits).
    const plain304 = await httpGetRaw(`${appUrl}/api/listings/snapshot`, { 'If-None-Match': plainEtag });
    assert.equal(plain304.status, 304);
    const gzip304 = await httpGetRaw(`${appUrl}/api/listings/snapshot`, {
      'Accept-Encoding': 'gzip',
      'If-None-Match': gzipEtag,
    });
    assert.equal(gzip304.status, 304);
    assert.equal(snapshotHits, 1);

    // Webhook advances revision -> stale cache + stale If-None-Match must bypass 304 and fetch new revision.
    originRevision = 11;
    originListings = [{ id: 2 }];
    const webhookRes = await fetch(`${appUrl}/internal/listings/revision`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer webhook-secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ revision: 11 }),
    });
    assert.equal(webhookRes.status, 200);

    const rev11Res = await httpGetRaw(`${appUrl}/api/listings/snapshot`, {
      'Accept-Encoding': 'gzip',
      'If-None-Match': gzipEtag,
    });
    assert.equal(rev11Res.status, 200);
    assert.equal(snapshotHits, 2);
    assert.deepEqual(JSON.parse(zlib.gunzipSync(rev11Res.body).toString('utf8')), {
      revision: 11,
      listings: [{ id: 2 }],
    });

    // Wait past snapshotCacheTtlMs -> revalidates with origin (304 updates timestamp without transferring body).
    await new Promise((resolve) => setTimeout(resolve, 100));
    const revalidated304 = await httpGetRaw(`${appUrl}/api/listings/snapshot`, {
      'Accept-Encoding': 'gzip',
      'If-None-Match': rev11Res.headers.etag,
    });
    assert.equal(revalidated304.status, 304);
    assert.equal(snapshotHits, 3);
  } finally {
    await close(app);
    await close(origin);
  }
});

test('/api/listings/revision serves directly from RAM during recent webhook heartbeat and falls back to origin after TTL', async () => {
  let originRevisionCalls = 0;
  const origin = http.createServer((req, res) => {
    if (req.url === '/api/listings/revision') {
      originRevisionCalls += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ revision: 42 }));
      return;
    }
    res.writeHead(404).end('not found');
  });

  const originUrl = await listen(origin);
  const app = createServer({
    originBaseUrl: originUrl,
    revisionWebhookSecret: 'webhook-secret',
    revisionLocalTtlMs: 80,
  });
  const appUrl = await listen(app);

  try {
    // Before webhook arrives, currentListingsRevision is null so edge relays to origin.
    const initialRes = await fetch(`${appUrl}/api/listings/revision`);
    assert.equal(initialRes.status, 200);
    assert.deepEqual(await initialRes.json(), { revision: 42 });
    assert.equal(originRevisionCalls, 1);

    // Webhook sets revision + recent heartbeat -> served from RAM with 0 origin calls.
    await fetch(`${appUrl}/internal/listings/revision`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer webhook-secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ revision: 43 }),
    });

    const cachedRevRes = await fetch(`${appUrl}/api/listings/revision`);
    assert.equal(cachedRevRes.status, 200);
    assert.deepEqual(await cachedRevRes.json(), { revision: 43 });
    assert.equal(originRevisionCalls, 1);

    // After heartbeat TTL expires, falls back to relaying to origin.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const fallbackRes = await fetch(`${appUrl}/api/listings/revision`);
    assert.equal(fallbackRes.status, 200);
    assert.deepEqual(await fallbackRes.json(), { revision: 42 });
    assert.equal(originRevisionCalls, 2);
  } finally {
    await close(app);
    await close(origin);
  }
});
