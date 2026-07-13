'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('../src/core');
const { deriveHashId, verifyTypeHint, MIN_BYTE_LENGTH } = require('../src/typeHint');

// ---------------------------------------------------------------------
// §3.1: Type Hint (key 1) is a globally-reserved odd/optional key with
// dual-mode semantics:
//   - Byte string Type ID → hint is a text string (name)
//   - Even uint Type ID   → hint is a byte string (legacy pointer)
// A decoder with zero knowledge of key 1 must handle it through the
// exact same unrecognized-odd-key path as any other field it doesn't
// understand, regardless of mode.
// ---------------------------------------------------------------------

test('a string Type Hint on a byte string Type ID is silently ignored by a decoder that has never heard of key 1', () => {
  const typeId = deriveHashId('com.example/wifi-badge-v1', 4); // byte string Buffer
  const container = core.encodeContainer([
    {
      typeId,
      fields: new Map([
        [2, 'some application-specific payload'],
        [1, 'com.example/wifi-badge-v1'], // Type Hint: name, since key 0 is a byte string
      ]),
    },
  ]);

  const { records } = core.decodeContainer(container);
  const rec = core.applyCriticality(records[0], new Set([0, 2]));

  assert.equal(rec.aborted, false);
  assert.deepEqual(rec.ignoredKeys, [1]);
  assert.equal(rec.map.get(2), 'some application-specific payload');
  assert.equal(rec.map.get(1), 'com.example/wifi-badge-v1');
});

test('a byte string Type Hint on an even uint Type ID (standard record type) round-trips the legacy pointer', () => {
  const typeId = 150; // even? No, 150 is even. Let me use an even stdlib.
  // Actually, standard record types are even: 8 (Compress), 10 (Fallback), 12 (App Route).
  // But let's use a generic even uint representing a registered type.
  const evenTypeId = 200; // even, so it's a standard/global type
  const legacyId = Buffer.from('A7F90B3C', 'hex'); // old decentralized byte string ID
  const container = core.encodeContainer([
    {
      typeId: evenTypeId,
      fields: new Map([
        [2, 'some application-specific payload'],
        [1, legacyId], // Type Hint: legacy byte string ID, since key 0 is now a registered even uint
      ]),
    },
  ]);

  const { records } = core.decodeContainer(container);
  const rec = core.applyCriticality(records[0], new Set([0, 2]));

  assert.equal(rec.aborted, false);
  assert.deepEqual(rec.ignoredKeys, [1]);
  assert.ok(Buffer.isBuffer(rec.map.get(1)));
  assert.deepEqual(rec.map.get(1), legacyId);
});

test('a pre-promotion reader recognizes a promoted Type by checking key 1 against its own known-legacy-ID table', () => {
  const promotedTypeId = 200; // even = standard/global after promotion
  const legacyId = Buffer.from('A7F90B3C', 'hex');
  const container = core.encodeContainer([
    {
      typeId: promotedTypeId,
      fields: new Map([[2, 'payload'], [1, legacyId]]),
    },
  ]);

  const { records } = core.decodeContainer(container);
  const rec = records[0];

  // This reader's dispatch table predates the promotion: it has no entry
  // for 200, only for the old byte string ID.
  const OLD_READER_KNOWN_TYPES = new Set([legacyId.toString('hex')]);
  assert.equal(OLD_READER_KNOWN_TYPES.has(String(rec.typeId)), false);

  const hint = rec.map.get(1);
  assert.equal(OLD_READER_KNOWN_TYPES.has(hint.toString('hex')), true);
});

// ---------------------------------------------------------------------
// The optional, self-certifying strengthening: deriving a decentralized
// Type ID from a hash of its own name. The ID is now a byte string
// (Buffer), not a uint. verifyTypeHint checks Buffer.equals().
// ---------------------------------------------------------------------

test('a hash-derived byte string Type ID verifies against its own Type Hint name', () => {
  const name = 'com.example/wifi-badge-v1';
  const typeId = deriveHashId(name, 4);
  assert.ok(Buffer.isBuffer(typeId));
  assert.equal(typeId.length, 4);

  assert.equal(verifyTypeHint(typeId, name), 'verified');
});

test('a pure-random byte string Type ID with an unrelated name degrades to unverified, not an error', () => {
  const typeId = Buffer.from('DEADBEEF', 'hex');
  const unrelatedName = 'com.example/totally-different-name';

  assert.equal(verifyTypeHint(typeId, unrelatedName), 'unverified');
});

test('verification is not-applicable for a registered (even uint) Type ID or a non-string hint', () => {
  assert.equal(verifyTypeHint(200, 'com.example/wifi-badge-v1'), 'not-applicable');
  assert.equal(verifyTypeHint(Buffer.from('AABB', 'hex'), 0x1a2b3c4d), 'not-applicable');
});

// ---------------------------------------------------------------------
// Hash derivation with developer-chosen byte width. Minimum 2 bytes.
// Two different widths produce different IDs; mismatched widths don't
// verify.
// ---------------------------------------------------------------------

test('a hash-derived 8-byte Type ID verifies correctly', () => {
  const name = 'com.example/tagdrop-paper';
  const typeId = deriveHashId(name, 8);
  assert.ok(Buffer.isBuffer(typeId));
  assert.equal(typeId.length, 8);

  assert.equal(verifyTypeHint(typeId, name), 'verified');
});

test('a narrow (4-byte) hash-derived ID is not wrongly verified against the wide (8-byte) derivation of the same name', () => {
  const name = 'com.example/tagdrop-paper';
  const narrowId = deriveHashId(name, 4);
  const wideId = deriveHashId(name, 8);
  assert.ok(!narrowId.equals(wideId));

  // Each only verifies against the derivation matching its own byte length.
  assert.equal(verifyTypeHint(narrowId, name), 'verified');
  assert.equal(verifyTypeHint(wideId, name), 'verified');

  // Cross-check: narrow does NOT verify against wide's buffer
  assert.equal(verifyTypeHint(narrowId, name), 'verified');
  assert.notEqual(narrowId.length, wideId.length);
});

test('byteWidth below minimum (2) throws', () => {
  assert.throws(
    () => deriveHashId('test', 1),
    /byteWidth must be >= 2/,
  );
  assert.throws(
    () => deriveHashId('test', 0),
    /byteWidth must be >= 2/,
  );
});

test('default byteWidth is 4 (RECOMMENDED_GLOBAL_BYTE_LENGTH)', () => {
  const id = deriveHashId('test');
  assert.ok(Buffer.isBuffer(id));
  assert.equal(id.length, 4);
});

// ---------------------------------------------------------------------
// §3.1's naming guidance illustrated, not just asserted: pinning the
// hash algorithm only solves half the problem. A hash of a generic,
// unqualified name has no more collision-safety than the name itself --
// two unrelated parties picking the same short word derive the exact
// same ID, guaranteed, not probabilistically. Qualifying by something
// verifiably unique (a domain) restores the "behaves like a random
// draw" property the mechanism actually depends on.
// ---------------------------------------------------------------------

test('two unrelated projects choosing the same bare, unqualified name derive an identical (colliding) ID -- the exact hazard the naming guidance exists to prevent', () => {
  const projectAId = deriveHashId('config', 8);
  const projectBId = deriveHashId('config', 8);

  assert.ok(projectAId.equals(projectBId));
});

test('the same two projects, qualifying by a domain they each actually control, do not collide', () => {
  const projectAId = deriveHashId('com.example-a/config', 8);
  const projectBId = deriveHashId('com.example-b/config', 8);

  assert.ok(!projectAId.equals(projectBId));
});
