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
// which would violate both §3.1 (key 0 MUST be a plain uint) and §3.2's
// field-value-shape rule (a value MUST NOT be a CBOR tag) for exactly the
// field the minimal-core-parser design cares about most. See FINDINGS.md
// #14. `core.encodeRecordBytes` uses `cbor.encodeCanonical`, not
// `cbor.encode` — verified separately not to have this bug — but these
// tests exist so that fact is locked in by a regression test, not just an
// observed side effect of an unrelated change (§3.4's canonical-encoding
// switch) that happened to also fix it.
// ---------------------------------------------------------------------

test('cbor.encode (plain, NOT what this prototype uses) always tag-2-wraps a BigInt, confirming the reported bug', () => {
  // This test documents the bug in the dependency, not in this codebase —
  // it exists so a future reader doesn't have to take the report on
  // faith, and so a regression in the *other* direction (accidentally
  // switching core.js back to plain cbor.encode) would be caught by the
  // tests below, not just by this one passing.
  assert.equal(cbor.encode(100n)[0], 0xc2); // tag 2 (bignum) marker
  assert.equal(cbor.encode(2n ** 64n - 1n)[0], 0xc2);
});

test('a large (BigInt-class) Type ID encodes as a native uint, never a CBOR tag', () => {
  const bigTypeId = 11040522420225562824n; // > Number.MAX_SAFE_INTEGER, needs BigInt in JS
  const bytes = core.encodeRecordBytes({ typeId: bigTypeId, fields: new Map([[2, 'x']]) });

  // Byte 0 is the map header (0xa2); byte 1 is key 0 (0x00); byte 2 is
  // where key 0's *value* starts — must be a native major-type-0 uint
  // (0x00-0x1b range for the head byte), never 0xc2 (tag 2, bignum).
  assert.notEqual(bytes[2], 0xc2);
  assert.equal(bytes[2], 0x1b); // major type 0, 8-byte argument follows

  const rec = core.decodeRecordBytes(bytes);
  assert.equal(rec.typeId, bigTypeId);
  assert.equal(typeof rec.typeId, 'bigint');
});

test('a small BigInt Type ID (the 100n case from the report) also encodes as a native uint, not tag-2', () => {
  const bytes = core.encodeRecordBytes({ typeId: 100n, fields: new Map() });
  assert.deepEqual(bytes, Buffer.from([0xa1, 0x00, 0x18, 0x64])); // map(1), key 0, uint 100 — no tag byte anywhere
});

test('a full container carrying a 64-bit-class private-use Type ID round-trips through decodeContainer', () => {
  const bigTypeId = 2n ** 64n - 1n; // the top of the range §9 recommends for this tier
  const container = core.encodeContainer([
    { typeId: bigTypeId, fields: new Map([[2, 'private-use content']]) },
  ]);

  const { records } = core.decodeContainer(container);
  assert.equal(records.length, 1);
  assert.equal(records[0].typeId, bigTypeId);
  assert.equal(records[0].map.get(2), 'private-use content');
});
