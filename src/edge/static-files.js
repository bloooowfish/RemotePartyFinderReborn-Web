const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream');
const zlib = require('node:zlib');

const {
  LOCALIZED_HTML_VARY,
  SUPPORTED_LANGUAGES,
  localizeHtmlForLanguage,
  pickLanguage,
} = require('./localization');

const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function staticPath(publicDir, pathname) {
  if (pathname === '/') return path.join(publicDir, 'index.html');
  if (pathname === '/listings') return path.join(publicDir, 'listings.html');
  if (pathname === '/stats' || pathname === '/stats/7days') {
    return path.join(publicDir, 'stats.html');
  }

  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  if (decoded.includes('\0') || decoded.includes('\\')) {
    return null;
  }
  if (decoded.endsWith('.br') || decoded.endsWith('.gz')) {
    return null;
  }

  const resolvedPublicDir = path.resolve(publicDir);
  const filePath = path.normalize(path.join(resolvedPublicDir, decoded));
  const relativePath = path.relative(resolvedPublicDir, filePath);
  if (
    relativePath === '..'
    || relativePath.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativePath)
  ) {
    return null;
  }

  return filePath;
}

function staticCacheControl(requestUrl) {
  if (!requestUrl.pathname.startsWith('/assets/')) {
    return 'no-cache';
  }

  return requestUrl.searchParams.has('v')
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';
}

function selectAcceptEncoding(acceptEncodingHeader, hasBr, hasGz) {
  if (!acceptEncodingHeader || (!hasBr && !hasGz)) {
    return null;
  }

  const header = String(acceptEncodingHeader).toLowerCase();
  const qValues = new Map();
  let wildcardQ = null;

  for (const part of header.split(',')) {
    const tokens = part.trim().split(';');
    const coding = tokens[0].trim();
    if (!coding) continue;
    let q = 1;
    for (let i = 1; i < tokens.length; i += 1) {
      const param = tokens[i].trim();
      if (param.startsWith('q=')) {
        const parsed = Number.parseFloat(param.slice(2));
        if (!Number.isNaN(parsed)) q = Math.max(0, Math.min(1, parsed));
      }
    }
    if (coding === '*') {
      wildcardQ = q;
    } else if (!qValues.has(coding) || q > qValues.get(coding)) {
      qValues.set(coding, q);
    }
  }

  const brQ = hasBr ? (qValues.has('br') ? qValues.get('br') : (wildcardQ ?? 0)) : 0;
  const gzQ = hasGz ? (qValues.has('gzip') ? qValues.get('gzip') : (wildcardQ ?? 0)) : 0;

  if (brQ <= 0 && gzQ <= 0) return null;
  return brQ >= gzQ ? 'br' : 'gzip';
}

function etagMatches(ifNoneMatchHeader, etag) {
  if (!ifNoneMatchHeader || !etag) return false;
  const raw = String(ifNoneMatchHeader).trim();
  if (raw === '*') return true;
  const normalize = (value) => value.trim().replace(/^W\//i, '');
  const expected = normalize(etag);
  return raw.split(',').some((candidate) => normalize(candidate) === expected);
}

function hashBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);
}

function createStaticHandler(publicDir) {
  const resolvedPublicDir = path.resolve(publicDir);
  const assetVersions = new Map();
  const assetIndex = new Map();
  const htmlCache = new Map();

  if (fs.existsSync(resolvedPublicDir)) {
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
          continue;
        }
        if (!entry.isFile()) continue;
        if (entry.name.endsWith('.br') || entry.name.endsWith('.gz')) continue;

        const ext = path.extname(entry.name).toLowerCase();
        if (ext === '.html') continue;

        const relWebPath = '/' + path.relative(resolvedPublicDir, fullPath).split(path.sep).join('/');
        const raw = fs.readFileSync(fullPath);
        const hash = hashBuffer(raw);
        if (relWebPath.startsWith('/assets/')) {
          assetVersions.set(relWebPath, hash);
        }

        const brPath = `${fullPath}.br`;
        const gzPath = `${fullPath}.gz`;
        const hasBr = fs.existsSync(brPath);
        const hasGz = fs.existsSync(gzPath);
        assetIndex.set(fullPath, {
          hash,
          size: raw.length,
          brPath: hasBr ? brPath : null,
          brSize: hasBr ? fs.statSync(brPath).size : 0,
          gzPath: hasGz ? gzPath : null,
          gzSize: hasGz ? fs.statSync(gzPath).size : 0,
        });
      }
    };

    walk(resolvedPublicDir);

    for (const entry of fs.readdirSync(resolvedPublicDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.html')) continue;
      const fullPath = path.join(resolvedPublicDir, entry.name);
      const sourceHtml = fs.readFileSync(fullPath, 'utf8');
      const perLang = new Map();

      for (const lang of SUPPORTED_LANGUAGES) {
        const localized = localizeHtmlForLanguage(lang, sourceHtml, assetVersions);
        const raw = Buffer.from(localized, 'utf8');
        const br = zlib.brotliCompressSync(raw, {
          params: {
            [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
            [zlib.constants.BROTLI_PARAM_QUALITY]: 9,
          },
        });
        const gz = zlib.gzipSync(raw, { level: 9 });
        const hash = hashBuffer(raw);
        perLang.set(lang, {
          raw,
          br,
          gz,
          etagRaw: `"${hash}"`,
          etagBr: `"${hash}-br"`,
          etagGz: `"${hash}-gz"`,
        });
      }

      htmlCache.set(fullPath, perLang);
    }
  }

  function handleStatic(req, res, requestUrl) {
    const { pathname } = requestUrl;
    const filePath = staticPath(resolvedPublicDir, pathname);
    if (!filePath) {
      res.writeHead(404).end('not found');
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end('method not allowed');
      return;
    }

    const localizedEntry = htmlCache.get(filePath);
    if (localizedEntry) {
      const lang = pickLanguage(req);
      const bundle = localizedEntry.get(lang) || localizedEntry.get('en');
      const encoding = selectAcceptEncoding(req.headers['accept-encoding'], true, true);
      const payload = encoding === 'br'
        ? bundle.br
        : encoding === 'gzip'
          ? bundle.gz
          : bundle.raw;
      const etag = encoding === 'br'
        ? bundle.etagBr
        : encoding === 'gzip'
          ? bundle.etagGz
          : bundle.etagRaw;

      const headers = {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
        ETag: etag,
        Vary: `${LOCALIZED_HTML_VARY}, Accept-Encoding`,
      };
      if (encoding) {
        headers['Content-Encoding'] = encoding;
      }

      if (etagMatches(req.headers['if-none-match'], etag)) {
        res.writeHead(304, headers).end();
        return;
      }

      headers['Content-Length'] = payload.length;
      res.writeHead(200, headers);
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      res.end(payload);
      return;
    }

    const indexed = assetIndex.get(filePath);
    if (indexed) {
      const encoding = selectAcceptEncoding(
        req.headers['accept-encoding'],
        Boolean(indexed.brPath),
        Boolean(indexed.gzPath),
      );
      const chosenPath = encoding === 'br'
        ? indexed.brPath
        : encoding === 'gzip'
          ? indexed.gzPath
          : filePath;
      const chosenSize = encoding === 'br'
        ? indexed.brSize
        : encoding === 'gzip'
          ? indexed.gzSize
          : indexed.size;
      const etag = `"${indexed.hash}-${encoding || 'raw'}"`;
      const extension = path.extname(filePath).toLowerCase();

      const headers = {
        'Content-Type': CONTENT_TYPES[extension] || 'application/octet-stream',
        'Cache-Control': staticCacheControl(requestUrl),
        ETag: etag,
      };
      if (indexed.brPath || indexed.gzPath) {
        headers.Vary = 'Accept-Encoding';
      }
      if (encoding) {
        headers['Content-Encoding'] = encoding;
      }

      if (etagMatches(req.headers['if-none-match'], etag)) {
        res.writeHead(304, headers).end();
        return;
      }

      headers['Content-Length'] = chosenSize;
      res.writeHead(200, headers);
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      pipeline(fs.createReadStream(chosenPath), res, (err) => {
        if (err && !res.destroyed && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
          res.destroy(err);
        }
      });
      return;
    }

    // Fallback for uncached files added dynamically (e.g. in tests).
    fs.stat(filePath, (statError, stat) => {
      if (statError || !stat.isFile()) {
        res.writeHead(404).end('not found');
        return;
      }

      const extension = path.extname(filePath).toLowerCase();
      const etag = `W/"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`;
      const headers = {
        'Content-Type': CONTENT_TYPES[extension] || 'application/octet-stream',
        'Cache-Control': staticCacheControl(requestUrl),
        ETag: etag,
      };

      if (extension === '.html') {
        headers.Vary = LOCALIZED_HTML_VARY;
        fs.readFile(filePath, 'utf8', (readError, body) => {
          if (readError) {
            res.writeHead(500).end('server error');
            return;
          }
          const localized = Buffer.from(localizeHtmlForLanguage(pickLanguage(req), body, assetVersions), 'utf8');
          if (etagMatches(req.headers['if-none-match'], etag)) {
            res.writeHead(304, headers).end();
            return;
          }
          headers['Content-Length'] = localized.length;
          res.writeHead(200, headers);
          res.end(req.method === 'HEAD' ? undefined : localized);
        });
        return;
      }

      if (etagMatches(req.headers['if-none-match'], etag)) {
        res.writeHead(304, headers).end();
        return;
      }

      headers['Content-Length'] = stat.size;
      res.writeHead(200, headers);
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      pipeline(fs.createReadStream(filePath), res, (err) => {
        if (err && !res.destroyed && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
          res.destroy(err);
        }
      });
    });
  }

  return {
    assetVersions,
    handleStatic,
  };
}

const defaultHandlers = new Map();

function serveStatic(req, res, requestUrl, publicDir) {
  const key = path.resolve(publicDir);
  let handler = defaultHandlers.get(key);
  if (!handler) {
    handler = createStaticHandler(key);
    defaultHandlers.set(key, handler);
  }
  return handler.handleStatic(req, res, requestUrl);
}

module.exports = {
  createStaticHandler,
  etagMatches,
  selectAcceptEncoding,
  serveStatic,
  staticCacheControl,
  staticPath,
};
