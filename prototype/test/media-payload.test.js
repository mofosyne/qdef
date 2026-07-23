'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('../src/core');
const wrappers = require('../src/wrappers');

// ---------------------------------------------------------------------
// §4.3's Media Payload (Type 6): a plain standard record type, not a
// wrapper. Its content lives in the payload slot (§3.1), not the field
// Map -- only the Media Type field (key 0) is a map field.
// ---------------------------------------------------------------------

test('Media Type as a CoAP Content-Format uint round-trips', () => {
  const payload = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  const container = core.encodeContainer({ subrecords: [
    {
      typeId: wrappers.MEDIA_PAYLOAD_TYPE,
      fields: new Map([[0, wrappers.COAP_CONTENT_FORMAT_IMAGE_JPEG]]),
      payload,
    },
  ] });

  const root = core.decodeContainer(container);
  const records = root.subrecords;
  const rec = core.applyCriticality(records[0], wrappers.MEDIA_PAYLOAD_KNOWN_KEYS);

  assert.equal(rec.aborted, false);
  assert.equal(rec.map.get(0), 22);
  assert.deepEqual(rec.payload, payload);
});

test('Media Type as a plain MIME string round-trips', () => {
  const payload = Buffer.from('BEGIN:VCARD\nVERSION:3.0\nEND:VCARD');
  const container = core.encodeContainer({ subrecords: [
    {
      typeId: wrappers.MEDIA_PAYLOAD_TYPE,
      fields: new Map([[0, 'text/vcard']]),
      payload,
    },
  ] });

  const root = core.decodeContainer(container);
  const records = root.subrecords;
  const rec = core.applyCriticality(records[0], wrappers.MEDIA_PAYLOAD_KNOWN_KEYS);

  assert.equal(rec.aborted, false);
  assert.equal(rec.map.get(0), 'text/vcard');
  assert.deepEqual(rec.payload, payload);
});

test('an application with no interest in Media Payload skips the whole Record cleanly by Type ID alone', () => {
  const container = core.encodeContainer({ subrecords: [
    {
      typeId: wrappers.MEDIA_PAYLOAD_TYPE,
      fields: new Map([[0, wrappers.COAP_CONTENT_FORMAT_APPLICATION_CBOR]]),
      payload: Buffer.from('irrelevant to this decoder'),
    },
    { typeId: 100, fields: new Map([[0, 'SSID'], [2, 'pass'], [4, 2]]) },
  ] });

  const root = core.decodeContainer(container);
  const records = root.subrecords;
  const KNOWN_TYPES = new Map([[100, new Set([0, 1, 2, 4])]]);
  const handled = records
    .filter((r) => KNOWN_TYPES.has(r.typeId))
    .map((r) => core.applyCriticality(r, KNOWN_TYPES.get(r.typeId)));

  assert.equal(records.length, 2);
  assert.equal(handled.length, 1);
  assert.equal(handled[0].typeId, 100);
});
