import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';

const PRODUCTS = [
  'com.vendora.pro.monthly',
  'com.vendora.pro.yearly',
  'com.vendora.partner.monthly',
];
// Documented capture examples, not the full list of Apple's supported sizes.
const PORTRAIT_SIZES = ['1179x2556', '1290x2796', '1320x2868'];
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function checkPng(data) {
  if (!data.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a PNG');

  let dimensions;
  let imageData = false;
  for (let start = 8; start + 12 <= data.length;) {
    const length = data.readUInt32BE(start);
    const end = start + 12 + length;
    if (end > data.length) break;
    const type = data.toString('ascii', start + 4, start + 8);
    if (crc32(data.subarray(start + 4, end - 4)) !== data.readUInt32BE(end - 4)) {
      throw new Error(`PNG checksum mismatch (${type})`);
    }

    if (start === 8 || type === 'IHDR') {
      if (start !== 8 || type !== 'IHDR' || length !== 13) throw new Error('invalid PNG header');
      dimensions = `${data.readUInt32BE(start + 8)}x${data.readUInt32BE(start + 12)}`;
      if (!PORTRAIT_SIZES.includes(dimensions)) {
        throw new Error(`${dimensions} is outside this preflight's capture sizes (${PORTRAIT_SIZES.join(', ')}); check Apple's specs for your device`);
      }
      if ([4, 6].includes(data[start + 17])) throw new Error('PNG includes an alpha channel');
    }
    if (type === 'tRNS') throw new Error('PNG includes transparency');
    if (type === 'IDAT' && length > 0) imageData = true;
    if (type === 'IEND') {
      if (imageData && length === 0 && end === data.length) return dimensions;
      break;
    }
    start = end;
  }
  throw new Error('incomplete or malformed PNG');
}

const args = process.argv.slice(2);
if (args.length > 1) {
  console.error('Usage: node docs/release/check-subscription-review-screenshots.mjs [capture-folder]');
  process.exitCode = 2;
} else {
  const folder = args[0] ?? fileURLToPath(new URL('../../.app-review/subscriptions/', import.meta.url));
  for (const id of PRODUCTS) {
    const name = `${id}.png`;
    let data;
    try {
      data = readFileSync(join(folder, name));
    } catch (error) {
      console.error(`FAIL ${name}: ${error.code === 'ENOENT' ? 'missing' : 'could not read file'}`);
      process.exitCode = 1;
      continue;
    }
    try {
      console.log(`OK ${name}: ${checkPng(data)} PNG`);
    } catch (error) {
      console.error(`FAIL ${name}: ${error.message}`);
      process.exitCode = 1;
    }
  }
  if (!process.exitCode) console.log('File checks passed. Visually confirm each native offer before manual upload.');
}
