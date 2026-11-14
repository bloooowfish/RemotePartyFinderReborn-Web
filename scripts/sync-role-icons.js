const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const OUTPUT_PATH = path.join(__dirname, '..', 'public', 'assets', 'role-icons.svg');
const SOURCE_CATEGORY = '060000';
const SOURCE_TEX_PATH = 'ui/uld/LFG_hr1.tex';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const ROLE_ICON_SPECS = [
  { id: 'ROLE_TANK', label: 'Tank role icon', x: 0, y: 216, width: 56, height: 56 },
  { id: 'ROLE_HEALER', label: 'Healer role icon', x: 56, y: 216, width: 56, height: 56 },
  { id: 'ROLE_DPS', label: 'DPS role icon', x: 176, y: 448, width: 56, height: 56 },
];

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
    }
    table[i] = crc >>> 0;
  }
  return table;
})();

/** Compute FFXIV SqPack path hash (lowercase CRC32 without final bitwise NOT). */
function sqHash(value) {
  const lower = value.toLowerCase();
  let crc = 0xffffffff;
  for (let i = 0; i < lower.length; i++) {
    crc = CRC32_TABLE[(crc ^ lower.charCodeAt(i)) & 0xff] ^ (crc >>> 8);
  }
  return crc >>> 0;
}

/** Compute standard PNG chunk CRC32 (with final bitwise NOT). */
function pngCrc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc = CRC32_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Resolve the FFXIV sqpack/ffxiv directory from env, XIVLauncher config, or standard install paths. */
function resolveSqpackDir() {
  const candidates = [];
  if (process.env.FFXIV_SQPACK_DIR) {
    candidates.push(process.env.FFXIV_SQPACK_DIR);
  }

  const appDataDir = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const xlConfigPath = path.join(appDataDir, 'XIVLauncher', 'launcherConfigV3.json');
  if (fs.existsSync(xlConfigPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(xlConfigPath, 'utf8'));
      if (typeof config?.GamePath === 'string' && config.GamePath.trim()) {
        candidates.push(path.join(config.GamePath.trim(), 'game', 'sqpack', 'ffxiv'));
      }
    } catch {
      // Ignore malformed launcher config and fall back to standard install directories.
    }
  }

  candidates.push(
    'D:\\SquareEnix\\FINAL FANTASY XIV - A Realm Reborn\\game\\sqpack\\ffxiv',
    'C:\\Program Files (x86)\\SquareEnix\\FINAL FANTASY XIV - A Realm Reborn\\game\\sqpack\\ffxiv',
  );

  for (const dir of candidates) {
    if (dir && fs.existsSync(path.join(dir, `${SOURCE_CATEGORY}.win32.index`))) {
      return dir;
    }
  }

  throw new Error(
    `Could not locate FFXIV sqpack directory (${SOURCE_CATEGORY}.win32.index). Set FFXIV_SQPACK_DIR to game/sqpack/ffxiv.`
  );
}

/** Find raw SqPack location descriptor for a virtual path in an index file. */
function lookupIndexEntry(indexPath, virtualPath) {
  const slashIndex = virtualPath.lastIndexOf('/');
  if (slashIndex <= 0 || slashIndex >= virtualPath.length - 1) {
    throw new Error(`Invalid SqPack path: ${virtualPath}`);
  }

  const targetDirHash = sqHash(virtualPath.slice(0, slashIndex));
  const targetFileHash = sqHash(virtualPath.slice(slashIndex + 1));

  const indexBuf = fs.readFileSync(indexPath);
  const segOffset = indexBuf.readUInt32LE(0x408);
  const segSize = indexBuf.readUInt32LE(0x40c);

  for (let pos = segOffset; pos + 16 <= segOffset + segSize; pos += 16) {
    const fileHash = indexBuf.readUInt32LE(pos);
    const dirHash = indexBuf.readUInt32LE(pos + 4);
    if (dirHash === targetDirHash && fileHash === targetFileHash) {
      return indexBuf.readUInt32LE(pos + 8);
    }
  }

  throw new Error(`Asset not found in SqPack index: ${virtualPath}`);
}

/** Read and decompress mip 0 of a SqPack type-4 texture file. */
function readSqpackTexture(sqpackDir, category, virtualPath) {
  const indexPath = path.join(sqpackDir, `${category}.win32.index`);
  const raw = lookupIndexEntry(indexPath, virtualPath);

  // Use floating-point arithmetic so offsets >256 MiB avoid 32-bit signed bitwise overflow.
  const datId = (raw % 16) >> 1;
  const offset = (raw - (raw % 16)) * 8;
  const datPath = path.join(sqpackDir, `${category}.win32.dat${datId}`);

  const fd = fs.openSync(datPath, 'r');
  try {
    const header = Buffer.alloc(1024);
    fs.readSync(fd, header, 0, header.length, offset);

    const headerSize = header.readUInt32LE(0);
    const fileType = header.readUInt32LE(4);
    if (fileType !== 4) {
      throw new Error(`Expected SqPack texture (type 4) for ${virtualPath}, got type ${fileType}`);
    }

    const mipCount = header.readUInt32LE(20);
    const texHeader = Buffer.alloc(80);
    fs.readSync(fd, texHeader, 0, texHeader.length, offset + headerSize);

    const format = texHeader.readUInt32LE(4);
    const width = texHeader.readUInt16LE(8);
    const height = texHeader.readUInt16LE(10);

    const compressedOffset = header.readUInt32LE(24);
    const decompressedSize = header.readUInt32LE(32);
    const blockTableStart = header.readUInt32LE(36);
    const numBlocks = header.readUInt32LE(40);

    const out = Buffer.alloc(decompressedSize);
    let currentOffset = offset + headerSize + compressedOffset;
    let outPos = 0;

    for (let block = 0; block < numBlocks; block++) {
      const blockSize = header.readUInt16LE(24 + mipCount * 20 + (blockTableStart + block) * 2);
      const blockHeader = Buffer.alloc(16);
      fs.readSync(fd, blockHeader, 0, blockHeader.length, currentOffset);

      const compressedSize = blockHeader.readUInt32LE(8);
      const uncompressedSize = blockHeader.readUInt32LE(12);

      if (compressedSize < 32000) {
        const compressed = Buffer.alloc(compressedSize);
        fs.readSync(fd, compressed, 0, compressedSize, currentOffset + 16);
        const decoded = zlib.inflateRawSync(compressed);
        decoded.copy(out, outPos);
        outPos += decoded.length;
      } else {
        fs.readSync(fd, out, outPos, uncompressedSize, currentOffset + 16);
        outPos += uncompressedSize;
      }

      currentOffset += blockSize;
    }

    return { format, width, height, data: out };
  } finally {
    fs.closeSync(fd);
  }
}

function unpackRgb565(color) {
  return [
    Math.round(((color >> 11) & 31) * 255 / 31),
    Math.round(((color >> 5) & 63) * 255 / 63),
    Math.round((color & 31) * 255 / 31),
  ];
}

/** Decode BC3/DXT5 blocks into RGBA8888 pixels. */
function decodeBc3(data, width, height) {
  const rgba = Buffer.alloc(width * height * 4);
  const blocksX = Math.ceil(width / 4);
  const blocksY = Math.ceil(height / 4);
  let pos = 0;

  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const a0 = data[pos];
      const a1 = data[pos + 1];
      const alphas = new Uint8Array(8);
      alphas[0] = a0;
      alphas[1] = a1;
      if (a0 > a1) {
        for (let i = 1; i <= 6; i++) {
          alphas[i + 1] = Math.round(((7 - i) * a0 + i * a1) / 7);
        }
      } else {
        for (let i = 1; i <= 4; i++) {
          alphas[i + 1] = Math.round(((5 - i) * a0 + i * a1) / 5);
        }
        alphas[6] = 0;
        alphas[7] = 255;
      }

      let alphaBits = 0n;
      for (let i = 0; i < 6; i++) {
        alphaBits |= BigInt(data[pos + 2 + i]) << BigInt(8 * i);
      }

      const c0 = data.readUInt16LE(pos + 8);
      const c1 = data.readUInt16LE(pos + 10);
      const colorBits = data.readUInt32LE(pos + 12);
      const rgb0 = unpackRgb565(c0);
      const rgb1 = unpackRgb565(c1);
      const palette = [
        rgb0,
        rgb1,
        [
          Math.round((2 * rgb0[0] + rgb1[0]) / 3),
          Math.round((2 * rgb0[1] + rgb1[1]) / 3),
          Math.round((2 * rgb0[2] + rgb1[2]) / 3),
        ],
        [
          Math.round((rgb0[0] + 2 * rgb1[0]) / 3),
          Math.round((rgb0[1] + 2 * rgb1[1]) / 3),
          Math.round((rgb0[2] + 2 * rgb1[2]) / 3),
        ],
      ];

      for (let py = 0; py < 4; py++) {
        for (let px = 0; px < 4; px++) {
          const x = bx * 4 + px;
          const y = by * 4 + py;
          if (x >= width || y >= height) continue;

          const texelIndex = py * 4 + px;
          const alphaIndex = Number((alphaBits >> BigInt(texelIndex * 3)) & 7n);
          const colorIndex = (colorBits >>> (texelIndex * 2)) & 3;
          const dstOffset = (y * width + x) * 4;
          rgba[dstOffset] = palette[colorIndex][0];
          rgba[dstOffset + 1] = palette[colorIndex][1];
          rgba[dstOffset + 2] = palette[colorIndex][2];
          rgba[dstOffset + 3] = alphas[alphaIndex];
        }
      }

      pos += 16;
    }
  }

  return rgba;
}

/** Decode BGRA8888 (0x1450) or BC3/DXT5 (0x3431) texture bytes into RGBA8888. */
function decodeTextureRgba({ format, width, height, data }) {
  if (format === 0x1450) {
    const rgba = Buffer.alloc(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      rgba[i * 4] = data[i * 4 + 2];
      rgba[i * 4 + 1] = data[i * 4 + 1];
      rgba[i * 4 + 2] = data[i * 4];
      rgba[i * 4 + 3] = data[i * 4 + 3];
    }
    return rgba;
  }

  if (format === 0x3431) {
    return decodeBc3(data, width, height);
  }

  throw new Error(`Unsupported SqPack texture format: 0x${format.toString(16)}`);
}

/** Crop an RGBA8888 sub-rectangle from a decoded texture buffer. */
function cropRgba(srcRgba, srcWidth, srcHeight, x, y, width, height) {
  if (x < 0 || y < 0 || x + width > srcWidth || y + height > srcHeight) {
    throw new Error(`Crop (${x},${y} ${width}x${height}) exceeds texture bounds (${srcWidth}x${srcHeight})`);
  }

  const out = Buffer.alloc(width * height * 4);
  for (let row = 0; row < height; row++) {
    const srcStart = ((y + row) * srcWidth + x) * 4;
    const dstStart = row * width * 4;
    srcRgba.copy(out, dstStart, srcStart, srcStart + width * 4);
  }
  return out;
}

function makePngChunk(type, payload) {
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), payload]);
  const lengthBuf = Buffer.alloc(4);
  lengthBuf.writeUInt32BE(payload.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(pngCrc32(typeAndData), 0);
  return Buffer.concat([lengthBuf, typeAndData, crcBuf]);
}

/** Encode RGBA8888 pixels as a minimal PNG containing only IHDR, IDAT, and IEND. */
function encodeRgbaPng(rgba, width, height) {
  const rowBytes = width * 4;
  const rawScanlines = Buffer.alloc((rowBytes + 1) * height);
  for (let row = 0; row < height; row++) {
    const rawRowOffset = row * (rowBytes + 1);
    rawScanlines[rawRowOffset] = 0; // Filter type None
    rgba.copy(rawScanlines, rawRowOffset + 1, row * rowBytes, (row + 1) * rowBytes);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 8-bit depth
  ihdr[9] = 6; // RGBA color type
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const compressed = zlib.deflateSync(rawScanlines, { level: 9 });
  return Buffer.concat([
    PNG_SIGNATURE,
    makePngChunk('IHDR', ihdr),
    makePngChunk('IDAT', compressed),
    makePngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function escapeXml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    '\'': '&apos;',
  })[character]);
}

function main() {
  const sqpackDir = resolveSqpackDir();
  const texture = readSqpackTexture(sqpackDir, SOURCE_CATEGORY, SOURCE_TEX_PATH);
  const rgba = decodeTextureRgba(texture);

  const symbols = ROLE_ICON_SPECS.map((spec) => {
    const cropped = cropRgba(rgba, texture.width, texture.height, spec.x, spec.y, spec.width, spec.height);
    const pngBase64 = encodeRgbaPng(cropped, spec.width, spec.height).toString('base64');
    return [
      `    <symbol id="${spec.id}" viewBox="0 0 ${spec.width} ${spec.height}" aria-label="${escapeXml(spec.label)}">`,
      `        <image href="data:image/png;base64,${pngBase64}" width="${spec.width}" height="${spec.height}"/>`,
      '    </symbol>',
    ].join('\n');
  });

  const output = [
    `<!-- Generated by scripts/sync-role-icons.js from FFXIV ${SOURCE_TEX_PATH}. -->`,
    '<svg xmlns="http://www.w3.org/2000/svg">',
    '  <defs>',
    ...symbols,
    '  </defs>',
    '</svg>',
    '',
  ].join('\n');

  fs.writeFileSync(OUTPUT_PATH, output, 'utf8');
  console.log(`Wrote ${ROLE_ICON_SPECS.length} role symbols from ${SOURCE_TEX_PATH} to ${path.relative(process.cwd(), OUTPUT_PATH)}`);
}

main();
