'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('../src/core');
const wrappers = require('../src/wrappers');

// ---------------------------------------------------------------------
// §4.3's Media Payload (Type 6): a plain stdlib Record, not a wrapper.
// Key 2 (Media Type) is a uint or a text string, encoder's choice — a
// CoAP Content-Format ID when one's registered, the plain MIME string
// otherwise. Unlike Type ID/Type Hint, there's deliberately no
// decentralized-ID-plus-hint layer here (DESIGN.md's "Media Payload"
// entry explains why); these tests only need to prove the two-form field
// round-trips and that an application with no interest in Media Payload
// can still skip the whole Record cleanly by Type ID alone.
// ---------------------------------------------------------------------

test('Media Type as a CoAP Content-Format uint round-trips', () => {
  const payload = Buffer.from([0xff, 0xd8, 0xff, 0xe0]); // JPEG-ish magic bytes, illustrative only
  const container = core.encodeContainer([
    {
      typeId: wrappers.MEDIA_PAYLOAD_TYPE,
      fields: new Map([
        [2, wrappers.COAP_CONTENT_FORMAT_IMAGE_JPEG],
        [4, payload],
      ]),
    },
  ]);

  const { records } = core.decodeContainer(container);
  const rec = core.applyCriticality(records[0], wrappers.MEDIA_PAYLOAD_KNOWN_KEYS);

  assert.equal(rec.aborted, false);
  assert.equal(rec.map.get(2), 22); // image/jpeg
  assert.deepEqual(rec.map.get(4), payload);
});

test('Media Type as a plain MIME string round-trips (the fallback for anything not in the CoAP registry)', () => {
  // text/vcard: confirmed absent from the CoAP Content-Formats registry
  // (spec §4.3, DESIGN.md) — the actual fixture for this path, not a
  // hypothetical one.
  const payload = Buffer.from('BEGIN:VCARD\nVERSION:3.0\nEND:VCARD');
  const container = core.encodeContainer([
    {
      typeId: wrappers.MEDIA_PAYLOAD_TYPE,
      fields: new Map([
        [2, 'text/vcard'],
        [4, payload],
      ]),
    },
  ]);

  const { records } = core.decodeContainer(container);
  const rec = core.applyCriticality(records[0], wrappers.MEDIA_PAYLOAD_KNOWN_KEYS);

  assert.equal(rec.aborted, false);
  assert.equal(rec.map.get(2), 'text/vcard');
  assert.deepEqual(rec.map.get(4), payload);
});

test('an application with no interest in Media Payload skips the whole Record cleanly by Type ID alone', () => {
  const container = core.encodeContainer([
    {
      typeId: wrappers.MEDIA_PAYLOAD_TYPE,
      fields: new Map([
        [2, wrappers.COAP_CONTENT_FORMAT_APPLICATION_CBOR],
        [4, Buffer.from('irrelevant to this decoder')],
      ]),
    },
    { typeId: 100, fields: new Map([[2, 'SSID'], [4, 'pass'], [6, 2]]) },
  ]);

  const { records } = core.decodeContainer(container);
  // A minimal core parser's dispatch table has no entry for Media Payload
  // at all — it never calls applyCriticality on it, same as any other
  // Record Type it doesn't recognize (§3.3).
  const KNOWN_TYPES = new Map([[100, new Set([0, 2, 3, 4, 6])]]);
  const handled = records
    .filter((r) => !r.aborted && KNOWN_TYPES.has(r.typeId))
    .map((r) => core.applyCriticality(r, KNOWN_TYPES.get(r.typeId)));

  assert.equal(records.length, 2);
  assert.equal(handled.length, 1);
  assert.equal(handled[0].typeId, 100);
});
