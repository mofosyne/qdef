'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/core');
const sig = require('../src/signature');

test('Signature [16]: encode and verify', () => {
  const records = [
    { typeId: [10], fields: new Map([[0, 'https://example.com']]) },
  ];
  const keyPair = sig.generateSigningKeyPair();
  const signed = sig.signatureEncode(records, keyPair.privateKey);
  assert.deepEqual(signed.typeId, [16]);
  assert.ok(signed.fields.get(0) instanceof Buffer);          // signature at key 0
  assert.equal(signed.fields.get(2), -8);                     // algorithm at key 2
  assert.equal(signed.fields.get(4).length, 32);              // public key at key 4
});

test('Signature: round-trip encode then verify in list', () => {
  const records = [
    { typeId: [10], fields: new Map([[0, 'https://example.com']]) },
  ];
  const keyPair = sig.generateSigningKeyPair();
  const signed = sig.signatureEncode(records, keyPair.privateKey);

  const encodedRecords = records.map(r => core.decodeRecordBytes(core.encodeRecordBytes(r)));
  const encodedSig = core.decodeRecordBytes(core.encodeRecordBytes(signed));
  const list = [...encodedRecords, encodedSig];

  const results = sig.verifySignaturesInList(list);
  assert.equal(results.length, 1);
  assert.equal(results[0].valid, true);
});

test('Signature: tampered record fails verification', () => {
  const records = [
    { typeId: [10], fields: new Map([[0, 'https://example.com']]) },
  ];
  const keyPair = sig.generateSigningKeyPair();
  const signed = sig.signatureEncode(records, keyPair.privateKey);

  const encodedSig = core.decodeRecordBytes(core.encodeRecordBytes(signed));
  const tampered = core.decodeRecordBytes(core.encodeRecordBytes({ typeId: [10], fields: new Map([[0, 'https://evil.com']]) }));
  const list = [tampered, encodedSig];

  const results = sig.verifySignaturesInList(list);
  assert.equal(results.length, 1);
  assert.equal(results[0].valid, false);
});
