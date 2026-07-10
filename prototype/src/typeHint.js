'use strict';
// §3.1's Type Hint (key 1): a globally-reserved, odd/optional field whose
// shape depends on which identity key 0 holds — a name string when key 0 is
// a private-use-random ID, or a legacy numeric ID when key 0 is registered.
// This module only implements the optional, opportunistic strengthening:
// deriving a private-use-random Type ID from a hash of its own name, so the
// (name, ID) binding is independently checkable without trusting a registry.
//
// Byte width for the truncated hash is illustrative here, not a spec
// decision (QDEF-SPEC.md §3.1 leaves that an open parameter) — 4 bytes
// keeps the derived ID a plain JS safe integer for this prototype.

const crypto = require('crypto');

const PRIVATE_USE_RANDOM_FLOOR = 0x10000;
const HASH_ID_BYTE_WIDTH = 4;

function deriveHashId(name, byteWidth = HASH_ID_BYTE_WIDTH) {
  const digest = crypto.createHash('sha256').update(name, 'utf8').digest();
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
  return deriveHashId(hint) === typeId ? 'verified' : 'unverified';
}

module.exports = {
  PRIVATE_USE_RANDOM_FLOOR,
  HASH_ID_BYTE_WIDTH,
  deriveHashId,
  verifyTypeHint,
};
