'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/core');

test('App Route [12]: domain at key 0, label at key 1', () => {
  const rec = core.decodeRecordBytes(core.encodeRecordBytes({
    typeId: [12],
    fields: new Map([[0, 'example.com'], [1, 'Example App']])
  }));
  assert.deepEqual(rec.typeId, [12]);
  assert.equal(rec.map.get(0), 'example.com');
  assert.equal(rec.map.get(1), 'Example App');
});

test('App Route: hash-derived form', () => {
  const hash = Buffer.from('aabbccdd', 'hex');
  const rec = core.decodeRecordBytes(core.encodeRecordBytes({
    typeId: [12],
    fields: new Map([[0, hash], [1, 'com.example/test']])
  }));
  assert.ok(rec.map.get(0).equals(hash));
});
