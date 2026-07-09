# QDEF — Quick Data Exchange Format

**Status: Draft. Validated by two throwaway prototypes — a Node round-trip
prototype covering the full design ([`/prototype`](../prototype)) and a
`no_std`, zero-dependency Rust prototype of the mandatory core specifically
([`/rust/qdef-core`](../rust/qdef-core)), which also builds for a bare-metal
Cortex-M0 target (see [FINDINGS.md](FINDINGS.md)); not yet implemented as a
reference library, not yet used in production anywhere.**

QDEF is a general-purpose binary container for multi-action 2D barcodes
(QR, Data Matrix, Aztec) and NFC tags. Think of it as filling the gap NDEF
already fills for NFC — "here are one or more typed records in one
tap/scan" — but for the byte-mode payload of an optical code, or for an NFC
payload with no existing MIME type doing the routing. No equivalent exists
today: text barcode schemas (`WIFI:S:...;;`, `BEGIN:VCARD`) are rigid,
single-purpose, and text-only; NDEF solves multi-record framing but only
for NFC.

QDEF is meant to be adopted by unrelated applications with no shared
history — a Wi-Fi provisioning sticker, an event ticket, a passphrase-
protected key backup spread across several printed codes (worked example in
§8) are all equally valid uses. It is not tied to, and does not assume
familiarity with, any particular application.

## 1. Abstract & Philosophy

QDEF is binary-first: an extensible, multi-action CBOR payload, parseable
both by a modern smartphone and by a deeply constrained embedded scanner
(transit gate, POS terminal) with no semantic-tag-aware CBOR library.

QDEF is deliberately two things, not one:

- A minimal **core format** (§3): magic/version framing, a CBOR Sequence of
  Records, Type-ID routing via a plain map key, and a per-key criticality
  rule. A parser that only implements this can route or skip any Record
  without knowing anything else about it.
- A separate, optional **standard library** (§4): reusable building blocks
  (splitting a payload across multiple codes, compression, encryption, a
  generic fallback) that any application can pull in without writing its
  own reassembly, cipher, or fallback-routing code.

Neither layer is optional to the *design* — see §4 for why a minimal
implementer must never be forced to bring a compression or reassembly
library just to route Records.

### When QDEF earns its place

Any application that already defines its own text/URI scheme (human-
typable, clickable — `myapp://...`) should encode its envelope directly
under that scheme, not wrap it in QDEF. The scheme prefix already does the
recognition job QDEF's magic header exists for (§2); wrapping adds only
redundant bytes with nothing to show for them. QDEF earns its place on
carriers with **no pre-existing dispatch**: plain byte-mode QR with no URI
at all, or an NDEF payload with no app-specific MIME type already routing
it. §8's PGP-key-backup example is exactly this case — those codes are only
ever scanned by one app, never clicked or typed, so there's no scheme to
lean on instead.

## 2. Container Wire Format

8-bit byte mode only — never alphanumeric; text-safety is explicitly not a
goal. A 4-byte magic header plus a 1-byte version (5 bytes total) for
instant optical-stream validation, followed by a CBOR Sequence (RFC 8742)
of Records — a sequence rather than a wrapping CBOR array, so a constrained
parser can process each Record as it streams in without buffering the
whole payload first (validated in the prototype against a real incremental
CBOR decoder fed arbitrary byte chunks).

```
+---------------------+--------------+----------------------------------+
|   Magic (4 bytes)    | Version (1B) |     CBOR Sequence of Records     |
+---------------------+--------------+----------------------------------+
| 0x51 0x44 0x45 0x46  |    0x01      |  Record, Record, Record, ...     |
|       "QDEF"         |  (Version 1) |                                  |
+---------------------+--------------+----------------------------------+
```

For NFC, the magic+version prefix is redundant: NDEF's own MIME-type field
already identifies the payload. An NDEF record carrying QDEF content uses
MIME type `application/vnd.qdef` with just the CBOR Sequence of Records as
the payload, no magic bytes. The magic header exists only for the
QR/optical case, where a scanner needs to recognize the byte stream's
format before any higher-level dispatch exists to tell it what it's
looking at. (Validated in the prototype: a bare CBOR Sequence with no magic
prefix decodes through the exact same Record-routing logic as the full
container.)

## 3. The Record Architecture

Every Record is a CBOR Map.

### 3.1 Hardware Parity Routing (Key 0)

1. **The Smart Route (Tags):** the Record Map SHOULD be wrapped in a CBOR
   Semantic Tag matching the Record Type ID, for parsers with tag-aware
   CBOR libraries.
2. **The Constrained Route (Key 0):** the Record Map MUST also contain Key
   `0` (uint), with the same Record Type ID as the tag. A constrained
   parser with no tag support reads `map[0]` directly and ignores the tag.

Both routes carry the *same* ID — this is redundant dual-declaration for
routing robustness, not a two-level type hierarchy (that's a different
thing NDEF does — TNF category plus a separate Type string — which QDEF
does not need, since "Record Type ID" is already the only dispatch key).

**If the tag and `map[0]` disagree,** or `map[0]` is absent entirely, the
Record cannot be routed consistently by every parser and MUST be treated as
an abort of that Record (§3.2's critical-key failure mode) — a tag-aware
parser and a constrained parser must never end up disagreeing about what
Type a Record is.

### 3.2 The Extensibility Rule (Even/Odd Keys)

Borrowed from PNG's critical/ancillary chunk convention:

- **Even keys are CRITICAL.** An unrecognized even-numbered key MUST cause
  the parser to abort processing *that record* (not the whole stream —
  other records in the same Sequence are unaffected). Key `0` is even, and
  is always critical.
- **Odd keys are OPTIONAL.** An unrecognized odd-numbered key MUST be
  silently ignored; the rest of the record still processes normally.

This gives per-field forward compatibility: a future critical field doesn't
require bumping the container `Version` byte, only choosing an even key
number the current Record Type doesn't yet define.

**Precondition on "the whole stream is unaffected":** this isolation
guarantee assumes the Record is at least well-formed CBOR — a parser needs
to determine its byte length to find where the next Record starts. A
Record that fails to route (missing key `0`, a Hardware Parity mismatch,
§3.1) is still well-formed and isolable this way. A Record whose bytes are
themselves malformed CBOR (truncated, an invalid length prefix, a reserved
additional-info value) is a stronger failure: the parser can no longer find
that boundary and cannot safely resume the Sequence at all. Implementers
should not conflate the two — only the former is isolated to one Record.

### 3.3 Conformance Levels

QDEF is designed so a minimal, generic parser is genuinely minimal — no
implementer has to bring a compression library or sector-reassembly logic
just to support the *container*:

- **Core QDEF parser (mandatory, all implementers):** verify magic/version,
  walk the CBOR Sequence, read each Record's `map[0]` to route or skip it,
  apply the even/odd rule (§3.2) to unrecognized keys. That's the entire
  surface area — no compression, no multi-code state, no knowledge of any
  specific Record Type's fields.
- **Record-Type-specific handling (optional, per Record Type an implementer
  chooses to support):** everything else — including whether a given
  Record Type's payload happens to be compressed, or happens to require
  reassembling several codes — is defined *by that Record Type*, not by
  QDEF. An implementer who only cares about Wi-Fi provisioning (Type 100)
  never has to read, understand, or link against whatever some other
  registered Record Type does internally.

A conformant core parser MUST bound recursion depth while walking CBOR
structures it doesn't otherwise interpret (skipping an unrecognized field's
value, or an unrecognized Record's entire map). This isn't a wire-format
requirement — it doesn't change what bytes are valid — but a genuinely
constrained target (§1's "deeply constrained embedded scanner") can have
only a few KB of stack, and an unbounded-recursion skip implementation lets
a malformed or adversarial input exhaust it. Validated in
[`rust/qdef-core`](../rust/qdef-core), whose hand-rolled skip logic
enforces a fixed maximum nesting depth for exactly this reason (see
FINDINGS.md).

## 4. The QDEF Standard Library

QDEF is a *format plus a standard library*, not just the format — the same
relationship C-the-language has with libc. §3 defines a minimal core any
conformant parser must implement, and says nothing about compression,
splitting, encryption, or graceful degradation for scanners that don't
understand a given Record Type. Those live here instead: a small, curated
set of Record Types any application can pull in — writing no reassembly
code, no cipher code, no fallback-routing code of its own.

**Reserved Type ID range:** `1`–`99` are reserved for this standard
library, maintained alongside the QDEF spec itself. `100` and above are
open for applications to register their own domain-specific Record Types
(§5's examples) — who governs *that* allocation is still open (§9), but at
least the two registries are partitioned by construction and can't
collide.

### 4.1 Wrapper Records (optional)

A **Wrapper Record** is an ordinary Record — same routing, same even/odd
rule — using a reserved low Type ID, whose payload is not application data
but the *encoded bytes of another Record* (which may itself be a Wrapper
Record, nested). Unwrapping and re-parsing the result as a Record is the
entire mechanism: no new parsing concept beyond "run the Record parser
again on these bytes." A single generic resolver — reassemble fragments /
decompress / decrypt, then re-parse as a Record, repeat until the result
isn't a Wrapper Record anymore — implements this for every Record Type
that opts in, with zero code written by that Record Type's own author
(demonstrated in `prototype/src/wrappers.js`'s `resolveStack`).

Reserved Wrapper Type IDs (placeholders, pending a real registry):

```
Type 2: {                    // Split
  0: 2,
  2: h'<group_id>',          // CRITICAL: content-addressed (a hash of the
                              //   full reassembled bytes) — never an issued
                              //   serial, so no coordination is needed
                              //   between independent encoders. A decoder
                              //   MUST recompute this hash after
                              //   reassembly and reject a mismatch — it
                              //   doubles as the group's integrity check.
  4: 1,                      // CRITICAL: this fragment's index
  6: 4,                      // CRITICAL: total fragment count in the group
  8: h'<fragment bytes>',    // CRITICAL: this code's slice
  9: 5821,                   // OPTIONAL as a key (odd), but MUST be present
                              //   whenever key 11 (parity_scheme) is set —
                              //   see chunking rule below. When present:
                              //   total_bytes of the reassembled whole.
  11: 1                      // OPTIONAL: parity_scheme — 0/absent = none,
                              //   nonzero selects a registered forward-
                              //   error-correction scheme so the group
                              //   tolerates a missing/damaged code.
}

Type 3: {                    // Compress (DEFLATE)
  0: 3,
  2: h'<deflate bytes>'      // CRITICAL
}

Type 4: {                    // Encrypt (e.g. AES-GCM)
  0: 4,
  2: h'<nonce>',             // CRITICAL
  4: h'<ciphertext+tag>'     // CRITICAL
  // Key provisioning (passphrase KDF? pre-shared key? recipient public-key
  // wrap?) is NOT specified here — open question, see §9. Two independent
  // apps using Type 4 need to agree on this out of band today.
}
```

**Fragment chunking (Type 2).** The spec must fix *how* the original bytes
are sliced, not just what fields describe the result, or two independent
encoders/decoders can't agree on wire bytes. Fixed rule:

```
chunkLen = ceil(total_bytes / count)
fragment[i] = bytes[i * chunkLen .. min((i + 1) * chunkLen, total_bytes)]
```

the last fragment is shorter than `chunkLen` when `total_bytes` isn't an
exact multiple of `count`. This uniform-chunking rule is what makes
`parity_scheme`'s XOR-style recovery well-defined (every fragment
zero-padded to `chunkLen` before XOR; a recovered fragment is truncated
using the missing index's known slice boundaries). It is also a real
constraint on encoders: a Split group can't freely give different physical
codes different-sized fragments to match each code's own capacity while
still supporting parity recovery under this rule. That tension is not yet
resolved — see §9.

`parity_scheme` mechanics: a parity fragment (index ≥ `count`, present only
when `parity_scheme` is set) is pure bonus redundancy — plain reassembly
only ever requires fragments `0` through `count − 1`. A decoder that
doesn't understand `parity_scheme` can just ignore any fragment past
`count` and still reassemble correctly in the all-present case — it only
loses resilience, never correctness. `parity_scheme = 1` (prototype-defined
only, not yet a real registry entry): a single XOR parity fragment,
recovering exactly one missing/damaged real fragment.

**Fixed nesting order** when more than one Wrapper is combined: `Split
(outermost, if present) → Encrypt → Compress → plain inner Record`.
Compress-before-encrypt is the only sound order between those two
(ciphertext doesn't meaningfully compress). Split-outermost is the
*recommended* order for efficiency — one encrypt/compress operation covers
the whole payload instead of one per fragment — but **it is not structurally
required and a decoder cannot detect or reject a different order**: the
generic resolver described above has no notion of "correct" order, it just
keeps unwrapping whatever Wrapper Type ID it finds next. A prototype run
confirmed both the documented order and a deliberately reversed one
(Encrypt applied per-fragment, Split innermost) decode identically through
the same resolver with no error (see FINDINGS.md §7). This is a corrected
claim from an earlier draft, which described Split-outermost as required
"because decompression/decryption need the complete byte string" — that
described the recommended case, not a hard constraint; encrypting each
fragment individually is well-defined too, just less efficient and without
a single whole-payload integrity tag.

**Why a wrapper, not a reserved key range on the inner record itself:**
wrapping avoids a cross-record correctness hazard a sibling/key-range
approach doesn't. If spanning info were just extra keys inside, say, a
"Photo Fragment" Record Type, a parser that recognizes that Type but not
the spanning convention would happily treat one fragment as if it were the
whole photo. A Wrapper Record can't be misread that way: its payload is
opaque bytes, not a valid inner Record, so a parser that doesn't implement
Type 2 just skips the entire record like any other unrecognized Type ID —
it never sees anything to misinterpret.

**Cost:** wrapper framing (CBOR map + a few keys) is added per code on top
of the inner record, so this stays strictly opt-in — a Record Type with no
need for it stays a plain, unwrapped Record, exactly as cheap as §5's
examples.

### 4.2 Fallback Hint (optional)

Unlike §4.1, this is deliberately **not** a wrapper — a plain stdlib Record
Type meant to sit as a *sibling* alongside real content records in the same
CBOR Sequence, carrying a URI any generic tool can follow if it doesn't
understand anything else in the container:

```
Type 5: {                          // Fallback Hint (stdlib)
  0: 5,
  2: "https://example.com/open-this",  // CRITICAL: a URI a generic tool
                                        //   or browser can follow
  1: "Open in MyApp"                   // OPTIONAL: human-readable label
}
```

This is what gives a QDEF container the "something useful happens even
without the specific app" property. It **must** stay a plain sibling
record, never nested inside a Wrapper — its entire value is being visible
to a parser that understands nothing else in the container, which a
Wrapper's opaque payload would defeat.

## 5. Record Type Registry (informative examples)

### Type `100`: Wi-Fi Provisioning

```
Tag 100: {
  0: 100,               // CRITICAL: Record Type ID
  2: "My Coffee Shop",  // CRITICAL: SSID
  4: "guest123",        // CRITICAL: Password
  6: 2,                 // CRITICAL: Auth Type (0=Open, 1=WEP, 2=WPA2/3)
  1: true                // OPTIONAL: Hidden Network Flag
}
```

### Type `105`: Universal Transit / Event Ticket

```
Tag 105: {
  0: 105,                // CRITICAL: Record Type ID
  2: h'A7F90B...',       // CRITICAL: Ticket Hash/Token
  4: 1735689600,         // CRITICAL: Expiry Epoch Timestamp
  1: "General Admit",    // OPTIONAL: UI Display Text
  3: "Gate A"            // OPTIONAL: Wayfinding Hint
}
```

## 6. Adopting QDEF for an existing application-specific format

An application with its own existing binary payload format (e.g. a
proprietary CBOR sequence used today for some other transport) can register
one Record Type ID and carry that payload unchanged, byte-for-byte, as an
opaque blob under a single key:

```
Tag <N>: {                     // application-chosen Type ID
  0: <N>,
  2: h'<existing payload bytes>'  // CRITICAL: raw bytes, unchanged from
                                   //   whatever that application already
                                   //   defines — QDEF never looks inside
}
```

This lets a QDEF-aware scanner dispatch a single byte-mode QR or NFC tag
containing, say, a Wi-Fi Record *and* this application's own content Record
together — without that application's own decoder changing at all: it
still just reads the raw bytes out of key `2`. This is additive and
opt-in — nothing about the application's own format needs to route through
QDEF for it to keep working exactly as it does today.

(The `mofosyne/tagdrop` project uses exactly this pattern to register its
own byte-mode payload — see that repo for the worked details. It's one
adopter among the format's intended audience, not the reason this format
exists; §8 below is an unrelated adopter using the same mechanism.)

## 7. Compression and splitting across multiple tags/codes

**QDEF itself defines neither** — both stay entirely inside each Record
Type's own payload definition (§6's registration pattern is one example of
why: an application that already solved reassembly/compression for its own
format keeps using its own solution, unchanged, rather than adopting a
second, competing one at the QDEF layer).

**Why not build them into the container:**

- *Compression:* §3.1's "Constrained Route" only works if a bare-metal
  scanner can read `map[0]` at zero decode cost to decide whether a record
  concerns it. If the CBOR Sequence itself were compressed, that scanner
  would need a DEFLATE implementation just to *skip* a record it doesn't
  recognize — directly against the point of Hardware Parity routing (§3.1).
  Keeping compression a per-Record-Type concern means a parser that doesn't
  recognize a given Type never touches a compressed byte it didn't ask for.
- *Splitting:* QDEF is deliberately scoped to one physical code's records
  (§2). Reassembling a payload spread across multiple codes (ordering,
  missing/duplicate parts, parity, content-addressing) is a much harder
  problem than routing. An application that already has its own proven
  answer to that problem should keep using it rather than adopt a second,
  possibly-disagreeing addressing scheme at the QDEF layer.

**If an application wants splitting, compression, or encryption without
writing any of it itself:** that's what §4.1's Wrapper Records are for — a
generic, reusable resolver any Record Type can opt into by simply being
wrapped, with zero code written by that Record Type's own author (§8 is the
worked example).

## 8. Worked example: passphrase-protected key backup across several codes

An app backs up a passphrase-protected secret key across a set of printed
QR codes. This app has **no scheme of its own** to dispatch on — these
codes are only ever scanned by its own app, never clicked or typed — so per
"When QDEF earns its place" (§1), going through QDEF's byte-mode container
(magic header included) is the right call.

Registers one Record Type, say `950`, for the plain secret-key bytes:

```
Tag 950: {
  0: 950,
  2: h'<raw secret key packet bytes>'  // CRITICAL
}
```

Because the key material is sensitive and may not fit one code, the app
composes it through two Wrapper Records, in the recommended order from
§4.1 — `Split (outermost) → Encrypt → plain Type-950 Record` (no `Compress`
layer here — key material is already high-entropy, DEFLATE wouldn't help):

```
authoring:  Type-950 Record  →  Encrypt Wrapper (Type 4)  →  Split Wrapper (Type 2)
decoding:   Split Wrapper    →  Encrypt Wrapper           →  Type-950 Record
            (per code)          (after reassembly)            (the real key)
```

Each printed code carries one Split-Wrapper Record (Type 2) with
`parity_scheme` set — losing one code out of the set is recoverable, which
matters far more for a one-off secret-key backup than for disposable
content. The app wrote **zero** reassembly, parity, or AES-GCM code of its
own for the container format — all of it is the shared QDEF Wrapper
resolver from §4.1, exercised through the exact same recursive "unwrap
bytes → re-parse as a Record" step, regardless of what Type 950 turns out
to mean.

This exact scenario — 3 data fragments + 1 XOR parity fragment, one
fragment deliberately dropped and recovered, then the full
Split→Encrypt→plain chain decrypted and re-parsed — is exercised end to end
in `prototype/test/roundtrip.test.js`.

## 9. Open questions (not resolved by this draft)

- **Registry governance.** Who allocates application-specific Record Type
  IDs (`100`+) if this is meant to be shared across unrelated projects? No
  registry exists yet — IDs in this document are illustrative placeholders
  only.
- **Standard library governance.** Related but narrower (§4): who maintains
  the reserved `1`–`99` range itself — additions like §4.1/§4.2 need some
  process for becoming part of "the stdlib" rather than just another
  vendor's Record Type squatting on a low number.
- **Magic-header overhead for QR.** 5 bytes fixed cost matters for a
  single-record payload in a size-constrained QR version; is it worth
  gating on payload size (e.g. omit magic when embedded via a scheme that
  already identifies the format, mirroring the NFC case in §2)?
- **Relationship to existing standards.** NDEF already solves "multiple
  typed records, one message" for NFC (§2's `application/vnd.qdef` MIME
  framing leans on this directly). This draft's actual net-new contribution
  is narrower than it first appears: a *magic-header-plus-CBOR-Sequence*
  convention for the optical/QR case specifically, plus the even/odd
  criticality rule, which NDEF itself does not have (NDEF has no per-key
  criticality signal at all, only per-record TNF/Type).
- **Encrypt key provisioning (new, from the prototype).** Type 4 names a
  cipher (e.g. AES-GCM) but never specifies where the key comes from. Left
  out of scope of the wrapper record entirely (an application-layer
  concern), or given an optional key-hint/KDF-params field? Unresolved —
  see FINDINGS.md §6.
- **Split chunking vs. per-code capacity (new, from the prototype).** The
  uniform `chunkLen = ceil(total_bytes/count)` rule (§4.1) is what makes
  single-fragment XOR parity well-defined, but it also prevents an encoder
  from sizing each fragment to match that specific code's actual capacity
  (different QR version/ECC level per code, or a QR code alongside a
  smaller-capacity NFC tag in the same group). Resolving this needs either
  accepting the uniform-chunking constraint as a real limitation, or
  specifying a fragment-length manifest redundant enough to survive one
  missing fragment. Unresolved — see FINDINGS.md §3.
- **Nesting order enforcement — now answered, not open.** A prototype
  confirmed a generically-written decoder cannot detect or reject a
  non-conformant Wrapper nesting order (FINDINGS.md §7); §4.1's text has
  been corrected accordingly. This bullet is resolved and kept here only as
  a record of the change from the prior draft's "leaning toward" language.
