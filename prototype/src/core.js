'use strict';
// QDEF core: magic framing, a mandatory container discriminator,
// CBOR-Sequence-of-Records, typeID-prefix routing, even/odd unknown-key
// criticality. Deliberately has no knowledge of any specific Record
// Type, compression, or reassembly (see docs/QDEF-SPEC.md §3.3).
//
// Every Record is a sequence of CBOR items terminating in a CBOR Map:
// one or more typeID items (uint or byte string), OR a namespace-pairing
// array ([namespace, typeId] — a Record declaring/overriding its own
// namespace inline, independent of the container's ambient one, see
// isNamespacePairing below), followed by zero or more unknown items
// (forward-compat padding), then the field Map as the record delimiter.
// The parser accumulates typeIDs (unpacking any pairing item's nested
// typeId) in a contiguous run at the start, skips unknown items, and
// stops at the first Map.
//
// No version byte: local forward compatibility is §3.2's even/odd rule.
// Container-level metadata (a format namespace) lives in a single
// mandatory discriminator item, always the first CBOR item after magic
// -- not an ordinary Record the way it used to be. Making it
// unconditionally present resolves a real ambiguity a bare, unwrapped
// namespace value would otherwise have (indistinguishable from a
// backup typeID belonging to the next real Record) without needing a
// CBOR-tag marker (see docs/DESIGN.md#cbor-tag-routing--removed for why
// that route is already closed). See header.js for the shapes it can
// take and what each one means; core.js only needs to know how to
// split it off the front, never how to interpret it.

const cbor = require('cbor');

const MAGIC = Buffer.from([0x51, 0x44, 0x45, 0x46]); // "QDEF"

/**
 * Encode a QDEF container from a list of records, prefixed by magic and
 * the mandatory discriminator item.
 *
 * @param {Array<{typeIds: Array<number|bigint|Buffer>, fields: Map<number, any>}>} records
 * @param {number|bigint|Buffer|Array|Map} [discriminator] - the
 *   container-level discriminator item (see header.js for its shapes).
 *   Omitted defaults to the bare uint `0`, meaning "no namespace" --
 *   the cheapest legal form, 1 byte.
 */
function encodeContainer(records, discriminator) {
  const discItem = cbor.encodeCanonical(discriminator === undefined ? 0 : discriminator);
  const parts = records.map(encodeRecordBytes);
  return Buffer.concat([MAGIC, discItem, ...parts]);
}

/**
 * Encode a single Record as CBOR bytes: [typeId1][typeId2]...[fieldMap].
 * typeIds is an array — the first element is the primary typeID, the
 * rest are backup typeIDs for transitional routing.
 *
 * @param {Object} record
 * @param {Array<number|bigint|Buffer>} record.typeIds
 * @param {Map<number, any>} [record.fields]
 * @param {number|bigint|Buffer} [record.localNamespace] - if given, wraps
 *   the primary typeID (typeIds[0]) in a namespace-pairing prefix item
 *   ([localNamespace, typeIds[0]]) instead of encoding it bare. See
 *   isNamespacePairing below. Backup typeIDs (typeIds[1+]) are always
 *   encoded bare.
 * @param {string} [record.externalId] - EXPERIMENTAL, not part of the
 *   spec (see isExternalIdWrapper below) -- if given, adds a 1-element
 *   array [externalId] as an additional prefix item, an NDEF-ID-style
 *   external-reference identifier structurally separate from typeIds.
 *   Prototyped to check feasibility only; not wired into any decision.
 * @param {string} [record.coreExternalId] - EXPERIMENTAL, not part of the
 *   spec (see CORE_METADATA_KEYS above) -- if given, writes it into the
 *   field map at reserved key -1, the competing "core metadata lives in
 *   negative map keys" approach to the same externalId question above.
 *   Mutually exclusive with `fields` already having a -1 key.
 */
function encodeRecordBytes({
  typeIds,
  fields,
  localNamespace,
  externalId,
  coreExternalId,
}) {
  if (!typeIds || typeIds.length === 0) {
    throw new Error('typeIds must be a non-empty array');
  }
  let effectiveFields = fields || new Map();
  if (coreExternalId !== undefined) {
    effectiveFields = new Map(effectiveFields);
    effectiveFields.set(-1, coreExternalId);
  }
  const mapBytes = cbor.encodeCanonical(effectiveFields);
  const typeItems = typeIds.map((id, idx) =>
    idx === 0 && localNamespace !== undefined
      ? cbor.encodeCanonical([localNamespace, id])
      : cbor.encodeCanonical(id),
  );
  const externalIdItem =
    externalId !== undefined ? [cbor.encodeCanonical([externalId])] : [];
  return Buffer.concat([...typeItems, ...externalIdItem, mapBytes]);
}

/**
 * Decode a QDEF container down to the raw discriminator item and
 * routed records: no even/odd criticality applied yet (that's
 * per-Record-Type, see applyCriticality), and the discriminator is
 * returned exactly as decoded, uninterpreted -- header.js normalizes
 * it into {namespace, hint}. core.js only knows there is always
 * exactly one such item and where it ends, never what it means.
 */
function decodeContainer(buf) {
  if (buf.length < 4) throw new Error('QDEF container too short for magic');
  const magic = buf.subarray(0, 4);
  if (!magic.equals(MAGIC)) {
    throw new Error(`bad magic: ${magic.toString('hex')}`);
  }
  const seq = buf.subarray(4);
  const items = cbor.decodeAllSync(seq);
  if (items.length === 0) {
    throw new Error('QDEF container missing its mandatory discriminator item');
  }
  const [discriminator, ...rest] = items;
  return { discriminator, records: parseRecords(rest) };
}

/**
 * Decode a bare CBOR Sequence of Records with no magic prefix and no
 * discriminator item — the NDEF/own-URI-scheme path (§2), where the
 * carrier (an NDEF MIME type, or an app's own scheme prefix) already
 * identifies the format *and* already isolates this content from every
 * other QDEF-aware decoder, so neither magic nor a discriminator buys
 * anything here (§3.5). Every item is an ordinary Record, full stop.
 */
function decodeSequence(seq) {
  const items = cbor.decodeAllSync(seq);
  return parseRecords(items);
}

/**
 * Parse an array of decoded CBOR items into Records.
 *
 * Two-phase loop per Record:
 *   Phase 1: accumulate typeIDs (contiguous run of uint/byte-string, or
 *            a namespace-pairing array, at the start — the routing
 *            mechanism)
 *   Phase 2: skip non-map items until the map delimiter
 *
 * If no typeID is found before the map, the Record is ignored. If the
 * sequence ends without a map, the incomplete Record is returned with
 * map: null.
 */
function parseRecords(items) {
  const records = [];
  let i = 0;

  while (i < items.length) {
    // Phase 1: accumulate typeIDs — contiguous run of bare typeID items,
    // namespace-pairing arrays, and/or an EXPERIMENTAL external-ID wrapper
    // (see isExternalIdWrapper below).
    const typeIds = [];
    let localNamespace; // raw, uninterpreted — from this Record's own
    // first pairing item, if any. Same "core exposes it raw, never
    // interprets it" treatment as the container discriminator.
    let externalId; // EXPERIMENTAL, raw and uninterpreted -- from this
    // Record's own first external-ID wrapper, if any. Not part of the
    // spec; prototyped only to check the shape doesn't collide with
    // anything else in this run.
    while (i < items.length) {
      if (isTypeId(items[i])) {
        typeIds.push(items[i]);
        i++;
        continue;
      }
      if (isNamespacePairing(items[i])) {
        const [ns, id] = items[i];
        typeIds.push(id);
        if (localNamespace === undefined) localNamespace = ns;
        i++;
        continue;
      }
      if (isExternalIdWrapper(items[i])) {
        if (externalId === undefined) externalId = items[i][0];
        i++;
        continue;
      }
      break;
    }

    // Phase 2: skip non-map items until the map delimiter
    let map = null;
    while (i < items.length && !isMapItem(items[i])) {
      // Skip unknown items (forward-compat for future QDEF evolution)
      i++;
    }
    if (i < items.length && isMapItem(items[i])) {
      // Normalize: the cbor library decodes empty maps as plain {},
      // but downstream code expects Map instances with .get()/.set().
      map =
        items[i] instanceof Map
          ? items[i]
          : new Map(Object.entries(items[i]).map(([k, v]) => [Number(k), v]));
      i++;
    }

    // EXPERIMENTAL -- see extractCoreMetadata above. Computed unconditionally
    // (zero-cost when the map has no negative keys) purely for comparison
    // against the prefix-item externalId above; not wired into any
    // criticality decision downstream in this prototype.
    const coreMeta = extractCoreMetadata(map);

    records.push({
      typeIds,
      typeId: typeIds[0] ?? null,
      localNamespace,
      externalId,
      coreExternalId: coreMeta.core.externalId,
      coreAborted: coreMeta.aborted,
      coreAbortReason: coreMeta.abortReason,
      map,
      ignored: typeIds.length === 0,
    });
  }

  return records;
}

/**
 * Check if a decoded CBOR item is a valid typeID prefix item:
 * unsigned integer (uint, major type 0), byte string (major type 2),
 * or text string (major type 3, reserved for future use).
 */
function isTypeId(item) {
  if (typeof item === 'number' && Number.isInteger(item) && item >= 0) {
    return true;
  }
  if (typeof item === 'bigint' && item >= 0n) {
    return true;
  }
  if (Buffer.isBuffer(item)) {
    return true;
  }
  if (typeof item === 'string') {
    return true;
  }
  return false;
}

/**
 * Check if a decoded CBOR item is a namespace-pairing prefix item: a
 * definite-length array of exactly 2 elements, [namespace, typeId],
 * where namespace is a valid Namespace ID (uint > 0, or byte string —
 * same convention as the container discriminator's namespace value,
 * §3.5) and typeId is a uint (even = Allocated/global, odd = Scoped to
 * this specific namespace, overriding any container-level ambient
 * namespace for this one Record).
 *
 * Purely structural: this function does not interpret what a namespace
 * IS or how it affects lookup — it only recognizes the shape so Phase 1
 * can pull the nested typeId out for routing. Interpretation (whether
 * the paired namespace actually scopes this typeId, and resolving
 * "local override vs. container-ambient") is header.js's job. A byte
 * string is deliberately never valid as the *typeId* half of a pairing
 * — decentralized Record IDs stay a separate, unpaired, always-global
 * mechanism (§3.1); pairing exists only to let a uint Record ID declare
 * or override its namespace inline.
 */
function isNamespacePairing(item) {
  if (!Array.isArray(item) || item.length !== 2) return false;
  const [ns, id] = item;
  const nsValid =
    (typeof ns === 'number' && Number.isInteger(ns) && ns > 0) ||
    (typeof ns === 'bigint' && ns > 0n) ||
    Buffer.isBuffer(ns);
  const idValid =
    (typeof id === 'number' && Number.isInteger(id) && id >= 0) ||
    (typeof id === 'bigint' && id >= 0n);
  return nsValid && idValid;
}

/**
 * EXPERIMENTAL -- not part of the spec, prototyped only to check
 * feasibility (see the conversation this came from: whether QDEF could
 * add an NDEF-ID-style external-reference identifier, structurally
 * separate from typeIds, without displacing backup typeIDs).
 *
 * Checks if a decoded CBOR item is an external-ID wrapper: a
 * definite-length array of exactly 1 element, a text string (mirroring
 * NDEF's own ID field, always a URI-reference string, §3.2.11 of the
 * NDEF spec). Disambiguated from every other prefix-item shape purely
 * by array length -- 1 element here, 2 for namespace-pairing, bare
 * scalar/string for an ordinary typeID. No CBOR tag involved, so this
 * doesn't reopen the tag-number-collision risk a tag-based approach
 * would.
 *
 * Worth being honest about the parallel: this is itself an instance of
 * "give this combination its own bespoke array shape" -- the exact
 * pattern that grew the container discriminator to eight shapes before
 * being collapsed back to four (see FINDINGS.md's discriminator-collapse
 * finding). That's part of why this stays an unadopted experiment
 * rather than a spec proposal -- see the competing negative-map-key
 * prototype (CORE_METADATA_KEYS below) for the alternative that avoids
 * adding a new prefix-item shape at all.
 */
function isExternalIdWrapper(item) {
  return Array.isArray(item) && item.length === 1 && typeof item[0] === 'string';
}

/**
 * EXPERIMENTAL -- a second, competing prototype for the same question
 * isExternalIdWrapper explores: whether QDEF could add a mandatory-core,
 * type-independent external-reference identifier (an NDEF-ID equivalent).
 * Where isExternalIdWrapper puts it in a *prefix item* (visible before
 * Phase 2 even starts), this puts it in a *reserved negative map key* --
 * CBOR permits negative-integer map keys generally, and QDEF's own spec
 * never restricts map keys to non-negative uints (only the *typeID
 * prefix item's value* excludes negint, a separate axis, see §3.1/§3.2).
 *
 * The reason this is worth comparing at all: it reuses the existing
 * even/odd criticality machinery for free. Parity is well-defined on
 * negative numbers (-1 is odd, -2 is even) and JS's `%` preserves sign,
 * so `key % 2 === 0` keeps working unmodified. No new mandatory-core
 * *shape* needs recognizing in Phase 1 -- the map was already opaque to
 * it. The cost: a reserved negative key isn't visible until the map is
 * actually parsed, one phase later than a prefix item.
 *
 * Reserved core keys live in CORE_METADATA_KEYS. Critically, an
 * *unrecognized* negative key is still even/odd-checked -- but at the
 * mandatory-core level, applied identically to every Record regardless
 * of its Type, never deferred to that Type's own applyCriticality call
 * (contrast with an ordinary Type-owned map key, whose criticality is
 * entirely up to that Type's author). No Record Type can ever redefine
 * or collide with a negative key's meaning, because the *core* claims
 * that whole namespace, not any individual Type.
 */
const CORE_METADATA_KEYS = new Map([
  [-1, 'externalId'], // NDEF-ID equivalent, prototyped for comparison only
]);

/**
 * EXPERIMENTAL -- see CORE_METADATA_KEYS above. Walks a Record's already-
 * parsed field map for negative-integer keys, resolving the ones this
 * prototype recognizes and applying the even/odd rule (at the mandatory-
 * core level) to the ones it doesn't. Does not mutate or strip entries
 * from the caller's map -- Type-level code still sees every key exactly
 * as before; this only *additionally* surfaces what the core layer would
 * claim from the same map.
 */
function extractCoreMetadata(map) {
  const core = {};
  if (!map) return { core, aborted: false };
  const entries =
    map instanceof Map
      ? map.entries()
      : Object.entries(map).map(([k, v]) => [Number(k), v]);
  for (const [key, value] of entries) {
    if (typeof key !== 'number' || key >= 0) continue;
    const name = CORE_METADATA_KEYS.get(key);
    if (name !== undefined) {
      core[name] = value;
      continue;
    }
    if (key % 2 === 0) {
      return {
        core,
        aborted: true,
        abortReason: `unrecognized critical core key ${key}`,
      };
    }
    // odd, unrecognized: silently ignored, same forward-compat rule as
    // every other odd key -- just enforced by the core instead of a Type.
  }
  return { core, aborted: false };
}

/**
 * Check whether a decoded CBOR item is a map. The `cbor` library
 * decodes empty CBOR maps as plain `{}` objects, not `Map` instances,
 * so we must handle both cases.
 */
function isMapItem(item) {
  if (item instanceof Map) return true;
  return (
    item !== null &&
    typeof item === 'object' &&
    !Buffer.isBuffer(item) &&
    !(item instanceof ArrayBuffer) &&
    !Array.isArray(item) &&
    Object.getPrototypeOf(item) === Object.prototype
  );
}

/**
 * Apply the even/odd criticality rule (§3.2) for a specific Record Type's
 * known key set. Returns the same record annotated with aborted/ignoredKeys.
 */
function applyCriticality(record, knownKeys) {
  if (record.ignored || !record.map) return record;
  const map = record.map;
  const keys = map instanceof Map ? map.keys() : Object.keys(map).map(Number);
  const ignoredKeys = [];
  for (const key of keys) {
    if (knownKeys.has(key)) continue;
    if (key % 2 === 0) {
      return {
        ...record,
        aborted: true,
        abortReason: `unrecognized critical (even) key ${key}`,
      };
    }
    ignoredKeys.push(key);
  }
  return { ...record, aborted: false, ignoredKeys };
}

/**
 * Decode a single Record from raw bytes — used for inner Records a
 * Wrapper Record (§4.1) unwraps, which are just "the encoded bytes
 * of another Record", not a fresh top-level QDEF container.
 */
function decodeRecordBytes(buf) {
  const items = cbor.decodeAllSync(buf);
  const records = parseRecords(items);
  return (
    records[0] || { typeIds: [], typeId: null, map: null, ignored: true }
  );
}

module.exports = {
  MAGIC,
  encodeContainer,
  encodeRecordBytes,
  decodeContainer,
  decodeSequence,
  decodeRecordBytes,
  applyCriticality,
};
