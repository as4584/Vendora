import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

const script = fileURLToPath(new URL('./check-subscription-review-screenshots.mjs', import.meta.url));
const filenames = ['com.vendora.pro.monthly.png', 'com.vendora.pro.yearly.png', 'com.vendora.partner.monthly.png'];

function chunk(type, data = Buffer.alloc(0)) {
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length);
  result.write(type, 4, 'ascii');
  data.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4);
  return result;
}

// Blank, synthetic PNG fixtures only. These are not App Review assets.
function png(width, height, { alpha = false, transparency = false } = {}) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = alpha ? 6 : 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    ...(transparency ? [chunk('tRNS', Buffer.alloc(6))] : []),
    chunk('IDAT', deflateSync(Buffer.alloc(height * (width * (alpha ? 4 : 3) + 1)))),
    chunk('IEND'),
  ]);
}

function run(t, images) {
  const folder = mkdtempSync(join(tmpdir(), 'vendora-review-screenshots-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  for (const [index, image] of images.entries()) {
    if (image) writeFileSync(join(folder, filenames[index]), image);
  }
  const result = spawnSync(process.execPath, [script, folder], { encoding: 'utf8' });
  assert.ifError(result.error);
  return result;
}

test('passes only when all three expected files are valid at documented portrait sizes', (t) => {
  const { status, stdout, stderr } = run(t, [png(1179, 2556), png(1290, 2796), png(1320, 2868)]);
  assert.equal(status, 0, stderr);
  for (const name of filenames) assert.ok(stdout.includes(`OK ${name}:`));
  assert.match(stdout, /Visually confirm each native offer/);
});

test('fails and reports every missing product', (t) => {
  const { status, stdout, stderr } = run(t, [png(1179, 2556)]);
  assert.equal(status, 1);
  assert.ok(stdout.includes(`OK ${filenames[0]}:`));
  for (const name of filenames.slice(1)) assert.ok(stderr.includes(`FAIL ${name}: missing`));
  assert.doesNotMatch(stdout, /File checks passed/);
});

test('rejects a landscape capture and an arbitrary resized image', (t) => {
  const { status, stderr } = run(t, [png(2556, 1179), png(100, 200), png(1179, 2556)]);
  assert.equal(status, 1);
  assert.ok(stderr.includes(`FAIL ${filenames[0]}: 2556x1179 is outside`));
  assert.ok(stderr.includes(`FAIL ${filenames[1]}: 100x200 is outside`));
});

test('rejects alpha channels and transparency chunks', (t) => {
  const { status, stderr } = run(t, [png(1179, 2556, { alpha: true }), png(1179, 2556, { transparency: true }), png(1179, 2556)]);
  assert.equal(status, 1);
  assert.ok(stderr.includes(`FAIL ${filenames[0]}: PNG includes an alpha channel`));
  assert.ok(stderr.includes(`FAIL ${filenames[1]}: PNG includes transparency`));
});

test('rejects a renamed non-PNG, truncated PNG, and bad checksum', (t) => {
  const valid = png(1179, 2556);
  const damaged = Buffer.from(valid);
  damaged[29] ^= 1; // IHDR checksum, not the dimensions.
  const { status, stderr } = run(t, [Buffer.from('not an image'), valid.subarray(0, -12), damaged]);
  assert.equal(status, 1);
  assert.ok(stderr.includes(`FAIL ${filenames[0]}: not a PNG`));
  assert.ok(stderr.includes(`FAIL ${filenames[1]}: incomplete or malformed PNG`));
  assert.ok(stderr.includes(`FAIL ${filenames[2]}: PNG checksum mismatch (IHDR)`));
});
