'use strict';
// §3.2's field-value-shape rule (a field value must be a flat scalar or
// definite-length string, never a bare array/map) was dropped: a field
// value may now be any well-formed CBOR item, including nested arrays,
// maps, and indefinite-length strings. The Node prototype never enforced
// the old restriction itself (it always decoded with the full `cbor`
// library), so these tests mainly document and lock in the capability;
// the real enforcement change was in rust/qdef-core's hand-rolled
// decoder, where field-value skipping used to be a separate, stricter
// function (`skip_value`) than prefix-item skipping (`skip_any_item`) --
// now merged into one, since there's no longer a shape distinction to
// enforce differently. See docs/FINDINGS.md.
//
// No indirection tax anymore: nested structure used to have to be
// pre-encoded as CBOR and carried as an opaque byte string field value,
// decoded separately by app code (see rust/qdef-core's test literally
// named `structured_content_is_carried_as_an_opaque_byte_string...`,
// now historical). It can be a native nested value directly.

const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('../src/core');

test('a field value can be a bare nested array -- previously disallowed, no indirection through an opaque byte string needed', () => {
  const bytes = core.encodeRecordBytes({
    typeId: 100,
    fields: new Map([[0, ['a', 'b', 'c']]]),
  });
  const rec = core.decodeRecordBytes(bytes);

  assert.deepEqual(rec.map.get(0), ['a', 'b', 'c']);
});

test('a field value can be a bare nested map', () => {
  const bytes = core.encodeRecordBytes({
    typeId: 100,
    fields: new Map([[0, new Map([['nested', 'value']])]]),
  });
  const rec = core.decodeRecordBytes(bytes);

  // Only the top-level Record map is normalized to a Map instance
  // (core.js's own delimiter); a nested map value round-trips however
  // the `cbor` library represents a decoded map -- a plain object here,
  // which is a JS-representation detail, not a wire-format one.
  assert.deepEqual(rec.map.get(0), { nested: 'value' });
});

test('a field value can nest several levels deep -- no depth restriction at the wire-format level (advisory guidance only, §3.2)', () => {
  const deep = { a: { b: { c: { d: ['deeply', 'nested', 'content'] } } } };
  const bytes = core.encodeRecordBytes({
    typeId: 100,
    fields: new Map([[0, deep]]),
  });
  const rec = core.decodeRecordBytes(bytes);

  assert.deepEqual(rec.map.get(0), deep);
});

test('unrecognized-key criticality still works normally when the value happens to be a nested structure -- the even/odd rule only ever looks at keys, never at value shape', () => {
  const bytes = core.encodeRecordBytes({
    typeId: 100,
    fields: new Map([
      [0, 'known'],
      [7, ['unknown', 'odd', 'key', 'nested value']],
    ]),
  });
  const rec = core.decodeRecordBytes(bytes);
  const checked = core.applyCriticality(rec, new Set([0]));

  assert.equal(checked.aborted, false);
  assert.deepEqual(checked.ignoredKeys, [7]);
});

test('an unrecognized EVEN key with a nested-structure value still aborts the record, same as any other unrecognized even key', () => {
  const bytes = core.encodeRecordBytes({
    typeId: 100,
    fields: new Map([
      [0, 'known'],
      [6, { unknown: 'critical nested field' }],
    ]),
  });
  const rec = core.decodeRecordBytes(bytes);
  const checked = core.applyCriticality(rec, new Set([0]));

  assert.equal(checked.aborted, true);
  assert.match(checked.abortReason, /unrecognized critical \(even\) key 6/);
});
