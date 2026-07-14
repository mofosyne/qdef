'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const core = require('../src/core');

// ---------------------------------------------------------------------
// §3.4: encoders MUST produce RFC 8949 §4.2.1 deterministic CBOR.
// ---------------------------------------------------------------------

test('two Records built from the same fields in different insertion order encode to identical bytes', () => {
  const bytesA = core.encodeRecordBytes({
    typeIds: [100],
    fields: new Map([
      [4, 2],
      [0, 'SSID'],
      [2, 'pass'],
    ]),
  });
  const bytesB = core.encodeRecordBytes({
    typeIds: [100],
    fields: new Map([
      [2, 'pass'],
      [0, 'SSID'],
      [4, 2],
    ]),
  });

  assert.deepEqual(bytesA, bytesB);
});

test('group_id-style content hashing agrees across independently-ordered encodings of the same content', () => {
  const hash = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

  const groupId = crypto.randomBytes(32);
  const fragA = core.encodeRecordBytes({
    typeIds: [2],
    fields: new Map([
      [0, groupId],
      [2, 0],
      [4, 1],
      [6, Buffer.from('fragment bytes')],
    ]),
  });
  const fragB = core.encodeRecordBytes({
    typeIds: [2],
    fields: new Map([
      [6, Buffer.from('fragment bytes')],
      [4, 1],
      [2, 0],
      [0, groupId],
    ]),
  });
  assert.equal(hash(fragA), hash(fragB));
});

test('shortest-form integer encoding is applied regardless of which JS number literal produced it', () => {
  const bytes = core.encodeRecordBytes({ typeIds: [100], fields: new Map([[0, 24]]) });
  // typeID 100: 0x18 0x64, then map(1): 0xa1, key 0: 0x00, value 24: 0x18 0x18
  const valueBytes = bytes.subarray(bytes.length - 2);
  assert.deepEqual(valueBytes, Buffer.from([0x18, 0x18]));
});
