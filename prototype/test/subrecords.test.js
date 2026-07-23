'use strict';
// Subrecords (§3.1's generalized shape): every Record is now exactly one
// self-delimited CBOR array, [namespace?, typeId, map?, payload?, sub*] --
// everything past the mandatory field Map, for the rest of that Record's
// own array, is itself a nested Record, recursively the same grammar.
// No separate wrapper array is needed to bound them anymore: the outer
// Record's own array header already is that boundary. Resolves the
// TagDrop Media Preview/Payload correlation problem without relying on
// Record position, and replaces the earlier `ID[]{}`-with-one-optional-
// array design once every Record became array-wrapped (see
// docs/FINDINGS.md and docs/DESIGN.md).

const test = require('node:test');
const assert = require('node:assert/strict');
const cbor = require('cbor');

const core = require('../src/core');
const header = require('../src/header');

test('a subrecord round-trips inside its parent, dispatched by its own typeID', () => {
  const bytes = core.encodeRecordBytes({
    typeId: 14,
    fields: new Map([
      [0, 'image/png'],
      [3, 'map.png'],
    ]),
    subrecords: [{ typeId: 2, fields: new Map([[0, Buffer.from('fragment')]]) }],
  });
  const rec = core.decodeRecordBytes(bytes);

  assert.equal(rec.typeId, 14);
  assert.equal(rec.map.get(0), 'image/png');
  assert.equal(rec.map.get(3), 'map.png');
  assert.equal(rec.subrecords.length, 1);
  assert.equal(rec.subrecords[0].typeId, 2);
  assert.ok(rec.subrecords[0].map.get(0).equals(Buffer.from('fragment')));
});

test('a record with no subrecords has the field undefined -- zero-cost when unused', () => {
  const bytes = core.encodeRecordBytes({
    typeId: 14,
    fields: new Map([[0, 'image/png']]),
  });
  const rec = core.decodeRecordBytes(bytes);
  assert.equal(rec.subrecords, undefined);
});

test('multiple subrecords dispatch by their own typeID, never by position', () => {
  const bytes = core.encodeRecordBytes({
    typeId: 20,
    fields: new Map(),
    subrecords: [
      { typeId: 14, fields: new Map([[1, 'a.png']]) },
      { typeId: 14, fields: new Map([[1, 'b.txt']]) },
    ],
  });
  const rec = core.decodeRecordBytes(bytes);
  assert.equal(rec.subrecords.length, 2);
  assert.equal(rec.subrecords[0].typeId, 14);
  assert.equal(rec.subrecords[0].map.get(1), 'a.png');
  assert.equal(rec.subrecords[1].map.get(1), 'b.txt');
});

test('a subrecord can itself carry a namespace and its own further subrecords -- reused grammar, not a reduced one', () => {
  const namespace = Buffer.from('cdcdcdcd', 'hex');
  const bytes = core.encodeRecordBytes({
    typeId: 20,
    fields: new Map(),
    subrecords: [
      {
        typeId: 1,
        localNamespace: namespace,
        fields: new Map([[0, 'payload']]),
        subrecords: [{ typeId: 22, fields: new Map([[0, 'leaf']]) }],
      },
    ],
  });
  const rec = core.decodeRecordBytes(bytes);
  const inner = rec.subrecords[0];
  assert.equal(inner.typeId, 1);
  assert.ok(inner.localNamespace.equals(namespace));
  assert.equal(inner.map.get(0), 'payload');
  assert.equal(inner.subrecords[0].typeId, 22);
  assert.equal(inner.subrecords[0].map.get(0), 'leaf');
});

test('a non-array item after the map is read as this Record\'s payload, not skipped -- payload accepts any CBOR shape', () => {
  const bytes = cbor.encodeCanonical([20, new Map([[0, 'payload']]), 42]);
  const rec = core.decodeRecordBytes(bytes);
  assert.equal(rec.typeId, 20);
  assert.equal(rec.map.get(0), 'payload');
  assert.equal(rec.payload, 42);
  assert.equal(rec.subrecords, undefined);
});

test('every Record is self-bounded by its own array -- two top-level Records, one with subrecords and one without, never bleed into each other', () => {
  const withSub = core.encodeRecordBytes({
    typeId: 20,
    fields: new Map([[0, 'A']]),
    subrecords: [{ typeId: 2, fields: new Map([[0, 1]]) }],
  });
  const plain = core.encodeRecordBytes({ typeId: 1, fields: new Map([[0, 'B']]) });
  const records = core.decodeSequence(Buffer.concat([withSub, plain])).subrecords;

  assert.equal(records.length, 2);
  assert.equal(records[0].typeId, 20);
  assert.equal(records[0].subrecords.length, 1);
  assert.equal(records[1].typeId, 1);
  assert.equal(records[1].subrecords, undefined);
  assert.equal(records[1].map.get(0), 'B');
});

test('a subrecord with no typeId of its own defaults to Bundle (0), and never corrupts its parent or any sibling top-level Record -- each Record\'s own array boundary is generic and independent of its contents', () => {
  // A subrecord slot holding an array with no typeId at all (a bare map
  // as its own first and only element) still has a well-defined byte
  // boundary -- the outer walker never needs to understand it to skip
  // past it. It's no longer "malformed": typeId defaults to 0 and the
  // map becomes that (Bundle-shaped) Record's own field map -- the
  // forgiving-parser choice (see docs/DESIGN.md).
  const parentWithDefaultingSub = cbor.encodeCanonical([
    20,
    new Map([[0, 'parent payload']]),
    [new Map([[0, 'no typeid here']])], // subrecord with no typeId: defaults to 0
  ]);
  const sibling = core.encodeRecordBytes({ typeId: 1, fields: new Map([[0, 'sibling payload']]) });

  const records = core.decodeSequence(Buffer.concat([parentWithDefaultingSub, sibling])).subrecords;
  assert.equal(records.length, 2);
  assert.equal(records[0].typeId, 20);
  assert.equal(records[0].subrecords.length, 1);
  assert.equal(records[0].subrecords[0].typeId, 0);
  assert.equal(records[0].subrecords[0].map.get(0), 'no typeid here');
  assert.equal(records[1].typeId, 1);
  assert.equal(records[1].map.get(0), 'sibling payload');
});

test('ambient namespace cascades from a namespace-paired Record down to its own subrecords, unless a subrecord declares its own override', () => {
  const namespace = Buffer.from('cdcdcdcd', 'hex');
  const otherNamespace = Buffer.from('eeeeeeee', 'hex');
  const bytes = core.encodeRecordBytes({
    typeId: 21, // odd, so its own resolved key carries a namespace too
    localNamespace: namespace,
    fields: new Map(),
    subrecords: [
      { typeId: 3, fields: new Map([[0, 'inherits ambient']]) }, // odd, no override
      { typeId: 5, localNamespace: otherNamespace, fields: new Map([[0, 'own override']]) }, // odd, own override
    ],
  });
  const rec = core.decodeRecordBytes(bytes);
  const resolved = header.resolveLookupKeysDeep(rec, undefined);

  // resolved[0] is the parent itself, resolved[1]/[2] are its subrecords.
  assert.equal(resolved.length, 3);
  assert.ok(resolved[0].key.namespace.equals(namespace));
  assert.ok(resolved[1].key.namespace.equals(namespace)); // cascaded, no pairing of its own
  assert.ok(resolved[2].key.namespace.equals(otherNamespace)); // its own override wins
});

test('FINDING: byte cost of a subrecord is exactly its own array plus one element slot on the parent -- no separate wrapper Type ID or byte-string re-encoding needed', () => {
  const withSub = core.encodeRecordBytes({
    typeId: 20,
    fields: new Map(),
    subrecords: [{ typeId: 2, fields: new Map([[0, 1]]) }],
  });
  const withoutSub = core.encodeRecordBytes({
    typeId: 20,
    fields: new Map(),
  });
  const subBytes = core.encodeRecordBytes({ typeId: 2, fields: new Map([[0, 1]]) });

  // withSub's own array grew by one element (the subrecord), and its
  // header may grow by at most a byte if the element count crosses a
  // CBOR length-encoding boundary (never happens for 2 vs 3 items here).
  assert.equal(withSub.length, withoutSub.length + subBytes.length);
});
