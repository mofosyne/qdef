'use strict';
// Container discriminator (spec §3.5): the mandatory first CBOR item
// after magic, dispatched by its own CBOR major type into one of
// several shapes. core.js only knows how to split it off the front and
// where it ends -- this module interprets what it means. Record-Type-
// interpretation-specific handling (spec §3.3's optional tier), never a
// mandatory-core concern: core.decodeContainer needs zero knowledge of
// namespaces to do its job.
//
// Namespace IDs are always Decentralized (a byte string) -- there is no
// Allocated (uint) namespace tier. An earlier draft gave namespace IDs
// the same uint-or-byte-string convention as Record Type IDs; dropped
// after checking what a real adopter (TagDrop) actually does (always
// decentralized) and recognizing that a *namespace* has fundamentally
// different collision-safety needs than a Type ID does: a namespace is
// the global root of trust for everything scoped inside it, and it's
// exactly the value that ends up baked into physical, already-printed
// media with no way to retroactively fix a bad choice. See
// docs/FINDINGS.md's decentralized-namespace finding for the full
// reasoning, including the birthday-paradox math behind the 4-byte
// self-certify floor below `HEADER_NAMESPACE_MIN_SELF_CERTIFY_BYTES`.
//
// Shapes, in the order a decoder checks them:
//   uint 0                        -> no namespace declared (the common case,
//                                    1 byte total, cheaper than the
//                                    previous "no Type 0 present" convention
//                                    cost -- 0 bytes -- ever was NOT: this
//                                    trades that free case for an
//                                    unconditionally unambiguous one; see
//                                    DESIGN.md for why that trade was made)
//   byte string                   -> Decentralized Namespace ID
//                                    (self-certifying, no registry needed;
//                                    the ONLY real namespace value shape)
//   map                           -> full extensible form, matching what
//                                    used to be the Type 0 Record's own
//                                    map: {1: namespace (bstr), 3: hint
//                                    (tstr), 5: a second, differently-
//                                    sized bstr namespace for a length-
//                                    promotion transition, ...future
//                                    even/odd keys}. The ONLY way to carry
//                                    a hint or a backup ID -- there is no
//                                    bare positional-array shortcut for
//                                    either (see docs/FINDINGS.md's
//                                    discriminator-collapse finding for
//                                    why: this item is a one-time,
//                                    per-container cost, so the bytes a
//                                    bespoke array shape would have saved
//                                    were never worth extra shapes for a
//                                    decoder to recognize).
//   anything else (incl. arrays,  -> unrecognized shape, degrades to "no
//   and any nonzero uint)            namespace" -- the same graceful
//                                    degrade an absent or aborted Type 0
//                                    Record already had, never a hard
//                                    failure. A nonzero uint is included
//                                    here deliberately: it used to mean
//                                    an Allocated namespace and no longer
//                                    means anything.

const crypto = require('crypto');

const HEADER_NAMESPACE_KEY = 1; // map form only: namespace (bstr)
const HEADER_NAMESPACE_HINT_KEY = 3; // map form only: recoverable name for it
const HEADER_NAMESPACE_BACKUP_KEY = 5; // map form only: a second bstr namespace, for a length-promotion transition

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
 * Normalize the raw discriminator value returned by core.decodeContainer
 * into {namespace, hint, decentralizedBackup} (hint/decentralizedBackup
 * possibly undefined), or undefined if no namespace is declared. Absent,
 * the "uint 0" sentinel, and an unrecognized future shape (including any
 * nonzero uint -- there is no Allocated namespace tier) all mean exactly
 * the same thing to a caller: interpret every Record's Type ID globally,
 * as if this mechanism didn't exist for this container.
 */
function parseDiscriminator(discriminator) {
  if (discriminator === undefined) return undefined;

  if (typeof discriminator === 'number' || typeof discriminator === 'bigint') {
    // Only the zero sentinel means anything; any other uint used to be
    // an Allocated namespace and now just degrades, same as an
    // unrecognized shape.
    return undefined;
  }

  if (Buffer.isBuffer(discriminator)) {
    return { namespace: discriminator };
  }

  // Arrays are no longer a recognized discriminator shape (see the
  // discriminator-collapse finding in docs/FINDINGS.md) -- an array here
  // falls through to the final "unrecognized" return below, degrading
  // gracefully to "no namespace" like any other unrecognized shape.

  if (isMapLike(discriminator)) {
    const namespace = mapGet(discriminator, HEADER_NAMESPACE_KEY);
    if (namespace === undefined) return undefined;
    return {
      namespace,
      hint: mapGet(discriminator, HEADER_NAMESPACE_HINT_KEY),
      decentralizedBackup: mapGet(discriminator, HEADER_NAMESPACE_BACKUP_KEY),
    };
  }

  // Text string, array, or any other shape: not a defined discriminator
  // form -- degrades to "no namespace" (§3.5).
  return undefined;
}

/**
 * Compares two namespace values for equality. A conformant namespace
 * value is always a Buffer now (§3.5 -- there is no Allocated/uint
 * namespace tier), and `===`/`!==` is never safe for that: it's
 * reference identity, not content equality, so two independently-
 * decoded Buffers holding byte-for-byte identical namespace values are
 * never `===`. A namespace's true identity is its exact byte content --
 * length is already part of that identity for free, since two
 * different-length byte strings can never be byte-for-byte equal to
 * begin with; nothing extra needs checking for that beyond an ordinary
 * content comparison. The number/bigint branch below is defensive, not
 * a normal case: the map form's namespace key (`1`) is never type-
 * checked at the structural-decode layer, so a non-conformant encoder
 * could still put a uint there -- this just makes sure that degrades to
 * a safe, correct comparison instead of a silent bug, the same class as
 * the one this function was written to fix (FINDINGS.md).
 */
function namespaceEquals(a, b) {
  if (a === undefined || b === undefined) return a === b;
  const aBuf = Buffer.isBuffer(a);
  const bBuf = Buffer.isBuffer(b);
  if (aBuf || bBuf) return aBuf && bBuf && a.equals(b);
  return BigInt(a) === BigInt(b);
}

function isMapLike(item) {
  if (item instanceof Map) return true;
  return (
    item !== null &&
    typeof item === 'object' &&
    !Buffer.isBuffer(item) &&
    !Array.isArray(item)
  );
}

function mapGet(mapLike, key) {
  return mapLike instanceof Map ? mapLike.get(key) : mapLike[key];
}

/**
 * Resolves the correct lookup key for a Record's Type ID, given the
 * container's normalized header (as returned by parseDiscriminator, or
 * undefined).
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
 * Resolves the correct lookup key for a Record, the same as
 * resolveLookupKey, but accounting for a per-Record namespace override
 * (core.js's Record.localNamespace, from a namespace-pairing prefix
 * item, §3.1) when the Record declares one. A local override takes
 * priority over the container's ambient discriminator-declared
 * namespace for this one Record only — every other Record in the same
 * container is unaffected and still resolves against the ambient
 * namespace. This is what makes more than one namespace usable within a
 * single container without taxing the common single-namespace case: the
 * ambient discriminator stays the cheap default, and only a Record that
 * actually wants a different namespace pays anything extra for it.
 *
 * @param {{typeId: number|bigint, localNamespace?: Buffer}} record
 * @param {{namespace: Buffer, hint?: string}|undefined} containerHeader -
 *   as returned by parseDiscriminator, or undefined
 */
function resolveLookupKeyForRecord(record, containerHeader) {
  const effectiveHeader =
    record.localNamespace !== undefined
      ? { namespace: record.localNamespace }
      : containerHeader;
  return resolveLookupKey(effectiveHeader, record.typeId);
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
 * where N is simply the candidate namespace's own byte length (a
 * namespace value is always a byte string, §3.5 -- there is no uint
 * width to infer, unlike the now-retired Type Hint mechanism this
 * algorithm was first pinned for). Verification is opportunistic: no
 * hint means nothing to check, a match confirms the binding, a mismatch
 * degrades to "an unverified label," never a hard failure (§3.5).
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
  HEADER_NAMESPACE_KEY,
  HEADER_NAMESPACE_HINT_KEY,
  HEADER_NAMESPACE_BACKUP_KEY,
  HEADER_NAMESPACE_MIN_SELF_CERTIFY_BYTES,
  parseDiscriminator,
  namespaceEquals,
  resolveLookupKey,
  resolveLookupKeyForRecord,
  deriveHashId,
  verifyNamespaceHint,
};
