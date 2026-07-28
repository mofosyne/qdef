'use strict';
// QDEF Signature (§4.7, Type [0, 16], standard record type): a sibling Record
// that signs every Record immediately preceding it within the same array.

const crypto = require('crypto');
const core = require('./core');

const SIGNATURE_TYPE = [8];
const SIGNATURE_KNOWN_KEYS = new Set([2, 4]); // algorithm=2, publicKey=4

const COSE_ALG_EDDSA = -8;

function generateSigningKeyPair() {
  return crypto.generateKeyPairSync('ed25519');
}

function publicKeyRawBytes(publicKey) {
  const jwk = publicKey.export({ format: 'jwk' });
  return Buffer.from(jwk.x, 'base64url');
}

function publicKeyFromRawBytes(rawBytes) {
  return crypto.createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: rawBytes.toString('base64url') },
    format: 'jwk',
  });
}

function decodedToEncodable(rec) {
  return {
    typeId: rec.typeId,
    fields: rec.map || undefined,
    subrecords: rec.subrecords ? rec.subrecords.map(decodedToEncodable) : undefined,
  };
}

function coveredMessageBytes(coveredRecords) {
  return Buffer.concat(coveredRecords.map((r) => core.encodeRecordBytes(decodedToEncodable(r))));
}

function signatureEncode(coveredRecords, privateKey, { algorithm = COSE_ALG_EDDSA } = {}) {
  if (algorithm !== COSE_ALG_EDDSA) {
    throw new Error(`unsupported algorithm ${algorithm}: this prototype only implements EdDSA (-8)`);
  }
  const message = Buffer.concat(coveredRecords.map((r) => core.encodeRecordBytes(r)));
  const publicKey = crypto.createPublicKey(privateKey);
  const signature = crypto.sign(null, message, privateKey);
  return {
    typeId: SIGNATURE_TYPE,
    fields: new Map([
      [0, signature],           // payload at key 0
      [2, algorithm],            // algorithm at key 2
      [4, publicKeyRawBytes(publicKey)], // public key at key 4
    ]),
  };
}

function verifySignaturesInList(records) {
  const results = [];
  let checkpoint = 0;
  for (let idx = 0; idx < records.length; idx++) {
    const rec = records[idx];
    if (rec.typeId === undefined || !coreArrayEquals(rec.typeId, SIGNATURE_TYPE)) continue;

    const covered = records.slice(checkpoint, idx);
    const criticality = core.applyCriticality(rec, SIGNATURE_KNOWN_KEYS);
    let valid = false;
    let reason;
    if (criticality.aborted) {
      reason = criticality.abortReason;
    } else {
      const map = rec.map || new Map();
      const signature = map.get(0);
      const algorithm = map.get(2);
      const publicKeyBytes = map.get(4);
      if (algorithm !== COSE_ALG_EDDSA) {
        reason = `unsupported algorithm ${algorithm}: this prototype only implements EdDSA (-8)`;
      } else if (!publicKeyBytes || !signature) {
        reason = 'missing public key or signature bytes';
      } else {
        const message = coveredMessageBytes(covered);
        const publicKey = publicKeyFromRawBytes(publicKeyBytes);
        valid = crypto.verify(null, message, publicKey, signature);
        if (!valid) reason = 'signature does not match covered Records';
      }
    }

    results.push({ index: idx, coveredCount: covered.length, valid, reason });
    checkpoint = idx + 1;
  }
  return results;
}

function verifyAllSignatures(records) {
  let results = verifySignaturesInList(records);
  for (const rec of records) {
    if (rec.subrecords && rec.subrecords.length > 0) {
      results = results.concat(verifyAllSignatures(rec.subrecords));
    }
  }
  return results;
}

function coreArrayEquals(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

module.exports = {
  SIGNATURE_TYPE,
  SIGNATURE_KNOWN_KEYS,
  COSE_ALG_EDDSA,
  generateSigningKeyPair,
  publicKeyRawBytes,
  publicKeyFromRawBytes,
  decodedToEncodable,
  coveredMessageBytes,
  signatureEncode,
  verifySignaturesInList,
  verifyAllSignatures,
};
