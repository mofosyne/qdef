'use strict';
// QDEF core: magic framing, typeID-prefix routing, even/odd unknown-key
// criticality. Deliberately has no knowledge of any specific Record
// Type, compression, or reassembly (see docs/QDEF-SPEC.md §3.3).
//
// There is exactly one grammar, applied identically everywhere -- the
// container root, an NDEF/own-URI-scheme body, a Wrapper Record's
// unwrapped inner bytes, and every subrecord are all the same one
// self-delimited CBOR array (see docs/DESIGN.md's "Self-delimited root"
// entry). No separate "container discriminator" concept exists (see
// docs/DESIGN.md and docs/FINDINGS.md for why: it collapsed into this
// same grammar once typeId became optional):
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
 * Encode a QDEF container: magic followed by the root Record, encoded
 * as one self-delimited CBOR array -- the exact same shape
 * encodeRecordBytes produces for any other Record (a subrecord, a
 * Wrapper's inner content). Self-delimiting the root this way means any
 * bytes appended after the container are unambiguously outside it, by
 * construction -- no end-of-buffer guesswork, no marker needed (see
 * docs/DESIGN.md's "Self-delimited root"). The root is otherwise an
 * ordinary Record: it MAY carry a real typeId of its own (a single
 * primary Record, e.g. a Media Payload, needs no Bundle indirection at
 * all -- see docs/DESIGN.md), or pass `typeId: 0` explicitly for Bundle
 * when the container holds several co-equal top-level Records, which
 * then live in `subrecords`.
 *
 * @param {Object} rootRecord - same shape as encodeRecordBytes's
 *   argument (typeId is a required argument on this encoder API, even
 *   though it's optional on the wire -- see recordToItems).
 */
function encodeContainer(rootRecord) {
  return Buffer.concat([MAGIC, encodeRecordBytes(rootRecord)]);
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
 * @param {number|bigint} record.typeId - REQUIRED on this encoder API,
 *   even though the wire grammar itself makes typeId optional (§3.1):
 *   the decoder stays forgiving of any encoder's output that omits it
 *   (defaults to 0, Bundle), but this reference encoder refuses to
 *   produce that omission silently, since omission-vs-intent is exactly
 *   the one ambiguity (a bstr payload with no namespace intended,
 *   misread as a leading namespace bstr) that can only be resolved at
 *   the point of encoding, never decoded back out of the bytes after
 *   the fact -- see docs/DESIGN.md's "Encoder-enforced explicit typeId"
 *   and prototype/scripts/qdef-lint.js's own footgun-check writeup for
 *   why a post-hoc check can't catch this. Pass `0` explicitly for a
 *   Bundle -- still omitted from the actual wire bytes, since `0` is
 *   indistinguishable from absent to any decoder.
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
  if (typeId === undefined) {
    throw new Error(
      'typeId is required on this encoder API -- pass 0 explicitly for a Bundle rather than omitting it, ' +
        'so an accidental omission fails loudly instead of silently producing ambiguous bytes (see docs/DESIGN.md)',
    );
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
  // typeId 0 (Bundle) is still omitted from the actual wire bytes when
  // possible -- indistinguishable from absent to any decoder either way
  // (§3.1). The check above is call-time-only, catching an omitted
  // *argument*, not an omitted *wire item*; this is not a wire-format
  // change. Loose equality deliberately: typeId may be a BigInt for the
  // 0x10000+ tier (§9), and `0n` must still compare equal to `0`.
  if (typeId != 0) items.push(typeId);

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
 * Decode a QDEF container: verify magic, then decode everything after it
 * as one self-delimited Record array (see decodeRecordBytes). No
 * discriminator to skip or interpret -- the root's own namespace/map
 * fields (if any) carry exactly the job a separate discriminator item
 * used to. Bytes after the root array (if any) are never touched --
 * they are provably outside the container, not guessed at from where
 * the buffer happens to end.
 */
function decodeContainer(buf) {
  if (buf.length < 4) throw new Error('QDEF container too short for magic');
  const magic = buf.subarray(0, 4);
  if (!magic.equals(MAGIC)) {
    throw new Error(`bad magic: ${magic.toString('hex')}`);
  }
  return decodeRecordBytes(buf.subarray(4));
}

/**
 * Decode a bare, self-delimited Record array with no magic prefix --
 * the NDEF/own-URI-scheme path (§2), where the carrier (an NDEF MIME
 * type, or an app's own scheme prefix) already identifies the format
 * and already isolates this content from every other QDEF-aware
 * decoder. Structurally identical to decodeContainer past the magic
 * check, and to decodeRecordBytes -- kept as a separate named export
 * for call-site clarity (this one path's caller-visible meaning is "the
 * whole NDEF/own-URI body," not "one Wrapper's unwrapped inner Record"),
 * not because the grammar differs.
 */
function decodeSequence(seq) {
  return decodeRecordBytes(seq);
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
 * items -- a Record's own array elements, whether that array is a
 * subrecord, the container root, an NDEF/own-URI body, or a Wrapper
 * Record's unwrapped inner bytes. No structural difference between
 * these contexts: this one function serves all of them.
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
 * Decode a single self-delimited Record array from raw bytes -- the one
 * shared implementation behind decodeContainer (past the magic check)
 * and decodeSequence, and also used directly for inner Records a
 * Wrapper Record (§4.1) unwraps. Reads exactly the first CBOR item off
 * `buf` and requires it to be an array (the same shape encodeRecordBytes
 * always produces); any bytes after that first item are never touched
 * -- they are provably outside this Record, not guessed at from where
 * `buf` happens to end (see docs/DESIGN.md's "Self-delimited root").
 */
function decodeRecordBytes(buf) {
  // extendedResults: true so trailing bytes of any shape -- valid CBOR
  // or not -- are simply left unread rather than triggering a decode
  // error or being (mis)interpreted as more items. That tolerance is
  // the entire point of self-delimiting the root: what follows the
  // array is provably none of this decoder's business.
  const { value } = cbor.decodeFirstSync(buf, { extendedResults: true });
  if (Array.isArray(value)) return parseRecordFromItems(value);
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
