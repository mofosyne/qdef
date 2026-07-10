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
  generic recursive `resolveStack` resolver (spec §4.1).
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

## Running

```sh
npm install
npm test
```

Uses Node's built-in test runner (`node --test`, Node 18+) — no test
framework dependency beyond the `cbor` package itself.
