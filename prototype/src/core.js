'use strict';
// QDEF core: magic framing, typeID-prefix routing, even/odd unknown-key
// criticality. Deliberately has no knowledge of any specific Record
// Type, compression, or reassembly (see docs/QDEF-SPEC.md §3.3).
//
// There is exactly one grammar, applied identically everywhere -- the
// container root, an NDEF/own-URI-scheme body, a Wrapper Record's
// unwrapped inner bytes, and every subrecord all parse the same way,
// the only difference being what bounds the item list (end-of-buffer
// for the first three, an explicit array for the last). No separate
// "container discriminator" concept exists (see docs/DESIGN.md and
// docs/FINDINGS.md for why: it collapsed into this same grammar once
// typeId became optional):
//   [namespace?, typeId?, map?, payload?, subrecord*]
// - namespace (optional): a byte string. Recognized whenever the
//   current position holds one, unconditionally -- there is no
//   requirement that a valid typeId immediately follow it (dropped
//   deliberately; see docs/DESIGN.md). Scopes this Record's own
//   typeId, overriding any inherited ambient namespace for this one
//   Record (and, by cascade, its own subrecords) only.
// - typeId (optional): a bare uint. Defaults to 0 (Bundle) when no
//   uint is found at this position -- a forgiving-parser choice, not
//   an error case: an encoder that meant to write a real typeId and
//   didn't is the encoder's own responsibility to catch, not the
//   decoder's to reject (see docs/DESIGN.md). No other typeId shape is
//   legal, and there is no backup-typeId accumulation.
// - map? (optional): the field Map, omitted when empty — default {}.
// - payload? (optional): any well-formed CBOR item EXCEPT an array (same
//   shape rule as an ordinary field value, §3.2, minus major type 4),
//   carrying this Record's opaque content (for Wrapper Records) or
//   direct application payload (e.g. Media Payload's content or a
//   simple text record). Arrays are excluded specifically so a bare
//   array right after the map/typeId is always unambiguously the start
//   of subrecords, never a payload -- no marker needed to tell the two
//   apart (see docs/DESIGN.md). A map-shaped payload requires the field
//   Map to also be explicitly present (even empty), since major type 5
//   right after typeId is otherwise always the field Map, never the
//   payload.
// - subrecord* (zero or more): every remaining item after the payload
//   (or after the map if no payload is present) is itself a nested
//   Record, recursively the same shape, always array-wrapped -- a
//   subrecord's own boundary must be self-delimited since it sits
//   inside a larger item list, unlike the outermost list itself.
//
// No version byte: local forward compatibility is §3.2's even/odd rule.
//
// Field values carry no shape restriction: any well-formed CBOR item is
// legal (§3.2 -- the earlier flat-scalar-or-string-only rule was
// dropped; see docs/FINDINGS.md).

const cbor = require('cbor');

const MAGIC = Buffer.from([0x51, 0x44, 0x45, 0x46]); // "QDEF"

/**
 * Encode a QDEF container: magic followed by the root Record's own
 * items, each encoded as a separate CBOR item and concatenated (a
 * Sequence) -- not wrapped in an outer array. The root is otherwise an
 * ordinary Record: it MAY carry a real typeId of its own (a single
 * primary Record, e.g. a Media Payload, needs no Bundle indirection at
 * all -- see docs/DESIGN.md), or omit typeId to default to Bundle (0)
 * when the container holds several co-equal top-level Records, which
 * then live in `subrecords`.
 *
 * @param {Object} rootRecord - same shape as encodeRecordBytes's
 *   argument (typeId now optional).
 */
function encodeContainer(rootRecord) {
  const items = recordToItems(rootRecord);
  const parts = items.map((item) => cbor.encodeCanonical(item));
  return Buffer.concat([MAGIC, ...parts]);
}

/**
 * Build the raw (unencoded) JS array representing a single Record's own
 * elements, in order: [namespace?, typeId?, map?, payload?, ...subrecords]
 * -- subrecords themselves built by recursing into this same function,
 * so they nest as CBOR arrays automatically once handed to
 * cbor.encodeCanonical. There is no separate grammar for "a Record when
 * it's nested" or "a Record at the container root": this one shape,
 * reused everywhere.
 *
 * @param {Object} record
 * @param {number|bigint} [record.typeId] - omitted entirely means "no
 *   typeId item on the wire," relying on the decoder's default (0,
 *   Bundle). Pass 0 explicitly instead of omitting it when a bstr
 *   payload with no namespace needs to be disambiguated from a leading
 *   namespace bstr (see docs/DESIGN.md).
 * @param {Map<number, any>} [record.fields] - omitted when empty (saves
 *   one byte per record with no fields).
 * @param {*} [record.payload] - any well-formed CBOR value EXCEPT a bare
 *   array, carrying this Record's opaque content (for Wrapper Records)
 *   or direct payload (e.g. Media Payload's content, simple text). To
 *   nest another Record, use `subrecords` -- payload can never be
 *   array-shaped (see docs/DESIGN.md for why).
 * @param {Buffer} [record.localNamespace] - if given, this Record's
 *   own namespace, overriding any inherited ambient one for this
 *   Record (and, per header.js's cascading resolution, for its own
 *   subrecords too unless they declare their own override).
 * @param {Array<Object>} [record.subrecords] - if given, each element
 *   is itself a record object of this same shape, appended as further
 *   elements after the payload.
 */
function recordToItems({ typeId, fields, payload, localNamespace, subrecords }) {
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
  if (typeId !== undefined) items.push(typeId);

  const hasFields = fields !== undefined && fields.size > 0;
  const payloadIsMapShaped = payload !== undefined && isMapItem(payload);

  if (hasFields) {
    items.push(fields);
  } else if (payloadIsMapShaped) {
    // A map-shaped payload needs the field Map explicitly present (even
    // empty) -- major type 5 right after typeId is otherwise always the
    // field Map, never the payload. See docs/DESIGN.md.
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
 * Encode a single Record as one self-delimited CBOR array -- used for a
 * subrecord, or for the bytes a Wrapper Record's payload carries before
 * it's unwrapped.
 */
function encodeRecordBytes(record) {
  return cbor.encodeCanonical(recordToItems(record));
}

/**
 * Decode a QDEF container: verify magic, then parse everything after it
 * as one Record, end-of-buffer-bounded (see parseRecordFromItems). No
 * discriminator to skip or interpret -- the root's own namespace/map
 * fields (if any) carry exactly the job a separate discriminator item
 * used to.
 */
function decodeContainer(buf) {
  if (buf.length < 4) throw new Error('QDEF container too short for magic');
  const magic = buf.subarray(0, 4);
  if (!magic.equals(MAGIC)) {
    throw new Error(`bad magic: ${magic.toString('hex')}`);
  }
  const items = cbor.decodeAllSync(buf.subarray(4));
  return parseRecordFromItems(items);
}

/**
 * Decode a bare CBOR Sequence with no magic prefix -- the NDEF/own-URI-
 * scheme path (§2), where the carrier (an NDEF MIME type, or an app's
 * own scheme prefix) already identifies the format and already isolates
 * this content from every other QDEF-aware decoder. Structurally
 * identical to decodeContainer past the magic check: one Record,
 * end-of-buffer-bounded.
 */
function decodeSequence(seq) {
  const items = cbor.decodeAllSync(seq);
  return parseRecordFromItems(items);
}

/**
 * Parse a list of already-decoded CBOR items into subrecords: each item
 * that is itself a CBOR array is one Record, parsed by
 * parseRecordFromItems below (an array's own elements are exactly such
 * a list); anything else (a stray non-array item) isn't a Record and is
 * silently skipped (forward-compat tolerance, the same principle
 * Phase 2 already applies inside a single Record).
 */
function parseRecordList(items) {
  const records = [];
  for (const item of items) {
    if (Array.isArray(item)) records.push(parseRecordFromItems(item));
  }
  return records;
}

/**
 * Parse a single Record from an already-decoded, flat list of CBOR
 * items -- either a subrecord's own array elements, or an entire
 * end-of-buffer-bounded body (the container root, an NDEF/own-URI
 * body, or a Wrapper Record's unwrapped inner bytes). No structural
 * difference between these contexts: this one function serves all of
 * them.
 *
 *   [namespace?, typeId?, map?, payload?, subrecord*]
 *
 * - namespace: recognized whenever the current item is a byte string,
 *   unconditionally -- no longer requires a following valid typeId
 *   (dropped; see docs/DESIGN.md). A namespace-shaped payload with no
 *   real namespace intended needs an explicit typeId (even `0`) ahead
 *   of it to avoid being read as one.
 * - typeId: a bare uint (major type 0) if present at this position;
 *   absent, defaults to 0 (Bundle). No other shape is recognized as a
 *   typeId.
 * - map? (optional): the item immediately after typeId, if map-shaped;
 *   normalized to a Map instance. Major type 5 in this position is
 *   unconditionally the field Map, never padding, never payload -- if
 *   no map is found there, defaults to null (empty).
 * - payload? (optional): the item immediately after the map (or after
 *   typeId if no map), if present and not array-shaped, is this
 *   Record's payload -- any other CBOR shape is fair game. An
 *   array-shaped item in this position is never payload; it's always
 *   subrecord 0, unconditionally, with no marker needed to tell the two
 *   apart (see docs/DESIGN.md).
 * - subrecord*: every remaining item after payload is a nested Record.
 */
function parseRecordFromItems(arr) {
  let i = 0;
  let typeId;
  let localNamespace;

  if (Buffer.isBuffer(arr[0])) {
    localNamespace = arr[0];
    i = 1;
  }

  if (i < arr.length && isTypeId(arr[i])) {
    typeId = arr[i];
    i++;
  } else {
    typeId = 0;
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
  if (i < arr.length && !Array.isArray(arr[i])) {
    payload = arr[i];
    i++;
  }

  const subrecords = i < arr.length ? parseRecordList(arr.slice(i)) : undefined;

  return {
    typeId,
    localNamespace,
    subrecords,
    map,
    payload,
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
  if (!record.map) return { ...record, aborted: false, ignoredKeys: [] };
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
 * Wrapper Record (§4.1) unwraps: just "the encoded bytes of another
 * Record," always one self-delimited CBOR array (the same shape
 * encodeRecordBytes always produces, since these bytes are re-parsed
 * exactly like an ordinary subrecord would be, not a fresh top-level
 * QDEF container). Not the same bounding rule the container root uses:
 * a byte-string payload slot already carries its own explicit length,
 * so there's no EOF to bound against here, only "one array, then done."
 */
function decodeRecordBytes(buf) {
  const items = cbor.decodeAllSync(buf);
  const [first] = items;
  if (Array.isArray(first)) return parseRecordFromItems(first);
  return parseRecordFromItems([]);
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
