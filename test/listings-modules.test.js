const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  applySnapshotExpiryTimestamps,
  escapeHtml,
  nowSeconds,
  pruneExpiredListings,
  secondsUntilListingExpiry,
} = require('../src/client/listings/utils');
const { matchesListingFilters, roleFilterValue } = require('../src/client/listings/filters');
const { createListingsRenderer } = require('../src/client/listings/renderer');

function rendererWithTranslations(translations = {}) {
  return createListingsRenderer({
    escapeHtml,
    translate(key, fallback, values = {}) {
      const template = Object.hasOwn(translations, key) ? translations[key] : fallback;
      return Object.entries(values).reduce(
        (text, [name, value]) => text.replace(`{${name}}`, value),
        template,
      );
    },
    seStringText(value) {
      return Array.isArray(value) ? value.join('') : String(value || '');
    },
    listingDutyName() {
      return 'Vampire Fatale';
    },
  });
}

test('source listings utilities expose floored epoch seconds', () => {
  const originalNow = Date.now;
  Date.now = () => 1234567899;

  try {
    assert.equal(nowSeconds(), 1234567);
  } finally {
    Date.now = originalNow;
  }
});

test('source listings utilities escape text and normalize expiry data', () => {
  assert.equal(escapeHtml('<span>"x" & \'y\'</span>'), '&lt;span&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/span&gt;');

  const snapshot = {
    listings: [
      { id: 'expired', expires_at_timestamp: 999 },
      { id: 'active', time_left_seconds: 3 },
      { id: 'clamped', time_left_seconds: -10 },
    ],
  };

  applySnapshotExpiryTimestamps(snapshot, 1000);

  assert.equal(snapshot.listings[1].expires_at_timestamp, 1003);
  assert.equal(snapshot.listings[2].expires_at_timestamp, 1000);
  assert.equal(secondsUntilListingExpiry(snapshot.listings[1], 1001), 2);
  assert.equal(secondsUntilListingExpiry({ time_left_seconds: 1.2 }, 1000), 2);
  assert.equal(pruneExpiredListings(snapshot, 1000), true);
  assert.deepEqual(snapshot.listings.map((entry) => entry.id), ['active']);
});

test('source listings filters apply high-end role and search rules', () => {
  const listing = {
    data_centre: 'Mana',
    num_parties: 1,
    joinable_roles: '256',
    high_end: true,
    objective_bits: 2,
    conditions_bits: 8,
    search_area_bits: 32,
    min_item_level: 730,
    content_kind: 5,
    duty_id: 101,
  };
  const filters = {
    centre: 'Mana',
    roles: 256n,
    objectives: 2,
    conditions: 8,
    onePlayerPerJob: true,
    minItemLevel: 720,
    contentTypes: [5],
    selectedContents: [101],
    searchQuery: 'vamp',
  };

  assert.equal(roleFilterValue('not-a-number'), 0n);
  assert.equal(matchesListingFilters({ listing }, filters, 'vamp fatale mana'), true);
  assert.equal(matchesListingFilters({ listing: { ...listing, high_end: false } }, filters, 'vamp fatale mana'), false);
  assert.equal(matchesListingFilters({ listing }, { ...filters, searchQuery: 'lindwurm' }, 'vamp fatale mana'), false);
});

test('source listings filter matches the Beastmaster bit above 32-bit range', () => {
  const beastmasterBit = 1n << 32n;
  const filters = {
    centre: 'All',
    roles: beastmasterBit,
    objectives: 0,
    conditions: 0,
    onePlayerPerJob: false,
    minItemLevel: 0,
    contentTypes: [],
    selectedContents: [],
    searchQuery: '',
  };
  const listing = {
    num_parties: 1,
    joinable_roles: '4294967296',
    high_end: true,
  };

  assert.equal(roleFilterValue(listing.joinable_roles), beastmasterBit);
  assert.equal(matchesListingFilters({ listing }, filters), true);
  assert.equal(matchesListingFilters({ listing: { ...listing, joinable_roles: '0' } }, filters), false);
});

test('source listings renderer exposes translated description and progress tags', () => {
  const renderer = rendererWithTranslations({
    none: 'なし',
  });

  assert.equal(
    renderer.renderDescription({ description: [] }),
    '<div class="description"><em>なし</em></div>',
  );
  const progressHtml = renderer.renderProgressTags({
    final_boss_percentage: 47,
    phase_progress: [{ display_text: 'P2 32%' }],
  });
  assert.match(progressHtml, /P2 32%/);
  assert.doesNotMatch(progressHtml, /Final Boss HP|47%/);
});

test('source listings renderer preserves alliance member parse details', () => {
  const renderer = rendererWithTranslations();

  const html = renderer.renderListingCard({
    time_left_seconds: 120,
    updated_at_timestamp: 0,
    listing: {
      creator_name: 'Lead',
      data_centre: 'Mana',
      display_slots: [{ filled: true, icon_code: 'PLD', role_class: 'tank', title: 'Paladin' }],
      high_end: true,
      home_world: { name: 'Ixion' },
      is_alliance_view: true,
      members: [{
        fflogs_character_url: 'https://www.fflogs.com/character/id/1',
        home_world: { name: 'Ixion' },
        job_code: 'PLD',
        job_id: 19,
        name: 'Alice',
        parse: {
          estimated: true,
          has_secondary: true,
          hidden: true,
          originally_hidden: true,
        },
        party_index: 0,
        progress: { final_clear_count: 2 },
        role_class: 'tank',
        slot_index: 0,
      }],
      min_item_level: 730,
      slot_count: 24,
      slots_filled_count: 1,
    },
  });

  assert.match(html, /listing-alliance-wide/);
  assert.match(html, /Alliance A/);
  assert.match(html, /icons\.svg#PLD/);
  assert.match(html, /parse-dual-hidden/);
  assert.match(html, /tag-hidden/);
  assert.match(html, /class="est"/);
  assert.match(html, /tag-clear/);
  assert.match(html, /data-party-index="0"/);
  assert.match(html, /https:\/\/www\.fflogs\.com\/character\/id\/1/);
});

test('source member phase progress suppresses parse percentile while keeping progress and FF link', () => {
  const renderer = rendererWithTranslations();

  const html = renderer.renderListingCard({
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

test('source progress rendering keeps existing output when phase progress is missing', () => {
  const { renderProgressTags } = rendererWithTranslations();

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

test('source progress rendering omits zero and invalid final boss percentages', () => {
  const { renderProgressTags } = rendererWithTranslations();

  assert.equal(renderProgressTags({ final_boss_percentage: 0 }), '');
  assert.equal(renderProgressTags({ final_boss_percentage: -1 }), '');
  assert.equal(renderProgressTags({ final_boss_percentage: 'not-a-number' }), '');
});

test('source unknown member rows do not render progress or rail tags', () => {
  const renderer = rendererWithTranslations();

  const html = renderer.renderListingCard({
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

test('source empty phase progress renders no phase tag', () => {
  const { renderPhaseProgress, renderProgressTags } = rendererWithTranslations();

  assert.equal(renderPhaseProgress({ phase_progress: [] }), '');
  assert.equal(renderProgressTags({ phase_progress: [] }), '');
});

test('source zero phase progress renders no phase tag', () => {
  const { renderPhaseProgress, renderProgressTags } = rendererWithTranslations();
  const progress = { phase_progress: [{ order: 2, display_text: 'P2 0.00%' }] };

  assert.equal(renderPhaseProgress(progress), '');
  assert.equal(renderProgressTags(progress), '');
});

test('source clear count progress takes priority over phase progress', () => {
  const { renderProgressTags } = rendererWithTranslations();

  const html = renderProgressTags({
    final_clear_count: 3,
    phase_progress: [{ order: 1, display_text: 'P1 12%' }],
  });

  assert.equal(html, '<span class="tag tag-clear" title="Clears: 3">\u27053</span>');
  assert.doesNotMatch(html, /tag-phase|P1 12%/);
});

test('source phase progress suppresses final boss progress when both are present', () => {
  const { renderProgressTags } = rendererWithTranslations();

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

test('source phase progress renders only highest-order phase from unsorted progress', () => {
  const { renderPhaseProgress, renderProgressTags } = rendererWithTranslations();
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

test('source phase progress picks lower boss HP when highest phase order ties', () => {
  const { renderPhaseProgress, renderProgressTags } = rendererWithTranslations();
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

test('source phase progress ignores non-phase labels from stale cached payloads', () => {
  const { renderPhaseProgress, renderProgressTags } = rendererWithTranslations();
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

test('source malformed phase order does not block later finite phase progress', () => {
  const { renderPhaseProgress, renderProgressTags } = rendererWithTranslations();
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

test('source phase progress text is escaped in content and title for the chosen highest-order phase', () => {
  const { renderPhaseProgress } = rendererWithTranslations();

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
