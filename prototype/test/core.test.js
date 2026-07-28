'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const cbor = require('cbor');
const core = require('../src/core');

// Grammar: [namespace?, ns_annotation?, typeId*, type_annotation?, map?, subrecord*]

test('Bundle: no typeId and no namespace', () => {
  const rec = core.decodeRecordBytes(cbor.encodeCanonical([]));
  assert.equal(rec.typeId, undefined);
  assert.equal(rec.localNamespace, undefined);
  assert.equal(rec.map, null);
});

test('Bundle with namespace', () => {
  const ns = Buffer.from('deadbeef', 'hex');
  const rec = core.decodeRecordBytes(cbor.encodeCanonical([ns, [1]]));
  assert.equal(rec.typeId, undefined);
  assert.ok(rec.localNamespace.equals(ns));
});

test('App type, no namespace', () => {
  const rec = core.decodeRecordBytes(core.encodeRecordBytes({ typeId: [100], fields: new Map([[2, 'SSID']]) }));
  assert.deepEqual(rec.typeId, [100]);
  assert.equal(rec.localNamespace, undefined);
  assert.equal(rec.map.get(2), 'SSID');
});

test('App type within namespace', () => {
  const ns = Buffer.from('deadbeef', 'hex');
  const rec = core.decodeRecordBytes(core.encodeRecordBytes({ typeId: [1], localNamespace: ns, fields: new Map([[0, Buffer.from('data')]]) }));
  assert.deepEqual(rec.typeId, [1]);
  assert.ok(rec.localNamespace.equals(ns));
  assert.ok(rec.map.get(0).equals(Buffer.from('data')));
});

test('Inherit marker (empty bstr)', () => {
  const rec = core.decodeRecordBytes(core.encodeRecordBytes({ typeId: [1], localNamespace: Buffer.alloc(0), fields: new Map([[0, Buffer.from('x')]]) }));
  assert.deepEqual(rec.typeId, [1]);
  assert.equal(rec.localNamespace.length, 0);
});

test('Standard type (global, no namespace)', () => {
  const rec = core.decodeRecordBytes(core.encodeRecordBytes({ typeId: [10], fields: new Map([[0, 'uri']]) }));
  assert.deepEqual(rec.typeId, [10]);
  assert.equal(rec.localNamespace, undefined);
  assert.equal(rec.map.get(0), 'uri');
});

test('Hierarchical typeId [1,2,3]', () => {
  const ns = Buffer.from('6e73', 'hex');
  const rec = core.decodeRecordBytes(core.encodeRecordBytes({ typeId: [1, 2, 3], localNamespace: ns, fields: new Map([[0, Buffer.from('d')]]) }));
  assert.deepEqual(rec.typeId, [1, 2, 3]);
  assert.ok(rec.localNamespace.equals(ns));
});

// --- Annotations ---

test('ns annotation', () => {
  const rec = core.decodeRecordBytes(core.encodeRecordBytes({
    localNamespace: Buffer.from('deadbeef', 'hex'), nsAnnotation: 'TagDrop', typeId: [1], fields: new Map([[0, Buffer.from('d')]])
  }));
  assert.equal(rec.nsAnnotation, 'TagDrop');
});

test('type annotation', () => {
  const rec = core.decodeRecordBytes(core.encodeRecordBytes({
    typeId: [100], typeAnnotation: 'WiFi', fields: new Map([[2, 'SSID']])
  }));
  assert.equal(rec.typeAnnotation, 'WiFi');
});

test('both annotations', () => {
  const rec = core.decodeRecordBytes(core.encodeRecordBytes({
    localNamespace: Buffer.from('deadbeef', 'hex'), nsAnnotation: 'Ns', typeId: [1], typeAnnotation: 'Type', fields: new Map([[0, Buffer.from('d')]])
  }));
  assert.equal(rec.nsAnnotation, 'Ns');
  assert.equal(rec.typeAnnotation, 'Type');
});

test('bare tstr at position 0 is an error', () => {
  assert.throws(() => core.decodeRecordBytes(cbor.encodeCanonical(['hello'])), /bare tstr/);
});

test('bare tstr in Bundle is an error', () => {
  assert.throws(() => core.decodeRecordBytes(cbor.encodeCanonical(['hello', [1]])), /bare tstr/);
});

// --- Payload at map key 0 ---

test('payload at map key 0', () => {
  const rec = core.decodeRecordBytes(core.encodeRecordBytes({ typeId: [10], fields: new Map([[0, 'hello']]) }));
  assert.equal(rec.map.get(0), 'hello');
});

test('key 1 is just another key (payload descriptor)', () => {
  const rec = core.decodeRecordBytes(core.encodeRecordBytes({ typeId: [6], fields: new Map([[0, Buffer.from('content')], [1, 22]]) }));
  assert.ok(rec.map.get(0).equals(Buffer.from('content')));
  assert.equal(rec.map.get(1), 22);
});

// --- Subrecords ---

test('subrecords parse independently', () => {
  const rec = core.decodeRecordBytes(core.encodeRecordBytes({
    subrecords: [{ typeId: [10], fields: new Map([[0, 'a']]) }, { typeId: [20], fields: new Map([[0, 'b']]) }]
  }));
  assert.equal(rec.subrecords.length, 2);
  assert.deepEqual(rec.subrecords[0].typeId, [10]);
  assert.deepEqual(rec.subrecords[1].typeId, [20]);
});

test('non-array items between subrecords are silently skipped', () => {
  const items = [
    [10, {0: 'a'}],
    1,
    [20, {0: 'b'}],
  ];
  const rec = core.decodeRecordBytes(cbor.encodeCanonical(items));
  assert.equal(rec.subrecords.length, 2);
  assert.deepEqual(rec.subrecords[0].typeId, [10]);
  assert.deepEqual(rec.subrecords[1].typeId, [20]);
});

// --- Container magic ---

test('container with magic', () => {
  const cont = core.encodeContainer({ typeId: [10], fields: new Map([[0, 'uri']]) });
  assert.ok(cont.subarray(0, 4).equals(core.MAGIC));
  const rec = core.decodeContainer(cont);
  assert.deepEqual(rec.typeId, [10]);
  assert.equal(rec.map.get(0), 'uri');
});

test('bad magic', () => {
  assert.throws(() => core.decodeContainer(Buffer.from('xxxx')), /bad magic/);
});

// --- NDEF path ---

test('decodeSequence: no magic, bare record', () => {
  const bytes = core.encodeRecordBytes({ typeId: [100], fields: new Map([[0, Buffer.from('data')]]) });
  const rec = core.decodeSequence(bytes);
  assert.deepEqual(rec.typeId, [100]);
});

// --- Criticality ---

test('even/odd criticality: unknown even key aborts', () => {
  const rec = { map: new Map([[2, 'x']]) };
  const result = core.applyCriticality(rec, new Set([]));
  assert.equal(result.aborted, true);
});

test('even/odd criticality: unknown odd key is ignored', () => {
  const rec = { map: new Map([[1, 'x']]) };
  const result = core.applyCriticality(rec, new Set([]));
  assert.equal(result.aborted, false);
  assert.deepEqual(result.ignoredKeys, [1]);
});

test('criticality skips key 0 (payload)', () => {
  const rec = { map: new Map([[0, 'payload'], [2, 'unknown']]) };
  const result = core.applyCriticality(rec, new Set([]));
  assert.equal(result.aborted, true); // key 2 is unknown even
});

test('criticality skips negative keys (common headers)', () => {
  const rec = { map: new Map([[-1, 'id'], [2, 'unknown']]) };
  const result = core.applyCriticality(rec, new Set([]));
  assert.equal(result.aborted, true); // key 2 is unknown even
});

test('criticality: known keys pass', () => {
  const rec = { map: new Map([[1, 'opt'], [2, 'crit']]) };
  const result = core.applyCriticality(rec, new Set([1, 2]));
  assert.equal(result.aborted, false);
  assert.equal(result.ignoredKeys.length, 0);
});

// --- Container encode/decode ---

test('round-trip encode/decode container', () => {
  const original = { typeId: [10], fields: new Map([[0, 'https://example.com']]) };
  const cont = core.encodeContainer(original);
  const dec = core.decodeContainer(cont);
  assert.deepEqual(dec.typeId, [10]);
  assert.equal(dec.map.get(0), 'https://example.com');
});

// --- Simple end-to-end ---

test('Bundle with one subrecord', () => {
  const bytes = core.encodeRecordBytes({ subrecords: [{ typeId: [10], fields: new Map([[0, 'uri']]) }] });
  const rec = core.decodeRecordBytes(bytes);
  assert.equal(rec.typeId, undefined);
  assert.equal(rec.subrecords.length, 1);
  assert.deepEqual(rec.subrecords[0].typeId, [10]);
});
