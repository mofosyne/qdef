'use strict';
// Namespace scoping (§3.5): a byte-string prefix on a Record, scoping
// its OWN typeId. Empty bstr (h'') = adopt the ambient namespace as its
// own scope; absent = its own typeId is always global (typeId 1-22
// standard types are always global this way, by construction). Either
// way, whatever ambient namespace was received still passes through
// unchanged to its own subrecords unless this Record set an explicit
// namespace of its own -- see effectiveNamespace() vs
// namespaceForChildren() below, which answer two different questions.

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
 * Determine the effective namespace for a Record's OWN typeId, given
 * its own localNamespace and its immediate parent's effective
 * namespace (§3.5's Cascade rule).
 *
 * - localNamespace is undefined (no bstr at all): this Record's own
 *   typeId is global, unconditionally -- regardless of ambientNamespace.
 * - localNamespace is an empty Buffer (h'', the inherit marker): adopt
 *   ambientNamespace (the immediate parent's own effective namespace)
 *   as this Record's own scope.
 * - localNamespace is a non-empty Buffer: this Record's own explicit
 *   namespace.
 *
 * This says nothing about what namespace reaches this Record's own
 * subrecords -- see namespaceForChildren() for that; they are two
 * separate questions.
 *
 * Returns the effective namespace Buffer, or undefined if none.
 */
function effectiveNamespace(localNamespace, ambientNamespace) {
  if (localNamespace === undefined) return undefined;
  if (isInheritMarker(localNamespace)) return ambientNamespace;
  return localNamespace;
}

/**
 * Determine what namespace a Record passes on to its own subrecords
 * as their ambient namespace (§3.5's Cascade rule).
 *
 * An explicit, non-empty localNamespace resets the ambient namespace
 * for everything nested inside this Record. Anything else -- h'', or
 * namespace absent entirely -- passes ambientNamespace straight
 * through unchanged, independent of how this Record's OWN typeId got
 * interpreted (effectiveNamespace, above). This is what lets a scoped
 * Record's h'' reach through an intervening standard-type or Bundle
 * Record that stayed global for its own purposes.
 */
function namespaceForChildren(localNamespace, ambientNamespace) {
  if (localNamespace !== undefined && !isInheritMarker(localNamespace)) {
    return localNamespace;
  }
  return ambientNamespace;
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
  record.effectiveNamespace = effectiveNamespace(record.localNamespace, ambientNamespace);
  const nextAmbient = namespaceForChildren(record.localNamespace, ambientNamespace);
  if (record.subrecords) {
    for (const sub of record.subrecords) {
      resolveNamespacesDeep(sub, nextAmbient);
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
  namespaceForChildren,
  isInheritMarker,
  resolveNamespacesDeep,
  deriveHashId,
  verifyNamespaceHint,
};
