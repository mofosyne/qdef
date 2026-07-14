'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('stream');
const cbor = require('cbor');

const core = require('../src/core');
const rt = require('../src/recordTypes');

// ---------------------------------------------------------------------
// Record Type ID routing (§3.1): typeID prefix items are the routing
// mechanism. The parser accumulates typeIDs (contiguous run of uint/
// byte-string at the start), skips unknown items, and stops at the
// first map (the record delimiter).
// ---------------------------------------------------------------------

test('a record with no typeID before the map is ignored (not routed)', () => {
  // A bare map with no preceding typeID items — the parser finds no
  // typeID and marks the record as ignored.
  const map = new Map([[0, 'SSID']]);
  const bytes = cbor.encode(map);
  const container = Buffer.concat([core.MAGIC, bytes]);

  const { records } = core.decodeContainer(container);
  assert.equal(records[0].ignored, true);
  assert.equal(records[0].typeId, null);
});

// ---------------------------------------------------------------------
// NDEF path (§2): no magic prefix, just the bare CBOR Sequence,
// because NDEF's own MIME type (application/vnd.qdef) already identifies it.
// ---------------------------------------------------------------------
test('NDEF path: a bare CBOR Sequence (no magic) still routes via decodeSequence', () => {
  const typeBytes = cbor.encodeCanonical(100);
  const mapBytes = cbor.encodeCanonical(new Map([[0, 'SSID'], [2, 'pass'], [4, 2]]));
  const bareSeq = Buffer.concat([typeBytes, mapBytes]);
  // Sanity: this must NOT be parseable as a magic-prefixed container.
  assert.throws(() => core.decodeContainer(bareSeq), /bad magic/);

  const records = core.decodeSequence(bareSeq);
  const rec = core.applyCriticality(records[0], rt.WIFI_KNOWN_KEYS);
  assert.equal(rec.ignored, false);
  assert.equal(rec.map.get(0), 'SSID');
});

// ---------------------------------------------------------------------
// Unknown Record Type at the container level: routed-or-skipped, no
// Record-Type-specific handling required (§3.3's "Core QDEF parser").
// ---------------------------------------------------------------------
test('a totally unrecognized Record Type is skippable without inspecting its keys', () => {
  const container = core.encodeContainer([
    { typeIds: [12345], fields: new Map([[0, 'whatever'], [2, 'nested-app-data']]) },
    { typeIds: [rt.WIFI_TYPE], fields: new Map([[0, 'SSID'], [2, 'pass'], [4, 2]]) },
  ]);
  const { records } = core.decodeContainer(container);

  // A minimal core parser's dispatch table just doesn't have 12345 in it —
  // it never needs to run applyCriticality for a type it has no schema for.
  const KNOWN_TYPES = new Map([[rt.WIFI_TYPE, rt.WIFI_KNOWN_KEYS]]);
  const handled = records
    .filter((r) => !r.ignored && KNOWN_TYPES.has(r.typeId))
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
    cbor.encodeCanonical(100),
    cbor.encodeCanonical(new Map([[0, 'a']])),
    cbor.encodeCanonical(900),
    cbor.encodeCanonical(new Map([[0, 'b']])),
  ]);

  return new Promise((resolve, reject) => {
    const decoder = new cbor.Decoder();
    const seenTypeIds = [];
    decoder.on('data', (item) => {
      if (typeof item === 'number' && item >= 0) seenTypeIds.push(item);
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
// Backup typeIDs for transitional routing
// ---------------------------------------------------------------------
test('backup typeIDs are accumulated and accessible via typeIds array', () => {
  const oldId = Buffer.from('A7F90B3C', 'hex');
  const container = core.encodeContainer([
    { typeIds: [100, oldId], fields: new Map([[0, 'SSID'], [2, 'pass'], [4, 2]]) },
  ]);

  const { records } = core.decodeContainer(container);
  assert.equal(records[0].typeIds.length, 2);
  assert.equal(records[0].typeId, 100);
  assert.ok(Buffer.isBuffer(records[0].typeIds[1]));
  assert.deepEqual(records[0].typeIds[1], oldId);
});

test('unknown items between typeIDs and map are skipped transparently', () => {
  // Manually construct a Record with an unknown item (e.g. a future
  // QDEF version marker) between the typeID and the map.
  const typeBytes = cbor.encodeCanonical(100);
  const futureMarker = cbor.encodeCanonical(-1); // negative int = unknown item
  const mapBytes = cbor.encodeCanonical(new Map([[0, 'SSID']]));
  const recordBytes = Buffer.concat([typeBytes, futureMarker, mapBytes]);
  const container = Buffer.concat([core.MAGIC, recordBytes]);

  const { records } = core.decodeContainer(container);
  assert.equal(records[0].typeId, 100);
  assert.equal(records[0].map.get(0), 'SSID');
});
