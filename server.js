const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { URL } = require('node:url');
const { WebSocket, WebSocketServer } = require('ws');

const {
  SERVICE_UNAVAILABLE,
  pickLanguage,
  sendOriginUnavailable,
} = require('./src/edge/localization');
const { serveStatic } = require('./src/edge/static-files');

const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 3000);

function isRelayPath(pathname) {
  return pathname === '/api/ws' || pathname.startsWith('/api/') || pathname.startsWith('/contribute');
}

function createServer(options = {}) {
  const originBaseUrl = options.originBaseUrl
    ?? process.env.ORIGIN_BASE_URL
    ?? process.env.RPF_ORIGIN_BASE_URL
    ?? '';
  const originTimeoutMs = Number(options.originTimeoutMs ?? process.env.ORIGIN_TIMEOUT_MS ?? 10000);
  const revisionWebhookSecret = options.revisionWebhookSecret
    ?? process.env.LISTINGS_REVISION_WEBHOOK_SECRET
    ?? process.env.RPF_LISTINGS_REVISION_WEBHOOK_SECRET
    ?? '';
  const ownsHttpAgent = !options.httpAgent;
  const ownsHttpsAgent = !options.httpsAgent;
  const httpAgent = options.httpAgent ?? new http.Agent({
    keepAlive: true,
    maxSockets: Number(process.env.ORIGIN_MAX_SOCKETS || 32),
    maxFreeSockets: Number(process.env.ORIGIN_MAX_FREE_SOCKETS || 8),
  });
  const httpsAgent = options.httpsAgent ?? new https.Agent({
    keepAlive: true,
    maxSockets: Number(process.env.ORIGIN_MAX_SOCKETS || 32),
    maxFreeSockets: Number(process.env.ORIGIN_MAX_FREE_SOCKETS || 8),
  });

  let currentListingsRevision = 0;
  const wsServer = new WebSocketServer({ noServer: true });

  function originUrlFor(req) {
    if (!originBaseUrl) return null;
    return new URL(req.url, originBaseUrl);
  }

  function relayHttp(req, res) {
    const target = originUrlFor(req);
    if (!target) {
      sendOriginUnavailable(req, res);
      return;
    }

    const client = target.protocol === 'https:' ? https : http;
    const headers = { ...req.headers, host: target.host };
    const agent = target.protocol === 'https:' ? httpsAgent : httpAgent;
    const proxy = client.request(
      target,
      {
        method: req.method,
        headers,
        agent,
        timeout: originTimeoutMs,
      },
      (originRes) => {
        res.writeHead(originRes.statusCode || 502, originRes.headers);
        originRes.pipe(res);
      },
    );

    proxy.on('timeout', () => proxy.destroy(new Error('origin timeout')));
    proxy.on('error', () => sendOriginUnavailable(req, res));
    req.pipe(proxy);
  }

  function broadcastListingsRevision(revision) {
    const payload = JSON.stringify({
      type: 'listings_revision_changed',
      revision,
    });

    for (const client of wsServer.clients) {
      if (client.readyState === WebSocket.OPEN && client.rpfSubscribedToListings) {
        client.send(payload);
      }
    }
  }

  function handleListingsWebSocket(socket) {
    socket.rpfSubscribedToListings = false;
    socket.on('message', (data) => {
      let message;
      try {
        message = JSON.parse(data.toString('utf8'));
      } catch {
        return;
      }

      if (message?.type !== 'subscribe' || message.channel !== 'listing_changes') return;

      socket.rpfSubscribedToListings = true;
      socket.send(JSON.stringify({ type: 'subscribed', channel: 'listing_changes' }));
      if (currentListingsRevision > 0) {
        socket.send(JSON.stringify({
          type: 'listings_revision_changed',
          revision: currentListingsRevision,
        }));
      }
    });
  }

  async function readJsonBody(req, maxBytes = 4096) {
    let total = 0;
    const chunks = [];
    for await (const chunk of req) {
      total += chunk.length;
      if (total > maxBytes) {
        const error = new Error('request body too large');
        error.statusCode = 413;
        throw error;
      }
      chunks.push(chunk);
    }
    if (chunks.length === 0) return {};
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  async function handleRevisionWebhook(req, res) {
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' }).end('method not allowed');
      return;
    }

    if (!revisionWebhookSecret) {
      res.writeHead(404).end('not found');
      return;
    }

    if (req.headers.authorization !== `Bearer ${revisionWebhookSecret}`) {
      res.writeHead(403).end('forbidden');
      return;
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      res.writeHead(error.statusCode || 400).end('bad request');
      return;
    }

    const revision = Number(body?.revision);
    if (!Number.isSafeInteger(revision) || revision < 0) {
      res.writeHead(400).end('invalid revision');
      return;
    }

    const applied = revision !== currentListingsRevision;
    currentListingsRevision = revision;
    if (applied) {
      broadcastListingsRevision(revision);
    }

    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({ ok: true, revision: currentListingsRevision, applied }));
  }

  wsServer.on('connection', handleListingsWebSocket);

  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const { pathname } = requestUrl;
    if (pathname === '/internal/listings/revision') {
      await handleRevisionWebhook(req, res);
      return;
    }

    if (isRelayPath(pathname)) {
      relayHttp(req, res);
      return;
    }

    serveStatic(req, res, requestUrl, PUBLIC_DIR);
  });

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (pathname !== '/api/ws') {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }

    wsServer.handleUpgrade(req, socket, head, (client) => {
      wsServer.emit('connection', client, req);
    });
  });

  server.on('close', () => {
    for (const client of wsServer.clients) {
      client.terminate();
    }
    wsServer.close();
    if (ownsHttpAgent) {
      httpAgent.destroy();
    }
    if (ownsHttpsAgent) {
      httpsAgent.destroy();
    }
  });

  return server;
}

const server = createServer();

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`web edge listening on :${PORT}`);
  });
}

module.exports = { createServer, server, SERVICE_UNAVAILABLE, pickLanguage };
