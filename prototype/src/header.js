'use strict';
// Namespace scoping (§3.5): a byte-string prefix on a Record, scoping
// its non-standard typeIds. Empty bstr = inherit parent's namespace.
// Standard types ([0, N]) always ignore namespace.

const crypto = require('crypto');

const MIN_SELF_CERTIFY_BYTES = 4;

/**
 * Check if a typeId is a QDEF standard type (reserved range 1-22,
 * as defined in §4). Standard types are global (no namespace).
 */
function isStandardType(typeId) {
  return Array.isArray(typeId) && typeId.length === 1 && typeId[0] >= 1 && typeId[0] <= 22;
}

/**
 * Determine the effective namespace for a Record given its own
 * localNamespace and its parent's ambient namespace.
 *
 * - localNamespace is a Buffer: use it (even if empty = inherit marker)
 * - localNamespace is undefined: inherit parent's
 *
 * Returns the effective namespace Buffer, or undefined if none.
 */
function effectiveNamespace(localNamespace, ambientNamespace) {
  if (localNamespace !== undefined) return localNamespace;
  return ambientNamespace;
}

/**
 * Check if a namespace value is the inherit-empty marker.
 */
function isInheritMarker(ns) {
  return Buffer.isBuffer(ns) && ns.length === 0;
}

/**
 * Derive a hash-based namespace ID from a name string, per §3.5.
 */
function deriveHashId(name, byteWidth) {
  const digest = crypto.createHash('sha256').update(name, 'utf8').digest();
  return digest.subarray(0, byteWidth);
}

/**
 * Opportunistic verification: if the namespace matches
 * truncate(SHA-256(UTF-8(hint)), namespace.length), return 'verified'.
 * Otherwise 'unverified' or 'not-applicable'.
 */
function verifyNamespaceHint(namespace, hint) {
  if (namespace === undefined || typeof hint !== 'string') {
    return 'not-applicable';
  }
  const derived = deriveHashId(hint, namespace.length);
  return derived.equals(namespace) ? 'verified' : 'unverified';
}

module.exports = {
  MIN_SELF_CERTIFY_BYTES,
  isStandardType,
  effectiveNamespace,
  isInheritMarker,
  deriveHashId,
  verifyNamespaceHint,
};
