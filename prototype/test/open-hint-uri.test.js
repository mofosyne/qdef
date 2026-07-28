'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/core');

test('Open/Hint URI [10]: URI at key 0, label at key 1', () => {
  const rec = core.decodeRecordBytes(core.encodeRecordBytes({
    typeId: [10],
    fields: new Map([[0, 'https://example.com'], [1, 'Example']])
  }));
  assert.deepEqual(rec.typeId, [10]);
  assert.equal(rec.map.get(0), 'https://example.com');
  assert.equal(rec.map.get(1), 'Example');
});

test('Open/Hint URI: optional fields', () => {
  const rec = core.decodeRecordBytes(core.encodeRecordBytes({
    typeId: [10],
    fields: new Map([[0, 'https://example.com'], [3, 'en'], [5, 1]])
  }));
  assert.equal(rec.map.get(3), 'en'); // language
  assert.equal(rec.map.get(5), 1);     // action: save for later
});
