'use strict';
// EXPERIMENTAL -- prototyping only, not a spec decision. A second,
// competing prototype for the same question experimental-external-id.
// test.js explores: whether QDEF could add a mandatory-core, type-
// independent external-reference identifier (an NDEF-ID equivalent).
//
// Where that file puts the identifier in a *prefix item* (visible before
// Phase 2 even runs), this one puts it in a *reserved negative map key*
// (see CORE_METADATA_KEYS / extractCoreMetadata in core.js). The point of
// this file is a head-to-head comparison, not a preference -- both are
// structurally sound; the tests below are deliberately mirrored against
// experimental-external-id.test.js's scenarios so the two can be read
// side by side.

const test = require('node:test');
const assert = require('node:assert/strict');
const cbor = require('cbor');

const core = require('../src/core');

test('a Record with only a core externalId (no typeID at all) is still unroutable -- same as the prefix-item version', () => {
  const bytes = Buffer.concat([
    cbor.encodeCanonical(new Map([[-1, 'ext-1'], [0, 'payload']])),
  ]);
  const [rec] = core.decodeSequence(bytes);
  assert.equal(rec.ignored, true);
  assert.equal(rec.coreExternalId, 'ext-1');
});

test('core externalId round-trips alongside an ordinary typeID', () => {
  const bytes = core.encodeRecordBytes({
    typeIds: [100],
    fields: new Map([[0, 'SSID']]),
    coreExternalId: 'wifi-record-1',
  });
  const [rec] = core.decodeSequence(bytes);

  assert.equal(rec.ignored, false);
  assert.equal(rec.typeId, 100);
  assert.equal(rec.coreExternalId, 'wifi-record-1');
  assert.equal(rec.map.get(0), 'SSID');
  // Unlike the prefix-item version, the core-metadata key is a real
  // entry in the Type's own map -- a Type-level decoder that doesn't
  // know about -1 still sees it (as an odd, unrecognized-to-it key)
  // unless it's filtered out before Type dispatch.
  assert.equal(rec.map.get(-1), 'wifi-record-1');
});

test('core externalId coexists with backup typeIDs', () => {
  const bytes = core.encodeRecordBytes({
    typeIds: [100, Buffer.from('A7F90B3C', 'hex')],
    fields: new Map([[0, 'SSID']]),
    coreExternalId: 'wifi-record-1',
  });
  const [rec] = core.decodeSequence(bytes);

  assert.equal(rec.ignored, false);
  assert.equal(rec.typeId, 100);
  assert.equal(rec.typeIds.length, 2);
  assert.equal(rec.coreExternalId, 'wifi-record-1');
});

test('core externalId coexists with a namespace-pairing primary typeID', () => {
  const bytes = core.encodeRecordBytes({
    typeIds: [1],
    fields: new Map([[0, 'payload']]),
    localNamespace: Buffer.from('cdcdcdcd', 'hex'),
    coreExternalId: 'scoped-record-1',
  });
  const [rec] = core.decodeSequence(bytes);

  assert.equal(rec.ignored, false);
  assert.equal(rec.typeId, 1);
  assert.ok(rec.localNamespace.equals(Buffer.from('cdcdcdcd', 'hex')));
  assert.equal(rec.coreExternalId, 'scoped-record-1');
});

test('a Record with no core externalId has the field undefined -- zero-cost when unused', () => {
  const bytes = core.encodeRecordBytes({
    typeIds: [100],
    fields: new Map([[0, 'SSID']]),
  });
  const [rec] = core.decodeSequence(bytes);
  assert.equal(rec.coreExternalId, undefined);
  assert.equal(rec.coreAborted, false);
});

test('both experimental mechanisms can be present at once without colliding -- they occupy genuinely different structural slots', () => {
  const bytes = core.encodeRecordBytes({
    typeIds: [100],
    fields: new Map([[0, 'SSID']]),
    externalId: 'prefix-item-id',
    coreExternalId: 'negkey-id',
  });
  const [rec] = core.decodeSequence(bytes);

  assert.equal(rec.externalId, 'prefix-item-id');
  assert.equal(rec.coreExternalId, 'negkey-id');
});

test('an unrecognized EVEN negative key aborts core-level processing for the whole Record -- mandatory-core criticality, not deferred to any Type', () => {
  const bytes = core.encodeRecordBytes({
    typeIds: [100],
    fields: new Map([[0, 'SSID'], [-2, 'unknown critical core field']]),
  });
  const [rec] = core.decodeSequence(bytes);

  assert.equal(rec.coreAborted, true);
  assert.match(rec.coreAbortReason, /-2/);
});

test('an unrecognized ODD negative key is silently ignored at the core level -- same forward-compat rule as any other odd key', () => {
  const bytes = core.encodeRecordBytes({
    typeIds: [100],
    fields: new Map([[0, 'SSID'], [-3, 'unknown optional core field']]),
  });
  const [rec] = core.decodeSequence(bytes);

  assert.equal(rec.coreAborted, false);
  assert.equal(rec.coreExternalId, undefined);
});

test('FINDING: byte cost is identical whether the map is otherwise empty or already has fields -- an earlier hypothesis that the negative-key form "amortizes" cheaper was checked and disproven', () => {
  // Both forms add exactly one byte of framing (an array-of-1 header, or
  // a map-key header for a definite-length negint that fits in one byte)
  // plus the string itself. A CBOR map/array header only grows past one
  // byte once entry/element *count* crosses 23 -- going from 1 to 2
  // entries never does, so there is no amortization to be had here.
  // Cost is a wash; whatever the two forms are actually being chosen
  // between on, it isn't wire size.
  const emptyMapPrefixItem = core
    .encodeRecordBytes({ typeIds: [100], fields: new Map(), externalId: 'wifi-record-1' })
    .length;
  const emptyMapNegKey = core
    .encodeRecordBytes({ typeIds: [100], fields: new Map(), coreExternalId: 'wifi-record-1' })
    .length;
  assert.equal(emptyMapNegKey, emptyMapPrefixItem);

  const nonEmptyMapPrefixItem = core
    .encodeRecordBytes({
      typeIds: [100],
      fields: new Map([[0, 'SSID']]),
      externalId: 'wifi-record-1',
    })
    .length;
  const nonEmptyMapNegKey = core
    .encodeRecordBytes({
      typeIds: [100],
      fields: new Map([[0, 'SSID']]),
      coreExternalId: 'wifi-record-1',
    })
    .length;
  assert.equal(nonEmptyMapNegKey, nonEmptyMapPrefixItem);
});
