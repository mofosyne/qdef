'use strict';
// §3.1's payload slot: a byte string or a text string only -- narrowed
// from "any well-formed CBOR item except an array." A scalar or a
// map-shaped payload used to be legal but was silently ambiguous
// whenever it landed with no namespace and typeId 0 (omitted from the
// wire): a uint payload was misread as typeId, a byte-string payload as
// a leading namespace, and both lost their actual content entirely on
// decode -- a real bug, not a hypothetical. Narrowing the shape to
// bstr/tstr removes the scalar/map cases outright; the remaining
// bstr-vs-namespace collision is closed by a flat, unconditional rule
// instead of a namespace-conditional one: a payload REQUIRES a nonzero
// typeId, full stop -- a Bundle (typeId 0) can never carry a payload,
// even when a namespace happens to also be present and the specific
// collision wouldn't actually occur (see docs/DESIGN.md).

const test = require('node:test');
const assert = require('node:assert/strict');
const cbor = require('cbor');

const core = require('../src/core');

test('a byte-string payload round-trips', () => {
  const bytes = core.encodeRecordBytes({ typeId: 20, payload: Buffer.from('hello') });
  const rec = core.decodeRecordBytes(bytes);
  assert.ok(rec.payload.equals(Buffer.from('hello')));
});

test('a text-string payload round-trips', () => {
  const bytes = core.encodeRecordBytes({ typeId: 20, payload: 'hello' });
  const rec = core.decodeRecordBytes(bytes);
  assert.equal(rec.payload, 'hello');
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

test('a scalar payload is rejected -- FINDING: it used to be silently misread as typeId and lost entirely', () => {
  assert.throws(() => core.encodeRecordBytes({ typeId: 0, payload: 42 }), /byte string.*text string/);
});

test('a map-shaped payload is rejected -- the field Map/payload carve-out no longer exists', () => {
  assert.throws(
    () => core.encodeRecordBytes({ typeId: 20, payload: new Map([[1, 'x']]) }),
    /byte string.*text string/,
  );
});

test('FINDING: a byte-string payload with typeId 0 used to be silently misread as a leading namespace, losing the payload entirely -- now a flat, unconditional rejection', () => {
  assert.throws(
    () => core.encodeRecordBytes({ typeId: 0, payload: Buffer.from('hi') }),
    /Bundle.*cannot carry a payload/,
  );
});

test('a Bundle cannot carry a payload even with an explicit localNamespace -- the rule is unconditional, not just when it would actually collide', () => {
  assert.throws(
    () =>
      core.encodeRecordBytes({
        typeId: 0,
        localNamespace: Buffer.from('cdcdcdcd', 'hex'),
        payload: Buffer.from('hi'),
      }),
    /Bundle.*cannot carry a payload/,
  );
});

test('a text-string payload is banned on a Bundle too, not just byte-string -- the rule is "payload requires a real typeId," not shape-specific', () => {
  assert.throws(() => core.encodeRecordBytes({ typeId: 0, payload: 'hi' }), /Bundle.*cannot carry a payload/);
});

test('a byte-string payload is fine once a nonzero typeId makes it unambiguous', () => {
  const bytes = core.encodeRecordBytes({ typeId: 5, payload: Buffer.from('hi') });
  const rec = core.decodeRecordBytes(bytes);
  assert.equal(rec.typeId, 5);
  assert.ok(rec.payload.equals(Buffer.from('hi')));
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
