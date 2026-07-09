'use strict';
// QDEF core: magic/version framing, CBOR-Sequence-of-Records, key-0 routing,
// even/odd unknown-key criticality. Deliberately has no knowledge of any
// specific Record Type, compression, or reassembly (see docs/QDEF-SPEC.md §3.3).

const cbor = require('cbor');

const MAGIC = Buffer.from([0x51, 0x44, 0x45, 0x46]); // "QDEF"
const VERSION = 0x01;

/**
 * Encode a QDEF container from a list of records.
 * @param {Array<{typeId: number, fields: Map<number, any>}>} records
 * @param {{tagged?: boolean}} [opts] - tagged=false emits bare maps only
 *   (simulates a constrained encoder that skips the "Smart Route" tag).
 */
function encodeContainer(records, opts = {}) {
  const tagged = opts.tagged !== false;
  const parts = records.map((r) => encodeRecordBytes(r, { tagged }));
  return Buffer.concat([MAGIC, Buffer.from([VERSION]), ...parts]);
}

function encodeRecordBytes({ typeId, fields }, opts = {}) {
  const tagged = opts.tagged !== false;
  const map = new Map(fields);
  map.set(0, typeId); // Key 0 MUST carry the Record Type ID (Constrained Route)
  if (map.get(0) !== typeId) throw new Error('key 0 must equal typeId');
  const value = tagged ? new cbor.Tagged(typeId, map) : map;
  return cbor.encode(value);
}

/**
 * Decode a QDEF container down to raw routed records: no even/odd
 * criticality applied yet (that's per-Record-Type, see applyCriticality).
 */
function decodeContainer(buf) {
  if (buf.length < 5) throw new Error('QDEF container too short for magic+version');
  const magic = buf.subarray(0, 4);
  if (!magic.equals(MAGIC)) throw new Error(`bad magic: ${magic.toString('hex')}`);
  const version = buf[4];
  if (version !== VERSION) throw new Error(`unsupported version: ${version}`);

  const seq = buf.subarray(5);
  return { version, records: decodeSequence(seq) };
}

/**
 * Decode a bare CBOR Sequence of Records with no magic/version prefix — the
 * NDEF path (§2), where the outer NDEF record's MIME type
 * (application/vnd.qdef) already identifies the format.
 */
function decodeSequence(seq) {
  const items = cbor.decodeAllSync(seq);
  return items.map(decodeRecordItem);
}

function decodeRecordItem(item) {
  let tag = null;
  let map = item;
  if (item instanceof cbor.Tagged) {
    tag = item.tag;
    map = item.value;
  }
  if (!(map instanceof Map)) {
    throw new Error('Record is not a CBOR map (or Tagged map)');
  }
  if (!map.has(0)) {
    // Key 0 is even and always critical: a record with no Type ID at all
    // cannot be routed by *any* parser, tag-aware or not. Treat as an
    // immediate abort of this record.
    return { tag, typeId: null, map, aborted: true, abortReason: 'missing key 0' };
  }
  const typeId = map.get(0);
  if (tag !== null && tag !== typeId) {
    // Spec gap found by the prototype: the draft never says what a decoder
    // should do when the Smart-Route tag and the Constrained-Route key 0
    // disagree. Treating it as a hard abort of the record (rather than
    // silently trusting one side) is the conservative, tamper-evident choice.
    return {
      tag,
      typeId,
      map,
      aborted: true,
      abortReason: `hardware-parity mismatch: tag=${tag} key0=${typeId}`,
    };
  }
  return { tag, typeId, map, aborted: false };
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
 * Decode a single Record from raw bytes with no magic/version prefix — used
 * for the inner bytes a Wrapper Record (§4.1) unwraps, which are just "the
 * encoded bytes of another Record", not a fresh top-level QDEF container.
 */
function decodeRecordBytes(buf) {
  const item = cbor.decodeFirstSync(buf);
  return decodeRecordItem(item);
}

module.exports = {
  MAGIC,
  VERSION,
  encodeContainer,
  encodeRecordBytes,
  decodeContainer,
  decodeSequence,
  decodeRecordBytes,
  applyCriticality,
};
