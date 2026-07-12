# QDEF round-trip prototype

A throwaway Node.js implementation used to prove out
[`docs/QDEF-SPEC.md`](../docs/QDEF-SPEC.md) by actually encoding and
decoding QDEF bytes — not a reference library, not meant to be published or
depended on. See [`docs/FINDINGS.md`](../docs/FINDINGS.md) for what it
found.

## Layout

- `src/core.js` — the mandatory core: magic/version framing, CBOR-Sequence
  encode/decode, `map[0]` routing, the even/odd criticality rule
  (spec §2–§3). No knowledge of any specific Record Type. Encodes every
  Record with RFC 8949 §4.2.1 canonical CBOR (spec §3.4), not just
  whatever the `cbor` package's default encoder happens to produce.
- `src/wrappers.js` — the optional standard library's Wrapper Records:
  Split (with XOR single-fragment parity), Compress, Encrypt, plus a
  generic recursive `resolveStack` resolver (spec §4.1). Also carries the
  non-wrapper stdlib Record Types' constants: Fallback Hint (§4.2), Media
  Payload (§4.3), and App Route (§4.4), plus the COSE (RFC 9053/9054) and
  CoAP Content-Format (RFC 7252/9876) IDs the latter two borrow rather
  than invent.
- `src/recordTypes.js` — the small set of application Record Type schemas
  used by the tests (Wi-Fi §5, a generic third-party-payload registration
  §6, a secret-key backup §8).
- `src/typeHint.js` — the optional, self-certifying strengthening for
  key 1's Type Hint (spec §3.1): deriving a private-use-random Type ID from
  a truncated hash of its own name, and opportunistically verifying that
  binding without needing a version marker.
- `test/roundtrip.test.js` — the four required scenarios: a plain Record,
  a Record wrapping an opaque third-party payload, the full
  Split(parity)→Encrypt→plain stack with fragment-drop recovery, and the
  even/odd criticality rule.
- `test/core.test.js` — Record Type ID routing edge cases (missing key 0,
  a CBOR-tagged item as malformed input now that key 0 is the sole
  routing mechanism), the NDEF no-magic path, and the streaming-decode
  claim.
- `test/nesting-order.test.js` — whether a generic decoder can detect a
  non-conformant Wrapper nesting order (spec finding: it can't).
- `test/type-hint.test.js` — proves key 1 needs zero special-case code in
  the core (a decoder that's never heard of Type Hint just skips it via
  the ordinary unrecognized-odd-key path), the old-reader/promoted-Type
  recognition scenario, and the hash-derivation verify/degrade behavior.
- `test/encrypt-algorithm.test.js` — Encrypt's optional Algorithm/Key
  Algorithm fields (keys 5/7, spec §4.1): both COSE-numeric and
  plain-string forms round-trip, and a decoder built before these fields
  existed ignores them via the ordinary odd-key path rather than aborting.
- `test/canonical-encoding.test.js` — proves §3.4's actual point: Records
  built from the same fields in different insertion order encode to
  byte-identical output, so a content hash like `group_id` means "same
  logical content" across independent encoders, not just "same encoder,
  same run."
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

## Running

```sh
npm install
npm test
```

Uses Node's built-in test runner (`node --test`, Node 18+) — no test
framework dependency beyond the `cbor` package itself.
