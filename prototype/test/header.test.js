'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const header = require('../src/header');

test('isStandardType', () => {
  assert.equal(header.isStandardType([2]), true);
  assert.equal(header.isStandardType([10]), true);
  assert.equal(header.isStandardType([22]), true);
  assert.equal(header.isStandardType([23]), false);
  assert.equal(header.isStandardType([100]), false);
  assert.equal(header.isStandardType([2, 1]), false);
  assert.equal(header.isStandardType(undefined), false);
});

test('isInheritMarker', () => {
  assert.equal(header.isInheritMarker(Buffer.alloc(0)), true);
  assert.equal(header.isInheritMarker(Buffer.from('aa', 'hex')), false);
  assert.equal(header.isInheritMarker(undefined), false);
});

test('effectiveNamespace', () => {
  const a = Buffer.from('aa', 'hex');
  const b = Buffer.from('bb', 'hex');
  assert.ok(header.effectiveNamespace(a, b).equals(a));
  assert.ok(header.effectiveNamespace(undefined, b).equals(b));
  assert.equal(header.effectiveNamespace(undefined, undefined), undefined);
});

test('deriveHashId and verifyNamespaceHint', () => {
  const id = header.deriveHashId('com.example.test', 6);
  assert.equal(id.length, 6);
  assert.equal(header.verifyNamespaceHint(id, 'com.example.test'), 'verified');
  assert.equal(header.verifyNamespaceHint(id, 'wrong'), 'unverified');
  assert.equal(header.verifyNamespaceHint(undefined, 'test'), 'not-applicable');
});
