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

const wifiContainer = core.encodeContainer([
  {
    typeId: rt.WIFI_TYPE,
    fields: new Map([
      [2, 'My Coffee Shop'],
      [4, 'guest123'],
      [6, 2],
      [3, true],
    ]),
  },
]);

const wifiUnknownEvenKeyContainer = core.encodeContainer([
  {
    typeId: rt.WIFI_TYPE,
    fields: new Map([[2, 'SSID'], [4, 'pass'], [6, 2], [8, 'unknown critical field']]),
  },
]);

const wifiUnknownOddKeyContainer = core.encodeContainer([
  {
    typeId: rt.WIFI_TYPE,
    fields: new Map([[2, 'SSID'], [4, 'pass'], [6, 2], [9, 'unknown optional field']]),
  },
]);

// A CBOR-tagged item is no longer valid Record syntax at all: key 0 is the
// sole routing mechanism (§3.1; the tag route was removed, see
// docs/FINDINGS.md #11-#12). A tag wrapping a Record is just malformed
// input now, not an alternate route to unwrap.
const taggedMap = new Map([[0, 100], [2, 'SSID'], [4, 'pass'], [6, 2]]);
const taggedBytes = cbor.encode(new cbor.Tagged(100, taggedMap));
const taggedItemIsMalformedContainer = Buffer.concat([core.MAGIC, Buffer.from([core.VERSION]), taggedBytes]);

// Missing key 0 entirely.
const noKey0Map = new Map([[2, 'SSID']]);
const noKey0Bytes = cbor.encode(noKey0Map);
const noKey0Container = Buffer.concat([core.MAGIC, Buffer.from([core.VERSION]), noKey0Bytes]);

// Two records in one sequence: first aborts (unknown even key), second is fine.
const twoRecordContainer = core.encodeContainer([
  { typeId: rt.WIFI_TYPE, fields: new Map([[2, 'SSID'], [4, 'pass'], [6, 2], [8, 'unknown critical']]) },
  { typeId: rt.TAGDROP_REGISTRATION_TYPE, fields: new Map([[2, Buffer.from('sibling record')]]) },
]);

// §3.2's field-value-shape rule: a field value that's a bare CBOR array
// (major type 4) instead of a scalar or definite-length string. Key 11 is
// odd/optional — if the shape rule didn't exist, an unaware decoder would
// just ignore it as an unrecognized optional key. It must instead be
// rejected outright, because the decoder can't even determine this
// Record's byte length without walking into the array's structure.
const disallowedArrayValueMap = new Map([[0, 100], [2, 'SSID'], [4, 'pass'], [6, 2], [11, [1, 2, 3]]]);
const disallowedArrayValueContainer = Buffer.concat([
  core.MAGIC,
  Buffer.from([core.VERSION]),
  cbor.encode(disallowedArrayValueMap),
]);

// The *correct* way to carry structured content under the field-value-shape
// rule: pre-encode it as CBOR and wrap the encoded bytes in a definite-
// length byte string. The outer decoder skips it as opaque bytes at O(1)
// cost, never recursing into it; a Record-Type-specific handler that wants
// the structure back decodes the byte string's contents itself.
const nestedAuthMethods = cbor.encode(['WPA2', 'WPA3']);
const byteStringWrappedValueMap = new Map([
  [0, 100],
  [2, 'SSID'],
  [4, 'pass'],
  [6, 2],
  [11, nestedAuthMethods], // odd/optional key, opaque nested CBOR payload
]);
const byteStringWrappedValueContainer = Buffer.concat([
  core.MAGIC,
  Buffer.from([core.VERSION]),
  cbor.encode(byteStringWrappedValueMap),
]);

// §3.2's field-value-shape rule, revised per GitHub issue #8: a field
// value MAY be CBOR tag 24 ("encoded CBOR data item", RFC 8949 §3.4.5.1)
// wrapping a definite-length byte string directly — skip-safe in exactly
// two fixed header reads, no recursion — rather than requiring the extra
// indirection of a bare byte string with no outer marker that it happens
// to contain further CBOR. This is the more standard, more discoverable
// form: generic CBOR tooling (not just QDEF-aware decoders) can tell from
// the tag alone that this field's bytes are re-parseable, without needing
// out-of-band schema knowledge.
const tag24WrappedValueMap = new Map([
  [0, 100],
  [2, 'SSID'],
  [4, 'pass'],
  [6, 2],
  [11, new cbor.Tagged(24, nestedAuthMethods)], // odd/optional key
]);
const tag24WrappedValueContainer = Buffer.concat([
  core.MAGIC,
  Buffer.from([core.VERSION]),
  cbor.encode(tag24WrappedValueMap),
]);

// The bound that keeps the tag-24 case from reopening unbounded recursion:
// tag 24 MUST wrap a definite-length string *directly*, never another tag.
// Nesting it — tag 24 wrapping tag 24 wrapping the real bytes — is exactly
// as disallowed as a bare array; the decoder checks the inner shape once,
// inline, rather than calling back into itself, so this MUST be rejected
// outright rather than silently accepted at unbounded depth.
const nestedTag24Map = new Map([
  [0, 100],
  [2, 'SSID'],
  [4, 'pass'],
  [6, 2],
  // Genuine tag-directly-wraps-tag nesting (tag 24's immediately-following
  // item is itself a tag, not a byte string) — not to be confused with a
  // byte string whose own re-decoded *contents* happen to be tag-24'd,
  // which is a different, still-allowed shape (opaque bytes, contents
  // never inspected by the outer skip).
  [11, new cbor.Tagged(24, new cbor.Tagged(24, nestedAuthMethods))],
]);
const nestedTag24Container = Buffer.concat([
  core.MAGIC,
  Buffer.from([core.VERSION]),
  cbor.encode(nestedTag24Map),
]);

// Widened per FINDINGS.md #16: any tag number is allowed, not just 24 —
// the content-shape check (definite-length string, directly) is what
// makes a tag skip-safe, and that holds regardless of which tag number is
// on the wire. Tag 0 ("standard date/time string") wrapping a definite-
// length text string is a real, IANA-registered tag, genuinely
// scalar-shaped by its own RFC 8949 definition — now accepted, same as
// tag 24 was.
const otherTagWrappedValueMap = new Map([
  [0, 100],
  [2, 'SSID'],
  [4, 'pass'],
  [6, 2],
  [11, new cbor.Tagged(0, '2026-07-10T12:00:00Z')],
]);
const otherTagWrappedValueContainer = Buffer.concat([
  core.MAGIC,
  Buffer.from([core.VERSION]),
  cbor.encode(otherTagWrappedValueMap),
]);

// The other half of the bound: it's the *content shape*, not the tag
// number, that's checked — a real, IANA-registered tag whose own RFC 8949
// definition genuinely requires array content stays rejected regardless.
// Tag 4 ("decimal fraction") wraps a 2-element array [exponent, mantissa]
// by definition; here [-2, 27315] means 273.15 — a real, plausible value,
// not a contrived one, still MUST be rejected, since its content isn't a
// string at all.
const structuredTagWrappedValueMap = new Map([
  [0, 100],
  [2, 'SSID'],
  [4, 'pass'],
  [6, 2],
  [11, new cbor.Tagged(4, [-2, 27315])],
]);
const structuredTagWrappedValueContainer = Buffer.concat([
  core.MAGIC,
  Buffer.from([core.VERSION]),
  cbor.encode(structuredTagWrappedValueMap),
]);

// A 64-bit-class private-use Type ID (§3.1, §9's `0x10000`+ tier) — needs
// BigInt in JS, since it exceeds Number.MAX_SAFE_INTEGER. Found checking
// against a real adopter (TagDrop, using the tier exactly as recommended):
// the `cbor` package's plain encode() wraps every BigInt in CBOR tag 2
// (bignum) regardless of magnitude, which would violate §3.1/§3.2 for
// key 0 specifically. core.encodeRecordBytes (via encodeCanonical) does
// not have this bug — verified — but this fixture exists so the Rust
// decoder is proven against a real large Type ID, not just assumed to
// handle the full uint64 range correctly. See docs/FINDINGS.md #14.
const largeTypeIdContainer = core.encodeContainer([
  { typeId: 2n ** 64n - 1n, fields: new Map([[2, 'private-use content']]) },
]);

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
console.log(rustBytes('TAGGED_ITEM_IS_MALFORMED_CONTAINER', taggedItemIsMalformedContainer));
console.log();
console.log(rustBytes('MISSING_KEY0_CONTAINER', noKey0Container));
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
