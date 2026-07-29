'use strict';
// Namespace scoping (§3.5): a byte-string prefix on a Record, scoping
// its non-standard typeIds. Empty bstr = inherit parent's namespace.
// Standard types (typeId 1-22) always ignore namespace and stay global.

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
 * localNamespace and its immediate parent's effective namespace
 * (§3.5's Cascade rule: inheritance only flows through an unbroken
 * chain — an intervening Record with no namespace of its own breaks
 * the chain for anything nested inside it, even if some ancestor
 * further up declared one).
 *
 * - localNamespace is undefined (no bstr at all): this Record has NO
 *   namespace, full stop. Does NOT inherit — the chain is broken here.
 * - localNamespace is an empty Buffer (h'', the inherit marker): use
 *   ambientNamespace (the immediate parent's own effective namespace).
 *   Only meaningful if the parent actually had one.
 * - localNamespace is a non-empty Buffer: this Record's own explicit
 *   namespace, which becomes what ITS subrecords can inherit from.
 *
 * Returns the effective namespace Buffer, or undefined if none.
 */
function effectiveNamespace(localNamespace, ambientNamespace) {
  if (localNamespace === undefined) return undefined;
  if (isInheritMarker(localNamespace)) return ambientNamespace;
  return localNamespace;
}

/**
 * Check if a namespace value is the inherit-empty marker.
 */
function isInheritMarker(ns) {
  return Buffer.isBuffer(ns) && ns.length === 0;
}

/**
 * Walk a decoded Record tree (the shape core.js's decode functions
 * produce: { typeId, localNamespace, subrecords, ... }) and annotate
 * every node in place with its own resolved `effectiveNamespace`,
 * applying the Cascade rule (§3.5) recursively down the tree. Returns
 * the same (mutated) root record for convenience.
 */
function resolveNamespacesDeep(record, ambientNamespace) {
  const resolved = effectiveNamespace(record.localNamespace, ambientNamespace);
  record.effectiveNamespace = resolved;
  if (record.subrecords) {
    for (const sub of record.subrecords) {
      resolveNamespacesDeep(sub, resolved);
    }
  }
  return record;
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
  resolveNamespacesDeep,
  deriveHashId,
  verifyNamespaceHint,
};
