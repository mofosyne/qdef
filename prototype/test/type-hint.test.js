'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('../src/core');
const { PRIVATE_USE_RANDOM_FLOOR, deriveHashId, verifyTypeHint } = require('../src/typeHint');

// ---------------------------------------------------------------------
// §3.1: Type Hint (key 1) is a globally-reserved odd/optional key, not a
// new core mechanism. These tests exist to prove that claim, not just
// assert it: a decoder with zero knowledge of Type Hint must handle it
// through the exact same unrecognized-odd-key path as any other field it
// doesn't understand.
// ---------------------------------------------------------------------

test('a string Type Hint on a private-use-random Type ID is silently ignored by a decoder that has never heard of key 1', () => {
  const typeId = 0x1a2b3c4d; // above PRIVATE_USE_RANDOM_FLOOR
  const container = core.encodeContainer([
    {
      typeId,
      fields: new Map([
        [2, 'some application-specific payload'],
        [1, 'com.example/wifi-badge-v1'], // Type Hint: name, since key 0 is self-assigned
      ]),
    },
  ]);

  const { records } = core.decodeContainer(container);
  // A decoder that only knows this application's own field (key 2) — no
  // special-case code for key 1 at all.
  const rec = core.applyCriticality(records[0], new Set([0, 2]));

  assert.equal(rec.aborted, false);
  assert.deepEqual(rec.ignoredKeys, [1]);
  assert.equal(rec.map.get(2), 'some application-specific payload');
  // A Type-Hint-aware layer, separately, can still read it back out.
  assert.equal(rec.map.get(1), 'com.example/wifi-badge-v1');
});

test('a uint Type Hint on a registered Type ID (the legacy pre-promotion ID) round-trips the same way', () => {
  const typeId = 150; // below PRIVATE_USE_RANDOM_FLOOR: this Type was promoted
  const legacyId = 0x1a2b3c4d; // what this Type used to be known by
  const container = core.encodeContainer([
    {
      typeId,
      fields: new Map([
        [2, 'some application-specific payload'],
        [1, legacyId], // Type Hint: legacy ID, since key 0 is now registered
      ]),
    },
  ]);

  const { records } = core.decodeContainer(container);
  const rec = core.applyCriticality(records[0], new Set([0, 2]));

  assert.equal(rec.aborted, false);
  assert.deepEqual(rec.ignoredKeys, [1]);
  assert.equal(rec.map.get(1), legacyId);
});

test('a pre-promotion reader recognizes a promoted Type by checking key 1 against its own known-legacy-ID table', () => {
  const promotedTypeId = 150;
  const legacyId = 0x1a2b3c4d;
  const container = core.encodeContainer([
    {
      typeId: promotedTypeId,
      fields: new Map([[2, 'payload'], [1, legacyId]]),
    },
  ]);

  const { records } = core.decodeContainer(container);
  const rec = records[0];

  // This reader's dispatch table predates the promotion: it has no entry
  // for 150, only for the old random ID.
  const OLD_READER_KNOWN_TYPES = new Set([legacyId]);
  assert.equal(OLD_READER_KNOWN_TYPES.has(rec.typeId), false);

  const hint = rec.map.get(1);
  assert.equal(OLD_READER_KNOWN_TYPES.has(hint), true);
});

// ---------------------------------------------------------------------
// The optional, self-certifying strengthening: deriving a private-use-
// random Type ID from a hash of its own name. No version bit needed — the
// check is opportunistic and degrades gracefully either way.
// ---------------------------------------------------------------------

test('a hash-derived Type ID verifies against its own Type Hint name', () => {
  const name = 'com.example/wifi-badge-v1';
  const typeId = deriveHashId(name);
  assert.ok(typeId >= PRIVATE_USE_RANDOM_FLOOR);

  assert.equal(verifyTypeHint(typeId, name), 'verified');
});

test('a pure-random Type ID with an unrelated name degrades to unverified, not an error', () => {
  const typeId = 0x1a2b3c4d; // not derived from any hash
  const unrelatedName = 'com.example/totally-different-name';

  assert.equal(verifyTypeHint(typeId, unrelatedName), 'unverified');
});

test('verification is not-applicable for a registered (low) Type ID or a non-string hint', () => {
  assert.equal(verifyTypeHint(150, 'com.example/wifi-badge-v1'), 'not-applicable');
  assert.equal(verifyTypeHint(0x1a2b3c4d, 0x1a2b3c4d), 'not-applicable');
});
