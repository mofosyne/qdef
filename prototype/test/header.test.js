'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const core = require('../src/core');
const header = require('../src/header');

// ---------------------------------------------------------------------
// Record Type 0: reserved container-level metadata (format namespace +
// optional Hint name), landed after collapsing what had been a separate
// fixed/positional header concept into "just another Record" -- no
// version byte, no non-Record header structure at all.
// ---------------------------------------------------------------------

test('a Type 0 header record round-trips namespace and hint', () => {
  const container = core.encodeContainer([
    { typeIds: [header.HEADER_TYPE], fields: new Map([[1, 12271745624591856273n], [3, 'com.example/tagdrop-paper']]) },
    { typeIds: [100], fields: new Map([[0, 'SSID'], [2, 'pass'], [4, 2]]) },
  ]);

  const { records } = core.decodeContainer(container);
  const h = header.extractHeader(records);

  assert.equal(h.namespace, 12271745624591856273n);
  assert.equal(h.hint, 'com.example/tagdrop-paper');
});

test('both namespace and hint are independently optional -- a bare Type 0 record is valid', () => {
  const container = core.encodeContainer([
    { typeIds: [header.HEADER_TYPE], fields: new Map() },
    { typeIds: [100], fields: new Map([[0, 'SSID'], [2, 'pass'], [4, 2]]) },
  ]);

  const { records } = core.decodeContainer(container);
  const h = header.extractHeader(records);

  assert.ok(h);
  assert.equal(h.namespace, undefined);
  assert.equal(h.hint, undefined);
});

test('no Type 0 record present at all is a valid, unnamespaced container', () => {
  const container = core.encodeContainer([
    { typeIds: [100], fields: new Map([[0, 'SSID'], [2, 'pass'], [4, 2]]) },
  ]);

  const { records } = core.decodeContainer(container);
  assert.equal(header.extractHeader(records), undefined);
});

test('a Type 0 record anywhere but first is not treated as the header', () => {
  const container = core.encodeContainer([
    { typeIds: [100], fields: new Map([[0, 'SSID'], [2, 'pass'], [4, 2]]) },
    { typeIds: [header.HEADER_TYPE], fields: new Map([[1, 42]]) },
  ]);

  const { records } = core.decodeContainer(container);
  assert.equal(header.extractHeader(records), undefined);
  assert.equal(records[1].typeId, 0);
});

test('a Type 0 record is not confused with "missing typeID" (typeId 0 vs null)', () => {
  const container = core.encodeContainer([
    { typeIds: [header.HEADER_TYPE], fields: new Map([[1, 1]]) },
  ]);

  const { records } = core.decodeContainer(container);
  assert.equal(records[0].ignored, false);
  assert.equal(records[0].typeId, 0);
  assert.notEqual(records[0].typeId, null);
  assert.equal(records[0].typeId === 0, true);
  assert.equal(Boolean(records[0].typeId), false); // confirms the falsy trap exists
});

test('an unrecognized odd key on a Type 0 record is ignored, not aborting', () => {
  const container = core.encodeContainer([
    { typeIds: [header.HEADER_TYPE], fields: new Map([[1, 42], [7, 'future-field']]) },
  ]);

  const { records } = core.decodeContainer(container);
  const checked = core.applyCriticality(records[0], header.HEADER_KNOWN_KEYS);

  assert.equal(checked.aborted, false);
  assert.deepEqual(checked.ignoredKeys, [7]);
  assert.equal(checked.map.get(1), 42);
});

test('the container is exactly magic + CBOR Sequence, no version byte', () => {
  const container = core.encodeContainer([
    { typeIds: [header.HEADER_TYPE], fields: new Map([[1, 1]]) },
  ]);

  assert.deepEqual(container.subarray(0, 4), core.MAGIC);
  // Byte immediately after magic is the start of the typeID (uint, major type 0).
  assert.equal(container[4] >> 5, 0);
});

// ---------------------------------------------------------------------
// Namespace-scoped Type IDs (spec §3.1)
// ---------------------------------------------------------------------

test('even uint Type IDs always resolve globally, regardless of namespace', () => {
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
    return GLOBAL_KNOWN_TYPES.get(typeId);
  }

  const key = header.resolveLookupKey({ namespace: 12271745624591856273n }, 100);
  assert.deepEqual(key, { scope: 'global', typeId: 100 });
  assert.equal(naiveDispatch(key.typeId), 'Wi-Fi Provisioning');
});

test("TagDrop's migration case: old global byte string ID keeps working, new namespace-scoped odd uint for 'the same' logical type never collides", () => {
  const TAGDROP_NAMESPACE = 12271745624591856273n;
  const OLD_GLOBAL_TYPE_ID = Buffer.from('A7F90B3CDE123456', 'hex');
  const NEW_NAMESPACE_LOCAL_ID = 32769;

  const oldStyleContainer = core.encodeContainer([
    { typeIds: [OLD_GLOBAL_TYPE_ID], fields: new Map([[0, 'legacy payload']]) },
  ]);
  const newStyleContainer = core.encodeContainer([
    { typeIds: [header.HEADER_TYPE], fields: new Map([[1, TAGDROP_NAMESPACE]]) },
    { typeIds: [NEW_NAMESPACE_LOCAL_ID], fields: new Map([[0, 'new payload']]) },
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

  assert.notEqual(oldRecords[0].typeId, newKey.typeId);
});
