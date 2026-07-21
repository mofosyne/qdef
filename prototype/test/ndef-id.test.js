'use strict';
// The NDEF-ID-equivalent (§3.1) has been removed from the grammar.
// A bare text string after typeId is now consumed as the payload slot
// (plaintext payload, §3.1). These tests document residual behaviors.

const test = require('node:test');
const assert = require('node:assert/strict');
const cbor = require('cbor');

const core = require('../src/core');

test('a Record with no ID field has the field undefined', () => {
  const bytes = core.encodeRecordBytes({
    typeId: 100,
    fields: new Map([[0, 'SSID']]),
  });
  const rec = core.decodeRecordBytes(bytes);
  assert.equal(rec.ndefId, undefined);
});

test('a bare text string with no preceding typeID is not a payload -- it is this Record\'s own unroutable first item, skipped as forward-compat padding', () => {
  const bytes = cbor.encodeCanonical(['stray-string', new Map([[0, 'payload']])]);
  const rec = core.decodeRecordBytes(bytes);
  assert.equal(rec.ignored, true);
  assert.equal(rec.typeId, null);
  assert.equal(rec.payload, undefined);
});
