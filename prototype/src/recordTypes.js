'use strict';
// Application/library Record Type schemas used by the prototype's tests.
// Each schema is "which keys does this Record Type recognize" — key 0 is
// always the payload (spec-reserved), keys > 0 are Type-specific fields.

// Bundle has no typeId (absent) and no known keys — structural only.
const BUNDLE_KNOWN_KEYS = new Set([]);

const WIFI_TYPE = [100];
const WIFI_KNOWN_KEYS = new Set([1, 2, 4, 6]);

const TAGDROP_REGISTRATION_TYPE = [900];
const TAGDROP_REGISTRATION_KNOWN_KEYS = new Set([]); // payload-only at key 0

const PGP_BACKUP_TYPE = [950];
const PGP_BACKUP_KNOWN_KEYS = new Set([]); // payload-only at key 0

module.exports = {
  BUNDLE_KNOWN_KEYS,
  WIFI_TYPE,
  WIFI_KNOWN_KEYS,
  TAGDROP_REGISTRATION_TYPE,
  TAGDROP_REGISTRATION_KNOWN_KEYS,
  PGP_BACKUP_TYPE,
  PGP_BACKUP_KNOWN_KEYS,
};
