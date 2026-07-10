'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const cbor = require('cbor');

const core = require('../src/core');
const wrappers = require('../src/wrappers');
const rt = require('../src/recordTypes');

// ---------------------------------------------------------------------
// 1. Plain Record round trip: Type 100, Wi-Fi Provisioning (§5)
// ---------------------------------------------------------------------
test('Type 100 (Wi-Fi) record round-trips through a full container', () => {
  const container = core.encodeContainer([
    {
      typeId: rt.WIFI_TYPE,
      fields: new Map([
        [2, 'My Coffee Shop'],
        [4, 'guest123'],
        [6, 2],
        [3, true],
      ]),
    },
  ]);

  assert.equal(container.subarray(0, 4).toString('latin1'), 'QDEF');
  assert.equal(container[4], 0x01);

  const { records } = core.decodeContainer(container);
  assert.equal(records.length, 1);
  const rec = core.applyCriticality(records[0], rt.WIFI_KNOWN_KEYS);

  assert.equal(rec.aborted, false);
  assert.equal(rec.typeId, 100);
  assert.equal(rec.map.get(2), 'My Coffee Shop');
  assert.equal(rec.map.get(4), 'guest123');
  assert.equal(rec.map.get(6), 2);
  assert.equal(rec.map.get(3), true);
});

// ---------------------------------------------------------------------
// 2. Type 900: TagDrop registration wrapping a fake TagDrop CBOR Sequence
// ---------------------------------------------------------------------
test('Type 900 (TagDrop registration) round-trips an opaque nested CBOR Sequence', () => {
  // Simulate SPEC.md's version/type/part_meta/sector_bytes CBOR Sequence
  // as an opaque blob QDEF never looks inside.
  const fakeTagDropSeq = Buffer.concat([
    cbor.encode(1), // version
    cbor.encode('content'), // type
    cbor.encode(new Map([['sector_index', 0], ['sector_count', 1]])), // part_meta
    cbor.encode(Buffer.from('hello from tagdrop sector bytes')), // sector_bytes
  ]);

  const container = core.encodeContainer([
    {
      typeId: rt.TAGDROP_REGISTRATION_TYPE,
      fields: new Map([[2, fakeTagDropSeq]]),
    },
  ]);

  const { records } = core.decodeContainer(container);
  const rec = core.applyCriticality(records[0], rt.TAGDROP_REGISTRATION_KNOWN_KEYS);

  assert.equal(rec.aborted, false);
  assert.equal(rec.typeId, 900);
  const roundTrippedSeq = rec.map.get(2);
  assert.ok(Buffer.isBuffer(roundTrippedSeq));
  assert.ok(roundTrippedSeq.equals(fakeTagDropSeq), 'nested TagDrop bytes must survive byte-for-byte');

  // And a decoder that *does* understand TagDrop's own sequence format can
  // decode it further, entirely independent of QDEF's own decoding.
  const innerItems = cbor.decodeAllSync(roundTrippedSeq);
  assert.equal(innerItems[0], 1);
  assert.equal(innerItems[1], 'content');
});

// ---------------------------------------------------------------------
// 3. Worked example (§8): Split (parity, 3 fragments) -> Encrypt -> plain
//    Type-950 Record, reassembled from fragments, incl. drop+recover.
// ---------------------------------------------------------------------
function buildPgpBackupCodes(secretKeyBytes, aesKey) {
  const innerRecordBytes = core.encodeRecordBytes({
    typeId: rt.PGP_BACKUP_TYPE,
    fields: new Map([[2, secretKeyBytes]]),
  });

  const encryptFields = wrappers.encryptEncode(innerRecordBytes, aesKey);
  const encryptRecordBytes = core.encodeRecordBytes({
    typeId: wrappers.ENCRYPT_TYPE,
    fields: encryptFields,
  });

  const fragmentMaps = wrappers.splitEncode(encryptRecordBytes, {
    count: 3,
    parityScheme: wrappers.PARITY_SCHEME_XOR,
  });

  // One physical QR/NFC code per fragment.
  return fragmentMaps.map((fragMap) =>
    core.encodeContainer([{ typeId: wrappers.SPLIT_TYPE, fields: fragMap }])
  );
}

function decodePgpBackupFromCodes(codes, aesKey) {
  const fragmentMaps = codes.map((codeBytes) => {
    const { records } = core.decodeContainer(codeBytes);
    const rec = core.applyCriticality(records[0], wrappers.SPLIT_KNOWN_KEYS);
    assert.equal(rec.aborted, false, rec.abortReason);
    return rec.map;
  });

  const encryptRecordBytes = wrappers.splitDecode(fragmentMaps);
  const encryptRec = core.applyCriticality(
    core.decodeRecordBytes(encryptRecordBytes),
    wrappers.ENCRYPT_KNOWN_KEYS
  );
  assert.equal(encryptRec.aborted, false, encryptRec.abortReason);

  const innerRecordBytes = wrappers.encryptDecode(encryptRec.map, aesKey);
  const pgpRec = core.applyCriticality(
    core.decodeRecordBytes(innerRecordBytes),
    rt.PGP_BACKUP_KNOWN_KEYS
  );
  assert.equal(pgpRec.aborted, false, pgpRec.abortReason);
  return pgpRec.map.get(2);
}

test('PGP backup worked example: Split(parity)->Encrypt->plain Record, all fragments present', () => {
  // Deliberately not a multiple of 3, to exercise the uneven-last-fragment case.
  const secretKeyBytes = crypto.randomBytes(137);
  const aesKey = crypto.randomBytes(32);

  const codes = buildPgpBackupCodes(secretKeyBytes, aesKey);
  assert.equal(codes.length, 4); // 3 data fragments + 1 XOR parity fragment

  const recovered = decodePgpBackupFromCodes(codes, aesKey);
  assert.ok(recovered.equals(secretKeyBytes));
});

test('PGP backup worked example: recovers from one dropped fragment via XOR parity', () => {
  const secretKeyBytes = crypto.randomBytes(137);
  const aesKey = crypto.randomBytes(32);

  const codes = buildPgpBackupCodes(secretKeyBytes, aesKey);
  // Drop the *last* real fragment (index 2) — the short, uneven one, and the
  // trickiest to recover correctly since its true length isn't chunkLen.
  const droppedLastFragment = [codes[0], codes[1], codes[3]]; // keep frag0, frag1, parity
  const recoveredA = decodePgpBackupFromCodes(droppedLastFragment, aesKey);
  assert.ok(recoveredA.equals(secretKeyBytes), 'recovery of dropped last (short) fragment');

  // Drop a middle fragment (index 1) too, for good measure.
  const droppedMiddleFragment = [codes[0], codes[2], codes[3]];
  const recoveredB = decodePgpBackupFromCodes(droppedMiddleFragment, aesKey);
  assert.ok(recoveredB.equals(secretKeyBytes), 'recovery of dropped middle fragment');
});

test('PGP backup worked example: 2 dropped fragments is unrecoverable (single XOR parity)', () => {
  const secretKeyBytes = crypto.randomBytes(137);
  const aesKey = crypto.randomBytes(32);
  const codes = buildPgpBackupCodes(secretKeyBytes, aesKey);
  const tooFewFragments = [codes[0], codes[3]]; // only frag0 + parity
  assert.throws(() => decodePgpBackupFromCodes(tooFewFragments, aesKey), /missing/);
});

// ---------------------------------------------------------------------
// 4. Even/odd key criticality round trip (§3.2)
// ---------------------------------------------------------------------
test('unrecognized EVEN key aborts the record', () => {
  const container = core.encodeContainer([
    {
      typeId: rt.WIFI_TYPE,
      fields: new Map([
        [2, 'SSID'],
        [4, 'pass'],
        [6, 2],
        [8, 'a future critical field this parser predates'], // unknown EVEN key
      ]),
    },
  ]);

  const { records } = core.decodeContainer(container);
  const rec = core.applyCriticality(records[0], rt.WIFI_KNOWN_KEYS);

  assert.equal(rec.aborted, true);
  assert.match(rec.abortReason, /unrecognized critical \(even\) key 8/);
});

test('unrecognized ODD key is silently ignored, rest of record still processes', () => {
  const container = core.encodeContainer([
    {
      typeId: rt.WIFI_TYPE,
      fields: new Map([
        [2, 'SSID'],
        [4, 'pass'],
        [6, 2],
        [9, 'a future optional field this parser predates'], // unknown ODD key
      ]),
    },
  ]);

  const { records } = core.decodeContainer(container);
  const rec = core.applyCriticality(records[0], rt.WIFI_KNOWN_KEYS);

  assert.equal(rec.aborted, false);
  assert.deepEqual(rec.ignoredKeys, [9]);
  // The rest of the record's known fields are still fully usable.
  assert.equal(rec.map.get(2), 'SSID');
  assert.equal(rec.map.get(4), 'pass');
});

test('one aborted record does not affect sibling records in the same Sequence', () => {
  const container = core.encodeContainer([
    {
      typeId: rt.WIFI_TYPE,
      fields: new Map([[2, 'SSID'], [4, 'pass'], [6, 2], [8, 'unknown critical']]),
    },
    {
      typeId: rt.TAGDROP_REGISTRATION_TYPE,
      fields: new Map([[2, Buffer.from('unaffected sibling record')]]),
    },
  ]);

  const { records } = core.decodeContainer(container);
  assert.equal(records.length, 2);
  const wifiRec = core.applyCriticality(records[0], rt.WIFI_KNOWN_KEYS);
  const tagdropRec = core.applyCriticality(records[1], rt.TAGDROP_REGISTRATION_KNOWN_KEYS);

  assert.equal(wifiRec.aborted, true);
  assert.equal(tagdropRec.aborted, false);
  assert.ok(tagdropRec.map.get(2).equals(Buffer.from('unaffected sibling record')));
});
