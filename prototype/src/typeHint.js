'use strict';
// §3.1's Type Hint (key 1): a globally-reserved, odd/optional field whose
// shape depends on which identity key 0 holds — a name string when key 0 is
// a private-use-random ID, or a legacy numeric ID when key 0 is registered.
// This module only implements the optional, opportunistic strengthening:
// deriving a private-use-random Type ID from a hash of its own name, so the
// (name, ID) binding is independently checkable without trusting a registry.
//
// The algorithm is pinned, not left as "hash(name)" with implementation-
// defined details -- SHA-256 over the name's UTF-8 bytes, truncated to
// the first N bytes of the digest read as a big-endian uint, where N is
// derived from the *candidate ID's own magnitude* (4 bytes if it fits in
// 32 bits, 8 otherwise) rather than a separately-negotiated constant.
// Two independent implementations computing this for the same name MUST
// agree, or "anyone can independently check" (spec §3.1) isn't actually
// true. See QDEF-SPEC.md §3.1 for the normative definition this mirrors.

const crypto = require('crypto');

const PRIVATE_USE_RANDOM_FLOOR = 0x10000;
const HASH_ID_NARROW_WIDTH = 4; // for candidate IDs that fit in 32 bits
const HASH_ID_WIDE_WIDTH = 8; // for candidate IDs that need up to 64 bits

/**
 * The hash-truncation width to use for a given candidate ID, derived from
 * its own magnitude rather than chosen independently -- an ID that needs
 * more than 32 bits to represent MUST be checked against an 8-byte
 * truncation, or a genuinely 64-bit-class ID (e.g. TagDrop's own private-
 * use Type IDs) could never verify no matter how it was actually derived.
 */
function widthForId(id) {
  const value = typeof id === 'bigint' ? id : BigInt(id);
  return value < (1n << 32n) ? HASH_ID_NARROW_WIDTH : HASH_ID_WIDE_WIDTH;
}

function deriveHashId(name, byteWidth = HASH_ID_NARROW_WIDTH) {
  const digest = crypto.createHash('sha256').update(name, 'utf8').digest();
  if (byteWidth === HASH_ID_WIDE_WIDTH) {
    return digest.readBigUInt64BE(0);
  }
  return digest.readUIntBE(0, byteWidth);
}

/**
 * Opportunistically check whether a Type Hint name string is the source of
 * its sibling private-use-random Type ID. Never throws: a hint that isn't a
 * checkable string, or simply doesn't match, degrades to 'unverified' —
 * exactly as if this convention weren't in use for that Record at all.
 */
function verifyTypeHint(typeId, hint) {
  if (typeof hint !== 'string') return 'not-applicable';
  if (typeId < PRIVATE_USE_RANDOM_FLOOR) return 'not-applicable';
  const derived = deriveHashId(hint, widthForId(typeId));
  // Normalize to BigInt before comparing: deriveHashId returns a plain
  // Number for the 4-byte path and a BigInt for the 8-byte path, and
  // JS's === never coerces between them (5 === 5n is false) -- a real
  // trap here, not a hypothetical one, since this codebase mixes both
  // representations depending on a Type ID's own magnitude.
  return BigInt(derived) === BigInt(typeId) ? 'verified' : 'unverified';
}

module.exports = {
  PRIVATE_USE_RANDOM_FLOOR,
  HASH_ID_NARROW_WIDTH,
  HASH_ID_WIDE_WIDTH,
  widthForId,
  deriveHashId,
  verifyTypeHint,
};
