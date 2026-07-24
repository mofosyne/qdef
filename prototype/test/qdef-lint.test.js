'use strict';
// qdef-lint.js: a standalone, dependency-free grammar-and-footgun checker
// that bolts onto any encoder's raw output bytes, not just this
// prototype's own encoder. Two layers, tested separately below:
//   1. Grammar checking -- well-formed per spec §3.1/§2, no Record-Type
//      semantics, mirroring rust/qdef-core's own CBOR primitives.
//   2. Footgun checking -- patterns that are legal CBOR but almost
//      certainly not what the encoder meant, each traced to a real
//      mistake documented in docs/FINDINGS.md.

const test = require('node:test');
const assert = require('node:assert/strict');
const cbor = require('cbor');

const core = require('../src/core');
const { lintRootBytes } = require('../scripts/qdef-lint');

function codes(findings) {
  return findings.map((f) => `${f.severity}:${f.code}`);
}

// ---------------------------------------------------------------------
// Grammar checking: every shape the real encoder produces must lint
// clean -- including the two shapes that motivated dropping the
// "namespace present, typeId absent" footgun check (see below).
// ---------------------------------------------------------------------

test('a single primary Record at the root lints clean', () => {
  const bytes = core.encodeContainer({ typeId: 100, fields: new Map([[0, 'SSID'], [2, 'pass']]) });
  assert.deepEqual(lintRootBytes(bytes), []);
});

test('namespace + typeId + map lints clean', () => {
  const bytes = core.encodeContainer({
    localNamespace: Buffer.from('cdcdcdcd', 'hex'),
    typeId: 1,
    fields: new Map([[0, 'x']]),
  });
  assert.deepEqual(lintRootBytes(bytes), []);
});

test('a Bundle root with subrecords lints clean', () => {
  const bytes = core.encodeContainer({
    typeId: 0,
    subrecords: [
      { typeId: 1, fields: new Map([[0, 'a']]) },
      { typeId: 3, fields: new Map([[0, 'b']]) },
    ],
  });
  assert.deepEqual(lintRootBytes(bytes), []);
});

test('nested subrecords, several levels deep, lint clean', () => {
  const bytes = core.encodeContainer({
    typeId: 0,
    subrecords: [
      {
        typeId: 21,
        fields: new Map(),
        subrecords: [
          {
            typeId: 1,
            localNamespace: Buffer.from('cdcdcdcd', 'hex'),
            fields: new Map([[0, 'payload']]),
            subrecords: [{ typeId: 22, fields: new Map([[0, 'leaf']]) }],
          },
        ],
      },
    ],
  });
  assert.deepEqual(lintRootBytes(bytes), []);
});

test('the NDEF/own-URI path (no magic) lints clean', () => {
  const bytes = core.encodeRecordBytes({ typeId: 100, fields: new Map([[0, 'SSID']]) });
  assert.deepEqual(lintRootBytes(bytes, { hasMagic: false }), []);
});

test('a bare namespace declaration with nothing else lints clean -- not a footgun, the cheapest legitimate shape (spec §3.5)', () => {
  const bytes = core.encodeContainer({ typeId: 0, localNamespace: Buffer.from('a7f90b3c', 'hex') });
  assert.deepEqual(lintRootBytes(bytes), []);
});

test('namespace + hint + one content subrecord (spec §3.5\'s own worked example) lints clean -- typeId is ALWAYS absent for a Bundle root, this is not ambiguous', () => {
  const bytes = core.encodeContainer({
    typeId: 0,
    localNamespace: Buffer.from('a9d6e1f30b7c4482', 'hex'),
    fields: new Map([[3, 'com.example/tagdrop-paper']]),
    subrecords: [{ typeId: 100, fields: new Map([[0, 'SSID']]) }],
  });
  assert.deepEqual(lintRootBytes(bytes), []);
});

test('a bare array field value (legal since the field-value-shape rule was dropped) lints clean', () => {
  const bytes = core.encodeContainer({ typeId: 100, fields: new Map([[0, 'SSID'], [9, [1, 2, 3]]]) });
  assert.deepEqual(lintRootBytes(bytes), []);
});

test('bad magic is a grammar error', () => {
  const findings = lintRootBytes(Buffer.from([0, 0, 0, 0, 0x81, 0x00]));
  assert.deepEqual(codes(findings), ['error:bad-magic']);
});

test('a root that is not a definite-length array is a grammar error', () => {
  const bytes = Buffer.concat([core.MAGIC, cbor.encodeCanonical(100)]);
  assert.deepEqual(codes(lintRootBytes(bytes)), ['error:root-not-array']);
});

test('truncated CBOR is a grammar error, not a crash', () => {
  const bytes = Buffer.concat([core.MAGIC, Buffer.from([0x82, 0x18])]);
  const findings = lintRootBytes(bytes);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'error');
  assert.equal(findings[0].code, 'malformed-cbor');
});

test('bytes appended after the root array are an informational finding, never an error -- the self-delimited-root guarantee (docs/DESIGN.md)', () => {
  const container = core.encodeContainer({ typeId: 100, fields: new Map([[0, 'x']]) });
  const findings = lintRootBytes(Buffer.concat([container, Buffer.from([0xff, 0xff, 0x00])]));
  assert.deepEqual(codes(findings), ['info:trailing-bytes']);
});

// ---------------------------------------------------------------------
// Footgun checking
// ---------------------------------------------------------------------

test('FOOTGUN: a Type ID encoded as a CBOR bignum tag instead of a native uint is flagged (FINDINGS.md #14)', () => {
  const bytes = cbor.encodeCanonical([new cbor.Tagged(2, Buffer.from([0x01, 0x00])), new Map([[0, 'x']])]);
  const findings = lintRootBytes(bytes, { hasMagic: false });
  assert.ok(findings.some((f) => f.code === 'bignum-typeid' && f.severity === 'warning'));
});

test('FOOTGUN: a non-canonical (longer-than-necessary) integer/length encoding is flagged (spec §3.4)', () => {
  // array(1) [ uint(5) encoded as 0x18 0x05 (2 bytes) instead of the
  // canonical single byte 0x05 ]
  const bytes = Buffer.from([0x81, 0x18, 0x05]);
  assert.deepEqual(codes(lintRootBytes(bytes, { hasMagic: false })), ['warning:non-canonical-length']);
});

test('FOOTGUN: a non-canonical array header (the root itself) is flagged exactly once, not duplicated', () => {
  // array(1), header encoded as 0x98 0x01 (2 bytes) instead of the
  // canonical single byte 0x81, containing one uint(0).
  const bytes = Buffer.from([0x98, 0x01, 0x00]);
  assert.deepEqual(codes(lintRootBytes(bytes, { hasMagic: false })), ['warning:non-canonical-length']);
});

test('FOOTGUN: a non-canonical subrecord array header is flagged exactly once, not duplicated', () => {
  // array(1) [ array(1, non-canonically encoded as 0x98 0x01) [ uint(0) ] ]
  const bytes = Buffer.from([0x81, 0x98, 0x01, 0x00]);
  assert.deepEqual(codes(lintRootBytes(bytes, { hasMagic: false })), ['warning:non-canonical-length']);
});

test('FOOTGUN: a duplicate map key is flagged exactly once', () => {
  // [100, {0: 'a', 0: 'b'}]
  const bytes = Buffer.from([0x82, 0x18, 0x64, 0xa2, 0x00, 0x61, 0x61, 0x00, 0x61, 0x62]);
  assert.deepEqual(codes(lintRootBytes(bytes, { hasMagic: false })), ['warning:duplicate-map-key']);
});

test('FOOTGUN: non-canonical map key order is flagged (spec §3.4)', () => {
  // [100, {1: 'a', 0: 'b'}] -- key 1 before key 0, violates RFC 8949 §4.2.1
  const bytes = Buffer.from([0x82, 0x18, 0x64, 0xa2, 0x01, 0x61, 0x61, 0x00, 0x61, 0x62]);
  assert.deepEqual(codes(lintRootBytes(bytes, { hasMagic: false })), ['warning:non-canonical-key-order']);
});

test('FOOTGUN: indefinite-length encoding is flagged (spec §3.4 requires definite-length from a conformant encoder)', () => {
  // [100, (indefinite map) {0: 'a'}]
  const bytes = Buffer.from([0x82, 0x18, 0x64, 0xbf, 0x00, 0x61, 0x61, 0xff]);
  const findings = lintRootBytes(bytes, { hasMagic: false });
  assert.ok(findings.some((f) => f.code === 'indefinite-length'));
});

test('a non-array item in subrecord position is an info-level finding, not an error -- the real decoder silently skips it (spec\'s forward-compat tolerance)', () => {
  // [20, {}, 0, 1] -- typeId 20, empty map, payload 0 (uint), then a
  // stray uint(1) sitting where only arrays are ever reachable.
  const bytes = Buffer.from([0x84, 0x14, 0xa0, 0x00, 0x01]);
  const findings = lintRootBytes(bytes, { hasMagic: false });
  assert.deepEqual(codes(findings), ['info:unreachable-subrecord-slot']);
});

test('"namespace present, typeId absent" is deliberately NOT flagged -- undecidable from bytes alone, and the common case is correct, not a mistake', () => {
  // Both of these are legitimate, spec-documented shapes (bare
  // namespace only; namespace + hint + content) -- covered above by
  // the grammar tests, repeated here to make the *absence* of this
  // check an explicit, intentional claim, not just incidental.
  const bare = core.encodeContainer({ typeId: 0, localNamespace: Buffer.from('a7f90b3c', 'hex') });
  const withContent = core.encodeContainer({
    typeId: 0,
    localNamespace: Buffer.from('a9d6e1f30b7c4482', 'hex'),
    fields: new Map([[3, 'hint']]),
    subrecords: [{ typeId: 100, fields: new Map([[0, 'SSID']]) }],
  });
  assert.deepEqual(lintRootBytes(bare), []);
  assert.deepEqual(lintRootBytes(withContent), []);
});
