'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('../src/core');
const header = require('../src/header');
const rt = require('../src/recordTypes');

// ---------------------------------------------------------------------
// Namespace (§3.1/§3.5): there is no separate container discriminator
// anymore -- a namespace is just the root Record's own namespace-
// pairing prefix, the identical mechanism any subrecord already has.
// See docs/DESIGN.md and docs/FINDINGS.md for why this collapsed once
// typeId became optional and namespace recognition dropped its
// "must be immediately followed by a valid typeId" requirement.
// ---------------------------------------------------------------------

test('a namespace on the root Record round-trips, no hint, with one content subrecord', () => {
  const namespace = Buffer.from('663c1cf2', 'hex');
  const container = core.encodeContainer({
    localNamespace: namespace,
    subrecords: [{ typeId: 100, fields: new Map([[0, 'SSID'], [2, 'pass'], [4, 2]]) }],
  });

  const root = core.decodeContainer(container);
  assert.ok(root.localNamespace.equals(namespace));
  assert.equal(root.typeId, 0);
  assert.equal(root.subrecords[0].typeId, 100);
});

test('no namespace declared means the root Record simply has no localNamespace -- there is no longer a distinct "default discriminator" concept', () => {
  const container = core.encodeContainer({
    subrecords: [{ typeId: 100, fields: new Map([[0, 'SSID'], [2, 'pass'], [4, 2]]) }],
  });

  const root = core.decodeContainer(container);
  assert.equal(root.localNamespace, undefined);
  assert.equal(root.subrecords[0].typeId, 100);
});

test('the root Record\'s own map carries a namespace hint (Bundle key 3), for cases needing more than a bare namespace', () => {
  const namespace = Buffer.from('a9d6e1f30b7c4482', 'hex');
  const container = core.encodeContainer({
    localNamespace: namespace,
    fields: new Map([[rt.BUNDLE_HINT_KEY, 'com.example/tagdrop-paper']]),
  });

  const root = core.decodeContainer(container);
  assert.ok(root.localNamespace.equals(namespace));
  assert.equal(root.map.get(rt.BUNDLE_HINT_KEY), 'com.example/tagdrop-paper');
});

test('the root Record\'s own map also carries a second, backup namespace (Bundle key 5) for a length-promotion transition', () => {
  const namespace = Buffer.from('a9d6e1f30b7c4482', 'hex'); // the new, longer namespace
  const decentralizedBackup = Buffer.from('a1b2c3d4', 'hex'); // the old, shorter one
  const container = core.encodeContainer({
    localNamespace: namespace,
    fields: new Map([
      [rt.BUNDLE_HINT_KEY, 'com.example/tagdrop-paper'],
      [rt.BUNDLE_BACKUP_NAMESPACE_KEY, decentralizedBackup],
    ]),
  });

  const root = core.decodeContainer(container);
  assert.ok(root.localNamespace.equals(namespace));
  assert.equal(root.map.get(rt.BUNDLE_HINT_KEY), 'com.example/tagdrop-paper');
  assert.ok(root.map.get(rt.BUNDLE_BACKUP_NAMESPACE_KEY).equals(decentralizedBackup));
});

test('a container with no content Records at all is still valid -- just a namespace declaration', () => {
  const container = core.encodeContainer({ localNamespace: Buffer.from('663c1cf2', 'hex') });
  const root = core.decodeContainer(container);

  assert.equal(root.subrecords, undefined);
  assert.ok(root.localNamespace);
});

test('the container is exactly magic + the root Record\'s own items, no discriminator and no version byte', () => {
  const container = core.encodeContainer({
    subrecords: [{ typeId: 100, fields: new Map([[0, 'SSID'], [2, 'pass'], [4, 2]]) }],
  });

  assert.deepEqual(container.subarray(0, 4), core.MAGIC);
  // No leading discriminator byte anymore -- the byte right after magic
  // is already the subrecord's own array header (0x82, a 2-element
  // array: typeId and map, nothing else).
  assert.equal(container[4], 0x82);
});

// ---------------------------------------------------------------------
// Namespace Hint hash-derivation verification (spec §3.5). N is simply
// the candidate namespace's own byte length (always a byte string).
// ---------------------------------------------------------------------

test('a namespace Hint that hash-derivation actually backs verifies -- narrow (4-byte) width', () => {
  const namespace = header.deriveHashId('com.example/tagdrop-paper', 4);
  assert.equal(header.verifyNamespaceHint(namespace, 'com.example/tagdrop-paper'), 'verified');
});

test('a namespace Hint verifies at wide (8-byte) width too -- the bug this locks in: an earlier version always truncated to 4 bytes regardless of the candidate ID\'s own magnitude, so a genuinely wide ID could never verify', () => {
  const namespace = header.deriveHashId('com.example/tagdrop-paper', 8);
  assert.equal(header.verifyNamespaceHint(namespace, 'com.example/tagdrop-paper'), 'verified');
});

test('a namespace Hint naming a different string than the one that actually derived the namespace is unverified, not silently accepted', () => {
  const namespace = header.deriveHashId('com.example/tagdrop-paper', 4);
  assert.equal(header.verifyNamespaceHint(namespace, 'com.example/some-other-name'), 'unverified');
});

test('a purely random namespace with no hash-derivation backing it at all is also just unverified -- self-certification is opportunistic, never required', () => {
  const namespace = Buffer.from('deadbeef', 'hex');
  assert.equal(header.verifyNamespaceHint(namespace, 'com.example/tagdrop-paper'), 'unverified');
});

test('no Hint name present means nothing to verify -- not-applicable, not a failure', () => {
  const namespace = Buffer.from('663c1cf2', 'hex');
  assert.equal(header.verifyNamespaceHint(namespace, undefined), 'not-applicable');
  assert.equal(header.verifyNamespaceHint(undefined, 'com.example/tagdrop-paper'), 'not-applicable');
});

test('a real decoded root namespace round-trips into a verifiable Hint end to end', () => {
  const namespace = header.deriveHashId('com.example/tagdrop-paper', 8);
  const container = core.encodeContainer({
    localNamespace: namespace,
    fields: new Map([[rt.BUNDLE_HINT_KEY, 'com.example/tagdrop-paper']]),
  });

  const root = core.decodeContainer(container);
  assert.equal(header.verifyNamespaceHint(root.localNamespace, root.map.get(rt.BUNDLE_HINT_KEY)), 'verified');
});

// ---------------------------------------------------------------------
// Namespace-scoped Type IDs (spec §3.1) -- pure resolution logic,
// unaffected by how the namespace value itself got onto the wire.
// ---------------------------------------------------------------------

test('even uint Type IDs always resolve globally, regardless of namespace', () => {
  const namespace = Buffer.from('6f6f6f6f', 'hex');
  for (const typeId of [0, 2, 4, 8, 100, 998, 32768]) {
    const withNamespace = header.resolveLookupKey({ namespace }, typeId);
    const withoutNamespace = header.resolveLookupKey(undefined, typeId);

    assert.deepEqual(withNamespace, { scope: 'global', typeId },
      `even type ${typeId} should be global with namespace`);
    assert.deepEqual(withoutNamespace, { scope: 'global', typeId },
      `even type ${typeId} should be global without namespace`);
  }
});

test('odd uint Type IDs resolve as namespace-scoped when a namespace is declared', () => {
  const namespaceA = Buffer.from('11111111', 'hex');
  const namespaceB = Buffer.from('22222222', 'hex');
  const keyA = header.resolveLookupKey({ namespace: namespaceA }, 32769);
  const keyB = header.resolveLookupKey({ namespace: namespaceB }, 32769);

  assert.notDeepEqual(keyA, keyB);
  assert.deepEqual(keyA, { scope: 'namespace', namespace: namespaceA, typeId: 32769 });
  assert.deepEqual(keyB, { scope: 'namespace', namespace: namespaceB, typeId: 32769 });
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

test('a common-vocabulary Type ID stays global even inside a declared namespace', () => {
  const GLOBAL_KNOWN_TYPES = new Map([[100, 'Wi-Fi Provisioning']]);
  function naiveDispatch(typeId) {
    return GLOBAL_KNOWN_TYPES.get(typeId);
  }

  const namespace = Buffer.from('a9d6e1f30b7c4482', 'hex');
  const key = header.resolveLookupKey({ namespace }, 100);
  assert.deepEqual(key, { scope: 'global', typeId: 100 });
  assert.equal(naiveDispatch(key.typeId), 'Wi-Fi Provisioning');
});

test("an old self-allocated even Type ID and a new namespace-scoped odd Type ID never collide -- structurally independent mechanisms, no promotion/migration bridge needed between them", () => {
  // There is no backup-typeID promotion mechanism anymore (docs/FINDINGS.md)
  // -- an adopter with an existing self-allocated even ID and a newly-
  // adopted namespace-scoped odd ID for new content just has two
  // independent, never-colliding identities, not a "before/after" pair
  // needing a bridge.
  const TAGDROP_NAMESPACE = Buffer.from('a9d6e1f30b7c4482', 'hex');
  const OLD_SELF_ALLOCATED_ID = 32770; // even -- always global
  const NEW_NAMESPACE_LOCAL_ID = 32769; // odd -- namespace-scoped

  const oldStyleContainer = core.encodeContainer({
    typeId: OLD_SELF_ALLOCATED_ID,
    fields: new Map([[0, 'legacy payload']]),
  });
  const newStyleContainer = core.encodeContainer({
    localNamespace: TAGDROP_NAMESPACE,
    typeId: NEW_NAMESPACE_LOCAL_ID,
    fields: new Map([[0, 'new payload']]),
  });

  const oldDecoded = core.decodeContainer(oldStyleContainer);
  assert.equal(header.resolveLookupKeyForRecord(oldDecoded, undefined).scope, 'global');

  const newDecoded = core.decodeContainer(newStyleContainer);
  const newKey = header.resolveLookupKeyForRecord(newDecoded, undefined);
  assert.deepEqual(newKey, {
    scope: 'namespace',
    namespace: TAGDROP_NAMESPACE,
    typeId: NEW_NAMESPACE_LOCAL_ID,
  });

  assert.notEqual(oldDecoded.typeId, newKey.typeId);
});
