'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('stream');
const cbor = require('cbor');

const core = require('../src/core');
const rt = require('../src/recordTypes');

// ---------------------------------------------------------------------
// Hardware Parity dual routing (§3.1): tag is optional, key 0 is mandatory.
// ---------------------------------------------------------------------
test('a Constrained-Route-only encoder (no CBOR tag) still routes correctly via key 0', () => {
  const container = core.encodeContainer(
    [{ typeId: rt.WIFI_TYPE, fields: new Map([[2, 'SSID'], [4, 'pass'], [6, 2]]) }],
    { tagged: false }
  );
  const { records } = core.decodeContainer(container);
  assert.equal(records.length, 1);
  assert.equal(records[0].tag, null);
  assert.equal(records[0].typeId, 100); // routed purely off map[0]
  const rec = core.applyCriticality(records[0], rt.WIFI_KNOWN_KEYS);
  assert.equal(rec.aborted, false);
});

test('a tag/key-0 disagreement (Hardware Parity mismatch) aborts the record', () => {
  // Hand-construct a malformed record: Tag says 105, key 0 says 100.
  const map = new Map([[0, 100], [2, 'SSID'], [4, 'pass'], [6, 2]]);
  const malformed = cbor.encode(new cbor.Tagged(105, map));
  const container = Buffer.concat([core.MAGIC, Buffer.from([core.VERSION]), malformed]);

  const { records } = core.decodeContainer(container);
  assert.equal(records[0].aborted, true);
  assert.match(records[0].abortReason, /hardware-parity mismatch/);
});

test('a record missing key 0 entirely aborts (cannot be routed by any parser)', () => {
  const map = new Map([[2, 'SSID']]); // no key 0
  const bytes = cbor.encode(new cbor.Tagged(100, map));
  const container = Buffer.concat([core.MAGIC, Buffer.from([core.VERSION]), bytes]);

  const { records } = core.decodeContainer(container);
  assert.equal(records[0].aborted, true);
  assert.match(records[0].abortReason, /missing key 0/);
});

// ---------------------------------------------------------------------
// NDEF path (§2): no magic/version prefix, just the bare CBOR Sequence,
// because NDEF's own MIME type (application/vnd.qdef) already identifies it.
// ---------------------------------------------------------------------
test('NDEF path: a bare CBOR Sequence (no magic/version) still routes via decodeSequence', () => {
  const bareSeq = Buffer.concat([
    cbor.encode(new cbor.Tagged(rt.WIFI_TYPE, new Map([[0, 100], [2, 'SSID'], [4, 'pass'], [6, 2]]))),
  ]);
  // Sanity: this must NOT be parseable as a magic-prefixed container.
  assert.throws(() => core.decodeContainer(bareSeq), /bad magic/);

  const records = core.decodeSequence(bareSeq);
  const rec = core.applyCriticality(records[0], rt.WIFI_KNOWN_KEYS);
  assert.equal(rec.aborted, false);
  assert.equal(rec.map.get(2), 'SSID');
});

// ---------------------------------------------------------------------
// Unknown Record Type at the container level: routed-or-skipped, no
// Record-Type-specific handling required (§3.3's "Core QDEF parser").
// ---------------------------------------------------------------------
test('a totally unrecognized Record Type is skippable without inspecting its keys', () => {
  const container = core.encodeContainer([
    { typeId: 12345, fields: new Map([[2, 'whatever'], [4, 'nested-app-data']]) },
    { typeId: rt.WIFI_TYPE, fields: new Map([[2, 'SSID'], [4, 'pass'], [6, 2]]) },
  ]);
  const { records } = core.decodeContainer(container);

  // A minimal core parser's dispatch table just doesn't have 12345 in it —
  // it never needs to run applyCriticality for a type it has no schema for.
  const KNOWN_TYPES = new Map([[rt.WIFI_TYPE, rt.WIFI_KNOWN_KEYS]]);
  const handled = records
    .filter((r) => !r.aborted && KNOWN_TYPES.has(r.typeId))
    .map((r) => core.applyCriticality(r, KNOWN_TYPES.get(r.typeId)));

  assert.equal(handled.length, 1);
  assert.equal(handled[0].typeId, 100);
});

// ---------------------------------------------------------------------
// §2's streaming claim: "a constrained parser can process each record as
// it streams in, without buffering the whole payload first."
// ---------------------------------------------------------------------
test('records decode incrementally off a byte stream, confirming the no-buffering claim', () => {
  const seq = Buffer.concat([
    cbor.encode(new cbor.Tagged(rt.WIFI_TYPE, new Map([[0, 100], [2, 'a']]))),
    cbor.encode(new cbor.Tagged(rt.TAGDROP_REGISTRATION_TYPE, new Map([[0, 900], [2, 'b']]))),
  ]);

  return new Promise((resolve, reject) => {
    const decoder = new cbor.Decoder({ tags: {} });
    const seenTags = [];
    decoder.on('data', (item) => seenTags.push(item.tag));
    decoder.on('error', reject);
    decoder.on('end', () => {
      assert.deepEqual(seenTags, [100, 900]);
      resolve();
    });
    // Feed the sequence in arbitrary small chunks, simulating bytes arriving
    // off an optical scan / NFC read before the whole payload is buffered.
    Readable.from([seq.subarray(0, 5), seq.subarray(5, 11), seq.subarray(11)]).pipe(decoder);
  });
});
