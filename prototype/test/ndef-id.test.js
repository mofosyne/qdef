'use strict';
// The NDEF-ID-equivalent (§3.1): a bare text string immediately following
// a Record's typeID item, a stable, type-independent external reference
// mirroring NDEF's own ID field. Reuses the text-string prefix-item slot
// that used to be reserved for a future "Named ID" typeID form and for
// Type Hint verification strings -- both retired alongside decentralized
// Type IDs, resolving which of two competing experimental prototypes
// (an array-wrapper prefix item, and a reserved negative map key) QDEF
// actually adopted: neither -- a bare text string needed no new shape at
// all, since the slot already existed, just unclaimed.

const test = require('node:test');
const assert = require('node:assert/strict');
const cbor = require('cbor');

const core = require('../src/core');

test('an NDEF-ID text string round-trips alongside an ordinary typeID', () => {
  const bytes = core.encodeRecordBytes({
    typeId: 100,
    fields: new Map([[0, 'SSID']]),
    ndefId: 'wifi-record-1',
  });
  const rec = core.decodeRecordBytes(bytes);

  assert.equal(rec.ignored, false);
  assert.equal(rec.typeId, 100);
  assert.equal(rec.ndefId, 'wifi-record-1');
  assert.equal(rec.map.get(0), 'SSID');
});

test('an NDEF-ID coexists with a namespace-pairing typeID -- both prefix concepts stack cleanly', () => {
  const namespace = Buffer.from('cdcdcdcd', 'hex');
  const bytes = core.encodeRecordBytes({
    typeId: 1,
    fields: new Map([[0, 'payload']]),
    localNamespace: namespace,
    ndefId: 'scoped-record-1',
  });
  const rec = core.decodeRecordBytes(bytes);

  assert.equal(rec.ignored, false);
  assert.equal(rec.typeId, 1);
  assert.ok(rec.localNamespace.equals(namespace));
  assert.equal(rec.ndefId, 'scoped-record-1');
});

test('a Record with no NDEF-ID has the field undefined -- zero-cost when unused', () => {
  const bytes = core.encodeRecordBytes({
    typeId: 100,
    fields: new Map([[0, 'SSID']]),
  });
  const rec = core.decodeRecordBytes(bytes);
  assert.equal(rec.ndefId, undefined);
});

test('a bare text string with no preceding typeID is not an NDEF-ID -- it is this Record\'s own unroutable first item, skipped as forward-compat padding', () => {
  // No typeID at all before the map: the whole Record is unroutable,
  // regardless of what the leading item looks like.
  const bytes = Buffer.concat([
    cbor.encodeCanonical('stray-string'),
    cbor.encodeCanonical(new Map([[0, 'payload']])),
  ]);
  const rec = core.decodeRecordBytes(bytes);
  assert.equal(rec.ignored, true);
  assert.equal(rec.typeId, null);
  assert.equal(rec.ndefId, undefined);
});

test('only one NDEF-ID string is recognized -- a second text string in a row falls through to being skipped as an unrecognized item', () => {
  const bytes = Buffer.concat([
    cbor.encodeCanonical(100),
    cbor.encodeCanonical('first-is-the-ndef-id'),
    cbor.encodeCanonical('second-is-just-unrecognized-padding'),
    cbor.encodeCanonical(new Map([[0, 'payload']])),
  ]);
  const rec = core.decodeRecordBytes(bytes);
  assert.equal(rec.ignored, false);
  assert.equal(rec.typeId, 100);
  assert.equal(rec.ndefId, 'first-is-the-ndef-id');
  assert.equal(rec.map.get(0), 'payload');
});

test('FINDING: byte cost of the NDEF-ID text string is exactly the cost of the string itself, no wrapper overhead', () => {
  const withNdefId = core.encodeRecordBytes({
    typeId: 100,
    fields: new Map(),
    ndefId: 'wifi-record-1',
  });
  const withoutNdefId = core.encodeRecordBytes({
    typeId: 100,
    fields: new Map(),
  });

  const ndefIdBytes = cbor.encodeCanonical('wifi-record-1').length;
  assert.equal(withNdefId.length, withoutNdefId.length + ndefIdBytes);
});
