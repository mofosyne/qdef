'use strict';
// QDEF standard-library Wrapper Records (§4.1): Split (2), Compress (3),
// Encrypt (4). Each is a generic byte-in/byte-out resolver — none of them
// know or care what the wrapped inner bytes mean.

const crypto = require('crypto');
const zlib = require('zlib');
const cbor = require('cbor');
const core = require('./core');

const SPLIT_TYPE = 2;
const COMPRESS_TYPE = 3;
const ENCRYPT_TYPE = 4;
const FALLBACK_HINT_TYPE = 5;

const SPLIT_KNOWN_KEYS = new Set([0, 2, 4, 6, 8, 9, 11]);
const COMPRESS_KNOWN_KEYS = new Set([0, 2]);
const ENCRYPT_KNOWN_KEYS = new Set([0, 2, 4, 5, 7]);
const FALLBACK_HINT_KNOWN_KEYS = new Set([0, 1, 2]);

const PARITY_SCHEME_NONE = 0;
const PARITY_SCHEME_XOR = 1; // prototype-only single-parity-fragment scheme

// COSE Algorithm IDs (RFC 9053/9054, IANA "COSE Algorithms" registry) —
// borrowed, not invented; see spec §4.1 and DESIGN.md's "Encrypt key
// provisioning" entry for why keys 5/7 use this registry instead of a
// QDEF-specific one.
const COSE_ALG_A256GCM = 3;
const COSE_ALG_ECDH_ES_HKDF_256 = -25;
const COSE_ALG_DIRECT_HKDF_SHA_256 = -10;

// ---- Compress (Type 3) -----------------------------------------------

function compressEncode(innerBytes) {
  return new Map([
    [0, COMPRESS_TYPE],
    [2, zlib.deflateRawSync(innerBytes)],
  ]);
}

function compressDecode(map) {
  return zlib.inflateRawSync(map.get(2));
}

// ---- Encrypt (Type 4) --------------------------------------------------
// Spec gap found by the prototype: the draft names "AES-GCM" but never says
// how the key is derived (passphrase KDF? pre-shared key? recipient pubkey?).
// That's out of scope for the *container* format (same reasoning as §7's
// compression/split split), but it's a real open question call-out
// (see docs/FINDINGS.md) since "Encrypt" wrapper is meaningless without it.
// The prototype takes a raw 32-byte key as given.

function encryptEncode(innerBytes, key, { algorithm, keyAlgorithm } = {}) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(innerBytes), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return new Map([
    [0, ENCRYPT_TYPE],
    [2, nonce],
    [4, Buffer.concat([ciphertext, authTag])], // "ciphertext+tag" per spec
    ...(algorithm !== undefined ? [[5, algorithm]] : []),
    ...(keyAlgorithm !== undefined ? [[7, keyAlgorithm]] : []),
  ]);
}

function encryptDecode(map, key) {
  const nonce = map.get(2);
  const combined = map.get(4);
  const authTag = combined.subarray(combined.length - 16);
  const ciphertext = combined.subarray(0, combined.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// ---- Split (Type 2) -----------------------------------------------------
//
// Spec gap found by the prototype: the draft never specifies *how* bytes are
// sliced into fragments (fixed chunk size? explicit per-fragment length?),
// which matters the moment `parity_scheme` is used, because XOR parity needs
// every fragment zero-padded to a common length. We fix a deterministic
// chunking rule here so any two independent implementations of Split agree
// without out-of-band coordination:
//
//   chunkLen = ceil(total_bytes / count)
//   fragment[i] = bytes[i*chunkLen .. min((i+1)*chunkLen, total_bytes)]
//
// This also surfaces why `total_bytes` (key 9, documented as OPTIONAL) is
// not really optional whenever `parity_scheme` is set: recovering a missing
// *last* fragment via XOR requires knowing its true (possibly short) length,
// which is only derivable from total_bytes + count + chunkLen. See
// docs/FINDINGS.md.

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
    fragments.push(
      new Map([
        [0, SPLIT_TYPE],
        [2, groupId],
        [4, i],
        [6, count],
        [8, Buffer.from(slice)],
        [9, totalBytes],
        ...(parityScheme !== PARITY_SCHEME_NONE ? [[11, parityScheme]] : []),
      ])
    );
  }

  if (parityScheme === PARITY_SCHEME_XOR) {
    const parity = Buffer.alloc(chunkLen);
    for (let i = 0; i < count; i++) {
      const padded = zeroPad(innerBytes.subarray(i * chunkLen, Math.min((i + 1) * chunkLen, totalBytes)), chunkLen);
      xorInPlace(parity, padded);
    }
    fragments.push(
      new Map([
        [0, SPLIT_TYPE],
        [2, groupId],
        [4, count], // parity fragment index == count (first index >= count)
        [6, count],
        [8, parity],
        [9, totalBytes],
        [11, parityScheme],
      ])
    );
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
 * Reassemble a Split group from whatever fragment maps were recovered
 * (order doesn't matter, duplicates tolerated). Returns the original bytes,
 * recovering one missing real fragment via XOR parity if needed and
 * possible. Throws if reassembly is not possible with what's present.
 */
function splitDecode(fragmentMaps) {
  if (fragmentMaps.length === 0) throw new Error('no fragments given');
  const groupId = fragmentMaps[0].get(2);
  const count = fragmentMaps[0].get(6);
  const totalBytes = fragmentMaps[0].get(9);
  const parityScheme = fragmentMaps[0].get(11) ?? PARITY_SCHEME_NONE;

  for (const f of fragmentMaps) {
    if (!f.get(2).equals(groupId)) throw new Error('fragments from mismatched groups');
    if (f.get(6) !== count) throw new Error('fragments disagree on count');
  }
  if (totalBytes === undefined) {
    throw new Error('total_bytes (key 9) absent: cannot safely reassemble/recover without it');
  }

  const chunkLen = chunkLength(totalBytes, count);
  const byIndex = new Map();
  for (const f of fragmentMaps) byIndex.set(f.get(4), f.get(8));

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
//
// This is the "one resolver, written once, works for every Record Type
// that opts in" claim from §4.1, made real: it recursively unwraps
// Compress/Encrypt layers as soon as they're seen (one code at a time) and
// gathers Split fragments across codes before unwrapping past them. It has
// NO notion of "correct" nesting order — it just keeps unwrapping whatever
// wrapper Type ID it finds until it hits a non-wrapper (terminal) Record.
//
// Prototype finding: this means nesting order (§4.1's "fixed nesting
// order", DESIGN.md's nesting-order question) is genuinely unenforceable/undetectable
// by a generically-written decoder — both the documented order
// (Split-outermost) and a deliberately reversed order (Encrypt applied
// per-code, Split innermost) round-trip through this exact same resolver
// with no error. See docs/FINDINGS.md.

const WRAPPER_TYPES = new Set([SPLIT_TYPE, COMPRESS_TYPE, ENCRYPT_TYPE]);

function unwrapSingle(typeId, map, ctx) {
  if (typeId === COMPRESS_TYPE) return compressDecode(map);
  if (typeId === ENCRYPT_TYPE) return encryptDecode(map, ctx.aesKey);
  throw new Error(`unwrapSingle: not a single-record wrapper type: ${typeId}`);
}

function decodeAndCheck(bytes, knownKeysRegistry) {
  const rec = core.decodeRecordBytes(bytes);
  const knownKeys = knownKeysRegistry.get(rec.typeId) ?? new Set([0]);
  const checked = core.applyCriticality(rec, knownKeys);
  if (checked.aborted) throw new Error(`record type ${rec.typeId} aborted: ${checked.abortReason}`);
  return checked;
}

/**
 * Resolve a set of "codes" (each a full QDEF container, one per physical
 * QR/NFC tag) down to the terminal (non-wrapper) application Record,
 * regardless of what order Split/Compress/Encrypt wrappers were nested in.
 *
 * @param {Buffer[]} codesBytesList
 * @param {{aesKey?: Buffer}} ctx
 * @param {Map<number, Set<number>>} knownKeysRegistry - typeId -> known keys,
 *   covering every wrapper AND application Record Type this call may see.
 */
function resolveStack(codesBytesList, ctx, knownKeysRegistry) {
  const pendingSplitFragments = [];
  let terminal = null;

  for (const codeBytes of codesBytesList) {
    const { records } = core.decodeContainer(codeBytes);
    const knownKeys = knownKeysRegistry.get(records[0].typeId) ?? new Set([0]);
    let rec = core.applyCriticality(records[0], knownKeys);
    if (rec.aborted) throw new Error(`record type ${rec.typeId} aborted: ${rec.abortReason}`);
    while (WRAPPER_TYPES.has(rec.typeId) && rec.typeId !== SPLIT_TYPE) {
      const bytes = unwrapSingle(rec.typeId, rec.map, ctx);
      rec = decodeAndCheck(bytes, knownKeysRegistry);
    }
    if (rec.typeId === SPLIT_TYPE) {
      pendingSplitFragments.push(rec.map);
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

  return terminal;
}

module.exports = {
  SPLIT_TYPE,
  COMPRESS_TYPE,
  ENCRYPT_TYPE,
  FALLBACK_HINT_TYPE,
  SPLIT_KNOWN_KEYS,
  COMPRESS_KNOWN_KEYS,
  ENCRYPT_KNOWN_KEYS,
  FALLBACK_HINT_KNOWN_KEYS,
  PARITY_SCHEME_NONE,
  PARITY_SCHEME_XOR,
  COSE_ALG_A256GCM,
  COSE_ALG_ECDH_ES_HKDF_256,
  COSE_ALG_DIRECT_HKDF_SHA_256,
  compressEncode,
  compressDecode,
  encryptEncode,
  encryptDecode,
  splitEncode,
  splitDecode,
  resolveStack,
};
