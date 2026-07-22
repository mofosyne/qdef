'use strict';
// §3.6's Common Field Key tier: negative integer map keys, a single
// spec-governed, Type-independent vocabulary any Record's field Map MAY
// use, interpreted the same way regardless of the Record's own Type --
// unlike ordinary (non-negative) keys, which are owned by that Type's
// own author. Subject to the exact same even/odd criticality rule
// (§3.2) as any other map key -- core.js's applyCriticality needs no
// change to support this, since it already applies `key % 2 === 0`
// uniformly to any integer key, negative or not.
//
// All six starter keys below are odd (optional): none is load-bearing
// for a Type's own function, only descriptive/correlating metadata a
// generic tool (a debugger, a search index) can render without knowing
// anything about the Record's Type.
//
// Standards-Action governed only -- never self-allocatable by an
// application, unlike positive Type IDs' 100+ tier. An application-
// invented negative key would break the one property this tier exists
// for: a debugger recognizing -1 the same way in every Record it sees.

const crypto = require('crypto');

const COMMON_KEY_ID = -1; // bstr or tstr: an NDEF-ID-equivalent
//   correlation/reference token -- matches between Records that share
//   it, no uniqueness guarantee beyond that
const COMMON_KEY_UUID = -3; // bstr, exactly 16 bytes: a standard,
//   globally-unique RFC 4122/9562 UUID -- stronger than COMMON_KEY_ID,
//   for identifying content across systems/sessions, not just within
//   one container
const COMMON_KEY_DATE = -5; // CBOR tag 0 (RFC 3339 text) or tag 1
//   (epoch number) -- reuses CBOR's own date tags, no new format
const COMMON_KEY_LABEL = -7; // tstr: human-readable label, generalizing
//   the per-Type label field already duplicated at Open/Hint URI key 1
//   and App Route key 1
const COMMON_KEY_LANGUAGE = -9; // tstr, BCP 47: language tag for
//   whatever human-readable text this Record carries (its own
//   COMMON_KEY_LABEL if present, or a Type's own text field) --
//   generalizes Open/Hint URI's key 3
const COMMON_KEY_CONTENT_HASH = -11; // bstr, multihash-style (1-byte
//   function code + digest, no separate length field -- exactly §4.5's
//   Media Preview key 1 shape, see wrappers.js's contentHashPrefix)
//   generalizing that pattern for any Record's content, not just Media
//   Preview's

/**
 * Generate 16 random bytes suitable for COMMON_KEY_UUID -- a v4
 * (random) UUID's raw binary form, no canonical-text overhead.
 */
function randomUuidBytes() {
  return crypto.randomBytes(16);
}

/**
 * Format a COMMON_KEY_UUID value as canonical, dashed, lowercase-hex
 * UUID text (RFC 9562 §4's textual representation) -- for display only;
 * the wire form always stays the raw 16-byte binary, never this string.
 */
function uuidBytesToString(buf) {
  if (!Buffer.isBuffer(buf) || buf.length !== 16) {
    throw new Error('UUID must be exactly 16 bytes');
  }
  const hex = buf.toString('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

module.exports = {
  COMMON_KEY_ID,
  COMMON_KEY_UUID,
  COMMON_KEY_DATE,
  COMMON_KEY_LABEL,
  COMMON_KEY_LANGUAGE,
  COMMON_KEY_CONTENT_HASH,
  randomUuidBytes,
  uuidBytesToString,
};
