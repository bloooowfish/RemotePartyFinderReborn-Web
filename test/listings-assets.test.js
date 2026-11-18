const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const zlib = require('node:zlib');

const { buildListings } = require('../scripts/build-listings');
const { localizeHtmlForLanguage, SUPPORTED_LANGUAGES } = require('../src/edge/localization');
const { createStaticHandler } = require('../src/edge/static-files');

const root = path.join(__dirname, '..');
const buildListingsScriptPath = path.join(root, 'scripts', 'build-listings.js');
const listingsSourcePath = path.join(root, 'src', 'client', 'listings', 'main.js');
const listingsScriptPath = path.join(root, 'public', 'assets', 'listings.js');
const statsScriptPath = path.join(root, 'public', 'assets', 'stats.js');
const statsEdgeScriptPath = path.join(root, 'public', 'assets', 'stats-edge.js');

function loadListingsHelpers() {
  delete require.cache[require.resolve(listingsSourcePath)];
  return require(listingsSourcePath).__test__;
}

function loadStatsHelpers() {
  delete require.cache[require.resolve(statsScriptPath)];
  return require(statsScriptPath).__test__;
}

function loadStatsEdgeHelpers() {
  delete require.cache[require.resolve(statsEdgeScriptPath)];
  return require(statsEdgeScriptPath).__test__;
}

async function withStatsEdgeBrowser(response, callback, options = {}) {
  const originalWindow = global.window;
  const originalDocument = global.document;
  const originalFetch = global.fetch;
  const elements = new Map();
  const tableBodies = new Map();
  const scripts = [];

  function getElement(id) {
    if (!elements.has(id)) {
      elements.set(id, {
        dataset: id === 'language' ? { accept: 'en' } : {},
        style: { display: 'none' },
        textContent: '',
        innerHTML: '',
      });
    }
    return elements.get(id);
  }

  global.window = {
    location: { pathname: options.pathname || '/stats' },
    console: { debug() {} },
  };
  global.document = {
    cookie: options.cookie || '',
    documentElement: {
      classList: {
        add() {},
        remove() {},
      },
    },
    body: {
      appendChild(script) {
        scripts.push(script);
        if (options.autoLoadScripts) {
          queueMicrotask(() => script.onload?.());
        }
      },
    },
    createElement(tagName) {
      assert.equal(tagName, 'script');
      return {};
    },
    getElementById: getElement,
    querySelector(selector) {
      if (!tableBodies.has(selector)) {
        tableBodies.set(selector, { innerHTML: '' });
      }
      return tableBodies.get(selector);
    },
  };
  global.fetch = async () => response;

  try {
    return await callback({ elements, scripts, tableBodies });
  } finally {
    if (originalWindow === undefined) {
      delete global.window;
    } else {
      global.window = originalWindow;
    }

    if (originalDocument === undefined) {
      delete global.document;
    } else {
      global.document = originalDocument;
    }

    if (originalFetch === undefined) {
      delete global.fetch;
    } else {
      global.fetch = originalFetch;
    }
  }
}

test('listings page loads the current unversioned assets and edge localization stamps per-language hashes', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'listings.html'), 'utf8');

  const orderedAssets = [
    '/assets/listings.css',
    '/assets/translations.js',
    '/assets/listing-data.en.js',
    '/assets/listings.js',
  ];
  let previousIndex = -1;
  for (const asset of orderedAssets) {
    const index = html.indexOf(asset);
    assert.notEqual(index, -1, `${asset} should be present`);
    assert.ok(index > previousIndex, `${asset} should load after the previous listings asset`);
    previousIndex = index;
  }

  assert.doesNotMatch(html, /\/assets\/listings-utils\.js/);
  assert.doesNotMatch(html, /\/assets\/listings-filters\.js/);
  assert.doesNotMatch(html, /\/assets\/listings-render\.js/);
  assert.doesNotMatch(html, /d3\.v7\.min\.js|pico\.min\.css|list\.min\.js/);
  assert.match(html, /<main\b/);
  assert.match(html, /<h1\b[^>]*data-i18n="listings_heading"/);
  assert.match(html, /id="advanced-filters-panel"/);
  assert.match(html, /id="advanced-filters-toggle"/);
  assert.match(html, /id="active-filters-badge"/);
  assert.match(html, /id="reset-filters-btn"/);
  assert.match(html, /id="content-select-search"/);
  assert.match(html, /class="role-group-toggle"/);

  for (const unusedAsset of ['d3.v7.min.js', 'pico.min.css', 'list.min.js']) {
    assert.equal(fs.existsSync(path.join(root, 'public', 'assets', unusedAsset)), false, `${unusedAsset} should be removed`);
  }

  const staticHandler = createStaticHandler(path.join(root, 'public'));
  const localizedJa = localizeHtmlForLanguage('ja', html, staticHandler.assetVersions);
  assert.match(localizedJa, /\/assets\/listing-data\.ja\.js\?v=[a-f0-9]+/);
  assert.match(localizedJa, /\/assets\/listings\.css\?v=[a-f0-9]+/);
  assert.match(localizedJa, /\/assets\/listings\.js\?v=[a-f0-9]+/);
  assert.doesNotMatch(localizedJa, /listing-data\.en\.js/);

  const manifestMatch = localizedJa.match(/<meta name="rpf-assets" content="([^"]+)"/);
  assert.ok(manifestMatch, 'localized HTML should expose versioned asset manifest metadata');
  const manifest = JSON.parse(
    manifestMatch[1]
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&'),
  );
  assert.match(manifest['/assets/job-icons.svg'], /^\/assets\/job-icons\.svg\?v=[a-f0-9]+$/);
  assert.match(manifest['/assets/role-icons.svg'], /^\/assets\/role-icons\.svg\?v=[a-f0-9]+$/);
  assert.match(manifest['/assets/icons.svg'], /^\/assets\/icons\.svg\?v=[a-f0-9]+$/);
  assert.match(manifest['/assets/d3.js'], /^\/assets\/d3\.js\?v=[a-f0-9]+$/);
  assert.match(manifest['/assets/stats.js'], /^\/assets\/stats\.js\?v=[a-f0-9]+$/);
});

test('listings bundle is generated by the esbuild script', () => {
  const script = fs.readFileSync(buildListingsScriptPath, 'utf8');

  assert.match(script, /src\/client\/listings\/main\.js/);
  assert.match(script, /public\/assets\/listings\.js/);
  assert.match(script, /bundle:\s*true/);
  assert.match(script, /minify:\s*true/);
  assert.match(script, /define:\s*\{\s*__RPF_BROWSER_BUNDLE__:\s*'true'\s*\}/);
});

test('npm test runs deterministic build checks and produces matching minified + precompressed assets', async () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const testScript = packageJson.scripts.test;

  const buildIndex = testScript.indexOf('npm run build');
  const testIndex = testScript.indexOf('node --test');
  assert.notEqual(buildIndex, -1);
  assert.ok(testIndex > buildIndex);
  assert.doesNotMatch(testScript, /git diff --exit-code/);

  const result = await buildListings({ write: false, precompress: false });
  const rebuiltText = result.outputFiles[0].text;
  const committedText = fs.readFileSync(listingsScriptPath, 'utf8');
  assert.equal(rebuiltText, committedText, 'public/assets/listings.js should match deterministic esbuild output');

  for (const relPath of [
    'listings.html',
    'stats.html',
    'assets/listings.css',
    'assets/listings.js',
    'assets/listing-data.en.js',
    'assets/listing-data.ja.js',
    'assets/listing-data.de.js',
    'assets/listing-data.fr.js',
  ]) {
    const fullPath = path.join(root, 'public', relPath);
    const raw = fs.readFileSync(fullPath);
    const br = fs.readFileSync(`${fullPath}.br`);
    const gz = fs.readFileSync(`${fullPath}.gz`);
    assert.deepEqual(zlib.brotliDecompressSync(br), raw, `${relPath}.br should match raw file`);
    assert.deepEqual(zlib.gunzipSync(gz), raw, `${relPath}.gz should match raw file`);
  }
});

test('listings bundle includes helper modules and reaches initialization', async () => {
  const script = fs.readFileSync(listingsScriptPath, 'utf8');
  assert.doesNotMatch(script, /RPF_LISTINGS_/);

  const bootstrapStatus = {
    dataset: {},
    textContent: '',
    style: { display: 'none' },
  };
  const timers = [];
  const intervals = [];
  const container = {
    classList: {
      toggle() {},
    },
  };

  let wsSocketInstance = null;
  const fetchCalls = [];
  class MockWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 1;
      this.listeners = new Map();
      wsSocketInstance = this;
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    send() {}
    close() {
      this.readyState = 3;
    }
  }
  MockWebSocket.OPEN = 1;
  const context = {
    console: { debug() {} },
    fetch: async (url) => {
      fetchCalls.push(url);
      return { ok: false, status: 500 };
    },
    WebSocket: MockWebSocket,
    localStorage: {
      getItem() { return null; },
      setItem() {},
    },
    setInterval(callback, delay) {
      const interval = { callback, delay };
      intervals.push(interval);
      return interval;
    },
    window: {
      WebSocket: MockWebSocket,
      addEventListener() {},
      clearTimeout(timer) {
        if (timer) timer.cleared = true;
      },
      location: { host: 'example.test', protocol: 'https:' },
      setTimeout(callback, delay) {
        const timer = { callback, delay, cleared: false };
        timers.push(timer);
        return timer;
      },
    },
    document: {
      cookie: '',
      readyState: 'complete',
      visibilityState: 'visible',
      documentElement: {
        classList: {
          add() {},
          remove() {},
        },
      },
      addEventListener() {},
      getElementById(id) {
        if (id === 'listings-bootstrap-status') return bootstrapStatus;
        if (id === 'container') return container;
        if (id === 'language') return { dataset: { accept: 'en' } };
        return null;
      },
      querySelector() { return null; },
      querySelectorAll() { return []; },
    },
  };
  context.WebSocket.OPEN = 1;

  vm.runInNewContext(script, context);
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));

  assert.notEqual(bootstrapStatus.textContent, 'Unable to load listings. Please refresh.');
  assert.ok(timers.some((timer) => timer.delay >= 750 && timer.delay <= 1250), 'first snapshot retry should be scheduled with jittered ~1000ms backoff');
  const pollInterval = intervals.find((interval) => interval.delay === 15000);
  assert.ok(pollInterval, 'revision poll should be scheduled every 15000ms');
  assert.ok(intervals.some((interval) => interval.delay === 1000), 'time display update should be scheduled every 1000ms');

  assert.deepEqual(fetchCalls, ['/api/listings/snapshot'], 'startup must not immediately call /api/listings/revision after snapshot fetch');
  assert.ok(wsSocketInstance, 'WebSocket should connect during initialize');
  await pollInterval.callback();
  assert.deepEqual(fetchCalls, ['/api/listings/snapshot'], '15s poll interval should skip /api/listings/revision while WS is OPEN');

  wsSocketInstance.readyState = 3;
  await pollInterval.callback();
  assert.deepEqual(fetchCalls, ['/api/listings/snapshot', '/api/listings/revision'], '15s poll interval should run when WS is closed');
});

test('listings client polls the lightweight revision endpoint as a missed-event backstop', () => {
  const source = fs.readFileSync(listingsSourcePath, 'utf8');
  const script = fs.readFileSync(listingsScriptPath, 'utf8');
  assert.match(source, /REVISION_POLL_INTERVAL_MS/);
  assert.match(source, /\/api\/listings\/revision/);
  assert.match(script, /\/api\/listings\/revision/);
  assert.match(script, /15000|15e3/);
});

test('listings client enforces monotonic revisions and jittered live snapshot fetches', async () => {
  const originalWindow = global.window;
  const originalDocument = global.document;
  const originalFetch = global.fetch;
  const originalRandom = Math.random;
  const timers = [];

  global.document = { visibilityState: 'visible' };
  global.window = {
    setTimeout(callback, delay) {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timer.cleared = true;
    },
  };

  const originalWebSocket = global.WebSocket;
  class StubWs {
    constructor() {
      this.readyState = 1;
      this.listeners = new Map();
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    send() {}
    close() {
      this.readyState = 3;
    }
  }
  StubWs.OPEN = 1;
  global.WebSocket = StubWs;
  global.window.WebSocket = StubWs;
  global.window.location = { host: 'example.test', protocol: 'https:' };

  try {
    const {
      connectLiveUpdates,
      liveUpdates,
      pollListingsRevision,
      scheduleLiveSnapshotFetch,
    } = loadListingsHelpers();

    liveUpdates.targetRevision = 10;

    global.fetch = async () => ({
      ok: true,
      async json() {
        return { revision: 10 };
      },
    });
    await pollListingsRevision();
    assert.equal(timers.length, 0, 'equal revision must not trigger snapshot fetch');

    global.fetch = async () => ({
      ok: true,
      async json() {
        return { revision: 8 };
      },
    });
    await pollListingsRevision();
    assert.equal(timers.length, 0, 'stale lower revision must not trigger snapshot fetch');

    global.fetch = async () => ({
      ok: true,
      async json() {
        return { revision: 11 };
      },
    });
    await pollListingsRevision();
    assert.equal(liveUpdates.targetRevision, 11);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 0);

    timers.length = 0;
    liveUpdates.refreshTimer = null;
    liveUpdates.refreshTimerDelay = null;
    Math.random = () => 0;
    scheduleLiveSnapshotFetch();
    assert.equal(timers[0].delay, 150);

    timers.length = 0;
    liveUpdates.refreshTimer = null;
    liveUpdates.refreshTimerDelay = null;
    Math.random = () => 0.9999;
    scheduleLiveSnapshotFetch();
    assert.equal(timers[0].delay, 599);

    // WS message handler ignores <= targetRevision and schedules jittered fetch on > targetRevision
    timers.length = 0;
    liveUpdates.refreshTimer = null;
    liveUpdates.refreshTimerDelay = null;
    connectLiveUpdates();
    const messageHandlers = liveUpdates.ws.listeners.get('message') || [];
    assert.equal(messageHandlers.length, 1);
    messageHandlers[0]({ data: JSON.stringify({ type: 'listings_revision_changed', revision: 11 }) });
    messageHandlers[0]({ data: JSON.stringify({ type: 'listings_revision_changed', revision: 9 }) });
    assert.equal(timers.length, 0);
    Math.random = () => 0.5;
    messageHandlers[0]({ data: JSON.stringify({ type: 'listings_revision_changed', revision: 12 }) });
    assert.equal(liveUpdates.targetRevision, 12);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 375);
  } finally {
    if (originalWebSocket === undefined) delete global.WebSocket;
    else global.WebSocket = originalWebSocket;
    Math.random = originalRandom;
    if (originalWindow === undefined) delete global.window;
    else global.window = originalWindow;
    if (originalDocument === undefined) delete global.document;
    else global.document = originalDocument;
    if (originalFetch === undefined) delete global.fetch;
    else global.fetch = originalFetch;
  }
});

test('listings client exposes server outage state that hides controls', () => {
  const source = fs.readFileSync(listingsSourcePath, 'utf8');
  const script = fs.readFileSync(listingsScriptPath, 'utf8');
  const css = fs.readFileSync(
    path.join(root, 'public', 'assets', 'listings.css'),
    'utf8',
  );

  assert.match(source, /function setServerUnavailable\(unavailable\)/);
  assert.match(source, /classList\.toggle\(["']server-unavailable["'], unavailable\)/);
  assert.match(source, /response\.status === 503[\s\S]*setServerUnavailable\(true\)/);
  assert.match(source, /setServerUnavailable\(false\)/);
  assert.match(script, /server-unavailable/);
  assert.match(script, /503/);
  assert.match(css, /#container\.server-unavailable\s*>\s*\.settings/);
  assert.match(css, /#container\.server-unavailable\s*>\s*\.pagination-controls/);
});

test('listings client reschedules a pending refresh when a sooner revision arrives', () => {
  const originalWindow = global.window;
  const originalDocument = global.document;
  const timers = [];

  global.document = { visibilityState: 'visible' };
  global.window = {
    setTimeout(callback, delay) {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timer.cleared = true;
    },
  };

  try {
    const { scheduleListingsRefresh, liveUpdates } = loadListingsHelpers();

    scheduleListingsRefresh(30000);
    scheduleListingsRefresh(0);

    assert.equal(timers.length, 2);
    assert.equal(timers[0].cleared, true);
    assert.equal(timers[1].delay, 0);
    assert.equal(liveUpdates.refreshTimer, timers[1]);
  } finally {
    if (originalWindow === undefined) {
      delete global.window;
    } else {
      global.window = originalWindow;
    }

    if (originalDocument === undefined) {
      delete global.document;
    } else {
      global.document = originalDocument;
    }
  }
});

test('stats bar charts tolerate empty datasets', () => {
  const { makeBarPlot } = loadStatsHelpers();

  assert.doesNotThrow(() => makeBarPlot([], 'empty-chart'));
});

test('listings client records absolute expiration time once per snapshot', () => {
  const { applySnapshotExpiryTimestamps, secondsUntilListingExpiry } = loadListingsHelpers();
  const snapshot = {
    listings: [
      { id: 'alpha', time_left_seconds: 65, listing: { high_end: true } },
    ],
  };

  applySnapshotExpiryTimestamps(snapshot, 1000);

  assert.equal(snapshot.listings[0].expires_at_timestamp, 1065);
  assert.equal(secondsUntilListingExpiry(snapshot.listings[0], 1020), 45);
});

test('listings client prunes expired listings from the current snapshot', () => {
  const { pruneExpiredListings } = loadListingsHelpers();
  const snapshot = {
    listings: [
      { id: 'expired', expires_at_timestamp: 999, listing: { high_end: true } },
      { id: 'active', expires_at_timestamp: 1001, listing: { high_end: true } },
    ],
  };

  assert.equal(pruneExpiredListings(snapshot, 1000), true);
  assert.deepEqual(snapshot.listings.map((entry) => entry.id), ['active']);
});

test('listings client refreshes expiration countdowns every second', () => {
  const source = fs.readFileSync(listingsSourcePath, 'utf8');
  const script = fs.readFileSync(listingsScriptPath, 'utf8');

  assert.match(source, /setInterval\(updateTimeDisplays,\s*1000\)/);
  assert.match(script, /setInterval\([^,]+,\s*(?:1000|1e3)\)/);
});

test('stale saved highEnd false does not disable high-end-only filtering', () => {
  const { listingMatchesFilters, normalizeSavedState, state } = loadListingsHelpers();

  normalizeSavedState({ highEnd: false });

  assert.equal(state.highEnd, true);
  assert.equal(listingMatchesFilters({ listing: { high_end: false } }), false);
  assert.equal(listingMatchesFilters({ listing: { high_end: true } }), true);
});

test('high-end-only filtering does not depend on mutable state', () => {
  const { listingMatchesFilters, state } = loadListingsHelpers();

  state.highEnd = false;

  assert.equal(listingMatchesFilters({ listing: { high_end: false } }), false);
  assert.equal(listingMatchesFilters({ listing: { high_end: true } }), true);
});

test('listing rendering translates practical hardcoded labels', () => {
  global.TRANSLATIONS = {
    none: { ja: 'なし' },
    min_il_short: { ja: '平均IL' },
    members_count: { ja: 'メンバー ({count})' },
    unknown: { ja: '不明' },
  };

  try {
    const { renderDescription, renderListingCard, state } = loadListingsHelpers();
    state.lang = 'ja';

    assert.equal(
      renderDescription({ description: [] }),
      '<div class="description"><em>なし</em></div>',
    );

    const html = renderListingCard({
      time_left_seconds: 120,
      updated_at_timestamp: 0,
      listing: {
        category: 0,
        creator_name: '',
        data_centre: 'Mana',
        display_slots: [],
        duty_id: 0,
        duty_type: 0,
        high_end: true,
        members: [],
        min_item_level: 730,
        slot_count: 8,
        slots_filled_count: 1,
      },
    });

    assert.match(html, />平均IL</);
    assert.match(html, /メンバー \(0\)/);
    assert.match(html, /不明/);
    assert.doesNotMatch(html, />Min IL</);
    assert.doesNotMatch(html, /Members \(0\)/);
  } finally {
    delete global.TRANSLATIONS;
  }
});

test('stats page has distinct empty and error state regions without duplicate CSS links', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'stats.html'), 'utf8');

  assert.match(html, /id="stats-error"[^>]*role="alert"/);
  assert.match(html, /id="stats-empty"[^>]*role="status"/);
  assert.doesNotMatch(html, /src="\/assets\/d3\.js"/);
  assert.equal((html.match(/href="\/assets\/minireset\.css"/g) || []).length, 1);
  assert.equal((html.match(/href="\/assets\/pico\.css"/g) || []).length, 1);
});

test('stats edge uses versioned asset manifest URLs when exposed', async () => {
  const { loadChartScripts } = loadStatsEdgeHelpers();
  const originalWindow = global.window;
  const originalDocument = global.document;
  const scripts = [];

  global.window = {
    __RPF_ASSETS__: {
      '/assets/d3.js': '/assets/d3.js?v=d3hash',
      '/assets/stats.js': '/assets/stats.js?v=statshash',
    },
  };
  global.document = {
    body: {
      appendChild(script) {
        scripts.push(script);
      },
    },
    createElement(tagName) {
      assert.equal(tagName, 'script');
      return {};
    },
  };

  try {
    const loaded = loadChartScripts();
    assert.deepEqual(scripts.map((script) => script.src), ['/assets/d3.js?v=d3hash']);
    scripts[0].onload();
    await Promise.resolve();
    assert.deepEqual(scripts.map((script) => script.src), ['/assets/d3.js?v=d3hash', '/assets/stats.js?v=statshash']);
    scripts[1].onload();
    await loaded;
  } finally {
    if (originalWindow === undefined) delete global.window;
    else global.window = originalWindow;
    if (originalDocument === undefined) delete global.document;
    else global.document = originalDocument;
  }
});

test('stats edge lazy-loads chart dependencies sequentially', async () => {
  const { loadChartScripts } = loadStatsEdgeHelpers();
  const originalWindow = global.window;
  const originalDocument = global.document;
  const scripts = [];

  global.window = {};
  global.document = {
    body: {
      appendChild(script) {
        scripts.push(script);
      },
    },
    createElement(tagName) {
      assert.equal(tagName, 'script');
      return {};
    },
  };

  try {
    const loaded = loadChartScripts();
    assert.deepEqual(scripts.map((script) => script.src), ['/assets/d3.js']);

    scripts[0].onload();
    await Promise.resolve();
    assert.deepEqual(scripts.map((script) => script.src), ['/assets/d3.js', '/assets/stats.js']);

    scripts[1].onload();
    await loaded;
  } finally {
    if (originalWindow === undefined) {
      delete global.window;
    } else {
      global.window = originalWindow;
    }

    if (originalDocument === undefined) {
      delete global.document;
    } else {
      global.document = originalDocument;
    }
  }
});

test('stats edge injects chart dependencies only after usable stats arrive', async () => {
  await withStatsEdgeBrowser({ ok: false }, async ({ scripts }) => {
    const { initialize } = loadStatsEdgeHelpers();

    await initialize();

    assert.equal(scripts.length, 0);
  });

  await withStatsEdgeBrowser({
    ok: true,
    async json() {
      return { num_listings: 0, duties: [], hosts: [], hours: [], days: [] };
    },
  }, async ({ scripts }) => {
    const { initialize } = loadStatsEdgeHelpers();

    await initialize();

    assert.equal(scripts.length, 0);
  });

  await withStatsEdgeBrowser({
    ok: true,
    async json() {
      return {
        num_listings: 1,
        duties: [{ label: 'Duty', count: 1 }],
        hosts: [{ world: 'World', name: 'Host', count: 1 }],
        hours: [{ hour: '12', count: 1 }],
        days: [{ label: 'Today', count: 1 }],
      };
    },
  }, async ({ elements, scripts }) => {
    const { initialize } = loadStatsEdgeHelpers();

    await initialize();

    assert.equal(elements.get('stats-content').style.display, '');
    assert.deepEqual(scripts.map((script) => script.src), ['/assets/d3.js', '/assets/stats.js']);
  }, { autoLoadScripts: true });
});

test('stats edge classifies zero-listing payloads as empty', () => {
  const { isStatsEmpty } = loadStatsEdgeHelpers();

  assert.equal(isStatsEmpty({ num_listings: 0, duties: [], hosts: [], hours: [], days: [] }), true);
  assert.equal(isStatsEmpty({ num_listings: 3, duties: [], hosts: [], hours: [], days: [] }), false);
});

test('stats edge exposes clearer localized empty and error copy', () => {
  const { statsCopy } = loadStatsEdgeHelpers();

  assert.deepEqual(statsCopy('error', 'en'), {
    title: 'Stats are temporarily unavailable',
    body: 'The statistics service could not be reached. Try refreshing in a moment.',
  });
  assert.deepEqual(statsCopy('empty', 'ja'), {
    title: '統計データはまだありません',
    body: '募集データが集まると、ここにカテゴリ、ホスト、時間帯の傾向が表示されます。',
  });
});

test('progress rendering keeps existing output when phase progress is missing', () => {
  const { renderProgressTags } = loadListingsHelpers();

  assert.equal(
    renderProgressTags({ final_clear_count: 3 }),
    '<span class="tag tag-clear" title="Clears: 3">\u27053</span>',
  );
  assert.equal(
    renderProgressTags({ final_boss_percentage: 47 }),
    '<span class="tag tag-boss" title="Final Boss HP: 47.00%">47.00%</span>',
  );
  assert.equal(
    renderProgressTags({ final_boss_percentage: 47.126 }),
    '<span class="tag tag-boss" title="Final Boss HP: 47.13%">47.13%</span>',
  );
  assert.equal(renderProgressTags({}), '');
});

test('progress rendering omits zero and invalid final boss percentages', () => {
  const { renderProgressTags } = loadListingsHelpers();

  assert.equal(renderProgressTags({ final_boss_percentage: 0 }), '');
  assert.equal(renderProgressTags({ final_boss_percentage: -1 }), '');
  assert.equal(renderProgressTags({ final_boss_percentage: 'not-a-number' }), '');
});

test('unknown member rows do not render progress or rail tags', () => {
  const { renderListingCard } = loadListingsHelpers();

  const html = renderListingCard({
    time_left_seconds: 120,
    updated_at_timestamp: 0,
    listing: {
      creator_name: 'Lead',
      data_centre: 'Mana',
      display_slots: [{ filled: true, icon_code: 'PLD', role_class: 'tank', title: 'Paladin' }],
      high_end: true,
      home_world: { name: 'Ixion' },
      members: [{
        home_world: { name: 'Unknown' },
        job_code: null,
        job_id: 0,
        name: 'Unknown Member',
        parse: {
          originally_hidden: true,
        },
        party_index: 0,
        progress: {
          final_clear_count: 4,
          final_boss_percentage: 0,
          phase_progress: [{ order: 2, display_text: 'P2 75.71%' }],
        },
        role_class: '',
        slot_index: 0,
      }],
      min_item_level: 730,
      slot_count: 8,
      slots_filled_count: 1,
    },
  });

  assert.match(html, /Unknown Member/);
  assert.doesNotMatch(html, /tag-(boss|phase|clear|hidden)|P2 75\.71%|\u27054|0\.00%/);
});

test('empty phase progress renders no phase tag', () => {
  const { renderPhaseProgress, renderProgressTags } = loadListingsHelpers();

  assert.equal(renderPhaseProgress({ phase_progress: [] }), '');
  assert.equal(renderProgressTags({ phase_progress: [] }), '');
});

test('zero phase progress renders no phase tag', () => {
  const { renderPhaseProgress, renderProgressTags } = loadListingsHelpers();
  const progress = { phase_progress: [{ order: 2, display_text: 'P2 0.00%' }] };

  assert.equal(renderPhaseProgress(progress), '');
  assert.equal(renderProgressTags(progress), '');
});

test('clear count progress takes priority over phase progress', () => {
  const { renderProgressTags } = loadListingsHelpers();

  const html = renderProgressTags({
    final_clear_count: 3,
    phase_progress: [{ order: 1, display_text: 'P1 12%' }],
  });

  assert.equal(html, '<span class="tag tag-clear" title="Clears: 3">\u27053</span>');
  assert.doesNotMatch(html, /tag-phase|P1 12%/);
});

test('member phase progress suppresses parse percentile while keeping progress and FF link', () => {
  const { renderListingCard } = loadListingsHelpers();

  const html = renderListingCard({
    time_left_seconds: 120,
    updated_at_timestamp: 0,
    listing: {
      creator_name: 'Lead',
      data_centre: 'Mana',
      display_slots: [{ filled: true, icon_code: 'PLD', role_class: 'tank', title: 'Paladin' }],
      high_end: true,
      home_world: { name: 'Ixion' },
      members: [{
        fflogs_character_url: 'https://www.fflogs.com/character/id/1',
        home_world: { name: 'Ixion' },
        job_code: 'PLD',
        job_id: 19,
        name: 'Alice',
        parse: {
          primary_percentile: 95,
          primary_color_class: 'parse-pink',
          estimated: true,
        },
        party_index: 0,
        progress: {
          final_boss_percentage: 76,
          phase_progress: [{ order: 2, display_text: 'P2 75.71%' }],
        },
        role_class: 'tank',
        slot_index: 0,
      }],
      min_item_level: 730,
      slot_count: 8,
      slots_filled_count: 1,
    },
  });

  assert.doesNotMatch(html, /Best Parse: 95|>95<\/span>|class="est"/);
  assert.doesNotMatch(html, /Final Boss HP|>76%<\/span>/);
  assert.match(html, /tag-phase/);
  assert.match(html, /P2 75\.71%/);
  assert.match(html, /https:\/\/www\.fflogs\.com\/character\/id\/1/);
});

test('phase progress suppresses final boss progress when both are present', () => {
  const { renderProgressTags } = loadListingsHelpers();

  assert.equal(
    renderProgressTags({
      final_boss_percentage: 47,
      phase_progress: [
        { order: 2, display_text: 'P2 48%' },
        { order: 1, display_text: 'P1 12%' },
      ],
    }),
    '<span class="tag tag-phase" title="P2 48%">P2 48%</span>',
  );
});

test('phase progress renders only highest-order phase from unsorted progress', () => {
  const { renderPhaseProgress, renderProgressTags } = loadListingsHelpers();
  const progress = {
    phase_progress: [
      { order: 2, display_text: 'P2 48%' },
      { order: 3, display_text: 'P3 4%' },
      { order: 1, display_text: 'P1 12%' },
    ],
  };

  assert.equal(
    renderPhaseProgress(progress),
    '<span class="tag tag-phase" title="P3 4%">P3 4%</span>',
  );
  assert.equal(renderProgressTags(progress), renderPhaseProgress(progress));
});

test('phase progress picks lower boss HP when highest phase order ties', () => {
  const { renderPhaseProgress, renderProgressTags } = loadListingsHelpers();
  const progress = {
    phase_progress: [
      { order: 5, boss_percentage: 68.71, display_text: 'P5 68.71%' },
      { order: 5, boss_percentage: 67.53, display_text: 'P5 67.53%' },
      { order: 4, boss_percentage: 41.2, display_text: 'P4 41.2%' },
    ],
  };

  assert.equal(
    renderPhaseProgress(progress),
    '<span class="tag tag-phase" title="P5 67.53%">P5 67.53%</span>',
  );
  assert.equal(renderProgressTags(progress), renderPhaseProgress(progress));
});

test('phase progress ignores non-phase labels from stale cached payloads', () => {
  const { renderPhaseProgress, renderProgressTags } = loadListingsHelpers();
  const progress = {
    phase_progress: [
      { order: 4, display_text: 'P4 41.13%' },
      { order: 7, display_text: 'I1 100%' },
    ],
  };

  assert.equal(
    renderPhaseProgress(progress),
    '<span class="tag tag-phase" title="P4 41.13%">P4 41.13%</span>',
  );
  assert.equal(renderProgressTags(progress), renderPhaseProgress(progress));
});

test('malformed phase order does not block later finite phase progress', () => {
  const { renderPhaseProgress, renderProgressTags } = loadListingsHelpers();
  const progress = {
    phase_progress: [
      { order: 'abc', display_text: 'bad' },
      { order: 2, display_text: 'P2 48%' },
    ],
  };

  assert.equal(
    renderPhaseProgress(progress),
    '<span class="tag tag-phase" title="P2 48%">P2 48%</span>',
  );
  assert.equal(renderProgressTags(progress), renderPhaseProgress(progress));
});

test('phase progress text is escaped in content and title for the chosen highest-order phase', () => {
  const { renderPhaseProgress } = loadListingsHelpers();

  assert.equal(
    renderPhaseProgress({
      phase_progress: [
        { order: 1, display_text: 'P1 12% "more" & ok' },
        { order: 2, display_text: 'P2 48% <done> & more' },
      ],
    }),
    '<span class="tag tag-phase" title="P2 48% &lt;done&gt; &amp; more">P2 48% &lt;done&gt; &amp; more</span>',
  );
});


test('per-language listing-data bundles exist strictly for en/ja/de/fr and retain core high-end duties', () => {
  assert.deepEqual(SUPPORTED_LANGUAGES, ['en', 'ja', 'de', 'fr']);
  assert.equal(fs.existsSync(path.join(root, 'public', 'assets', 'listing-data.ko.js')), false, 'ko bundle must not exist');

  const trimmedBloatGroups = ['22', '25', '49', '51', '57', '60', '62', '63', '65'];
  const requiredDutyIds = ['1010', '1063', '1094', '1114', '1116', '1118'];

  for (const lang of SUPPORTED_LANGUAGES) {
    const filePath = path.join(root, 'public', 'assets', `listing-data.${lang}.js`);
    assert.equal(fs.existsSync(filePath), true, `missing listing-data.${lang}.js`);
    const sizeBytes = fs.statSync(filePath).size;
    assert.ok(sizeBytes < 260 * 1024, `listing-data.${lang}.js should remain compact (<260KB, got ${sizeBytes})`);
    const brPath = `${filePath}.br`;
    if (fs.existsSync(brPath)) {
      const brBytes = fs.statSync(brPath).size;
      assert.ok(brBytes < 65 * 1024, `listing-data.${lang}.js.br should stay compressed (<65KB, got ${brBytes})`);
    }

    const context = { window: {} };
    vm.runInNewContext(fs.readFileSync(filePath, 'utf8'), context);
    const data = context.window.RPF_LISTING_DATA;
    assert.ok(data && data.duties && data.territoryNames && data.autoTranslate, `RPF_LISTING_DATA missing in ${lang}`);
    assert.ok(Object.hasOwn(data.duties, '1'), `missing regular dungeon duty 1 in ${lang}`);
    assert.ok(Object.hasOwn(data.territoryNames, '128'), `missing territory 128 in ${lang}`);

    for (const id of requiredDutyIds) {
      assert.ok(Object.hasOwn(data.duties, id), `missing duty ${id} in ${lang}`);
    }
    for (const group of trimmedBloatGroups) {
      assert.equal(Object.hasOwn(data.autoTranslate, group), false, `bloat group ${group} should be trimmed in ${lang}`);
    }
  }
});

test('translations and stats localization strictly use en/ja/de/fr with zero ko and complete stats keys', () => {
  const translationsSource = fs.readFileSync(path.join(root, 'public', 'assets', 'translations.js'), 'utf8');
  const translations = vm.runInNewContext(`(function () {\n${translationsSource}\nreturn TRANSLATIONS;\n})()`, {});

  assert.equal(translations.min_item_level.ja, '下限IL');
  const listingsHelpers = loadListingsHelpers();
  const prevLang = listingsHelpers.state.lang;
  try {
    listingsHelpers.state.lang = 'ja';
    const cardHtml = listingsHelpers.renderListingCard({
      listing: {
        creator_name: 'Tester',
        home_world: { name: 'Ixion' },
        min_item_level: 730,
        display_slots: [],
        members: [],
      },
    });
    assert.match(cardHtml, /<div class="name">下限IL<\/div>/);
  } finally {
    listingsHelpers.state.lang = prevLang;
  }

  for (const [key, entry] of Object.entries(translations)) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      assert.equal(Object.hasOwn(entry, 'ko'), false, `TRANSLATIONS.${key} must not contain ko`);
    }
  }

  const { DAY_NAMES, STATS_TRANSLATIONS, statsCopy, translateDayLabel, translateStat } = loadStatsEdgeHelpers();
  for (const [key, entry] of Object.entries(STATS_TRANSLATIONS)) {
    assert.equal(Object.hasOwn(entry, 'ko'), false, `STATS_TRANSLATIONS.${key} must not contain ko`);
    for (const lang of SUPPORTED_LANGUAGES) {
      assert.ok(typeof entry[lang] === 'string' && entry[lang].length > 0, `missing ${lang} translation for ${key}`);
    }
  }
  for (const [dayKey, entry] of Object.entries(DAY_NAMES)) {
    assert.equal(Object.hasOwn(entry, 'ko'), false, `DAY_NAMES.${dayKey} must not contain ko`);
    for (const lang of SUPPORTED_LANGUAGES) {
      assert.ok(typeof entry[lang] === 'string' && entry[lang].length > 0, `missing ${lang} day name for ${dayKey}`);
    }
  }
  for (const lang of SUPPORTED_LANGUAGES) {
    assert.ok(statsCopy('loading', lang).title.length > 0);
    assert.ok(statsCopy('error', lang).title.length > 0);
    assert.ok(statsCopy('empty', lang).title.length > 0);
    assert.equal(translateDayLabel('Monday', lang), DAY_NAMES.monday[lang]);
    assert.ok(translateStat('tooltip_treemap', lang).includes('{percent}'));
    assert.ok(translateStat('tooltip_bar', lang).includes('{count}'));
  }

  const statsHtml = fs.readFileSync(path.join(root, 'public', 'stats.html'), 'utf8');
  assert.match(statsHtml, /id="stats-loading"/);
  assert.match(statsHtml, /<main\b/);
  assert.equal((statsHtml.match(/<h1\b/g) || []).length, 1);
});

test('stats charts use accessible contrast for #FBC02D, sequential hour colors, CJK wrap, and unescaped textContent', () => {
  const {
    contrastTextColor,
    extractData,
    relativeLuminance,
    sequentialHourColor,
    tokenizeForWrap,
  } = loadStatsHelpers();

  const textHex = contrastTextColor('#FBC02D');
  assert.equal(textHex, '#1a1a1a');
  const bgLum = relativeLuminance('#FBC02D');
  const fgLum = relativeLuminance(textHex);
  const contrastRatio = (Math.max(bgLum, fgLum) + 0.05) / (Math.min(bgLum, fgLum) + 0.05);
  assert.ok(contrastRatio >= 4.5, `contrast ratio on #FBC02D must be >= 4.5 (got ${contrastRatio.toFixed(2)})`);

  assert.equal(contrastTextColor('#1976D2'), '#ffffff');

  const lowHour = sequentialHourColor(5, 100);
  const highHour = sequentialHourColor(95, 100);
  assert.notEqual(lowHour, highHour);
  assert.match(lowHour, /^rgb\(\d+, \d+, \d+\)$/);

  const cjkTokens = tokenizeForWrap('アルカディア零式：ヘビー級');
  assert.ok(cjkTokens.length >= 10);
  assert.equal(cjkTokens[0].joinWithSpace, false);

  const originalDocument = global.document;
  global.document = {
    getElementById(id) {
      assert.equal(id, 'categories-table');
      return {
        querySelectorAll() {
          return [{
            querySelectorAll() {
              return [
                { textContent: 'Dungeons & Trials', innerHTML: 'Dungeons &amp; Trials' },
                { textContent: '42', innerHTML: '42' },
              ];
            },
          }];
        },
      };
    },
  };
  try {
    const extracted = extractData('categories-table');
    assert.deepEqual(extracted, [{ label: 'Dungeons & Trials', value: 42 }]);
  } finally {
    if (originalDocument === undefined) delete global.document;
    else global.document = originalDocument;
  }
});

test('listings CSS prevents double chevrons, mobile horizontal overflow, and display:none inputs', () => {
  const commonCss = fs.readFileSync(path.join(root, 'public', 'assets', 'common.css'), 'utf8');
  const listingsCss = fs.readFileSync(path.join(root, 'public', 'assets', 'listings.css'), 'utf8');

  assert.match(listingsCss, /#data-centre-filter[\s\S]*appearance:\s*none/);
  assert.match(listingsCss, /#data-centre-filter::picker-icon[\s\S]*display:\s*none/);
  assert.match(listingsCss, /\.role-group\s+\.jobs[\s\S]*flex-wrap:\s*wrap/);
  assert.match(listingsCss, /\.sr-only[\s\S]*clip:\s*rect\(0,\s*0,\s*0,\s*0\)/);
  assert.doesNotMatch(listingsCss, /display:\s*none\s*;?\s*\}\s*\n*\s*\.chip-group input/);
  assert.match(commonCss, /white-space:\s*nowrap/);
});

test('game-data drift sync covers Pilgrim\'s Traverse, EU Shadow DC, and dead listing-data.js removal', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'listings.html'), 'utf8');
  assert.match(html, /<optgroup label="Europe">[\s\S]*?<option value="Shadow">Shadow<\/option>[\s\S]*?<\/optgroup>/);

  for (const deadFile of ['listing-data.js', 'listing-data.js.br', 'listing-data.js.gz']) {
    assert.equal(fs.existsSync(path.join(root, 'public', 'assets', deadFile)), false, `${deadFile} should be removed`);
  }

  const { listingDutyName, listingRenderSignature, renderListingCard, state } = loadListingsHelpers();
  const prevLang = state.lang;
  try {
    state.lang = 'en';
    assert.equal(listingDutyName({ duty_type: 0, category: 8192, duty_id: 4 }), "Pilgrim's Traverse");
    state.lang = 'ja';
    assert.equal(listingDutyName({ duty_type: 0, category: 8192, duty_id: 4 }), 'ピルグリム・トラバース');
    state.lang = 'de';
    assert.equal(listingDutyName({ duty_type: 0, category: 8192, duty_id: 4 }), 'Pilgers Pfad');
    state.lang = 'fr';
    assert.equal(listingDutyName({ duty_type: 0, category: 8192, duty_id: 4 }), 'Sanctuaire des pèlerins');
  } finally {
    state.lang = prevLang;
  }

  const sig1 = listingRenderSignature({
    time_left_seconds: 1200,
    updated_at_timestamp: 500,
    listing: { id: 10, slot_count: 8, slots_filled_count: 3, members: [{}, {}, {}] },
  }, 42);
  const sig2 = listingRenderSignature({
    time_left_seconds: 1200,
    updated_at_timestamp: 500,
    listing: { id: 10, slot_count: 8, slots_filled_count: 4, members: [{}, {}, {}, {}] },
  }, 43);
  assert.notEqual(sig1, sig2);
  assert.ok(!sig1.includes('{'), 'renderSignature should be a compact composite key instead of JSON.stringify');

  const originalWindow = global.window;
  global.window = {
    __RPF_ASSETS__: {
      '/assets/job-icons.svg': '/assets/job-icons.svg?v=jobv1',
      '/assets/role-icons.svg': '/assets/role-icons.svg?v=rolev1',
      '/assets/icons.svg': '/assets/icons.svg?v=iconv1',
    },
  };
  try {
    const cardHtml = renderListingCard({
      time_left_seconds: 100,
      updated_at_timestamp: 0,
      listing: {
        creator_name: 'Lead',
        home_world: { name: 'Ixion' },
        display_slots: [
          { filled: true, icon_code: 'PLD', role_class: 'tank', title: 'Paladin' },
          { filled: false, role_class: 'healer', title: 'Healer' },
        ],
        members: [],
      },
    });
    assert.match(cardHtml, /href="\/assets\/job-icons\.svg\?v=jobv1#PLD"/);
    assert.match(cardHtml, /href="\/assets\/role-icons\.svg\?v=rolev1#ROLE_HEALER"/);
    assert.match(cardHtml, /href="\/assets\/icons\.svg\?v=iconv1#user"/);
  } finally {
    if (originalWindow === undefined) delete global.window;
    else global.window = originalWindow;
  }
});

test('common.js hydrates window.__RPF_ASSETS__ from edge-injected meta manifest', () => {
  const staticHandler = createStaticHandler(path.join(root, 'public'));
  const html = localizeHtmlForLanguage(
    'en',
    fs.readFileSync(path.join(root, 'public', 'stats.html'), 'utf8'),
    staticHandler.assetVersions,
  );
  const match = html.match(/<meta name="rpf-assets" content="([^"]+)"/);
  assert.ok(match);
  const decodedContent = match[1]
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

  const commonScript = fs.readFileSync(path.join(root, 'public', 'assets', 'common.js'), 'utf8');
  const windowObj = {};
  const context = {
    window: windowObj,
    document: {
      cookie: '',
      documentElement: { lang: 'en' },
      getElementById() { return null; },
      querySelector(selector) {
        if (selector === 'meta[name="rpf-assets"]') {
          return { getAttribute: (name) => (name === 'content' ? decodedContent : null) };
        }
        return null;
      },
      querySelectorAll() { return []; },
    },
  };
  vm.runInNewContext(commonScript, context);
  assert.match(windowObj.__RPF_ASSETS__['/assets/d3.js'], /^\/assets\/d3\.js\?v=[a-f0-9]+$/);
  assert.match(windowObj.__RPF_ASSETS__['/assets/stats.js'], /^\/assets\/stats\.js\?v=[a-f0-9]+$/);
  assert.match(windowObj.__RPF_ASSETS__['/assets/job-icons.svg'], /^\/assets\/job-icons\.svg\?v=[a-f0-9]+$/);
});

test('listings renderer accepts Tier 2/3 tomestone_web and tomestone_cdp mechanic progress', () => {
  const { renderListingCard, renderPhaseProgress, renderProgressTags } = loadListingsHelpers();

  for (const source of ['tomestone_api', 'tomestone_web', 'tomestone_cdp']) {
    const progress = {
      phase_progress: [{
        phase_key: 'mechanic-splattershed-2',
        phase_name: 'Splattershed #2',
        order: 0,
        boss_percentage: 35.82,
        display_text: 'Splattershed #2 35.82%',
        source,
      }],
    };
    const expected = '<span class="tag tag-phase" title="Splattershed #2 35.82%">Splattershed #2 35.82%</span>';
    assert.equal(renderPhaseProgress(progress), expected);
    assert.equal(renderProgressTags(progress), expected);

    const cardHtml = renderListingCard({
      time_left_seconds: 120,
      updated_at_timestamp: 0,
      listing: {
        creator_name: 'Lead',
        data_centre: 'Mana',
        display_slots: [{ filled: true, icon_code: 'PLD', role_class: 'tank', title: 'Paladin' }],
        high_end: true,
        home_world: { name: 'Ixion' },
        members: [{
          home_world: { name: 'Ixion' },
          job_code: 'PLD',
          job_id: 19,
          name: 'Alice',
          parse: { primary_percentile: 80, primary_color_class: 'parse-purple' },
          party_index: 0,
          progress,
          role_class: 'tank',
          slot_index: 0,
        }],
        slot_count: 8,
        slots_filled_count: 1,
      },
    });
    assert.match(cardHtml, /tag-phase/);
    assert.match(cardHtml, /Splattershed #2 35\.82%/);
  }

  assert.equal(renderPhaseProgress({
    phase_progress: [{
      phase_key: 'mechanic-splattershed-2',
      phase_name: 'Splattershed #2',
      order: 0,
      boss_percentage: 35.82,
      display_text: 'Splattershed #2 35.82%',
      source: 'fflogs_web',
    }],
  }), '');
});

test('listings client handles non-monotonic revision_epoch resets and epoch-less fallback resets', async () => {
  const originalWindow = global.window;
  const originalDocument = global.document;
  const originalFetch = global.fetch;
  const originalWebSocket = global.WebSocket;
  const timers = [];

  global.document = {
    visibilityState: 'visible',
    cookie: '',
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  global.window = {
    location: { host: 'example.test', protocol: 'https:' },
    setTimeout(callback, delay) {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timer.cleared = true;
    },
  };

  class StubWs {
    constructor() {
      this.readyState = 1;
      this.listeners = new Map();
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    send() {}
    close() {
      this.readyState = 3;
    }
  }
  StubWs.OPEN = 1;
  global.WebSocket = StubWs;
  global.window.WebSocket = StubWs;

  try {
    const {
      connectLiveUpdates,
      fetchSnapshot,
      isTargetAheadOfLoaded,
      liveUpdates,
      pollListingsRevision,
    } = loadListingsHelpers();

    liveUpdates.targetEpoch = '0000019a00000001-aaaaaaaaaaaaaaaa';
    liveUpdates.targetRevision = 500;
    liveUpdates.revisionEpoch = '0000019a00000001-aaaaaaaaaaaaaaaa';
    liveUpdates.revision = 500;

    connectLiveUpdates();
    const messageHandler = liveUpdates.ws.listeners.get('message')[0];

    // Stale lower epoch with huge revision must be ignored.
    messageHandler({
      data: JSON.stringify({
        type: 'listings_revision_changed',
        revision: 999,
        revision_epoch: '0000019a00000000-0000000000000000',
      }),
    });
    assert.equal(liveUpdates.targetEpoch, '0000019a00000001-aaaaaaaaaaaaaaaa');
    assert.equal(liveUpdates.targetRevision, 500);
    assert.equal(timers.length, 0);

    // Newer epoch with reset revision 1 must be accepted.
    messageHandler({
      data: JSON.stringify({
        type: 'listings_revision_changed',
        revision: 1,
        revision_epoch: '0000019a00000002-bbbbbbbbbbbbbbbb',
      }),
    });
    assert.equal(liveUpdates.targetEpoch, '0000019a00000002-bbbbbbbbbbbbbbbb');
    assert.equal(liveUpdates.targetRevision, 1);
    assert.equal(timers.length, 1);

    // Poll with newer epoch and revision 1 <= previous 500 also advances cleanly.
    timers.length = 0;
    liveUpdates.refreshTimer = null;
    liveUpdates.refreshTimerDelay = null;
    global.fetch = async () => ({
      ok: true,
      async json() {
        return { revision: 1, revision_epoch: '0000019a00000003-cccccccccccccccc' };
      },
    });
    await pollListingsRevision();
    assert.equal(liveUpdates.targetEpoch, '0000019a00000003-cccccccccccccccc');
    assert.equal(liveUpdates.targetRevision, 1);
    assert.equal(timers.length, 1);

    // Epoch-less snapshot reset when ETag changes: 500 -> 1 resets targetRevision cleanly.
    timers.length = 0;
    liveUpdates.refreshTimer = null;
    liveUpdates.refreshTimerDelay = null;
    liveUpdates.targetEpoch = null;
    liveUpdates.revisionEpoch = null;
    liveUpdates.targetRevision = 500;
    liveUpdates.revision = 500;
    liveUpdates.snapshotEtag = '"etag-500"';
    global.fetch = async () => ({
      ok: true,
      headers: { get: (name) => (name.toLowerCase() === 'etag' ? '"etag-1"' : null) },
      async json() {
        return { revision: 1, listings: [] };
      },
    });
    await fetchSnapshot(true);
    assert.equal(liveUpdates.revision, 1);
    assert.equal(liveUpdates.targetRevision, 1);
    assert.equal(isTargetAheadOfLoaded(), false);
    assert.equal(timers.length, 0);

    // Mid-flight WS bump (rev 1 -> fetched rev 2 while WS bumped target to 3) keeps retry active.
    global.fetch = async () => {
      liveUpdates.targetRevision = 3;
      return {
        ok: true,
        headers: { get: (name) => (name.toLowerCase() === 'etag' ? '"etag-2"' : null) },
        async json() {
          return { revision: 2, listings: [] };
        },
      };
    };
    await fetchSnapshot(true);
    assert.equal(liveUpdates.revision, 2);
    assert.equal(liveUpdates.targetRevision, 3);
    assert.equal(isTargetAheadOfLoaded(), true);
    assert.equal(timers.length, 1);
  } finally {
    if (originalWebSocket === undefined) delete global.WebSocket;
    else global.WebSocket = originalWebSocket;
    if (originalWindow === undefined) delete global.window;
    else global.window = originalWindow;
    if (originalDocument === undefined) delete global.document;
    else global.document = originalDocument;
    if (originalFetch === undefined) delete global.fetch;
    else global.fetch = originalFetch;
  }
});

test('listings client runs silent-WS backstop poll, jitters reconnect/retry, and avoids visibilitychange double-fetch', async () => {
  const originalWindow = global.window;
  const originalDocument = global.document;
  const originalFetch = global.fetch;
  const originalWebSocket = global.WebSocket;
  const originalRandom = Math.random;
  const timers = [];
  const fetchCalls = [];

  global.document = {
    visibilityState: 'visible',
    cookie: '',
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  global.window = {
    location: { host: 'example.test', protocol: 'https:' },
    setTimeout(callback, delay) {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timer.cleared = true;
    },
  };

  class StubWs {
    constructor() {
      this.readyState = 1;
      this.listeners = new Map();
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    send() {}
    close() {
      this.readyState = 3;
    }
  }
  StubWs.OPEN = 1;
  global.WebSocket = StubWs;
  global.window.WebSocket = StubWs;
  global.fetch = async (url) => {
    fetchCalls.push(url);
    return {
      ok: true,
      async json() {
        return { revision: 1 };
      },
    };
  };

  try {
    const {
      connectLiveUpdates,
      handleVisibilityChange,
      liveUpdates,
      scheduleLiveReconnect,
      scheduleSnapshotRetry,
      shouldRunRevisionPoll,
      state,
    } = loadListingsHelpers();

    // 1. Silent WS backstop poll check.
    connectLiveUpdates();
    const openedAt = liveUpdates.lastWsEventAtMs;
    assert.equal(shouldRunRevisionPoll(openedAt + 15000), false);
    assert.equal(shouldRunRevisionPoll(openedAt + 45000), true);
    liveUpdates.lastRevisionPollAtMs = openedAt + 45000;
    assert.equal(shouldRunRevisionPoll(openedAt + 60000), false);
    assert.equal(shouldRunRevisionPoll(openedAt + 90000), true);

    // 2. Backoff jitter check (±25%).
    timers.length = 0;
    liveUpdates.retryAttempt = 0;
    liveUpdates.refreshFailureCount = 0;
    Math.random = () => 0;
    scheduleLiveReconnect();
    scheduleSnapshotRetry();
    assert.equal(timers[0].delay, 750);
    assert.equal(timers[1].delay, 750);

    timers.length = 0;
    liveUpdates.refreshTimer = null;
    liveUpdates.refreshTimerDelay = null;
    liveUpdates.retryAttempt = 0;
    liveUpdates.refreshFailureCount = 0;
    Math.random = () => 0.9999;
    scheduleLiveReconnect();
    scheduleSnapshotRetry();
    assert.equal(timers[0].delay, 1250);
    assert.equal(timers[1].delay, 1250);

    // 3. visibilitychange avoids redundant double-fetch on resume.
    timers.length = 0;
    fetchCalls.length = 0;
    liveUpdates.refreshTimer = null;
    liveUpdates.refreshTimerDelay = null;
    liveUpdates.pendingRefresh = false;
    liveUpdates.paused = true;
    state.snapshot = { revision: 1, listings: [] };
    liveUpdates.revision = 1;
    liveUpdates.targetRevision = 1;
    liveUpdates.lastSnapshotAtMs = Date.now();
    global.document.visibilityState = 'visible';

    // Quick tab switch (< 15s): relies on WS reconnect, 0 HTTP fetches/timers.
    handleVisibilityChange();
    assert.equal(fetchCalls.length, 0);
    assert.equal(timers.length, 0);

    // Stale tab switch (>= 15s): runs single revision poll, NOT unconditional snapshot fetch.
    liveUpdates.lastSnapshotAtMs = Date.now() - 20000;
    handleVisibilityChange();
    await Promise.resolve();
    assert.deepEqual(fetchCalls, ['/api/listings/revision']);
    assert.equal(timers.length, 0);

    // Pending refresh resume: schedules single snapshot fetch, NOT revision poll.
    fetchCalls.length = 0;
    liveUpdates.pendingRefresh = true;
    handleVisibilityChange();
    assert.equal(fetchCalls.length, 0);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 250);
  } finally {
    Math.random = originalRandom;
    if (originalWebSocket === undefined) delete global.WebSocket;
    else global.WebSocket = originalWebSocket;
    if (originalWindow === undefined) delete global.window;
    else global.window = originalWindow;
    if (originalDocument === undefined) delete global.document;
    else global.document = originalDocument;
    if (originalFetch === undefined) delete global.fetch;
    else global.fetch = originalFetch;
  }
});

test('listingRenderSignature reuses unchanged card DOM nodes across snapshots and invalidates on mutable field updates', () => {
  const { listingRenderSignature, renderListingsPage, setSnapshot } = loadListingsHelpers();

  const makeContainer = (overrides = {}) => ({
    time_left_seconds: 1200,
    updated_at_timestamp: 500,
    ...overrides,
    listing: {
      id: 77,
      duty_id: 1010,
      duty_type: 2,
      category: 4,
      data_centre: 'Mana',
      creator_name: [{ type: 'text', text: 'Lead' }],
      home_world: { name: 'Ixion' },
      created_world: { name: 'Ixion' },
      description: [{ type: 'text', text: 'P2 prog' }],
      description_badges: ['practice'],
      description_badge_class: 'practice',
      min_item_level: 730,
      slot_count: 8,
      slots_filled_count: 2,
      high_end: true,
      display_slots: [
        { filled: true, icon_code: 'PLD', role_class: 'tank', title: 'Paladin' },
        { filled: false, role_class: 'healer', title: 'Healer' },
      ],
      leader_parse: { primary_percentile: 85, primary_color_class: 'parse-purple' },
      members: [
        {
          name: 'Lead',
          home_world: { name: 'Ixion' },
          job_id: 19,
          job_code: 'PLD',
          role_class: 'tank',
          party_index: 0,
          slot_index: 0,
          parse: { primary_percentile: 85, primary_color_class: 'parse-purple' },
          progress: { final_boss_percentage: 42 },
        },
      ],
      ...(overrides.listing || {}),
    },
  });

  // Unchanged content across different snapshotRevision and time_left_seconds produces identical signature.
  const baseSig = listingRenderSignature(makeContainer(), 42);
  const nextRevSig = listingRenderSignature(makeContainer({ time_left_seconds: 1185, updated_at_timestamp: 515 }), 43);
  assert.equal(baseSig, nextRevSig);
  assert.ok(!baseSig.includes('{'));

  // Mutable rendered fields all change the signature even at the same revision.
  const variants = [
    { listing: { description: [{ type: 'text', text: 'Clear party' }] } },
    { listing: { description_badges: ['completion'] } },
    { listing: { min_item_level: 735 } },
    { listing: { duty_id: 1063 } },
    { listing: { display_slots: [{ filled: true, icon_code: 'WAR', role_class: 'tank', title: 'Warrior' }] } },
    { listing: { leader_parse: { primary_percentile: 99, primary_color_class: 'parse-gold' } } },
    {
      listing: {
        members: [{
          name: 'Lead',
          home_world: { name: 'Ixion' },
          job_id: 19,
          job_code: 'PLD',
          role_class: 'tank',
          party_index: 0,
          slot_index: 0,
          parse: { primary_percentile: 99, primary_color_class: 'parse-gold' },
          progress: { final_boss_percentage: 42 },
        }],
      },
    },
    {
      listing: {
        members: [{
          name: 'Lead',
          home_world: { name: 'Ixion' },
          job_id: 19,
          job_code: 'PLD',
          role_class: 'tank',
          party_index: 0,
          slot_index: 0,
          parse: { primary_percentile: 85, primary_color_class: 'parse-purple' },
          progress: {
            phase_progress: [{
              phase_key: 'mechanic-foo',
              phase_name: 'Foo',
              order: 0,
              boss_percentage: 25,
              display_text: 'Foo 25%',
              source: 'tomestone_web',
            }],
          },
        }],
      },
    },
  ];
  for (const variant of variants) {
    assert.notEqual(listingRenderSignature(makeContainer(variant), 42), baseSig);
  }

  // Verify actual DOM node reuse in renderListingsPage() across snapshots.
  const originalWindow = global.window;
  const originalDocument = global.document;
  const children = [];
  const listingsEl = {
    children,
    get lastElementChild() {
      return children[children.length - 1] || null;
    },
    insertBefore(node, ref) {
      const existingIdx = children.indexOf(node);
      if (existingIdx !== -1) children.splice(existingIdx, 1);
      if (!ref) {
        children.push(node);
        return node;
      }
      const refIdx = children.indexOf(ref);
      children.splice(refIdx === -1 ? children.length : refIdx, 0, node);
      return node;
    },
  };

  global.window = { RPF_LISTING_DATA: {} };
  global.document = {
    cookie: '',
    getElementById(id) {
      return id === 'listings' ? listingsEl : null;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement(tag) {
      assert.equal(tag, 'template');
      let rawHtml = '';
      const card = {
        dataset: {},
        expiresEl: { dataset: {} },
        updatedEl: { dataset: {} },
        querySelector(sel) {
          if (sel === '.expires') return card.expiresEl;
          if (sel === '.updated') return card.updatedEl;
          return null;
        },
        querySelectorAll() { return []; },
        remove() {
          const idx = children.indexOf(card);
          if (idx !== -1) children.splice(idx, 1);
        },
      };
      return {
        set innerHTML(val) { rawHtml = val; },
        get innerHTML() { return rawHtml; },
        content: { firstElementChild: card },
      };
    },
  };

  try {
    setSnapshot({ revision: 42, listings: [makeContainer()] }, false);
    assert.equal(children.length, 1);
    const firstCardNode = children[0];

    setSnapshot({ revision: 43, listings: [makeContainer({ time_left_seconds: 1185, updated_at_timestamp: 515 })] }, true);
    assert.equal(children.length, 1);
    assert.equal(children[0], firstCardNode, 'unchanged card must reuse existing DOM node across revisions');
    assert.equal(firstCardNode.expiresEl.dataset.expiresIn, '1185');
    assert.equal(firstCardNode.updatedEl.dataset.updatedAt, '515');

    setSnapshot({ revision: 43, listings: [makeContainer({ listing: { min_item_level: 740 } })] }, true);
    assert.equal(children.length, 1);
    assert.notEqual(children[0], firstCardNode, 'card with updated mutable field at same revision must re-render');
  } finally {
    if (originalWindow === undefined) delete global.window;
    else global.window = originalWindow;
    if (originalDocument === undefined) delete global.document;
    else global.document = originalDocument;
  }
});
