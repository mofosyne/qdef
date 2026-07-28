'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/core');
const wrappers = require('../src/wrappers');

test('round-trip: compress then decompress', () => {
  const inner = core.encodeRecordBytes({ typeId: [950], fields: new Map([[0, Buffer.from('Hello World!')]]) });
  const comp = wrappers.compressEncode(inner);
  const compBytes = core.encodeRecordBytes(comp);
  const compDec = core.decodeRecordBytes(compBytes);
  const decomp = core.decodeRecordBytes(wrappers.compressDecode(compDec));
  assert.equal(decomp.map.get(0).toString(), 'Hello World!');
});

test('round-trip: encrypt then decrypt', () => {
  const inner = core.encodeRecordBytes({ typeId: [950], fields: new Map([[0, Buffer.from('secret')]]) });
  const key = Buffer.alloc(32, 0x42);
  const enc = wrappers.encryptEncode(inner, key);
  const encBytes = core.encodeRecordBytes(enc);
  const encDec = core.decodeRecordBytes(encBytes);
  const dec = core.decodeRecordBytes(wrappers.encryptDecode(encDec, key));
  assert.equal(dec.map.get(0).toString(), 'secret');
});

test('round-trip: split 3 fragments + reassemble', () => {
  const inner = core.encodeRecordBytes({ typeId: [950], fields: new Map([[0, Buffer.from('data to split')]]) });
  const frags = wrappers.splitEncode(inner, { count: 3, parityScheme: 1 });
  assert.equal(frags.length, 4);
  const decoded = frags.map(f => core.decodeRecordBytes(core.encodeRecordBytes(f)));
  const reassembled = wrappers.splitDecode(decoded);
  assert.ok(reassembled.equals(inner));
});

test('round-trip: split + encrypt + compress wrapper stack', () => {
  const inner = core.encodeRecordBytes({ typeId: [950], fields: new Map([[0, Buffer.from('nested wrapper test')]]) });
  const compressed = wrappers.compressEncode(inner);
  const key = Buffer.alloc(32, 0x42);
  const encrypted = wrappers.encryptEncode(core.encodeRecordBytes(compressed), key);
  const frags = wrappers.splitEncode(core.encodeRecordBytes(encrypted), { count: 2 });
  assert.equal(frags.length, 2);

  // Resolve with known keys for wrapper types
  const knownKeys = new Map();
  const tidKey = (tid) => Array.isArray(tid) ? tid.join(',') : '';
  knownKeys.set(tidKey(wrappers.SPLIT_TYPE), wrappers.SPLIT_KNOWN_KEYS);
  knownKeys.set(tidKey(wrappers.ENCRYPT_TYPE), wrappers.ENCRYPT_KNOWN_KEYS);
  knownKeys.set(tidKey(wrappers.COMPRESS_TYPE), wrappers.COMPRESS_KNOWN_KEYS);
  const fragBufs = frags.map(f => core.encodeContainer(f));
  const resolved = wrappers.resolveStack(fragBufs, { aesKey: key }, knownKeys);
  assert.deepEqual(resolved.typeId, [950]);
  assert.equal(resolved.map.get(0).toString(), 'nested wrapper test');
});
