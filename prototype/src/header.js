'use strict';
// Record Type 0: reserved for container-level metadata (a format
// namespace) — an ordinary Record, not a distinct header structure.
// Reuses the exact same even/odd extensibility and prefix typeID
// routing every other Record already has.
//
// Must be the first Record in the Sequence to serve its purpose (early,
// cheap identification without scanning the whole container). Absent,
// or found anywhere but first, the container is simply treated as
// unnamespaced — a safe, graceful degrade, never a hard failure.
//
// Type 0 is the one, permanent header Record Type — it does not get
// "versioned" by minting new Type IDs. No dedicated "version" field
// either — even/odd extensibility already is the version mechanism,
// for free: a genuinely incompatible future change to Type 0 itself is
// just a new even/critical key, whenever it's actually needed.

const core = require('./core');

const HEADER_TYPE = 0;
const HEADER_NAMESPACE_KEY = 1; // odd/optional: format namespace (uint or byte string)
const HEADER_NAMESPACE_HINT_KEY = 3; // odd/optional: recoverable name for it
const HEADER_KNOWN_KEYS = new Set([HEADER_NAMESPACE_KEY, HEADER_NAMESPACE_HINT_KEY]);

/**
 * Peek at a decoded record list for a valid Type 0 header. Returns
 * undefined if none is present, not first, or ignored — callers get a
 * plain "no header" result for all three cases, since they mean the
 * same thing: fall back to unnamespaced, global Type ID interpretation.
 */
function extractHeader(records) {
  const first = records[0];
  if (!first || first.ignored || first.typeId !== HEADER_TYPE) {
    return undefined;
  }
  const checked = core.applyCriticality(first, HEADER_KNOWN_KEYS);
  if (checked.aborted) return undefined;
  return {
    namespace: checked.map.get(HEADER_NAMESPACE_KEY),
    hint: checked.map.get(HEADER_NAMESPACE_HINT_KEY),
  };
}

/**
 * Resolves the correct lookup key for a Record's Type ID, given the
 * container's header (as returned by extractHeader, or undefined).
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

module.exports = {
  HEADER_TYPE,
  HEADER_KNOWN_KEYS,
  HEADER_NAMESPACE_KEY,
  HEADER_NAMESPACE_HINT_KEY,
  extractHeader,
  resolveLookupKey,
};
