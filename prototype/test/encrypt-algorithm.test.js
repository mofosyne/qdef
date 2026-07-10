'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const core = require('../src/core');
const wrappers = require('../src/wrappers');

// ---------------------------------------------------------------------
// §4.1's Encrypt Wrapper Algorithm (key 5) / Key Algorithm (key 7): both
// optional, both borrowed from IANA's COSE Algorithms registry rather than
// invented. These tests prove the two claims the spec text makes about
// them: absent, everything works exactly as before (§8's already-agree-
// out-of-band case), and present-but-unrecognized is safely ignorable by
// an older decoder, not an abort — the same odd/optional contract
// `parity_scheme` already has.
// ---------------------------------------------------------------------

const OLD_ENCRYPT_KNOWN_KEYS = new Set([0, 2, 4]); // pre-dates keys 5/7

test('Encrypt with no Algorithm/Key Algorithm fields round-trips exactly as before (regression)', () => {
  const key = crypto.randomBytes(32);
  const innerBytes = Buffer.from('some secret payload bytes');

  const map = wrappers.encryptEncode(innerBytes, key);
  assert.equal(map.has(5), false);
  assert.equal(map.has(7), false);

  const decrypted = wrappers.encryptDecode(map, key);
  assert.deepEqual(decrypted, innerBytes);
});

test('Encrypt with Algorithm (uint, COSE) and Key Algorithm (uint, COSE) round-trips and decrypts', () => {
  const key = crypto.randomBytes(32);
  const innerBytes = Buffer.from('some secret payload bytes');

  const map = wrappers.encryptEncode(innerBytes, key, {
    algorithm: wrappers.COSE_ALG_A256GCM,
    keyAlgorithm: wrappers.COSE_ALG_ECDH_ES_HKDF_256,
  });

  assert.equal(map.get(5), 3); // A256GCM
  assert.equal(map.get(7), -25); // ECDH-ES+HKDF-256

  const decrypted = wrappers.encryptDecode(map, key);
  assert.deepEqual(decrypted, innerBytes);
});

test('Algorithm/Key Algorithm accept a text-string fallback for anything not in the COSE registry', () => {
  const key = crypto.randomBytes(32);
  const innerBytes = Buffer.from('some secret payload bytes');

  const map = wrappers.encryptEncode(innerBytes, key, {
    algorithm: 'A256GCM',
    keyAlgorithm: 'com.example/proprietary-key-wrap-v1',
  });

  assert.equal(map.get(5), 'A256GCM');
  assert.equal(map.get(7), 'com.example/proprietary-key-wrap-v1');
  assert.deepEqual(wrappers.encryptDecode(map, key), innerBytes);
});

test('a decoder that pre-dates keys 5/7 silently ignores them instead of aborting the record', () => {
  const key = crypto.randomBytes(32);
  const innerBytes = Buffer.from('some secret payload bytes');

  const map = wrappers.encryptEncode(innerBytes, key, {
    algorithm: wrappers.COSE_ALG_A256GCM,
    keyAlgorithm: wrappers.COSE_ALG_DIRECT_HKDF_SHA_256,
  });
  const encoded = core.encodeRecordBytes({ typeId: wrappers.ENCRYPT_TYPE, fields: map });

  const rec = core.decodeRecordBytes(encoded);
  // Simulates an implementation built before keys 5/7 existed in the spec.
  const checked = core.applyCriticality(rec, OLD_ENCRYPT_KNOWN_KEYS);

  assert.equal(checked.aborted, false);
  assert.deepEqual(checked.ignoredKeys.sort(), [5, 7]);
  // The old decoder can still decrypt using its own out-of-band assumption
  // — it never needed keys 5/7 to do so, they're purely additive.
  assert.deepEqual(wrappers.encryptDecode(checked.map, key), innerBytes);
});
