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

test('effectiveNamespace: a Record\'s own scope', () => {
  const a = Buffer.from('aa', 'hex');
  const b = Buffer.from('bb', 'hex');
  const empty = Buffer.alloc(0);
  // Own explicit namespace wins, regardless of ambient.
  assert.ok(header.effectiveNamespace(a, b).equals(a));
  assert.equal(header.effectiveNamespace(a, undefined).equals(a), true);
  // h'' (empty, the inherit marker) resolves to the ambient namespace.
  assert.ok(header.effectiveNamespace(empty, b).equals(b));
  assert.equal(header.effectiveNamespace(empty, undefined), undefined);
  // Absent (no bstr at all) is unconditionally global for THIS Record's
  // own typeId, regardless of ambient -- but (see namespaceForChildren
  // below) that says nothing about what its own subrecords receive.
  assert.equal(header.effectiveNamespace(undefined, b), undefined);
  assert.equal(header.effectiveNamespace(undefined, undefined), undefined);
});

test('namespaceForChildren: what a Record passes on to its subrecords', () => {
  const a = Buffer.from('aa', 'hex');
  const b = Buffer.from('bb', 'hex');
  const empty = Buffer.alloc(0);
  // An explicit, non-empty namespace resets the ambient for children.
  assert.ok(header.namespaceForChildren(a, b).equals(a));
  // h'' passes the received ambient straight through unchanged.
  assert.ok(header.namespaceForChildren(empty, b).equals(b));
  // Absent ALSO passes the ambient straight through -- unlike
  // effectiveNamespace, absence does not reset or break this. This is
  // what lets a scoped Record's h'' reach through an intervening
  // standard-type or Bundle Record that stayed global for itself.
  assert.ok(header.namespaceForChildren(undefined, b).equals(b));
  assert.equal(header.namespaceForChildren(undefined, undefined), undefined);
});

test('deriveHashId and verifyNamespaceHint', () => {
  const id = header.deriveHashId('com.example.test', 6);
  assert.equal(id.length, 6);
  assert.equal(header.verifyNamespaceHint(id, 'com.example.test'), 'verified');
  assert.equal(header.verifyNamespaceHint(id, 'wrong'), 'unverified');
  assert.equal(header.verifyNamespaceHint(undefined, 'test'), 'not-applicable');
});
