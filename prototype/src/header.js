'use strict';
// Record Type 0: reserved for container-level metadata (a format
// namespace, an optional recoverable Hint name for it) -- an ordinary
// Record, not a distinct header structure. Reuses the exact same
// even/odd extensibility and key-0 routing every other Record already
// has, rather than a second, parallel extensibility mechanism just for
// the header.
//
// Must be the first Record in the Sequence to serve its purpose (early,
// cheap identification without scanning the whole container). Absent,
// or found anywhere but first, the container is simply treated as
// unnamespaced -- a safe, graceful degrade, never a hard failure.
//
// Type 0 is the one, permanent header Record Type -- it does not get
// "versioned" by minting new Type IDs (that would waste low Type IDs on
// header revisions instead of saving them for real future mechanisms,
// and it's inconsistent with how every other stdlib Record evolves:
// Encrypt gained Algorithm/Key Algorithm as new keys on its existing
// Type ID, never a new Type). No dedicated "version" field either --
// even/odd extensibility already is the version mechanism, for free: a
// genuinely incompatible future change to Type 0 itself is just a new
// even/critical key, whenever it's actually needed. An old decoder that
// doesn't recognize it aborts only this one Record (§3.2) and falls
// back to unnamespaced, the same graceful, already-proven degrade every
// other stdlib Record already has -- no field needs to be pre-allocated
// in advance.

const core = require('./core');
const { deriveHashId, widthForId } = require('./typeHint');

const HEADER_TYPE = 0;
const HEADER_NAMESPACE_KEY = 3; // odd/optional: format namespace uint
const HEADER_NAMESPACE_HINT_KEY = 5; // odd/optional: recoverable name for it
const HEADER_KNOWN_KEYS = new Set([0, HEADER_NAMESPACE_KEY, HEADER_NAMESPACE_HINT_KEY]);

// Type IDs 1-99 (stdlib mechanisms, §4) always stay global regardless of
// any declared namespace -- a generic tool must still be able to unwrap
// Split/Compress/Encrypt/App Route inside a namespaced file. 100+ is
// where namespace-scoping applies.
const STDLIB_MECHANISM_CEILING = 100;

/**
 * Peek at a decoded record list for a valid Type 0 header. Returns
 * undefined if none is present, not first, or aborted -- callers get a
 * plain "no header" result for all three cases, since they mean the same
 * thing: fall back to unnamespaced, global Type ID interpretation.
 */
function extractHeader(records) {
  const first = records[0];
  if (!first || first.aborted || first.typeId !== HEADER_TYPE) {
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
 * Type IDs below STDLIB_MECHANISM_CEILING always resolve globally. Every
 * other Type ID becomes namespace-scoped once a namespace is declared:
 * the real identity is the *compound* (namespace, typeId) pair, not
 * typeId alone -- the same way a Bluetooth short UUID only means
 * anything paired with the Base UUID it's declared against.
 *
 * This is Record-Type-interpretation-specific handling (spec §3.3's
 * optional tier), not a mandatory-core concern -- the mandatory core
 * (core.js) never calls this and needs no namespace knowledge at all.
 * Callers that DO interpret specific 100+ Type IDs must use this (or
 * equivalent logic) rather than looking typeId up directly, or they
 * risk the sharp edge this mechanism has: misapplying a *global*
 * interpretation to a namespace-scoped Record that merely shares the
 * same number -- a wrong match, not a clean miss.
 */
function resolveLookupKey(header, typeId) {
  if (typeId < STDLIB_MECHANISM_CEILING) {
    return { scope: 'global', typeId };
  }
  if (header && header.namespace !== undefined) {
    return { scope: 'namespace', namespace: header.namespace, typeId };
  }
  return { scope: 'global', typeId };
}

/**
 * §3.5's optional, opportunistic self-certifying strengthening for the
 * namespace field: `namespace = truncate(hash(name), N)`, reusing Type
 * Hint's exact algorithm (§3.1) and implementation (typeHint.js) rather
 * than a second hash scheme -- same SHA-256-over-UTF-8, same width-
 * derived-from-magnitude rule, so a namespace value and a Type ID are
 * checked identically, not by two different conventions that happen to
 * look similar.
 */
function verifyNamespaceHint(namespace, hint) {
  if (typeof hint !== 'string') return 'not-applicable';
  const derived = deriveHashId(hint, widthForId(namespace));
  return BigInt(derived) === BigInt(namespace) ? 'verified' : 'unverified';
}

module.exports = {
  HEADER_TYPE,
  HEADER_KNOWN_KEYS,
  HEADER_NAMESPACE_KEY,
  HEADER_NAMESPACE_HINT_KEY,
  STDLIB_MECHANISM_CEILING,
  extractHeader,
  resolveLookupKey,
  verifyNamespaceHint,
};
