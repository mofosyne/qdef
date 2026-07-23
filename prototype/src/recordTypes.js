'use strict';
// Application/library Record Type schemas used by the prototype's tests.
// Each schema is just "which keys does this Record Type recognize" — the
// minimum a decoder needs to apply the even/odd criticality rule (§3.2).

const BUNDLE_TYPE = 0;
// Namespace no longer lives here -- it's the ordinary namespace-pairing
// prefix (§3.1), same as any other Record, now that typeId is optional
// and a leading bstr is unconditionally recognized as namespace. These
// two keys are what remain of the old container discriminator's
// "full extensible form": a recoverable hint name for the namespace,
// and a second, differently-sized namespace for a length-promotion
// transition. Both odd/optional, both meaningless without a namespace
// actually declared via the positional prefix.
const BUNDLE_HINT_KEY = 3; // tstr: recoverable hint name for the namespace
const BUNDLE_BACKUP_NAMESPACE_KEY = 5; // bstr: a second namespace, for a length-promotion transition
const BUNDLE_KNOWN_KEYS = new Set([BUNDLE_HINT_KEY, BUNDLE_BACKUP_NAMESPACE_KEY]);

const WIFI_TYPE = 100;
const WIFI_KNOWN_KEYS = new Set([0, 1, 2, 4]);

const TAGDROP_REGISTRATION_TYPE = 900;
const TAGDROP_REGISTRATION_KNOWN_KEYS = new Set([0]);

const PGP_BACKUP_TYPE = 950;
const PGP_BACKUP_KNOWN_KEYS = new Set([0]);

module.exports = {
  BUNDLE_TYPE,
  BUNDLE_HINT_KEY,
  BUNDLE_BACKUP_NAMESPACE_KEY,
  BUNDLE_KNOWN_KEYS,
  WIFI_TYPE,
  WIFI_KNOWN_KEYS,
  TAGDROP_REGISTRATION_TYPE,
  TAGDROP_REGISTRATION_KNOWN_KEYS,
  PGP_BACKUP_TYPE,
  PGP_BACKUP_KNOWN_KEYS,
};
