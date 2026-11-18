const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const net = require('node:net');
const path = require('node:path');
const { URL } = require('node:url');
const { promisify } = require('node:util');
const zlib = require('node:zlib');
const { WebSocket, WebSocketServer } = require('ws');

const {
  SERVICE_UNAVAILABLE,
  pickLanguage,
  sendOriginUnavailable,
} = require('./src/edge/localization');
const {
  createStaticHandler,
  etagMatches,
  selectAcceptEncoding,
} = require('./src/edge/static-files');

const gzipAsync = promisify(zlib.gzip);
const gunzipAsync = promisify(zlib.gunzip);

const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 3000);
const DEFAULT_WS_MAX_PAYLOAD = 4096;
const DEFAULT_MAX_WS_CLIENTS = Number(process.env.MAX_WS_CLIENTS || 512);
const DEFAULT_WS_HEARTBEAT_MS = 30000;
const DEFAULT_MAX_WS_BUFFERED_BYTES = 65536;
const DEFAULT_WEBHOOK_MAX_BYTES = 16 * 1024;
const DEFAULT_SNAPSHOT_CACHE_TTL_MS = 15000;
const DEFAULT_SNAPSHOT_STALE_GRACE_MS = 30000;
const DEFAULT_REVISION_LOCAL_TTL_MS = 60000;
const DEFAULT_SNAPSHOT_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const FAST_SNAPSHOT_PARSE_THRESHOLD_BYTES = 8192;
const SNAPSHOT_METADATA_SLICE_BYTES = 4096;

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' ws: wss:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');

function applySecurityHeaders(res) {
  if (!res || res.headersSent || res.writableEnded || res.destroyed) return;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
}

function normalizeRevisionEpoch(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 128 || /[\s\u0000-\u001f\u007f]/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function skipWhitespace(text, index) {
  let pos = index;
  while (pos < text.length) {
    const code = text.charCodeAt(pos);
    if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) {
      pos += 1;
    } else {
      break;
    }
  }
  return pos;
}

function readJsonStringToken(text, startIndex) {
  if (text[startIndex] !== '"') return null;
  let pos = startIndex + 1;
  while (pos < text.length) {
    const ch = text[pos];
    if (ch === '\\') {
      pos += 2;
      continue;
    }
    if (ch === '"') {
      try {
        return {
          value: JSON.parse(text.slice(startIndex, pos + 1)),
          nextIndex: pos + 1,
        };
      } catch {
        return null;
      }
    }
    pos += 1;
  }
  return null;
}

function skipJsonComposite(text, startIndex) {
  const opener = text[startIndex];
  if (opener !== '{' && opener !== '[') return -1;
  let depth = 0;
  let pos = startIndex;
  while (pos < text.length) {
    const ch = text[pos];
    if (ch === '"') {
      pos += 1;
      while (pos < text.length) {
        if (text[pos] === '\\') {
          pos += 2;
        } else if (text[pos] === '"') {
          pos += 1;
          break;
        } else {
          pos += 1;
        }
      }
      continue;
    }
    if (ch === '{' || ch === '[') {
      depth += 1;
    } else if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) {
        return pos + 1;
      }
    }
    pos += 1;
  }
  return -1;
}

function extractTopLevelFromHeadSlice(head) {
  let revision = null;
  let revisionEpoch = null;
  let pos = skipWhitespace(head, 0);
  if (head[pos] !== '{') {
    return { revision, revisionEpoch };
  }
  pos += 1;

  while (pos < head.length) {
    pos = skipWhitespace(head, pos);
    if (pos >= head.length || head[pos] === '}') break;
    if (head[pos] === ',') {
      pos = skipWhitespace(head, pos + 1);
    }
    if (pos >= head.length || head[pos] !== '"') break;

    const keyToken = readJsonStringToken(head, pos);
    if (!keyToken) break;
    const key = keyToken.value;
    pos = skipWhitespace(head, keyToken.nextIndex);
    if (head[pos] !== ':') break;
    pos = skipWhitespace(head, pos + 1);
    if (pos >= head.length) break;

    const valStart = head[pos];
    if (valStart === '"') {
      const strToken = readJsonStringToken(head, pos);
      if (!strToken) break;
      if (key === 'revision_epoch' || (key === 'epoch' && revisionEpoch === null)) {
        revisionEpoch = normalizeRevisionEpoch(strToken.value);
      }
      pos = strToken.nextIndex;
    } else if (valStart === '{' || valStart === '[') {
      if (key === 'listings') break;
      const nextPos = skipJsonComposite(head, pos);
      if (nextPos === -1) break;
      pos = nextPos;
    } else {
      let endPos = pos;
      while (endPos < head.length && !/[\s,}\]]/.test(head[endPos])) {
        endPos += 1;
      }
      if (endPos === head.length && !/[\s,}\]]/.test(head[endPos - 1])) {
        // Number/token may be truncated at the end of the slice.
        break;
      }
      const token = head.slice(pos, endPos);
      if (key === 'revision' && /^(0|[1-9]\d*)$/.test(token)) {
        const parsed = Number(token);
        if (Number.isSafeInteger(parsed) && parsed >= 0) {
          revision = parsed;
        }
      }
      pos = endPos;
    }
  }

  return { revision, revisionEpoch };
}

function extractTopLevelFromTailSlice(tail) {
  const lastBracket = tail.lastIndexOf(']');
  if (lastBracket === -1) return { revision: null, revisionEpoch: null };
  const afterBracket = tail.slice(lastBracket + 1).trim();
  if (!afterBracket.endsWith('}')) return { revision: null, revisionEpoch: null };
  const body = afterBracket.startsWith(',') ? afterBracket.slice(1).trimStart() : afterBracket;
  if (!body || body === '}') return { revision: null, revisionEpoch: null };

  try {
    const parsed = JSON.parse(`{${body}`);
    const revision = Number.isSafeInteger(parsed?.revision) && parsed.revision >= 0
      ? parsed.revision
      : null;
    const revisionEpoch = normalizeRevisionEpoch(parsed?.revision_epoch ?? parsed?.epoch);
    return { revision, revisionEpoch };
  } catch {
    return { revision: null, revisionEpoch: null };
  }
}

function parseSnapshotFullJson(bodyPlain) {
  try {
    const parsed = JSON.parse(bodyPlain.toString('utf8'));
    if (!parsed || typeof parsed !== 'object') {
      return { validJson: false, revision: null, revisionEpoch: null };
    }
    const revision = !Array.isArray(parsed) && Number.isSafeInteger(parsed.revision) && parsed.revision >= 0
      ? parsed.revision
      : null;
    const revisionEpoch = !Array.isArray(parsed)
      ? normalizeRevisionEpoch(parsed.revision_epoch ?? parsed.epoch)
      : null;
    return { validJson: true, revision, revisionEpoch };
  } catch {
    return { validJson: false, revision: null, revisionEpoch: null };
  }
}

function extractSnapshotMetadata(bodyPlain) {
  if (!Buffer.isBuffer(bodyPlain) || bodyPlain.length === 0) {
    return { validJson: false, revision: null, revisionEpoch: null };
  }

  if (bodyPlain.length <= FAST_SNAPSHOT_PARSE_THRESHOLD_BYTES) {
    return parseSnapshotFullJson(bodyPlain);
  }

  const head = bodyPlain.subarray(0, SNAPSHOT_METADATA_SLICE_BYTES).toString('utf8');
  const tail = bodyPlain
    .subarray(Math.max(0, bodyPlain.length - SNAPSHOT_METADATA_SLICE_BYTES))
    .toString('utf8');

  if (!head.trimStart().startsWith('{') || !tail.trimEnd().endsWith('}')) {
    return { validJson: false, revision: null, revisionEpoch: null };
  }

  let { revision, revisionEpoch } = extractTopLevelFromHeadSlice(head);
  if (revision === null || revisionEpoch === null) {
    const fromTail = extractTopLevelFromTailSlice(tail);
    if (revision === null && fromTail.revision !== null) {
      revision = fromTail.revision;
    }
    if (revisionEpoch === null && fromTail.revisionEpoch !== null) {
      revisionEpoch = fromTail.revisionEpoch;
    }
  }

  if (revision !== null) {
    return { validJson: true, revision, revisionEpoch };
  }

  return parseSnapshotFullJson(bodyPlain);
}

function isValidRequestTarget(rawUrl) {
  return (
    typeof rawUrl === 'string'
    && rawUrl.startsWith('/')
    && !rawUrl.startsWith('//')
    && !rawUrl.includes('\\')
    && !/[\u0000-\u001f\u007f]/.test(rawUrl)
  );
}

function parseRequestUrl(req) {
  if (!isValidRequestTarget(req.url)) {
    return null;
  }
  try {
    return new URL(req.url, 'http://localhost');
  } catch {
    return null;
  }
}

function isRelayPath(pathname) {
  return pathname === '/api' || pathname.startsWith('/api/');
}

function deriveSnapshotEtags(originEtag, bodyPlain) {
  const raw = typeof originEtag === 'string' ? originEtag.trim() : '';
  if (raw) {
    const quotedMatch = /^(W\/)?"(.*)"$/i.exec(raw);
    if (quotedMatch) {
      const weak = quotedMatch[1] || '';
      const inner = quotedMatch[2];
      return {
        etagPlain: `${weak}"${inner}"`,
        etagGzip: `${weak}"${inner}-gz"`,
      };
    }
    return {
      etagPlain: `"${raw}"`,
      etagGzip: `"${raw}-gz"`,
    };
  }

  const hash = crypto.createHash('sha256').update(bodyPlain).digest('hex').slice(0, 16);
  return {
    etagPlain: `"${hash}"`,
    etagGzip: `"${hash}-gz"`,
  };
}

function stripHopByHopHeaders(headers) {
  const cleaned = {};
  const connectionTokens = new Set();
  const rawConnection = headers.connection;
  if (typeof rawConnection === 'string') {
    for (const token of rawConnection.split(',')) {
      const normalized = token.trim().toLowerCase();
      if (normalized) connectionTokens.add(normalized);
    }
  }

  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || connectionTokens.has(lower)) {
      continue;
    }
    cleaned[key] = value;
  }
  return cleaned;
}

function normalizeRemoteAddress(address) {
  if (typeof address !== 'string' || !address) return '';
  return address.startsWith('::ffff:') ? address.slice(7) : address;
}

function parseClientIpCandidate(raw) {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const candidate = normalizeRemoteAddress(trimmed);
  return net.isIP(candidate) !== 0 ? candidate : '';
}

function extractRelayClientIp(req, trustProxy) {
  if (trustProxy) {
    const envoyIp = parseClientIpCandidate(req.headers['x-envoy-external-address']);
    if (envoyIp) return envoyIp;

    const forwardedFor = req.headers['x-forwarded-for'];
    if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
      for (const part of forwardedFor.split(',')) {
        const candidate = parseClientIpCandidate(part);
        if (candidate) return candidate;
      }
    }
  }

  return parseClientIpCandidate(normalizeRemoteAddress(req.socket?.remoteAddress));
}

function timingSafeEqualString(left, right) {
  const digestLeft = crypto.createHash('sha256').update(String(left)).digest();
  const digestRight = crypto.createHash('sha256').update(String(right)).digest();
  return crypto.timingSafeEqual(digestLeft, digestRight);
}

function isAllowedWsOrigin(req, allowedWsOrigins, requireWsOrigin) {
  const originHeader = req.headers.origin;
  if (originHeader === undefined) {
    return !requireWsOrigin;
  }
  if (typeof originHeader !== 'string' || !originHeader.trim()) {
    return false;
  }
  let parsedOrigin;
  try {
    parsedOrigin = new URL(originHeader);
  } catch {
    return false;
  }
  if (parsedOrigin.protocol !== 'http:' && parsedOrigin.protocol !== 'https:') {
    return false;
  }
  if (Array.isArray(allowedWsOrigins) && allowedWsOrigins.length > 0) {
    return allowedWsOrigins.includes(parsedOrigin.origin);
  }
  const hostHeader = typeof req.headers.host === 'string' ? req.headers.host.trim().toLowerCase() : '';
  return Boolean(hostHeader) && parsedOrigin.host.toLowerCase() === hostHeader;
}

function createServer(options = {}) {
  const publicDir = path.resolve(options.publicDir || PUBLIC_DIR);
  const staticHandler = options.staticHandler || createStaticHandler(publicDir);

  const originBaseUrl = options.originBaseUrl
    ?? process.env.ORIGIN_BASE_URL
    ?? process.env.RPF_ORIGIN_BASE_URL
    ?? '';
  let parsedOriginBase = null;
  if (originBaseUrl) {
    try {
      parsedOriginBase = new URL(originBaseUrl);
    } catch {
      parsedOriginBase = null;
    }
  }

  const originTimeoutMs = Number(options.originTimeoutMs ?? process.env.ORIGIN_TIMEOUT_MS ?? 10000);
  const revisionWebhookSecret = options.revisionWebhookSecret
    ?? process.env.LISTINGS_REVISION_WEBHOOK_SECRET
    ?? process.env.RPF_LISTINGS_REVISION_WEBHOOK_SECRET
    ?? '';
  const trustProxy = Boolean(
    options.trustProxy ?? (process.env.TRUST_PROXY === 'true' || Boolean(process.env.KOYEB_SERVICE_ID)),
  );
  const originRelaySecret = String(
    options.originRelaySecret ?? process.env.ORIGIN_RELAY_SECRET ?? revisionWebhookSecret ?? '',
  ).trim();
  const wsMaxPayload = Number(options.wsMaxPayload ?? DEFAULT_WS_MAX_PAYLOAD);
  const maxWsClients = Number(options.maxWsClients ?? DEFAULT_MAX_WS_CLIENTS);
  const wsHeartbeatIntervalMs = Number(options.wsHeartbeatIntervalMs ?? DEFAULT_WS_HEARTBEAT_MS);
  const maxWsBufferedBytes = Number(options.maxWsBufferedBytes ?? DEFAULT_MAX_WS_BUFFERED_BYTES);
  const webhookMaxBytes = Number(options.webhookMaxBytes ?? DEFAULT_WEBHOOK_MAX_BYTES);
  const allowedWsOrigins = options.allowedWsOrigins ?? null;
  const requireWsOrigin = Boolean(options.requireWsOrigin);
  const snapshotCacheTtlMs = Number(
    options.snapshotCacheTtlMs ?? process.env.SNAPSHOT_CACHE_TTL_MS ?? DEFAULT_SNAPSHOT_CACHE_TTL_MS,
  );
  const snapshotStaleGraceMs = Number(
    options.snapshotStaleGraceMs ?? process.env.SNAPSHOT_STALE_GRACE_MS ?? DEFAULT_SNAPSHOT_STALE_GRACE_MS,
  );
  const revisionLocalTtlMs = Number(
    options.revisionLocalTtlMs ?? process.env.REVISION_LOCAL_TTL_MS ?? DEFAULT_REVISION_LOCAL_TTL_MS,
  );
  const snapshotCacheMaxBytes = Number(
    options.snapshotCacheMaxBytes ?? process.env.SNAPSHOT_CACHE_MAX_BYTES ?? DEFAULT_SNAPSHOT_CACHE_MAX_BYTES,
  );

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

  let currentListingsRevision = null;
  let currentListingsEpoch = null;
  let lastRevisionWebhookAtMs = 0;
  let cachedSnapshot = null;
  let inflightSnapshotFetch = null;
  const wsServer = new WebSocketServer({
    noServer: true,
    maxPayload: wsMaxPayload,
  });

  function originUrlFor(requestUrl) {
    if (!parsedOriginBase) return null;
    const target = new URL(`${requestUrl.pathname}${requestUrl.search}`, parsedOriginBase);
    if (target.origin !== parsedOriginBase.origin) {
      return null;
    }
    return target;
  }

  function buildOriginHeaders(req, target, baseHeaders) {
    const headers = { ...baseHeaders, host: target.host };
    delete headers['x-rpf-forwarded-for'];
    delete headers['x-rpf-relay-secret'];
    const remoteIp = extractRelayClientIp(req, trustProxy);
    if (remoteIp) {
      headers['x-rpf-forwarded-for'] = remoteIp;
    }
    if (originRelaySecret) {
      headers['x-rpf-relay-secret'] = originRelaySecret;
    }
    return headers;
  }

  function syncRevisionFromOriginRevisionResponse(rev, revEpoch) {
    const hasValidRev = Number.isSafeInteger(rev) && rev >= 0;
    if (revEpoch) {
      if (!currentListingsEpoch || revEpoch > currentListingsEpoch) {
        if (cachedSnapshot && cachedSnapshot.epoch !== revEpoch) {
          cachedSnapshot = null;
        }
        currentListingsEpoch = revEpoch;
        if (hasValidRev) {
          currentListingsRevision = rev;
        }
        return;
      }
      if (revEpoch === currentListingsEpoch) {
        if (hasValidRev && (currentListingsRevision === null || rev > currentListingsRevision)) {
          currentListingsRevision = rev;
        }
        return;
      }
      if (
        revEpoch !== currentListingsEpoch
        && hasValidRev
        && currentListingsRevision !== null
        && rev < currentListingsRevision
      ) {
        if (cachedSnapshot && cachedSnapshot.epoch !== revEpoch) {
          cachedSnapshot = null;
        }
        currentListingsEpoch = revEpoch;
        currentListingsRevision = rev;
      }
      return;
    }

    if (!currentListingsEpoch && hasValidRev) {
      if (currentListingsRevision === null || rev > currentListingsRevision) {
        currentListingsRevision = rev;
      }
    }
  }

  function relayHttp(req, res, requestUrl, relayOptions = {}) {
    const target = originUrlFor(requestUrl);
    if (!target) {
      sendOriginUnavailable(req, res);
      return;
    }

    const client = target.protocol === 'https:' ? https : http;
    const headers = buildOriginHeaders(req, target, stripHopByHopHeaders(req.headers));

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
        if (res.headersSent || res.destroyed) {
          originRes.destroy();
          return;
        }
        const responseHeaders = stripHopByHopHeaders(originRes.headers);
        res.writeHead(originRes.statusCode || 502, responseHeaders);

        if (relayOptions.observeListingsRevision && originRes.statusCode === 200) {
          const encoding = String(originRes.headers['content-encoding'] || '').trim().toLowerCase();
          const headerEpoch = normalizeRevisionEpoch(originRes.headers['x-rpf-revision-epoch']);
          const revChunks = [];
          let revBytes = 0;
          let overflow = false;
          originRes.on('data', (chunk) => {
            if (overflow) return;
            revBytes += chunk.length;
            if (revBytes > 4096) {
              overflow = true;
              return;
            }
            revChunks.push(chunk);
          });
          originRes.on('end', () => {
            if (overflow || revBytes === 0) return;
            const raw = Buffer.concat(revChunks, revBytes);
            const applyParsed = (plainBuf) => {
              try {
                const parsed = JSON.parse(plainBuf.toString('utf8'));
                const rev = Number(parsed?.revision);
                const revEpoch = normalizeRevisionEpoch(parsed?.revision_epoch ?? parsed?.epoch) ?? headerEpoch;
                syncRevisionFromOriginRevisionResponse(rev, revEpoch);
              } catch {
                // Ignore non-JSON payloads.
              }
            };
            if (encoding === 'gzip') {
              zlib.gunzip(raw, (err, plain) => {
                if (!err && plain) applyParsed(plain);
              });
            } else if (!encoding || encoding === 'identity') {
              applyParsed(raw);
            }
          });
        }

        originRes.on('error', () => {
          if (!res.destroyed) res.destroy();
        });
        originRes.pipe(res);
      },
    );

    const abortUpstream = () => {
      if (!res.writableEnded && !proxy.destroyed) {
        proxy.destroy();
      }
    };
    req.on('aborted', abortUpstream);
    res.on('close', abortUpstream);

    proxy.on('timeout', () => proxy.destroy(new Error('origin timeout')));
    proxy.on('error', () => {
      if (res.headersSent) {
        if (!res.destroyed) res.destroy();
        return;
      }
      if (!res.writableEnded && !res.destroyed) {
        sendOriginUnavailable(req, res);
      }
    });
    req.pipe(proxy);
  }

  function isSnapshotStaleAgainstCurrent(snapshot) {
    if (!snapshot) return true;
    if (currentListingsEpoch) {
      if (snapshot.epoch !== currentListingsEpoch) {
        return true;
      }
      return currentListingsRevision !== null
        && (snapshot.revision === null || currentListingsRevision > snapshot.revision);
    }
    return currentListingsRevision !== null
      && (snapshot.revision === null || currentListingsRevision > snapshot.revision);
  }

  function isSnapshotCacheFresh(snapshot, nowMs = Date.now()) {
    if (!snapshot) return false;
    if (isSnapshotStaleAgainstCurrent(snapshot)) {
      return false;
    }
    return (nowMs - snapshot.fetchedAtMs) < snapshotCacheTtlMs;
  }

  function canServeStaleSnapshot(snapshot, nowMs = Date.now()) {
    if (!snapshot) return false;
    if (!Number.isFinite(snapshotStaleGraceMs) || snapshotStaleGraceMs <= 0) return false;
    if (currentListingsEpoch && snapshot.epoch !== currentListingsEpoch) return false;
    return (nowMs - snapshot.fetchedAtMs) < (snapshotCacheTtlMs + snapshotStaleGraceMs);
  }

  function performOriginSnapshotFetch({
    req,
    target,
    revalidationEtag,
    previousSnapshot,
    startedForEpoch,
    startedForRevision,
  }) {
    return new Promise((resolve) => {
      let settled = false;
      let proxy = null;
      let activeOriginRes = null;

      const finish = (outcome) => {
        if (!settled) {
          settled = true;
          if (deadlineTimer) {
            clearTimeout(deadlineTimer);
          }
          resolve(outcome);
        }
      };

      const deadlineTimer = Number.isFinite(originTimeoutMs) && originTimeoutMs > 0
        ? setTimeout(() => {
          if (activeOriginRes && !activeOriginRes.destroyed) {
            activeOriginRes.destroy();
          }
          if (proxy && !proxy.destroyed) {
            proxy.destroy(new Error('origin snapshot deadline exceeded'));
          }
          finish({ kind: 'unavailable' });
        }, originTimeoutMs)
        : null;
      if (deadlineTimer && typeof deadlineTimer.unref === 'function') {
        deadlineTimer.unref();
      }

      const client = target.protocol === 'https:' ? https : http;
      const agent = target.protocol === 'https:' ? httpsAgent : httpAgent;
      const headers = buildOriginHeaders(req, target, {
        accept: 'application/json',
        'accept-encoding': 'gzip',
      });
      if (revalidationEtag) {
        headers['if-none-match'] = revalidationEtag;
      }

      try {
        proxy = client.request(
          target,
          {
            method: 'GET',
            headers,
            agent,
            timeout: originTimeoutMs,
          },
          (originRes) => {
            activeOriginRes = originRes;
            if (settled) {
              originRes.destroy();
              return;
            }

            if (originRes.statusCode === 304 && previousSnapshot) {
              originRes.on('error', () => finish({ kind: 'unavailable' }));
              originRes.on('aborted', () => finish({ kind: 'unavailable' }));
              originRes.on('close', () => {
                if (!settled && !originRes.complete) {
                  finish({ kind: 'unavailable' });
                }
              });
              originRes.on('end', () => {
                if (settled) return;
                previousSnapshot.fetchedAtMs = Date.now();
                cachedSnapshot = previousSnapshot;
                finish({ kind: 'cached', snapshot: cachedSnapshot });
              });
              originRes.resume();
              return;
            }

            const chunks = [];
            let totalBytes = 0;
            let exceededLimit = false;

            originRes.on('data', (chunk) => {
              if (settled || exceededLimit) return;
              totalBytes += chunk.length;
              if (totalBytes > snapshotCacheMaxBytes) {
                exceededLimit = true;
                originRes.destroy();
                proxy.destroy();
                finish({ kind: 'unavailable' });
                return;
              }
              chunks.push(chunk);
            });

            originRes.on('error', () => finish({ kind: 'unavailable' }));
            originRes.on('aborted', () => finish({ kind: 'unavailable' }));
            originRes.on('close', () => {
              if (!settled && !originRes.complete) {
                finish({ kind: 'unavailable' });
              }
            });

            originRes.on('end', async () => {
              if (settled || exceededLimit) return;
              const rawBody = Buffer.concat(chunks, totalBytes);
              const cleanedHeaders = stripHopByHopHeaders(originRes.headers);

              if (originRes.statusCode !== 200) {
                finish({
                  kind: 'passthrough',
                  statusCode: originRes.statusCode || 502,
                  headers: cleanedHeaders,
                  body: rawBody,
                });
                return;
              }

              const encoding = String(originRes.headers['content-encoding'] || '').trim().toLowerCase();
              let bodyPlain;
              let bodyGzip;
              try {
                if (encoding === 'gzip') {
                  bodyGzip = rawBody;
                  bodyPlain = await gunzipAsync(bodyGzip);
                  if (bodyPlain.length > snapshotCacheMaxBytes) {
                    finish({ kind: 'unavailable' });
                    return;
                  }
                } else if (!encoding || encoding === 'identity') {
                  bodyPlain = rawBody;
                  bodyGzip = await gzipAsync(bodyPlain, { level: 6 });
                } else {
                  finish({
                    kind: 'passthrough',
                    statusCode: 200,
                    headers: cleanedHeaders,
                    body: rawBody,
                  });
                  return;
                }
              } catch {
                finish({ kind: 'unavailable' });
                return;
              }

              if (settled) return;

              const metadata = extractSnapshotMetadata(bodyPlain);
              if (!metadata.validJson) {
                finish({
                  kind: 'passthrough',
                  statusCode: 200,
                  headers: cleanedHeaders,
                  body: rawBody,
                });
                return;
              }

              const parsedRevision = metadata.revision;
              const snapshotEpoch = metadata.revisionEpoch
                ?? normalizeRevisionEpoch(originRes.headers['x-rpf-revision-epoch']);

              const originEtag = typeof originRes.headers.etag === 'string'
                ? originRes.headers.etag.trim()
                : '';
              const { etagPlain, etagGzip } = deriveSnapshotEtags(originEtag, bodyPlain);
              const contentType = originRes.headers['content-type'] || 'application/json; charset=utf-8';

              const stateUnchangedDuringFetch = (
                currentListingsEpoch === startedForEpoch
                && currentListingsRevision === startedForRevision
              );
              const etagChanged = Boolean(
                !previousSnapshot
                || !previousSnapshot.originEtag
                || !originEtag
                || originEtag !== previousSnapshot.originEtag,
              );

              if (stateUnchangedDuringFetch) {
                if (snapshotEpoch) {
                  if (
                    !currentListingsEpoch
                    || snapshotEpoch > currentListingsEpoch
                    || (etagChanged && snapshotEpoch !== currentListingsEpoch)
                  ) {
                    currentListingsEpoch = snapshotEpoch;
                    if (parsedRevision !== null) {
                      currentListingsRevision = parsedRevision;
                    }
                  } else if (
                    snapshotEpoch === currentListingsEpoch
                    && parsedRevision !== null
                    && (currentListingsRevision === null || parsedRevision > currentListingsRevision)
                  ) {
                    currentListingsRevision = parsedRevision;
                  }
                } else if (parsedRevision !== null) {
                  if (currentListingsRevision === null) {
                    currentListingsRevision = parsedRevision;
                  } else if (!currentListingsEpoch) {
                    if (
                      parsedRevision > currentListingsRevision
                      || (etagChanged && parsedRevision < currentListingsRevision)
                    ) {
                      currentListingsRevision = parsedRevision;
                    }
                  }
                }
              }

              cachedSnapshot = {
                revision: parsedRevision,
                epoch: snapshotEpoch,
                originEtag: originEtag || null,
                etagPlain,
                etagGzip,
                bodyPlain,
                bodyGzip,
                contentType,
                fetchedAtMs: Date.now(),
              };
              finish({ kind: 'cached', snapshot: cachedSnapshot });
            });
          },
        );
      } catch {
        finish({ kind: 'unavailable' });
        return;
      }

      proxy.on('timeout', () => proxy.destroy(new Error('origin timeout')));
      proxy.on('error', () => finish({ kind: 'unavailable' }));
      proxy.on('close', () => {
        if (!activeOriginRes && !settled) {
          finish({ kind: 'unavailable' });
        }
      });
      proxy.end();
    });
  }

  async function getOrFetchSnapshot(req, target) {
    if (isSnapshotCacheFresh(cachedSnapshot)) {
      return { kind: 'cached', snapshot: cachedSnapshot };
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (isSnapshotCacheFresh(cachedSnapshot)) {
        return { kind: 'cached', snapshot: cachedSnapshot };
      }

      if (!inflightSnapshotFetch) {
        const startedForEpoch = currentListingsEpoch;
        const startedForRevision = currentListingsRevision;
        const previousSnapshot = cachedSnapshot;
        const canSendConditional = Boolean(
          previousSnapshot
          && previousSnapshot.originEtag
          && !isSnapshotStaleAgainstCurrent(previousSnapshot),
        );
        const revalidationEtag = canSendConditional ? previousSnapshot.originEtag : null;

        const promise = performOriginSnapshotFetch({
          req,
          target,
          revalidationEtag,
          previousSnapshot,
          startedForEpoch,
          startedForRevision,
        }).finally(() => {
          if (inflightSnapshotFetch && inflightSnapshotFetch.promise === promise) {
            inflightSnapshotFetch = null;
          }
        });

        inflightSnapshotFetch = { promise, startedForEpoch, startedForRevision };
      }

      const currentInflight = inflightSnapshotFetch;
      const outcome = await currentInflight.promise;
      if (outcome.kind !== 'cached') {
        if (
          (outcome.kind === 'unavailable' || (outcome.kind === 'passthrough' && outcome.statusCode >= 500))
          && canServeStaleSnapshot(cachedSnapshot)
        ) {
          return { kind: 'cached', snapshot: cachedSnapshot };
        }
        return outcome;
      }

      const hasNewerTarget = (
        currentListingsEpoch !== currentInflight.startedForEpoch
        || currentListingsRevision !== currentInflight.startedForRevision
      );
      if (hasNewerTarget && isSnapshotStaleAgainstCurrent(outcome.snapshot)) {
        continue;
      }

      return outcome;
    }

    return cachedSnapshot && !isSnapshotStaleAgainstCurrent(cachedSnapshot)
      ? { kind: 'cached', snapshot: cachedSnapshot }
      : (canServeStaleSnapshot(cachedSnapshot)
        ? { kind: 'cached', snapshot: cachedSnapshot }
        : { kind: 'unavailable' });
  }

  async function handleListingsSnapshot(req, res) {
    const target = originUrlFor({ pathname: '/api/listings/snapshot', search: '' });
    if (!target) {
      sendOriginUnavailable(req, res);
      return;
    }

    const outcome = await getOrFetchSnapshot(req, target);
    if (res.headersSent || res.destroyed || res.writableEnded) {
      return;
    }

    if (outcome.kind === 'unavailable') {
      sendOriginUnavailable(req, res);
      return;
    }

    if (outcome.kind === 'passthrough') {
      const headers = { ...outcome.headers };
      delete headers['content-length'];
      headers['Content-Length'] = outcome.body.length;
      res.writeHead(outcome.statusCode, headers);
      res.end(req.method === 'HEAD' ? undefined : outcome.body);
      return;
    }

    const { snapshot } = outcome;
    const wantsGzip = selectAcceptEncoding(req.headers['accept-encoding'], false, true) === 'gzip';
    const etag = wantsGzip ? snapshot.etagGzip : snapshot.etagPlain;

    if (etagMatches(req.headers['if-none-match'], etag)) {
      res.writeHead(304, {
        'Cache-Control': 'no-cache, max-age=0, must-revalidate',
        Vary: 'Accept-Encoding',
        ETag: etag,
      }).end();
      return;
    }

    const body = wantsGzip ? snapshot.bodyGzip : snapshot.bodyPlain;
    const headers = {
      'Content-Type': snapshot.contentType,
      'Cache-Control': 'no-cache, max-age=0, must-revalidate',
      Vary: 'Accept-Encoding',
      ETag: etag,
      'Content-Length': body.length,
    };
    if (wantsGzip) {
      headers['Content-Encoding'] = 'gzip';
    }

    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  function handleListingsRevision(req, res, requestUrl) {
    const now = Date.now();
    if (
      currentListingsRevision !== null
      && lastRevisionWebhookAtMs > 0
      && (now - lastRevisionWebhookAtMs) < revisionLocalTtlMs
    ) {
      const payload = { revision: currentListingsRevision };
      if (currentListingsEpoch) {
        payload.revision_epoch = currentListingsEpoch;
      }
      const body = Buffer.from(JSON.stringify(payload), 'utf8');
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': body.length,
      });
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }

    relayHttp(req, res, requestUrl, {
      observeListingsRevision: req.method === 'GET',
    });
  }

  function buildWsRevisionMessage(revision, revisionEpoch) {
    const payload = {
      type: 'listings_revision_changed',
      revision,
    };
    if (revisionEpoch) {
      payload.revision_epoch = revisionEpoch;
    }
    return JSON.stringify(payload);
  }

  function broadcastListingsRevision(revision, revisionEpoch = currentListingsEpoch) {
    const payload = buildWsRevisionMessage(revision, revisionEpoch);

    for (const client of wsServer.clients) {
      if (client.readyState !== WebSocket.OPEN || !client.rpfSubscribedToListings) {
        continue;
      }
      if (client.bufferedAmount > maxWsBufferedBytes) {
        client.terminate();
        continue;
      }
      client.send(payload);
    }
  }

  function handleListingsWebSocket(socket) {
    socket.rpfSubscribedToListings = false;
    socket.rpfIsAlive = true;

    socket.on('pong', () => {
      socket.rpfIsAlive = true;
    });

    socket.on('error', () => {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CLOSING) {
        socket.terminate();
      }
    });

    socket.on('message', (data) => {
      let message;
      try {
        message = JSON.parse(data.toString('utf8'));
      } catch {
        return;
      }

      if (message?.type !== 'subscribe' || message.channel !== 'listing_changes') return;

      if (socket.bufferedAmount > maxWsBufferedBytes) {
        socket.terminate();
        return;
      }

      socket.rpfSubscribedToListings = true;
      socket.send(JSON.stringify({ type: 'subscribed', channel: 'listing_changes' }));
      if (currentListingsRevision !== null && (currentListingsRevision > 0 || currentListingsEpoch)) {
        socket.send(buildWsRevisionMessage(currentListingsRevision, currentListingsEpoch));
      }
    });
  }

  function readJsonBody(req, maxBytes = webhookMaxBytes) {
    return new Promise((resolve, reject) => {
      let total = 0;
      let settled = false;
      const chunks = [];

      const cleanup = () => {
        req.off('data', onData);
        req.off('end', onEnd);
        req.off('error', onError);
      };

      const onData = (chunk) => {
        if (settled) return;
        total += chunk.length;
        if (total > maxBytes) {
          settled = true;
          cleanup();
          req.pause();
          const error = new Error('request body too large');
          error.statusCode = 413;
          reject(error);
          return;
        }
        chunks.push(chunk);
      };

      const onEnd = () => {
        if (settled) return;
        settled = true;
        cleanup();
        if (chunks.length === 0) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          const error = new Error('invalid json');
          error.statusCode = 400;
          reject(error);
        }
      };

      const onError = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      req.on('data', onData);
      req.on('end', onEnd);
      req.on('error', onError);
    });
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

    const expectedAuth = `Bearer ${revisionWebhookSecret}`;
    const providedAuth = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
    if (!timingSafeEqualString(providedAuth, expectedAuth)) {
      res.writeHead(403).end('forbidden');
      return;
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      if (res.headersSent || res.destroyed || res.writableEnded) {
        return;
      }
      const status = error.statusCode || 400;
      if (status === 413) {
        res.writeHead(413, { Connection: 'close' }).end('payload too large', () => {
          if (!req.destroyed) req.destroy();
        });
        return;
      }
      res.writeHead(status).end('bad request');
      return;
    }

    if (res.headersSent || res.destroyed || res.writableEnded) {
      return;
    }

    const revision = Number(body?.revision);
    if (!Number.isSafeInteger(revision) || revision < 0) {
      res.writeHead(400).end('invalid revision');
      return;
    }

    const epoch = normalizeRevisionEpoch(body?.revision_epoch ?? body?.epoch)
      ?? normalizeRevisionEpoch(req.headers['x-rpf-revision-epoch']);

    const isNewerEpoch = Boolean(epoch && (!currentListingsEpoch || epoch > currentListingsEpoch));
    const isSameEpochAdvance = Boolean(
      epoch
      && currentListingsEpoch
      && epoch === currentListingsEpoch
      && (currentListingsRevision === null || revision > currentListingsRevision),
    );
    const isLegacyAdvance = Boolean(
      !epoch
      && !currentListingsEpoch
      && (currentListingsRevision === null || revision > currentListingsRevision),
    );
    const applied = isNewerEpoch || isSameEpochAdvance || isLegacyAdvance;

    if (applied) {
      lastRevisionWebhookAtMs = Date.now();
      if (isNewerEpoch) {
        if (cachedSnapshot && cachedSnapshot.epoch !== epoch) {
          cachedSnapshot = null;
        }
        currentListingsEpoch = epoch;
      }
      currentListingsRevision = revision;
      broadcastListingsRevision(revision, currentListingsEpoch);
    }

    const responsePayload = { ok: true, revision: currentListingsRevision, applied };
    if (currentListingsEpoch) {
      responsePayload.revision_epoch = currentListingsEpoch;
    }

    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(responsePayload));
  }

  wsServer.on('connection', handleListingsWebSocket);

  const heartbeatTimer = wsHeartbeatIntervalMs > 0
    ? setInterval(() => {
      for (const client of wsServer.clients) {
        if (client.rpfIsAlive === false) {
          client.terminate();
          continue;
        }
        client.rpfIsAlive = false;
        client.ping();
      }
    }, wsHeartbeatIntervalMs)
    : null;
  if (heartbeatTimer && typeof heartbeatTimer.unref === 'function') {
    heartbeatTimer.unref();
  }

  const server = http.createServer(async (req, res) => {
    try {
      applySecurityHeaders(res);

      const requestUrl = parseRequestUrl(req);
      if (!requestUrl) {
        if (!res.headersSent && !res.writableEnded && !res.destroyed) {
          res.writeHead(400, { Connection: 'close' }).end('bad request');
        }
        return;
      }

      const { pathname } = requestUrl;

      if (req.headers.upgrade || pathname === '/api/ws') {
        if (!res.headersSent && !res.writableEnded && !res.destroyed) {
          res.writeHead(426, {
            Connection: 'close',
            Upgrade: 'websocket',
          }).end('upgrade required');
        }
        return;
      }

      if (pathname === '/internal/listings/revision') {
        await handleRevisionWebhook(req, res);
        return;
      }

      if (pathname === '/') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          if (!res.headersSent && !res.writableEnded && !res.destroyed) {
            res.writeHead(405, { Allow: 'GET, HEAD' }).end('method not allowed');
          }
          return;
        }
        if (!res.headersSent && !res.writableEnded && !res.destroyed) {
          res.writeHead(302, {
            Location: `/listings${requestUrl.search}`,
            'Cache-Control': 'no-cache',
          }).end();
        }
        return;
      }

      if (pathname === '/contribute' || pathname.startsWith('/contribute/')) {
        if (!res.headersSent && !res.writableEnded && !res.destroyed) {
          res.writeHead(404).end('not found');
        }
        return;
      }

      if (pathname === '/api/listings/revision' && (req.method === 'GET' || req.method === 'HEAD')) {
        handleListingsRevision(req, res, requestUrl);
        return;
      }

      if (pathname === '/api/listings/snapshot' && (req.method === 'GET' || req.method === 'HEAD')) {
        await handleListingsSnapshot(req, res);
        return;
      }

      if (isRelayPath(pathname)) {
        relayHttp(req, res, requestUrl);
        return;
      }

      staticHandler.handleStatic(req, res, requestUrl);
    } catch (error) {
      console.error('unhandled request error:', error && error.stack ? error.stack : String(error));
      if (!res.headersSent && !res.writableEnded && !res.destroyed) {
        try {
          res.writeHead(500, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store',
          }).end('internal server error');
          return;
        } catch {
          // Fall through to destroy.
        }
      }
      if (!res.destroyed) {
        res.destroy();
      }
    }
  });

  server.headersTimeout = Number(options.headersTimeout ?? process.env.SERVER_HEADERS_TIMEOUT_MS ?? 15000);
  server.requestTimeout = Number(options.requestTimeout ?? process.env.SERVER_REQUEST_TIMEOUT_MS ?? 30000);
  server.keepAliveTimeout = Number(options.keepAliveTimeout ?? process.env.SERVER_KEEP_ALIVE_TIMEOUT_MS ?? 5000);

  server.on('upgrade', (req, socket, head) => {
    const requestUrl = parseRequestUrl(req);
    if (!requestUrl) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket') {
      socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nUpgrade: websocket\r\n\r\n');
      socket.destroy();
      return;
    }

    if (requestUrl.pathname !== '/api/ws') {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    if (!isAllowedWsOrigin(req, allowedWsOrigins, requireWsOrigin)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    if (wsServer.clients.size >= maxWsClients) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    wsServer.handleUpgrade(req, socket, head, (client) => {
      wsServer.emit('connection', client, req);
    });
  });

  server.on('close', () => {
    cachedSnapshot = null;
    inflightSnapshotFetch = null;
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
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

if (require.main === module) {
  const server = createServer();
  let shuttingDown = false;

  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`received ${signal}, shutting down`);
    const forceTimer = setTimeout(() => {
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      process.exit(0);
    }, 5000);
    forceTimer.unref();

    server.close(() => {
      clearTimeout(forceTimer);
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  server.listen(PORT, () => {
    console.log(`web edge listening on :${PORT}`);
  });
}

module.exports = {
  applySecurityHeaders,
  createServer,
  extractSnapshotMetadata,
  isAllowedWsOrigin,
  isRelayPath,
  isValidRequestTarget,
  normalizeRevisionEpoch,
  SERVICE_UNAVAILABLE,
  pickLanguage,
  stripHopByHopHeaders,
  timingSafeEqualString,
};
