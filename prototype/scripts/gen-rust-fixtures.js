'use strict';
// Regenerates rust/qdef-core/src/fixtures.rs: QDEF containers encoded by
// the (already round-trip-tested) Node prototype, as Rust byte-array
// literals. This cross-validates the hand-rolled Rust decoder against an
// independently-implemented encoder (Node's `cbor` package), instead of
// only ever checking the Rust code against itself. CI regenerates this
// file and diffs it against what's committed to catch drift.
//
// Run: node scripts/gen-rust-fixtures.js > ../rust/qdef-core/src/fixtures.rs

const cbor = require('cbor');
const core = require('../src/core');
const rt = require('../src/recordTypes');

function rustBytes(name, buf) {
  const hex = Array.from(buf).map((b) => `0x${b.toString(16).padStart(2, '0')}`);
  const lines = [];
  for (let i = 0; i < hex.length; i += 16) lines.push('    ' + hex.slice(i, i + 16).join(', ') + ',');
  return `pub const ${name}: &[u8] = &[\n${lines.join('\n')}\n];`;
}

// --- Basic round-trip: a valid Wi-Fi record in a container ---

const wifiContainer = core.encodeContainer([
  {
    typeIds: [rt.WIFI_TYPE],
    fields: new Map([
      [0, 'My Coffee Shop'],
      [2, 'guest123'],
      [4, 2],
      [1, true],
    ]),
  },
]);

// --- Even/odd criticality: unknown even key aborts the record ---

const wifiUnknownEvenKeyContainer = core.encodeContainer([
  {
    typeIds: [rt.WIFI_TYPE],
    fields: new Map([[0, 'SSID'], [2, 'pass'], [4, 2], [6, 'unknown critical field']]),
  },
]);

// --- Even/odd criticality: unknown odd key is silently ignored ---

const wifiUnknownOddKeyContainer = core.encodeContainer([
  {
    typeIds: [rt.WIFI_TYPE],
    fields: new Map([[0, 'SSID'], [2, 'pass'], [4, 2], [7, 'unknown optional field']]),
  },
]);

// --- Record with no typeID prefix: ignored (not routed) ---
// Manually constructed (not via encodeContainer) to keep the mandatory
// discriminator explicit here: uint 0 (no namespace), then a bare map
// with no preceding typeID item.

const noTypeidDiscBytes = cbor.encodeCanonical(0);
const noTypeidMap = new Map([[0, 'SSID']]);
const noTypeidBytes = cbor.encode(noTypeidMap);
const noTypeidContainer = Buffer.concat([core.MAGIC, noTypeidDiscBytes, noTypeidBytes]);

// --- Bare NDEF/own-URI-scheme sequence: no magic, no discriminator ---
// Built directly via encodeRecordBytes (bypassing encodeContainer entirely),
// since that carrier already supplies its own dispatch/isolation and never
// carries a magic or a discriminator item (§ own-URI-scheme carriers).

const bareSequenceNoDiscriminator = core.encodeRecordBytes({
  typeIds: [rt.WIFI_TYPE],
  fields: new Map([[0, 'SSID'], [2, 'pass'], [4, 2], [1, true]]),
});

// --- Two records in one sequence: first aborts (unknown even key), second is fine ---

const twoRecordContainer = core.encodeContainer([
  { typeIds: [rt.WIFI_TYPE], fields: new Map([[0, 'SSID'], [2, 'pass'], [4, 2], [6, 'unknown critical']]) },
  { typeIds: [rt.TAGDROP_REGISTRATION_TYPE], fields: new Map([[0, Buffer.from('sibling record')]]) },
]);

// --- §3.2's field-value-shape rule: a field value that's a bare CBOR array ---
// (major type 4) instead of a scalar or definite-length string. Key 11 is
// odd/optional — if the shape rule didn't exist, an unaware decoder would
// just ignore it as an unrecognized optional key. It must instead be
// rejected outright, because the decoder can't even determine this
// Record's byte length without walking into the array's structure.

const disallowedArrayValueContainer = core.encodeContainer([
  {
    typeIds: [rt.WIFI_TYPE],
    fields: new Map([[0, 'SSID'], [2, 'pass'], [4, 2], [9, [1, 2, 3]]]),
  },
]);

// --- The *correct* way to carry structured content under the field-value-shape ---
// rule: pre-encode it as CBOR and wrap the encoded bytes in a definite-
// length byte string. The outer decoder skips it as opaque bytes at O(1)
// cost, never recursing into it; a Record-Type-specific handler that wants
// the structure back decodes the byte string's contents itself.

const nestedAuthMethods = cbor.encode(['WPA2', 'WPA3']);
const byteStringWrappedValueContainer = core.encodeContainer([
  {
    typeIds: [rt.WIFI_TYPE],
    fields: new Map([
      [0, 'SSID'],
      [2, 'pass'],
      [4, 2],
      [9, nestedAuthMethods], // odd/optional key, opaque nested CBOR payload
    ]),
  },
]);

// --- §3.2's field-value-shape rule, revised per GitHub issue #8: a field ---
// value MAY be CBOR tag 24 ("encoded CBOR data item", RFC 8949 §3.4.5.1)
// wrapping a definite-length byte string directly — skip-safe in exactly
// two fixed header reads, no recursion — rather than requiring the extra
// indirection of a bare byte string with no outer marker that it happens
// to contain further CBOR.

const tag24WrappedValueContainer = core.encodeContainer([
  {
    typeIds: [rt.WIFI_TYPE],
    fields: new Map([
      [0, 'SSID'],
      [2, 'pass'],
      [4, 2],
      [9, new cbor.Tagged(24, nestedAuthMethods)],
    ]),
  },
]);

// --- The bound that keeps the tag-24 case from reopening unbounded recursion: ---
// tag 24 MUST wrap a definite-length string *directly*, never another tag.
// Nesting it — tag 24 wrapping tag 24 wrapping the real bytes — is exactly
// as disallowed as a bare array; the decoder checks the inner shape once,
// inline, rather than calling back into itself, so this MUST be rejected
// outright rather than silently accepted at unbounded depth.

const nestedTag24Container = core.encodeContainer([
  {
    typeIds: [rt.WIFI_TYPE],
    fields: new Map([
      [0, 'SSID'],
      [2, 'pass'],
      [4, 2],
      [9, new cbor.Tagged(24, new cbor.Tagged(24, nestedAuthMethods))],
    ]),
  },
]);

// --- Widened per FINDINGS.md #16: any tag number is allowed, not just 24 ---
// the content-shape check (definite-length string, directly) is what
// makes a tag skip-safe, and that holds regardless of which tag number is
// on the wire. Tag 0 ("standard date/time string") wrapping a definite-
// length text string is a real, IANA-registered tag, genuinely
// scalar-shaped by its own RFC 8949 definition — now accepted.

const otherTagWrappedValueContainer = core.encodeContainer([
  {
    typeIds: [rt.WIFI_TYPE],
    fields: new Map([
      [0, 'SSID'],
      [2, 'pass'],
      [4, 2],
      [9, new cbor.Tagged(0, '2026-07-10T12:00:00Z')],
    ]),
  },
]);

// --- The other half of the bound: it's the *content shape*, not the tag ---
// number, that's checked — a real, IANA-registered tag whose own RFC 8949
// definition genuinely requires array content stays rejected regardless.
// Tag 4 ("decimal fraction") wraps a 2-element array [exponent, mantissa]
// by definition; here [-2, 27315] means 273.15 — still MUST be rejected.

const structuredTagWrappedValueContainer = core.encodeContainer([
  {
    typeIds: [rt.WIFI_TYPE],
    fields: new Map([
      [0, 'SSID'],
      [2, 'pass'],
      [4, 2],
      [9, new cbor.Tagged(4, [-2, 27315])],
    ]),
  },
]);

// --- A 64-bit-class private-use Type ID (§3.1, §9's 0x10000+ tier) ---
// needs BigInt in JS, since it exceeds Number.MAX_SAFE_INTEGER.
// core.encodeRecordBytes (via encodeCanonical) encodes BigInts as native
// CBOR uints, not tag-2 bignums. This fixture proves the Rust decoder
// handles the full uint64 range correctly. See docs/FINDINGS.md #14.

const largeTypeIdContainer = core.encodeContainer([
  { typeIds: [2n ** 64n - 1n], fields: new Map([[0, 'private-use content']]) },
]);

// --- Container discriminator (§3.5) ---
// The mandatory core needs zero special knowledge of what the
// discriminator means -- it only knows how to split exactly one CBOR
// item off the front (`Container::discriminator()`), never how to
// interpret it. This fixture proves the records that follow are routed
// by the exact same generic Rust decoder either way: a decentralized
// (byte-string) namespace discriminator, followed by a plain Wi-Fi
// record.

const header = require('../src/header');
const headerContainer = core.encodeContainer(
  [{ typeIds: [rt.WIFI_TYPE], fields: new Map([[0, 'SSID'], [2, 'pass'], [4, 2]]) }],
  Buffer.from('a9d6e1f30b7c4482', 'hex'),
);

// --- §3.1's byte-string Type ID ---
// A byte string Type ID is a decentralized/global Type ID. The core routes
// it without interpreting the bytes — the caller resolves scope via their
// own namespace logic. This fixture carries a 4-byte string ID in the
// prefix, proving the Rust decoder can handle byte-string typeIDs.

const byteStringTypeIdContainer = core.encodeContainer([
  {
    typeIds: [Buffer.from('A7F90B3C', 'hex')],
    fields: new Map([[0, 'decentralized payload']]),
  },
]);

// --- Backup typeIDs: promoted byte-string ID carried alongside new uint ---
// When a byte-string typeID is promoted to a registered uint, the old ID
// is carried as a backup prefix item. The decoder accumulates all typeIDs
// and exposes them via the typeIds array.

const backupTypeIdContainer = core.encodeContainer([
  {
    typeIds: [rt.WIFI_TYPE, Buffer.from('A7F90B3C', 'hex')],
    fields: new Map([[0, 'SSID'], [2, 'pass'], [4, 2]]),
  },
]);

// --- Namespace-pairing prefix item (§3.1) ---
// A Record's own prefix MAY declare/override its namespace inline via a
// 2-element array [namespace, typeId], independent of the container
// discriminator's ambient one. Purely structural for the mandatory
// core: it only needs to recognize the 2-element-array shape and pull
// out the nested typeId, never learn what a namespace means. This
// fixture pairs a decentralized (byte-string) namespace with a scoped
// (odd) typeId.

const namespacePairingContainer = core.encodeContainer([
  {
    typeIds: [1],
    fields: new Map([[0, 'payload']]),
    localNamespace: Buffer.from('cdcdcdcd', 'hex'),
  },
]);

// --- Namespace-pairing with an Allocated (uint) namespace ---

const allocatedNamespacePairingContainer = core.encodeContainer([
  {
    typeIds: [1],
    fields: new Map([[0, 'payload']]),
    localNamespace: 100,
  },
]);

// --- Namespace-pairing primary + a backup typeID ---
// The same promotion pattern §3.1 already uses for backup typeIDs,
// applied to a namespace-scoped primary: the pairing contributes the
// primary typeId, and an ordinary backup typeID still follows it.

const namespacePairingWithBackupContainer = core.encodeContainer([
  {
    typeIds: [1, Buffer.from('A7F90B3C', 'hex')],
    fields: new Map([[0, 'payload']]),
    localNamespace: Buffer.from('cdcdcdcd', 'hex'),
  },
]);

// --- Output ---

console.log('//! Generated by `node prototype/scripts/gen-rust-fixtures.js` — do not');
console.log('//! hand-edit. Regenerate with:');
console.log('//!');
console.log('//!     cd prototype && node scripts/gen-rust-fixtures.js');
console.log('//!');
console.log('//! These are QDEF containers encoded by the (already round-trip-tested)');
console.log('//! Node prototype, checked into the Rust crate so its independent,');
console.log('//! hand-rolled decoder can be tested against an independently-produced');
console.log('//! encoding — not just against its own encoder. CI regenerates this file');
console.log('//! and diffs it against what\'s committed, so it can\'t silently drift out');
console.log('//! of sync with the Node encoder.\n');
console.log(rustBytes('WIFI_CONTAINER', wifiContainer));
console.log();
console.log(rustBytes('WIFI_UNKNOWN_EVEN_KEY_CONTAINER', wifiUnknownEvenKeyContainer));
console.log();
console.log(rustBytes('WIFI_UNKNOWN_ODD_KEY_CONTAINER', wifiUnknownOddKeyContainer));
console.log();
console.log(rustBytes('NO_TYPEID_CONTAINER', noTypeidContainer));
console.log();
console.log(rustBytes('BARE_SEQUENCE_NO_DISCRIMINATOR', bareSequenceNoDiscriminator));
console.log();
console.log(rustBytes('TWO_RECORD_CONTAINER', twoRecordContainer));
console.log();
console.log(rustBytes('DISALLOWED_ARRAY_VALUE_CONTAINER', disallowedArrayValueContainer));
console.log();
console.log(rustBytes('BYTE_STRING_WRAPPED_VALUE_CONTAINER', byteStringWrappedValueContainer));
console.log();
console.log(rustBytes('TAG24_WRAPPED_VALUE_CONTAINER', tag24WrappedValueContainer));
console.log();
console.log(rustBytes('NESTED_TAG24_CONTAINER', nestedTag24Container));
console.log();
console.log(rustBytes('OTHER_TAG_WRAPPED_VALUE_CONTAINER', otherTagWrappedValueContainer));
console.log();
console.log(rustBytes('STRUCTURED_TAG_WRAPPED_VALUE_CONTAINER', structuredTagWrappedValueContainer));
console.log();
console.log(rustBytes('NESTED_AUTH_METHODS_CBOR', nestedAuthMethods));
console.log();
console.log(rustBytes('LARGE_TYPE_ID_CONTAINER', largeTypeIdContainer));
console.log();
console.log(rustBytes('HEADER_CONTAINER', headerContainer));
console.log();
console.log(rustBytes('BYTE_STRING_TYPE_ID_CONTAINER', byteStringTypeIdContainer));
console.log();
console.log(rustBytes('BACKUP_TYPE_ID_CONTAINER', backupTypeIdContainer));
console.log();
console.log(rustBytes('NAMESPACE_PAIRING_CONTAINER', namespacePairingContainer));
console.log();
console.log(rustBytes('ALLOCATED_NAMESPACE_PAIRING_CONTAINER', allocatedNamespacePairingContainer));
console.log();
console.log(rustBytes('NAMESPACE_PAIRING_WITH_BACKUP_CONTAINER', namespacePairingWithBackupContainer));
