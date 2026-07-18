# QDEF — Quick Data Exchange Format

**Status: Draft. Validated by two throwaway prototypes — a Node round-trip
prototype covering the full design ([`/prototype`](../prototype)) and a
`no_std`, zero-dependency Rust prototype of the mandatory core specifically
([`/rust/qdef-core`](../rust/qdef-core)), which also builds for a bare-metal
Cortex-M0 target (see [FINDINGS.md](FINDINGS.md)); not yet implemented as a
reference library, not yet used in production anywhere. This document is
normative; the reasoning behind its decisions — mechanisms tried and
removed, alternatives weighed, and what's still unresolved — lives in
[DESIGN.md](DESIGN.md).**

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
inherited the sniffing problem instead. QDEF's magic header plus prefix-based Type-ID routing (§3) gives byte-mode
QR that same explicit, extensible dispatch — a reader checks a few prefix
items instead of accumulating heuristics.

QDEF is meant to be adopted by unrelated applications with no shared
history — a Wi-Fi provisioning sticker, an event ticket, a passphrase-
protected key backup spread across several printed codes (worked example in
§7) are all equally valid uses. It is not tied to, and does not assume
familiarity with, any particular application.

## 1. Abstract & Philosophy

QDEF is binary-first: an extensible, multi-action CBOR payload, parseable
both by a modern smartphone and by a deeply constrained embedded scanner
(transit gate, POS terminal) with only a minimal CBOR decoder — no
semantic-tag support, no compression library, nothing beyond reading maps,
uints, and strings.

QDEF is deliberately two things, not one:

- A minimal **core format** (§3): magic framing, a CBOR Sequence of
  Records, prefix-based Type-ID routing, and a per-key criticality
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
it. §7's PGP-key-backup example is exactly this case — those codes are only
ever scanned by one app, never clicked or typed, so there's no scheme to
lean on instead.

## 2. Container Wire Format

8-bit byte mode only — never alphanumeric; text-safety is explicitly not a
goal. A 4-byte magic header (4 bytes total, no version byte) for instant
optical-stream validation, followed by a **mandatory container
discriminator** (§3.5 — always exactly one CBOR item, always present),
followed by a CBOR Sequence (RFC 8742) of Records — a sequence rather
than a wrapping CBOR array, so a constrained parser can process each
Record as it streams in without buffering the whole payload first
(validated in the prototype against a real incremental CBOR decoder fed
arbitrary byte chunks).

```
+----------------------+------------------------+----------------------------------+
|   Magic (4 bytes)     | Discriminator (1 item) |     CBOR Sequence of Records     |
+----------------------+------------------------+----------------------------------+
| 0x51 0x44 0x45 0x46   |  uint, bstr, array,    |  Record, Record, Record, ...     |
|       "QDEF"          |  or map (§3.5)         |                                  |
+----------------------+------------------------+----------------------------------+
```

A minimal Record is at minimum a typeID prefix (a bare uint, or a
namespace-pairing array, §3.1) followed by a field Map:

```
+---------------------------+-------------------------------+
|  typeID prefix (1 item)   |   field Map (CBOR map)        |
+---------------------------+-------------------------------+
|  100                      |  { 0: "SSID", 2: 2 }         |
+---------------------------+-------------------------------+
```

The map acts as the record delimiter in the Sequence — the parser knows a
Record ends when it reaches the first Map. An optional bare text string
may follow the typeID (the NDEF-ID-equivalent, §3.1), and unknown items
may appear between the typeID and the map (forward-compat padding for
future QDEF evolution), but the minimum viable Record is just typeID +
map.

For NFC, the magic prefix is redundant: NDEF's own MIME-type field already
identifies the payload. An NDEF record carrying QDEF content uses MIME type
`application/vnd.qdef` with just the CBOR Sequence of Records as the
payload — no magic bytes, and no discriminator item either, since NDEF's
MIME type already provides the "what kind of file is this" identification
the discriminator otherwise exists to buy (§3.5). The magic-and-
discriminator header exists only for the QR/optical case, where a scanner
needs to recognize the byte stream's format before any higher-level
dispatch exists to tell it what it's looking at. (Validated in the
prototype: a bare CBOR Sequence with no magic prefix and no discriminator
decodes through the exact same Record-routing logic as the full
container.)

**The same is true for an application carrying QDEF content under its own
URI scheme** (§1's "When QDEF earns its place"): the scheme prefix
(`myapp:...`) already told the reader what it's looking at before any
QDEF-specific parsing begins, doing the identical dispatch job magic *and*
the discriminator exist to provide for an otherwise-unidentified byte-mode
stream — a scanner recognizes `myapp:` and hands the remainder straight to
that app's own decoder. The remainder is a bare CBOR Sequence of Records
with no magic and no discriminator, decoded exactly the same way as the
NDEF case above, via the same `decodeSequence` path. `mofosyne/tagdrop`'s
own `tagdrop:<...>` scheme already does exactly this dispatch job for its
own wire format today; an application in that position pays no
magic-byte or discriminator-byte cost at all for adopting QDEF's Record
shape underneath its existing scheme. (Validated in the prototype:
`prototype/test/custom-scheme-carrier.test.js`.) This dispatch-based
isolation is what §3.5's even-Type-ID guidance leans on for collision
safety — see that section's caution on why the same bytes reaching a
second, unisolated carrier (e.g. a shared MIME type, or a raw byte-mode
form with no distinguishing wrapper) silently forfeits it.

**No version byte.** §3.2's even/odd criticality rule already provides
local forward compatibility; see [DESIGN.md](DESIGN.md#container-framing-choices)
for why an earlier draft's version byte was removed.

**No record count or total payload size in the header.** A CBOR Sequence
is self-delimiting; see [DESIGN.md](DESIGN.md#container-framing-choices)
for why these fields were deliberately left out.

## 3. The Record Architecture

Every Record is a sequence of CBOR items terminated by a CBOR Map — one
typeID-bearing item (a bare uint, or a namespace-pairing array),
optionally one NDEF-ID-equivalent text string, zero or more unknown items
(forward-compat padding for future QDEF evolution), then a field Map as
the record delimiter. Using a Wi-Fi Record (Type `100`, see
[EXAMPLES.md](EXAMPLES.md)) as the example (this is where §3.2's even/odd
rule applies):

```
Prefix: 100                                  // typeID (uint 100)

Map:
+-----+------------------------+-------+----------+-----------------------------+
| Key | Value                  | Type  | Even/Odd | If unrecognized             |
+-----+------------------------+-------+----------+-----------------------------+
| 0   | "My Coffee Shop"       | text  | even     | CRITICAL: abort Record      |
| 2   | "guest123"             | text  | even     | CRITICAL: abort Record      |
| 4   | 2                      | uint  | even     | CRITICAL: abort Record      |
| 1   | true                   | bool  | odd      | OPTIONAL: silently ignored  |
+-----+------------------------+-------+----------+-----------------------------+
```

Every Record — a plain content Record like this one or a standard record
type Wrapper Record (§4.1) — has exactly this shape: a typeID-bearing
item, optionally an NDEF-ID, followed by a Map. Field values may be any
well-formed CBOR item now, not just scalars and strings (§3.2) — the
"never needs recursion" property §3.3 describes still holds, just via a
bounded explicit stack (the same one already used to skip unrecognized
prefix items) rather than a shape restriction.

The parser uses a two-phase loop to find each Record's boundaries:
Phase 1 recognizes the Record's single typeID-bearing item (a bare uint,
or a namespace-pairing array), then its optional NDEF-ID text string.
Phase 2 skips any non-map items (forward-compat padding) until it
reaches the first Map, which serves as the record delimiter.

### 3.1 Record Type ID (prefix item) and the NDEF-ID-equivalent

Every Record begins with exactly one typeID-bearing item — a bare uint
(major type 0), or a namespace-pairing array (below) — at the start of
the Record, before the field Map, optionally followed by exactly one
bare text string (the NDEF-ID-equivalent, below). There is no backup-
typeID mechanism and no decentralized (byte string) or Named (text
string) Type ID form: both were retired once removing them turned out
to cost nothing real (every job they did is better served by a
namespace-scoped uint or, for genuine self-certification, doesn't
survive contact with an actual adopter's practice) and to gain a real
simplification — one typeID-bearing item per Record instead of an
accumulated run, and a clean, unambiguous slot for the NDEF-ID
equivalent. See docs/FINDINGS.md for the full reasoning.

The parser reads this prefix item to decide what kind of Record it's
looking at, or to skip a Record it doesn't recognize. A Record with no
typeID-bearing item before the map cannot be routed at all and MUST be
marked as ignored (§3.2's well-formed-but-unroutable case).

The typeID's CBOR major type determines its classification:

```
+------------------+-------------------+------------------+-----------------------+
| typeID CBOR type | Classification    | Scope            | Meaning               |
+------------------+-------------------+------------------+-----------------------+
| uint, even       | Standard record   | Always global    | Registered standard   |
|                  | type              |                  | mechanism or content  |
|                  |                   |                  | type                  |
+------------------+-------------------+------------------+-----------------------+
| uint, odd        | Scoped record     | Namespace-       | REQUIRES a declared   |
|                  | type              | scoped           | namespace (§3.5);     |
|                  |                   |                  | absent namespace,     |
|                  |                   |                  | Record MUST abort     |
+------------------+-------------------+------------------+-----------------------+
```

Even uints are always globally interpreted regardless of any declared
namespace — this ensures standard record type mechanisms (compression,
encryption, splitting, §4) work unconditionally inside any namespaced
container, matching the universal pattern across CBOR, XML, NDEF,
Protocol Buffers, and HTTP where infrastructure mechanisms stay globally
interpretable. Odd uints require a declared namespace; without one, the
Record MUST be treated as an abort.

**TypeID form boundary.** A bare typeID item is only ever CBOR major
type 0 — a simple, self-delimiting item a parser can skip with zero
recursion. Major type 4 (array) is valid at the typeID position in
exactly one specific, structurally-recognized shape — a definite-length
2-element namespace-pairing item (below) — never as a general-purpose
typeID form; an array of any other shape at that position is not a
typeID and falls through to Phase 2's forward-compat skip like anything
else unrecognized there. Every other major type is never valid at the
typeID position. A future revision could only add a new major type, or
a new array shape, if it preserved the same bounded, zero-recursion
skip guarantee.

**Note on even/odd vocabulary reuse.** The even/odd convention also
appears in §3.2 for map *keys* (critical vs. optional). The two
conventions apply to different axes — map keys vs. typeID *values* —
and never overlap in practice. A parser checking whether a *key* is
critical never looks at a typeID's *value* parity, and a parser
classifying the Type ID never looks at field keys' parity. Both
follow the same mnemonic (even = safe/default, odd = conditional/special)
applied at different layers.

An earlier draft also wrapped the Record Map in a CBOR semantic Tag
matching the Type ID as a redundant routing path. That mechanism has been
removed; see [DESIGN.md](DESIGN.md#cbor-tag-routing--removed) and
FINDINGS.md #11 for why. The prefix-based typeID mechanism is sufficient on
its own.

**Namespace-pairing prefix item: a Record MAY declare or override its
own namespace inline, independent of the container discriminator's
ambient one (§3.5).** In place of a bare typeID item, a Record's prefix
MAY instead hold a **namespace-pairing item**: a definite-length CBOR
array of exactly 2 elements, `[namespace, typeId]`, where `namespace` is
a byte string — the only valid Namespace ID shape, the same convention
as the container discriminator's own namespace value (§3.5; there is no
Allocated/uint namespace tier) — and `typeId` is a uint (never a byte
string — decentralized Record IDs no longer exist as a mechanism at
all). A uint in the `namespace` slot is not recognized as a pairing item
at all; the array falls through to being treated as an ordinary
unrecognized prefix item, and the Record has no typeID. When present,
the array's second element becomes the Record's routing typeID; the
array's first element declares the namespace that typeID is scoped
against, taking priority over the container's ambient namespace for
this one Record. Every other Record in the same container is
unaffected — this is a purely local override.

```
Prefix: [h'a9d6e1f30b7c4482', 1]    // this Record's own namespace,
                                     //   paired with a scoped typeID
```

An even (Standard/global) `typeId` inside a pairing is vacuous: §3.5's
invariant that even uints are always globally interpreted, regardless of
any declared namespace, is unconditional and unaffected by pairing — a
paired namespace only has an effect on an odd (Scoped) `typeId`. Pairing
is not a way to give an even typeID a namespace-flavored meaning; it
exists solely so an odd typeID can be scoped to something other than
whatever the container's discriminator ambiently declares.

**This is not a cheaper way to declare a namespace — it is a narrow,
opt-in override, and is more expensive per use than the alternative it
might be confused with.** Unlike the container discriminator (paid
once, amortized across every Record in the container), a namespace-
pairing item is paid fresh on every Record that carries one — there is
no amortization. A Record that's happy with the container's ambient
namespace should still use a bare typeID. Namespace-pairing exists to
answer one specific question — "can this one Record use a namespace
other than the container's ambient one" — enabling more than one
namespace to coexist within a single container without taxing the
common single-namespace case: every Record that doesn't need an
override still costs exactly what it always did. See DESIGN.md's
"Multiple namespaces per container" for the verified byte-cost
comparison and the two previously-considered mechanisms this one
replaces.

**Purely structural for the mandatory core (§3.3): recognizing the
2-element-array shape and extracting its nested typeId is all the core
does — it never learns what a namespace is, never compares it against
anything, never applies even/odd scoping logic.** That interpretation
(preferring a Record's own paired namespace over the container's
ambient one when resolving an odd typeID's scope) is
Record-Type-interpretation-specific handling, the same optional tier
§3.5's namespace semantics already live in.

**NDEF-ID-equivalent: a Record MAY carry a stable, type-independent
external reference, mirroring NDEF's own `ID` field.** Immediately
following the typeID-bearing item (a bare typeID, or a namespace-pairing
array), a Record's prefix MAY hold exactly one bare CBOR text string
(major type 3) — a URI-reference-style identifier an external system can
use to reference this specific Record's payload, the identical role
NDEF's own `ID` field plays (its own spec explicitly declines to
standardize what uses it, or how; QDEF makes the same choice). This
reuses a prefix-item slot that used to be split between two purposes —
a reserved-for-future-use "Named ID" typeID form, and a Type Hint
verification string — both retired alongside decentralized Type IDs
(above), leaving the bare-text-string position free for exactly one,
unambiguous meaning.

```
Prefix: 100, "wifi-record-1"    // typeID 100, NDEF-ID "wifi-record-1"
```

This is structurally separate from the typeID's own routing role: a
Record's NDEF-ID never affects which Type it routes to, and a decoder
that doesn't recognize this mechanism at all simply doesn't look for it
— it costs nothing when absent (no item is written), and a decoder that
recognizes the typeID but not the NDEF-ID mechanism still routes and
processes the Record correctly, since the NDEF-ID sits in the prefix
run, not inside the field Map. Purely structural for the mandatory core
(§3.3): recognizing "a bare text string immediately following a
recognized typeID-bearing item" is all the core does — it never learns
what the string means, the same "core exposes it raw, an interpretation
layer decides what it means" split every other optional prefix
mechanism in this section already uses. A bare text string with no
preceding typeID is not an NDEF-ID at all — it's just this Record's own
unroutable first item, and the whole Record is ignored, same as if the
prefix were empty.

**Implementer caution for uint Type IDs:** a uint Type ID MUST be encoded
as a native CBOR uint (major type 0), never wrapped in a bignum tag
(CBOR tag `2`/`3`). Verify your specific encoder does this, not just
that some CBOR library is present: this repo's own Node prototype had
exactly this bug for its entire history, undetected because none of its
own worked examples ever used a Type ID large enough to trigger it. See
FINDINGS.md #14.

**Implementer caution for the NDEF-ID-equivalent:** it MUST be a
definite-length CBOR text string (major type 3) — no shape restriction
applies to it beyond that, since it isn't a field value (§3.2's field-
value-shape rule, itself since relaxed, was never about prefix items to
begin with). Comparison, if an application layer does any, is exact and
byte-for-byte over the raw UTF-8 encoding — no Unicode normalization,
case-folding, or whitespace trimming — the same discipline this spec
applies everywhere else a string is used as an identifier, so two
independent implementations can't silently disagree about whether two
values match.

### 3.2 The Extensibility Rule (Even/Odd Keys)

Borrowed from PNG's critical/ancillary chunk convention. Note: this even/odd
rule applies to *map keys* only, not to a typeID prefix item's *value* —
see §3.1 for the even/odd classification of Type ID values, which is a
separate convention on a separate axis.

- **Even keys are CRITICAL.** An unrecognized even-numbered key MUST cause
  the parser to abort processing *that record* (not the whole stream —
  other records in the same Sequence are unaffected).
- **Odd keys are OPTIONAL.** An unrecognized odd-numbered key MUST be
  silently ignored; the rest of the record still processes normally.

This gives per-field forward compatibility: a future critical field doesn't
require any version-bump mechanism, only choosing an even key
number the current Record Type doesn't yet define.

**A Record field's value MAY be any well-formed CBOR item — a scalar, a
string, or a nested array, map, or tag of any depth.** An earlier draft
restricted field values to flat scalars, definite-length strings, and a
tag wrapping a definite-length string directly, requiring anything more
structured to be pre-encoded separately and carried as an opaque byte
string. That restriction was dropped once checking what it actually
cost turned out to matter more than what it protected: it forced a real
indirection tax on every Record Type that ever wanted natural nested
structure (see the worked example below), to guarantee a property — no
recursion at all, not even bounded — that most real decoders don't need
and the format's own physical medium already limits on its own (a QR
code tops out around 800 bytes at practical error-correction levels;
there's only so much nesting that fits). See docs/FINDINGS.md for the
full reasoning.

For example, a field carrying a list of supported Wi-Fi channel numbers
can now appear as a bare array directly:

```
7: [1, 6, 11]                     // legal now -- a bare array (major type 4)
```

Pre-encoding structured content as an opaque byte string is still a
legal, sometimes useful pattern — it lets an outer decoder skip the
value without a generic CBOR library, and lets a Record-Type-specific
handler decode it separately, the same "opaque bytes, re-parsed only by
something that opts in" pattern §4.1's Wrapper Records use at the
whole-Record level:

```
7: h'8301060b'                    // still legal -- pre-encoded [1, 6, 11],
                                   //   opaque to a decoder that skips it
```

**Skip-safety survives the relaxation — it doesn't depend on the shape
restriction the way it first appears to.** Skipping an unrecognized
field's value (or an unrecognized prefix item) never needed *true*
recursion in this format's own reference implementations: `skip_any_item`
(the mandatory core's generic "skip any well-formed CBOR item" function)
already used a bounded explicit stack, not the call stack, to walk
containers of any shape — arrays, maps, tags, indefinite-length forms
included — because unrecognized *prefix* items were never restricted to
flat shapes in the first place. Dropping the field-value restriction
just means field values now use that same, already-proven mechanism
instead of a second, stricter one. Nesting depth is bounded by each
decoder's own practical limit (an implementation detail, not part of
this spec's wire contract), not by a universal cap this format mandates.

**Advisory, not required: keep nesting reasonable.** Encoders SHOULD NOT
produce field values nested more deeply than genuinely useful content
needs — a handful of levels covers essentially every real Record Type
this project has built. Some decoders, especially ones targeting
genuinely constrained embedded hardware, MAY enforce their own,
tighter depth limit and reject anything deeper; that's a legitimate,
implementation-specific choice, not a spec violation on either side.
QR/NFC's own small capacity already does most of this work in practice —
there's rarely room to nest deeply enough for it to matter.

**Indefinite-length items are legal in field values now too — for
decoders to accept, never for conformant encoders to produce.** §3.4's
canonical-encoding requirement already mandates definite-length forms
everywhere, unconditionally, for any conformant encoder — that
requirement is unchanged. What's new is decoder-side tolerance: a
well-formed indefinite-length array, map, or chunked string reaching a
decoder from a non-canonical source is now skip-safe rather than a hard
rejection, the same "accept what's well-formed, even if not how this
spec's own encoders would have produced it" posture already applied to
oversized Type IDs and generously-tolerated forward-compat padding
elsewhere in this spec.

**Precondition on "the whole stream is unaffected":** this isolation
guarantee assumes the Record is at least well-formed CBOR — a parser
needs to determine the Record's byte length to find where the next
Record starts. A Record that fails to route (no typeID in prefix, §3.1)
is still well-formed and isolable this way. A Record that is malformed
CBOR (including a malformed indefinite-length chunk sequence) is a
stronger failure: the parser can no longer determine that boundary and
cannot safely resume the Sequence at all. Implementers should not
conflate the two failure classes — only the former is isolated to one
Record.

### 3.3 Conformance Levels

QDEF is designed so a minimal, generic parser is genuinely minimal — no
implementer has to bring a compression library or sector-reassembly logic
just to support the *container*:

- **Core QDEF parser (mandatory, all implementers):** verify magic, skip
  the discriminator as one opaque CBOR item (§3.5 — never interpreting
  its shape), walk the CBOR Sequence, read each Record's prefix typeIDs
  to route or skip it, apply the even/odd rule (§3.2) to unrecognized
  keys. That's the entire surface area — no compression, no multi-code
  state, no knowledge of any specific Record Type's fields.
- **Record-Type-specific handling (optional, per Record Type an implementer
  chooses to support):** everything else — including whether a given
  Record Type's payload happens to be compressed, or happens to require
  reassembling several codes — is defined *by that Record Type*, not by
  QDEF. An implementer who only cares about Wi-Fi provisioning (Type 100)
  never has to read, understand, or link against whatever some other
  registered Record Type does internally.

A conformant core parser never needs *true* recursion to do its job —
not because field values are shape-restricted (§3.2 dropped that
restriction), but because skipping any well-formed CBOR item, at any
depth, is done with a bounded explicit stack instead of the call stack.
A Record is always exactly `typeID-item → (NDEF-ID)? → Map`: one
typeID-bearing item, an optional text string, then one map level —
whatever structure lives *inside* the map's values is walked with the
same bounded mechanism that already handled unrecognized prefix items.
Skipping a field whose key isn't recognized, or an entire Record whose
Type ID isn't recognized, is always either a direct read, a cursor-
arithmetic jump, or a bounded-depth stack walk — never unbounded
recursion. Validated in [`rust/qdef-core`](../rust/qdef-core) — see
FINDINGS.md for the specific mechanism (`skip_any_item`) and the depth
bound being an implementation choice, not a wire-format requirement.

### 3.4 Canonical Encoding

**Encoders MUST produce CBOR meeting RFC 8949 §4.2.1's core deterministic
encoding requirements** for every Record: the shortest-form argument for
every integer, length, and tag; no indefinite-length items; and every
Record Map's keys sorted in bytewise lexicographic order of their own
encoded bytes. QDEF doesn't define a new canonical-encoding rule — it
adopts CBOR's own, unchanged.

This is a requirement on *encoders*, not decoders: a decoder reading field
values back out of a Record MUST NOT reject an otherwise well-formed
Record merely for being non-canonically encoded (key order on the wire
never affects whether `map[N]` is findable — §3's Record Map is a
CBOR map, not something position-dependent). The rule exists for a
narrower, specific reason: anywhere QDEF hashes a Record's bytes for
content-addressing (§4.1's `group_id`, and any future Sign mechanism,
§8), that hash is only meaningful as "same logical content" across
independent tools if those tools agree on what bytes "the same logical
content" produces in the first place. Two conformant encoders handed
identical field values but disagreeing on integer width or map key order
would otherwise compute different hashes for content that's semantically
identical — silently defeating `group_id`'s own stated purpose ("no
coordination is needed between independent encoders," §4.1) the moment
more than one encoder is ever involved, even though the narrower
single-encoder reassembly-integrity check `group_id` performs today
already works regardless of canonicalization.

Not a new implementation burden in practice: most CBOR encoders already
default to shortest-form arguments and definite-length items, since
that's the common case for hand-written or generated values. The one
requirement that needs explicit encoder discipline is map key
ordering — sorting a Record's handful of keys before serializing is
cheap, including on constrained hardware, and §3's Record Maps are small
by construction (a flat set of fields, never nested).

### 3.5 The Container Discriminator

Immediately after the magic (§2), every QDEF container carries exactly
one mandatory CBOR item — the **discriminator** — before the CBOR
Sequence of Records begins. Its job is the same one RIFF's form-type
(`WAVE`/`AVI `) does right after RIFF's own magic: a fast, early "what
kind of file is this" identifier, specifically a format namespace for a
QDEF-based file format that wants one. Unlike a Record, the
discriminator is not itself typeID-prefixed or Map-shaped — it is
whatever single well-formed CBOR item comes next, and its own CBOR major
type is what tells a decoder which of the shapes below it is. The
mandatory core (§3.3) only needs to know how to skip exactly one
well-formed CBOR item to find where the Record Sequence starts — it
never needs to interpret what the item means. That interpretation is
Record-Type-interpretation-specific handling (§3.3's optional tier),
prototyped in `prototype/src/header.js` and never added to the minimal
Rust core (`rust/qdef-core`), which stays exactly as small as before.

**Why mandatory, and not an optional leading Record the way an earlier
draft of this section had it.** An optional item is structurally
ambiguous the instant it's a bare uint or byte string: a decoder
scanning for a discriminator has no way to distinguish "this is the
container's own discriminator" from "this is the typeID belonging to
the container's first real Record" — both are the identical CBOR shape
at the identical position. A CBOR tag
number could mark the difference, but tag-number collision risk with
other CBOR-based ecosystems already ruled that mechanism out once
(FINDINGS.md #11, [DESIGN.md](DESIGN.md#cbor-tag-routing--removed)).
The only way left to resolve the ambiguity structurally, rather than by
convention a careless encoder could violate, is to make the
discriminator unconditionally present — always exactly one item, always
first, no exceptions — so a decoder never has to guess which case it's
looking at.

**Three recognized shapes**, dispatched purely by the discriminator
item's own CBOR major type. Namespace IDs are always Decentralized (a
byte string) — there is no Allocated (uint) namespace tier; see below
for why a namespace ID doesn't mirror even uint Type IDs' governed,
globally-issued numbering (§3.1) the way an earlier draft assumed it
should, not an oversight:

```
+-----------------------------------+------------------------------------------------------------+
| Discriminator shape                | Meaning                                                     |
+-----------------------------------+------------------------------------------------------------+
| uint 0                             | No namespace declared (cheapest legal container: 1 byte)   |
| byte string                        | Decentralized Namespace ID (self-certifying, no registry)  |
| map                                | Full extensible form: {1: namespace, 3: hint, 5: backup,   |
|                                     | ...} — the ONLY way to carry a hint or a backup ID          |
| anything else (unrecognized,       | Degrades to "no namespace" — same graceful degrade as      |
| including any array and any        | uint 0                                                      |
| nonzero uint)                      |                                                              |
+-----------------------------------+------------------------------------------------------------+
```

```
0                                      // cheapest legal container: no namespace declared

h'a9d6e1f30b7c4482'                    // bare decentralized namespace, no hint

{                                       // full extensible form -- needed for a
                                        //   hint, a backup namespace, or both
  1: h'a9d6e1f30b7c4482',              // namespace: a byte string, always
  3: "com.example/tagdrop-paper",      // OPTIONAL: recoverable Hint name,
                                        //   same hash-derivation pattern
                                        //   as below
  5: h'a7f90b3c'                       // OPTIONAL: a second, differently-
                                        //   sized namespace, for a length-
                                        //   promotion transition in
                                        //   progress
}
```

An earlier draft of this section gave namespace IDs the same uint-or-
byte-string convention §3.1 once used for Type IDs (before decentralized
byte-string Type IDs were retired entirely, §3.1), plus bespoke
positional array shapes for the hint-carrying and backup-namespace cases
(`[uint, byte string]`, `[id, text string]`, `[uint, byte string, text
string]`), growing this table to eight rows at its widest. Both were
cut, for two independent reasons: the array shapes were never worth
their own per-container-one-time cost (see FINDINGS.md's
discriminator-collapse finding), and the Allocated tier itself was
dropped once checking what a real adopter (TagDrop) actually does —
always decentralized — against what a namespace ID actually needs made
clear this axis doesn't transfer from §3.1 the way it first seemed to: a
namespace is the *global root of
trust* for everything scoped inside it (two colliding namespaces means
every Type ID scoped to each collides too), and it's exactly the value
most likely to end up baked into physical, already-printed media with no
way to retroactively fix a bad choice — see the byte-length guidance
below and FINDINGS.md for the full reasoning. The map form is the single
fallback for anything beyond a bare namespace, using the identical
even/odd key convention (§3.2) as every other Record's own field Map. An
encoder picks whichever of the three shapes is cheapest for what it
actually needs to say; a decoder MUST recognize all three, and MUST
treat any array, any nonzero uint, or any other CBOR shape not listed
above as "unrecognized," degrading to no namespace.

**A hint on a namespace ID is always self-certifying, since a namespace
ID is always a byte string.** Key `3`'s Hint name always plays the full
self-certifying strengthening role the hash-derivation convention below
describes (pinned algorithm, opportunistic verify) — a uint can't be
hash-derived from a name the way a truncated digest can, but that's
never a concern here, since there's no uint namespace form to fall back
to weakly. Concretely: anyone examining a QDEF container found in the
wild, with no registry and no external lookup available, can both read
the namespace's name off the wire *and* verify it actually matches the
namespace bytes.

**Unrecognized shape degrades gracefully, exactly like `uint 0`.** A
discriminator item that is well-formed CBOR but doesn't match either of
the two namespace-bearing shapes above (a bare byte string, or the map
form — including any array, and including any nonzero uint, which used
to mean an Allocated namespace and no longer means anything) is treated
identically to "no namespace declared" — never a hard failure. The
mandatory core still only has to skip it as one CBOR item; it never
needs to recognize its shape to do that.

**Not "zero cost when unused" — deliberately, and by design.** Because
the discriminator is unconditionally present, every container pays for
it, including one that wants no namespace at all: `uint 0` still costs
1 byte. This is a considered trade-off, not an oversight — see
[DESIGN.md](DESIGN.md#container-discriminator-redesign) for the full
byte-cost accounting and the reasoning that led here. In short: a
single byte answering "is this a generic QDEF record, or a specific
application's own file format" is proportionally negligible next to any
realistic payload, and it buys back real savings (§3.1's own typeID
prefix items no longer have to do double duty as an ambiguous
leading-Record-or-header guess) the instant a namespace actually is
wanted.

**An application whose carrier already isolates its content from every
other QDEF-aware decoder generally has no need for this mechanism at
all, for the same reason it has no need for §2's magic bytes.** Its own
URI scheme, or an app-specific NDEF MIME type, already guarantees
nothing but that application's own decoder will ever interpret its Type
IDs — the cross-app collision-safety a declared namespace exists to buy
isn't needed when there is no shared, generic dispatch context for other
apps' Type IDs to collide within in the first place. Such an application
can use a small, self-allocated even Type ID (the `32768`+ tier, §4) with
no namespace, no discriminator item at all (§2's own-URI-scheme carrier
path), and no per-code repetition cost — cheaper than namespace-scoping
and just as collision-safe *in that application's own actual
deployment*, even though the same ID would not be safe to assume
collision-free in a shared, generic QDEF container. Namespace-scoping
earns its cost specifically where that isolation doesn't already
exist — a byte-mode QR or an NDEF payload with no app-specific MIME
type, where genuinely unrelated apps' content might share one container.
See DESIGN.md for the real, verified byte-cost comparison this
recommendation is based on.

**Caution: this safety is a property of the carrier at the point of
consumption, not of the bytes themselves — it does not survive reuse
across carriers that don't all provide equivalent isolation.** Even
Type IDs carry zero self-protection of their own (§3.1); "isolated" and
"unisolated" byte sequences are bit-for-bit identical, and nothing in
the wire format marks which one a given blob is. An implementer who
reuses the identical CBOR-sequence bytes across multiple carriers for
implementation simplicity — e.g. the same bytes underlying both an own
URI scheme and a raw NDEF record — MUST verify *every* carrier those
bytes can reach provides isolation, not just the primary one; a single
future carrier added without an equivalently exclusive dispatch
mechanism (a shared/generic MIME type, a bare byte-mode QR with no
distinguishing wrapper) silently reintroduces full collision exposure
for every even Type ID already in use, with no wire-level signal that
anything changed. More fundamentally, this mechanism is in direct
tension with wanting broader interoperability: an application that
wants its content recognizable by tools other than its own decoder is,
by definition, choosing not to stay isolated — for that application,
namespace-scoping or an eventual First Come First Served registry entry
(§4) is the more robust choice, since either stays collision-safe
regardless of which carrier the bytes travel through.

**Recommended pattern for an isolated-carrier application: namespace-
scoped odd Type IDs with the namespace *implied* by the carrier, never
transmitted — not self-allocated even IDs.** An application whose
carrier already isolates it (above) doesn't have to choose between
"cheap but carrier-dependent" (a self-allocated even ID) and "safe but
costs a transmitted discriminator" (an ordinary namespace declaration).
It can have both: decide on a real namespace value once, and have its
own decoder assume that fixed value applies to *any* content reaching it
through *any* of its own carriers — the wire bytes never carry a
discriminator at all (exactly as today, §2), but the decoder's own
Record-Type-interpretation layer resolves odd Type IDs against that
implied namespace instead of treating them as global. This costs nothing
more than the even-ID pattern (odd uints as small as `1` byte, no
discriminator transmitted) but gains real safety: an odd Type ID with no
namespace present is a spec-mandated abort (above), so if the exact same
bytes ever do reach an unisolated carrier, a reader fails *closed*
instead of silently, successfully misinterpreting the ID the way an
unprotected even ID would. It also leaves a clean, zero-renumbering path
to genuine interoperability later — start transmitting that same
namespace value explicitly, via an ordinary discriminator, on whichever
carrier doesn't imply it; the Type IDs themselves never have to change.

The one requirement this depends on: the implied namespace value MUST be
identical across every one of the application's own carriers. Using
different implied values for, say, a URI-scheme path and an NDEF path
reintroduces exactly the cross-carrier inconsistency this pattern exists
to avoid.

**A namespace value is always a byte string — there is no uint
(Allocated) namespace tier.** This is a deliberate departure from §3.1's
Record Type ID convention, not an oversight: a namespace ID is the
*global root of trust* for everything scoped inside it (two unrelated
namespaces sharing the same byte string ID would collide every Type ID
scoped to each, not just one identity), and unlike most Type IDs, a
namespace value is exactly the kind of thing that ends up baked into
physical, already-printed QR/NFC media with no way to retroactively fix
a bad choice once it's out in the world. A real adopter (TagDrop)
already treats namespace IDs as always decentralized in practice, which
is what prompted checking whether the Allocated tier was pulling its
weight here at all; it wasn't (see FINDINGS.md for the full reasoning).

**Byte length guidance, grounded in the actual collision math rather
than a round number:** self-allocate freely at **4 bytes or longer** —
no coordination needed, collision safety comes from the byte length
alone. At 4 bytes (a `2^32` space), even a pessimistic estimate of
around 1,000 independently self-chosen namespaces sits at roughly a
1-in-8,600 collision probability, and the format stays comfortable into
the tens of thousands before that changes meaningfully. **Shorter than 4
bytes is reserved, not self-allocatable** — collision risk at those
widths is real even against a small, uncoordinated population (a 3-byte,
`2^24` space reaches ~3% collision risk at just 1,000 independent
picks), so a namespace this short is only safe with its uniqueness
actually guaranteed by direct coordination. There is no formal registry
process for that today, deliberately — see "Standard library
governance" in DESIGN.md for why this project's registry effort is
aimed elsewhere; if a genuinely compact namespace is ever needed badly
enough, that's a conversation to have directly, not infrastructure to
pre-build speculatively.

This 4-byte floor is intentionally conservative relative to what a
humble estimate of QDEF's real adoption might suggest (a niche format
could plausibly see far fewer than 1,000 total namespaces, ever) —
deliberately so: the two ways to be wrong about the eventual population
size aren't symmetric. Choosing a longer namespace than turns out to be
necessary costs a few extra bytes, once, forever negligible against any
realistic payload. Choosing shorter than turns out to be necessary is
unfixable the moment it's printed on physical media the format actually
succeeds with. Given that asymmetry, sizing for a plausible-upside
scenario is the only choice that doesn't risk being caught out by its
own eventual success.

**Hash-derivation algorithm, for any self-certifying byte string value
this spec calls for** (namespace IDs here, and App Route's decentralized
pre-filter form, §4.4 — the general-purpose primitive, not tied to Type
IDs specifically since decentralized Type IDs no longer exist as a
mechanism). Key `3`'s Hint name MAY be bound to the namespace value by
deriving it as a truncated hash of the Hint name string, rather than
choosing the namespace bytes purely at random: this upgrades the Hint
from an unverifiable claim into something anyone can independently
check — recompute the hash, compare to the namespace value — without
trusting a registry or a possibly-unreachable original author, the same
"hash as proof" instinct already behind `group_id` (§4.1) and the Sign
coverage scheme (§8). No version marker is needed to record whether a
given value used this convention: verification is opportunistic — if
the hash matches, the binding is confirmed; if it doesn't, the Hint name
simply degrades to a plain, unverified label.

The derivation algorithm is pinned, not left as "hash(name)" with
implementation-defined details — "anyone can independently check" is
only true if independent implementations actually agree on what they're
computing:

```
digest = SHA-256(UTF-8(name))
N      = developer-chosen byte length (4+ for namespace IDs, per this
         section's own byte-length guidance above)
Value  = digest[0..N] as a definite-length CBOR byte string (major type 2)
```

SHA-256 over the name's raw UTF-8 bytes (not any CBOR encoding of the
string) was chosen for the same reason `group_id` and CoAP/COSE registry
reuse elsewhere in this spec favor already-ubiquitous, already-
implemented primitives over inventing new ones.

**Pinning the algorithm only solves half the problem — the input `name`
still has to be collision-resistant itself, or the derived value
inherits whatever collision risk the name has.** SHA-256 is a good hash,
but a good hash of a bad input is still a bad input: two unrelated
implementers who each pick a short, generic word for a similar concept
derive the *exact same* value — a certain collision, not a probabilistic
one, since the derivation is deterministic. **A name feeding hash-
derivation SHOULD be qualified by something the namer actually,
verifiably controls** — a reverse-domain string
(`"com.example.tagdrop"`, not bare `"tagdrop"`) is the recommended
convention, the same one Java packages, XML namespaces, and MIME
subtypes already use for exactly this reason: a domain two unrelated
parties could plausibly both register is already vanishingly unlikely by
construction (DNS is itself a collision-free allocation system), which
is what actually restores the "behaves like a random draw" property the
whole mechanism depends on.

**The namespace's Hint name is exactly the case that needs this
qualification, not a case that's exempt from it.** Nothing outside the
namespace itself protects a hash-derived namespace value from collision
— unlike a Record-Type-local field value used *inside* an
already-declared namespace, which doesn't need qualifying, since
collision-safety there already comes from the namespace itself.

Prototyped in `prototype/src/header.js`'s `verifyNamespaceHint`, which
calls the same shared derivation used elsewhere in the prototype rather
than reimplementing it. Locks in a real bug this exact
underspecification once caused: an earlier version of this prototype
always truncated to 4 bytes regardless of the candidate value's actual
width, silently unable to verify any 64-bit-class value — exactly the
width this project generally recommends for maximum safety. See
FINDINGS.md #21.

**No dedicated "version" field, and the discriminator does not get
"versioned" by minting new shapes for future revisions beyond the three
above.** The map form is already the fully extensible escape hatch: a
genuinely incompatible future addition is just a new even/critical key
in the map form, whenever it's actually needed, using the same even/odd
extensibility (§3.2) every Record's own field Map already relies on. A
decoder that doesn't recognize a future key inside the map form aborts
only that key's effect (or the whole map form, if the new key is
even/critical) and falls back to unnamespaced — the same graceful,
already-proven degrade every unrecognized discriminator shape gets.

**What a declared namespace changes, and what it doesn't.** Even uint
Type IDs always stay globally, absolutely interpreted regardless of any
declared namespace — standard record type mechanisms (§4: a generic tool
must still be able to unwrap Split/Compress/Encrypt and recognize App
Route inside a namespaced file) *and* registered content types (§8's
Registry governance). This is deliberate: a generic tool that only
implements the standard record types must keep working unconditionally
inside any namespaced container, without needing to know a namespace
mechanism exists at all.

**Odd uint Type IDs become namespace-scoped once a namespace is declared,
reusing the existing flat numbering space rather than carving out a new
range for it.** When the discriminator declares namespace `N`, a subsequent Record's
odd Type ID `T` is no longer looked up as the bare global identity `T` —
its real identity is the *compound* key `(N, T)`, exactly the way a
Bluetooth short UUID only means anything paired with the Base UUID it's
declared against. This is why no new numeric range is needed for the
scoped tier itself: nothing is reinterpreting what `T` means in isolation,
because `T` in isolation is no longer the lookup key at all once a
namespace is present. An app with its own declared namespace can freely
use small, sequential odd Type IDs (`1`, `3`, `5`...) for as many Record
Types as it needs — genuinely minimal on the wire (CBOR encodes any
value `0`–`23` in a single byte, so odd IDs up to `23` cost nothing more
than the smallest possible typeID) and collision-free by construction,
since collision safety now comes from the namespace, not from the ID's
own width. There is no magnitude floor on a namespace-scoped odd
uint — parity alone determines scoping (§3.1), so there is nothing to
be gained by picking a larger starting value.

`N` here is normally the container discriminator's own ambient
namespace, but a specific Record MAY instead pair its own typeID with a
different namespace inline (§3.1's namespace-pairing prefix item),
overriding `N` for that one Record only — the mechanism that lets more
than one namespace coexist within a single container without taxing the
common single-namespace case.

**Byte string Type IDs are always global regardless of any declared
namespace.** Collision safety for byte string IDs comes from the byte
length the developer chose, not from a namespace. A namespace does not
scope byte string IDs — they are looked up by their bare value, same as
even uints. This keeps the decentralized allocation model independent of
namespace scoping: a developer choosing a byte string ID is choosing
collision safety from width, and that choice is unaffected by whether a
namespace happens to be declared.

**Odd uint without a namespace is an error.** An odd uint Type ID without
a declared namespace has no collision safety source — not registry
curation (it's not registered), not numeric width (odd uints can be
small), and not a namespace (none declared). A Record with an odd uint
Type ID and no discriminator declaring a namespace MUST be treated as
an abort of that Record — this is stricter than the current even-uint
fallback, and deliberately so: a wrong match is worse than a clean miss.

**This is Record-Type-interpretation-specific handling (§3.3's optional
tier), not a mandatory-core requirement.** The mandatory core is
unaffected: it still just skips the discriminator as one opaque CBOR
item and reads prefix typeIDs to route or skip Records, with zero
knowledge of namespaces, exactly as validated today (`rust/qdef-core`
needs no discriminator-shape-specific code at all beyond splitting it
off). The correctness obligation
falls on any decoder that implements specific semantics for *any*
odd uint or namespace-local Type ID: such a decoder MUST check for a
declared namespace before applying its interpretation, and MUST NOT fall
back to a global reading merely because it doesn't recognize the specific
`(namespace, TypeID)` pair — that pair is simply unrecognized, skipped the
same way any other unrecognized Type ID is, never silently reinterpreted
as the global meaning of the same number. Getting this wrong is a real,
worse-than-usual failure mode (a *wrong* match, not a clean miss) — it
is the one sharp edge this mechanism has, and it exists precisely because
odd uints are being asked to serve two different lookup schemes (global
vs. namespace-scoped) depending on context a decoder must actually check,
not assume.

**MUST repeat, identically, on every physical code of a multi-code group
whenever that group carries any namespace-scoped (odd uint) Type ID —
whether the scoped Type ID belongs to a plain sibling Record or is only
reachable after a Wrapper stack (§4.1) fully resolves.** Each physical
code is its own independent container, parsed from a blank slate with no
cross-code state (§8) — a decoder holding only one code out of a group
has no way to learn a namespace declared on some other code. This is the
same reasoning that already requires Fallback Hint's URI and App Route's
hash-derived form to repeat per code (§4.2, §4.4): a mechanism meant to
work from any single code, or to survive losing one, cannot rely on a
declaration that exists on only one of them. It applies with equal force
to a Type ID only reachable after Split reassembly: `parity_scheme`
(§4.1) recovers a missing *fragment's bytes*, but the discriminator is a
whole leading item, not fragment data — parity gives it no protection
at all. A namespace declared on a single code is therefore a genuine
single point of failure the Split-protected *content* does not share:
losing that one code loses the namespace even when every other code
needed for full content recovery is intact. Once declared, the same
namespace value applies to every Record in that code's own Sequence *and*
to whatever Record a Wrapper stack (Split/Compress/Encrypt) in that
Sequence ultimately resolves to, once fully unwrapped.

**A Wrapper-wrapped Record's inner Type ID is never bare and never
repeated the way a plain sibling Record's is — worth stating as its own
principle, since it changes the byte-cost math for whether
namespace-scoping a given Type ID actually pays off.** A plain sibling
Record with a namespace-scoped Type ID is typically repeated verbatim
across every code (for the same resilience reasons as the discriminator
itself), so shrinking its Type ID to a namespace-scoped odd uint saves
that shrink *N times* — once per code it's repeated on. A Type ID only
reachable after a Wrapper stack (Split/Compress/Encrypt) fully resolves
is structurally different: it exists exactly once, fragmented or
otherwise encoded across the group, reconstructed once at the end — so
shrinking *that* Type ID saves the shrink exactly *once* for the whole
group, not once per code. When computing whether a given Type ID is
worth namespace-scoping, use the repeated-savings math (below) for a
plain sibling and the one-time saving for a Wrapper-reachable one — they
are not the same calculation, and conflating them overstates a
Wrapper-reachable ID's contribution to clearing the discriminator's
own per-code repetition cost. See DESIGN.md's "Namespace repetition
across a multi-code Split group" for a worked example of exactly this
distinction.

**This has a real wire-code cost, now cheaper than the earlier
optional-Record design — verified against the actual encoder, not
assumed.** Repeating a decentralized-namespace discriminator (a bare
4-byte byte string, no hint) on every code costs 5 bytes *per code*
(down from the earlier optional Type `0` Record header's 8 bytes,
since the discriminator no longer pays for its own typeID prefix and
map-wrapper framing). Shrinking one namespace-scoped Type ID from a
private-use-random byte string to a small odd uint saves at least 8
bytes for a genuinely minimal odd uint. A single namespace-scoped Type
ID repeating alone on each code is therefore already a net **win**
(+3 bytes/code) on its own, not merely a breakeven — an adopter should
still count how many namespace-scoped Type IDs actually co-occur per
physical code before assuming the savings compound, since only the
first shrunk ID needs to clear the discriminator's now-smaller,
per-code repeated cost.

Prototyped in `prototype/src/wrappers.js`'s `resolveStack`: reads each
code's discriminator via `header.parseDiscriminator`, requires every
code that declares one to agree, and applies the agreed namespace to
whatever Record the stack ultimately resolves to.
`prototype/test/multi-code-namespace.test.js` demonstrates the
mechanism end to end — including the single-point-of-failure case
above, reproduced directly: a namespace declared on only one code
resolves correctly while that code survives, and aborts the instant
it's the one dropped, even though XOR parity fully recovers the
Split-protected content regardless.

**Fully additive, no migration forced.** An app with an existing even uint
Type ID keeps it working forever, namespaced container or not — nothing
about this mechanism invalidates any ID that predates it. Adopting
namespace-scoped odd uint IDs for *new* content is an independent,
opt-in choice; an old even ID and a new scoped odd one for "the same"
logical Record Type never collide, because an even ID was never
namespace-scoped to begin with.

Prototyped in `prototype/src/header.js` and `prototype/test/header.test.js`:
round-trip coverage for all three discriminator shapes, the
unrecognized-shape graceful degrade (including every array form and the
dropped Allocated-namespace uint form, now all collapsed into it), the
JS falsy-zero trap guarded against explicitly, and cross-validated
against the Rust core (`rust/qdef-core`), which needs no
discriminator-shape-specific code at all to split it off and route/walk
the Records that follow correctly.

## 4. The QDEF Standard Record Types

QDEF is a *format plus a set of standard record types*, not just the
format — the same relationship C-the-language has with libc. §3 defines
a minimal core any conformant parser must implement, and says nothing
about compression, splitting, encryption, or graceful degradation for
scanners that don't understand a given Record Type. Those live here
instead: a small, curated set of Record Types any application can pull
in — writing no reassembly code, no cipher code, no fallback-routing
code of its own.

**Standard record type IDs:** even numbers `2`–`98` are reserved for
these standard record types, maintained alongside the QDEF spec itself.
Even numbers `100` and above are open for applications to register their
own domain-specific Record Types ([EXAMPLES.md](EXAMPLES.md)) — who governs *that*
allocation is still open (§8), but at least the two registries are
partitioned by construction and can't collide.

**Currently assigned Type IDs — the complete list, gathered in one
place.** Each is defined in full in its own subsection below; this
table exists purely so an implementer can check or cross-reference an
ID at a glance without hunting through prose, since a typo here (using
the wrong number for a standard record type) collides silently with
whatever real ID that number belongs to instead of failing loudly:

```
+------+------------------+---------+---------------------------------+
| ID   | Record Type      | Section | Notes                          |
+------+------------------+---------+---------------------------------+
|  2   | Split            | §4.1    | Fragment reassembly / parity    |
|  4   | Encrypt          | §4.1    | AEAD (e.g. AES-256-GCM)         |
|  6   | Media Payload    | §4.3    | Typed binary content            |
|  8   | Compress         | §4.1    | DEFLATE                         |
| 10   | Fallback Hint    | §4.2    | URI fallback for unaware readers|
| 12   | App Route        | §4.4    | Application dispatch/routing    |
+------+------------------+---------+---------------------------------+
```

All six sit in the `0`–`22` Standards Action tier — this spec document's
own publication *is* the authoritative declaration for them, the same
way CBOR's own tags `0`–`23` are authoritative by virtue of being
defined in RFC 8949 itself, independent of whether IANA's registry
infrastructure is actively processing anything. No separate "registry
running" is needed to make these six real; a future registry authority
(§8) inherits and records them, it doesn't grant them. This is different
from an adopter's own pick in the `100`–`32767` tier (e.g. the
illustrative `900` in "Registering a real Type ID before governance
exists," below) — that tier's allocations genuinely are provisional
until a review authority exists, since nothing in this spec document
itself declares what any specific number in that range means.

**Type ID allocation ranges** (adapted from CBOR's tag registry pattern,
RFC 8949 §9.2):

```
+----------------+----------+----------------------------------------------+
| Range          | Even/Odd | Purpose & governance                         |
+----------------+----------+----------------------------------------------+
| 0–22           | even     | Standards Action — Wrapper Records and other  |
|                |          | standard record type infrastructure,         |
|                |          | spec-maintained                              |
| 24–98          | even     | Specification Required — standard record     |
|                |          | types reserved for future use                |
| 100–32767      | even     | Specification Required — common vocabulary,  |
|                |          | reviewed application-specific types          |
| 32768+         | even     | First Come First Served — self-allocated     |
| odd uints      | odd      | Namespace-scoped only (§3.5) — requires      |
|                |          | declared namespace, abort otherwise          |
+----------------+----------+----------------------------------------------+
```

**"Governed" and "review-gated" are independent properties, not the
same axis — this is the actual line between the tiers above.** Every
tier's collision-safety comes from exactly one of two sources here:
curation (a registry that both records *and* reviews an allocation
before granting it) or recording (a registry that tracks who claimed
what, first-come, with no review gate). Standards Action and
Specification Required both sit in the first category (reviewed); First
Come First Served sits in the second (recorded, not reviewed). No
registry authority exists today for *any* uint tier (§8) — that's a
separate, current-state fact from which of these collision-safety
models a given tier is *intended* to use once one does. (Namespace IDs,
§3.5, use a third source — self-certification from byte length alone,
with no registry involved at all — but that's a namespace-layer
property, not a Type ID tier here; there is no equivalent self-
certifying Type ID form anymore.)

**Choosing a Type ID form.** Three mechanisms sit above, each solving
collision-safety a different way. Work through these questions in
order; stop at the first `YES`:

```
1. Is this part of QDEF's own standard-record-type infrastructure
   (a Wrapper Record or similar mechanism, not application content)?
     YES -> even uint 0-22 (Standards Action, spec-maintained -- not
            something an application ever picks for itself)

2. Do you want this Type eventually recognized by unrelated
   implementers, even though no registry exists yet (§8)?
     YES -> even uint 100-32767 (Specification Required / common
            vocabulary). Ship now with an illustrative number -- there
            is no cheaper provisional-placeholder mechanism anymore
            (no backup typeID promotion path), so pick the number you
            intend to keep.

3. Does your application already have -- or are you willing to
   declare -- a namespace (self-chosen; §3.5 has no Allocated/uint
   namespace tier, so this is always a byte string you pick yourself)?
     YES -> a small sequential odd uint (1, 3, 5...) inside that
            namespace. The cheapest option (as little as 1 byte), and
            if your carrier already isolates you (own URI scheme, own
            NDEF MIME type), the namespace itself can be implied by
            that carrier and never transmitted at all (§3.5) -- so
            this option is usually available "for free" even without
            wanting to pay for an explicit namespace declaration.
     NO  -> a self-allocated even uint, 32768+ (First Come First
            Served) -- but only if your carrier already isolates you
            (own URI scheme, own NDEF MIME type) and you're accepting
            that its safety is carrier-dependent (§3.5's caution)
            rather than declaring a namespace after all (re-read the
            YES branch first -- the implied-namespace pattern costs
            the same and is strictly safer).
```

Most application Record Types resolve at step 3's `YES` branch — a
declared namespace, implied or explicit, with small sequential odd
uints inside it. See DESIGN.md's "Registry governance" and
FINDINGS.md #29/#30/#36 for the full reasoning behind why namespace-
scoping is the default, and why decentralized (self-certifying) Type
IDs were retired as a mechanism entirely.

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

Wrapper Type IDs, authoritatively assigned by this spec document itself
(Standards Action, `0`–`22` — see the note above the Type ID allocation
table on why that tier needs no separate registry to be real):

```
Type 2: {                    // Split
  // prefix typeID: 2
  // field map:
  0: h'<group_id>',          // CRITICAL: content-addressed (a hash of the
                              //   full reassembled bytes) — never an issued
                              //   serial, so no coordination is needed
                              //   between independent encoders (relies on
                              //   §3.4's canonical-encoding rule to actually
                              //   hold across more than one encoder). A
                              //   decoder MUST recompute this hash after
                              //   reassembly and reject a mismatch — it
                              //   doubles as the group's integrity check.
  2: 1,                      // CRITICAL: this fragment's index
  4: 4,                      // CRITICAL: total fragment count in the group
  6: h'<fragment bytes>',    // CRITICAL: this code's slice
  7: 5821,                   // OPTIONAL as a key (odd), but MUST be present
                              //   whenever key 9 (parity_scheme) is set —
                              //   see chunking rule below. When present:
                              //   total_bytes of the reassembled whole.
  9: 1                       // OPTIONAL: parity_scheme — 0/absent = none,
                              //   nonzero selects a registered forward-
                              //   error-correction scheme so the group
                              //   tolerates a missing/damaged code.
}

Type 8: {                    // Compress (DEFLATE)
  // prefix typeID: 8
  // field map:
  0: h'<deflate bytes>'      // CRITICAL
}

Type 4: {                    // Encrypt (e.g. AES-GCM)
  // prefix typeID: 4
  // field map:
  0: h'<nonce>',             // CRITICAL
  2: h'<ciphertext+tag>',    // CRITICAL
  3: 3,                      // OPTIONAL: Algorithm — 3 = A256GCM
  5: -25                     // OPTIONAL: Key Algorithm — -25 = ECDH-ES+HKDF-256
}
```

**Keys `3` (Algorithm) and `5` (Key Algorithm)** are each a uint or a text
string, an encoder's choice — the same two-form pattern as §4.3's Media
Type, and for the same reason: both name something with a stable identity
independent of QDEF, so there's no opacity for a decentralized-ID-plus-
hint layer to resolve, just a compact number when one's registered and a
plain string otherwise.

- **A uint** is a [COSE Algorithm
  ID](https://www.iana.org/assignments/cose/cose.xhtml) (RFC 9053/9054) —
  an existing, actively maintained IANA registry, tiered by governance
  strictness the same way CoAP's Content-Formats and QDEF's own Type ID
  space are. It already covers both halves of this problem: content
  encryption algorithms (`1`/`2`/`3` = A128GCM/A192GCM/A256GCM) *and*
  key-agreement/wrap/derivation algorithms (`-25` = ECDH-ES+HKDF-256,
  recipient-public-key wrap; `-10` = direct+HKDF-SHA-256, a shared
  secret/passphrase; `-5` = A256KW, key wrap) — including negative
  integers, which §3.2's field-value-shape rule already permits.
- **A text string** names the algorithm directly for anything not
  registered there.

Key `5` resolves this Wrapper's other long-standing gap: which cipher was
actually used was previously only ever an implicit, out-of-band
assumption (the `(e.g. AES-GCM)` comment above was illustrative, not a
field). Key `7` is the fix for the key-provisioning gap specifically: two
independent apps can now interoperate on *how* the symmetric key was
obtained, not just agree that something called "Encrypt" happened.

Both keys are odd/optional, matching `parity_scheme`'s precedent (§4.1's
Split fields) rather than nonce/ciphertext's: absent, everything works
exactly as before (two ends that already agree out of band, as in §7's
worked example, need neither field), and a decoder that doesn't recognize
either key simply falls back to whatever algorithm it already assumed —
which fails safely either way, since AEAD's own authentication tag check
already catches a wrong-algorithm or wrong-key attempt. They exist for
when unrelated apps need self-description, not to tax the case that
already works.

**A decoder that does honor key `3`/`5` MUST NOT let them broaden which
algorithms it's willing to run** — the same "alg" confusion class of
vulnerability JOSE/JWT is well known for (an attacker-controlled
algorithm identifier tricking a verifier into a weaker or inappropriate
algorithm than it intended). Treat the field as a hint to check against
an application-chosen allowlist, never as an instruction to trust
outright.

**Encrypt cannot provide deniability, and that's a scope boundary, not a
gap.** Being wrapped in a Type-`4` Record at all is itself a visible
declaration — "this is encrypted content" — to any QDEF-aware parser
walking the Sequence, whether or not it can decode the payload, because
Type ID routing (§3.1) happens unconditionally before any per-Record-Type
logic runs. An application whose threat model requires ciphertext
indistinguishable from random has a requirement this wrapper structurally
cannot satisfy no matter how its fields are shaped — self-describing
dispatch is the format's entire reason for existing. Such an application
should keep its own encryption entirely inside an opaque registered blob
(§5) rather than use this wrapper, the same way any application with its
own proven mechanism should (§6). See FINDINGS.md #13.

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
resolved — see §8.

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
keeps unwrapping whatever Wrapper Type ID it finds next — confirmed
against a prototype run of both the documented order and a deliberately
reversed one (see FINDINGS.md #7 and
[DESIGN.md's "Nesting order enforcement"](DESIGN.md#nesting-order-enforcement--now-answered-not-open)).

**Why a wrapper, not a reserved key range on the inner record itself:**
wrapping avoids a cross-record correctness hazard. See
[DESIGN.md](DESIGN.md#wrapper-records--why-a-wrapper-not-a-reserved-key-range)
for the full rationale.

**Cost:** wrapper framing (CBOR map + a few keys) is added per code on top
of the inner record, so this stays strictly opt-in — a Record Type with no
need for it stays a plain, unwrapped Record, exactly as cheap as
[EXAMPLES.md](EXAMPLES.md).

### 4.2 Fallback Hint (optional)

Unlike §4.1, this is deliberately **not** a wrapper — a plain standard record type Record
Type meant to sit as a *sibling* alongside real content records in the same
CBOR Sequence, carrying a URI any generic tool can follow if it doesn't
understand anything else in the container:

```
Type 10: {                         // Fallback Hint (standard record type)
  // prefix typeID: 10
  // field map:
  0: "https://example.com/open-this",  // CRITICAL: a URI a generic tool
                                        //   or browser can follow
  1: "Open in MyApp",                   // OPTIONAL: human-readable label
  3: "en",                              // OPTIONAL: BCP 47 language tag
                                         //   for key 1's label
  5: 0                                  // OPTIONAL: suggested action --
                                         //   0 = perform the action (open
                                         //   the URI), 1 = save for later,
                                         //   2 = open for editing
}
```

This is what gives a QDEF container the "something useful happens even
without the specific app" property. It **must** stay a plain sibling
record, never nested inside a Wrapper — its entire value is being visible
to a parser that understands nothing else in the container, which a
Wrapper's opaque payload would defeat.

**Keys `3` and `5` exist for lossless conversion to and from NDEF's Smart
Poster RTD** (see DESIGN.md's "Relationship to existing standards" for
the full comparison this was checked against), which carries a language
tag on its title text and an action code neither of QDEF's original two
fields had anywhere to hold. Both are odd/optional (§3.2): a decoder that
doesn't recognize either still gets a fully working URI and label — the
same graceful degrade Fallback Hint already guarantees for its two
original fields, now extended to both new ones. Key `5`'s three values
mirror Smart Poster's own action codes exactly, borrowed rather than
reinvented, the same "use an existing small enum instead of inventing
one" choice already made for Encrypt's Algorithm field (§4.1) and Media
Payload's Media Type field (§4.3).

**Multiple languages, or multiple URIs, need no new mechanism at all —
just repeat Fallback Hint as an ordinary sibling Record, once per
variant.** Nothing in QDEF restricts how many Records of the same Type
appear in one Sequence; a decoder collecting every Fallback Hint sibling
and picking the best language match already reproduces NDEF's
multi-title Smart Poster behavior and its Multiple URI RTD, without
needing a dedicated list-carrying field. A bare array value is legal
under §3.2 now, but it would still mean every decoder special-cases one
field as list-shaped instead of using the uniform per-Record iteration
it already needs everywhere else — repetition-as-siblings is the simpler
mechanism, not the only technically possible one.

**Not adopted: NDEF URI RTD's compact prefix-code trick** (a 1-byte code
standing in for a common scheme prefix like `"http://www."`), despite
QDEF otherwise readily borrowing external tables (CoAP Content-Formats,
COSE Algorithm IDs) when one already exists and is worth the byte
savings. Checked concretely, not assumed away: representing it would
need either restructuring key `0`'s value into a 2-element array
(`[prefixCode, remainder]`) — legal now that §3.2 permits any
field-value shape, but it would silently change key `0`'s type out from
under any decoder that already expects a plain URI text string there,
the same graceful-degrade break the field-splitting option below causes
on purpose — or a CBOR tag number standing in for the prefix code
(reopening the exact tag-collision risk already rejected once for
container routing — DESIGN.md's "CBOR tag-number collision"). The
remaining option — splitting key `0` into a separate prefix-code field
plus a prefix-stripped remainder — would mean a decoder that recognizes
Type `10` but not that specific field pairing sees a broken, prefix-less
string instead of a working URI, undermining Fallback Hint's entire
reason to exist: *any* decoder that recognizes the Type gets a complete,
usable URI, with no further sub-feature support required. A few bytes
saved on an already-short field isn't worth trading that guarantee away.

### 4.3 Media Payload (optional)

A plain standard record type Record Type — not a wrapper — for attaching a standard,
already-widely-recognized media type (a JPEG thumbnail, a vCard, a PDF
snippet) without registering a bespoke Type ID for every possible file
format the way [EXAMPLES.md](EXAMPLES.md) does for application-specific content:

```
Type 6: {                          // Media Payload (standard record type)
  // prefix typeID: 6
  // field map:
  0: 22,                           // CRITICAL: Media Type — uint or text,
                                    //   see below (22 = image/jpeg)
  2: h'<payload bytes>'            // CRITICAL: the content itself
}
```

**Key `0` (Media Type) may be a uint or a text string** — an encoder's
choice, and a decoder MUST accept either shape (both are already
skip-safe under §3.2's field-value-shape rule regardless of which an
encoder picks):

- **A uint in `0`–`65535`** is a [CoAP Content-Format
  ID](https://www.iana.org/assignments/core-parameters/core-parameters.xhtml)
  (RFC 7252 §12.3, as amended by RFC 9876) — an existing, actively
  maintained IANA registry that already assigns compact numeric IDs to
  common media types (`application/cbor` = 60, `image/jpeg` = 22,
  `image/png` = 23, `application/json` = 50, `text/plain;charset=utf-8` =
  0, and hundreds more), tiered by its own governance the same way QDEF
  tiers its own Type ID space. QDEF doesn't invent a numbering scheme
  here; it borrows one that already exists and is already CBOR-friendly
  (a plain small uint).
- **A text string** is the literal MIME type, spelled out directly — used
  whenever the media type isn't in CoAP's registry (e.g. `"text/vcard"`,
  confirmed absent as of this writing). Deliberately *not* a numeric ID
  paired with a hash-derivation hint, the way a namespace ID uses one
  (§3.5): a media type already has a stable, globally-meaningful name
  independent of any numeric registry (defined by RFC 6838's Media Types
  registry, which predates and doesn't depend on CoAP's numeric shortcut
  for it) — there's no opacity problem here for a hint to solve. A
  namespace ID has no other identity besides its bytes, which is exactly
  why a hash-derivation hint has real work to do there; a media type not
  in CoAP's table already has its name, so falling back to the plain
  string directly is sufficient, not a workaround.

**Depending on an external registry is a deliberate, conditional choice,
not a default.** It's only justified here because CoAP's Content-Formats
registry specifically has good prospects of staying maintained — IANA-run,
IETF-governed, updated as recently as 2025 (RFC 9876) — not merely because
*some* external registry existed to point at. QDEF should not casually
crib from a numbering scheme with a shakier maintenance outlook just to
avoid inventing one. Even so, adopters relying on this field should keep a
periodic mirror of CoAP's Content-Formats table (even just checked into a
repo alongside their own code) — cheap insurance so the numbering can be
forked and kept alive independently if that registry ever does go
unmaintained, rather than leaving every uint in this field meaningless.

Prototyped in `prototype/test/media-payload.test.js`: both the
CoAP-numeric and plain-string forms round-trip, and an application with
no interest in Media Payload skips the whole Record cleanly by Type ID
prefix alone — the same "unaware decoder pays nothing" guarantee every other
standard record type gets, not just an aspiration.

### 4.4 App Route (optional)

A plain standard record type Record — not a wrapper — for letting a generic
QDEF-aware scanner offer to launch a specific handling application,
comparable to NFC's Android Application Record (AAR) or platform
Intent-filter dispatch, without the scanner needing any
implementer-specific knowledge baked in ([GitHub issue
#10](https://github.com/mofosyne/qdef/issues/10)):

```
Type 12: {                         // App Route (standard record type) — domain form
  // prefix typeID: 12
  // field map:
  0: "example.com",                // CRITICAL: a domain the routing
                                    //   target has verified control over
  1: "Open in Example App"         // OPTIONAL: human-readable label
}

Type 12: {                         // App Route (standard record type) — hash-derived form
  // prefix typeID: 12
  // field map:
  0: h'<truncated SHA-256>',      // CRITICAL: hash-derived byte string
                                    //   value (§3.5's derivation algorithm)
  1: "com.example/tagdrop-paper"   // OPTIONAL: Hint name, same role as
                                    //   §3.5's hash-derivation hint
}
```

**Key `0` may be a domain string or a hash-derived byte string — two
genuinely different trust models for two genuinely different purposes,
not two encodings of the same thing.**

*The domain form* is deliberately narrower than a bare package name or
reverse-domain string could be. A plain string claim
(`"com.example.official"`) has no protection against spoofing: anything
can claim to be any string. A domain is verifiable using the mechanism
Android App Links and iOS Universal Links already deploy (a
`.well-known` file — `assetlinks.json` on Android, `apple-app-site-
association` on iOS — hosted on the domain the claimant controls) — QDEF
inherits that existing, proven trust machinery on both platforms instead
of inventing a new one. Use this form for auto-launch dispatch, where
getting it wrong means the wrong application opens.

*The hash-derived form* reuses §3.5's hash-derivation algorithm — the
same one namespace Hints use — to produce key `0`'s value: a byte string
value, with key `1` playing the Hint name role — a recoverable name,
optionally derived as `value = truncate(SHA-256(name), N)` so the
binding is checkable rather than an unverifiable claim, exactly as
described there. This is a plain field value, not a Type ID (App
Route's own routing typeID is always the standard uint `12` — this form
doesn't change how the Record routes, only what key `0` contains).
**This form has no anti-spoofing property, and that is not a detail to
gloss over.** The hash-derivation proves *name-to-value consistency* —
that this specific value was reproducibly derived from this specific
name — never *authorization*. Anyone can compute
`SHA-256("Example App")` and truncate to the same bytes; nothing about this form proves
the claimant is entitled to it, unlike the domain form's real ownership
proof. Use this form only where getting it wrong costs *effort*, not
*trust* — the intended case is a fast, per-code pre-filter a scanner uses
to reject obviously-unrelated scans (a misread, an unrelated nearby QR
code) before attempting the real work of reassembly, layered *ahead of*
§4.1's `group_id` integrity check, never as a replacement for it. A false
match here just means a decoder wastes effort before `group_id` catches
the mismatch anyway — not a wrongly-launched application.

Resolving a domain to an actual launch target is intentionally left to
local, OS-level dispatch — no centralized QDEF-level registry or
governance body is needed for it to function at all — but *how* that
resolution is triggered is platform-specific, not a single uniform
mechanism, and a scanner implementer needs to know which path they're
using:

- **Android** exposes an explicit query (`PackageManager` Intent-filter
  resolution) a scanner can call to ask "which installed app claims
  this domain" before deciding what to do — closer to how AAR dispatch
  already works.
- **iOS** exposes no equivalent query. A scanner instead constructs an
  actual `https://` URL from the domain (e.g. `https://example.com/`)
  and opens it (`openURL:`); iOS itself checks the domain's `apple-app-
  site-association` registration as a side effect of opening that URL,
  handing it to the registered app or falling through to Safari. The
  dispatch decision happens *inside* opening the URL, not as a separate
  lookup step.

Both still satisfy "matched only against what's actually installed
on-device, no QDEF-level registry" — the end-user outcome is the same on
either platform — but a scanner implementation needs the platform-
specific mechanism, not a shared cross-platform API, since none exists.

Key `0` carries the bare domain, not a full URL — the iOS path above
constructs `https://<domain>/` (root) from it when actually opening a
URL; an App Route Record isn't the place for path-level routing, which
belongs to the payload the application itself defines once launched.

**Deliberately decoupled from payload-shape Type IDs, not folded into
them.** An open, shared payload shape should be able to stay
interoperable across multiple independent handling applications;
routing identity is a separate concern layered alongside the payload
via a sibling Record, not encoded into the payload's own Type ID. This
also means adopting App Route never requires restructuring an
application's existing Type IDs.

**Not positionally special.** QDEF's dispatch already routes by Type ID
prefix regardless of position (§3.1), so this Record doesn't need a
fixed position in the Sequence — a decoder finds it the same way it
finds any recognized Record Type.

**Encoder etiquette — split by form, because the two forms serve
different moments in a scan.** Both forms should always be small and
plain — never Compress- or Split-wrapped — so a scanner can read one
without reassembling anything else first. Where they diverge is
repetition across a multi-code group:

- *The domain form* (SHOULD, not required): repeat it verbatim on every
  code if the adopter wants auto-launch to work from whichever code
  happens to get scanned first. Putting it on a single designated code
  only — e.g. a "metadata" code that's always scanned first by
  convention — is also a valid choice; the cost is that auto-launch
  dispatch only fires from that code, not a spec violation.
- *The hash-derived form* (SHOULD repeat on every code, more strongly
  than the domain form): its entire value is letting a scanner reject an
  obviously-unrelated scan *before* attempting reassembly. A copy on only
  one code can't do that for scans of any other code in the group — the
  pre-filter simply doesn't run for them, silently losing the only thing
  this form is for. An encoder that places it on a single code should
  treat that as accepting no pre-filtering on the rest of the group, not
  as an oversight-free equivalent to repeating it.

**"Cheap" describes the hash-derived form's per-code cost, not its
group-wide total — the two are not the same claim.** Mandatory
per-code repetition means the cost multiplies by fragment count: the
Record shown above (byte string ID plus a Hint name) is cheap on any
one code, but a 7-code Split group pays that 7 times over — for App
Route alone, on top of whatever else repeats per code (Split's
own Wrapper framing, etc.). Dropping the Hint name shrinks a
single Record significantly at the cost of losing the hash-derivation
check. Not a flaw in the mechanism — the per-code repetition requirement
is exactly what makes the pre-filter work at all — but an adopter
choosing between the two forms should weigh this against actual group
size, not just the anti-spoofing difference.

**Scope note.** App Route is QDEF's dedicated mechanism for
cross-implementer routing, entirely decoupled from payload Type IDs —
both forms live in App Route's own field map (key `0`), never in the
Record's own routing typeID, which is always the standard uint `12`
either way. What the two forms add is a *trust model* for routing
specifically — domain verification for the form that drives auto-
launch, §3.5's shared hash-derivation algorithm for the form that
doesn't — so routing identity and payload shape can evolve
independently of each other.

## 5. Adopting QDEF for an existing application-specific format

An application with its own existing binary payload format (e.g. a
proprietary CBOR sequence used today for some other transport) can register
one Record Type ID and carry that payload unchanged, byte-for-byte, as an
opaque blob under a single key:

```
// prefix typeID: N
{
  0: h'<existing payload bytes>'  // CRITICAL: raw bytes, unchanged from
                                   //   whatever that application already
                                   //   defines — QDEF never looks inside
}
```

This lets a QDEF-aware scanner dispatch a single byte-mode QR or NFC tag
containing, say, a Wi-Fi Record *and* this application's own content Record
together — without that application's own decoder changing at all: it
still just reads the raw bytes out of key `0`. This is additive and
opt-in — nothing about the application's own format needs to route through
QDEF for it to keep working exactly as it does today.

(The `mofosyne/tagdrop` project uses exactly this pattern to register its
own byte-mode payload, illustrated here as Type `900` — see that repo for
the worked details. It's one adopter among the format's intended audience,
not the reason this format exists; §7 below is an unrelated adopter using
the same mechanism.)

**Registering a real Type ID before governance exists.** `900` here is an
illustrative placeholder, not a protected allocation — §8's registry
governance for the `100`–`32767` "common vocabulary" tier has no authority
yet, so nothing stops an unrelated adopter from also picking `900`. Any
adopter wiring this pattern into real shipping code *before* that
governance exists should declare their own namespace (§3.5 — always a
self-chosen byte string, no allocation authority needed) and use a
namespace-scoped odd uint instead of a fixed low number in the shared
tier: cheaper on the wire than the common-vocabulary tier's placeholder
number would ever risk being wrong, and no shipping code that has to
migrate its Type ID once a real registry does exist for that tier.

**On signing and this registration pattern specifically:** an adopter whose
own signature already covers the fully-reassembled plaintext (signed once,
after all splitting/addressing is resolved, with nothing about the
signature depending on how the content happened to be fragmented in
transit) needs no QDEF-level Sign mechanism at all, wrapper or sibling
(§8). §4.1's `group_id` is already a content hash a decoder MUST verify
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
this for free — see §8's Sign entry. This reasoning generalizes beyond any
one adopter — see §6's note on signing.

## 6. Compression and splitting across multiple tags/codes

**QDEF itself defines neither** — both stay entirely inside each Record
Type's own payload definition. An application that already solved
reassembly/compression for its own format keeps using its own solution,
unchanged, rather than adopting a second, competing one at the QDEF layer.
See [DESIGN.md](DESIGN.md#why-not-build-compression-or-splitting-into-the-container)
for why these were deliberately kept out of the container.

**The same reasoning applies to signing, not just compression and
splitting.** An application with its own proven authentication mechanism
— e.g. a single hash-then-sign step over the fully reassembled payload,
computed independently of however the transport happened to fragment it —
needs no QDEF Sign primitive for that content either, for the identical
reason: it already solved this, adopting a second, QDEF-native mechanism
would just be a second thing that could disagree with the first. §5's
registration pattern already demonstrates this for an adopter whose
signature covers reassembled bytes; §8's Sign entry is for the different
case — a Record with no pre-existing answer of its own.

**If an application wants splitting, compression, or encryption without
writing any of it itself:** that's what §4.1's Wrapper Records are for — a
generic, reusable resolver any Record Type can opt into by simply being
wrapped, with zero code written by that Record Type's own author (§7 is the
worked example).

## 7. Worked example: passphrase-protected key backup across several codes

An app backs up a passphrase-protected secret key across a set of printed
QR codes. This app has **no scheme of its own** to dispatch on — these
codes are only ever scanned by its own app, never clicked or typed — so per
"When QDEF earns its place" (§1), going through QDEF's byte-mode container
(magic header included) is the right call.

Registers one Record Type, say `950`, for the plain secret-key bytes:

```
// prefix typeID: 950
{
  0: h'<raw secret key packet bytes>'  // CRITICAL
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
to mean. This is exactly the case Encrypt's Algorithm/Key Algorithm fields
(§4.1) are optional for: the app's own passphrase-KDF scheme is only ever
read by itself, so it has nothing to gain from self-describing it — those
fields exist for the *different* case of two unrelated apps needing to
interoperate on a key transfer, not this one.

This exact scenario — 3 data fragments + 1 XOR parity fragment, one
fragment deliberately dropped and recovered, then the full
Split→Encrypt→plain chain decrypted and re-parsed — is exercised end to end
in `prototype/test/roundtrip.test.js`.

## 8. Design rationale and open questions

Moved to [`DESIGN.md`](DESIGN.md): why mechanisms were removed (the CBOR
tag route), alternatives weighed and
rejected, comparisons against NDEF/BBQr/MCAP and `mofosyne/tagdrop`, and
what this draft still hasn't resolved (registry governance, the Sign
wrapper, Split's per-code capacity limits). None of it is required
reading to implement a conformant parser — everything normative is
above this line.
