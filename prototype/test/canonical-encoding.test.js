'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const core = require('../src/core');

// ---------------------------------------------------------------------
// §3.4: encoders MUST produce RFC 8949 §4.2.1 deterministic CBOR. These
// tests exist to prove the specific property the rule is for — that a
// content hash like group_id (§4.1) means "same logical content" across
// independent encoders, not just "same encoder, same run" — rather than
// just asserting it in prose.
// ---------------------------------------------------------------------

test('two Records built from the same fields in different insertion order encode to identical bytes', () => {
  // Simulates two independent encoders (e.g. different languages/library
  // implementations) that happen to iterate a Record's fields in different
  // orders — insertion order, alphabetical, whatever their own Map/dict
  // type defaults to. Neither is "wrong"; §3.4 exists so it doesn't matter.
  const bytesA = core.encodeRecordBytes({
    typeId: 100,
    fields: new Map([
      [6, 2],
      [2, 'SSID'],
      [4, 'pass'],
    ]),
  });
  const bytesB = core.encodeRecordBytes({
    typeId: 100,
    fields: new Map([
      [4, 'pass'],
      [2, 'SSID'],
      [6, 2],
    ]),
  });

  assert.deepEqual(bytesA, bytesB);
});

test('group_id-style content hashing agrees across independently-ordered encodings of the same content', () => {
  const hash = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

  // A close analogue to a real Split fragment map (§4.1's Type 2), built
  // in two different field orders the way two unrelated implementations
  // plausibly would.
  const groupId = crypto.randomBytes(32);
  const fragA = core.encodeRecordBytes({
    typeId: 2,
    fields: new Map([
      [2, groupId],
      [4, 0],
      [6, 1],
      [8, Buffer.from('fragment bytes')],
    ]),
  });
  const fragB = core.encodeRecordBytes({
    typeId: 2,
    fields: new Map([
      [8, Buffer.from('fragment bytes')],
      [6, 1],
      [4, 0],
      [2, groupId],
    ]),
  });
  assert.equal(hash(fragA), hash(fragB));
});

test('shortest-form integer encoding is applied regardless of which JS number literal produced it', () => {
  // CBOR permits multiple valid encodings of the same integer value (a
  // longer-than-necessary argument width); §3.4 requires the shortest one.
  // The `cbor` package always picks the shortest form on encode, so this
  // mainly documents the property rather than forcing it — but it's the
  // exact class of divergence §3.4 rules out for any encoder that doesn't.
  const bytes = core.encodeRecordBytes({ typeId: 100, fields: new Map([[2, 24]]) });
  // key 2 (0x02), then value 24 in its shortest CBOR form: 0x18 0x18
  // (major type 0, one-byte argument) — never a padded multi-byte form.
  const valueBytes = bytes.subarray(bytes.length - 2);
  assert.deepEqual(valueBytes, Buffer.from([0x18, 0x18]));
});
