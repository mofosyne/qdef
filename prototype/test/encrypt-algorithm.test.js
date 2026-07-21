'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const core = require('../src/core');
const wrappers = require('../src/wrappers');

// ---------------------------------------------------------------------
// §4.1's Encrypt Wrapper Algorithm (key 5) / Key Algorithm (key 7): both
// optional, both borrowed from IANA's COSE Algorithms registry rather than
// invented.
// ---------------------------------------------------------------------

const OLD_ENCRYPT_KNOWN_KEYS = new Set([0, 2]); // pre-dates keys 3/5

test('Encrypt with no Algorithm/Key Algorithm fields round-trips exactly as before (regression)', () => {
  const key = crypto.randomBytes(32);
  const innerBytes = Buffer.from('some secret payload bytes');

  const enc = wrappers.encryptEncode(innerBytes, key);
  assert.equal(enc.fields.has(3), false);
  assert.equal(enc.fields.has(5), false);

  const decrypted = wrappers.encryptDecode(enc, key);
  assert.deepEqual(decrypted, innerBytes);
});

test('Encrypt with Algorithm (uint, COSE) and Key Algorithm (uint, COSE) round-trips and decrypts', () => {
  const key = crypto.randomBytes(32);
  const innerBytes = Buffer.from('some secret payload bytes');

  const enc = wrappers.encryptEncode(innerBytes, key, {
    algorithm: wrappers.COSE_ALG_A256GCM,
    keyAlgorithm: wrappers.COSE_ALG_ECDH_ES_HKDF_256,
  });

  assert.equal(enc.fields.get(3), 3); // A256GCM
  assert.equal(enc.fields.get(5), -25); // ECDH-ES+HKDF-256

  const decrypted = wrappers.encryptDecode(enc, key);
  assert.deepEqual(decrypted, innerBytes);
});

test('Algorithm/Key Algorithm accept a text-string fallback for anything not in the COSE registry', () => {
  const key = crypto.randomBytes(32);
  const innerBytes = Buffer.from('some secret payload bytes');

  const enc = wrappers.encryptEncode(innerBytes, key, {
    algorithm: 'A256GCM',
    keyAlgorithm: 'com.example/proprietary-key-wrap-v1',
  });

  assert.equal(enc.fields.get(3), 'A256GCM');
  assert.equal(enc.fields.get(5), 'com.example/proprietary-key-wrap-v1');
  assert.deepEqual(wrappers.encryptDecode(enc, key), innerBytes);
});

test('a decoder that pre-dates keys 3/5 silently ignores them instead of aborting the record', () => {
  const key = crypto.randomBytes(32);
  const innerBytes = Buffer.from('some secret payload bytes');

  const enc = wrappers.encryptEncode(innerBytes, key, {
    algorithm: wrappers.COSE_ALG_A256GCM,
    keyAlgorithm: wrappers.COSE_ALG_DIRECT_HKDF_SHA_256,
  });
  const encoded = core.encodeRecordBytes(enc);

  const rec = core.decodeRecordBytes(encoded);
  const checked = core.applyCriticality(rec, OLD_ENCRYPT_KNOWN_KEYS);

  assert.equal(checked.aborted, false);
  assert.deepEqual(checked.ignoredKeys.sort(), [3, 5]);
  assert.deepEqual(wrappers.encryptDecode(rec, key), innerBytes);
});
