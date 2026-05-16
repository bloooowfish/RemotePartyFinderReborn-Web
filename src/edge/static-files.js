const fs = require('node:fs');
const path = require('node:path');

const { LOCALIZED_HTML_VARY, localizeHtml } = require('./localization');

const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
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

  const filePath = path.normalize(path.join(publicDir, decoded));
  const relativePath = path.relative(publicDir, filePath);
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

function serveStatic(req, res, requestUrl, publicDir) {
  const { pathname } = requestUrl;
  const filePath = staticPath(publicDir, pathname);
  if (!filePath) {
    res.writeHead(404).end('not found');
    return;
  }

  fs.stat(filePath, (statError, stat) => {
    if (statError || !stat.isFile()) {
      res.writeHead(404).end('not found');
      return;
    }

    const extension = path.extname(filePath);
    const headers = {
      'Content-Type': CONTENT_TYPES[extension] || 'application/octet-stream',
      'Cache-Control': staticCacheControl(requestUrl),
    };

    if (extension === '.html') {
      headers.Vary = LOCALIZED_HTML_VARY;
      fs.readFile(filePath, 'utf8', (readError, body) => {
        if (readError) {
          res.writeHead(500).end('server error');
          return;
        }

        res.writeHead(200, headers);
        res.end(localizeHtml(req, body));
      });
      return;
    }

    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  });
}

module.exports = {
  serveStatic,
  staticCacheControl,
  staticPath,
};
