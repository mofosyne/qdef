'use strict';
// QDEF core: magic framing, namespace/typeId routing, even/odd unknown-key
// criticality. Deliberately has no knowledge of any specific Record Type.
//
// Grammar (same for root, subrecord, and Wrapper inner bytes):
//   [namespace?, ns_annotation?, typeId*, type_annotation?, map?, subrecord*]
//
// - namespace (optional): bstr at position 0. Empty = inherit parent's.
// - ns_annotation (optional): tstr immediately after namespace.
// - typeId*: consecutive uints after namespace/ns_annotation.
//   First uint = 0 means standard QDEF type. Absent = Bundle.
// - type_annotation (optional): tstr immediately after last typeId uint.
// - map? (optional): first non-bstr, non-uint, non-tstr item if a map.
//   Key 0 = payload. Keys > 0 have even/odd criticality.
// - subrecord*: remaining items are nested Records.
//
// A tstr at position 0 with no preceding bstr or uints is malformed.

const cbor = require('cbor');

const MAGIC = Buffer.from([0x51, 0x44, 0x45, 0x46]); // "QDEF"

function encodeContainer(rootRecord) {
  return Buffer.concat([MAGIC, encodeRecordBytes(rootRecord)]);
}

function recordToItems({ typeId, fields, localNamespace, nsAnnotation, typeAnnotation, subrecords }) {
  const items = [];

  if (localNamespace !== undefined) items.push(localNamespace);
  if (nsAnnotation !== undefined) items.push(nsAnnotation);

  if (typeId !== undefined) {
    const ids = Array.isArray(typeId) ? typeId : [typeId];
    for (const id of ids) items.push(id);
  }
  if (typeAnnotation !== undefined) items.push(typeAnnotation);

  if (fields !== undefined && fields.size > 0) {
    items.push(fields);
  }

  if (subrecords !== undefined) {
    for (const sub of subrecords) items.push(recordToItems(sub));
  }
  return items;
}

function encodeRecordBytes(record) {
  return cbor.encodeCanonical(recordToItems(record));
}

function decodeContainer(buf) {
  if (buf.length < 4) throw new Error('QDEF container too short for magic');
  const magic = buf.subarray(0, 4);
  if (!magic.equals(MAGIC)) {
    throw new Error(`bad magic: ${magic.toString('hex')}`);
  }
  return decodeRecordBytes(buf.subarray(4));
}

function decodeSequence(seq) {
  return decodeRecordBytes(seq);
}

function parseRecordList(items) {
  const records = [];
  for (const item of items) {
    if (Array.isArray(item)) records.push(parseRecordFromItems(item));
  }
  return records;
}

function parseRecordFromItems(arr) {
  let i = 0;
  let localNamespace;
  let nsAnnotation;
  let typeAnnotation;

  // Check for namespace bstr at position 0
  if (Buffer.isBuffer(arr[0])) {
    localNamespace = arr[0];
    i = 1;
    // Check for ns_annotation tstr
    if (i < arr.length && typeof arr[i] === 'string') {
      nsAnnotation = arr[i];
      i++;
    }
  }

  // Consume consecutive uints as typeId
  const typeId = [];
  while (i < arr.length && isTypeIdItem(arr[i])) {
    typeId.push(arr[i]);
    i++;
  }
  const resolvedTypeId = typeId.length > 0 ? typeId : undefined;

  // Check for type_annotation tstr (only valid after at least one uint)
  if (resolvedTypeId !== undefined && i < arr.length && typeof arr[i] === 'string') {
    typeAnnotation = arr[i];
    i++;
  }

  // Error: bare tstr at position 0 with no namespace or typeId
  if (localNamespace === undefined && resolvedTypeId === undefined && i < arr.length && typeof arr[i] === 'string') {
    // If the first (and only) item is a tstr, that's malformed
    if (i === 0) {
      throw new Error('bare tstr at record start with no namespace or typeId');
    }
  }

  // Next item, if map, is the field Map
  let map = null;
  if (i < arr.length && isMapItem(arr[i])) {
    map =
      arr[i] instanceof Map ? arr[i] : new Map(Object.entries(arr[i]).map(([k, v]) => [Number(k), v]));
    i++;
  }

  const subrecords = i < arr.length ? parseRecordList(arr.slice(i)) : undefined;

  return {
    typeId: resolvedTypeId,
    localNamespace,
    nsAnnotation,
    typeAnnotation,
    subrecords,
    map,
  };
}

function isTypeIdItem(item) {
  if (typeof item === 'number' && Number.isInteger(item) && item >= 0) {
    return true;
  }
  if (typeof item === 'bigint' && item >= 0n) {
    return true;
  }
  return false;
}

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
 * Apply even/odd criticality (§3.2) for positive keys only.
 * Key 0 (payload) and negative keys are spec-reserved and skipped.
 */
function applyCriticality(record, knownKeys) {
  if (!record.map) return { ...record, aborted: false, ignoredKeys: [] };
  const map = record.map;
  const keys = map instanceof Map ? map.keys() : Object.keys(map).map(Number);
  const ignoredKeys = [];
  for (const key of keys) {
    if (key === 0 || key < 0) continue;
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

function decodeRecordBytes(buf) {
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
