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
    typeId: rt.WIFI_TYPE,
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
    typeId: rt.WIFI_TYPE,
    fields: new Map([[0, 'SSID'], [2, 'pass'], [4, 2], [6, 'unknown critical field']]),
  },
]);

// --- Even/odd criticality: unknown odd key is silently ignored ---

const wifiUnknownOddKeyContainer = core.encodeContainer([
  {
    typeId: rt.WIFI_TYPE,
    fields: new Map([[0, 'SSID'], [2, 'pass'], [4, 2], [7, 'unknown optional field']]),
  },
]);

// --- Record with no typeID prefix: ignored (not routed) ---
// Manually constructed (not via encodeContainer) to keep the mandatory
// discriminator explicit here: uint 0 (no namespace), then a Record
// array whose own first (and only) element is a bare map, with nothing
// namespace/typeId-shaped before it.

const noTypeidDiscBytes = cbor.encodeCanonical(0);
const noTypeidBytes = cbor.encodeCanonical([new Map([[0, 'SSID']])]);
const noTypeidContainer = Buffer.concat([core.MAGIC, noTypeidDiscBytes, noTypeidBytes]);

// --- Bare NDEF/own-URI-scheme sequence: no magic, no discriminator ---
// Built directly via encodeRecordBytes (bypassing encodeContainer entirely),
// since that carrier already supplies its own dispatch/isolation and never
// carries a magic or a discriminator item (§ own-URI-scheme carriers).

const bareSequenceNoDiscriminator = core.encodeRecordBytes({
  typeId: rt.WIFI_TYPE,
  fields: new Map([[0, 'SSID'], [2, 'pass'], [4, 2], [1, true]]),
});

// --- Two records in one sequence: first aborts (unknown even key), second is fine ---

const twoRecordContainer = core.encodeContainer([
  { typeId: rt.WIFI_TYPE, fields: new Map([[0, 'SSID'], [2, 'pass'], [4, 2], [6, 'unknown critical']]) },
  { typeId: rt.TAGDROP_REGISTRATION_TYPE, fields: new Map([[0, Buffer.from('sibling record')]]) },
]);

// --- §3.2's field-value-shape rule was dropped: a bare CBOR array ---
// (major type 4) as a field value, previously disallowed outright, is now
// a perfectly legal field value -- skip-safe via the same bounded
// explicit stack (`skip_any_item`) prefix items already used. Key 11 is
// odd/optional, but that no longer matters for shape purposes -- there
// is no shape restriction left to apply to any key, even or odd.

const arrayValueContainer = core.encodeContainer([
  {
    typeId: rt.WIFI_TYPE,
    fields: new Map([[0, 'SSID'], [2, 'pass'], [4, 2], [9, [1, 2, 3]]]),
  },
]);

// --- Structured content as an opaque byte string: still a legal, ---
// useful pattern (not the *only* legal one anymore) -- pre-encode as CBOR
// and wrap the encoded bytes in a definite-length byte string when the
// content is meant to be handled as an opaque blob by an outer decoder
// and only decoded by a Record-Type-specific handler that wants it.

const nestedAuthMethods = cbor.encode(['WPA2', 'WPA3']);
const byteStringWrappedValueContainer = core.encodeContainer([
  {
    typeId: rt.WIFI_TYPE,
    fields: new Map([
      [0, 'SSID'],
      [2, 'pass'],
      [4, 2],
      [9, nestedAuthMethods], // odd/optional key, opaque nested CBOR payload
    ]),
  },
]);

// --- CBOR tag 24 ("encoded CBOR data item", RFC 8949 §3.4.5.1) wrapping ---
// a definite-length byte string directly: still a legal field value,
// exactly as before -- unaffected by the shape rule's removal, since it
// was already legal under the old rule too.

const tag24WrappedValueContainer = core.encodeContainer([
  {
    typeId: rt.WIFI_TYPE,
    fields: new Map([
      [0, 'SSID'],
      [2, 'pass'],
      [4, 2],
      [9, new cbor.Tagged(24, nestedAuthMethods)],
    ]),
  },
]);

// --- A tag directly wrapping another tag: previously disallowed under ---
// the old field-value-shape rule (shape checked once, inline, never
// walked recursively). Now legal: `skip_any_item`'s bounded explicit
// stack already supported nested tags for prefix items (unknown-item
// skipping), and field values now use the identical mechanism -- nesting
// depth is bounded by this decoder's own MAX_DEPTH, not rejected outright
// at any depth.

const nestedTag24Container = core.encodeContainer([
  {
    typeId: rt.WIFI_TYPE,
    fields: new Map([
      [0, 'SSID'],
      [2, 'pass'],
      [4, 2],
      [9, new cbor.Tagged(24, new cbor.Tagged(24, nestedAuthMethods))],
    ]),
  },
]);

// --- Any tag number is allowed, not just 24 -- unaffected by the shape ---
// rule's removal, this was already true before it (FINDINGS.md #16). Tag
// 0 ("standard date/time string") wrapping a definite-length text string
// is a real, IANA-registered tag.

const otherTagWrappedValueContainer = core.encodeContainer([
  {
    typeId: rt.WIFI_TYPE,
    fields: new Map([
      [0, 'SSID'],
      [2, 'pass'],
      [4, 2],
      [9, new cbor.Tagged(0, '2026-07-10T12:00:00Z')],
    ]),
  },
]);

// --- A real tag whose own definition requires array content: previously ---
// disallowed under the old field-value-shape rule (a tag had to wrap a
// definite-length string directly). Now legal: tag content may be any
// well-formed CBOR item. Tag 4 ("decimal fraction") wraps a 2-element
// array [exponent, mantissa] by definition; here [-2, 27315] means
// 273.15.

const structuredTagWrappedValueContainer = core.encodeContainer([
  {
    typeId: rt.WIFI_TYPE,
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
  { typeId: 2n ** 64n - 1n, fields: new Map([[0, 'private-use content']]) },
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
  [{ typeId: rt.WIFI_TYPE, fields: new Map([[0, 'SSID'], [2, 'pass'], [4, 2]]) }],
  Buffer.from('a9d6e1f30b7c4482', 'hex'),
);

// --- A byte string with nothing valid typeId-shaped following it: not ---
// recognized as a namespace, and there is no other legal bare typeId
// shape a byte string could be -- this Record loses its only typeID and
// ends up unroutable (ignored). Built directly (encodeRecordBytes has no
// way to omit typeId) to keep the fixture's intent explicit: a bare byte
// string immediately followed by a map, nothing else.

const byteStringTypeIdBytes = cbor.encodeCanonical([
  Buffer.from('A7F90B3C', 'hex'),
  new Map([[0, 'decentralized payload']]),
]);
const byteStringTypeIdContainer = Buffer.concat([
  core.MAGIC,
  cbor.encodeCanonical(0),
  byteStringTypeIdBytes,
]);

// --- A second typeID-shaped item after the primary: not accumulated ---
// There is no backup-typeID mechanism anymore (docs/FINDINGS.md) -- at
// most one typeID-bearing item per Record. A second uint immediately
// following the primary, with no map before it, is read as this
// Record's own payload (§3.1's payload slot now accepts any CBOR
// shape) -- not accumulated as a "backup" typeID.

const secondTypeIdNotAccumulatedBytes = cbor.encodeCanonical([
  rt.WIFI_TYPE,
  900, // would have been a backup, once -- now just this Record's payload
]);
const secondTypeIdNotAccumulatedContainer = Buffer.concat([
  core.MAGIC,
  cbor.encodeCanonical(0),
  secondTypeIdNotAccumulatedBytes,
]);

// --- Namespace prefix (§3.1) ---
// A Record's own array MAY lead with a byte string namespace immediately
// followed by its typeId, independent of the container discriminator's
// ambient one. Purely structural for the mandatory core: it only needs
// to recognize "byte string, then a valid typeId" at the front of the
// array, never learn what a namespace means. This fixture pairs a
// decentralized (byte-string) namespace with a scoped (odd) typeId.

const namespacePairingContainer = core.encodeContainer([
  {
    typeId: 1,
    fields: new Map([[0, 'payload']]),
    localNamespace: Buffer.from('cdcdcdcd', 'hex'),
  },
]);

// --- A uint where a namespace was intended: read directly as this ---
// Record's own typeID instead. Namespace recognition requires the
// array's first element to be a byte string; a uint there is
// unconditionally valid typeID shape on its own, so there is no
// "malformed namespace" state left over -- it's simply this Record's
// typeID (100), and the originally-intended typeID (1) becomes a
// skipped stray item.

const uintNamespaceSlotUnrecognizedContainer = core.encodeContainer([
  {
    typeId: 1,
    fields: new Map([[0, 'payload']]),
    localNamespace: 100,
  },
]);

// --- Namespace prefix with a scoped typeId, a map, AND a real payload ---
// value -- proves Rust's decoder actually extracts a *present* payload's
// bytes correctly (not just that it's None), stacked with a namespace
// override and an ordinary field map. Every other Rust payload test
// before this one only ever asserted absence.

const namespacePairingWithPayloadContainer = core.encodeContainer([
  {
    typeId: 1,
    fields: new Map([[0, 'field, not payload']]),
    payload: Buffer.from('real payload bytes'),
    localNamespace: Buffer.from('cdcdcdcd', 'hex'),
  },
]);

// --- Record with map only, no payload ---

const plainMapOnlyContainer = core.encodeContainer([
  {
    typeId: rt.WIFI_TYPE,
    fields: new Map([[0, 'SSID'], [2, 'pass'], [4, 2]]),
  },
]);

// --- Payload with no map at all (the shipped Wrapper Type shape, e.g. ---
// Compress: `[8, h'<deflate bytes>']`, no map because there's nothing
// else to put in one) -- proves Rust correctly treats the item right
// after typeId as payload, not as a stray forward-compat item, when no
// map precedes it.

const payloadOnlyNoMapContainer = core.encodeContainer([
  {
    typeId: 8,
    payload: Buffer.from('deflate-style opaque bytes'),
  },
]);

// --- Map, payload, AND subrecords all present on the same Record -- the ---
// full grammar in one shot (§3.1's actual shipped Wrapper-Record-plus-
// Media-Preview-subrecord pattern, e.g. Compress wrapping content with
// Media Preview identification riding along), not each piece tested in
// isolation.

const mapPayloadAndSubrecordsContainer = core.encodeContainer([
  {
    typeId: 8,
    fields: new Map([[9, 'not the compress key -- just an ordinary field']]),
    payload: Buffer.from('deflate-style opaque bytes'),
    subrecords: [{ typeId: 14, fields: new Map([[0, 'image/png']]) }],
  },
]);

// --- Subrecords (§3.1's generalized `ID[]{}` shape) ---
// Every Record is now exactly one self-delimited CBOR array; everything
// past its own field Map, for the rest of that array, is itself a
// nested Record, recursively the same grammar -- no separate wrapper
// array needed. Resolves the TagDrop Media Preview/Payload correlation
// problem without relying on Record position. See docs/DESIGN.md and
// docs/FINDINGS.md.

const subrecordsContainer = core.encodeContainer([
  {
    typeId: 20,
    fields: new Map([[0, 'image/png']]),
    subrecords: [{ typeId: 2, fields: new Map([[0, Buffer.from('fragment')]]) }],
  },
]);

// --- Subrecords: a subrecord may itself carry a namespace and its own ---
// further subrecords -- the same grammar, applied recursively, not a
// reduced one.

const subrecordsWithNamespaceContainer = core.encodeContainer([
  {
    typeId: 21,
    fields: new Map(),
    subrecords: [
      {
        typeId: 1,
        localNamespace: Buffer.from('cdcdcdcd', 'hex'),
        fields: new Map([[0, 'payload']]),
        subrecords: [{ typeId: 22, fields: new Map([[0, 'leaf']]) }],
      },
    ],
  },
]);

// --- Subrecords: every Record is self-bounded by its own array, so a ---
// Record with subrecords followed by a plain sibling Record never bleed
// into each other -- no position-dependent boundary logic is needed
// anywhere anymore.

const subrecordsSiblingContainer = core.encodeContainer([
  {
    typeId: 23,
    fields: new Map([[0, 'A']]),
    subrecords: [{ typeId: 2, fields: new Map([[0, 1]]) }],
  },
  { typeId: 1, localNamespace: Buffer.from('cdcdcdcd', 'hex'), fields: new Map([[0, 'B']]) },
]);

// --- Record-shaped payload (§3.1's generalized payload shape rule): ---
// Media Preview (14) with its payload slot -- not a subrecord -- holding
// a nested Media Payload (6) Record directly. Proves the payload slot
// accepts major type 4 (array), decoded recursively as a nested Record.

const recordShapedPayloadContainer = core.encodeContainer([
  {
    typeId: 14,
    fields: new Map([[0, 'image/png']]),
    payload: { typeId: 6, fields: new Map([[0, 'image/png']]), payload: Buffer.from('jpeg bytes') },
  },
]);

// --- Map-shaped payload, no other fields: the encoder auto-inserts an ---
// empty field Map ahead of it, since major type 5 right after typeId is
// otherwise always the field Map, never the payload (§3.1's map-shape
// carve-out).

const mapShapedPayloadNoFieldsContainer = core.encodeContainer([
  { typeId: 20, payload: new Map([[1, 'arbitrary map-shaped payload value']]) },
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
console.log(rustBytes('ARRAY_VALUE_CONTAINER', arrayValueContainer));
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
console.log(rustBytes('BYTE_STRING_TYPE_ID_UNRECOGNIZED_CONTAINER', byteStringTypeIdContainer));
console.log();
console.log(rustBytes('SECOND_TYPE_ID_NOT_ACCUMULATED_CONTAINER', secondTypeIdNotAccumulatedContainer));
console.log();
console.log(rustBytes('NAMESPACE_PAIRING_CONTAINER', namespacePairingContainer));
console.log();
console.log(rustBytes('UINT_NAMESPACE_SLOT_UNRECOGNIZED_CONTAINER', uintNamespaceSlotUnrecognizedContainer));
console.log();
console.log(rustBytes('NAMESPACE_PAIRING_WITH_PAYLOAD_CONTAINER', namespacePairingWithPayloadContainer));
console.log();
console.log(rustBytes('PLAIN_MAP_ONLY_CONTAINER', plainMapOnlyContainer));
console.log();
console.log(rustBytes('PAYLOAD_ONLY_NO_MAP_CONTAINER', payloadOnlyNoMapContainer));
console.log();
console.log(rustBytes('MAP_PAYLOAD_AND_SUBRECORDS_CONTAINER', mapPayloadAndSubrecordsContainer));
console.log();
console.log(rustBytes('SUBRECORDS_CONTAINER', subrecordsContainer));
console.log();
console.log(
  rustBytes('SUBRECORDS_WITH_NAMESPACE_CONTAINER', subrecordsWithNamespaceContainer),
);
console.log();
console.log(rustBytes('SUBRECORDS_SIBLING_CONTAINER', subrecordsSiblingContainer));
console.log();
console.log(rustBytes('RECORD_SHAPED_PAYLOAD_CONTAINER', recordShapedPayloadContainer));
console.log();
console.log(rustBytes('MAP_SHAPED_PAYLOAD_NO_FIELDS_CONTAINER', mapShapedPayloadNoFieldsContainer));
