'use strict';
// QDEF core: magic framing, a mandatory container discriminator,
// CBOR-Sequence-of-Records, typeID-prefix routing, even/odd unknown-key
// criticality. Deliberately has no knowledge of any specific Record
// Type, compression, or reassembly (see docs/QDEF-SPEC.md §3.3).
//
// Every Record is exactly one definite-length CBOR array, self-bounded
// by its own array header -- a decoder never needs Record-grammar
// knowledge to skip past a Record it doesn't care about, only to skip
// one generic CBOR array (see docs/DESIGN.md for why this replaced the
// earlier flat, unwrapped Record shape). Its elements, in order:
//   [namespace?, typeId, map?, payload?, subrecord*]
// - namespace (optional): a byte string, present only when the first
//   element is a byte string immediately followed by a valid typeId.
//   Scopes this Record's own typeId, overriding any container-level
//   ambient namespace for this one Record only (§3.5).
// - typeId (mandatory): a bare uint. There is no other legal typeId
//   shape and no backup-typeId accumulation -- at most one typeId per
//   Record (see docs/FINDINGS.md for why decentralized Type IDs, Named
//   Type IDs, and backup typeIDs were all retired).
// - map? (optional): the field Map, omitted when empty — default {}.
// - payload? (optional): any well-formed CBOR item EXCEPT an array (same
//   shape rule as an ordinary field value, §3.2, minus major type 4),
//   carrying this Record's opaque content (for Wrapper Records) or
//   direct application payload (e.g. Media Payload's content or a
//   simple text record). Arrays are excluded specifically so a bare
//   array right after the map/typeId is always unambiguously the start
//   of subrecords, never a payload -- no marker needed to tell the two
//   apart (see docs/DESIGN.md; array-shaped payload was tried and
//   reverted after real adopter feedback showed it had no use nothing
//   else already provided). A map-shaped payload requires the field Map
//   to also be explicitly present (even empty), since major type 5
//   right after typeId is otherwise always the field Map, never the
//   payload.
// - subrecord* (zero or more): every remaining array element after the
//   payload (or after the map if no payload is present) is itself a
//   nested Record, recursively the same shape.
//
// No version byte: local forward compatibility is §3.2's even/odd rule.
// Container-level metadata (a format namespace) lives in a single
// mandatory discriminator item, always the first CBOR item after magic
// -- not an ordinary Record. See header.js for the shapes it can take
// and what each one means; core.js only needs to know how to split it
// off the front, never how to interpret it.
//
// Field values carry no shape restriction: any well-formed CBOR item is
// legal (§3.2 -- the earlier flat-scalar-or-string-only rule was
// dropped; see docs/FINDINGS.md).

const cbor = require('cbor');

const MAGIC = Buffer.from([0x51, 0x44, 0x45, 0x46]); // "QDEF"

/**
 * Encode a QDEF container from a list of records, prefixed by magic and
 * the mandatory discriminator item.
 *
 * @param {Array<Object>} records
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
 * Build the raw (unencoded) JS array representing a single Record's own
 * elements, in order: [namespace?, typeId, map?, payload?, ...subrecords]
 * -- subrecords themselves built by recursing into this same function,
 * so they nest as CBOR arrays automatically once handed to
 * cbor.encodeCanonical. There is no separate grammar for "a Record when
 * it's nested": the top level and every subrecord slot use exactly this
 * one shape.
 *
 * @param {Object} record
 * @param {number|bigint} record.typeId
 * @param {Map<number, any>} [record.fields] - omitted when empty (saves
 *   one byte per record with no fields).
 * @param {*} [record.payload] - any well-formed CBOR value EXCEPT a bare
 *   array, carrying this Record's opaque content (for Wrapper Records)
 *   or direct payload (e.g. Media Payload's content, simple text). To
 *   nest another Record, use `subrecords` -- payload can never be
 *   array-shaped (see docs/DESIGN.md for why).
 * @param {Buffer} [record.localNamespace] - if given, this Record's
 *   own namespace, overriding any container-ambient one for this
 *   Record (and, per header.js's cascading resolution, for its own
 *   subrecords too unless they declare their own override).
 * @param {Array<Object>} [record.subrecords] - if given, each element
 *   is itself a record object of this same shape, appended as further
 *   elements of this Record's own array, after the payload.
 */
function recordToItems({ typeId, fields, payload, localNamespace, subrecords }) {
  if (typeId === undefined) {
    throw new Error('typeId is required');
  }
  if (Array.isArray(payload)) {
    throw new Error('payload cannot be array-shaped -- use subrecords to nest a Record instead');
  }
  if (isRecordSpec(payload)) {
    throw new Error(
      'payload cannot be a record spec ({typeId, fields, ...}) -- use subrecords to nest a Record instead',
    );
  }
  const items = [];
  if (localNamespace !== undefined) items.push(localNamespace);
  items.push(typeId);

  const hasFields = fields !== undefined && fields.size > 0;
  const payloadIsMapShaped = payload !== undefined && isMapItem(payload);

  if (hasFields) {
    items.push(fields);
  } else if (payloadIsMapShaped) {
    // A map-shaped payload needs the field Map explicitly present (even
    // empty) -- major type 5 right after typeId (or namespace/typeId) is
    // otherwise always the field Map, never the payload. See DESIGN.md.
    items.push(new Map());
  }

  if (payload !== undefined) items.push(payload);

  if (subrecords !== undefined) {
    for (const sub of subrecords) items.push(recordToItems(sub));
  }
  return items;
}

/**
 * Detects a leftover record-spec object ({typeId, fields, ...}) passed
 * as payload -- a migration trap from when payload could recursively
 * encode a nested Record. cbor.encodeCanonical would otherwise happily
 * encode such an object as a literal CBOR map with string keys like
 * "typeId", silently producing garbage instead of an error.
 */
function isRecordSpec(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Buffer.isBuffer(value) &&
    !(value instanceof Map) &&
    !Array.isArray(value) &&
    typeof value.typeId !== 'undefined'
  );
}

/**
 * Encode a single Record as one self-delimited CBOR array.
 */
function encodeRecordBytes(record) {
  return cbor.encodeCanonical(recordToItems(record));
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
  return { discriminator, records: parseRecordList(rest) };
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
  return parseRecordList(items);
}

/**
 * Parse a list of already-decoded CBOR items into Records: each item
 * that is itself a CBOR array is one Record, parsed by parseRecordArray
 * below; anything else (a stray non-array top-level item) isn't a
 * Record and is silently skipped (forward-compat tolerance, the same
 * principle Phase 2 already applies inside a single Record).
 *
 * This one function serves both the top-level Sequence (called on
 * cbor.decodeAllSync's output) and any Record's own trailing subrecord
 * elements (called on the slice of its array after the field Map) --
 * there is no structural difference between the two contexts anymore.
 */
function parseRecordList(items) {
  const records = [];
  for (const item of items) {
    if (Array.isArray(item)) records.push(parseRecordArray(item));
  }
  return records;
}

/**
 * Parse a single Record from its own already-decoded CBOR array:
 *   [namespace?, typeId, map?, payload?, subrecord*]
 *
 * - namespace: recognized only when the first element is a byte string
 *   AND the element immediately after it is a valid typeId -- otherwise
 *   this Record has no typeId at all (ignored), the same "malformed
 *   prefix means unroutable, not a crash" tolerance as before.
 * - typeId: a bare uint (major type 0). No other shape is recognized.
 * - map? (optional): the element immediately after typeId, if
 *   map-shaped; normalized to a Map instance. Major type 5 in this
 *   position is unconditionally the field Map, never padding, never
 *   payload -- if no map is found there, defaults to null (empty).
 * - payload? (optional): the item immediately after the map (or after
 *   typeId if no map), if present and not array-shaped, is this
 *   Record's payload -- any other CBOR shape is fair game. An
 *   array-shaped item in this position is never payload; it's always
 *   subrecord 0, unconditionally, with no marker needed to tell the two
 *   apart (see docs/DESIGN.md).
 * - subrecord*: every remaining array element after payload is a nested
 *   Record.
 */
function parseRecordArray(arr) {
  let i = 0;
  let typeId;
  let localNamespace;

  if (Buffer.isBuffer(arr[0]) && isTypeId(arr[1])) {
    localNamespace = arr[0];
    typeId = arr[1];
    i = 2;
  } else if (isTypeId(arr[0])) {
    typeId = arr[0];
    i = 1;
  }

  let map = null;
  if (i < arr.length && isMapItem(arr[i])) {
    // Normalize: the cbor library decodes empty maps as plain {}, but
    // downstream code expects Map instances with .get()/.set().
    map =
      arr[i] instanceof Map ? arr[i] : new Map(Object.entries(arr[i]).map(([k, v]) => [Number(k), v]));
    i++;
  }

  let payload = undefined;
  if (typeId !== undefined && i < arr.length && !Array.isArray(arr[i])) {
    payload = arr[i];
    i++;
  }

  const subrecords = i < arr.length ? parseRecordList(arr.slice(i)) : undefined;

  return {
    typeId: typeId ?? null,
    localNamespace,
    subrecords,
    map,
    payload,
    ignored: typeId === undefined,
  };
}

/**
 * Check if a decoded CBOR item is a valid typeID: an unsigned integer
 * (uint, major type 0) — the only valid typeID shape. Byte string and
 * text string Type IDs (decentralized/self-certifying and "Named ID,"
 * respectively) were both retired; see docs/FINDINGS.md.
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
  if (record.ignored || !record.map) return { ...record, aborted: false, ignoredKeys: [] };
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
 * Wrapper Record (§4.1) unwraps, which are just "the encoded bytes of
 * another Record" (now: the encoded bytes of that Record's own CBOR
 * array), not a fresh top-level QDEF container.
 */
function decodeRecordBytes(buf) {
  const items = cbor.decodeAllSync(buf);
  const [first] = items;
  if (Array.isArray(first)) return parseRecordArray(first);
  return { typeId: null, localNamespace: undefined, subrecords: undefined, map: null, payload: undefined, ignored: true };
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
