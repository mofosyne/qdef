'use strict';
// QDEF core: magic framing, a mandatory container discriminator,
// CBOR-Sequence-of-Records, typeID-prefix routing, even/odd unknown-key
// criticality. Deliberately has no knowledge of any specific Record
// Type, compression, or reassembly (see docs/QDEF-SPEC.md §3.3).
//
// Every Record is a sequence of CBOR items terminating in a CBOR Map:
// exactly one typeID-bearing item -- a bare uint, OR a namespace-pairing
// array ([namespace, typeId], a Record declaring/overriding its own
// namespace inline, independent of the container's ambient one, see
// isNamespacePairing below) -- optionally followed by exactly one bare
// text string (an NDEF-ID-equivalent external reference, §3.1),
// optionally followed by exactly one array of embedded Records (§3.1's
// `ID[]{}` shape -- see isEmbeddedRecordsItem below), followed by zero or
// more unknown items (forward-compat padding), then the field Map as the
// record delimiter -- always present, even when empty, so a record's
// terminator is unconditionally a map regardless of whether an embedded-
// Records array preceded it. There is no backup-typeID accumulation: at
// most one typeID-bearing item per Record (see docs/FINDINGS.md for why
// decentralized Type IDs and backup typeIDs were both dropped).
//
// No version byte: local forward compatibility is §3.2's even/odd rule.
// Container-level metadata (a format namespace) lives in a single
// mandatory discriminator item, always the first CBOR item after magic
// -- not an ordinary Record the way it used to be. Making it
// unconditionally present resolves a real ambiguity a bare, unwrapped
// namespace value would otherwise have (indistinguishable from the next
// real Record's own typeID) without needing a CBOR-tag marker (see
// docs/DESIGN.md#cbor-tag-routing--removed for why that route is already
// closed). See header.js for the shapes it can take and what each one
// means; core.js only needs to know how to split it off the front,
// never how to interpret it.
//
// Field values carry no shape restriction: any well-formed CBOR item is
// legal (§3.2 -- the earlier flat-scalar-or-string-only rule was
// dropped; see docs/FINDINGS.md). core.js never needs to walk into a
// field value's structure regardless -- it only ever needs to find
// where one ends, which is a property of well-formed CBOR generally,
// not of this shape restriction specifically.

const cbor = require('cbor');

const MAGIC = Buffer.from([0x51, 0x44, 0x45, 0x46]); // "QDEF"

/**
 * Encode a QDEF container from a list of records, prefixed by magic and
 * the mandatory discriminator item.
 *
 * @param {Array<{typeId: number|bigint, fields: Map<number, any>}>} records
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
 * Build the flat list of raw (unencoded) CBOR items representing a single
 * Record's own prefix items and payload, in order: typeId (or
 * namespace-pairing array), NDEF-ID (if any), the embedded-Records array
 * (if any, §3.1's `ID[]{}` shape), then the field Map -- always present,
 * even when empty (never omitted just because an embedded-Records array
 * came before it; see docs/DESIGN.md for why the map stays unconditional).
 *
 * Shared by encodeRecordBytes (top level -- each item gets individually
 * CBOR-encoded and the bytes concatenated) and embedded-Records encoding
 * (a whole record's items get flattened into its parent's own
 * embedded-Records array, one level deeper, encoded together as a single
 * CBOR array item) -- the same grammar either way, just nested or not.
 *
 * @param {Object} record
 * @param {number|bigint} record.typeId
 * @param {Map<number, any>} [record.fields]
 * @param {Buffer} [record.localNamespace] - if given, wraps the typeID
 *   in a namespace-pairing prefix item ([localNamespace, typeId])
 *   instead of encoding it bare. See isNamespacePairing below.
 * @param {string} [record.ndefId] - if given, adds a bare text string
 *   immediately after the typeID item: an NDEF-ID-equivalent external
 *   reference (§3.1), structurally separate from and independent of the
 *   typeID's own routing role. Reuses the text-string prefix-item slot
 *   that used to be reserved for a future "Named ID" typeID form and
 *   for Type Hint verification strings -- both retired alongside
 *   decentralized Type IDs, freeing the slot for this single meaning.
 * @param {Array<Object>} [record.embeddedRecords] - if given, each
 *   element is itself a record object of this same shape, flattened into
 *   one CBOR array positioned right before the field Map.
 */
function recordToItems({ typeId, fields, localNamespace, ndefId, embeddedRecords }) {
  if (typeId === undefined) {
    throw new Error('typeId is required');
  }
  const items = [];
  items.push(localNamespace !== undefined ? [localNamespace, typeId] : typeId);
  if (ndefId !== undefined) items.push(ndefId);
  if (embeddedRecords !== undefined) {
    items.push(embeddedRecords.flatMap(recordToItems));
  }
  items.push(fields || new Map());
  return items;
}

/**
 * Encode a single top-level Record as CBOR bytes. There is exactly one
 * typeID per Record -- no backup typeIDs (see docs/FINDINGS.md for why
 * that mechanism was dropped).
 */
function encodeRecordBytes(record) {
  const items = recordToItems(record);
  return Buffer.concat(items.map((item) => cbor.encodeCanonical(item)));
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
 * Per Record:
 *   Phase 1: recognize exactly one typeID-bearing item -- a bare uint,
 *            or a namespace-pairing array -- optionally followed by
 *            exactly one bare text string (the NDEF-ID-equivalent),
 *            optionally followed by exactly one array of embedded
 *            Records (§3.1's `ID[]{}` shape)
 *   Phase 2: skip non-map items until the map delimiter
 *
 * If no typeID is found before the map, the Record is ignored. If the
 * sequence ends without a map, the incomplete Record is returned with
 * map: null.
 *
 * This same function is called recursively on an embedded-Records
 * array's own contents -- there is no separate grammar for "a Record
 * when it's nested," only this one, reused. A definite-length CBOR
 * array's payload is byte-for-byte identical in shape to a CBOR
 * Sequence of the same items, so nothing but the input source (an
 * already-decoded array of items either way) differs.
 */
function parseRecords(items) {
  const records = [];
  let i = 0;

  while (i < items.length) {
    // Phase 1: recognize this Record's single typeID-bearing item, then
    // its optional NDEF-ID text string, then its optional embedded-
    // Records array.
    let typeId;
    let localNamespace; // raw, uninterpreted — from this Record's own
    // pairing item, if any. Same "core exposes it raw, never interprets
    // it" treatment as the container discriminator.
    let ndefId; // raw, uninterpreted text string, if present.
    let embeddedRecords; // parsed recursively, if an array was present.

    if (isTypeId(items[i])) {
      typeId = items[i];
      i++;
    } else if (isNamespacePairing(items[i])) {
      const [ns, id] = items[i];
      typeId = id;
      localNamespace = ns;
      i++;
    }

    if (typeId !== undefined && i < items.length && typeof items[i] === 'string') {
      ndefId = items[i];
      i++;
    }

    // An array appearing here, after the typeID/NDEF-ID slot and before
    // the mandatory map, is always the embedded-Records array -- never
    // ambiguous with namespace-pairing (only recognized in the typeID
    // slot, above) or with the *next* Record starting (a bare typeID
    // with no map yet was already malformed before this shape existed,
    // so this claims previously-invalid byte patterns, not currently-
    // valid ones; see docs/DESIGN.md).
    if (typeId !== undefined && i < items.length && Array.isArray(items[i])) {
      embeddedRecords = parseRecords(items[i]);
      i++;
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

    records.push({
      typeId: typeId ?? null,
      localNamespace,
      ndefId,
      embeddedRecords,
      map,
      ignored: typeId === undefined,
    });
  }

  return records;
}

/**
 * Check if a decoded CBOR item is a valid typeID prefix item: an
 * unsigned integer (uint, major type 0) — the only valid typeID shape.
 * Byte string and text string Type IDs (decentralized/self-certifying
 * and "Named ID," respectively) were both retired; see docs/FINDINGS.md.
 */
function isTypeId(item) {
  if (typeof item === 'number' && Number.isInteger(item) && item >= 0) {
    return true;
  }
  if (typeof item === 'bigint' && item >= 0n) {
    return true;
  }
  return false;
}

/**
 * Check if a decoded CBOR item is a namespace-pairing prefix item: a
 * definite-length array of exactly 2 elements, [namespace, typeId],
 * where namespace is a byte string (the only valid Namespace ID shape —
 * same convention as the container discriminator's namespace value,
 * §3.5; there is no Allocated/uint namespace tier) and typeId is a uint
 * (even = Allocated/global, odd = Scoped to this specific namespace,
 * overriding any container-level ambient namespace for this one Record).
 *
 * Purely structural: this function does not interpret what a namespace
 * IS or how it affects lookup — it only recognizes the shape so Phase 1
 * can pull the nested typeId out for routing. Interpretation (whether
 * the paired namespace actually scopes this typeId, and resolving
 * "local override vs. container-ambient") is header.js's job. A uint in
 * the *namespace* slot is not recognized at all — this item simply
 * isn't a namespace-pairing item then, and falls through to being
 * treated as an ordinary unrecognized prefix item, same as any other
 * unrecognized 2-element array.
 */
function isNamespacePairing(item) {
  if (!Array.isArray(item) || item.length !== 2) return false;
  const [ns, id] = item;
  const nsValid = Buffer.isBuffer(ns);
  const idValid =
    (typeof id === 'number' && Number.isInteger(id) && id >= 0) ||
    (typeof id === 'bigint' && id >= 0n);
  return nsValid && idValid;
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
  return records[0] || { typeId: null, map: null, ignored: true };
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
