'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const common = require('../src/commonKeys');

test('Common keys: ID and UUID only', () => {
  assert.equal(common.COMMON_KEY_ID, -1);
  assert.equal(common.COMMON_KEY_UUID, -3);
});

test('UUID generation and formatting', () => {
  const uuid = common.randomUuidBytes();
  assert.equal(uuid.length, 16);
  const str = common.uuidBytesToString(uuid);
  assert.equal(str.length, 36);
  assert.equal(str.split('-').length, 5);
});

test('UUID formatting: expected pattern', () => {
  const buf = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  const str = common.uuidBytesToString(buf);
  assert.equal(str, '00112233-4455-6677-8899-aabbccddeeff');
});
