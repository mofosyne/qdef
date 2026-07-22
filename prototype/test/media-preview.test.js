'use strict';
// §4.5's Media Preview (Type 14): a plain standard record type, not a
// wrapper -- content identification (media type, content hash, filename,
// label) as the Record's own map, with the identified content itself
// riding as a subrecord (typically §4.3 Media Payload). Resolves the
// TagDrop Media Preview/Payload correlation problem via subrecords
// instead of positional pairing (see docs/DESIGN.md, docs/FINDINGS.md).
//
// When Split (§4.1) is present, Split MUST stay outermost with Media
// Preview as ITS subrecord -- not the reverse -- so an old decoder that
// has never heard of Media Preview still reassembles the fragment group:
// it just ignores the unrecognized subrecord (§3.2), the same way it
// ignores any other subrecord it doesn't recognize.

const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('../src/core');
const wrappers = require('../src/wrappers');

test('Media Preview round-trips with a Media Payload subrecord', () => {
  const content = Buffer.from('Hello World');
  const hashPrefix = wrappers.contentHashPrefix(content);
  const bytes = core.encodeRecordBytes({
    typeId: wrappers.MEDIA_PREVIEW_TYPE,
    fields: new Map([
      [0, 'text/plain'],
      [1, hashPrefix],
      [3, 'hello.txt'],
    ]),
    subrecords: [
      {
        typeId: wrappers.MEDIA_PAYLOAD_TYPE,
        fields: new Map([[0, 'text/plain']]),
        payload: content,
      },
    ],
  });

  const rec = core.decodeRecordBytes(bytes);
  assert.equal(rec.ignored, false);
  assert.equal(rec.typeId, wrappers.MEDIA_PREVIEW_TYPE);
  assert.equal(rec.map.get(0), 'text/plain');
  assert.ok(rec.map.get(1).equals(hashPrefix));
  assert.equal(rec.map.get(3), 'hello.txt');

  assert.equal(rec.subrecords.length, 1);
  const payload = rec.subrecords[0];
  assert.equal(payload.typeId, wrappers.MEDIA_PAYLOAD_TYPE);
  assert.equal(payload.map.get(0), 'text/plain');
  assert.ok(payload.payload.equals(content));
});

test('key 1 is multihash-style: 1-byte function code + digest, length inferred from the CBOR byte string itself', () => {
  const content = Buffer.from('Hello World');
  const hashPrefix = wrappers.contentHashPrefix(content, { length: 8 });

  assert.equal(hashPrefix.length, 9); // 1 function-code byte + 8 digest bytes
  assert.equal(hashPrefix[0], wrappers.MULTIHASH_SHA2_256);

  const fullDigest = require('crypto').createHash('sha256').update(content).digest();
  assert.ok(hashPrefix.subarray(1).equals(fullDigest.subarray(0, 8)));

  // Trivially convertible to a canonical multiformats multihash: insert
  // the digest's own length (already known once this CBOR byte string is
  // decoded) as a second byte, right after the function code.
  const canonicalMultihash = Buffer.concat([hashPrefix.subarray(0, 1), Buffer.from([8]), hashPrefix.subarray(1)]);
  assert.equal(canonicalMultihash.length, 10);
});

test('Media Preview criticality: key 0 is critical, keys 1/3/5 are optional', () => {
  const abortBytes = core.encodeRecordBytes({
    typeId: wrappers.MEDIA_PREVIEW_TYPE,
    fields: new Map([
      [0, 'image/png'],
      [2, 'unknown critical field'], // even, unrecognized -> abort
    ]),
  });
  const aborted = core.applyCriticality(core.decodeRecordBytes(abortBytes), wrappers.MEDIA_PREVIEW_KNOWN_KEYS);
  assert.equal(aborted.aborted, true);

  const okBytes = core.encodeRecordBytes({
    typeId: wrappers.MEDIA_PREVIEW_TYPE,
    fields: new Map([
      [0, 'image/png'],
      [7, 'unknown optional field'], // odd, unrecognized -> ignored
    ]),
  });
  const ok = core.applyCriticality(core.decodeRecordBytes(okBytes), wrappers.MEDIA_PREVIEW_KNOWN_KEYS);
  assert.equal(ok.aborted, false);
  assert.deepEqual(ok.ignoredKeys, [7]);
});

test('multi-item: two independent Media Preview Records are consecutive top-level items, never wrapped in an enclosing array', () => {
  const recA = core.encodeRecordBytes({
    typeId: wrappers.MEDIA_PREVIEW_TYPE,
    fields: new Map([[0, 'text/plain'], [3, 'doc.txt']]),
    subrecords: [{ typeId: wrappers.MEDIA_PAYLOAD_TYPE, fields: new Map([[0, 'text/plain']]), payload: Buffer.from('content A') }],
  });
  const recB = core.encodeRecordBytes({
    typeId: wrappers.MEDIA_PREVIEW_TYPE,
    fields: new Map([[0, 'image/png'], [3, 'photo.png']]),
    subrecords: [{ typeId: wrappers.MEDIA_PAYLOAD_TYPE, fields: new Map([[0, 'image/png']]), payload: Buffer.from('content B') }],
  });

  const records = core.decodeSequence(Buffer.concat([recA, recB]));
  assert.equal(records.length, 2);
  assert.equal(records[0].map.get(3), 'doc.txt');
  assert.equal(records[0].subrecords[0].payload.toString(), 'content A');
  assert.equal(records[1].map.get(3), 'photo.png');
  assert.equal(records[1].subrecords[0].payload.toString(), 'content B');
});

test('Media Preview composes with Compress: Compress outermost, Preview as its subrecord', () => {
  const inner = compressableFixture();
  const compressRec = wrappers.compressEncode(inner);
  compressRec.subrecords = [
    { typeId: wrappers.MEDIA_PREVIEW_TYPE, fields: new Map([[0, 'text/plain'], [3, 'doc.txt']]) },
  ];
  const container = core.encodeContainer([compressRec]);
  const { records } = core.decodeContainer(container);

  const rec = core.applyCriticality(records[0], wrappers.COMPRESS_KNOWN_KEYS);
  assert.equal(rec.aborted, false);
  assert.deepEqual(wrappers.compressDecode(rec), inner);
  assert.equal(rec.subrecords[0].typeId, wrappers.MEDIA_PREVIEW_TYPE);
  assert.equal(rec.subrecords[0].map.get(3), 'doc.txt');
});

test('Media Preview composes with Encrypt: Encrypt outermost, Preview as its subrecord', () => {
  const key = Buffer.alloc(32, 7);
  const inner = compressableFixture();
  const encryptRec = wrappers.encryptEncode(inner, key);
  encryptRec.subrecords = [
    { typeId: wrappers.MEDIA_PREVIEW_TYPE, fields: new Map([[0, 'application/octet-stream']]) },
  ];
  const container = core.encodeContainer([encryptRec]);
  const { records } = core.decodeContainer(container);

  const rec = core.applyCriticality(records[0], wrappers.ENCRYPT_KNOWN_KEYS);
  assert.equal(rec.aborted, false);
  assert.deepEqual(wrappers.encryptDecode(rec, key), inner);
  assert.equal(rec.subrecords[0].typeId, wrappers.MEDIA_PREVIEW_TYPE);
  assert.equal(rec.subrecords[0].map.get(0), 'application/octet-stream');
});

test('Media Preview composes with Split: Split MUST stay outermost, Preview as its subrecord', () => {
  // Split's own payload is "the encoded bytes of another Record" (§4.1) --
  // here, the Media Payload this whole group's Media Preview identifies.
  const innerRecordBytes = core.encodeRecordBytes({
    typeId: wrappers.MEDIA_PAYLOAD_TYPE,
    fields: new Map([[0, 'image/png']]),
    payload: Buffer.from('a much larger reassembled image payload'),
  });
  const fragments = wrappers.splitEncode(innerRecordBytes, { count: 3 });
  for (const frag of fragments) {
    frag.subrecords = [
      { typeId: wrappers.MEDIA_PREVIEW_TYPE, fields: new Map([[0, 'image/png'], [3, 'map.png']]) },
    ];
  }
  const codes = fragments.map((frag) => core.encodeContainer([frag]));

  // A "new" decoder can read identification straight off code 0's
  // subrecord, before any reassembly happens.
  const { records: code0Records } = core.decodeContainer(codes[0]);
  const preview = code0Records[0].subrecords[0];
  assert.equal(preview.typeId, wrappers.MEDIA_PREVIEW_TYPE);
  assert.equal(preview.map.get(3), 'map.png');

  // resolveStack (standing in for an "old" Split-only decoder) never
  // inspects subrecords at all -- it reassembles correctly regardless,
  // even with a knownKeysRegistry that has no entry for Type 14.
  const knownKeysRegistry = new Map([
    [wrappers.SPLIT_TYPE, wrappers.SPLIT_KNOWN_KEYS],
    [wrappers.MEDIA_PAYLOAD_TYPE, wrappers.MEDIA_PAYLOAD_KNOWN_KEYS],
  ]);
  const terminal = wrappers.resolveStack(codes, {}, knownKeysRegistry);
  assert.equal(terminal.typeId, wrappers.MEDIA_PAYLOAD_TYPE);
  assert.ok(terminal.payload.equals(Buffer.from('a much larger reassembled image payload')));
});

function compressableFixture() {
  return Buffer.from('repeat repeat repeat repeat repeat repeat repeat content');
}
