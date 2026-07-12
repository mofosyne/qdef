'use strict';
// QDEF core: magic framing, CBOR-Sequence-of-Records, key-0 routing,
// even/odd unknown-key criticality. Deliberately has no knowledge of any
// specific Record Type, compression, or reassembly (see docs/QDEF-SPEC.md §3.3).
//
// Records are plain CBOR maps, never CBOR-tagged: an earlier draft also
// wrapped each Record in a CBOR semantic tag equal to its Type ID, dropped
// after finding it collided with the IANA CBOR tag registry (see
// docs/FINDINGS.md #11–#12). Key 0 is the only routing mechanism.
//
// No version byte: the container is just magic + a CBOR Sequence of
// Records, full stop. Any container-level metadata (a format namespace)
// lives inside the Sequence itself, as a Record with the reserved Type
// ID 0 (see header.js) — reusing the same even/odd extensibility every
// other Record already has, rather than a second, parallel
// extensibility mechanism for the header alone.

const cbor = require('cbor');

const MAGIC = Buffer.from([0x51, 0x44, 0x45, 0x46]); // "QDEF"

/**
 * Encode a QDEF container from a list of records.
 * @param {Array<{typeId: number, fields: Map<number, any>}>} records
 */
function encodeContainer(records) {
  const parts = records.map(encodeRecordBytes);
  return Buffer.concat([MAGIC, ...parts]);
}

function encodeRecordBytes({ typeId, fields }) {
  const map = new Map(fields);
  map.set(0, typeId); // Key 0 MUST carry the Record Type ID — the only routing mechanism
  if (map.get(0) !== typeId) throw new Error('key 0 must equal typeId');
  // §3.4: encoders MUST produce RFC 8949 §4.2.1 deterministic CBOR (shortest-
  // form arguments, sorted map keys) — not a style preference, it's what
  // makes a content hash like group_id (§4.1) mean "same logical content"
  // across independent encoders rather than just "same encoder, same run."
  return cbor.encodeCanonical(map);
}

/**
 * Decode a QDEF container down to raw routed records: no even/odd
 * criticality applied yet (that's per-Record-Type, see applyCriticality).
 */
function decodeContainer(buf) {
  if (buf.length < 4) throw new Error('QDEF container too short for magic');
  const magic = buf.subarray(0, 4);
  if (!magic.equals(MAGIC)) throw new Error(`bad magic: ${magic.toString('hex')}`);

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
  return items.map(decodeRecordItem);
}

function decodeRecordItem(map) {
  if (!(map instanceof Map)) {
    throw new Error('Record is not a CBOR map');
  }
  if (!map.has(0)) {
    // Key 0 is even and always critical: a record with no Type ID at all
    // cannot be routed. Treat as an immediate abort of this record.
    return { typeId: null, map, aborted: true, abortReason: 'missing key 0' };
  }
  return { typeId: map.get(0), map, aborted: false };
}

/**
 * Apply the even/odd criticality rule (§3.2) for a specific Record Type's
 * known key set. Returns the same record annotated with aborted/ignoredKeys.
 */
function applyCriticality(record, knownKeys) {
  if (record.aborted) return record;
  const ignoredKeys = [];
  for (const key of record.map.keys()) {
    if (key === 0) continue;
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
 * Decode a single Record from raw bytes with no magic prefix — used
 * for the inner bytes a Wrapper Record (§4.1) unwraps, which are just "the
 * encoded bytes of another Record", not a fresh top-level QDEF container.
 */
function decodeRecordBytes(buf) {
  const item = cbor.decodeFirstSync(buf);
  return decodeRecordItem(item);
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
