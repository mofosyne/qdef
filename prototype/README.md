# QDEF round-trip prototype

A throwaway Node.js implementation used to prove out
[`docs/QDEF-SPEC.md`](../docs/QDEF-SPEC.md) by actually encoding and
decoding QDEF bytes — not a reference library, not meant to be published or
depended on. See [`docs/FINDINGS.md`](../docs/FINDINGS.md) for what it
found.

## Layout

- `src/core.js` — the mandatory core: magic framing, the unified root/
  subrecord Record grammar (the container root is an ordinary Record,
  one self-delimited CBOR array — the identical shape a subrecord
  already uses, no separate discriminator item), per-Record prefix
  typeID recognition (optional on the wire, defaulting to `0`/Bundle
  when omitted; a bare uint, or a namespace-pairing array), the
  optional payload slot, and the even/odd criticality rule (spec §2–§3).
  `recordToItems` (the encoder's shared internals) requires `typeId` as
  an explicit argument regardless — a decoder-only choice, not a wire
  one: the decoder stays forgiving of any encoder's output that omits
  it, but this reference encoder won't produce that omission by
  accident (see docs/DESIGN.md's "Encoder-enforced explicit typeId").
  Payload is further restricted to a byte string or a text string only
  (no scalar, map, or tag), and REQUIRES a nonzero `typeId` -- a Bundle
  (`typeId: 0`) can never carry a payload, closing a real silent-
  data-loss bug the same way (see docs/DESIGN.md's payload-narrowing
  entries). No knowledge of any specific Record Type. Encodes every Record with
  RFC 8949 §4.2.1 canonical CBOR (spec §3.4), not just whatever the
  `cbor` package's default encoder happens to produce.
- `src/header.js` — interprets a Record's namespace declaration (spec
  §3.5): namespace parsing, namespace-Hint hash-derivation verification,
  and Type ID lookup-key resolution (even = always global, odd = requires
  a declared namespace, with a per-Record namespace-pairing override).
  Record-Type-interpretation-specific handling, never a mandatory-core
  concern — `core.js` needs zero namespace knowledge to do its job.
- `src/wrappers.js` — the optional standard library's Wrapper Records:
  Split (with XOR single-fragment parity), Compress, Encrypt, plus a
  generic recursive `resolveStack` resolver (spec §4.1). Also carries the
  non-wrapper standard record types' constants: Open/Hint URI (§4.2), Media
  Payload (§4.3), and App Route (§4.4), plus the COSE (RFC 9053/9054) and
  CoAP Content-Format (RFC 7252/9876) IDs the latter two borrow rather
  than invent.
- `src/recordTypes.js` — the small set of application Record Type schemas
  used by the tests (Wi-Fi §5, a generic third-party-payload registration
  §6, a secret-key backup §8).
- `scripts/gen-type-id.js` / `scripts/validate-type-id.js` — derive and
  verify a hash-derived Namespace ID from a name (spec §3.5). Decentralized
  Record Type IDs no longer exist as a mechanism, so these are
  namespace-only now.
- `scripts/qdef-lint.js` — a standalone, dependency-free grammar-and-
  footgun checker for arbitrary QDEF bytes from *any* encoder, not just
  this prototype's own (`node scripts/qdef-lint.js [--no-magic]
  <file|hex>`). Two separate layers: grammar checking (well-formed per
  §3.1/§2, no Record-Type semantics, mirroring `rust/qdef-core`'s own
  CBOR primitives so the algorithm — not this specific JS — is what's
  meant to be portable) and footgun checking (patterns that are legal
  CBOR but almost certainly a mistake, each traced to a real bug in
  `docs/FINDINGS.md`, not invented for this tool). Considered and
  rejected: a CDDL schema instead of a hand-written checker — the
  standard Rust `cddl` implementation (two major versions tested)
  can't correctly validate an array with more than one optional slot
  occupied, which is QDEF's normal case, not an edge case; see
  `docs/FINDINGS.md`.
- `scripts/gen-rust-fixtures.js` — generates `rust/qdef-core/src/fixtures.rs`
  from this prototype's own canonical encoder, so the independently
  hand-rolled Rust decoder is cross-validated against independently
  produced bytes, not just self-consistency.
- `test/roundtrip.test.js` — the four required scenarios: a plain Record,
  a Record wrapping an opaque third-party payload, the full
  Split(parity)→Encrypt→plain stack with fragment-drop recovery, and the
  even/odd criticality rule.
- `test/core.test.js` — Record Type ID routing edge cases, the NDEF
  no-magic path, the streaming-decode claim, and the self-delimited
  root's actual guarantee: bytes appended after the root array, valid
  CBOR or not, are provably ignored on both the magic and NDEF/own-URI
  paths.
- `test/header.test.js` — root/subrecord namespace recognition and
  graceful degrade, namespace-Hint hash-derivation verification, and
  namespace-scoped Type ID lookup-key resolution.
- `test/record-namespace-pairing.test.js` — the per-Record
  namespace-pairing prefix item (spec §3.1/§3.5): overriding the
  container's ambient namespace for one Record, and the byte-cost
  comparison against a bare typeID.
- `test/multi-code-namespace.test.js` — namespace consistency checking
  across a multi-code Split group via `resolveStack`.
- `test/custom-scheme-carrier.test.js` — the implied-namespace pattern
  for an isolated carrier (own URI scheme / own NDEF MIME type): a
  namespace fixed by the carrier itself, never transmitted.
- `test/nested-field-values.test.js` — §3.2's field-value-shape rule
  relaxation: a field value may be any well-formed CBOR item now (bare
  arrays, nested maps, multi-level nesting), and criticality is
  unaffected by value shape.
- `test/nesting-order.test.js` — whether a generic decoder can detect a
  non-conformant Wrapper nesting order (spec finding: it can't).
- `test/encrypt-algorithm.test.js` — Encrypt's optional Algorithm/Key
  Algorithm fields (keys 5/7, spec §4.1): both COSE-numeric and
  plain-string forms round-trip, and a decoder built before these fields
  existed ignores them via the ordinary odd-key path rather than aborting.
- `test/canonical-encoding.test.js` — proves §3.4's actual point: Records
  built from the same fields in different insertion order encode to
  byte-identical output, so a content hash like `group_id` means "same
  logical content" across independent encoders, not just "same encoder,
  same run."
- `test/open-hint-uri.test.js` — Open/Hint URI (Type 10, spec §4.2):
  language/action fields, and graceful degrade for a decoder that
  doesn't recognize them.
- `test/media-payload.test.js` — Media Payload's (Type 6, spec §4.3)
  Media Type field in both forms (a CoAP Content-Format uint, and the
  plain-MIME-string fallback using `text/vcard` — confirmed genuinely
  absent from that registry, not a hypothetical fixture), and that an
  application with no interest in it skips the whole Record by Type ID
  alone, same as any other unrecognized Type.
- `test/large-type-id.test.js` — a real ~64-bit private-use Type ID
  (§3.1, §9's `0x10000`+ tier) encodes as a native uint, never a CBOR
  bignum tag, locking in a real bug found checking against a real adopter
  (`cbor.encode()`'s BigInt handling — see FINDINGS.md #14) rather than
  leaving it as an unverified side effect of an unrelated change.
- `test/app-route.test.js` — App Route (Type 7, spec §4.4): round-trips
  with and without the optional label, isn't positionally special, skips
  cleanly for an application with no interest in it, and — since it's
  meant to repeat verbatim across every code in a multi-code group —
  proves two independent encodes of the same fields produce byte-
  identical output (relying on §3.4's canonical encoding, not assuming
  it holds).
- `test/bundle.test.js` — Bundle (Type 0, spec §4.6): round-trips with
  the empty map omitted, an unaware decoder skips the whole Bundle (and
  its subrecords) by Type ID alone, and it scopes a namespace override
  across its subrecords without repeating it on each one.
- `test/payload-byte-cost.test.js` — the payload slot's (§3.1) actual
  savings for the three shipped Wrapper Records, verified against the
  encoder rather than assumed uniform: Compress saves 2 bytes (its map
  is dropped entirely), Encrypt and Split each save exactly 1 (their
  maps still hold other fields).
- `test/payload-shape.test.js` — payload's shape restriction (byte
  string or text string only -- a scalar or map-shaped payload is
  rejected outright, closing a real bug where either used to be
  silently misread as typeId or namespace and lost) and the flat rule
  that a payload requires a nonzero typeId (a Bundle can never carry
  one, namespace or not).
- `test/qdef-lint.test.js` — `scripts/qdef-lint.js`'s two layers: every
  shape the real encoder produces lints clean (including the two shapes
  that ruled out a "namespace present, typeId absent" footgun check —
  it's undecidable from bytes alone and the common case is correct, not
  a mistake), each footgun fires exactly once (not duplicated — a real
  bug caught during development, since `skipAnyItem` both bounds items
  *and* audits their canonical encoding as a side effect), and
  genuinely malformed CBOR degrades to a clean error, not a crash.

## Running

```sh
npm install
npm test
```

Uses Node's built-in test runner (`node --test`, Node 18+) — no test
framework dependency beyond the `cbor` package itself.
