const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const spritePath = path.join(__dirname, '..', 'public', 'assets', 'job-icons.svg');
const sprite = fs.readFileSync(spritePath, 'utf8');
const roleSpritePath = path.join(__dirname, '..', 'public', 'assets', 'role-icons.svg');
const roleSprite = fs.readFileSync(roleSpritePath, 'utf8');

function assertCleanEmbeddedPngs(svgContent, spriteName, expectedDimensions = null) {
  const matches = [...svgContent.matchAll(/data:image\/png;base64,([^"']+)/g)];
  assert.ok(matches.length > 0, `expected embedded PNGs inside ${spriteName}`);

  const ancillaryTypes = new Set(['iTXt', 'zTXt', 'tEXt', 'iCCP', 'eXIf', 'pHYs', 'tIME']);
  for (const match of matches) {
    const buf = Buffer.from(match[1], 'base64');
    assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    let offset = 8;
    while (offset + 12 <= buf.length) {
      const length = buf.readUInt32BE(offset);
      const type = buf.subarray(offset + 4, offset + 8).toString('ascii');
      assert.equal(ancillaryTypes.has(type), false, `unexpected PNG chunk ${type} inside ${spriteName}`);
      if (type === 'IHDR' && expectedDimensions) {
        assert.equal(buf.readUInt32BE(offset + 8), expectedDimensions.width);
        assert.equal(buf.readUInt32BE(offset + 12), expectedDimensions.height);
      }
      offset += 12 + length;
      if (type === 'IEND') break;
    }
  }
  return matches.length;
}

test('generated job icon sprite contains every Set 10 (Large) job and the Beastmaster placeholder', () => {
  const codes = [
    'BRD', 'DRG', 'MNK', 'PLD', 'WAR', 'BLM', 'WHM', 'SCH', 'SMN', 'NIN', 'AST',
    'DRK', 'MCH', 'RDM', 'SAM', 'BLU', 'GNB', 'DNC', 'RPR', 'SGE', 'VPR', 'PCT', 'BST',
  ];

  for (const code of codes) {
    assert.ok(sprite.includes(`<symbol id="${code}"`), `missing ${code} sprite symbol`);
  }
  assert.equal((sprite.match(/<symbol\b/g) || []).length, codes.length);
  assert.match(sprite, /<symbol id="BST"[^>]*aria-label="Beastmaster icon placeholder"[\s\S]*?rx="14"[\s\S]*?<ellipse/);
  assert.doesNotMatch(sprite, /<symbol id="BST"[\s\S]*?url\(#/);
  assert.equal((sprite.match(/data:image\/png;base64,/g) || []).length, codes.length - 1);
});

test('embedded PNG sprites strip ancillary PNG metadata chunks', () => {
  const count = assertCleanEmbeddedPngs(sprite, 'job-icons.svg');
  assert.ok(count >= 22);
});

test('generated role icon sprite contains FFXIV generic role symbols with clean 56x56 PNGs', () => {
  const ids = [...roleSprite.matchAll(/<symbol id="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['ROLE_TANK', 'ROLE_HEALER', 'ROLE_DPS']);
  assert.equal(assertCleanEmbeddedPngs(roleSprite, 'role-icons.svg', { width: 56, height: 56 }), 3);
  assert.equal(fs.existsSync(`${roleSpritePath}.br`), true, 'expected precompressed role-icons.svg.br');
  assert.equal(fs.existsSync(`${roleSpritePath}.gz`), true, 'expected precompressed role-icons.svg.gz');
});

test('icons.svg is trimmed to only the four UI icons actually referenced', () => {
  const iconsSvg = fs.readFileSync(path.join(__dirname, '..', 'public', 'assets', 'icons.svg'), 'utf8');
  const ids = [...iconsSvg.matchAll(/<symbol id="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['clock', 'stopwatch', 'user', 'sphere']);
  assert.equal(new Set(ids).size, 4);
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
  assert.match(renderer, /\/assets\/role-icons\.svg#\$\{symbolId\}/);
  assert.equal(packageJson.scripts['sync:job-icons'], 'node scripts/sync-job-icons.js');
  assert.equal(packageJson.scripts['sync:role-icons'], 'node scripts/sync-role-icons.js');
});

test('limited jobs are grouped immediately after magical ranged jobs', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'listings.html'), 'utf8');
  const rolesStart = html.indexOf('<div class="roles" id="role-filter">');
  const rolesEnd = html.indexOf('<!-- Objective -->', rolesStart);
  assert.ok(rolesStart >= 0 && rolesEnd > rolesStart, 'role filter section should precede Objective section');
  const roles = html.slice(rolesStart, rolesEnd);
  const groups = [...roles.matchAll(/class="role-group-toggle"[^>]*data-i18n="([^"]+)"/g)].map((match) => match[1]);
  const magicalRangedIndex = groups.indexOf('magical_ranged');
  const limitedJobIndex = groups.indexOf('limited_job');

  assert.ok(magicalRangedIndex >= 0, 'magical ranged group should exist');
  assert.equal(limitedJobIndex, magicalRangedIndex + 1, 'limited jobs should immediately follow magical ranged jobs');
  const limitedGroup = roles.slice(roles.indexOf('data-i18n="limited_job"'));
  assert.ok(limitedGroup.indexOf('id="BLU"') >= 0, 'Blue Mage should be in Limited Job');
  assert.ok(limitedGroup.indexOf('id="BST"') >= 0, 'Beastmaster should be in Limited Job');
  assert.equal((html.match(/id="BLU"/g) || []).length, 1, 'Blue Mage should not be duplicated in another group');
});
