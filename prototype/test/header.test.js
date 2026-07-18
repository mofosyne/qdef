'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('../src/core');
const header = require('../src/header');

// ---------------------------------------------------------------------
// Container discriminator (§3.5): the mandatory first CBOR item after
// magic, replacing what used to be an optional Type 0 Record. Making it
// unconditionally present resolves a real ambiguity a bare namespace
// value would otherwise have (indistinguishable from a backup typeID of
// the next real Record) without reopening CBOR-tag-based routing.
// ---------------------------------------------------------------------

test('a decentralized-namespace discriminator (byte string) round-trips, no hint', () => {
  const namespace = Buffer.from('663c1cf2', 'hex');
  const container = core.encodeContainer(
    [{ typeIds: [100], fields: new Map([[0, 'SSID'], [2, 'pass'], [4, 2]]) }],
    namespace,
  );

  const { discriminator } = core.decodeContainer(container);
  const h = header.parseDiscriminator(discriminator);

  assert.deepEqual(h.namespace, namespace);
  assert.equal(h.hint, undefined);
});

test('a nonzero uint discriminator is no longer a recognized namespace shape -- degrades gracefully (there is no Allocated namespace tier)', () => {
  const container = core.encodeContainer(
    [{ typeIds: [100], fields: new Map([[0, 'SSID'], [2, 'pass'], [4, 2]]) }],
    500,
  );

  const { discriminator, records } = core.decodeContainer(container);
  assert.equal(header.parseDiscriminator(discriminator), undefined);
  assert.equal(records[0].typeId, 100); // Records after it are unaffected
});

test('the default discriminator (bare uint 0) means no namespace declared', () => {
  const container = core.encodeContainer([
    { typeIds: [100], fields: new Map([[0, 'SSID'], [2, 'pass'], [4, 2]]) },
  ]);

  const { discriminator, records } = core.decodeContainer(container);
  assert.equal(discriminator, 0);
  assert.equal(header.parseDiscriminator(discriminator), undefined);
  // Records are unaffected -- the discriminator is a structurally
  // separate item, not something a caller has to skip over manually.
  assert.equal(records[0].typeId, 100);
});

test('the full map-form discriminator round-trips namespace and hint, for cases needing more than a bare id/hint pair', () => {
  const namespace = Buffer.from('a9d6e1f30b7c4482', 'hex');
  const fullForm = new Map([
    [header.HEADER_NAMESPACE_KEY, namespace],
    [header.HEADER_NAMESPACE_HINT_KEY, 'com.example/tagdrop-paper'],
  ]);
  const container = core.encodeContainer([], fullForm);

  const { discriminator } = core.decodeContainer(container);
  const h = header.parseDiscriminator(discriminator);

  assert.ok(h.namespace.equals(namespace));
  assert.equal(h.hint, 'com.example/tagdrop-paper');
});

test('arrays are no longer a recognized discriminator shape (post-collapse) -- every array form degrades gracefully to no namespace, the same as any other unrecognized shape', () => {
  // These were all previously-recognized shapes ([uint,bstr],
  // [id,hint], [uint,bstr,hint]) -- see docs/FINDINGS.md's
  // discriminator-collapse finding for why they were cut in favor of
  // the map form being the only way to carry a hint or a backup.
  const decentralizedBackup = Buffer.from('a1b2c3d4', 'hex');
  const shapes = [
    [500, decentralizedBackup],
    [Buffer.from('663c1cf2', 'hex'), 'com.example/tagdrop-paper'],
    [500, 'com.example/tagdrop-paper'],
    [500, decentralizedBackup, 'com.example/tagdrop-paper'],
  ];

  for (const shape of shapes) {
    const container = core.encodeContainer([], shape);
    const { discriminator } = core.decodeContainer(container);
    assert.equal(
      header.parseDiscriminator(discriminator),
      undefined,
      `expected ${JSON.stringify(shape)} to degrade to no namespace`,
    );
  }
});

test('the map form also carries a second, backup namespace (key 5) for a length-promotion transition, for the same all-three-together case the array forms used to cover', () => {
  const namespace = Buffer.from('a9d6e1f30b7c4482', 'hex'); // the new, longer namespace
  const decentralizedBackup = Buffer.from('a1b2c3d4', 'hex'); // the old, shorter one
  const fullForm = new Map([
    [header.HEADER_NAMESPACE_KEY, namespace],
    [header.HEADER_NAMESPACE_HINT_KEY, 'com.example/tagdrop-paper'],
    [header.HEADER_NAMESPACE_BACKUP_KEY, decentralizedBackup],
  ]);
  const container = core.encodeContainer([], fullForm);

  const { discriminator } = core.decodeContainer(container);
  const h = header.parseDiscriminator(discriminator);

  assert.ok(h.namespace.equals(namespace));
  assert.equal(h.hint, 'com.example/tagdrop-paper');
  assert.deepEqual(h.decentralizedBackup, decentralizedBackup);
});

test('an unrecognized discriminator shape (e.g. a bare text string) degrades to no namespace, never a hard failure', () => {
  // Text string is not currently a defined discriminator form -- same
  // graceful degrade an absent or malformed header already had.
  const container = core.encodeContainer(
    [{ typeIds: [100], fields: new Map([[0, 'SSID'], [2, 'pass'], [4, 2]]) }],
    'not-a-defined-shape',
  );

  const { discriminator, records } = core.decodeContainer(container);
  assert.equal(header.parseDiscriminator(discriminator), undefined);
  assert.equal(records[0].typeId, 100); // Records after it are unaffected
});

test('a container with no Records at all is still valid -- just the mandatory discriminator', () => {
  const container = core.encodeContainer([], Buffer.from('663c1cf2', 'hex'));
  const { discriminator, records } = core.decodeContainer(container);

  assert.equal(records.length, 0);
  assert.ok(header.parseDiscriminator(discriminator));
});

test('the container is exactly magic + discriminator + CBOR Sequence, no version byte', () => {
  const container = core.encodeContainer([
    { typeIds: [100], fields: new Map([[0, 'SSID'], [2, 'pass'], [4, 2]]) },
  ]);

  assert.deepEqual(container.subarray(0, 4), core.MAGIC);
  // Byte immediately after magic is the discriminator's own CBOR head --
  // the default (bare uint 0) encodes as a single byte, 0x00.
  assert.equal(container[4], 0x00);
});

// ---------------------------------------------------------------------
// Namespace-scoped Type IDs (spec §3.1)
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

test('byte string Type IDs always resolve globally', () => {
  const byteId = Buffer.from('A7F90B3C', 'hex');
  const namespace = Buffer.from('6f6f6f6f', 'hex');
  const withNamespace = header.resolveLookupKey({ namespace }, byteId);
  const withoutNamespace = header.resolveLookupKey(undefined, byteId);

  assert.deepEqual(withNamespace, { scope: 'global', typeId: byteId });
  assert.deepEqual(withoutNamespace, { scope: 'global', typeId: byteId });
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

test("TagDrop's migration case: old global byte string ID keeps working, new namespace-scoped odd uint for 'the same' logical type never collides", () => {
  const TAGDROP_NAMESPACE = Buffer.from('a9d6e1f30b7c4482', 'hex');
  const OLD_GLOBAL_TYPE_ID = Buffer.from('A7F90B3CDE123456', 'hex');
  const NEW_NAMESPACE_LOCAL_ID = 32769;

  const oldStyleContainer = core.encodeContainer([
    { typeIds: [OLD_GLOBAL_TYPE_ID], fields: new Map([[0, 'legacy payload']]) },
  ]);
  const newStyleContainer = core.encodeContainer(
    [{ typeIds: [NEW_NAMESPACE_LOCAL_ID], fields: new Map([[0, 'new payload']]) }],
    TAGDROP_NAMESPACE,
  );

  const oldDecoded = core.decodeContainer(oldStyleContainer);
  assert.equal(
    header.resolveLookupKey(header.parseDiscriminator(oldDecoded.discriminator), oldDecoded.records[0].typeId).scope,
    'global',
  );

  const newDecoded = core.decodeContainer(newStyleContainer);
  const newHeader = header.parseDiscriminator(newDecoded.discriminator);
  const newKey = header.resolveLookupKey(newHeader, newDecoded.records[0].typeId);
  assert.deepEqual(newKey, {
    scope: 'namespace',
    namespace: TAGDROP_NAMESPACE,
    typeId: NEW_NAMESPACE_LOCAL_ID,
  });

  assert.notEqual(oldDecoded.records[0].typeId, newKey.typeId);
});
