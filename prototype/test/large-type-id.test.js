'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const cbor = require('cbor');

const core = require('../src/core');

// ---------------------------------------------------------------------
// §3.1's `0x10000`+ private-use-random tier and §9's "32- or 64-bit
// random value" recommendation both need a Type ID wider than a JS safe
// integer (2^53 - 1) — which means a BigInt input in this prototype's own
// encoder. Found checking against a real adopter (TagDrop) actually using
// the tier as recommended: the `cbor` npm package's plain `encode()`
// wraps *every* BigInt input in CBOR tag 2 (bignum), regardless of
// magnitude — even one that trivially fits as a native single-byte uint —
// which would violate §3.1 (typeID MUST be a plain uint). See FINDINGS.md
// #14. `core.encodeRecordBytes` uses `cbor.encodeCanonical`, not
// `cbor.encode` — verified separately not to have this bug.
// ---------------------------------------------------------------------

test('cbor.encode (plain, NOT what this prototype uses) always tag-2-wraps a BigInt, confirming the reported bug', () => {
  assert.equal(cbor.encode(100n)[0], 0xc2); // tag 2 (bignum) marker
  assert.equal(cbor.encode(2n ** 64n - 1n)[0], 0xc2);
});

test('a large (BigInt-class) Type ID encodes as a native uint, never a CBOR tag', () => {
  const bigTypeId = 11040522420225562824n;
  const bytes = core.encodeRecordBytes({ typeId: bigTypeId, fields: new Map([[0, 'x']]) });

  // bytes[0] is now this Record's own array header (§3.1's universal
  // per-record array-wrapping); the typeID encoding starts at bytes[1]:
  // major type 0, 8-byte argument (0x1b), never 0xc2 (tag 2, bignum).
  assert.equal(bytes[1], 0x1b); // major type 0, 8-byte argument follows

  const rec = core.decodeRecordBytes(bytes);
  assert.equal(rec.typeId, bigTypeId);
  assert.equal(typeof rec.typeId, 'bigint');
});

test('a small BigInt Type ID also encodes as a native uint, not tag-2', () => {
  const bytes = core.encodeRecordBytes({ typeId: 100n, fields: new Map() });
  // Record array header (1 element: 0x81), typeID 100 as CBOR uint
  // (0x18 0x64). Empty map omitted (saves one byte).
  assert.deepEqual(bytes, Buffer.from([0x81, 0x18, 0x64]));
});

test('a full container carrying a 64-bit-class private-use Type ID round-trips through decodeContainer', () => {
  const bigTypeId = 2n ** 64n - 1n;
  const container = core.encodeContainer({ subrecords: [
    { typeId: bigTypeId, fields: new Map([[0, 'private-use content']]) },
  ] });

  const root = core.decodeContainer(container);
  const records = root.subrecords;
  assert.equal(records.length, 1);
  assert.equal(records[0].typeId, bigTypeId);
  assert.equal(records[0].map.get(0), 'private-use content');
});
