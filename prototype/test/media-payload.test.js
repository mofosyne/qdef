'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/core');
const wrappers = require('../src/wrappers');

test('Media Payload [6]: content at key 0, media type at key 1', () => {
  const rec = core.decodeRecordBytes(core.encodeRecordBytes({
    typeId: [6],
    fields: new Map([[0, Buffer.from('image bytes')], [1, 22]])  // 22 = image/jpeg
  }));
  assert.deepEqual(rec.typeId, [6]);
  assert.ok(rec.map.get(0).equals(Buffer.from('image bytes')));
  assert.equal(rec.map.get(1), 22);
});

test('Media Payload: media type as text string', () => {
  const rec = core.decodeRecordBytes(core.encodeRecordBytes({
    typeId: [6],
    fields: new Map([[0, Buffer.from('content')], [1, 'text/vcard']])
  }));
  assert.equal(rec.map.get(1), 'text/vcard');
});

test('Media Payload: no key 1 if media type is unknown', () => {
  const rec = core.decodeRecordBytes(core.encodeRecordBytes({
    typeId: [6],
    fields: new Map([[0, Buffer.from('opaque')]])
  }));
  assert.ok(rec.map.get(0).equals(Buffer.from('opaque')));
  assert.equal(rec.map.has(1), false);
});
