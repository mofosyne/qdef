'use strict';
// A Record's own prefix MAY declare or override its namespace inline,
// independent of the container discriminator's ambient one (§3.1/§3.5).
// Motivated by reopening "Multiple namespaces per container" (DESIGN.md
// -- previously "considered, not built") with a mechanism that avoids
// the two costs that sank the earlier options: no stateful position-
// based re-scoping, and no mandatory selector field added to *every*
// namespace-scoped Record -- only a Record that actually wants a
// namespace other than the container's ambient one pays anything extra.
//
// This is strictly an opt-in escape hatch, not a cheaper substitute for
// the container discriminator, which amortizes across every Record in
// the container: a pairing item is paid fresh on every Record that uses
// it, with no amortization. See the byte-cost FINDING below.

const test = require('node:test');
const assert = require('node:assert/strict');
const cbor = require('cbor');

const core = require('../src/core');
const header = require('../src/header');
const wrappers = require('../src/wrappers');

const AMBIENT_NAMESPACE = Buffer.from('11111111', 'hex');
const OVERRIDE_NAMESPACE = Buffer.from('cdcdcdcd', 'hex');
const KNOWN_KEYS = new Set([0]);

test('a uint in the namespace slot is no longer a recognized pairing item -- there is no Allocated namespace tier, so the Record loses its only typeID and becomes unroutable, not just its namespace', () => {
  const bytes = core.encodeRecordBytes({
    typeId: 1,
    fields: new Map([[0, 'payload']]),
    localNamespace: 100, // uint -- namespace values are byte-string only now
  });
  const [rec] = core.decodeSequence(bytes);
  // [100, 1] is no longer recognized as a namespace-pairing item, so it
  // falls through to being an ordinary unrecognized prefix item -- Phase
  // 1 finds no typeID at all before the map, same as if the Record's
  // prefix were empty.
  assert.equal(rec.ignored, true);
  assert.equal(rec.typeId, null);
});

test('a namespace-pairing prefix item round-trips: byte string (Decentralized) namespace paired with a scoped typeID', () => {
  const bytes = core.encodeRecordBytes({
    typeId: 1,
    fields: new Map([[0, 'payload']]),
    localNamespace: OVERRIDE_NAMESPACE,
  });
  const [rec] = core.decodeSequence(bytes);
  assert.equal(rec.ignored, false);
  assert.equal(rec.typeId, 1);
  assert.ok(rec.localNamespace.equals(OVERRIDE_NAMESPACE));
});

test('a Record with no pairing item has localNamespace undefined -- the ordinary, unaffected case', () => {
  const bytes = core.encodeRecordBytes({
    typeId: 1,
    fields: new Map([[0, 'payload']]),
  });
  const [rec] = core.decodeSequence(bytes);
  assert.equal(rec.localNamespace, undefined);
});

test('resolveLookupKeyForRecord: a local override takes priority over the container-ambient namespace', () => {
  const bytes = core.encodeRecordBytes({
    typeId: 1,
    fields: new Map([[0, 'payload']]),
    localNamespace: OVERRIDE_NAMESPACE,
  });
  const [rec] = core.decodeSequence(bytes);
  const ambientHeader = header.parseDiscriminator(AMBIENT_NAMESPACE);

  const key = header.resolveLookupKeyForRecord(rec, ambientHeader);
  assert.equal(key.scope, 'namespace');
  assert.ok(key.namespace.equals(OVERRIDE_NAMESPACE));
  assert.ok(!key.namespace.equals(AMBIENT_NAMESPACE));
});

test('resolveLookupKeyForRecord: falls back to the container-ambient namespace when the Record declares no override', () => {
  const bytes = core.encodeRecordBytes({
    typeId: 1,
    fields: new Map([[0, 'payload']]),
  });
  const [rec] = core.decodeSequence(bytes);
  const ambientHeader = header.parseDiscriminator(AMBIENT_NAMESPACE);

  const key = header.resolveLookupKeyForRecord(rec, ambientHeader);
  assert.equal(key.scope, 'namespace');
  assert.ok(key.namespace.equals(AMBIENT_NAMESPACE));
});

test('resolveLookupKeyForRecord: an odd/scoped typeID with neither a local override nor an ambient namespace still aborts', () => {
  const bytes = core.encodeRecordBytes({
    typeId: 1,
    fields: new Map([[0, 'payload']]),
  });
  const [rec] = core.decodeSequence(bytes);

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
  const [rec] = core.decodeSequence(bytes);
  const ambientHeader = header.parseDiscriminator(AMBIENT_NAMESPACE);

  const key = header.resolveLookupKeyForRecord(rec, ambientHeader);
  assert.equal(key.scope, 'global');
  assert.equal(key.typeId, 100);
});

test('FINDING: multiple namespaces coexist within one container -- the ambient discriminator stays the cheap default, one Record opts into a different namespace', () => {
  const ambientScopedRecord = { typeId: 1, fields: new Map([[0, 'uses ambient namespace']]) };
  const overrideScopedRecord = {
    typeId: 3,
    fields: new Map([[0, 'uses its own namespace']]),
    localNamespace: OVERRIDE_NAMESPACE,
  };

  const containerBytes = Buffer.concat([
    core.MAGIC,
    cbor.encodeCanonical(AMBIENT_NAMESPACE), // container discriminator
    core.encodeRecordBytes(ambientScopedRecord),
    core.encodeRecordBytes(overrideScopedRecord),
  ]);

  const { discriminator, records } = core.decodeContainer(containerBytes);
  const containerHeader = header.parseDiscriminator(discriminator);
  assert.equal(records.length, 2);

  const keyForFirst = header.resolveLookupKeyForRecord(records[0], containerHeader);
  const keyForSecond = header.resolveLookupKeyForRecord(records[1], containerHeader);

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
  const codeBytes = core.encodeContainer([compressed], AMBIENT_NAMESPACE);

  const knownKeysRegistry = new Map([
    [wrappers.COMPRESS_TYPE, wrappers.COMPRESS_KNOWN_KEYS],
    [1, KNOWN_KEYS],
  ]);
  const terminal = wrappers.resolveStack([codeBytes], {}, knownKeysRegistry);

  assert.equal(terminal.typeId, 1);
  assert.ok(terminal.namespace.equals(OVERRIDE_NAMESPACE));
  assert.ok(!terminal.namespace.equals(AMBIENT_NAMESPACE));
});

test('FINDING: the pairing form is NOT a cheaper substitute for the container discriminator -- it is an opt-in override, paid fresh per Record with no amortization', () => {
  function bareCost(typeId, fields, localNamespace) {
    return core.encodeRecordBytes({ typeId, fields: fields || new Map(), localNamespace }).length;
  }

  const paired = bareCost(1, undefined, OVERRIDE_NAMESPACE);
  const bareTypeIdNoOverride = bareCost(1);

  assert.equal(paired, 8);
  assert.equal(bareTypeIdNoOverride, 2);
  // Verified, not asserted: pairing with a namespace override costs MORE
  // per Record than the same typeID with no override at all (8 > 2) --
  // because it bundles a full namespace declaration onto every Record
  // that uses it, unlike the container discriminator's one-time,
  // amortized-across-the-whole-container cost. This form exists to
  // answer "can this one Record use a different namespace than the
  // container's ambient one" -- only pay for it when that's actually
  // what's needed.
  assert.ok(paired > bareTypeIdNoOverride);
});
