'use strict';
// §4.7's Signature (Type 16): a sibling Record covering every Record
// immediately preceding it within the same array -- top-level Sequence
// or a shared parent's subrecord list -- since the start of that array
// or the previous Signature Record within it. Purely positional: no
// hash list, no coverage-identification bytes (docs/DESIGN.md's fourth
// Sign coverage strategy). Ed25519 only, via Node's built-in crypto.

const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('../src/core');
const sig = require('../src/signature');
const rt = require('../src/recordTypes');

test('a Signature Record verifies the exact preceding top-level Records it was built over -- NDEF Signature RTD parity, zero coverage-identification bytes', () => {
  const { privateKey } = sig.generateSigningKeyPair();
  const covered = [
    { typeId: rt.WIFI_TYPE, fields: new Map([[0, 'SSID'], [2, 'pass'], [4, 2]]) },
    { typeId: 10, fields: new Map([[0, 'https://example.com/open']]) },
  ];
  const signatureRecord = sig.signatureEncode(covered, privateKey);

  const container = core.encodeContainer({ typeId: 0, subrecords: [...covered, signatureRecord] });
  const root = core.decodeContainer(container);
  const records = root.subrecords;

  const results = sig.verifySignaturesInList(records);
  assert.equal(results.length, 1);
  assert.equal(results[0].valid, true);
  assert.equal(results[0].coveredCount, 2);
});

test('reordering a covered Record after signing breaks verification -- positional coverage is exactly this fragile, by design', () => {
  const { privateKey } = sig.generateSigningKeyPair();
  const a = { typeId: rt.WIFI_TYPE, fields: new Map([[0, 'SSID'], [2, 'pass'], [4, 2]]) };
  const b = { typeId: 10, fields: new Map([[0, 'https://example.com/open']]) };
  const signatureRecord = sig.signatureEncode([a, b], privateKey);

  const container = core.encodeContainer({ typeId: 0, subrecords: [b, a, signatureRecord] }); // swapped
  const root = core.decodeContainer(container);
  const records = root.subrecords;

  const results = sig.verifySignaturesInList(records);
  assert.equal(results[0].valid, false);
});

test('inserting an unrelated Record between signing and verification breaks it too -- the exact tradeoff against the hash-list form', () => {
  const { privateKey } = sig.generateSigningKeyPair();
  const a = { typeId: rt.WIFI_TYPE, fields: new Map([[0, 'SSID'], [2, 'pass'], [4, 2]]) };
  const b = { typeId: 10, fields: new Map([[0, 'https://example.com/open']]) };
  const signatureRecord = sig.signatureEncode([a, b], privateKey);
  const unrelated = { typeId: 10, fields: new Map([[0, 'https://example.com/unrelated']]) };

  const container = core.encodeContainer({ typeId: 0, subrecords: [a, unrelated, b, signatureRecord] });
  const root = core.decodeContainer(container);
  const records = root.subrecords;

  const results = sig.verifySignaturesInList(records);
  assert.equal(results[0].valid, false);
  assert.equal(results[0].coveredCount, 3); // a, unrelated, b -- not the 2 originally signed
});

test('tampering with a covered Record\'s own field after signing breaks verification', () => {
  const { privateKey } = sig.generateSigningKeyPair();
  const a = { typeId: rt.WIFI_TYPE, fields: new Map([[0, 'SSID'], [2, 'pass'], [4, 2]]) };
  const signatureRecord = sig.signatureEncode([a], privateKey);

  const tampered = { typeId: rt.WIFI_TYPE, fields: new Map([[0, 'SSID-tampered'], [2, 'pass'], [4, 2]]) };
  const container = core.encodeContainer({ typeId: 0, subrecords: [tampered, signatureRecord] });
  const root = core.decodeContainer(container);
  const records = root.subrecords;

  const results = sig.verifySignaturesInList(records);
  assert.equal(results[0].valid, false);
});

test('a decoder with no interest in Signature skips the whole Record cleanly by Type ID alone, same as any other unrecognized Type', () => {
  const { privateKey } = sig.generateSigningKeyPair();
  const a = { typeId: 10, fields: new Map([[0, 'https://example.com/open']]) };
  const signatureRecord = sig.signatureEncode([a], privateKey);

  const container = core.encodeContainer({ typeId: 0, subrecords: [a, signatureRecord] });
  const root = core.decodeContainer(container);
  const records = root.subrecords;

  const KNOWN_TYPES = new Map([[10, new Set([0, 1, 3, 5])]]); // no entry for Type 16
  const handled = records
    .filter((r) => KNOWN_TYPES.has(r.typeId))
    .map((r) => core.applyCriticality(r, KNOWN_TYPES.get(r.typeId)));

  assert.equal(records.length, 2);
  assert.equal(handled.length, 1);
  assert.equal(handled[0].typeId, 10);
});

test('a Signature nested as a subrecord covers only its own parent\'s preceding subrecords -- the Bundle-scoped case, not the whole container', () => {
  const { privateKey } = sig.generateSigningKeyPair();
  const inBundle = { typeId: rt.WIFI_TYPE, fields: new Map([[0, 'SSID'], [2, 'pass'], [4, 2]]) };
  const alsoInBundle = { typeId: 10, fields: new Map([[0, 'https://example.com/open']]) };
  const bundleSignature = sig.signatureEncode([inBundle, alsoInBundle], privateKey);

  const outsideBundle = { typeId: 10, fields: new Map([[0, 'https://example.com/outside']]) };
  const container = core.encodeContainer({ typeId: 0, subrecords: [
    {
      typeId: rt.BUNDLE_TYPE,
      subrecords: [inBundle, alsoInBundle, bundleSignature],
    },
    outsideBundle,
  ] });
  const root = core.decodeContainer(container);
  const records = root.subrecords;

  const allResults = sig.verifyAllSignatures(records);
  assert.equal(allResults.length, 1); // only the Bundle's own subrecord list has a Signature
  assert.equal(allResults[0].valid, true);
  assert.equal(allResults[0].coveredCount, 2); // just the two WiFi/Open-URI subrecords, not the Bundle or outsideBundle
});

test('two Signature Records in the same list checkpoint independently -- the second covers only what\'s between them, not everything since the start', () => {
  const { privateKey } = sig.generateSigningKeyPair();
  const a = { typeId: rt.WIFI_TYPE, fields: new Map([[0, 'SSID'], [2, 'pass'], [4, 2]]) };
  const sigA = sig.signatureEncode([a], privateKey);
  const b = { typeId: 10, fields: new Map([[0, 'https://example.com/open']]) };
  const sigB = sig.signatureEncode([b], privateKey);

  const container = core.encodeContainer({ typeId: 0, subrecords: [a, sigA, b, sigB] });
  const root = core.decodeContainer(container);
  const records = root.subrecords;

  const results = sig.verifySignaturesInList(records);
  assert.equal(results.length, 2);
  assert.equal(results[0].valid, true);
  assert.equal(results[0].coveredCount, 1);
  assert.equal(results[1].valid, true);
  assert.equal(results[1].coveredCount, 1); // just b, not [a, sigA, b] -- checkpoint reset by sigA
});

test('an unsupported Algorithm value is reported, not silently treated as valid', () => {
  const { privateKey } = sig.generateSigningKeyPair();
  const a = { typeId: rt.WIFI_TYPE, fields: new Map([[0, 'SSID']]) };
  const publicKey = require('crypto').createPublicKey(privateKey);
  const forgedAlgSignature = {
    typeId: sig.SIGNATURE_TYPE,
    fields: new Map([
      [0, -7], // ES256, not implemented by this prototype
      [2, sig.publicKeyRawBytes(publicKey)],
    ]),
    payload: Buffer.alloc(64),
  };

  const container = core.encodeContainer({ typeId: 0, subrecords: [a, forgedAlgSignature] });
  const root = core.decodeContainer(container);
  const records = root.subrecords;

  const results = sig.verifySignaturesInList(records);
  assert.equal(results[0].valid, false);
  assert.match(results[0].reason, /unsupported algorithm/);
});

test('an unrecognized EVEN key in a Signature Record\'s own map aborts it via the ordinary criticality rule (§3.2), same as any other Type', () => {
  const { privateKey } = sig.generateSigningKeyPair();
  const a = { typeId: rt.WIFI_TYPE, fields: new Map([[0, 'SSID']]) };
  const publicKey = require('crypto').createPublicKey(privateKey);
  const signatureWithUnknownCriticalField = {
    typeId: sig.SIGNATURE_TYPE,
    fields: new Map([
      [0, sig.COSE_ALG_EDDSA],
      [2, sig.publicKeyRawBytes(publicKey)],
      [4, 'a hypothetical future critical field this decoder does not understand'],
    ]),
    payload: Buffer.alloc(64),
  };

  const container = core.encodeContainer({ typeId: 0, subrecords: [a, signatureWithUnknownCriticalField] });
  const root = core.decodeContainer(container);
  const records = root.subrecords;

  const results = sig.verifySignaturesInList(records);
  assert.equal(results[0].valid, false);
  assert.match(results[0].reason, /unrecognized critical \(even\) key 4/);
});
