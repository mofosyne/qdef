'use strict';
// §3.1's payload slot generalized: present whenever anything follows the
// map (a conformant encoder emits a `null` placeholder otherwise, so a
// trailing array is never ambiguous with subrecord 0), and its value may
// be any well-formed CBOR item -- the same shape rule §3.2 already gives
// field values -- including another Record. See docs/DESIGN.md.

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

test('payload may itself be a Record -- passed as a record spec, recursively encoded and decoded', () => {
  const bytes = core.encodeRecordBytes({
    typeId: 14, // Media Preview
    fields: new Map([[0, 'image/png']]),
    payload: { typeId: 6, fields: new Map([[0, 'image/png']]), payload: Buffer.from('jpeg bytes') },
  });
  const rec = core.decodeRecordBytes(bytes);

  assert.equal(rec.typeId, 14);
  assert.equal(rec.map.get(0), 'image/png');
  assert.equal(rec.subrecords, undefined);

  // The payload was itself a Record: decoded recursively into the same
  // shape a subrecord would be, not left as a raw undecoded array.
  assert.equal(rec.payload.typeId, 6);
  assert.equal(rec.payload.map.get(0), 'image/png');
  assert.ok(rec.payload.payload.equals(Buffer.from('jpeg bytes')));
});

test('a lone trailing array is unambiguously a record-shaped payload, never misread as subrecord 0', () => {
  // No subrecords at all here -- the sole array item after the map is
  // the payload, full stop. (Compare with the mandatory-`null`-marker
  // tests in subrecords.test.js for the case where a real subrecord
  // *does* follow.)
  const bytes = core.encodeRecordBytes({
    typeId: 20,
    fields: new Map([[0, 'x']]),
    payload: { typeId: 6, fields: new Map([[0, 'text/plain']]) },
  });
  const rec = core.decodeRecordBytes(bytes);
  assert.equal(rec.payload.typeId, 6);
  assert.equal(rec.subrecords, undefined);
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

test('FINDING: the mandatory null placeholder costs exactly 1 byte, only when subrecords are present and there is no real payload', () => {
  const noSubrecords = cbor.encodeCanonical([20, new Map([[0, 'image/png']])]);
  const withSubrecordNoPayload = core.encodeRecordBytes({
    typeId: 20,
    fields: new Map([[0, 'image/png']]),
    subrecords: [{ typeId: 6, fields: new Map([[0, 'image/png']]) }],
  });
  const subBytes = core.encodeRecordBytes({ typeId: 6, fields: new Map([[0, 'image/png']]) });

  // withSubrecordNoPayload = noSubrecords's own array (grown by one
  // element: the array-length nibble) + 1-byte null marker + subBytes.
  assert.equal(withSubrecordNoPayload.length, noSubrecords.length + 1 + subBytes.length);
});

test('no payload and no subrecords costs nothing -- the placeholder is never emitted needlessly', () => {
  const bytes = core.encodeRecordBytes({ typeId: 20, fields: new Map([[0, 'image/png']]) });
  const rec = core.decodeRecordBytes(bytes);
  assert.equal(rec.payload, undefined);
  assert.equal(rec.subrecords, undefined);
});
