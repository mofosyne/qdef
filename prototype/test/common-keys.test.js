'use strict';
// §3.6's Common Field Key tier: negative integer map keys, interpreted
// the same way regardless of a Record's Type, subject to the same
// even/odd criticality rule (§3.2) as any positive key.

const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('../src/core');
const commonKeys = require('../src/commonKeys');
const wrappers = require('../src/wrappers');

const WIFI_TYPE = 100;
const WIFI_KNOWN_KEYS = new Set([0, 2, 4]);

test('an unrecognized Common Field Key does not abort a Record that has no idea it exists -- all starter keys are odd', () => {
  for (const key of [
    commonKeys.COMMON_KEY_ID,
    commonKeys.COMMON_KEY_UUID,
    commonKeys.COMMON_KEY_DATE,
    commonKeys.COMMON_KEY_LABEL,
    commonKeys.COMMON_KEY_LANGUAGE,
    commonKeys.COMMON_KEY_CONTENT_HASH,
    commonKeys.COMMON_KEY_SOURCE,
    commonKeys.COMMON_KEY_FILENAME,
  ]) {
    assert.equal(key % 2 === 0, false, `${key} must be odd/optional`);

    const bytes = core.encodeRecordBytes({
      typeId: WIFI_TYPE,
      fields: new Map([[0, 'SSID'], [2, 'pass'], [4, 2], [key, 'a common field value']]),
    });
    const rec = core.applyCriticality(core.decodeRecordBytes(bytes), WIFI_KNOWN_KEYS);
    assert.equal(rec.aborted, false);
    assert.deepEqual(rec.ignoredKeys, [key]);
  }
});

test('an unrecognized EVEN negative key still aborts, exactly like an unrecognized even positive key', () => {
  const bytes = core.encodeRecordBytes({
    typeId: WIFI_TYPE,
    fields: new Map([[0, 'SSID'], [2, 'pass'], [4, 2], [-2, 'a hypothetical future critical common field']]),
  });
  const rec = core.applyCriticality(core.decodeRecordBytes(bytes), WIFI_KNOWN_KEYS);
  assert.equal(rec.aborted, true);
  assert.equal(rec.abortReason, 'unrecognized critical (even) key -2');
});

test('a Type recognizing a Common Field Key reads it like any other known key, with zero collision risk against its own positive keys', () => {
  const KNOWN_KEYS_INCLUDING_ID = new Set([0, 2, 4, commonKeys.COMMON_KEY_ID]);
  const bytes = core.encodeRecordBytes({
    typeId: WIFI_TYPE,
    fields: new Map([
      [0, 'SSID'],
      [2, 'pass'],
      [4, 2],
      [commonKeys.COMMON_KEY_ID, 'correlates-with-another-record'],
    ]),
  });
  const rec = core.applyCriticality(core.decodeRecordBytes(bytes), KNOWN_KEYS_INCLUDING_ID);
  assert.equal(rec.aborted, false);
  assert.deepEqual(rec.ignoredKeys, []);
  assert.equal(rec.map.get(commonKeys.COMMON_KEY_ID), 'correlates-with-another-record');
  assert.equal(rec.map.get(0), 'SSID');
});

test('COMMON_KEY_ID round-trips as an NDEF-ID-equivalent correlation token between two otherwise-unrelated Records', () => {
  const sharedId = Buffer.from('order-4471');
  // Two co-equal top-level Records under the NDEF/own-URI path fall
  // back to typeId's default (Bundle) at the root, same as under magic
  // (see docs/DESIGN.md's "Self-delimited root").
  const seq = core.encodeRecordBytes({
    subrecords: [
      {
        typeId: WIFI_TYPE,
        fields: new Map([[0, 'SSID'], [2, 'pass'], [4, 2], [commonKeys.COMMON_KEY_ID, sharedId]]),
      },
      {
        typeId: wrappers.MEDIA_PAYLOAD_TYPE,
        fields: new Map([[0, 'text/plain'], [commonKeys.COMMON_KEY_ID, sharedId]]),
      },
    ],
  });

  const [a, b] = core.decodeSequence(seq).subrecords;
  assert.ok(a.map.get(commonKeys.COMMON_KEY_ID).equals(sharedId));
  assert.ok(b.map.get(commonKeys.COMMON_KEY_ID).equals(sharedId));
});

test('COMMON_KEY_UUID round-trips as a 16-byte binary UUID, formatted for display only', () => {
  const uuid = commonKeys.randomUuidBytes();
  assert.equal(uuid.length, 16);

  const bytes = core.encodeRecordBytes({
    typeId: WIFI_TYPE,
    fields: new Map([[0, 'SSID'], [2, 'pass'], [4, 2], [commonKeys.COMMON_KEY_UUID, uuid]]),
  });
  const rec = core.decodeRecordBytes(bytes);
  assert.ok(rec.map.get(commonKeys.COMMON_KEY_UUID).equals(uuid));

  const formatted = commonKeys.uuidBytesToString(uuid);
  assert.match(formatted, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test('COMMON_KEY_DATE reuses CBOR tag 0/1, no new date format invented', () => {
  const cbor = require('cbor');
  const asRfc3339 = new cbor.Tagged(0, '2026-07-22T00:00:00Z');
  const asEpoch = new cbor.Tagged(1, 1784064000);

  for (const dateValue of [asRfc3339, asEpoch]) {
    const bytes = core.encodeRecordBytes({
      typeId: WIFI_TYPE,
      fields: new Map([[0, 'SSID'], [2, 'pass'], [4, 2], [commonKeys.COMMON_KEY_DATE, dateValue]]),
    });
    const rec = core.decodeRecordBytes(bytes);
    const decoded = rec.map.get(commonKeys.COMMON_KEY_DATE);
    assert.ok(decoded instanceof Date || typeof decoded === 'object');
  }
});

test('COMMON_KEY_LABEL and COMMON_KEY_LANGUAGE generalize the pattern already duplicated at Open/Hint URI and App Route', () => {
  const bytes = core.encodeRecordBytes({
    typeId: wrappers.MEDIA_PAYLOAD_TYPE,
    fields: new Map([
      [0, 'text/plain'],
      [commonKeys.COMMON_KEY_LABEL, 'Trail Map'],
      [commonKeys.COMMON_KEY_LANGUAGE, 'en'],
    ]),
  });
  const rec = core.decodeRecordBytes(bytes);
  assert.equal(rec.map.get(commonKeys.COMMON_KEY_LABEL), 'Trail Map');
  assert.equal(rec.map.get(commonKeys.COMMON_KEY_LANGUAGE), 'en');
});

test('COMMON_KEY_CONTENT_HASH reuses the exact multihash-style shape Media Preview key 1 already defines', () => {
  const content = Buffer.from('some record content, of any Type');
  const hashPrefix = wrappers.contentHashPrefix(content);

  const bytes = core.encodeRecordBytes({
    typeId: wrappers.MEDIA_PAYLOAD_TYPE,
    fields: new Map([[0, 'text/plain'], [commonKeys.COMMON_KEY_CONTENT_HASH, hashPrefix]]),
    payload: content,
  });
  const rec = core.decodeRecordBytes(bytes);
  const decodedHash = rec.map.get(commonKeys.COMMON_KEY_CONTENT_HASH);
  assert.equal(decodedHash[0], wrappers.MULTIHASH_SHA2_256);
  assert.ok(decodedHash.equals(hashPrefix));
});

test('COMMON_KEY_SOURCE carries provenance, orthogonal to COMMON_KEY_ID -- a Record may carry both with distinct meanings', () => {
  const bytes = core.encodeRecordBytes({
    typeId: wrappers.MEDIA_PAYLOAD_TYPE,
    fields: new Map([
      [0, 'image/jpeg'],
      [commonKeys.COMMON_KEY_ID, Buffer.from('local-correlation-token')],
      [commonKeys.COMMON_KEY_SOURCE, 'https://example.com/originals/photo.jpg'],
    ]),
  });
  const rec = core.decodeRecordBytes(bytes);
  assert.equal(rec.map.get(commonKeys.COMMON_KEY_SOURCE), 'https://example.com/originals/photo.jpg');
  assert.ok(rec.map.get(commonKeys.COMMON_KEY_ID).equals(Buffer.from('local-correlation-token')));
});

test('COMMON_KEY_FILENAME is distinct from COMMON_KEY_LABEL -- machine-facing name vs. human-facing display name', () => {
  const bytes = core.encodeRecordBytes({
    typeId: wrappers.MEDIA_PAYLOAD_TYPE,
    fields: new Map([
      [0, 'image/jpeg'],
      [commonKeys.COMMON_KEY_LABEL, 'Beach sunset'],
      [commonKeys.COMMON_KEY_FILENAME, 'IMG_2043.jpg'],
    ]),
  });
  const rec = core.decodeRecordBytes(bytes);
  assert.equal(rec.map.get(commonKeys.COMMON_KEY_LABEL), 'Beach sunset');
  assert.equal(rec.map.get(commonKeys.COMMON_KEY_FILENAME), 'IMG_2043.jpg');
});
