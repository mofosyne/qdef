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
      typeIds: [rt.WIFI_TYPE],
      fields: new Map([
        [0, 'My Coffee Shop'],
        [2, 'guest123'],
        [4, 2],
        [1, true],
      ]),
    },
  ]);

  assert.equal(container.subarray(0, 4).toString('latin1'), 'QDEF');
  // No version byte: the CBOR Sequence starts immediately after magic.
  // First item is the typeID (uint 100 = major type 0, 0x18 0x64).
  assert.equal(container[4] >> 5, 0); // CBOR major type 0 = uint

  const { records } = core.decodeContainer(container);
  assert.equal(records.length, 1);
  const rec = core.applyCriticality(records[0], rt.WIFI_KNOWN_KEYS);

  assert.equal(rec.ignored, false);
  assert.equal(rec.typeId, 100);
  assert.equal(rec.map.get(0), 'My Coffee Shop');
  assert.equal(rec.map.get(2), 'guest123');
  assert.equal(rec.map.get(4), 2);
  assert.equal(rec.map.get(1), true);
});

// ---------------------------------------------------------------------
// 2. Type 900: TagDrop registration wrapping a fake TagDrop CBOR Sequence
// ---------------------------------------------------------------------
test('Type 900 (TagDrop registration) round-trips an opaque nested CBOR Sequence', () => {
  const fakeTagDropSeq = Buffer.concat([
    cbor.encode(1),
    cbor.encode('content'),
    cbor.encode(new Map([['sector_index', 0], ['sector_count', 1]])),
    cbor.encode(Buffer.from('hello from tagdrop sector bytes')),
  ]);

  const container = core.encodeContainer([
    {
      typeIds: [rt.TAGDROP_REGISTRATION_TYPE],
      fields: new Map([[0, fakeTagDropSeq]]),
    },
  ]);

  const { records } = core.decodeContainer(container);
  const rec = core.applyCriticality(records[0], rt.TAGDROP_REGISTRATION_KNOWN_KEYS);

  assert.equal(rec.ignored, false);
  assert.equal(rec.typeId, 900);
  const roundTrippedSeq = rec.map.get(0);
  assert.ok(Buffer.isBuffer(roundTrippedSeq));
  assert.ok(roundTrippedSeq.equals(fakeTagDropSeq), 'nested TagDrop bytes must survive byte-for-byte');

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
    typeIds: [rt.PGP_BACKUP_TYPE],
    fields: new Map([[0, secretKeyBytes]]),
  });

  const { typeIds: encTypeIds, fields: encFields } = wrappers.encryptEncode(innerRecordBytes, aesKey);
  const encryptRecordBytes = core.encodeRecordBytes({
    typeIds: encTypeIds,
    fields: encFields,
  });

  const fragmentRecords = wrappers.splitEncode(encryptRecordBytes, {
    count: 3,
    parityScheme: wrappers.PARITY_SCHEME_XOR,
  });

  // One physical QR/NFC code per fragment.
  return fragmentRecords.map((fragRec) =>
    core.encodeContainer([fragRec])
  );
}

function decodePgpBackupFromCodes(codes, aesKey) {
  const fragmentRecords = codes.map((codeBytes) => {
    const { records } = core.decodeContainer(codeBytes);
    const rec = core.applyCriticality(records[0], wrappers.SPLIT_KNOWN_KEYS);
    assert.equal(rec.ignored, false, rec.abortReason);
    return rec;
  });

  const encryptRecordBytes = wrappers.splitDecode(fragmentRecords);
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
  return pgpRec.map.get(0);
}

test('PGP backup worked example: Split(parity)->Encrypt->plain Record, all fragments present', () => {
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
  const droppedLastFragment = [codes[0], codes[1], codes[3]];
  const recoveredA = decodePgpBackupFromCodes(droppedLastFragment, aesKey);
  assert.ok(recoveredA.equals(secretKeyBytes), 'recovery of dropped last (short) fragment');

  const droppedMiddleFragment = [codes[0], codes[2], codes[3]];
  const recoveredB = decodePgpBackupFromCodes(droppedMiddleFragment, aesKey);
  assert.ok(recoveredB.equals(secretKeyBytes), 'recovery of dropped middle fragment');
});

test('PGP backup worked example: 2 dropped fragments is unrecoverable (single XOR parity)', () => {
  const secretKeyBytes = crypto.randomBytes(137);
  const aesKey = crypto.randomBytes(32);
  const codes = buildPgpBackupCodes(secretKeyBytes, aesKey);
  const tooFewFragments = [codes[0], codes[3]];
  assert.throws(() => decodePgpBackupFromCodes(tooFewFragments, aesKey), /missing/);
});

// ---------------------------------------------------------------------
// 4. Even/odd key criticality round trip (§3.2)
// ---------------------------------------------------------------------
test('unrecognized EVEN key aborts the record', () => {
  const container = core.encodeContainer([
    {
      typeIds: [rt.WIFI_TYPE],
      fields: new Map([
        [0, 'SSID'],
        [2, 'pass'],
        [4, 2],
        [6, 'a future critical field this parser predates'],
      ]),
    },
  ]);

  const { records } = core.decodeContainer(container);
  const rec = core.applyCriticality(records[0], rt.WIFI_KNOWN_KEYS);

  assert.equal(rec.aborted, true);
  assert.match(rec.abortReason, /unrecognized critical \(even\) key 6/);
});

test('unrecognized ODD key is silently ignored, rest of record still processes', () => {
  const container = core.encodeContainer([
    {
      typeIds: [rt.WIFI_TYPE],
      fields: new Map([
        [0, 'SSID'],
        [2, 'pass'],
        [4, 2],
        [7, 'a future optional field this parser predates'],
      ]),
    },
  ]);

  const { records } = core.decodeContainer(container);
  const rec = core.applyCriticality(records[0], rt.WIFI_KNOWN_KEYS);

  assert.equal(rec.aborted, false);
  assert.deepEqual(rec.ignoredKeys, [7]);
  assert.equal(rec.map.get(0), 'SSID');
  assert.equal(rec.map.get(2), 'pass');
});

test('one aborted record does not affect sibling records in the same Sequence', () => {
  const container = core.encodeContainer([
    {
      typeIds: [rt.WIFI_TYPE],
      fields: new Map([[0, 'SSID'], [2, 'pass'], [4, 2], [6, 'unknown critical']]),
    },
    {
      typeIds: [rt.TAGDROP_REGISTRATION_TYPE],
      fields: new Map([[0, Buffer.from('unaffected sibling record')]]),
    },
  ]);

  const { records } = core.decodeContainer(container);
  assert.equal(records.length, 2);
  const wifiRec = core.applyCriticality(records[0], rt.WIFI_KNOWN_KEYS);
  const tagdropRec = core.applyCriticality(records[1], rt.TAGDROP_REGISTRATION_KNOWN_KEYS);

  assert.equal(wifiRec.aborted, true);
  assert.equal(tagdropRec.aborted, false);
  assert.ok(tagdropRec.map.get(0).equals(Buffer.from('unaffected sibling record')));
});
