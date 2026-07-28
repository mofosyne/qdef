'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/core');

test('Bundle: empty array', () => {
  const rec = core.decodeRecordBytes(core.encodeRecordBytes({ subrecords: [] }));
  assert.equal(rec.typeId, undefined);
  assert.equal(rec.subrecords, undefined);
});

test('Bundle: with subrecords', () => {
  const rec = core.decodeRecordBytes(core.encodeRecordBytes({
    subrecords: [
      { typeId: [10], fields: new Map([[0, 'uri']]) },
      { typeId: [100], fields: new Map([[2, 'SSID']]) },
    ]
  }));
  assert.equal(rec.typeId, undefined);
  assert.equal(rec.subrecords.length, 2);
  assert.deepEqual(rec.subrecords[0].typeId, [10]);
  assert.deepEqual(rec.subrecords[1].typeId, [100]);
});

test('Bundle: namespace cascades to subrecords', () => {
  const ns = Buffer.from('deadbeef', 'hex');
  const rec = core.decodeRecordBytes(core.encodeRecordBytes({
    localNamespace: ns,
    subrecords: [{ typeId: [1], fields: new Map([[0, Buffer.from('scoped')]]) }]
  }));
  assert.equal(rec.typeId, undefined);
  assert.ok(rec.localNamespace.equals(ns));
  assert.deepEqual(rec.subrecords[0].typeId, [1]);
});
