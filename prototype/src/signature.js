'use strict';
// QDEF Signature (§4.7, Type 16, standard record type): a sibling Record
// that signs every Record immediately preceding it within the same array
// -- the top-level Sequence, or a shared parent's subrecord list -- since
// the start of that array or the previous Signature Record within it,
// whichever is nearer. Coverage is purely positional: no hash list, no
// coverage-identification bytes at all (see docs/DESIGN.md's "Sign /
// detached-authenticity wrapper" entry, the fourth coverage strategy).
//
// Ed25519 only for this prototype -- fixed-size keys and signatures, no
// algorithm parameters, natively supported by Node's crypto module (no
// new dependency). Other COSE algorithms are a wire-compatible future
// extension (key 0 already carries the COSE Algorithm ID), not a format
// change.

const crypto = require('crypto');
const core = require('./core');

const SIGNATURE_TYPE = 16;
const SIGNATURE_KNOWN_KEYS = new Set([0, 2]);

// COSE Algorithm ID (RFC 9053, IANA "COSE Algorithms" registry) -- same
// "borrow, don't invent" reasoning as Encrypt's key 3/5 (§4.1).
const COSE_ALG_EDDSA = -8;

/**
 * Generate an Ed25519 signing key pair (Node KeyObjects, not raw bytes --
 * use publicKeyRawBytes to get the 32 bytes that travel on the wire).
 */
function generateSigningKeyPair() {
  return crypto.generateKeyPairSync('ed25519');
}

/**
 * Extract an Ed25519 public key's raw 32 bytes (the wire form, key 2)
 * from a Node KeyObject, via JWK rather than hand-parsing SPKI DER.
 */
function publicKeyRawBytes(publicKey) {
  const jwk = publicKey.export({ format: 'jwk' });
  return Buffer.from(jwk.x, 'base64url');
}

/**
 * Rebuild a Node public-KeyObject from the raw 32 bytes carried in a
 * Signature Record's key 2 -- the inverse of publicKeyRawBytes.
 */
function publicKeyFromRawBytes(rawBytes) {
  return crypto.createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: rawBytes.toString('base64url') },
    format: 'jwk',
  });
}

/**
 * Convert a decoded Record (core.js's decode shape: `map`, recursively
 * decoded `subrecords`) back into encode-ready shape (`fields`,
 * recursively re-encodable `subrecords`) so it can be fed back through
 * core.encodeRecordBytes to reproduce its own canonical wire bytes.
 * Relies on canonical encoding (§3.4) being deterministic -- the same
 * assumption Split's group_id and Media Preview's content hash already
 * make; see docs/DESIGN.md.
 */
function decodedToEncodable(rec) {
  return {
    typeId: rec.typeId,
    fields: rec.map || undefined,
    payload: rec.payload,
    localNamespace: rec.localNamespace,
    subrecords: rec.subrecords ? rec.subrecords.map(decodedToEncodable) : undefined,
  };
}

/**
 * The exact bytes a Signature Record signs/verifies: the concatenation
 * of each covered Record's own canonical wire bytes, in order -- no
 * extra framing, since CBOR items are already self-delimiting and this
 * is already a contiguous run in the encoded container (see
 * docs/DESIGN.md's "coverage is always deep" finding).
 */
function coveredMessageBytes(coveredRecords) {
  return Buffer.concat(coveredRecords.map((r) => core.encodeRecordBytes(decodedToEncodable(r))));
}

/**
 * Build a Signature Record (Type 16) covering `coveredRecords` -- an
 * array of encode-ready record objects (the same shape core.js's
 * encodeRecordBytes expects), given in the exact order they'll appear
 * immediately before this Signature Record in the final array.
 */
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
      [0, algorithm],
      [2, publicKeyRawBytes(publicKey)],
    ]),
    payload: signature,
  };
}

/**
 * Walk one array of already-decoded sibling Records (the top-level
 * Sequence, or a single parent's own `.subrecords`) and verify every
 * Signature Record found in it against the Records immediately
 * preceding it since the start of the array or the previous Signature
 * Record -- NOT recursive; a Signature Record never covers anything at
 * a different nesting level (see docs/DESIGN.md). Returns one result
 * per Signature Record found, in order.
 */
function verifySignaturesInList(records) {
  const results = [];
  let checkpoint = 0;
  for (let idx = 0; idx < records.length; idx++) {
    const rec = records[idx];
    if (rec.typeId !== SIGNATURE_TYPE) continue;

    const covered = records.slice(checkpoint, idx);
    const criticality = core.applyCriticality(rec, SIGNATURE_KNOWN_KEYS);
    let valid = false;
    let reason;
    if (criticality.aborted) {
      reason = criticality.abortReason;
    } else {
      const algorithm = rec.map ? rec.map.get(0) : undefined;
      const publicKeyBytes = rec.map ? rec.map.get(2) : undefined;
      if (algorithm !== COSE_ALG_EDDSA) {
        reason = `unsupported algorithm ${algorithm}: this prototype only implements EdDSA (-8)`;
      } else if (!publicKeyBytes || !rec.payload) {
        reason = 'missing public key or signature bytes';
      } else {
        const message = coveredMessageBytes(covered);
        const publicKey = publicKeyFromRawBytes(publicKeyBytes);
        valid = crypto.verify(null, message, publicKey, rec.payload);
        if (!valid) reason = 'signature does not match covered Records';
      }
    }

    results.push({ index: idx, coveredCount: covered.length, valid, reason });
    checkpoint = idx + 1;
  }
  return results;
}

/**
 * verifySignaturesInList, applied to the top-level Sequence AND
 * recursively to every Record's own `.subrecords` list -- the full
 * verification pass a real decoder would run, since a Signature Record
 * can appear at any nesting level, each one scoped to its own list only.
 */
function verifyAllSignatures(records) {
  let results = verifySignaturesInList(records);
  for (const rec of records) {
    if (rec.subrecords && rec.subrecords.length > 0) {
      results = results.concat(verifyAllSignatures(rec.subrecords));
    }
  }
  return results;
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
