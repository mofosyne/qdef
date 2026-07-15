'use strict';
// QDEF standard record type Wrapper Records (§4.1): Split (2), Compress (8),
// Encrypt (4). Each is a generic byte-in/byte-out resolver — none of them
// know or care what the wrapped inner bytes mean.

const crypto = require('crypto');
const zlib = require('zlib');
const cbor = require('cbor');
const core = require('./core');
const header = require('./header');

const SPLIT_TYPE = 2;
const COMPRESS_TYPE = 8;
const ENCRYPT_TYPE = 4;
const FALLBACK_HINT_TYPE = 10;
const MEDIA_PAYLOAD_TYPE = 6;
const APP_ROUTE_TYPE = 12;

const SPLIT_KNOWN_KEYS = new Set([0, 2, 4, 6, 7, 9]);
const COMPRESS_KNOWN_KEYS = new Set([0]);
const ENCRYPT_KNOWN_KEYS = new Set([0, 2, 3, 5]);
const FALLBACK_HINT_KNOWN_KEYS = new Set([0]);
const MEDIA_PAYLOAD_KNOWN_KEYS = new Set([0, 2]);
const APP_ROUTE_KNOWN_KEYS = new Set([0, 1]);

const PARITY_SCHEME_NONE = 0;
const PARITY_SCHEME_XOR = 1; // prototype-only single-parity-fragment scheme

// COSE Algorithm IDs (RFC 9053/9054, IANA "COSE Algorithms" registry) —
// borrowed, not invented; see spec §4.1 and DESIGN.md's "Encrypt key
// provisioning" entry for why keys 5/7 use this registry instead of a
// QDEF-specific one.
const COSE_ALG_A256GCM = 3;
const COSE_ALG_ECDH_ES_HKDF_256 = -25;
const COSE_ALG_DIRECT_HKDF_SHA_256 = -10;

// CoAP Content-Format IDs (RFC 7252 §12.3 / RFC 9876, IANA "CoAP
// Content-Formats" registry) — borrowed for §4.3's Media Type field, same
// reasoning as the COSE IDs above. text/vcard is deliberately absent from
// this list: confirmed not present in the real registry (spec §4.3,
// DESIGN.md), so it's the fixture for the plain-string fallback path.
const COAP_CONTENT_FORMAT_IMAGE_JPEG = 22;
const COAP_CONTENT_FORMAT_IMAGE_PNG = 23;
const COAP_CONTENT_FORMAT_APPLICATION_CBOR = 60;

// ---- Compress (Type 8) -----------------------------------------------

function compressEncode(innerBytes) {
  return {
    typeIds: [COMPRESS_TYPE],
    fields: new Map([[0, zlib.deflateRawSync(innerBytes)]]),
  };
}

function compressDecode(map) {
  return zlib.inflateRawSync(map.get(0));
}

// ---- Encrypt (Type 4) --------------------------------------------------

function encryptEncode(innerBytes, key, { algorithm, keyAlgorithm } = {}) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(innerBytes), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const fields = new Map([
    [0, nonce],
    [2, Buffer.concat([ciphertext, authTag])], // "ciphertext+tag" per spec
  ]);
  if (algorithm !== undefined) fields.set(3, algorithm);
  if (keyAlgorithm !== undefined) fields.set(5, keyAlgorithm);
  return {
    typeIds: [ENCRYPT_TYPE],
    fields,
  };
}

function encryptDecode(map, key) {
  const nonce = map.get(0);
  const combined = map.get(2);
  const authTag = combined.subarray(combined.length - 16);
  const ciphertext = combined.subarray(0, combined.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// ---- Split (Type 2) -----------------------------------------------------

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
      [0, groupId],
      [2, i],
      [4, count],
      [6, Buffer.from(slice)],
      [7, totalBytes],
    ]);
    if (parityScheme !== PARITY_SCHEME_NONE) fields.set(9, parityScheme);
    fragments.push({
      typeIds: [SPLIT_TYPE],
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
      [0, groupId],
      [2, count], // parity fragment index == count (first index >= count)
      [4, count],
      [6, parity],
      [7, totalBytes],
      [9, parityScheme],
    ]);
    fragments.push({
      typeIds: [SPLIT_TYPE],
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

/**
 * Reassemble a Split group from whatever fragment records were recovered
 * (order doesn't matter, duplicates tolerated). Returns the original bytes,
 * recovering one missing real fragment via XOR parity if needed and
 * possible. Throws if reassembly is not possible with what's present.
 */
function splitDecode(fragmentRecords) {
  if (fragmentRecords.length === 0) throw new Error('no fragments given');
  const groupId = fragmentRecords[0].map.get(0);
  const count = fragmentRecords[0].map.get(4);
  const totalBytes = fragmentRecords[0].map.get(7);
  const parityScheme = fragmentRecords[0].map.get(9) ?? PARITY_SCHEME_NONE;

  for (const f of fragmentRecords) {
    if (!f.map.get(0).equals(groupId)) throw new Error('fragments from mismatched groups');
    if (f.map.get(4) !== count) throw new Error('fragments disagree on count');
  }
  if (totalBytes === undefined) {
    throw new Error('total_bytes (key 7) absent: cannot safely reassemble/recover without it');
  }

  const chunkLen = chunkLength(totalBytes, count);
  const byIndex = new Map();
  for (const f of fragmentRecords) byIndex.set(f.map.get(2), f.map.get(6));

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

const WRAPPER_TYPES = new Set([SPLIT_TYPE, COMPRESS_TYPE, ENCRYPT_TYPE]);

function unwrapSingle(typeId, map, ctx) {
  if (typeId === COMPRESS_TYPE) return compressDecode(map);
  if (typeId === ENCRYPT_TYPE) return encryptDecode(map, ctx.aesKey);
  throw new Error(`unwrapSingle: not a single-record wrapper type: ${typeId}`);
}

function decodeAndCheck(bytes, knownKeysRegistry) {
  const rec = core.decodeRecordBytes(bytes);
  const knownKeys = knownKeysRegistry.get(rec.typeId) ?? new Set();
  const checked = core.applyCriticality(rec, knownKeys);
  if (checked.aborted) throw new Error(`record type ${rec.typeId} aborted: ${checked.abortReason}`);
  return checked;
}

/**
 * Resolve a set of "codes" (each a full QDEF container, one per physical
 * QR/NFC tag) down to the terminal (non-wrapper) application Record,
 * regardless of what order Split/Compress/Encrypt wrappers were nested in.
 *
 * Per spec §3.5: each physical code is its own independent container, with
 * no cross-code state -- so a namespace declared for the group MUST repeat,
 * identically, as a Type 0 sibling on every code, not just one. A code
 * whose first Record is Type 0 is routed starting from its *second* Record
 * instead; every code's declared namespace (if any) must agree, and that
 * namespace applies to the terminal Record this whole stack resolves to --
 * including one only reachable after full Split reassembly, which is
 * exactly the case a lone per-code declaration couldn't reach at all.
 *
 * @param {Buffer[]} codesBytesList
 * @param {{aesKey?: Buffer}} ctx
 * @param {Map<number, Set<number>>} knownKeysRegistry - typeId -> known keys,
 *   covering every wrapper AND application Record Type this call may see.
 */
function resolveStack(codesBytesList, ctx, knownKeysRegistry) {
  const pendingSplitFragments = [];
  let terminal = null;
  let groupHeader; // {namespace, hint} agreed across every code that declares one

  for (const codeBytes of codesBytesList) {
    const { records } = core.decodeContainer(codeBytes);
    const codeHeader = header.extractHeader(records);
    const startIndex = codeHeader ? 1 : 0;
    if (codeHeader) {
      if (groupHeader === undefined) {
        groupHeader = codeHeader;
      } else if (groupHeader.namespace !== codeHeader.namespace) {
        throw new Error('codes in this group declare inconsistent namespaces');
      }
    }

    const record = records[startIndex];
    if (!record) throw new Error('code has no routable Record after its Type 0 header');
    const knownKeys = knownKeysRegistry.get(record.typeId) ?? new Set();
    let rec = core.applyCriticality(record, knownKeys);
    if (rec.aborted) throw new Error(`record type ${rec.typeId} aborted: ${rec.abortReason}`);
    while (WRAPPER_TYPES.has(rec.typeId) && rec.typeId !== SPLIT_TYPE) {
      const bytes = unwrapSingle(rec.typeId, rec.map, ctx);
      rec = decodeAndCheck(bytes, knownKeysRegistry);
    }
    if (rec.typeId === SPLIT_TYPE) {
      pendingSplitFragments.push(rec);
    } else {
      terminal = rec;
    }
  }

  if (pendingSplitFragments.length > 0) {
    const bytes = splitDecode(pendingSplitFragments);
    let rec = decodeAndCheck(bytes, knownKeysRegistry);
    while (WRAPPER_TYPES.has(rec.typeId) && rec.typeId !== SPLIT_TYPE) {
      const inner = unwrapSingle(rec.typeId, rec.map, ctx);
      rec = decodeAndCheck(inner, knownKeysRegistry);
    }
    if (rec.typeId === SPLIT_TYPE) {
      throw new Error('nested Split-of-Split groups not supported by this prototype resolver');
    }
    terminal = rec;
  }

  // Throws if terminal.typeId is an odd/namespace-scoped uint with no
  // namespace found anywhere in the group -- the same correctness rule
  // §3.5 already defines, just reached via a resolved Wrapper stack instead
  // of a plain sibling Record.
  const key = header.resolveLookupKey(groupHeader, terminal.typeId);
  terminal.namespace = key.scope === 'namespace' ? key.namespace : undefined;

  return terminal;
}

module.exports = {
  SPLIT_TYPE,
  COMPRESS_TYPE,
  ENCRYPT_TYPE,
  FALLBACK_HINT_TYPE,
  MEDIA_PAYLOAD_TYPE,
  APP_ROUTE_TYPE,
  SPLIT_KNOWN_KEYS,
  COMPRESS_KNOWN_KEYS,
  ENCRYPT_KNOWN_KEYS,
  FALLBACK_HINT_KNOWN_KEYS,
  MEDIA_PAYLOAD_KNOWN_KEYS,
  APP_ROUTE_KNOWN_KEYS,
  PARITY_SCHEME_NONE,
  PARITY_SCHEME_XOR,
  COSE_ALG_A256GCM,
  COSE_ALG_ECDH_ES_HKDF_256,
  COSE_ALG_DIRECT_HKDF_SHA_256,
  COAP_CONTENT_FORMAT_IMAGE_JPEG,
  COAP_CONTENT_FORMAT_IMAGE_PNG,
  COAP_CONTENT_FORMAT_APPLICATION_CBOR,
  compressEncode,
  compressDecode,
  encryptEncode,
  encryptDecode,
  splitEncode,
  splitDecode,
  resolveStack,
};
