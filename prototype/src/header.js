'use strict';
// Container discriminator (spec §3.5): the mandatory first CBOR item
// after magic, dispatched by its own CBOR major type into one of
// several shapes. core.js only knows how to split it off the front and
// where it ends -- this module interprets what it means. Record-Type-
// interpretation-specific handling (spec §3.3's optional tier), never a
// mandatory-core concern: core.decodeContainer needs zero knowledge of
// namespaces to do its job.
//
// Shapes, in the order a decoder checks them:
//   uint 0                        -> no namespace declared (the common case,
//                                    1 byte total, cheaper than the
//                                    previous "no Type 0 present" convention
//                                    cost -- 0 bytes -- ever was NOT: this
//                                    trades that free case for an
//                                    unconditionally unambiguous one; see
//                                    DESIGN.md for why that trade was made)
//   uint N > 0                    -> Allocated Namespace ID = N (registered,
//                                    common-vocabulary style)
//   byte string                   -> Decentralized Namespace ID
//                                    (self-certifying, no registry needed)
//   array [uint, byte string]     -> [Allocated Namespace ID,
//                                    Decentralized Namespace ID backup] --
//                                    a promotion/transition pair, the same
//                                    backup-typeID convention Records
//                                    already use (§3.1), applied to
//                                    namespace promotion
//   array [id, text]              -> [Namespace ID (uint or byte string),
//                                    Namespace Name hint] -- one shape
//                                    covering both an Allocated ID with a
//                                    plain recovery hint and a Decentralized
//                                    ID with a self-certifying one;
//                                    disambiguated purely by id's own major
//                                    type, same recognition rule either way
//                                    (element[1] is a text string)
//   array [uint, byte string, text] -> [Allocated Namespace ID,
//                                    Decentralized Namespace ID backup,
//                                    Namespace Name hint] -- all three
//                                    together, for a promotion in progress
//                                    that also wants a hint
//   map                           -> full extensible form, matching what
//                                    used to be the Type 0 Record's own
//                                    map: {1: namespace (uint|bstr),
//                                    3: hint (tstr), 5: decentralized
//                                    backup (bstr), ...future even/odd
//                                    keys}. For cases needing more than
//                                    the bare/pair/triple forms above.
//   anything else                  -> unrecognized shape, degrades to "no
//                                    namespace" -- the same graceful
//                                    degrade an absent or aborted Type 0
//                                    Record already had, never a hard
//                                    failure.

const HEADER_NAMESPACE_KEY = 1; // map form only: namespace (uint|bstr)
const HEADER_NAMESPACE_HINT_KEY = 3; // map form only: recoverable name for it
const HEADER_NAMESPACE_BACKUP_KEY = 5; // map form only: decentralized backup (bstr)

/**
 * Normalize the raw discriminator value returned by core.decodeContainer
 * into {namespace, hint, decentralizedBackup} (hint/decentralizedBackup
 * possibly undefined), or undefined if no namespace is declared. Absent,
 * the "uint 0" sentinel, and an unrecognized future shape all mean
 * exactly the same thing to a caller: interpret every Record's Type ID
 * globally, as if this mechanism didn't exist for this container.
 */
function parseDiscriminator(discriminator) {
  if (discriminator === undefined) return undefined;

  if (typeof discriminator === 'number' || typeof discriminator === 'bigint') {
    return BigInt(discriminator) === 0n ? undefined : { namespace: discriminator };
  }

  if (Buffer.isBuffer(discriminator)) {
    return { namespace: discriminator };
  }

  if (Array.isArray(discriminator)) {
    if (discriminator.length === 2) {
      const [a, b] = discriminator;
      const aIsId = typeof a === 'number' || typeof a === 'bigint' || Buffer.isBuffer(a);
      if ((typeof a === 'number' || typeof a === 'bigint') && Buffer.isBuffer(b)) {
        return { namespace: a, decentralizedBackup: b };
      }
      if (aIsId && typeof b === 'string') {
        return { namespace: a, hint: b };
      }
      return undefined; // unrecognized array shape
    }
    if (discriminator.length === 3) {
      const [a, b, c] = discriminator;
      const aIsUint = typeof a === 'number' || typeof a === 'bigint';
      if (aIsUint && Buffer.isBuffer(b) && typeof c === 'string') {
        return { namespace: a, decentralizedBackup: b, hint: c };
      }
      return undefined; // unrecognized array shape
    }
    return undefined; // unrecognized array length
  }

  if (isMapLike(discriminator)) {
    const namespace = mapGet(discriminator, HEADER_NAMESPACE_KEY);
    if (namespace === undefined) return undefined;
    return {
      namespace,
      hint: mapGet(discriminator, HEADER_NAMESPACE_HINT_KEY),
      decentralizedBackup: mapGet(discriminator, HEADER_NAMESPACE_BACKUP_KEY),
    };
  }

  // Text string, or any other shape: not currently a defined
  // discriminator form.
  return undefined;
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
 * Classification (spec §3.1):
 * - Byte string IDs are always global (collision safety from byte length)
 * - Even uint IDs are always global (standard record types)
 * - Odd uint IDs require a declared namespace (scoped record types)
 *
 * This is Record-Type-interpretation-specific handling (spec §3.3's
 * optional tier), not a mandatory-core concern — the mandatory core
 * (core.js) never calls this and needs no namespace knowledge at all.
 */
function resolveLookupKey(header, typeId) {
  // Byte string IDs are always global
  if (Buffer.isBuffer(typeId)) {
    return { scope: 'global', typeId };
  }
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
 * @param {{typeId: number|bigint|Buffer, localNamespace?: number|bigint|Buffer}} record
 * @param {{namespace: number|bigint|Buffer, hint?: string}|undefined} containerHeader -
 *   as returned by parseDiscriminator, or undefined
 */
function resolveLookupKeyForRecord(record, containerHeader) {
  const effectiveHeader =
    record.localNamespace !== undefined
      ? { namespace: record.localNamespace }
      : containerHeader;
  return resolveLookupKey(effectiveHeader, record.typeId);
}

module.exports = {
  HEADER_NAMESPACE_KEY,
  HEADER_NAMESPACE_HINT_KEY,
  HEADER_NAMESPACE_BACKUP_KEY,
  parseDiscriminator,
  resolveLookupKey,
  resolveLookupKeyForRecord,
};
