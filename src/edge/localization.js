const LOCALIZED_HTML_VARY = 'Accept-Language, Cookie';

const SUPPORTED_LANGUAGES = ['en', 'ja', 'de', 'fr'];

const SERVICE_UNAVAILABLE = {
  en: 'The Remote Party Finder Reborn server is temporarily unavailable. Please try again later.',
  ja: 'Remote Party Finder Reborn サーバーは一時的に利用できません。しばらくしてからもう一度お試しください。',
  de: 'Der Remote-Party-Finder-Reborn-Server ist vorübergehend nicht verfügbar. Bitte versuche es später erneut.',
  fr: 'Le serveur Remote Party Finder Reborn est temporairement indisponible. Veuillez réessayer plus tard.',
};

const LANGUAGE_NAMES = {
  en: 'English',
  ja: '日本語',
  de: 'Deutsch',
  fr: 'Français',
};

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function supportedLanguage(lang) {
  return SERVICE_UNAVAILABLE[lang] ? lang : null;
}

function cookieLanguage(cookieHeader) {
  const cookie = String(cookieHeader || '');
  const match = cookie.match(/(?:^|;\s*)lang=([^;]*)/);
  if (!match) return null;

  return supportedLanguage(safeDecodeURIComponent(match[1]));
}

function acceptedLanguage(acceptLanguageHeader) {
  return String(acceptLanguageHeader || '')
    .split(',')
    .map((part, index) => {
      const [range, ...params] = part.trim().split(';');
      const tag = range.trim().toLowerCase();
      if (!tag || tag === '*') return null;

      let q = 1;
      for (const param of params) {
        const [key, value] = param.split('=').map((entry) => entry.trim());
        if (key.toLowerCase() !== 'q') continue;

        const parsed = Number(value);
        q = Number.isFinite(parsed) ? parsed : 0;
      }

      const lang = supportedLanguage(tag.split('-')[0]);
      if (!lang || q <= 0) return null;
      return { lang, q, index };
    })
    .filter(Boolean)
    .sort((a, b) => b.q - a.q || a.index - b.index)[0]?.lang || null;
}

function pickLanguage(req) {
  return cookieLanguage(req.headers.cookie)
    || acceptedLanguage(req.headers['accept-language'])
    || 'en';
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sendOriginUnavailable(req, res, options = {}) {
  const message = SERVICE_UNAVAILABLE[pickLanguage(req)] || SERVICE_UNAVAILABLE.en;
  const acceptsHtml = options.html || String(req.headers.accept || '').includes('text/html');

  res.statusCode = 503;
  res.setHeader('Cache-Control', 'no-store');
  if (acceptsHtml) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Vary', LOCALIZED_HTML_VARY);
    res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Service unavailable</title></head><body><main><p>${escapeHtml(message)}</p></main></body></html>`);
  } else {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(message);
  }
}

function localizeHtmlForLanguage(lang, html, assetVersions = null) {
  const safeLang = LANGUAGE_NAMES[lang] ? lang : 'en';
  const name = LANGUAGE_NAMES[safeLang];

  let localized = html
    .replace(/<html lang="[^"]*"/, `<html lang="${safeLang}"`)
    .replace(/id="language" data-accept="[^"]*"/, `id="language" data-accept="${safeLang}"`)
    .replace(
      /(<a\b[^>]*aria-haspopup="listbox"[^>]*>)[^<]*(<\/a>\s*<ul role="listbox" aria-haspopup="listbox" id="language")/,
      `$1${name}$2`,
    )
    .replace(
      /\/assets\/listing-data(?:\.(?:en|ja|de|fr))?\.js(?:\?v=[^"'#\s]+)?/g,
      `/assets/listing-data.${safeLang}.js`,
    );

  if (assetVersions && assetVersions.size > 0) {
    localized = localized.replace(
      /\b(src|href)="(\/assets\/[^"?#]+)(?:\?v=[^"#]*)?(#[^"]*)?"/g,
      (full, attr, pathname, fragment = '') => {
        const version = assetVersions.get(pathname);
        if (!version) return full;
        return `${attr}="${pathname}?v=${version}${fragment}"`;
      },
    );
  }

  return localized;
}

function localizeHtml(req, html, assetVersions = null) {
  return localizeHtmlForLanguage(pickLanguage(req), html, assetVersions);
}

module.exports = {
  LANGUAGE_NAMES,
  LOCALIZED_HTML_VARY,
  SERVICE_UNAVAILABLE,
  SUPPORTED_LANGUAGES,
  escapeHtml,
  localizeHtml,
  localizeHtmlForLanguage,
  pickLanguage,
  sendOriginUnavailable,
};
