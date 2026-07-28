'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/core');

test('Media Preview [14]: no key 0, media type at key 2', () => {
  const rec = core.decodeRecordBytes(core.encodeRecordBytes({
    typeId: [14],
    fields: new Map([[2, 'image/png']])
  }));
  assert.deepEqual(rec.typeId, [14]);
  assert.equal(rec.map.get(2), 'image/png');
  assert.equal(rec.map.has(0), false);
});

test('Media Preview: with content hash, filename, label', () => {
  const rec = core.decodeRecordBytes(core.encodeRecordBytes({
    typeId: [14],
    fields: new Map([
      [2, 'image/png'],
      [3, Buffer.from('12aabb', 'hex')],
      [5, 'photo.png'],
      [7, 'Beach sunset'],
    ])
  }));
  assert.equal(rec.map.get(2), 'image/png');
  assert.equal(rec.map.get(5), 'photo.png');
  assert.equal(rec.map.get(7), 'Beach sunset');
});

test('Media Preview: with subrecord content', () => {
  const rec = core.decodeRecordBytes(core.encodeRecordBytes({
    typeId: [14],
    fields: new Map([[2, 'image/png']]),
    subrecords: [{ typeId: [6], fields: new Map([[0, Buffer.from('content')], [1, 'image/png']]) }]
  }));
  assert.equal(rec.subrecords.length, 1);
  assert.deepEqual(rec.subrecords[0].typeId, [6]);
});
