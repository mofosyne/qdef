'use strict';
// Namespace resolution (spec §3.5): there is no separate "container
// discriminator" item anymore -- a Record's own namespace-pairing
// prefix (core.js's Record.localNamespace, §3.1) is the only namespace
// mechanism, used identically whether that Record is the container
// root or an ordinary subrecord. This module is entirely about
// *cascading* that value down through nesting and *resolving* it
// against a typeId's parity; it has no shape to parse anymore -- see
// docs/FINDINGS.md for why the discriminator collapsed into the
// ordinary Record grammar once typeId became optional.
//
// Namespace IDs are always Decentralized (a byte string) -- there is no
// Allocated (uint) namespace tier. See docs/FINDINGS.md for why.

const crypto = require('crypto');

// Self-certify freely at this length or longer (no registry, no
// coordination -- pick your own bytes). Shorter than this is reserved:
// birthday-paradox collision risk at these widths is real even against
// a small, self-selecting population with no coordination at all (see
// docs/FINDINGS.md), so a namespace this short is only safe if its
// uniqueness is actually guaranteed by direct coordination -- there is
// no formal registry process for that today; it means asking the project
// directly. This is pure guidance, not a wire-format distinction: a
// namespace value is a byte string of any length either way, and nothing
// here rejects a shorter one structurally.
const HEADER_NAMESPACE_MIN_SELF_CERTIFY_BYTES = 4;

/**
 * Compares two namespace values for equality. A conformant namespace
 * value is always a Buffer (§3.5 -- there is no Allocated/uint
 * namespace tier), and `===`/`!==` is never safe for that: it's
 * reference identity, not content equality, so two independently-
 * decoded Buffers holding byte-for-byte identical namespace values are
 * never `===`. A namespace's true identity is its exact byte content --
 * length is already part of that identity for free, since two
 * different-length byte strings can never be byte-for-byte equal to
 * begin with; nothing extra needs checking for that beyond an ordinary
 * content comparison.
 */
function namespaceEquals(a, b) {
  if (a === undefined || b === undefined) return a === b;
  return Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.equals(b);
}

/**
 * Resolves the correct lookup key for a Record's Type ID, given its
 * effective namespace header ({namespace: Buffer} or undefined).
 *
 * Classification (spec §3.1 -- a typeID is always a uint now; byte
 * string and text string Type IDs were both retired, see
 * docs/FINDINGS.md):
 * - Even uint IDs are always global (standard record types)
 * - Odd uint IDs require a declared namespace (scoped record types)
 *
 * This is Record-Type-interpretation-specific handling (spec §3.3's
 * optional tier), not a mandatory-core concern — the mandatory core
 * (core.js) never calls this and needs no namespace knowledge at all.
 */
function resolveLookupKey(header, typeId) {
  // Even uints are always global (standard record types)
  if (typeId % 2 === 0) {
    return { scope: 'global', typeId };
  }
  // Odd uints require a namespace
  if (header && header.namespace !== undefined) {
    return { scope: 'namespace', namespace: header.namespace, typeId };
  }
  // Odd uint without a namespace = error
  throw new Error(`odd uint Type ID ${typeId} requires a declared namespace`);
}

/**
 * A Record's own effective ambient header: its own namespace-pairing
 * override (core.js's Record.localNamespace, §3.1) if it declared one,
 * otherwise whatever ambient header it inherited (its *parent's own*
 * effective header, recursively -- see resolveLookupKeysDeep). A local
 * override takes priority for this one Record only; every sibling is
 * unaffected.
 *
 * @param {{localNamespace?: Buffer}} record
 * @param {{namespace: Buffer}|undefined} ambientHeader
 */
function effectiveHeaderForRecord(record, ambientHeader) {
  return record.localNamespace !== undefined ? { namespace: record.localNamespace } : ambientHeader;
}

/**
 * Resolves the correct lookup key for a Record, the same as
 * resolveLookupKey, but accounting for a per-Record namespace override
 * when the Record declares one.
 *
 * @param {{typeId: number|bigint, localNamespace?: Buffer}} record
 * @param {{namespace: Buffer}|undefined} ambientHeader
 */
function resolveLookupKeyForRecord(record, ambientHeader) {
  return resolveLookupKey(effectiveHeaderForRecord(record, ambientHeader), record.typeId);
}

/**
 * Recursively resolves lookup keys for a Record and every one of its
 * subrecords, cascading the ambient namespace down through nesting: a
 * subrecord with no override of its own resolves against its
 * *immediate parent's* effective namespace, not directly against
 * whatever the outermost ambient one was. A Record that pairs its own
 * typeId with a namespace therefore scopes its own subrecords too, for
 * free, without each one needing to repeat the same pairing item.
 *
 * This is also, now, the container root's own cascade: calling this
 * with the root Record (core.decodeContainer's return value) and no
 * ambient header does the job a separate "container discriminator"
 * mechanism used to -- the root's own namespace (if any) cascades to
 * every one of its subrecords exactly like any other Record's would.
 *
 * @param {Object} record
 * @param {{namespace: Buffer}|undefined} ambientHeader
 * @returns {Array<{record: Object, key: Object}>} depth-first, in
 *   document order.
 */
function resolveLookupKeysDeep(record, ambientHeader, out = []) {
  const effectiveHeader = effectiveHeaderForRecord(record, ambientHeader);
  out.push({ record, key: resolveLookupKey(effectiveHeader, record.typeId) });
  for (const sub of record.subrecords || []) {
    resolveLookupKeysDeep(sub, effectiveHeader, out);
  }
  return out;
}

/**
 * Derives a hash-based ID from a name, per spec §3.5's pinned algorithm
 * (the general-purpose primitive, not tied to Type IDs -- decentralized
 * Type IDs were retired, but namespace IDs and App Route's hash-derived
 * form both still use this): SHA-256 over the name's raw UTF-8 bytes,
 * truncated to the first `byteWidth` digest bytes.
 */
function deriveHashId(name, byteWidth) {
  const digest = crypto.createHash('sha256').update(name, 'utf8').digest();
  return digest.subarray(0, byteWidth);
}

/**
 * §3.5's optional, opportunistic self-certifying strengthening for the
 * namespace field: `namespace = truncate(SHA-256(UTF-8(name)), N)`,
 * where N is simply the candidate namespace's own byte length. A hint
 * name now lives in whatever Record's field Map carries it (e.g.
 * Bundle's own key, §4.6) alongside the namespace-pairing prefix, not
 * inside a separate discriminator shape. Verification is opportunistic:
 * no hint means nothing to check, a match confirms the binding, a
 * mismatch degrades to "an unverified label," never a hard failure.
 *
 * @param {Buffer|undefined} namespace
 * @param {string|undefined} hint
 * @returns {'not-applicable'|'verified'|'unverified'}
 */
function verifyNamespaceHint(namespace, hint) {
  if (namespace === undefined || typeof hint !== 'string') {
    return 'not-applicable';
  }
  const derived = deriveHashId(hint, namespace.length);
  return derived.equals(namespace) ? 'verified' : 'unverified';
}

module.exports = {
  HEADER_NAMESPACE_MIN_SELF_CERTIFY_BYTES,
  namespaceEquals,
  resolveLookupKey,
  resolveLookupKeyForRecord,
  resolveLookupKeysDeep,
  deriveHashId,
  verifyNamespaceHint,
};
