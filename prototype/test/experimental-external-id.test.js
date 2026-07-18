'use strict';
// EXPERIMENTAL -- prototyping only, not a spec decision. Checking
// feasibility of an NDEF-ID-style external-reference identifier,
// structurally separate from typeIds (unlike Fallback Hint's language/
// action fields, which are ordinary field-map keys owned by that one
// Record Type). If QDEF ever wanted a true NDEF-ID equivalent -- "any
// Record gets a stable, type-independent identity something outside
// the container can reference" -- it would need to live in the
// Record's own structure (next to the prefix typeIDs), not in any one
// Type's field map, the same way NDEF's own ID field sits in the common
// record header rather than being redefined per-RTD.
//
// The question this file checks: can that be added additively, without
// displacing backup typeIDs (§3.1's promotion pattern) or reopening the
// CBOR-tag-collision risk already rejected twice elsewhere? Verified
// here structurally; no decision has been made to actually adopt this.

const test = require('node:test');
const assert = require('node:assert/strict');
const cbor = require('cbor');

const core = require('../src/core');

test('a Record with only an external ID (no typeID at all) is still unroutable -- external ID is not a substitute for a typeID', () => {
  // Built manually since encodeRecordBytes requires a non-empty typeIds
  // array -- this checks the parser's own behavior if an external-ID
  // wrapper appeared with nothing else recognizable before it.
  const bytes = Buffer.concat([
    cbor.encodeCanonical(['ext-1']),
    cbor.encodeCanonical(new Map([[0, 'payload']])),
  ]);
  const [rec] = core.decodeSequence(bytes);
  assert.equal(rec.ignored, true);
  assert.equal(rec.externalId, 'ext-1');
});

test('external ID round-trips alongside an ordinary typeID', () => {
  const bytes = core.encodeRecordBytes({
    typeIds: [100],
    fields: new Map([[0, 'SSID']]),
    externalId: 'wifi-record-1',
  });
  const [rec] = core.decodeSequence(bytes);

  assert.equal(rec.ignored, false);
  assert.equal(rec.typeId, 100);
  assert.equal(rec.externalId, 'wifi-record-1');
  assert.equal(rec.map.get(0), 'SSID');
});

test('external ID coexists with backup typeIDs -- confirming it does not need to displace the promotion pattern', () => {
  const bytes = core.encodeRecordBytes({
    typeIds: [100, Buffer.from('A7F90B3C', 'hex')], // primary + backup
    fields: new Map([[0, 'SSID']]),
    externalId: 'wifi-record-1',
  });
  const [rec] = core.decodeSequence(bytes);

  assert.equal(rec.ignored, false);
  assert.equal(rec.typeId, 100);
  assert.equal(rec.typeIds.length, 2);
  assert.ok(rec.typeIds[1].equals(Buffer.from('A7F90B3C', 'hex')));
  assert.equal(rec.externalId, 'wifi-record-1');
});

test('external ID coexists with a namespace-pairing primary typeID -- all three prefix concepts stack cleanly', () => {
  const bytes = core.encodeRecordBytes({
    typeIds: [1],
    fields: new Map([[0, 'payload']]),
    localNamespace: Buffer.from('cdcdcdcd', 'hex'),
    externalId: 'scoped-record-1',
  });
  const [rec] = core.decodeSequence(bytes);

  assert.equal(rec.ignored, false);
  assert.equal(rec.typeId, 1);
  assert.ok(rec.localNamespace.equals(Buffer.from('cdcdcdcd', 'hex')));
  assert.equal(rec.externalId, 'scoped-record-1');
});

test('a Record with no external ID has the field undefined -- zero-cost when unused, same as every other optional prefix concept', () => {
  const bytes = core.encodeRecordBytes({
    typeIds: [100],
    fields: new Map([[0, 'SSID']]),
  });
  const [rec] = core.decodeSequence(bytes);
  assert.equal(rec.externalId, undefined);
});

test('array length alone disambiguates external-ID (1 element) from namespace-pairing (2 elements) with no ambiguity', () => {
  const withExternalId = core.encodeRecordBytes({
    typeIds: [100],
    fields: new Map(),
    externalId: 'x',
  });
  const withPairing = core.encodeRecordBytes({
    typeIds: [1],
    fields: new Map(),
    localNamespace: 500,
  });

  const [recA] = core.decodeSequence(withExternalId);
  const [recB] = core.decodeSequence(withPairing);

  assert.equal(recA.externalId, 'x');
  assert.equal(recA.localNamespace, undefined);
  assert.equal(recB.externalId, undefined);
  assert.equal(recB.localNamespace, 500);
});

test('FINDING: byte cost of the external-ID wrapper alone, verified against the real encoder', () => {
  const bareId = cbor.encodeCanonical(['wifi-record-1']).length;
  // 1-element array header (1 byte for short arrays) + text string
  // header+content. Confirms the shape doesn't carry unexpected overhead
  // beyond an ordinary CBOR array-of-one-string.
  assert.equal(bareId, cbor.encodeCanonical('wifi-record-1').length + 1);
});
