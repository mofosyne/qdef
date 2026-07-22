'use strict';
// §3.1's payload slot: any well-formed CBOR item EXCEPT an array -- the
// same shape rule §3.2 gives field values, minus major type 4. Arrays
// are excluded specifically so a bare array right after the map/typeId
// is always unambiguously the start of subrecords, with no marker
// needed. (Array-shaped payload -- letting payload itself be a nested
// Record -- was tried and reverted; see docs/DESIGN.md and
// docs/FINDINGS.md for why.)

const test = require('node:test');
const assert = require('node:assert/strict');
const cbor = require('cbor');

const core = require('../src/core');

test('payload may be a bare scalar, not just bytes/text', () => {
  const bytes = core.encodeRecordBytes({ typeId: 20, payload: 42 });
  const rec = core.decodeRecordBytes(bytes);
  assert.equal(rec.payload, 42);
  assert.equal(rec.map, null);
  assert.equal(rec.subrecords, undefined);
});

test('an array-shaped payload is rejected outright -- use subrecords to nest a Record', () => {
  assert.throws(() => core.encodeRecordBytes({ typeId: 20, payload: [6, { 0: 'x' }] }), /array-shaped/);
});

test('a leftover record-spec object as payload is rejected, not silently mis-encoded', () => {
  assert.throws(
    () => core.encodeRecordBytes({ typeId: 20, payload: { typeId: 6, fields: new Map() } }),
    /record spec/,
  );
});

test('a lone trailing array is always subrecord 0, never payload -- even when it is the only item following the map', () => {
  const bytes = core.encodeRecordBytes({
    typeId: 20,
    fields: new Map([[0, 'x']]),
    subrecords: [{ typeId: 6, fields: new Map([[0, 'text/plain']]) }],
  });
  const rec = core.decodeRecordBytes(bytes);
  assert.equal(rec.payload, undefined);
  assert.equal(rec.subrecords.length, 1);
  assert.equal(rec.subrecords[0].typeId, 6);
});

test('a map-shaped payload requires the field Map to be explicitly present, even if empty', () => {
  const bytes = core.encodeRecordBytes({
    typeId: 20,
    payload: new Map([[1, 'arbitrary map-shaped payload value']]),
  });
  const rec = core.decodeRecordBytes(bytes);

  // The encoder auto-inserted an empty field Map ahead of the
  // map-shaped payload so major type 5 right after typeId is never
  // ambiguous between "this is the field Map" and "there is no field
  // Map, the payload itself is a map."
  assert.equal(rec.map.size, 0);
  assert.equal(rec.payload.get(1), 'arbitrary map-shaped payload value');
});

test('a map-shaped payload alongside real fields needs no extra empty-map insertion', () => {
  const bytes = core.encodeRecordBytes({
    typeId: 20,
    fields: new Map([[0, 'a real field']]),
    payload: new Map([[1, 'map-shaped payload']]),
  });
  const rec = core.decodeRecordBytes(bytes);
  assert.equal(rec.map.get(0), 'a real field');
  assert.equal(rec.payload.get(1), 'map-shaped payload');
});

test('FINDING: subrecords with no payload cost nothing extra -- no marker byte, since array is never ambiguous with payload', () => {
  const noSubrecords = cbor.encodeCanonical([20, new Map([[0, 'image/png']])]);
  const withSubrecordNoPayload = core.encodeRecordBytes({
    typeId: 20,
    fields: new Map([[0, 'image/png']]),
    subrecords: [{ typeId: 6, fields: new Map([[0, 'image/png']]) }],
  });
  const subBytes = core.encodeRecordBytes({ typeId: 6, fields: new Map([[0, 'image/png']]) });

  // withSubrecordNoPayload = noSubrecords's own array (grown by one
  // element: the subrecord) + subBytes -- no marker byte.
  assert.equal(withSubrecordNoPayload.length, noSubrecords.length + subBytes.length);
});

test('no payload and no subrecords costs nothing', () => {
  const bytes = core.encodeRecordBytes({ typeId: 20, fields: new Map([[0, 'image/png']]) });
  const rec = core.decodeRecordBytes(bytes);
  assert.equal(rec.payload, undefined);
  assert.equal(rec.subrecords, undefined);
});
