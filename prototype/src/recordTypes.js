'use strict';
// Application/library Record Type schemas used by the prototype's tests.
// Each schema is just "which keys does this Record Type recognize" — the
// minimum a decoder needs to apply the even/odd criticality rule (§3.2).

const WIFI_TYPE = 100;
const WIFI_KNOWN_KEYS = new Set([0, 1, 2, 4, 6]);

const TAGDROP_REGISTRATION_TYPE = 900;
const TAGDROP_REGISTRATION_KNOWN_KEYS = new Set([0, 2]);

const PGP_BACKUP_TYPE = 950;
const PGP_BACKUP_KNOWN_KEYS = new Set([0, 2]);

module.exports = {
  WIFI_TYPE,
  WIFI_KNOWN_KEYS,
  TAGDROP_REGISTRATION_TYPE,
  TAGDROP_REGISTRATION_KNOWN_KEYS,
  PGP_BACKUP_TYPE,
  PGP_BACKUP_KNOWN_KEYS,
};
