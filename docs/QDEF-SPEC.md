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

Without a format field to dispatch on, a general-purpose QR reader has no
choice but to *guess* what a scanned payload is — is this a URL? a `WIFI:`
string? a vCard? raw text? — by sniffing prefixes. Every new payload type
it wants to recognize is one more heuristic bolted onto that guesswork, a
list that only grows and never gets more reliable, because nothing in the
payload itself ever says what it is. NDEF sidestepped this for NFC decades
ago with its MIME-type/TNF field; QR never had the equivalent, so readers
inherited the sniffing problem instead. QDEF's magic header plus key-`0`
Type-ID routing (§3) gives byte-mode QR that same explicit, extensible
dispatch — a reader checks one field instead of accumulating heuristics.

QDEF is meant to be adopted by unrelated applications with no shared
history — a Wi-Fi provisioning sticker, an event ticket, a passphrase-
protected key backup spread across several printed codes (worked example in
§8) are all equally valid uses. It is not tied to, and does not assume
familiarity with, any particular application.

## 1. Abstract & Philosophy

QDEF is binary-first: an extensible, multi-action CBOR payload, parseable
both by a modern smartphone and by a deeply constrained embedded scanner
(transit gate, POS terminal) with only a minimal CBOR decoder — no
semantic-tag support, no compression library, nothing beyond reading maps,
uints, and strings.

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

**Unknown version byte: reject the whole container.** The version byte
gates the interpretation of everything after it. A decoder that reads a
version it does not implement MUST reject the entire container and MUST NOT
attempt to parse the Sequence that follows — a future version is free to
change the framing, the routing rules, or the even/odd criticality
convention itself, i.e. the very machinery a decoder would otherwise rely
on to skip safely. This is the one point in QDEF where "skip what you don't
understand" deliberately does *not* apply: an unknown Record Type ID (skip
the record) and an unknown even key (abort the record) both have local,
recoverable rules, but an unknown *version* is a global "I cannot safely
interpret any of this" signal. Version bumps are
expected to be rare precisely because §3.2's per-field forward
compatibility absorbs most evolution without one; the version byte moves
only for a change to the core framing itself.

**Deliberately no record count or total payload size in the header** —
suggested more than once as a natural addition to a binary header, and
deliberately left out. Either field would require an encoder to know its
final size before writing the header, and a decoder to trust a value that
duplicates information already recoverable by walking the Sequence, adding
a way for the two to disagree with no benefit: the entire point of a CBOR
*Sequence* over a wrapping array (above) is that a Record's presence is
self-delimiting and a constrained parser can stream through Records one at
a time without ever needing to know the total count up front. A count/size
field would sit unused by that parser and be one more thing a fuzzer or a
malformed input could make lie.

## 3. The Record Architecture

Every Record is a CBOR Map, one level deep, no more — a flat set of
key/value pairs and nothing else. Using §5's Wi-Fi Record (Type `100`) as
the example (this is where §3.2's even/odd rule and field-value-shape rule
apply — the "Type" column below is never array, map, or tag, by that
rule):

```
+-----+------------------------+-------+----------+-----------------------------+
| Key | Value                  | Type  | Even/Odd | If unrecognized             |
+-----+------------------------+-------+----------+-----------------------------+
| 0   | 100                    | uint  | even     | n/a -- always required      |
| 2   | "My Coffee Shop"       | text  | even     | CRITICAL: abort Record      |
| 4   | "guest123"             | text  | even     | CRITICAL: abort Record      |
| 6   | 2                      | uint  | even     | CRITICAL: abort Record      |
| 1   | true                   | bool  | odd      | OPTIONAL: silently ignored  |
+-----+------------------------+-------+----------+-----------------------------+
```

Every Record — a plain content Record like this one or a stdlib Wrapper
Record (§4.1) — has exactly this shape: a flat Map, and field values that
are always scalar-or-string, never structure to walk into. That fixed
shape is what §3.3 means by "a conformant core parser never needs
recursion at all."

### 3.1 Record Type ID (Key 0)

The Record Map MUST contain Key `0` (uint), the Record Type ID. This is
the *only* routing mechanism — a parser reads `map[0]` to decide what kind
of Record it's looking at, or to skip a Record it doesn't recognize. Key
`0` is even, and is always critical: a Record with no key `0` cannot be
routed at all and MUST be treated as an abort of that Record (§3.2's
critical-key failure mode).

An earlier draft also wrapped the Record Map in a CBOR semantic Tag
matching the Type ID, as a second, redundant routing path for tag-aware
CBOR libraries. That mechanism has been removed: CBOR tag numbers are a
shared IANA registry meant for predefined, universal interpretations of a
data item (a byte string *is* a bignum, a text string *is* a date) — not a
private, per-application enumeration space, which is what treating "tag
number" as "Type ID" actually asked of it. It also collided in practice:
QDEF's own low Type IDs landed on tag numbers IANA already assigns to
bignums, decimal fractions, and dates, verified against a real decoder
mangling the result. See §9's "CBOR tag-number collision (resolved)" and
FINDINGS.md #11 for the full reasoning and the decision. Key `0` was never
part of the problem — there is no IANA registry for map keys, only for
tags, so this simplification costs nothing: every prototype test already
routed through key `0` alone.

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

**Field values MUST be skip-safe.** A Record field's value — for *any* key,
recognized or not — MUST be one of: an unsigned or negative integer, a
simple value or float, or a definite-length byte or text string. A value
MUST NOT be a bare array, a nested map, or a CBOR tag. Structured content
(a list, a sub-record, anything shaped like an array or map) MUST instead
be CBOR-encoded separately and carried as the payload of a definite-length
byte string — the same "opaque bytes, re-parsed only by something that
opts in" pattern §4.1's Wrapper Records already use, just applied at the
field level instead of only at the whole-Record level. (Optionally, that
byte string's contents may themselves be tagged with CBOR tag 24 — "encoded
CBOR data item," RFC 8949 §3.4.5.1 — as a hint to a decoder that chooses to
parse them.)

This isn't a style preference: determining a field's length ordinarily
requires walking into its structure (an array's or map's true byte length
isn't known until every element inside it has been walked, recursively for
nested structure), which is an unbounded-recursion hazard on a target with
only a few KB of stack. A byte or text string's length, by contrast, is
always stated directly in its own head — skipping one is pure cursor
arithmetic, never a walk. Restricting every field value to that shape means
a conformant core parser never needs to recurse *at all* to skip a field it
doesn't recognize — not "recursion bounded by a depth guard," but no
recursion, structurally. (Validated in
[`rust/qdef-core`](../rust/qdef-core); see FINDINGS.md.)

**Precondition on "the whole stream is unaffected":** this isolation
guarantee assumes the Record is at least well-formed CBOR *and* obeys the
field-value-shape rule above — a parser needs to determine the Record's
byte length to find where the next Record starts. A Record that fails to
route (missing key `0`, §3.1) is still well-formed and isolable this way. A Record that is malformed CBOR, or
whose bytes violate the field-value-shape rule (a bare array/map/tag as a
field value), is a stronger failure in both cases: the parser can no longer
determine that boundary and cannot safely resume the Sequence at all.
Implementers should not conflate the two failure classes — only the former
is isolated to one Record.

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

Because of §3.2's field-value-shape rule, a conformant core parser never
needs recursion at all to do its job — not bounded recursion, none. A
Record is always exactly `Map → (scalar | definite-length string)*`: one
flat level, walked once. Skipping a field whose key isn't recognized, or
an entire Record whose Type ID isn't recognized, is always a direct read
or a cursor-arithmetic jump, never a walk into unbounded structure. A conformant core parser SHOULD still reject a Record outright
(rather than attempt to interpret it) the instant it encounters a field
value that violates the shape rule, since by definition that value's true
length can't be determined without doing the recursive walk the rule exists
to avoid. Validated in [`rust/qdef-core`](../rust/qdef-core) — see
FINDINGS.md for the size and code-shape difference this made in practice.

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
{
  0: 100,               // CRITICAL: Record Type ID
  2: "My Coffee Shop",  // CRITICAL: SSID
  4: "guest123",        // CRITICAL: Password
  6: 2,                 // CRITICAL: Auth Type (0=Open, 1=WEP, 2=WPA2/3)
  1: true                // OPTIONAL: Hidden Network Flag
}
```

### Type `105`: Universal Transit / Event Ticket

```
{
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
{
  0: <N>,                          // application-chosen Type ID
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
own byte-mode payload, illustrated here as Type `900` — see that repo for
the worked details. It's one adopter among the format's intended audience,
not the reason this format exists; §8 below is an unrelated adopter using
the same mechanism.)

**Registering a real Type ID before governance exists.** `900` here is an
illustrative placeholder, not a protected allocation — §9's registry
governance for the `100`–`999` "common vocabulary" tier has no authority
yet, so nothing stops an unrelated adopter from also picking `900`. Any
adopter wiring this pattern into real shipping code *before* that
governance exists should use the `0x10000`+ private-use-random tier (§9)
instead of a fixed low number: a few more bytes on the wire, but no
allocation authority needed at all, and no shipping code that has to
migrate its Type ID once a real registry does exist.

**On signing and this registration pattern specifically:** an adopter whose
own signature already covers the fully-reassembled plaintext (signed once,
after all splitting/addressing is resolved, with nothing about the
signature depending on how the content happened to be fragmented in
transit) needs no QDEF-level Sign mechanism at all, wrapper or sibling
(§9). §4.1's `group_id` is already a content hash a decoder MUST verify
after Split reassembly — that alone guarantees "the bytes you got back are
the bytes that went in," which is all a whole-payload signature needs from
the container. The signature fields themselves are just ordinary payload
bytes inside the registered blob, orthogonal to whichever Wrapper stack (if
any) did the fragmenting. `mofosyne/tagdrop`'s own wire format anticipates
exactly this: its signed message is specified over the fully reassembled
stream, independent of per-sector addressing (SPEC.md §10) — so a
Type-900-style registration needs nothing further from QDEF's side for
that content, regardless of whether any given adopter's UI/tooling
actually produces signed multi-sector content yet. An adopter whose
signature is instead coupled to its own splitting/addressing scheme
(covers per-sector metadata, not just reassembled bytes) would not get
this for free — see §9's Sign entry. This reasoning generalizes beyond any
one adopter — see §7's note on signing.

## 7. Compression and splitting across multiple tags/codes

**QDEF itself defines neither** — both stay entirely inside each Record
Type's own payload definition (§6's registration pattern is one example of
why: an application that already solved reassembly/compression for its own
format keeps using its own solution, unchanged, rather than adopting a
second, competing one at the QDEF layer).

**Why not build them into the container:**

- *Compression:* §3.1's key-`0` routing only works if a bare-metal scanner
  can read `map[0]` at zero decode cost to decide whether a record concerns
  it. If the CBOR Sequence itself were compressed, that scanner would need
  a DEFLATE implementation just to *skip* a record it doesn't recognize —
  directly against the point of routing at all (§3.1). Keeping compression
  a per-Record-Type concern means a parser that doesn't recognize a given
  Type never touches a compressed byte it didn't ask for.
- *Splitting:* QDEF is deliberately scoped to one physical code's records
  (§2). Reassembling a payload spread across multiple codes (ordering,
  missing/duplicate parts, parity, content-addressing) is a much harder
  problem than routing. An application that already has its own proven
  answer to that problem should keep using it rather than adopt a second,
  possibly-disagreeing addressing scheme at the QDEF layer.

**The same reasoning applies to signing, not just compression and
splitting.** An application with its own proven authentication mechanism
— e.g. a single hash-then-sign step over the fully reassembled payload,
computed independently of however the transport happened to fragment it —
needs no QDEF Sign primitive for that content either, for the identical
reason: it already solved this, adopting a second, QDEF-native mechanism
would just be a second thing that could disagree with the first. §6's
registration pattern already demonstrates this for an adopter whose
signature covers reassembled bytes; §9's Sign entry is for the different
case — a Record with no pre-existing answer of its own.

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
{
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

- **Registry governance — allocation shape proposed, authority still
  open.** Who allocates application-specific Record Type IDs (`100`+) if
  this is meant to be shared across unrelated projects is still open — no
  registry authority exists yet, and IDs in this document remain
  illustrative placeholders. But the *shape* of the range has an answer:
  tier it the way CBOR's own tag registry (RFC 8949 §9.2) tiers tag
  numbers — a small span requiring registration/review, then a larger
  "first-come" span, then an explicit private-use span for
  never-shared/internal Type IDs. QDEF doesn't use CBOR tags itself
  (§3.1, §9's "CBOR tag-number collision"), but the *governance pattern*
  a mature numeric-ID registry uses is worth borrowing on its own merits,
  independent of whether QDEF's wire format happens to touch tags at all.
  Two options were weighed and this is the one to build the eventual
  policy on:
  - **Tiered ranges (recommended):** four tiers, not two, each with a
    different reason to exist:
    - `1`–`99`: mechanism/plumbing (already spec'd, §4) — Wrapper Records
      and other stdlib infrastructure, not application content.
    - `100`–`999`: **common vocabulary** — reviewed, widely-recognized
      content types (Wi-Fi, a URL/URI record, the kind of thing NDEF calls
      a "Well Known Type"). This is the tier for a Record Type enough
      unrelated implementers would want to recognize that it's worth a
      shared, reviewed number rather than everyone reinventing their own —
      today's §5 examples (`100`, `105`) already sit here informally.
    - `1000`–`0xFFFF`: first-come-first-served — registered, but no review
      gate beyond "not already taken."
    - `0x10000`+: **private-use, via a large random value, not a
      registry.** This tier needs no allocation authority at all: because
      Type IDs are CBOR uints with no fixed width, an implementer who picks
      a sufficiently large (e.g. 32- or 64-bit) *random* number gets
      collision avoidance from the sheer size of the number space, the same
      way a UUID does — not from anyone checking a list. This is the
      correct answer for closed/internal Record Types that will never be
      published or need to interoperate with an unrelated implementer, and
      it's only viable because the wire format never fixed Type IDs to a
      small byte-width field.
    Exact boundaries remain a policy decision for whoever ends up running
    the registry, not a wire-format one.
  - **Even/odd for governance tier (considered, rejected):** reuse the
    even/odd convention itself to mean "pre-registered vs. free-for-all,"
    the same way it already means critical-vs-optional for keys (§3.2).
    Rejected for two reasons: it collides semantically with a convention
    that already carries a specific, different, load-bearing meaning
    elsewhere in this same spec — a reader would have to track two
    unrelated meanings of "even/odd" depending on whether they're looking
    at a key or a Type ID — and it halves the usable ID space for no
    benefit a tiered range doesn't already provide more cheaply.
- **CBOR tag-number collision (resolved — the tag route was removed).** An
  earlier draft wrapped every Record Map in a CBOR semantic tag equal to
  its Type ID (the "Smart Route"), alongside the mandatory key `0`. Found
  broken on two independent grounds, not one:
  - **Empirical.** CBOR tag numbers are a shared IANA registry (RFC 8949
    §3.4), and the low numbers QDEF's stdlib picked are already assigned:
    tag `2`/`3` are bignums, tag `4` is a decimal fraction, tag `5` is a
    bigfloat — exactly Types 2 (Split), 3 (Compress), 4 (Encrypt), 5
    (Fallback Hint). Type `100` (Wi-Fi) collides with RFC 8943's
    days-since-epoch date; tag `0` additionally makes Type ID `0` unusable.
    Reproduced against a real decoder, not just asserted: `Tagged(2, <byte
    string>)` decodes to a `BigInt`, and wrapping an actual Record Map in
    tag `0` decodes to `Invalid Date` — see FINDINGS.md #11.
  - **Conceptual, and the deeper reason.** Even numbers with no *current*
    collision were the wrong fix, not just a smaller one. A tag number is
    meant to carry one predefined, universal interpretation (a byte string
    *is* a bignum, a text string *is* a date) that any implementation can
    look up and apply — not a private, per-application enumeration handed
    out in bulk. Treating "tag == Type ID" as QDEF's own extensible ID
    space was asking the registry to be something it isn't, independent of
    which specific numbers happened to be free. No legitimate registry
    grants thousands of slots to one application's internal dispatch
    table.

  Key `0` was never implicated by either argument: there is no IANA
  registry for map keys, only for tags, so a bare Record Map has no
  built-in semantic layer for a generic decoder to misinterpret — verified
  directly (FINDINGS.md #11): the identical Record Map round-trips cleanly
  when untagged, and decodes to `Invalid Date` only when wrapped in a tag.
  **Decision: the tag route is removed. Key `0` is the sole routing
  mechanism** (§3.1) — simpler, and every prototype test already routed
  through it alone, tag or no tag. The one place a CBOR tag still
  legitimately appears in QDEF is unrelated to routing: §3.2's optional
  tag-24 hint on a field's own byte-string *value*, a Record-Type author's
  own opt-in choice about one field's content, which is exactly the
  "predefined, universal meaning" use tags are for — not a mechanism
  QDEF's core depends on. A single shared "this map is a QDEF Record" tag
  (the way tag `55799` means "self-describe CBOR") was considered as a
  middle ground and set aside for the same reason: one more optional
  mechanism to document and implement, for a benefit key `0` already
  provides unconditionally.
- **Standard library governance.** Related but narrower (§4): who maintains
  the reserved `1`–`99` range itself — additions like §4.1/§4.2 need some
  process for becoming part of "the stdlib" rather than just another
  vendor's Record Type squatting on a low number.
- **Magic-header overhead for QR.** 5 bytes fixed cost matters for a
  single-record payload in a size-constrained QR version; is it worth
  gating on payload size (e.g. omit magic when embedded via a scheme that
  already identifies the format, mirroring the NFC case in §2)? A real
  data point from an adopter comparison (verified directly against
  `mofosyne/tagdrop`'s SPEC.md): TagDrop's native envelope costs 2 bytes
  total (`version`+`type`, both small CBOR uints, SPEC.md §2), against
  roughly 10–15 bytes for QDEF's
  magic+version+map-framing overhead (key `0` plus key `2`'s length
  header) on the same small payload — a large proportional cost for
  TagDrop's smallest codes (a short text snippet can be under 50 bytes
  total). Doesn't change the conclusion elsewhere in this spec that QDEF
  wrapping stays strictly opt-in, never the default framing (§6, §7) — but
  it's a concrete number to weigh if the conditional-magic-header idea
  above is ever worth building.
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
- **Split chunking vs. per-code capacity — costs nothing against at least
  one real adopter's design, general case still open.** The uniform
  `chunkLen = ceil(total_bytes/count)` rule (§4.1) is what makes
  single-fragment XOR parity well-defined, but it also prevents an encoder
  from sizing each fragment to match that specific code's actual capacity
  (different QR version/ECC level per code, or a QR code alongside a
  smaller-capacity NFC tag in the same group). Checked against a real
  adopter rather than left as a hypothetical concern: `mofosyne/tagdrop`'s
  own sectorization already assumes uniform chunk length across a split
  group (every sector but the last is the same length, per its own spec —
  verified directly against `mofosyne/tagdrop`'s SPEC.md), so QDEF's
  uniform-chunking rule matches what that adopter's format
  already does rather than imposing a new constraint on it. That's
  evidence for one real usage pattern, not a general resolution — an
  adopter that genuinely needs heterogeneous per-code capacity within one
  group (the QR-alongside-smaller-NFC-tag case) still hits this
  constraint. Resolving that general case still needs either accepting
  uniform-chunking as a real limitation, or specifying a fragment-length
  manifest redundant enough to survive one missing fragment. See
  FINDINGS.md §3.
- **Canonical encoding (new, prompted by outside review).** §4.1's `group_id`
  is already a hash of encoded bytes, which silently assumes two conformant
  encoders given the same logical content produce identical CBOR — true
  today only because every worked example uses simple, unambiguous field
  values. CBOR permits multiple valid encodings of the same value (e.g. an
  integer encoded with a longer-than-necessary argument width), so this
  isn't automatically true in general, and matters more if QDEF is ever
  used for hashing/signing beyond `group_id`'s current narrow use (§8's
  PGP-backup example already sits right next to that use case). Adopting
  CBOR's own deterministic-encoding rules (RFC 8949 §4.2.1 — shortest-form
  arguments, sorted map keys, etc.) as a MUST for encoders is the likely
  answer; not yet written into the spec. Distinct from, and not solved by,
  the field-value-shape rule (§3.2), which constrains *what shape* a value
  may be, not which of several valid *encodings* of that shape an encoder
  must pick. Worth resolving on its own priority, separate from Sign below:
  it's already a live correctness gap for `group_id` today, in anything
  shipped now, not merely a prerequisite for a feature that doesn't exist
  yet.
- **Sign / detached-authenticity wrapper (new, requested).** There is no
  way today to prove a *plain, readable* Record is authentic without also
  hiding it: the Encrypt wrapper's AES-GCM tag provides integrity only as a
  side effect of confidentiality, and there is no standalone sign primitive.
  Adding one is not the clean parallel to Encrypt it first looks like, and
  that is the finding:
  - **Sign-as-wrapper (opaque form).** Mechanically identical to Encrypt
    (Type 4) — the signed Record's bytes become the wrapper's opaque
    payload, plus a signature/MAC field. It inherits Encrypt's visibility,
    though: an unaware parser skips the whole thing and sees *nothing*. That
    is fine only when the inner Record was going to be opaque anyway (a
    Type-950 key backup, a proprietary blob), where it *is* a clean
    parallel. It cannot achieve "sign a Wi-Fi record and keep it readable" —
    being readable and being a wrapper payload are mutually exclusive.
  - **Sign-as-sibling (detached form).** The signature is a *separate*
    Record (like the Fallback Hint §4.2 is a sibling, not a wrapper),
    carrying a reference to which Record(s) it covers plus the signature
    bytes. The signed Records stay plain and readable; an unaware parser
    reads them normally and skips the unrecognized signature Record by Type
    ID. This is the form that delivers "readable *and* verifiable" — but it
    depends on two things QDEF lacks: the **canonical encoding** above (a
    verifier must reconstruct the exact signed bytes) and a
    **coverage-identification scheme** (which Records, addressed how — by
    index? by content hash? — surviving reordering and unrelated siblings).
    Coverage identification is the same signed-bytes/verified-bytes
    divergence hazard this project's origin story (TagDrop's signing bug) is
    a caution about, so it must not be hand-waved.

  **Coverage-identification scheme — direction decided, not yet built.**
  Cover by content hash of each covered Record's own canonical bytes, never
  by Sequence index: an index breaks the moment anything is reordered or an
  unrelated Record is inserted, while a hash doesn't care where a Record
  sits. This also reuses the canonical-encoding machinery `group_id` already
  needs (above) rather than inventing a second addressing concept. Two
  refinements this needs to get right, both surfaced by checking the
  proposal against rules already settled elsewhere in this spec rather than
  taking the shape on faith:
  - **The hash list MUST be a packed, fixed-width byte string, not a bare
    CBOR array.** §3.2's field-value-shape rule forbids a bare array as a
    field value — `N` concatenated 32-byte SHA-256 hashes in one
    definite-length byte string (skip-safe, decoded by whatever
    Sign-Record-aware handler chooses to) is the compliant shape; a naive
    CBOR array of hashes is not, and a conformant core parser would reject
    it outright (§3.3).
  - **A hash covers a Record's fully unwrapped, reassembled canonical
    bytes — never a Wrapper's per-fragment or per-code bytes.** Hashing
    Split-fragment bytes directly would make a signature depend on how many
    physical codes the content happened to be fragmented into, an
    implementation/transport detail with no business affecting whether a
    signature verifies. Sign a Record after any Wrapper stack resolves, the
    same layer `group_id`'s own hash already operates on.

  Strippable-but-not-forgeable is an accepted property of this design, not
  a gap to close: deleting a sibling Sign Record from the Sequence
  downgrades signed to unsigned, trivially, the same way `mofosyne/tagdrop`
  already documents "signature can be stripped but not forged or
  retargeted" as an accepted limitation of its own scheme (§6) rather than
  something it structurally prevents.

  Direction when taken up: specify the sibling form (it is the one worth
  having), but only *after* the canonical-encoding question is resolved —
  a detached signature is meaningless without it. The wrapper form can be
  dropped in at any time as a straight parallel to Encrypt if an
  opaque-payload use case ever wants it. Prototype it the same way
  everything else here was: sign two sibling Records, reorder them, insert
  an unrelated third Record, and confirm verification still finds exactly
  the right two — the sort of end-to-end check that catches what design
  review alone doesn't (see FINDINGS.md).
- **Nesting order enforcement — now answered, not open.** A prototype
  confirmed a generically-written decoder cannot detect or reject a
  non-conformant Wrapper nesting order (FINDINGS.md §7); §4.1's text has
  been corrected accordingly. This bullet is resolved and kept here only as
  a record of the change from the prior draft's "leaning toward" language.
