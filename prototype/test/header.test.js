'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('../src/core');
const header = require('../src/header');
const { deriveHashId } = require('../src/typeHint');

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

// ---------------------------------------------------------------------
// Namespace-scoped Type IDs (spec §3.1): even uints are always global,
// odd uints require a namespace, byte strings are always global.
// resolveLookupKey classifies by CBOR type and parity, not by magnitude.
// ---------------------------------------------------------------------

test('even uint Type IDs always resolve globally, regardless of namespace', () => {
  // Even stdlib types (0, 2, 4, 8) and even common-vocabulary types (100)
  // all resolve globally — the whole point of even=standard/global.
  for (const typeId of [0, 2, 4, 8, 100, 998, 32768]) {
    const withNamespace = header.resolveLookupKey({ namespace: 111n }, typeId);
    const withoutNamespace = header.resolveLookupKey(undefined, typeId);

    assert.deepEqual(withNamespace, { scope: 'global', typeId },
      `even type ${typeId} should be global with namespace`);
    assert.deepEqual(withoutNamespace, { scope: 'global', typeId },
      `even type ${typeId} should be global without namespace`);
  }
});

test('odd uint Type IDs resolve as namespace-scoped when a namespace is declared', () => {
  const keyA = header.resolveLookupKey({ namespace: 111n }, 32769);
  const keyB = header.resolveLookupKey({ namespace: 222n }, 32769);

  assert.notDeepEqual(keyA, keyB);
  assert.deepEqual(keyA, { scope: 'namespace', namespace: 111n, typeId: 32769 });
  assert.deepEqual(keyB, { scope: 'namespace', namespace: 222n, typeId: 32769 });
});

test('odd uint Type IDs throw without a declared namespace', () => {
  assert.throws(
    () => header.resolveLookupKey(undefined, 32769),
    /odd uint Type ID 32769 requires a declared namespace/,
  );
  assert.throws(
    () => header.resolveLookupKey({ namespace: undefined }, 32769),
    /odd uint Type ID 32769 requires a declared namespace/,
  );
});

test('byte string Type IDs always resolve globally', () => {
  const byteId = Buffer.from('A7F90B3C', 'hex');
  const withNamespace = header.resolveLookupKey({ namespace: 111n }, byteId);
  const withoutNamespace = header.resolveLookupKey(undefined, byteId);

  assert.deepEqual(withNamespace, { scope: 'global', typeId: byteId });
  assert.deepEqual(withoutNamespace, { scope: 'global', typeId: byteId });
});

test('a common-vocabulary Type ID stays global even inside a declared namespace', () => {
  const GLOBAL_KNOWN_TYPES = new Map([[100, 'Wi-Fi Provisioning']]);
  function naiveDispatch(typeId) {
    return GLOBAL_KNOWN_TYPES.get(typeId); // no namespace check at all
  }

  const key = header.resolveLookupKey({ namespace: 12271745624591856273n }, 100);
  assert.deepEqual(key, { scope: 'global', typeId: 100 });
  assert.equal(naiveDispatch(key.typeId), 'Wi-Fi Provisioning');
});

test("TagDrop's migration case: old global byte string ID keeps working, new namespace-scoped odd uint for 'the same' logical type never collides", () => {
  const TAGDROP_NAMESPACE = 12271745624591856273n;
  const OLD_GLOBAL_TYPE_ID = Buffer.from('A7F90B3CDE123456', 'hex'); // pre-existing byte string ID
  const NEW_NAMESPACE_LOCAL_ID = 32769; // odd uint, chosen after adopting Type 0

  const oldStyleContainer = core.encodeContainer([
    { typeId: OLD_GLOBAL_TYPE_ID, fields: new Map([[2, 'legacy payload']]) },
  ]);
  const newStyleContainer = core.encodeContainer([
    { typeId: header.HEADER_TYPE, fields: new Map([[3, TAGDROP_NAMESPACE]]) },
    { typeId: NEW_NAMESPACE_LOCAL_ID, fields: new Map([[2, 'new payload']]) },
  ]);

  const oldRecords = core.decodeContainer(oldStyleContainer).records;
  assert.equal(
    header.resolveLookupKey(header.extractHeader(oldRecords), oldRecords[0].typeId).scope,
    'global',
  );

  const newRecords = core.decodeContainer(newStyleContainer).records;
  const newHeader = header.extractHeader(newRecords);
  const newKey = header.resolveLookupKey(newHeader, newRecords[1].typeId);
  assert.deepEqual(newKey, {
    scope: 'namespace',
    namespace: TAGDROP_NAMESPACE,
    typeId: NEW_NAMESPACE_LOCAL_ID,
  });

  // The old ID and the new one are simply different keys in different
  // scopes — nothing forces a choice between them.
  assert.notEqual(oldRecords[0].typeId, newKey.typeId);
});

// ---------------------------------------------------------------------
// §3.5's optional self-certifying strengthening for the namespace field
// itself (`namespace = truncate(SHA-256(name), N)`), reusing Type Hint's
// exact algorithm (§3.1) via typeHint.js.
// ---------------------------------------------------------------------

test('a hash-derived namespace verifies against its own Hint name (byte string)', () => {
  const name = 'com.example/tagdrop-paper';
  const namespace = deriveHashId(name, 8); // returns a Buffer

  const container = core.encodeContainer([
    { typeId: header.HEADER_TYPE, fields: new Map([[3, namespace], [5, name]]) },
  ]);
  const h = header.extractHeader(core.decodeContainer(container).records);

  assert.equal(header.verifyNamespaceHint(h.namespace, h.hint), 'verified');
});

test('a hash-derived uint namespace verifies against its own Hint name', () => {
  const name = 'com.example/tagdrop-paper';
  const digest = require('crypto').createHash('sha256').update(name, 'utf8').digest();
  const namespace = digest.readBigUInt64BE(0); // uint, not Buffer

  const container = core.encodeContainer([
    { typeId: header.HEADER_TYPE, fields: new Map([[3, namespace], [5, name]]) },
  ]);
  const h = header.extractHeader(core.decodeContainer(container).records);

  assert.equal(header.verifyNamespaceHint(h.namespace, h.hint), 'verified');
});

test('a namespace unrelated to its Hint name degrades to unverified, not an error', () => {
  assert.equal(
    header.verifyNamespaceHint(Buffer.from('DEADBEEF', 'hex'), 'com.example/totally-different-name'),
    'unverified',
  );
});

test('namespace hash-check is not-applicable with no Hint name present', () => {
  assert.equal(header.verifyNamespaceHint(Buffer.from('DEADBEEF', 'hex'), undefined), 'not-applicable');
});
