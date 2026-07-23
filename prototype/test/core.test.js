'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('stream');
const cbor = require('cbor');

const core = require('../src/core');
const rt = require('../src/recordTypes');

// ---------------------------------------------------------------------
// Record Type ID routing (§3.1): typeId is optional and defaults to 0
// (Bundle) when no uint is found at that position -- a forgiving-
// parser choice (see docs/DESIGN.md): there is no "ignored, unroutable"
// state anymore, since every Record always resolves to *some* typeId.
// ---------------------------------------------------------------------

test('a record with no typeID before the map defaults to typeId 0 (Bundle), not "ignored"', () => {
  const recordBytes = new Map([[0, 'SSID']]);
  const container = Buffer.concat([core.MAGIC, cbor.encodeCanonical(recordBytes)]);

  const root = core.decodeContainer(container);
  assert.equal(root.typeId, 0);
  assert.equal(root.map.get(0), 'SSID');
});

test('a leading byte string is unconditionally read as namespace, never as payload -- even when there\'s nothing after it to pair with', () => {
  // Dropped requirement (see docs/DESIGN.md): namespace no longer needs
  // a valid typeId immediately following it. A namespace-shaped payload
  // with no real namespace intended needs an explicit typeId ahead of
  // it to escape this reading.
  const bytes = cbor.encodeCanonical([Buffer.from('not-a-namespace')]);
  const rec = core.decodeRecordBytes(bytes);
  assert.ok(rec.localNamespace.equals(Buffer.from('not-a-namespace')));
  assert.equal(rec.typeId, 0);
  assert.equal(rec.payload, undefined);
});

test('an explicit typeId ahead of a bstr payload keeps it from being read as namespace', () => {
  const bytes = cbor.encodeCanonical([0, Buffer.from('a real payload')]);
  const rec = core.decodeRecordBytes(bytes);
  assert.equal(rec.localNamespace, undefined);
  assert.equal(rec.typeId, 0);
  assert.ok(rec.payload.equals(Buffer.from('a real payload')));
});

// ---------------------------------------------------------------------
// NDEF path (§2): no magic prefix, just the bare CBOR Sequence, parsed
// exactly like the magic path past the magic check -- one Record,
// end-of-buffer-bounded.
// ---------------------------------------------------------------------
test('NDEF path: a bare CBOR Sequence (no magic) still routes via decodeSequence, structurally identical to the magic path', () => {
  // A single record written flat -- typeId and map as separate
  // top-level Sequence items, not array-wrapped -- becomes the root
  // Record directly, no Bundle indirection (see docs/DESIGN.md).
  const bareSeq = Buffer.concat([
    cbor.encodeCanonical(100),
    cbor.encodeCanonical(new Map([[0, 'SSID'], [2, 'pass'], [4, 2]])),
  ]);
  // Sanity: this must NOT be parseable as a magic-prefixed container.
  assert.throws(() => core.decodeContainer(bareSeq), /bad magic/);

  const root = core.decodeSequence(bareSeq);
  const rec = core.applyCriticality(root, rt.WIFI_KNOWN_KEYS);
  assert.equal(rec.typeId, 100);
  assert.equal(rec.map.get(0), 'SSID');
});

// ---------------------------------------------------------------------
// Unknown Record Type at the container level: routed-or-skipped, no
// Record-Type-specific handling required (§3.3's "Core QDEF parser").
// ---------------------------------------------------------------------
test('a totally unrecognized Record Type is skippable without inspecting its keys', () => {
  const container = core.encodeContainer({
    subrecords: [
      { typeId: 12345, fields: new Map([[0, 'whatever'], [2, 'nested-app-data']]) },
      { typeId: rt.WIFI_TYPE, fields: new Map([[0, 'SSID'], [2, 'pass'], [4, 2]]) },
    ],
  });
  const root = core.decodeContainer(container);
  const records = root.subrecords;

  // A minimal core parser's dispatch table just doesn't have 12345 in it —
  // it never needs to run applyCriticality for a type it has no schema for.
  const KNOWN_TYPES = new Map([[rt.WIFI_TYPE, rt.WIFI_KNOWN_KEYS]]);
  const handled = records
    .filter((r) => KNOWN_TYPES.has(r.typeId))
    .map((r) => core.applyCriticality(r, KNOWN_TYPES.get(r.typeId)));

  assert.equal(handled.length, 1);
  assert.equal(handled[0].typeId, 100);
});

// ---------------------------------------------------------------------
// §2's streaming claim: "a constrained parser can process each record as
// it streams in, without buffering the whole payload first."
// ---------------------------------------------------------------------
test('records decode incrementally off a byte stream, confirming the no-buffering claim', () => {
  // Each subrecord is still its own self-delimited CBOR array -- a
  // generic CBOR streaming decoder already emits one complete, parsed
  // item per array it finds, with no QDEF-specific grammar needed.
  const seq = Buffer.concat([
    cbor.encodeCanonical([100, new Map([[0, 'a']])]),
    cbor.encodeCanonical([900, new Map([[0, 'b']])]),
  ]);

  return new Promise((resolve, reject) => {
    const decoder = new cbor.Decoder();
    const seenTypeIds = [];
    decoder.on('data', (item) => {
      if (Array.isArray(item) && typeof item[0] === 'number') seenTypeIds.push(item[0]);
    });
    decoder.on('error', reject);
    decoder.on('end', () => {
      assert.deepEqual(seenTypeIds, [100, 900]);
      resolve();
    });
    // Feed the sequence in arbitrary small chunks, simulating bytes arriving
    // off an optical scan / NFC read before the whole payload is buffered.
    Readable.from([seq.subarray(0, 5), seq.subarray(5, 11), seq.subarray(11)]).pipe(decoder);
  });
});

// ---------------------------------------------------------------------
// There is no backup-typeID mechanism anymore -- at most one typeID-
// bearing item per Record (see docs/FINDINGS.md). A second typeID-shaped
// item is just an ordinary unrecognized prefix item now.
// ---------------------------------------------------------------------
test('a second, would-be-backup typeID is not accumulated -- it is read as this Record\'s own payload instead', () => {
  // There is no forward-compat padding left between typeId and the map:
  // payload now accepts any well-formed CBOR shape (§3.1/§3.2), so a
  // bare uint immediately after typeId -- with no map before it -- is
  // unconditionally this Record's payload, not a skipped stray item.
  // 900 would have been a backup typeID, once -- written flat (not
  // array-wrapped) so it becomes the root Record directly.
  const recordBytes = Buffer.concat([cbor.encodeCanonical(100), cbor.encodeCanonical(900)]);
  const container = Buffer.concat([core.MAGIC, recordBytes]);

  const root = core.decodeContainer(container);
  assert.equal(root.typeId, 100);
  assert.equal(root.map, null);
  assert.equal(root.payload, 900);
});

test('a map-shaped item right after typeId is always the field Map, never padding or payload', () => {
  const recordBytes = Buffer.concat([cbor.encodeCanonical(100), cbor.encodeCanonical(new Map([[0, 'SSID']]))]);
  const container = Buffer.concat([core.MAGIC, recordBytes]);

  const root = core.decodeContainer(container);
  assert.equal(root.typeId, 100);
  assert.equal(root.map.get(0), 'SSID');
});

test('an indefinite-length payload candidate is recognized as payload -- decoder-tolerance-only, documented divergence from rust/qdef-core (§3.1)', () => {
  // A conformant encoder never emits this (§3.4 requires definite-length),
  // but a decoder MAY still recognize it. The Node prototype does, because
  // its underlying `cbor` library normalizes indefinite-length byte/text
  // strings into a single definite value before application code ever
  // sees them -- there is no way, post-decode, to tell it apart from a
  // conformant definite-length payload. rust/qdef-core deliberately does
  // NOT recognize this shape (an explicit is_indefinite() guard); both
  // are conformant per §3.1's decoder-tolerance wording.
  //
  // array(2) [ typeID uint(20), indefinite-length byte string "hello" ]
  const bytes = Buffer.from([0x82, 0x14, 0x5f, 0x45, 0x68, 0x65, 0x6c, 0x6c, 0x6f, 0xff]);
  const rec = core.decodeRecordBytes(bytes);

  assert.equal(rec.typeId, 20);
  assert.ok(Buffer.isBuffer(rec.payload));
  assert.equal(rec.payload.toString(), 'hello');
});
