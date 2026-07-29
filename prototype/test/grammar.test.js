'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const cbor = require('cbor');
const core = require('../src/core');
const wrappers = require('../src/wrappers');
const header = require('../src/header');
const common = require('../src/commonKeys');

// =====================================================================
// Comprehensive grammar test covering the final QDEF wire format.
// =====================================================================

// --- Record shapes ---

test('grammar: all record shapes round-trip', () => {
  const shapes = [
    ['Bundle empty', { subrecords: [] }, (r) => r.typeId === undefined && r.subrecords === undefined],
    ['Bundle with sub', { subrecords: [{ typeId: [10] }] }, (r) => r.typeId === undefined && r.subrecords.length === 1],
    ['App type no ns', { typeId: [100] }, (r) => JSON.stringify(r.typeId) === '[100]' && r.localNamespace === undefined],
    ['App type with ns', { typeId: [1], localNamespace: Buffer.from('deadbeef', 'hex') }, (r) => JSON.stringify(r.typeId) === '[1]' && r.localNamespace?.toString('hex') === 'deadbeef'],
    ['Std type no ns', { typeId: [10] }, (r) => JSON.stringify(r.typeId) === '[10]'],
    ['Hierarchical tid', { typeId: [1, 2, 3] }, (r) => JSON.stringify(r.typeId) === '[1,2,3]'],
    ['Inherit marker', { typeId: [1], localNamespace: Buffer.alloc(0) }, (r) => r.localNamespace?.length === 0],
  ];
  for (const [label, args, check] of shapes) {
    const buf = core.encodeRecordBytes(args);
    const dec = core.decodeRecordBytes(buf);
    assert.ok(check(dec), label);
  }
});

// --- Annotations ---

test('grammar: annotations round-trip', () => {
  const rec = core.decodeRecordBytes(core.encodeRecordBytes({
    localNamespace: Buffer.from('deadbeef', 'hex'),
    nsAnnotation: 'TagDrop',
    typeId: [1],
    typeAnnotation: 'Route',
    fields: new Map([[0, Buffer.from('data')]])
  }));
  assert.equal(rec.nsAnnotation, 'TagDrop');
  assert.equal(rec.typeAnnotation, 'Route');
});

test('grammar: bare tstr error', () => {
  assert.throws(() => core.decodeRecordBytes(cbor.encodeCanonical(['hello'])), /bare tstr/);
});

// --- Map key 0 and 1 ---

test('grammar: payload at key 0 and descriptor at key 1', () => {
  // Media Payload: content at 0, media type at 1
  const rec = core.decodeRecordBytes(core.encodeRecordBytes({
    typeId: [6],
    fields: new Map([[0, Buffer.from('content')], [1, 22]])
  }));
  assert.ok(rec.map.get(0).equals(Buffer.from('content')));
  assert.equal(rec.map.get(1), 22);
});

// --- Header module ---

test('header: isStandardType range', () => {
  assert.equal(header.isStandardType([2]), true);
  assert.equal(header.isStandardType([10]), true);
  assert.equal(header.isStandardType([22]), true);
  assert.equal(header.isStandardType([23]), false);
  assert.equal(header.isStandardType([100]), false);
  assert.equal(header.isStandardType([2, 1]), false);
  assert.equal(header.isStandardType(undefined), false);
});

test('header: inherit marker', () => {
  assert.equal(header.isInheritMarker(Buffer.alloc(0)), true);
  assert.equal(header.isInheritMarker(Buffer.from('aa', 'hex')), false);
});

test('header: effective namespace', () => {
  const a = Buffer.from('aa', 'hex');
  const b = Buffer.from('bb', 'hex');
  const empty = Buffer.alloc(0);
  assert.ok(header.effectiveNamespace(a, b).equals(a)); // own explicit wins
  assert.ok(header.effectiveNamespace(empty, b).equals(b)); // h'' inherits
  assert.equal(header.effectiveNamespace(undefined, b), undefined); // absent breaks the chain
  assert.equal(header.effectiveNamespace(undefined, undefined), undefined);
});

test('header: hash derivation and verification', () => {
  const ns = header.deriveHashId('com.example.tagdrop', 4);
  assert.equal(ns.length, 4);
  assert.equal(header.verifyNamespaceHint(ns, 'com.example.tagdrop'), 'verified');
  assert.equal(header.verifyNamespaceHint(ns, 'wrong'), 'unverified');
  assert.equal(header.verifyNamespaceHint(undefined, 'com.example'), 'not-applicable');
});

// --- Wrappers ---

test('wrapper: compress round-trip', () => {
  const inner = core.encodeRecordBytes({ typeId: [950], fields: new Map([[0, Buffer.from('secret data')]]) });
  const comp = wrappers.compressEncode(inner);
  const compBytes = core.encodeRecordBytes(comp);
  const compDec = core.decodeRecordBytes(compBytes);
  assert.deepEqual(compDec.typeId, [4]);
  const decomp = core.decodeRecordBytes(wrappers.compressDecode(compDec));
  assert.equal(decomp.map.get(0).toString(), 'secret data');
});

test('wrapper: encrypt round-trip', () => {
  const inner = core.encodeRecordBytes({ typeId: [950], fields: new Map([[0, Buffer.from('secret')]]) });
  const key = Buffer.alloc(32, 0x42);
  const enc = wrappers.encryptEncode(inner, key);
  const encBytes = core.encodeRecordBytes(enc);
  const encDec = core.decodeRecordBytes(encBytes);
  assert.deepEqual(encDec.typeId, [2]);
  assert.equal(encDec.map.get(2).length, 12); // nonce at key 2
  const dec = core.decodeRecordBytes(wrappers.encryptDecode(encDec, key));
  assert.equal(dec.map.get(0).toString(), 'secret');
});

test('wrapper: split round-trip', () => {
  const inner = core.encodeRecordBytes({ typeId: [950], fields: new Map([[0, Buffer.from('hello world!')]]) });
  const frags = wrappers.splitEncode(inner, { count: 3 });
  assert.equal(frags.length, 3);
  const decoded = frags.map(f => core.decodeRecordBytes(core.encodeRecordBytes(f)));
  const reassembled = wrappers.splitDecode(decoded);
  assert.ok(reassembled.equals(inner));
});

test('wrapper: split with parity recovery', () => {
  const inner = core.encodeRecordBytes({ typeId: [950], fields: new Map([[0, Buffer.from('recoverable data')]]) });
  const frags = wrappers.splitEncode(inner, { count: 3, parityScheme: 1 });
  assert.equal(frags.length, 4);
  const decoded = frags.map(f => core.decodeRecordBytes(core.encodeRecordBytes(f)));
  // Drop fragment 0, recover from parity
  const partial = [decoded[1], decoded[2], decoded[3]];
  const reassembled = wrappers.splitDecode(partial);
  assert.ok(reassembled.equals(inner));
});

// --- Standard type IDs follow the new bare-uint convention ---

test('standard type IDs are sequential 1-8', () => {
  assert.deepEqual(wrappers.SPLIT_TYPE, [1]);
  assert.deepEqual(wrappers.ENCRYPT_TYPE, [2]);
  assert.deepEqual(wrappers.MEDIA_PAYLOAD_TYPE, [3]);
  assert.deepEqual(wrappers.COMPRESS_TYPE, [4]);
  assert.deepEqual(wrappers.OPEN_HINT_URI_TYPE, [5]);
  assert.deepEqual(wrappers.APP_ROUTE_TYPE, [6]);
  assert.deepEqual(wrappers.MEDIA_PREVIEW_TYPE, [7]);
});

// --- Known keys ---

test('known keys for standard types', () => {
  assert.ok(wrappers.SPLIT_KNOWN_KEYS.has(2));
  assert.ok(wrappers.ENCRYPT_KNOWN_KEYS.has(2));
  assert.ok(wrappers.MEDIA_PAYLOAD_KNOWN_KEYS.has(1)); // media type at key 1
  assert.ok(wrappers.OPEN_HINT_URI_KNOWN_KEYS.has(1)); // label
  assert.ok(wrappers.APP_ROUTE_KNOWN_KEYS.has(1)); // label
  assert.ok(wrappers.MEDIA_PREVIEW_KNOWN_KEYS.has(2)); // media type at key 2
});

// --- Common keys ---

test('common keys are ID and UUID only', () => {
  assert.equal(common.COMMON_KEY_ID, -1);
  assert.equal(common.COMMON_KEY_UUID, -3);
});

test('common UUID generation', () => {
  const uuid = common.randomUuidBytes();
  assert.equal(uuid.length, 16);
  const str = common.uuidBytesToString(uuid);
  assert.equal(str.length, 36);
  assert.equal(str.split('-').length, 5);
});

// --- End-to-end: full container ---

test('end-to-end: encode container, decode, verify structure', () => {
  const record = {
    typeId: [10],
    fields: new Map([[0, 'https://example.com'], [1, 'Example']]),
  };
  const container = core.encodeContainer(record);
  assert.ok(container.subarray(0, 4).equals(core.MAGIC));
  const dec = core.decodeContainer(container);
  assert.deepEqual(dec.typeId, [10]);
  assert.equal(dec.map.get(0), 'https://example.com');
  assert.equal(dec.map.get(1), 'Example');
});

// --- Cross-validate with Rust test vectors (generated by Node) ---

test('cross-val: app [100] with payload', () => {
  const hex = '821864A100477061796C6F6164';
  const rec = core.decodeRecordBytes(Buffer.from(hex, 'hex'));
  assert.deepEqual(rec.typeId, [100]);
  assert.equal(rec.map.get(0).toString(), 'payload');
});

test('cross-val: standard [10] OpenURI', () => {
  const hex = '820AA1006E68747470733A2F2F65782E636F6D';
  const rec = core.decodeRecordBytes(Buffer.from(hex, 'hex'));
  assert.deepEqual(rec.typeId, [10]);
  assert.equal(rec.map.get(0), 'https://ex.com');
});

test('cross-val: Bundle empty', () => {
  const rec = core.decodeRecordBytes(Buffer.from('80', 'hex'));
  assert.equal(rec.typeId, undefined);
  assert.equal(rec.subrecords, undefined);
});

test('cross-val: ns + nsAnnotation + typeId + typeAnnotation', () => {
  const hex = '85426E7362 4E73 01 64 54797065 A1004464617461'.replace(/\s/g, '');
  const rec = core.decodeRecordBytes(Buffer.from(hex, 'hex'));
  assert.deepEqual(rec.typeId, [1]);
  assert.equal(rec.localNamespace.toString(), 'ns');
  assert.equal(rec.nsAnnotation, 'Ns');
  assert.equal(rec.typeAnnotation, 'Type');
});

test('cross-val: hierarchical [1,2,3]', () => {
  const hex = '85426E73010203A1004164';
  const rec = core.decodeRecordBytes(Buffer.from(hex, 'hex'));
  assert.deepEqual(rec.typeId, [1, 2, 3]);
});

test('cross-val: inherit marker h\'\'', () => {
  const hex = '834001A1004178';
  const rec = core.decodeRecordBytes(Buffer.from(hex, 'hex'));
  assert.deepEqual(rec.typeId, [1]);
  assert.equal(rec.localNamespace.length, 0);
});
