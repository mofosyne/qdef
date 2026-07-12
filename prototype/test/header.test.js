'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('../src/core');
const header = require('../src/header');

// ---------------------------------------------------------------------
// Record Type 0: reserved container-level metadata (format namespace +
// optional Hint name), landed after collapsing what had been a separate
// fixed/positional header concept into "just another Record" -- no
// version byte, no non-Record header structure at all. The container is
// now literally magic + a CBOR Sequence of Records, full stop.
// ---------------------------------------------------------------------

test('a Type 0 header record round-trips namespace and hint', () => {
  const container = core.encodeContainer([
    { typeId: header.HEADER_TYPE, fields: new Map([[3, 12271745624591856273n], [5, 'com.example/tagdrop-paper']]) },
    { typeId: 100, fields: new Map([[2, 'SSID'], [4, 'pass'], [6, 2]]) },
  ]);

  const { records } = core.decodeContainer(container);
  const h = header.extractHeader(records);

  assert.equal(h.namespace, 12271745624591856273n);
  assert.equal(h.hint, 'com.example/tagdrop-paper');
});

test('both namespace and hint are independently optional -- a bare Type 0 record is valid', () => {
  const container = core.encodeContainer([
    { typeId: header.HEADER_TYPE, fields: new Map() },
    { typeId: 100, fields: new Map([[2, 'SSID'], [4, 'pass'], [6, 2]]) },
  ]);

  const { records } = core.decodeContainer(container);
  const h = header.extractHeader(records);

  assert.ok(h);
  assert.equal(h.namespace, undefined);
  assert.equal(h.hint, undefined);
});

test('no Type 0 record present at all is a valid, unnamespaced container', () => {
  const container = core.encodeContainer([
    { typeId: 100, fields: new Map([[2, 'SSID'], [4, 'pass'], [6, 2]]) },
  ]);

  const { records } = core.decodeContainer(container);
  assert.equal(header.extractHeader(records), undefined);
});

// ---------------------------------------------------------------------
// The positional requirement: Type 0 only counts as the header if it's
// literally the first Record. Unlike App Route/Media Payload/Fallback
// Hint (all explicitly "not positionally special"), Type 0's entire
// purpose is early identification without scanning the whole Sequence
// -- so a decoder that finds it elsewhere treats the container as
// unnamespaced rather than searching for it or hard-failing.
// ---------------------------------------------------------------------

test('a Type 0 record anywhere but first is not treated as the header', () => {
  const container = core.encodeContainer([
    { typeId: 100, fields: new Map([[2, 'SSID'], [4, 'pass'], [6, 2]]) },
    { typeId: header.HEADER_TYPE, fields: new Map([[3, 42]]) },
  ]);

  const { records } = core.decodeContainer(container);
  assert.equal(header.extractHeader(records), undefined);
  // The misplaced Type 0 record is still just an ordinary, decodable
  // Record in the Sequence -- nothing about this is malformed, it's
  // simply not recognized as the header.
  assert.equal(records[1].typeId, 0);
});

// ---------------------------------------------------------------------
// Type ID 0 is falsy in JS. Any code checking `if (record.typeId)`
// instead of `record.map.has(0)` or `typeId === undefined` would
// silently misroute a Type 0 record -- exactly the class of bug
// FINDINGS.md #14 already caught once for a different reason. Testing
// it explicitly rather than assuming the surrounding code is careful.
// ---------------------------------------------------------------------

test('a Type 0 record is not confused with "missing key 0" (typeId 0 vs null)', () => {
  const container = core.encodeContainer([
    { typeId: header.HEADER_TYPE, fields: new Map([[3, 1]]) },
  ]);

  const { records } = core.decodeContainer(container);
  assert.equal(records[0].aborted, false);
  assert.equal(records[0].typeId, 0);
  assert.notEqual(records[0].typeId, null);
  // The falsy-zero trap: `if (records[0].typeId)` would wrongly treat
  // this as absent. Guard against that class of bug directly.
  assert.equal(records[0].typeId === 0, true);
  assert.equal(Boolean(records[0].typeId), false); // confirms the trap exists
  assert.equal(records[0].map.has(0), true); // the correct way to check presence
});

// ---------------------------------------------------------------------
// An unrecognized odd key on a Type 0 record degrades exactly like any
// other Record Type's unrecognized odd key -- no special-cased logic
// needed for Type 0 beyond what §3.2 already provides everywhere else.
// ---------------------------------------------------------------------

test('an unrecognized odd key on a Type 0 record is ignored, not aborting', () => {
  const container = core.encodeContainer([
    { typeId: header.HEADER_TYPE, fields: new Map([[3, 42], [9, 'future-field']]) },
  ]);

  const { records } = core.decodeContainer(container);
  const checked = core.applyCriticality(records[0], header.HEADER_KNOWN_KEYS);

  assert.equal(checked.aborted, false);
  assert.deepEqual(checked.ignoredKeys, [9]);
  assert.equal(checked.map.get(3), 42);
});

// ---------------------------------------------------------------------
// The container as a whole: no version byte anywhere, magic + Sequence
// only. Confirms the collapse is real, not just true of the header
// module in isolation.
// ---------------------------------------------------------------------

test('the container is exactly magic + CBOR Sequence, no version byte', () => {
  const container = core.encodeContainer([
    { typeId: header.HEADER_TYPE, fields: new Map([[3, 1]]) },
  ]);

  assert.deepEqual(container.subarray(0, 4), core.MAGIC);
  // Byte immediately after magic is the start of a CBOR map (major type
  // 5), not a version integer -- there is nothing in between.
  assert.equal(container[4] >> 5, 5);
});
