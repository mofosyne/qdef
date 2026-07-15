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
// either the container discriminator (which amortizes across every
// Record in the container) or a standalone decentralized Record ID
// (§3.1's byte string typeID, always global, individually
// self-certifying): a pairing item is paid fresh on every Record that
// uses it, with no amortization. See the byte-cost FINDING below.

const test = require('node:test');
const assert = require('node:assert/strict');
const cbor = require('cbor');

const core = require('../src/core');
const header = require('../src/header');
const wrappers = require('../src/wrappers');

const AMBIENT_NAMESPACE = Buffer.from('11111111', 'hex');
const OVERRIDE_NAMESPACE = Buffer.from('cdcdcdcd', 'hex');
const ALLOCATED_NAMESPACE = 100;
const KNOWN_KEYS = new Set([0]);

test('a namespace-pairing prefix item round-trips: uint (Allocated) namespace paired with a scoped typeID', () => {
  const bytes = core.encodeRecordBytes({
    typeIds: [1],
    fields: new Map([[0, 'payload']]),
    localNamespace: ALLOCATED_NAMESPACE,
  });
  const [rec] = core.decodeSequence(bytes);
  assert.equal(rec.ignored, false);
  assert.equal(rec.typeId, 1);
  assert.equal(rec.localNamespace, ALLOCATED_NAMESPACE);
  assert.equal(rec.map.get(0), 'payload');
});

test('a namespace-pairing prefix item round-trips: byte string (Decentralized) namespace paired with a scoped typeID', () => {
  const bytes = core.encodeRecordBytes({
    typeIds: [1],
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
    typeIds: [1],
    fields: new Map([[0, 'payload']]),
  });
  const [rec] = core.decodeSequence(bytes);
  assert.equal(rec.localNamespace, undefined);
});

test('resolveLookupKeyForRecord: a local override takes priority over the container-ambient namespace', () => {
  const bytes = core.encodeRecordBytes({
    typeIds: [1],
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
    typeIds: [1],
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
    typeIds: [1],
    fields: new Map([[0, 'payload']]),
  });
  const [rec] = core.decodeSequence(bytes);

  assert.throws(
    () => header.resolveLookupKeyForRecord(rec, undefined),
    /odd uint Type ID .* requires a declared namespace/,
  );
});

test('an even (Allocated) typeID inside a pairing is vacuous -- still always global, matching the existing invariant that even typeIDs ignore any declared namespace', () => {
  const bytes = core.encodeRecordBytes({
    typeIds: [100], // even
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
  const ambientScopedRecord = { typeIds: [1], fields: new Map([[0, 'uses ambient namespace']]) };
  const overrideScopedRecord = {
    typeIds: [3],
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

test('backup typeIDs still work alongside a pairing primary -- the same promotion pattern §3.1 already uses, applied to a namespace-scoped primary', () => {
  const bytes = core.encodeRecordBytes({
    typeIds: [1, Buffer.from('A7F90B3C', 'hex')], // primary: scoped uint; backup: decentralized global
    fields: new Map([[0, 'payload']]),
    localNamespace: OVERRIDE_NAMESPACE,
  });
  const [rec] = core.decodeSequence(bytes);
  assert.equal(rec.typeIds.length, 2);
  assert.equal(rec.typeId, 1); // primary is the pairing's nested id
  assert.ok(rec.typeIds[1].equals(Buffer.from('A7F90B3C', 'hex')));
  assert.ok(rec.localNamespace.equals(OVERRIDE_NAMESPACE));
});

test('resolveStack: the terminal Record of a resolved Wrapper stack can carry its own namespace override', () => {
  const innerBytes = core.encodeRecordBytes({
    typeIds: [1],
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

test('FINDING: the pairing form is NOT a cheaper substitute for a standalone decentralized Record ID or the container discriminator -- it is an opt-in override, paid fresh per Record with no amortization', () => {
  function bareCost(typeIds, fields, localNamespace) {
    return core.encodeRecordBytes({ typeIds, fields: fields || new Map(), localNamespace }).length;
  }

  const pairedAllocated = bareCost([1], undefined, ALLOCATED_NAMESPACE);
  const pairedDecentralized = bareCost([1], undefined, OVERRIDE_NAMESPACE);
  const standaloneDecentralizedId = bareCost([Buffer.alloc(4, 0xab)]);

  assert.equal(pairedAllocated, 5);
  assert.equal(pairedDecentralized, 8);
  assert.equal(standaloneDecentralizedId, 6);
  // Verified, not asserted: pairing with a decentralized namespace costs
  // MORE per Record than a plain standalone decentralized Record ID
  // (7 > 5) -- because it bundles a full namespace declaration onto
  // every Record that uses it, unlike the container discriminator's
  // one-time, amortized-across-the-whole-container cost. This form
  // exists to answer "can this one Record use a different namespace
  // than the container's ambient one", not "how do I cheaply get a
  // decentralized ID" -- that's still what a standalone byte string
  // typeID is for.
  assert.ok(pairedDecentralized > standaloneDecentralizedId);
});
