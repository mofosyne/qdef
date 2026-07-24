'use strict';
// A Record's own prefix MAY declare or override its namespace inline,
// independent of whatever ambient namespace it inherited (§3.1) -- the
// exact same mechanism the container root now uses for its own
// namespace, since there is no separate container discriminator
// anymore (see docs/DESIGN.md).
//
// This is strictly an opt-in escape hatch, not a cheaper substitute for
// an ambient namespace that already amortizes across every Record under
// it: a pairing item is paid fresh on every Record that uses it, with
// no amortization. See the byte-cost FINDING below.

const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('../src/core');
const header = require('../src/header');
const wrappers = require('../src/wrappers');

const AMBIENT_NAMESPACE = Buffer.from('11111111', 'hex');
const OVERRIDE_NAMESPACE = Buffer.from('cdcdcdcd', 'hex');
const KNOWN_KEYS = new Set([0]);

test('a uint in the namespace slot is not recognized as a namespace at all -- the flat grammar reads it directly as this Record\'s own typeID instead, and the intended typeID becomes a skipped stray item', () => {
  const bytes = core.encodeRecordBytes({
    typeId: 1,
    fields: new Map([[0, 'payload']]),
    localNamespace: 100, // uint -- namespace values are byte-string only now
  });
  const rec = core.decodeRecordBytes(bytes);
  // Namespace recognition (§3.1) requires the array's first element to
  // be a byte string; a uint there is unconditionally valid typeID
  // shape on its own, so it's read as the typeID directly -- there is
  // no shape left over that could mean "malformed namespace pairing."
  // The originally-intended typeID (1) becomes forward-compat padding,
  // skipped in Phase 2.
  assert.equal(rec.typeId, 100);
  assert.equal(rec.localNamespace, undefined);
});

test('a namespace-pairing prefix item round-trips: byte string (Decentralized) namespace paired with a scoped typeID', () => {
  const bytes = core.encodeRecordBytes({
    typeId: 1,
    fields: new Map([[0, 'payload']]),
    localNamespace: OVERRIDE_NAMESPACE,
  });
  const rec = core.decodeRecordBytes(bytes);
  assert.equal(rec.typeId, 1);
  assert.ok(rec.localNamespace.equals(OVERRIDE_NAMESPACE));
});

test('a Record with no pairing item has localNamespace undefined -- the ordinary, unaffected case', () => {
  const bytes = core.encodeRecordBytes({
    typeId: 1,
    fields: new Map([[0, 'payload']]),
  });
  const rec = core.decodeRecordBytes(bytes);
  assert.equal(rec.localNamespace, undefined);
});

test('resolveLookupKeyForRecord: a local override takes priority over an inherited ambient namespace', () => {
  const bytes = core.encodeRecordBytes({
    typeId: 1,
    fields: new Map([[0, 'payload']]),
    localNamespace: OVERRIDE_NAMESPACE,
  });
  const rec = core.decodeRecordBytes(bytes);
  const ambientHeader = { namespace: AMBIENT_NAMESPACE };

  const key = header.resolveLookupKeyForRecord(rec, ambientHeader);
  assert.equal(key.scope, 'namespace');
  assert.ok(key.namespace.equals(OVERRIDE_NAMESPACE));
  assert.ok(!key.namespace.equals(AMBIENT_NAMESPACE));
});

test('resolveLookupKeyForRecord: falls back to the inherited ambient namespace when the Record declares no override', () => {
  const bytes = core.encodeRecordBytes({
    typeId: 1,
    fields: new Map([[0, 'payload']]),
  });
  const rec = core.decodeRecordBytes(bytes);
  const ambientHeader = { namespace: AMBIENT_NAMESPACE };

  const key = header.resolveLookupKeyForRecord(rec, ambientHeader);
  assert.equal(key.scope, 'namespace');
  assert.ok(key.namespace.equals(AMBIENT_NAMESPACE));
});

test('resolveLookupKeyForRecord: an odd/scoped typeID with neither a local override nor an ambient namespace still aborts', () => {
  const bytes = core.encodeRecordBytes({
    typeId: 1,
    fields: new Map([[0, 'payload']]),
  });
  const rec = core.decodeRecordBytes(bytes);

  assert.throws(
    () => header.resolveLookupKeyForRecord(rec, undefined),
    /odd uint Type ID .* requires a declared namespace/,
  );
});

test('an even typeID inside a pairing is vacuous -- still always global, matching the existing invariant that even typeIDs ignore any declared namespace', () => {
  const bytes = core.encodeRecordBytes({
    typeId: 100, // even
    fields: new Map([[0, 'payload']]),
    localNamespace: OVERRIDE_NAMESPACE,
  });
  const rec = core.decodeRecordBytes(bytes);
  const ambientHeader = { namespace: AMBIENT_NAMESPACE };

  const key = header.resolveLookupKeyForRecord(rec, ambientHeader);
  assert.equal(key.scope, 'global');
  assert.equal(key.typeId, 100);
});

test('FINDING: multiple namespaces coexist within one container -- the root\'s own namespace stays the cheap ambient default, one subrecord opts into a different namespace', () => {
  const container = core.encodeContainer({
    typeId: 0,
    localNamespace: AMBIENT_NAMESPACE,
    subrecords: [
      { typeId: 1, fields: new Map([[0, 'uses ambient namespace']]) },
      {
        typeId: 3,
        fields: new Map([[0, 'uses its own namespace']]),
        localNamespace: OVERRIDE_NAMESPACE,
      },
    ],
  });

  const root = core.decodeContainer(container);
  assert.equal(root.subrecords.length, 2);

  const resolved = header.resolveLookupKeysDeep(root, undefined);
  // resolved[0] is the root itself (even, global); [1]/[2] are its subrecords.
  const keyForFirst = resolved[1].key;
  const keyForSecond = resolved[2].key;

  assert.ok(keyForFirst.namespace.equals(AMBIENT_NAMESPACE));
  assert.ok(keyForSecond.namespace.equals(OVERRIDE_NAMESPACE));
  assert.ok(!keyForFirst.namespace.equals(keyForSecond.namespace));
});

test('resolveStack: the terminal Record of a resolved Wrapper stack can carry its own namespace override', () => {
  const innerBytes = core.encodeRecordBytes({
    typeId: 1,
    fields: new Map([[0, 'wrapped payload']]),
    localNamespace: OVERRIDE_NAMESPACE,
  });
  const compressed = wrappers.compressEncode(innerBytes);
  const codeBytes = core.encodeContainer({ ...compressed, localNamespace: AMBIENT_NAMESPACE });

  const knownKeysRegistry = new Map([
    [wrappers.COMPRESS_TYPE, wrappers.COMPRESS_KNOWN_KEYS],
    [1, KNOWN_KEYS],
  ]);
  const terminal = wrappers.resolveStack([codeBytes], {}, knownKeysRegistry);

  assert.equal(terminal.typeId, 1);
  assert.ok(terminal.namespace.equals(OVERRIDE_NAMESPACE));
  assert.ok(!terminal.namespace.equals(AMBIENT_NAMESPACE));
});

test('FINDING: the pairing form is NOT a cheaper substitute for an ambient namespace -- it is an opt-in override, paid fresh per Record with no amortization', () => {
  function bareCost(typeId, fields, localNamespace) {
    return core.encodeRecordBytes({ typeId, fields: fields || new Map(), localNamespace }).length;
  }

  const paired = bareCost(1, undefined, OVERRIDE_NAMESPACE);
  const bareTypeIdNoOverride = bareCost(1);

  assert.equal(paired, 7);
  assert.equal(bareTypeIdNoOverride, 2);
  // Verified, not asserted: pairing with a namespace override costs MORE
  // per Record than the same typeID with no override at all -- because
  // it bundles a full namespace declaration onto every Record that uses
  // it, unlike an ambient namespace's one-time, amortized-across-every-
  // subrecord cost. This form exists to answer "can this one Record use
  // a different namespace than the one it inherited" -- only pay for it
  // when that's actually what's needed.
  assert.ok(paired > bareTypeIdNoOverride);
});
