'use strict';
// §3.6 Reserved Map Keys: key 0 is payload (every Record), negative keys
// -1 and -3 are QDEF common header keys (ID and UUID). Spec-governed only
// — never self-allocatable by an application, unlike positive keys which
// are per-Type field numbering.

const crypto = require('crypto');

const COMMON_KEY_ID = -1;   // bstr or tstr: NDEF-ID-equivalent correlation token
const COMMON_KEY_UUID = -3; // bstr, exactly 16 bytes: RFC 4122/9562 UUID

/**
 * Generate 16 random bytes suitable for COMMON_KEY_UUID.
 */
function randomUuidBytes() {
  return crypto.randomBytes(16);
}

/**
 * Format a COMMON_KEY_UUID value as canonical UUID text (for display only).
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
  randomUuidBytes,
  uuidBytesToString,
};
