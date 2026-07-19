'use strict';
// Embedded Records (§3.1's `ID[]{}` shape): an optional array of Records
// positioned between a Record's typeID/NDEF-ID prefix items and its
// mandatory field Map. Parsed with the exact same Record grammar as the
// top-level Sequence -- recursion, not a new shape -- so NDEF-ID and
// namespace-pairing on an embedded Record work for free. Resolves the
// TagDrop Media Preview/Payload correlation problem without relying on
// Record position (see docs/FINDINGS.md and docs/DESIGN.md).

const test = require('node:test');
const assert = require('node:assert/strict');
const cbor = require('cbor');

const core = require('../src/core');

test('an embedded Record round-trips inside its parent, dispatched by its own typeID', () => {
  const bytes = core.encodeRecordBytes({
    typeId: 14,
    fields: new Map([
      [0, 'image/png'],
      [3, 'map.png'],
    ]),
    embeddedRecords: [{ typeId: 2, fields: new Map([[0, Buffer.from('fragment')]]) }],
  });
  const rec = core.decodeRecordBytes(bytes);

  assert.equal(rec.ignored, false);
  assert.equal(rec.typeId, 14);
  assert.equal(rec.map.get(0), 'image/png');
  assert.equal(rec.map.get(3), 'map.png');
  assert.equal(rec.embeddedRecords.length, 1);
  assert.equal(rec.embeddedRecords[0].typeId, 2);
  assert.ok(rec.embeddedRecords[0].map.get(0).equals(Buffer.from('fragment')));
});

test('a record with no embedded-Records array has the field undefined -- zero-cost when unused', () => {
  const bytes = core.encodeRecordBytes({
    typeId: 14,
    fields: new Map([[0, 'image/png']]),
  });
  const rec = core.decodeRecordBytes(bytes);
  assert.equal(rec.embeddedRecords, undefined);
});

test('an explicitly empty embedded-Records array round-trips as zero members, distinct from absent', () => {
  const bytes = core.encodeRecordBytes({
    typeId: 20,
    fields: new Map(),
    embeddedRecords: [],
  });
  const rec = core.decodeRecordBytes(bytes);
  assert.ok(Array.isArray(rec.embeddedRecords));
  assert.equal(rec.embeddedRecords.length, 0);
});

test('multiple embedded Records dispatch by their own typeID, never by position', () => {
  const bytes = core.encodeRecordBytes({
    typeId: 20,
    fields: new Map(),
    embeddedRecords: [
      { typeId: 14, fields: new Map([[1, 'a.png']]) },
      { typeId: 14, fields: new Map([[1, 'b.txt']]) },
    ],
  });
  const rec = core.decodeRecordBytes(bytes);
  assert.equal(rec.embeddedRecords.length, 2);
  assert.equal(rec.embeddedRecords[0].typeId, 14);
  assert.equal(rec.embeddedRecords[0].map.get(1), 'a.png');
  assert.equal(rec.embeddedRecords[1].map.get(1), 'b.txt');
});

test('an embedded Record can itself carry an NDEF-ID and a namespace-pairing typeID -- reused grammar, not a reduced one', () => {
  const namespace = Buffer.from('cdcdcdcd', 'hex');
  const bytes = core.encodeRecordBytes({
    typeId: 20,
    fields: new Map(),
    embeddedRecords: [
      {
        typeId: 1,
        localNamespace: namespace,
        ndefId: 'inner-record-1',
        fields: new Map([[0, 'payload']]),
      },
    ],
  });
  const rec = core.decodeRecordBytes(bytes);
  const inner = rec.embeddedRecords[0];
  assert.equal(inner.typeId, 1);
  assert.ok(inner.localNamespace.equals(namespace));
  assert.equal(inner.ndefId, 'inner-record-1');
  assert.equal(inner.map.get(0), 'payload');
});

test('embedded Records nest to more than one level -- the same grammar applies recursively', () => {
  const bytes = core.encodeRecordBytes({
    typeId: 20,
    fields: new Map(),
    embeddedRecords: [
      {
        typeId: 21,
        fields: new Map(),
        embeddedRecords: [{ typeId: 22, fields: new Map([[0, 'leaf']]) }],
      },
    ],
  });
  const rec = core.decodeRecordBytes(bytes);
  const mid = rec.embeddedRecords[0];
  assert.equal(mid.typeId, 21);
  const leaf = mid.embeddedRecords[0];
  assert.equal(leaf.typeId, 22);
  assert.equal(leaf.map.get(0), 'leaf');
});

test('an unrecognized (leftover) item inside an embedded-Records array is skipped, same forward-compat tolerance as the top-level Sequence', () => {
  // typeId 20, then an embedded array containing [uint 2, <stray item>,
  // map] -- parseRecords recursed into the array should tolerate the
  // stray item exactly the way the top-level Sequence already does.
  const bytes = Buffer.concat([
    cbor.encodeCanonical(20),
    cbor.encodeCanonical([2, 'stray-forward-compat-item', new Map([[0, 'payload']])]),
    cbor.encodeCanonical(new Map()),
  ]);
  const rec = core.decodeRecordBytes(bytes);
  assert.equal(rec.embeddedRecords.length, 1);
  assert.equal(rec.embeddedRecords[0].typeId, 2);
  assert.equal(rec.embeddedRecords[0].map.get(0), 'payload');
});

test('the field Map stays mandatory even when an embedded-Records array is present and the map has nothing else to say', () => {
  const bytes = core.encodeRecordBytes({
    typeId: 20,
    fields: new Map(),
    embeddedRecords: [{ typeId: 2, fields: new Map([[0, 1]]) }],
  });
  const rec = core.decodeRecordBytes(bytes);
  assert.notEqual(rec.map, null);
  assert.equal(rec.map.size, 0);
});

test('criticality (§3.2) is unaffected by the presence of an embedded-Records array -- it is still purely typeID/map-key based', () => {
  const bytes = core.encodeRecordBytes({
    typeId: 20,
    fields: new Map([[5, 'unrecognized odd field']]),
    embeddedRecords: [{ typeId: 2, fields: new Map([[0, 1]]) }],
  });
  const rec = core.decodeRecordBytes(bytes);
  const checked = core.applyCriticality(rec, new Set([]));
  assert.equal(checked.aborted, false);
  assert.deepEqual(checked.ignoredKeys, [5]);
});

test('an unrecognized even key inside the outer map still aborts, embedded-Records array or not', () => {
  const bytes = core.encodeRecordBytes({
    typeId: 20,
    fields: new Map([[6, 'unrecognized even field']]),
    embeddedRecords: [{ typeId: 2, fields: new Map([[0, 1]]) }],
  });
  const rec = core.decodeRecordBytes(bytes);
  const checked = core.applyCriticality(rec, new Set([]));
  assert.equal(checked.aborted, true);
});

test('FINDING: an array after the typeID with no map yet is unambiguous because that byte pattern was already malformed before this shape existed', () => {
  // A bare typeID immediately followed by an array, with the mandatory
  // map still present right after: this is exactly ID[]{} and always
  // resolves to "typeId, embeddedRecords, empty-ish map" -- there is no
  // competing interpretation, because "typeID directly followed by an
  // array, no map yet" was never legal before this shape was added (a
  // bare typeID always required its own map before anything else could
  // start). See docs/DESIGN.md.
  const bytes = Buffer.concat([
    cbor.encodeCanonical(20),
    cbor.encodeCanonical([2, new Map([[0, 1]])]),
    cbor.encodeCanonical(new Map()),
  ]);
  const rec = core.decodeRecordBytes(bytes);
  assert.equal(rec.ignored, false);
  assert.equal(rec.typeId, 20);
  assert.equal(rec.embeddedRecords.length, 1);
});

test('FINDING: a map immediately followed by an array between two SIBLING top-level records is unaffected -- still "record ends, next record starts namespace-paired," never misread as a trailing embedded-Records array', () => {
  // This is the shape that was considered and rejected (ID{}[]): once a
  // record's map closes, an array right after it is the START of the
  // next record (namespace-pairing), never this record's own trailing
  // embedded array, because the embedded-Records array only has a slot
  // BEFORE the map, never after.
  const namespace = Buffer.from('cdcdcdcd', 'hex');
  const recordA = core.encodeRecordBytes({ typeId: 20, fields: new Map([[0, 'A']]) });
  const recordB = core.encodeRecordBytes({
    typeId: 1,
    localNamespace: namespace,
    fields: new Map([[0, 'B']]),
  });
  const seq = Buffer.concat([recordA, recordB]);
  const records = core.decodeSequence(seq);

  assert.equal(records.length, 2);
  assert.equal(records[0].typeId, 20);
  assert.equal(records[0].embeddedRecords, undefined);
  assert.equal(records[0].map.get(0), 'A');
  assert.equal(records[1].typeId, 1);
  assert.ok(records[1].localNamespace.equals(namespace));
  assert.equal(records[1].map.get(0), 'B');
});

test('FINDING: byte cost of an embedded-Records array is exactly the array framing plus its members -- no separate wrapper Type ID or byte-string re-encoding needed', () => {
  const withEmbedded = core.encodeRecordBytes({
    typeId: 20,
    fields: new Map(),
    embeddedRecords: [{ typeId: 2, fields: new Map([[0, 1]]) }],
  });
  const withoutEmbedded = core.encodeRecordBytes({
    typeId: 20,
    fields: new Map(),
  });
  const innerBytes = core.encodeRecordBytes({ typeId: 2, fields: new Map([[0, 1]]) });
  const arrayHeaderBytes = cbor.encodeCanonical([]).length; // empty-array header cost as a baseline

  assert.equal(withEmbedded.length, withoutEmbedded.length + arrayHeaderBytes + innerBytes.length);
});
