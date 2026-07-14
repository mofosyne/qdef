'use strict';
// QDEF core: magic framing, CBOR-Sequence-of-Records, typeID-prefix
// routing, even/odd unknown-key criticality. Deliberately has no
// knowledge of any specific Record Type, compression, or reassembly
// (see docs/QDEF-SPEC.md §3.3).
//
// Every Record is a sequence of CBOR items terminating in a CBOR Map:
// one or more typeID items (uint or byte string) followed by zero or
// more unknown items (forward-compat padding), then the field Map as
// the record delimiter. The parser accumulates typeIDs in a contiguous
// run at the start, skips unknown items, and stops at the first Map.
//
// No version byte: the container is just magic + a CBOR Sequence of
// Records, full stop. Container-level metadata (a format namespace)
// lives inside the Sequence itself, as a Record with the reserved Type
// ID 0 (see header.js) — reusing the same even/odd extensibility every
// other Record already has, rather than a second, parallel
// extensibility mechanism for the header alone.

const cbor = require('cbor');

const MAGIC = Buffer.from([0x51, 0x44, 0x45, 0x46]); // "QDEF"

/**
 * Encode a QDEF container from a list of records.
 * @param {Array<{typeIds: Array<number|bigint|Buffer>, fields: Map<number, any>}>} records
 */
function encodeContainer(records) {
  const parts = records.map(encodeRecordBytes);
  return Buffer.concat([MAGIC, ...parts]);
}

/**
 * Encode a single Record as CBOR bytes: [typeId1][typeId2]...[fieldMap].
 * typeIds is an array — the first element is the primary typeID, the
 * rest are backup typeIDs for transitional routing.
 */
function encodeRecordBytes({ typeIds, fields }) {
  if (!typeIds || typeIds.length === 0) {
    throw new Error('typeIds must be a non-empty array');
  }
  const mapBytes = cbor.encodeCanonical(fields || new Map());
  const typeItems = typeIds.map((id) => cbor.encodeCanonical(id));
  return Buffer.concat([...typeItems, mapBytes]);
}

/**
 * Decode a QDEF container down to raw routed records: no even/odd
 * criticality applied yet (that's per-Record-Type, see applyCriticality).
 */
function decodeContainer(buf) {
  if (buf.length < 4) throw new Error('QDEF container too short for magic');
  const magic = buf.subarray(0, 4);
  if (!magic.equals(MAGIC)) {
    throw new Error(`bad magic: ${magic.toString('hex')}`);
  }
  const seq = buf.subarray(4);
  return { records: decodeSequence(seq) };
}

/**
 * Decode a bare CBOR Sequence of Records with no magic prefix — the
 * NDEF path (§2), where the outer NDEF record's MIME type
 * (application/vnd.qdef) already identifies the format.
 */
function decodeSequence(seq) {
  const items = cbor.decodeAllSync(seq);
  return parseRecords(items);
}

/**
 * Parse an array of decoded CBOR items into Records.
 *
 * Two-phase loop per Record:
 *   Phase 1: accumulate typeIDs (contiguous run of uint/byte-string
 *            at the start — the routing mechanism)
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
    // Phase 1: accumulate typeIDs — contiguous run of uint/byte-string
    const typeIds = [];
    while (i < items.length && isTypeId(items[i])) {
      typeIds.push(items[i]);
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
      typeIds,
      typeId: typeIds[0] ?? null,
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
