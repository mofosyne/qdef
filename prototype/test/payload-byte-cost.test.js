'use strict';
// §3.1's payload slot, byte-cost FINDINGs for the three shipped Wrapper
// Records that moved their opaque content out of the field Map and into
// payload. Verified against the actual encoder, not estimated -- and
// the savings are NOT uniform across the three, which is worth locking
// in rather than assuming: Compress's map held nothing else, so dropping
// its one key eliminates the whole map (2 bytes: the map header plus the
// key byte). Encrypt's and Split's maps still hold other fields, so only
// the payload's own key byte goes away (1 byte each) -- the map header
// itself is unchanged either way for a map that still has content.

const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('../src/core');
const wrappers = require('../src/wrappers');

test('FINDING: Compress moving its sole field to payload drops the whole map -- 2 bytes saved', () => {
  const inner = Buffer.from('repeat repeat repeat repeat content');
  const withPayload = core.encodeRecordBytes(wrappers.compressEncode(inner));

  // Old shape: the deflated bytes as an ordinary map value at key 0.
  const oldShapeFields = new Map([[0, wrappers.compressEncode(inner).payload]]);
  const oldShape = core.encodeRecordBytes({ typeId: wrappers.COMPRESS_TYPE, fields: oldShapeFields });

  assert.equal(oldShape.length - withPayload.length, 2);
});

test('FINDING: Encrypt moving its ciphertext+tag to payload saves exactly 1 byte -- its map still holds the nonce', () => {
  const key = Buffer.alloc(32, 7);
  const inner = Buffer.from('some secret payload bytes');
  const enc = wrappers.encryptEncode(inner, key);
  const withPayload = core.encodeRecordBytes(enc);

  // Old shape: ciphertext+tag back as an ordinary map value at key 2,
  // alongside the nonce that was always at key 0.
  const oldShapeFields = new Map([[0, enc.fields.get(0)], [2, enc.payload]]);
  const oldShape = core.encodeRecordBytes({ typeId: wrappers.ENCRYPT_TYPE, fields: oldShapeFields });

  assert.equal(oldShape.length - withPayload.length, 1);
});

test('FINDING: Split moving its fragment bytes to payload saves exactly 1 byte per fragment -- its map still holds group_id/index/count/total_bytes', () => {
  const inner = Buffer.from('a payload split across two codes');
  const fragments = wrappers.splitEncode(inner, { count: 2 });
  const withPayload = core.encodeRecordBytes(fragments[0]);

  // Old shape: this fragment's slice back as an ordinary map value at key 6.
  const oldShapeFields = new Map(fragments[0].fields);
  oldShapeFields.set(6, fragments[0].payload);
  const oldShape = core.encodeRecordBytes({ typeId: wrappers.SPLIT_TYPE, fields: oldShapeFields });

  assert.equal(oldShape.length - withPayload.length, 1);
});
