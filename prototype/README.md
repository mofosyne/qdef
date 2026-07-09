# QDEF round-trip prototype

A throwaway Node.js implementation used to prove out
[`docs/QDEF-SPEC.md`](../docs/QDEF-SPEC.md) by actually encoding and
decoding QDEF bytes — not a reference library, not meant to be published or
depended on. See [`docs/FINDINGS.md`](../docs/FINDINGS.md) for what it
found.

## Layout

- `src/core.js` — the mandatory core: magic/version framing, CBOR-Sequence
  encode/decode, `map[0]` routing, the even/odd criticality rule
  (spec §2–§3). No knowledge of any specific Record Type.
- `src/wrappers.js` — the optional standard library's Wrapper Records:
  Split (with XOR single-fragment parity), Compress, Encrypt, plus a
  generic recursive `resolveStack` resolver (spec §4.1).
- `src/recordTypes.js` — the small set of application Record Type schemas
  used by the tests (Wi-Fi §5, a generic third-party-payload registration
  §6, a secret-key backup §8).
- `test/roundtrip.test.js` — the four required scenarios: a plain Record,
  a Record wrapping an opaque third-party payload, the full
  Split(parity)→Encrypt→plain stack with fragment-drop recovery, and the
  even/odd criticality rule.
- `test/core.test.js` — Hardware Parity dual-routing edge cases (tag/key-0
  agreement, disagreement, and tag-less encoding), the NDEF no-magic path,
  and the streaming-decode claim.
- `test/nesting-order.test.js` — whether a generic decoder can detect a
  non-conformant Wrapper nesting order (spec finding: it can't).

## Running

```sh
npm install
npm test
```

Uses Node's built-in test runner (`node --test`, Node 18+) — no test
framework dependency beyond the `cbor` package itself.
