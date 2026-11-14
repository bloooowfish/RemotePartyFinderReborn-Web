const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SOURCE_URL = 'https://ffxiv.gamerescape.com/wiki/Dictionary_of_Icons';
const OUTPUT_PATH = path.join(__dirname, '..', 'public', 'assets', 'job-icons.svg');
const PLACEHOLDER_CODES = new Set(['BST']);
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const CURL = process.platform === 'win32' ? 'curl.exe' : 'curl';

function download(url) {
  return execFileSync(CURL, [
    '--fail', '--location', '--silent', '--show-error',
    '--user-agent', USER_AGENT,
    url,
  ], { maxBuffer: 20 * 1024 * 1024 });
}

function decodeHtml(value) {
  return value
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function stripMarkup(value) {
  return decodeHtml(value.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function extractJobRows(html) {
  const sectionMatch = html.match(/<h3\b[^>]*>[\s\S]*?Disciple of War\/Magic Job Icons[\s\S]*?<\/h3>\s*<table\b[^>]*>([\s\S]*?)<\/table>/i);
  const tableMatch = sectionMatch && [sectionMatch[0], sectionMatch[1]];
  if (!tableMatch) throw new Error('Could not find the job icon table on Gamer Escape.');

  const rows = [...tableMatch[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
  const cellsFor = (row) => [...row.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((match) => match[1]);
  const headers = cellsFor(rows[0]?.[1] || '').map(stripMarkup);
  const largeColumn = headers.indexOf('Set 10 (Large)');
  if (largeColumn < 0) throw new Error('The Gamer Escape job table no longer has a Set 10 (Large) column.');

  return rows.slice(1).flatMap((match) => {
    const cells = cellsFor(match[1]);
    const jobName = stripMarkup(cells[0] || '');
    const codeMatch = jobName.match(/\(([A-Z0-9]{3})\)/);
    if (!codeMatch) return [];

    const iconCell = cells[largeColumn] || '';
    const imageMatch = iconCell.match(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/i);
    return [{
      code: codeMatch[1],
      name: jobName.replace(/\s*\([A-Z0-9]{3}\)\s*$/, ''),
      imageUrl: imageMatch ? new URL(decodeHtml(imageMatch[1]), SOURCE_URL).href : null,
    }];
  });
}

function readPngDimensions(buffer) {
  if (buffer.length < 24 || buffer.toString('ascii', 1, 4) !== 'PNG') {
    throw new Error('Set 10 (Large) source was not a valid PNG image.');
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function escapeXml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;',
  })[character]);
}

const CRITICAL_PNG_CHUNKS = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function stripPngMetadata(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return buffer;
  }

  const parts = [buffer.subarray(0, 8)];
  let offset = 8;

  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const totalChunkLength = 12 + length;
    if (offset + totalChunkLength > buffer.length) {
      return buffer;
    }
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (CRITICAL_PNG_CHUNKS.has(type)) {
      parts.push(buffer.subarray(offset, offset + totalChunkLength));
    }
    offset += totalChunkLength;
    if (type === 'IEND') break;
  }

  return Buffer.concat(parts);
}

function placeholderSymbol({ code, name }) {
  return `    <symbol id="${code}" viewBox="0 0 84 84" aria-label="${escapeXml(`${name} icon placeholder`)}">
        <rect x="4" y="4" width="76" height="76" rx="14" fill="#2a1f3d" stroke="#c5ab70" stroke-width="3.5"/>
        <rect x="7" y="7" width="70" height="70" rx="11" fill="#3a2956"/>
        <path d="M7 42 h70 v24 a11 11 0 0 1 -11 11 h-48 a11 11 0 0 1 -11 -11 z" fill="#241938"/>
        <rect x="9.5" y="9.5" width="65" height="65" rx="9" fill="none" stroke="#856f42" stroke-width="1.25"/>
        <g fill="#f4efe4">
            <ellipse cx="42" cy="52" rx="13.5" ry="10.5"/>
            <ellipse cx="23.5" cy="39" rx="5.5" ry="7.8" transform="rotate(-18 23.5 39)"/>
            <ellipse cx="35.5" cy="31.5" rx="5.5" ry="7.8" transform="rotate(-7 35.5 31.5)"/>
            <ellipse cx="48.5" cy="31.5" rx="5.5" ry="7.8" transform="rotate(7 48.5 31.5)"/>
            <ellipse cx="60.5" cy="39" rx="5.5" ry="7.8" transform="rotate(18 60.5 39)"/>
        </g>
    </symbol>`;
}

async function imageSymbol(job) {
  let image;
  try {
    image = download(job.imageUrl);
  } catch (error) {
    throw new Error(`${job.code}: icon download failed (${job.imageUrl}): ${error.message}`);
  }
  image = stripPngMetadata(image);
  const { width, height } = readPngDimensions(image);
  const base64 = image.toString('base64');
  return `    <symbol id="${job.code}" viewBox="0 0 ${width} ${height}" aria-label="${escapeXml(job.name)}">
        <image href="data:image/png;base64,${base64}" width="${width}" height="${height}"/>
    </symbol>`;
}

async function main() {
  const jobs = extractJobRows(download(SOURCE_URL).toString('utf8'));
  if (jobs.length === 0) throw new Error('No job icon rows were found in the Gamer Escape table.');

  const symbols = [];
  const seen = new Set();
  for (const job of jobs) {
    if (seen.has(job.code)) throw new Error(`Duplicate job code in Gamer Escape table: ${job.code}`);
    seen.add(job.code);

    if (!job.imageUrl) {
      if (!PLACEHOLDER_CODES.has(job.code)) {
        throw new Error(`${job.code} (${job.name}) has no Set 10 (Large) icon. Add it to PLACEHOLDER_CODES only after review.`);
      }
      symbols.push(placeholderSymbol(job));
      console.log(`${job.code}: generated placeholder (no Set 10 (Large) image on source page)`);
      continue;
    }

    symbols.push(await imageSymbol(job));
  }

  for (const code of PLACEHOLDER_CODES) {
    if (!seen.has(code)) throw new Error(`Expected placeholder job ${code} was not found in the source table.`);
  }

  const output = [
    `<!-- Generated by scripts/sync-job-icons.js from ${SOURCE_URL} (Set 10 (Large)). -->`,
    '<svg xmlns="http://www.w3.org/2000/svg">',
    '  <defs>',
    ...symbols,
    '  </defs>',
    '</svg>',
    '',
  ].join('\n');
  await fs.writeFile(OUTPUT_PATH, output, 'utf8');
  console.log(`Wrote ${jobs.length} job symbols to ${path.relative(process.cwd(), OUTPUT_PATH)}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
