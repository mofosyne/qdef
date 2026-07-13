'use strict';
// §3.1's Type Hint (key 1): a globally-reserved, odd/optional field whose
// shape depends on which identity key 0 holds — a name string when key 0 is
// a decentralized byte string ID, or a legacy byte string ID when key 0 is
// a promoted standard record type. This module only implements the optional,
// opportunistic strengthening: deriving a decentralized Type ID from a hash
// of its own name, so the (name, ID) binding is independently checkable
// without trusting a registry.
//
// The algorithm is pinned, not left as "hash(name)" with implementation-
// defined details — SHA-256 over the name's UTF-8 bytes, truncated to the
// first N bytes of the digest as a definite-length CBOR byte string (major
// type 2), where N is a developer-chosen byte length (minimum 2, recommended
// 4+). Two independent implementations computing this for the same name and
// N MUST agree, or "anyone can independently check" (spec §3.1) isn't
// actually true. See QDEF-SPEC.md §3.1 for the normative definition this
// mirrors.

const crypto = require('crypto');

const MIN_BYTE_LENGTH = 2;
const RECOMMENDED_GLOBAL_BYTE_LENGTH = 4;

/**
 * Derive a decentralized Type ID from a name. Returns a Buffer containing
 * the first `byteWidth` bytes of the SHA-256 digest.
 *
 * @param {string} name - The name to derive from (UTF-8 encoded)
 * @param {number} byteWidth - Number of bytes to truncate to (minimum 2)
 * @returns {Buffer}
 */
function deriveHashId(name, byteWidth = RECOMMENDED_GLOBAL_BYTE_LENGTH) {
  if (byteWidth < MIN_BYTE_LENGTH) {
    throw new Error(`byteWidth must be >= ${MIN_BYTE_LENGTH}, got ${byteWidth}`);
  }
  const digest = crypto.createHash('sha256').update(name, 'utf8').digest();
  return Buffer.from(digest.subarray(0, byteWidth));
}

/**
 * Opportunistically check whether a Type Hint name string is the source of
 * its sibling decentralized Type ID. Never throws: a hint that isn't a
 * checkable string, or simply doesn't match, degrades to 'unverified' —
 * exactly as if this convention weren't in use for that Record at all.
 *
 * @param {Buffer|number} typeId - The Type ID from key 0 (byte string Buffer or uint)
 * @param {string} hint - The Type Hint name from key 1
 * @returns {'verified'|'unverified'|'not-applicable'}
 */
function verifyTypeHint(typeId, hint) {
  if (typeof hint !== 'string') return 'not-applicable';
  // Only verify byte string (Buffer) Type IDs — uint IDs are standard/registered
  if (!Buffer.isBuffer(typeId)) return 'not-applicable';
  const derived = deriveHashId(hint, typeId.length);
  return derived.equals(typeId) ? 'verified' : 'unverified';
}

module.exports = {
  MIN_BYTE_LENGTH,
  RECOMMENDED_GLOBAL_BYTE_LENGTH,
  deriveHashId,
  verifyTypeHint,
};
