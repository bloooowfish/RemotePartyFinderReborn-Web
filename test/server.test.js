const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');

const { createServer, SERVICE_UNAVAILABLE, pickLanguage } = require('../server');

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
  assert.equal(response.headers.get('vary'), 'Accept-Language, Cookie');
});

test('uses immutable caching only for explicitly versioned assets', async () => {
  const unversioned = await fetch(`${baseUrl}/assets/translations.js`);
  assert.equal(unversioned.status, 200);
  assert.equal(unversioned.headers.get('cache-control'), 'no-cache');
  assert.equal(unversioned.headers.get('vary'), null);

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

test('relays party detail POST bodies to origin', async () => {
  let captured;
  const origin = http.createServer(async (req, res) => {
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
    res.end(JSON.stringify({ status: 'ok', matched_count: 1, modified_count: 1 }));
  });

  const originUrl = await listen(origin);
  const app = createServer({
    originBaseUrl: originUrl,
    originTimeoutMs: 1000,
  });
  const appUrl = await listen(app);

  try {
    const payload = {
      listing_id: 1,
      leader_content_id: 2,
      leader_name: 'Leader',
      home_world: 73,
      member_content_ids: [2],
    };
    const response = await fetch(`${appUrl}/contribute/detail`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    assert.equal(response.status, 200);
    await response.text();
    assert.equal(captured.method, 'POST');
    assert.equal(captured.url, '/contribute/detail');
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

test('applies lower listing revisions after the origin server restarts', async () => {
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

    const lowerMessage = onceWebSocketMessage(
      ws,
      (candidate) => candidate.type === 'listings_revision_changed',
    );
    lowerMessage.catch(() => {});
    assert.deepEqual(await postRevision(2), {
      status: 200,
      body: { ok: true, revision: 2, applied: true },
    });
    assert.equal((await lowerMessage).revision, 2);

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
