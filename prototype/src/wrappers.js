'use strict';
// QDEF standard record type Wrapper Records (§4.1): Split ([0, 2]),
// Compress ([0, 8]), Encrypt ([0, 4]). Each is a generic byte-in/byte-out
// resolver — none of them know or care what the wrapped inner bytes mean.

const crypto = require('crypto');
const zlib = require('zlib');
const cbor = require('cbor');
const core = require('./core');

const SPLIT_TYPE = [1];
const ENCRYPT_TYPE = [2];
const MEDIA_PAYLOAD_TYPE = [3];
const COMPRESS_TYPE = [4];
const OPEN_HINT_URI_TYPE = [5];
const APP_ROUTE_TYPE = [6];
const MEDIA_PREVIEW_TYPE = [7];

// Known keys for each standard type (keys > 0, excluding key 0 which is payload)
const SPLIT_KNOWN_KEYS = new Set([2, 4, 6, 7, 9]);
const COMPRESS_KNOWN_KEYS = new Set([]);
const ENCRYPT_KNOWN_KEYS = new Set([2, 3, 5]);
const OPEN_HINT_URI_KNOWN_KEYS = new Set([1, 3, 5]);
const MEDIA_PAYLOAD_KNOWN_KEYS = new Set([1]);
const APP_ROUTE_KNOWN_KEYS = new Set([1]);
const MEDIA_PREVIEW_KNOWN_KEYS = new Set([2, 3, 5, 7]);

const PARITY_SCHEME_NONE = 0;
const PARITY_SCHEME_XOR = 1;

// COSE Algorithm IDs (RFC 9053/9054)
const COSE_ALG_A256GCM = 3;
const COSE_ALG_ECDH_ES_HKDF_256 = -25;
const COSE_ALG_DIRECT_HKDF_SHA_256 = -10;

// CoAP Content-Format IDs
const COAP_CONTENT_FORMAT_IMAGE_JPEG = 22;
const COAP_CONTENT_FORMAT_IMAGE_PNG = 23;
const COAP_CONTENT_FORMAT_APPLICATION_CBOR = 60;

// Multiformats multicodec hash-function codes
const MULTIHASH_SHA2_256 = 0x12;

function typeIdEquals(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function contentHashPrefix(contentBytes, { length = 8 } = {}) {
  const digest = crypto.createHash('sha256').update(contentBytes).digest();
  return Buffer.concat([Buffer.from([MULTIHASH_SHA2_256]), digest.subarray(0, length)]);
}

// ---- Compress (Type [0, 8]) -----------------------------------------------

function compressEncode(innerBytes) {
  return {
    typeId: COMPRESS_TYPE,
    fields: new Map([[0, zlib.deflateRawSync(innerBytes)]]),
  };
}

function compressDecode(rec) {
  return zlib.inflateRawSync(rec.map.get(0));
}

// ---- Encrypt (Type [0, 4]) --------------------------------------------------

function encryptEncode(innerBytes, key, { algorithm, keyAlgorithm } = {}) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(innerBytes), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const fields = new Map([
    [0, Buffer.concat([ciphertext, authTag])], // payload at key 0
    [2, nonce],                                  // nonce at key 2 (was key 0)
  ]);
  if (algorithm !== undefined) fields.set(3, algorithm);
  if (keyAlgorithm !== undefined) fields.set(5, keyAlgorithm);
  return {
    typeId: ENCRYPT_TYPE,
    fields,
  };
}

function encryptDecode(rec, key) {
  const map = rec.map || rec.fields;
  const combined = map.get(0);     // payload at key 0
  const nonce = map.get(2);        // nonce at key 2
  const authTag = combined.subarray(combined.length - 16);
  const ciphertext = combined.subarray(0, combined.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// ---- Split (Type [0, 2]) -----------------------------------------------------

function chunkLength(totalBytes, count) {
  return Math.ceil(totalBytes / count);
}

function splitEncode(innerBytes, { count, parityScheme = PARITY_SCHEME_NONE }) {
  if (count < 1) throw new Error('count must be >= 1');
  const totalBytes = innerBytes.length;
  const chunkLen = chunkLength(totalBytes, count);
  const groupId = crypto.createHash('sha256').update(innerBytes).digest();

  const fragments = [];
  for (let i = 0; i < count; i++) {
    const start = i * chunkLen;
    const end = Math.min(start + chunkLen, totalBytes);
    const slice = innerBytes.subarray(start, end);
    const fields = new Map([
      [0, Buffer.from(slice)],  // fragment bytes at key 0 (payload)
      [2, groupId],             // group_id at key 2 (was key 0)
      [4, i],                   // index at key 4 (was key 2)
      [6, count],               // count at key 6 (was key 4)
      [7, totalBytes],          // total_bytes stays at key 7 (odd)
    ]);
    if (parityScheme !== PARITY_SCHEME_NONE) fields.set(9, parityScheme);
    fragments.push({
      typeId: SPLIT_TYPE,
      fields,
    });
  }

  if (parityScheme === PARITY_SCHEME_XOR) {
    const parity = Buffer.alloc(chunkLen);
    for (let i = 0; i < count; i++) {
      const padded = zeroPad(innerBytes.subarray(i * chunkLen, Math.min((i + 1) * chunkLen, totalBytes)), chunkLen);
      xorInPlace(parity, padded);
    }
    const fields = new Map([
      [0, parity],
      [2, groupId],
      [4, count],
      [6, count],
      [7, totalBytes],
      [9, parityScheme],
    ]);
    fragments.push({
      typeId: SPLIT_TYPE,
      fields,
    });
  } else if (parityScheme !== PARITY_SCHEME_NONE) {
    throw new Error(`unsupported parity_scheme: ${parityScheme}`);
  }

  return fragments;
}

function zeroPad(buf, len) {
  if (buf.length === len) return buf;
  const out = Buffer.alloc(len);
  buf.copy(out);
  return out;
}

function xorInPlace(target, src) {
  for (let i = 0; i < target.length; i++) target[i] ^= src[i];
}

function splitDecode(fragmentRecords) {
  if (fragmentRecords.length === 0) throw new Error('no fragments given');
  const map0 = fragmentRecords[0].map;
  const groupId = map0.get(2);
  const count = map0.get(6);
  const totalBytes = map0.get(7);
  const parityScheme = map0.get(9) ?? PARITY_SCHEME_NONE;

  for (const f of fragmentRecords) {
    if (!f.map.get(2).equals(groupId)) throw new Error('fragments from mismatched groups');
    if (f.map.get(6) !== count) throw new Error('fragments disagree on count');
  }
  if (totalBytes === undefined) {
    throw new Error('total_bytes (key 7) absent: cannot safely reassemble/recover without it');
  }

  const chunkLen = chunkLength(totalBytes, count);
  const byIndex = new Map();
  for (const f of fragmentRecords) byIndex.set(f.map.get(4), f.map.get(0)); // payload at key 0

  const missing = [];
  for (let i = 0; i < count; i++) {
    if (!byIndex.has(i)) missing.push(i);
  }

  if (missing.length > 1) {
    throw new Error(`${missing.length} fragments missing; XOR parity can only recover 1`);
  }

  if (missing.length === 1) {
    if (parityScheme !== PARITY_SCHEME_XOR) {
      throw new Error(`fragment ${missing[0]} missing and no usable parity_scheme present`);
    }
    const parityFrag = byIndex.get(count);
    if (!parityFrag) throw new Error('parity fragment (index == count) not present');
    const recovered = Buffer.alloc(chunkLen);
    xorInPlace(recovered, zeroPad(parityFrag, chunkLen));
    for (let i = 0; i < count; i++) {
      if (i === missing[0]) continue;
      xorInPlace(recovered, zeroPad(byIndex.get(i), chunkLen));
    }
    const missIdx = missing[0];
    const start = missIdx * chunkLen;
    const end = Math.min(start + chunkLen, totalBytes);
    byIndex.set(missIdx, recovered.subarray(0, end - start));
  }

  const parts = [];
  for (let i = 0; i < count; i++) parts.push(byIndex.get(i));
  const reassembled = Buffer.concat(parts);

  if (reassembled.length !== totalBytes) {
    throw new Error(`reassembled length ${reassembled.length} != total_bytes ${totalBytes}`);
  }
  const recomputedGroupId = crypto.createHash('sha256').update(reassembled).digest();
  if (!recomputedGroupId.equals(groupId)) {
    throw new Error('group_id (content hash) mismatch after reassembly — corrupt fragment(s)');
  }
  return reassembled;
}

// ---- Generic wrapper resolver ------------------------------------------

function typeIdListToKey(tid) {
  return Array.isArray(tid) ? tid.join(',') : '';
}

const WRAPPER_TYPES = new Set([
  typeIdListToKey(SPLIT_TYPE),
  typeIdListToKey(COMPRESS_TYPE),
  typeIdListToKey(ENCRYPT_TYPE),
]);

function isWrapperType(tid) {
  return WRAPPER_TYPES.has(typeIdListToKey(tid));
}

function unwrapSingle(rec, ctx) {
  if (typeIdEquals(rec.typeId, COMPRESS_TYPE)) return compressDecode(rec);
  if (typeIdEquals(rec.typeId, ENCRYPT_TYPE)) return encryptDecode(rec, ctx.aesKey);
  throw new Error(`unwrapSingle: not a single-record wrapper type: ${JSON.stringify(rec.typeId)}`);
}

function decodeAndCheck(bytes, knownKeysRegistry) {
  const rec = core.decodeRecordBytes(bytes);
  const tidKey = typeIdListToKey(rec.typeId);
  const knownKeys = knownKeysRegistry.get(tidKey) ?? new Set();
  const checked = core.applyCriticality(rec, knownKeys);
  if (checked.aborted) throw new Error(`record type ${JSON.stringify(rec.typeId)} aborted: ${checked.abortReason}`);
  return checked;
}

function resolveStack(codesBytesList, ctx, knownKeysRegistry) {
  const pendingSplitFragments = [];
  let terminal = null;

  for (const codeBytes of codesBytesList) {
    const record = core.decodeContainer(codeBytes);
    const tidKey = typeIdListToKey(record.typeId);
    const knownKeys = knownKeysRegistry.get(tidKey) ?? new Set();
    let rec = core.applyCriticality(record, knownKeys);
    if (rec.aborted) throw new Error(`record type ${JSON.stringify(rec.typeId)} aborted: ${rec.abortReason}`);

    while (isWrapperType(rec.typeId) && !typeIdEquals(rec.typeId, SPLIT_TYPE)) {
      const bytes = unwrapSingle(rec, ctx);
      rec = decodeAndCheck(bytes, knownKeysRegistry);
    }
    if (typeIdEquals(rec.typeId, SPLIT_TYPE)) {
      pendingSplitFragments.push(rec);
    } else {
      terminal = rec;
    }
  }

  if (pendingSplitFragments.length > 0) {
    const bytes = splitDecode(pendingSplitFragments);
    let rec = decodeAndCheck(bytes, knownKeysRegistry);
    while (isWrapperType(rec.typeId) && !typeIdEquals(rec.typeId, SPLIT_TYPE)) {
      const inner = unwrapSingle(rec, ctx);
      rec = decodeAndCheck(inner, knownKeysRegistry);
    }
    if (typeIdEquals(rec.typeId, SPLIT_TYPE)) {
      throw new Error('nested Split-of-Split groups not supported by this prototype resolver');
    }
    terminal = rec;
  }

  return terminal;
}

module.exports = {
  SPLIT_TYPE,
  COMPRESS_TYPE,
  ENCRYPT_TYPE,
  OPEN_HINT_URI_TYPE,
  MEDIA_PAYLOAD_TYPE,
  APP_ROUTE_TYPE,
  MEDIA_PREVIEW_TYPE,
  SPLIT_KNOWN_KEYS,
  COMPRESS_KNOWN_KEYS,
  ENCRYPT_KNOWN_KEYS,
  OPEN_HINT_URI_KNOWN_KEYS,
  MEDIA_PAYLOAD_KNOWN_KEYS,
  APP_ROUTE_KNOWN_KEYS,
  MEDIA_PREVIEW_KNOWN_KEYS,
  PARITY_SCHEME_NONE,
  PARITY_SCHEME_XOR,
  COSE_ALG_A256GCM,
  COSE_ALG_ECDH_ES_HKDF_256,
  COSE_ALG_DIRECT_HKDF_SHA_256,
  COAP_CONTENT_FORMAT_IMAGE_JPEG,
  COAP_CONTENT_FORMAT_IMAGE_PNG,
  COAP_CONTENT_FORMAT_APPLICATION_CBOR,
  MULTIHASH_SHA2_256,
  compressEncode,
  compressDecode,
  encryptEncode,
  encryptDecode,
  splitEncode,
  splitDecode,
  resolveStack,
  contentHashPrefix,
  typeIdEquals,
};
