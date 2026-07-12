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
// The choice of Type ID is the version/generation signal for this
// mechanism: Type 0 is the only header shape defined today. A
// genuinely incompatible future header shape would claim a different
// reserved low Type ID; an old decoder simply doesn't recognize it and
// skips the whole Record via the ordinary unrecognized-Type-ID path --
// no separate version field needed.

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
