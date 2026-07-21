# QDEF round-trip prototype

A throwaway Node.js implementation used to prove out
[`docs/QDEF-SPEC.md`](../docs/QDEF-SPEC.md) by actually encoding and
decoding QDEF bytes — not a reference library, not meant to be published or
depended on. See [`docs/FINDINGS.md`](../docs/FINDINGS.md) for what it
found.

## Layout

- `src/core.js` — the mandatory core: magic framing, the mandatory
  container discriminator, CBOR-Sequence encode/decode, per-Record
   prefix typeID recognition (a bare uint, or a namespace-pairing array),
   the optional payload slot, and the even/odd criticality rule (spec
   §2–§3). No knowledge of any specific Record Type. Encodes every Record
   with RFC 8949 §4.2.1 canonical CBOR (spec §3.4), not just whatever the
   `cbor` package's default encoder happens to produce.
- `src/header.js` — interprets the container discriminator (spec §3.5):
  namespace parsing, namespace-Hint hash-derivation verification, and
  Type ID lookup-key resolution (even = always global, odd = requires a
  declared namespace, with a per-Record namespace-pairing override).
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
- `scripts/gen-rust-fixtures.js` — generates `rust/qdef-core/src/fixtures.rs`
  from this prototype's own canonical encoder, so the independently
  hand-rolled Rust decoder is cross-validated against independently
  produced bytes, not just self-consistency.
- `test/roundtrip.test.js` — the four required scenarios: a plain Record,
  a Record wrapping an opaque third-party payload, the full
  Split(parity)→Encrypt→plain stack with fragment-drop recovery, and the
  even/odd criticality rule.
- `test/core.test.js` — Record Type ID routing edge cases, the NDEF
  no-magic path, and the streaming-decode claim.
- `test/header.test.js` — the container discriminator's recognized
  shapes and graceful degrade, namespace-Hint hash-derivation
  verification, and namespace-scoped Type ID lookup-key resolution.
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

## Running

```sh
npm install
npm test
```

Uses Node's built-in test runner (`node --test`, Node 18+) — no test
framework dependency beyond the `cbor` package itself.
