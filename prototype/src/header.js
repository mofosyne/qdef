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
// Encrypt gained Algorithm/Key Algorithm and App Route gained Companion
// ID as new keys on their existing Type IDs, never as new Types). No
// dedicated "version" field either -- even/odd extensibility already is
// the version mechanism, for free: a genuinely incompatible future
// change to Type 0 itself is just a new even/critical key, whenever
// it's actually needed. An old decoder that doesn't recognize it aborts
// only this one Record (§3.2) and falls back to unnamespaced, the same
// graceful, already-proven degrade every other stdlib Record already
// has -- no field needs to be pre-allocated in advance.

const core = require('./core');

const HEADER_TYPE = 0;
const HEADER_NAMESPACE_KEY = 3; // odd/optional: format namespace uint
const HEADER_NAMESPACE_HINT_KEY = 5; // odd/optional: recoverable name for it
const HEADER_KNOWN_KEYS = new Set([0, HEADER_NAMESPACE_KEY, HEADER_NAMESPACE_HINT_KEY]);

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

module.exports = {
  HEADER_TYPE,
  HEADER_KNOWN_KEYS,
  HEADER_NAMESPACE_KEY,
  HEADER_NAMESPACE_HINT_KEY,
  extractHeader,
};
