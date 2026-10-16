const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const spritePath = path.join(__dirname, '..', 'public', 'assets', 'job-icons.svg');
const sprite = fs.readFileSync(spritePath, 'utf8');

test('generated job icon sprite contains every Set 10 (Large) job and the Beastmaster placeholder', () => {
  const codes = [
    'BRD', 'DRG', 'MNK', 'PLD', 'WAR', 'BLM', 'WHM', 'SCH', 'SMN', 'NIN', 'AST',
    'DRK', 'MCH', 'RDM', 'SAM', 'BLU', 'GNB', 'DNC', 'RPR', 'SGE', 'VPR', 'PCT', 'BST',
  ];

  for (const code of codes) {
    assert.ok(sprite.includes(`<symbol id="${code}"`), `missing ${code} sprite symbol`);
  }
  assert.equal((sprite.match(/<symbol\b/g) || []).length, codes.length);
  assert.match(sprite, /<symbol id="BST"[^>]*aria-label="Beastmaster icon placeholder"[\s\S]*?<ellipse/);
  assert.equal((sprite.match(/data:image\/png;base64,/g) || []).length, codes.length - 1);
});

test('job filters and listing renderers use the generated local sprite', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'listings.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'client', 'listings', 'renderer.js'), 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

  assert.match(html, /\/assets\/job-icons\.svg#PLD/);
  assert.match(html, /id="BST" value="4294967296"/);
  assert.match(html, /\/assets\/job-icons\.svg#BST/);
  assert.match(renderer, /\/assets\/job-icons\.svg#\$\{escapeHtml\(slot\.icon_code\)\}/);
  assert.match(renderer, /\/assets\/job-icons\.svg#\$\{escapeHtml\(member\.job_code\)\}/);
  assert.equal(packageJson.scripts['sync:job-icons'], 'node scripts/sync-job-icons.js');
});

test('limited jobs are grouped immediately after magical ranged jobs', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'listings.html'), 'utf8');
  const rolesStart = html.indexOf('<div class="roles" id="role-filter">');
  const rolesEnd = html.indexOf('<!-- Options 섹션', rolesStart);
  const roles = html.slice(rolesStart, rolesEnd);
  const groups = [...roles.matchAll(/<small data-i18n="([^"]+)"/g)].map((match) => match[1]);
  const magicalRangedIndex = groups.indexOf('magical_ranged');
  const limitedJobIndex = groups.indexOf('limited_job');

  assert.ok(magicalRangedIndex >= 0, 'magical ranged group should exist');
  assert.equal(limitedJobIndex, magicalRangedIndex + 1, 'limited jobs should immediately follow magical ranged jobs');
  const limitedGroup = roles.slice(roles.indexOf('data-i18n="limited_job"'));
  assert.ok(limitedGroup.indexOf('id="BLU"') >= 0, 'Blue Mage should be in Limited Job');
  assert.ok(limitedGroup.indexOf('id="BST"') >= 0, 'Beastmaster should be in Limited Job');
  assert.equal((html.match(/id="BLU"/g) || []).length, 1, 'Blue Mage should not be duplicated in another group');
});
