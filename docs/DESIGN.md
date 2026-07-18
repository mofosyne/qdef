# QDEF — Design Rationale, Rejected Alternatives, and Open Questions

**Non-normative.** [`QDEF-SPEC.md`](QDEF-SPEC.md) defines the wire format;
this document explains why it looks the way it does — mechanisms that were
tried and removed, alternatives weighed and rejected, and questions this
draft hasn't resolved yet. Nothing here is required reading to implement a
conformant parser; it exists for reviewers, future contributors, and
anyone deciding how to resolve what's still open. See
[`FINDINGS.md`](FINDINGS.md) for the empirical, prototype-driven
discoveries that prompted many of these decisions.

## Registry governance — allocation shape proposed, authority still open

Who allocates application-specific Record Type IDs (`100`+) if this is
meant to be shared across unrelated projects is still open — no registry
authority exists yet, and IDs in the spec remain illustrative placeholders.
But the *shape* of the range has an answer: tier it the way CBOR's own tag
registry (RFC 8949 §9.2, and its IANA-maintained assignments table) tiers
tag numbers — a small span requiring registration/review, then an explicit
private-use span for never-shared/internal Type IDs, with no third
ungoverned middle tier between them. QDEF doesn't use CBOR tags itself
(see "CBOR tag-number collision" below), but the *governance pattern* a
mature numeric-ID registry uses is worth borrowing on its own merits,
independent of whether QDEF's wire format happens to touch tags at all.
Two options were weighed and this is the one to build the eventual policy
on:

- **Tiered ranges (recommended):** three tiers, not two, each with a
  different reason to exist:
  - `1`–`99`: mechanism/plumbing (already spec'd, §4) — Wrapper Records
    and other standard record type infrastructure, not application content.
  - `100`–`32767`: **common vocabulary** — reviewed, widely-recognized
    content types (Wi-Fi, a URL/URI record, the kind of thing NDEF calls
    a "Well Known Type"). This is the tier for a Record Type enough
    unrelated implementers would want to recognize that it's worth a
    shared, reviewed number rather than everyone reinventing their own —
    the spec's §5 examples (`100`, `105`) already sit here informally.
    Ceiling aligned with IANA's own CBOR tag registry boundary
    ([iana.org/assignments/cbor-tags](https://www.iana.org/assignments/cbor-tags/cbor-tags.xhtml))
    between "Specification Required" (`24`–`32767`) and "First Come
    First Served" (`32768`+) — see "Namespace-scoped Type IDs," below,
    for the full rationale — since that's conceptually the same
    distinction: this tier IS the "Specification Required" one,
    reviewed before allocation.
  - `32768`+: **First Come First Served — self-allocate freely, recorded
    once a registry authority exists, never reviewed.** This is a real,
    distinct governance model, not "no governance" — the term is borrowed
    verbatim from IANA's own CBOR tag registry, where it means exactly
    this: an allocation authority still exists and still tracks every
    assignment (so two implementers can't both silently claim the same
    number once one is recorded), it just never gates *who* can request
    one or reviews *what* it's for. Self-allocation is immediate and
    free; recording (once an authority exists — none does today, see
    below) is what actually prevents a collision, not the numeric width
    or any inherent property of the ID itself. See "Governed vs.
    ungoverned, made explicit," below, for why this tier would be
    pointless if it meant permanently untracked instead — it would just
    be a strictly worse version of a decentralized byte string ID (a
    smaller ID space, same "nobody's tracking it" property).
  Exact boundaries remain a policy decision for whoever ends up running
  the registry, not a wire-format one.
- **Decentralized byte string Type IDs — tried, then removed entirely
  once namespace-scoped odd uints existed to do the same job cheaper.**
  An earlier draft gave a byte string Type ID (any width) its own axis
  outside the tiered-range system, with collision safety coming from
  sheer byte-space size (like a UUID) rather than a registry, backed by
  a self-certifying hash-derivation Hint. That mechanism is gone now
  (§3.1) — checking what a real adopter (TagDrop) actually does made the
  case for keeping it evaporate: nobody in practice needed a Type ID that
  stood alone with no namespace, since a declared namespace (§3.5, itself
  still a byte string, still fully decentralized) gives every odd uint
  inside it the identical zero-coordination collision safety at a
  fraction of the per-ID cost — 1 byte vs. 4+ every Record Type, forever.
  See FINDINGS.md's entry on retiring decentralized Type IDs for the full
  reasoning, and "Namespace-scoped Type IDs," below, for the byte-cost
  comparison that made the namespace path strictly better for every case
  that used to reach for a standalone decentralized Type ID.
- **An older, narrower "first-come-first-served" tier (`1000`–`0xFFFF`,
  registered but with no review gate) was considered and dropped — a
  different mechanism from the `32768`+ tier above, despite the shared
  name, worth not confusing with it.** That older proposal predates the
  even/odd parity redesign: it was meant to give a cheap small number to
  anyone who didn't want to wait for common-vocabulary review, in a
  world where "namespace-scoped" wasn't yet a distinct wire-format
  concept. It was dropped once namespace-scoped Type IDs (§3.5) landed
  and made it redundant: collision-avoidance for a Type ID only ever
  comes from one of three sources — registry curation, registry
  recording, or a declared namespace — and this older tier tried to be
  cheap and uncoordinated without picking any of the three, which is
  exactly why it never had a viable governance model. Anyone who wants a
  cheap small ID with zero *upfront* coordination can get one today by
  declaring their own namespace — itself decentralized, since the
  namespace value can be a byte string — and using small sequential odd
  uint IDs inside it. The *current* `32768`+ First Come First Served
  tier is not a revival of this dropped mechanism: it's for an always-
  global ID that needs no namespace machinery at all (see TagDrop's own
  use of it, "Governed vs. ungoverned, made explicit," below).
- **Even/odd for governance tier — adopted.** The even/odd convention on
  prefix typeIDs now determines governance scope: even uint = always-
  global standard record type, odd uint = namespace-scoped. This reuses
  the same even/odd vocabulary already load-bearing for map key criticality
  (spec §3.2) but applies it to a different axis (ID classification, not
  key criticality). The two uses never overlap — one applies to map keys,
  the other to prefix typeIDs — and both follow the same mnemonic
  (even = safe/default, odd = conditional/special). The even/odd split
  only costs half of the *global* uint space, not half of the
  ecosystem's total addressable IDs: every declared namespace (§3.5)
  gets its own independent range of odd uints, so there's no fixed
  ceiling on how many namespace-scoped Type IDs can exist across every
  namespace combined. See spec §3.1's note on even/odd vocabulary reuse
  for the full rationale.

### Governed vs. ungoverned, made explicit

TagDrop asked directly, after self-allocating four `32768`+ even Type
IDs under §2/§3.5's own-URI-scheme-isolation guidance: does that tier
eventually get a registry, or does it stay permanently uncoordinated
like a decentralized byte string ID? Worth answering with a table
instead of prose, since the confusion was real: an earlier version of
this section's own `32768`+ bullet described *byte string* self-
allocation under a heading about the *numeric* tier — conflating two
different axes (CBOR major type vs. numeric range) that happen to both
be "self-allocated, no review."

**"Has a registry" and "requires review" are independent properties —
that's the actual line, not tier width or magnitude:**

```
+------------------------+------------------+-------------+-------------+
| Tier                   | Collision-safety | Registry?   | Review?     |
|                        | source            |             |             |
+------------------------+------------------+-------------+-------------+
| Standards Action       | spec-maintained   | Yes         | Yes (spec   |
| (uint even 0–22)       | curation          | (in-spec)   | change)     |
+------------------------+------------------+-------------+-------------+
| Specification Required | curation          | Yes (once   | Yes         |
| (uint even 24–98,      |                   | an authority|             |
| 100–32767)             |                   | exists)     |             |
+------------------------+------------------+-------------+-------------+
| First Come First       | recording (not    | Yes, light- | No          |
| Served (uint even      | width, not review)| weight (once|             |
| 32768+)                |                   | an authority|             |
|                        |                   | exists)     |             |
+------------------------+------------------+-------------+-------------+
| Namespace-scoped       | the declaring     | No —        | No          |
| (uint odd, any value)  | namespace         | nothing to  |             |
|                        |                   | register    |             |
+------------------------+------------------+-------------+-------------+
```

There is no longer a Decentralized (byte string) or Named (text string)
row here — both Type ID forms were retired entirely once namespace-
scoped odd uints existed to give the identical zero-coordination
collision safety at a fraction of the per-ID byte cost (§3.1; see
FINDINGS.md). The table above is exhaustive for Type IDs as they exist
today: exactly two axes, uint parity and, for even IDs, which of three
numeric ranges the value falls in.

Namespace IDs (§3.5) do **not** reuse this table the way an earlier
draft assumed — that assumption didn't survive contact with what a real
adopter (TagDrop) actually does. A namespace value is always
Decentralized (byte string); there is no Allocated (uint) namespace tier
to inherit the Specification-Required/First-Come split from, and
therefore no governed row applies at this layer at all. See "Namespace
IDs are always Decentralized," below, for the full reasoning — the short
version is that a namespace is the global root of trust for everything
scoped inside it, which makes its collision-safety needs different in
kind from a Type ID's, not just a smaller instance of the same table.

**Why First Come First Served has to mean "eventually recorded," not
"permanently informal," or the tier is pointless.** If it meant the
latter, it would be strictly dominated by just declaring a namespace
(§3.5) and using a cheap odd uint inside it: same "nobody reviews it"
property, but zero-coordination collision safety that comes from the
namespace itself rather than from luck, and a 1-byte-forever cost
instead of a global uint the whole ecosystem draws from — no reason to
ever choose an unrecorded global even uint over that. This is the
identical reasoning that already killed the older, narrower first-come
tier once before (above): a tier that's cheap
*and* uncoordinated without picking one of the three real
collision-safety sources never has a viable governance model. The
`32768`+ tier only earns its place because it's the one that *will* get
tracked, just not reviewed.

**Nothing is registered today, for any tier — that's a separate fact
from what each tier is intended to do once an authority exists.**
`DESIGN.md`/`ROADMAP.md` have said "no registry authority exists yet"
since before this table existed; TagDrop's four self-allocated values
are exactly as safe today as they'll ever need to be for their own
deployment, independent of how or when a registry eventually stands up —
their own `tagdrop:` scheme already isolates them from every other
QDEF-aware decoder (§2/§3.5), so no external collision is possible
regardless of registry timing. Once NFCDAB (or whichever body) does
stand up a `32768`+ recording registry, submitting already-in-use values
opportunistically is good practice, not urgent — there's no retroactive
protection to lose by waiting, since nothing is tracked yet for anyone
to have raced against.

**Historical: structured composition within the decentralized byte
string Type ID space — the use case behind [GitHub issue
#10](https://github.com/mofosyne/qdef/issues/10), now resolved a
different way.** The issue asked how an implementer defining several
related Record Types should structure a decentralized byte string ID —
a fixed prefix shared across all related Types, plus a locally
self-assigned suffix, rather than an independent hash or random draw per
Type — and the guidance that used to live here worked out the
prefix/suffix width tradeoff and the birthday-bound math for exactly
that (a 56-bit prefix gives 56-bit-class safety, not 64-bit-class, once
suffix clustering around small sequential integers is accounted for; a
32-bit prefix is unsafe at any serious ecosystem scale). None of that
math is needed anymore: decentralized byte string Type IDs were retired
entirely (§3.1, above), and the problem they were being structured to
solve — several related Record Types under one implementer, without
per-Type registry coordination — is exactly what declaring a namespace
(§3.5) and using small sequential odd uints inside it already does,
at a fraction of the per-ID cost and with no prefix-width sizing
decision to get wrong. See "Namespace-scoped Type IDs," below.

The one caution from this thread that's still live, restated in current
terms: if a namespace value's own prefix bytes start getting treated as
an *implicit* cross-implementer routing signal — "anything sharing my
namespace prefix is safe to auto-launch for" — that's quietly
reinventing App Route (§4.4) without App Route's domain-verified trust
model behind it. Use App Route explicitly when routing is the actual
goal; don't let a namespace-prefix convention become an accidental
second routing channel nobody decided to build.

## Namespace IDs are always Decentralized — the Allocated (uint) namespace tier was dropped

Raised directly, continuing the "too many shapes to reason about"
simplification thread that also produced the discriminator-shape
collapse (see FINDINGS.md): does QDEF's namespace layer actually need
the same governed/ungoverned choice §3.1 gives Record Type IDs, or was
that duplication carried over from Type IDs without checking whether it
earns its keep one level up? A concrete data point resolved it: TagDrop,
the project's one real adopter, already treats its namespace as always
decentralized. Combined with the observation that a namespace is
architecturally different from a Type ID — it's the *global root of
trust* for everything scoped inside it (two colliding namespaces means
every Type ID scoped to each collides too, not just one identity), and
it's exactly the kind of value that ends up baked into physical,
already-printed QR/NFC media with no way to fix a bad choice
retroactively — the Allocated (uint) namespace tier was dropped
entirely. A namespace value is now always a byte string; there is no
"registered/common-vocabulary" numeric option to choose instead.

**Concrete effects of dropping it:**

- The container discriminator's shape table drops from four recognized
  shapes to three (`uint 0`, byte string, map) — any nonzero uint now
  degrades gracefully to "no namespace," the same treatment an
  unrecognized shape already got, rather than meaning "Allocated
  Namespace ID."
- §3.1's namespace-*pairing* prefix item (`[namespace, typeId]`) is
  affected identically, since it always followed the same
  uint-or-byte-string convention: a uint in the `namespace` slot is no
  longer recognized as a pairing item at all, and the array falls
  through to being an ordinary unrecognized prefix item — meaningfully
  different from before, since that now costs the Record its only
  typeID, not just its namespace. Fixed identically in both
  `prototype/src/core.js`'s `isNamespacePairing` and
  `rust/qdef-core`'s `parse_namespace_pairing`, so the two
  implementations can't drift on this axis. Regenerated
  `rust/qdef-core/src/fixtures.rs` to match (the old
  `ALLOCATED_NAMESPACE_PAIRING_CONTAINER` fixture is now
  `UINT_NAMESPACE_SLOT_UNRECOGNIZED_CONTAINER`, same encoded bytes,
  different meaning).
- §3.5's Hint-name guidance simplifies too: a namespace Hint is now
  *always* the fully self-certifying, hash-verifiable case (§3.1's
  strengthening applies to every namespace, since every namespace is a
  byte string), never the weaker "plain, unverifiable recovery name"
  case a uint Type ID hint is stuck with. One fewer distinction a reader
  has to track.

**Byte-length policy, worked out from the actual collision math rather
than picked by feel.** Checked the birthday-bound numbers directly
rather than trusting intuition about keyspace size — the naive read
("`2^24` is 16.7 million possibilities, plenty") is wrong for
self-allocated IDs with no coordination, because the safe *population*
a width supports is governed by `√N`, not `N`:

```
bytes | keyspace (N) | wire cost | namespaces for 1% risk | for 1-in-a-million
------|---------------|-----------|-------------------------|--------------------
  3   | 16.7M         | 4 bytes   | 579                     | 6
  4   | 4.3B          | 5 bytes   | 9,268                   | 93
  5   | 1.1T          | 6 bytes   | 148,291                 | 1,483
  8   | 18.4Qi        | 9 bytes   | 607M                    | 6.07M
```

3 bytes reaches meaningful collision risk (~3%) at just 1,000
independent picks, and is essentially guaranteed to collide by 10,000 —
not a hypothetical scale for an open format that could plausibly see a
few thousand independent adopters over a decade. **Resolution: self-
certify freely at 4 bytes or longer (no coordination needed); shorter
than 4 bytes is reserved, not self-allocatable** — safe only with
uniqueness actually guaranteed by direct coordination, and there is no
formal registry process for that today, deliberately (see "Standard
library governance," above, for why this project's registry effort is
aimed at growing §4's standard record types instead, not at operating a
namespace-allocation bureaucracy). A sub-4-byte namespace is something
to ask for directly if the need is ever real, not infrastructure worth
pre-building on spec.

**A hybrid was considered and rejected: registry-*curated* allocation
specifically for the 1–3 byte range, self-certification above it.**
Structurally this actually works better than the birthday-bound numbers
above suggest — a registry that reviews before granting sidesteps the
birthday bound entirely (curated allocation gets the *full* keyspace,
not `√N`, the same way any reviewed numeric tier does), so a curated
1–3-byte tier could genuinely serve the rare case that needs an
ultra-compact ID. Rejected anyway, for the same reason the Allocated
namespace tier itself was dropped: it reintroduces exactly the
governed/ungoverned split this whole simplification pass was cutting,
for a self-admittedly niche need, and requires an actual operating
authority to review requests — the same "don't build registry
infrastructure ahead of real demand" discipline already applied
everywhere else in this project (Type IDs, App Route, everything). If
someone concrete ever needs a 1–3 byte namespace, that's a real
conversation to have then; nothing about the wire format needs to
anticipate it now, since the byte string shape already accepts any
length without a new CBOR shape.

**Why the 4-byte floor doesn't bend toward a smaller, more "honest"
population estimate.** A fair objection: QDEF is a niche format, and the
real long-run number of independent namespaces might plausibly be far
smaller than the 1,000+ figures the table above uses — maybe closer to
10–20. Worth taking seriously, but it shouldn't move the floor, because
of an asymmetry specific to this format: over-provisioning length costs
a few extra bytes, once, forever negligible against any realistic
payload. Under-provisioning is unfixable — it's baked into physical
media the moment the format succeeds beyond whatever the humble estimate
assumed, with no way to reissue what's already printed. Given that
asymmetry, sizing for a plausible-upside scenario is the only choice
that doesn't risk being caught out by the format's own success. (One
genuinely resolved sub-question here: does a namespace minted short and
early become retroactively unsafe once later adopters pick longer
lengths? No — different-length byte strings can never be byte-for-byte
equal to begin with, so cross-length collision is structurally
impossible; a length is only ever at risk from *other* namespaces
choosing that exact same length, never from the ecosystem growing at
other lengths. This is what makes "self-certify at 4+ bytes, no
coordination" durable regardless of how namespace-length choices spread
out over time.)

## Registry entry template — a concrete, documentable shape, not yet a process

The governance *authority* is still open (above), but the *shape* of a
registry entry isn't — and doesn't need to wait for governance to be
useful. Anyone can start documenting their own Type IDs in this format
today, in their own README or spec, without permission from anyone. The
template below is an informative, non-binding documentation convention,
not a governance proposal.

Adapted from IANA's own per-tag registration template for the CBOR tag
registry (RFC 8949 §9.2), which is surprisingly lean — four fields
total. QDEF needs more, because a single logical Record Type can have
*two independent, unlinked identifiers*: a Record Type ID (global —
common-vocabulary or decentralized byte string, works with no namespace
declared) and a Scoped Type ID (cheap, only means anything paired with
a specific declared namespace). Since nothing connects them by formula —
a scoped ID is freshly chosen, not derived from the global one
(DESIGN.md's "Fourth follow-on" under "Namespace-scoped Type IDs") — a
registry entry recording only one form wouldn't let a reader who
encounters the *other* form recognize it as the same thing.

Two parallel identity pairs, each an ID plus an optional recoverable
name:

- **Record Type ID + Record Type Name** — the identity carried in the
  prefix typeIDs before the Record map (spec §3.1).
- **Namespace ID + Namespace Name** — the identity carried by the
  container discriminator (spec §3.5), key `1` / key `3` in its map
  form or the equivalent bare-array shape.

### Template

```
Record Type ID:             <hex byte string, or "none — namespace-only">
Record Type Name:           <reverse-domain name, e.g. com.example.tagdrop/route>
Variable Name:              <space-separated words, e.g. "Tag Drop Route">

Namespace ID:               <hex byte string, or "none — global-only">
Namespace Name:             <reverse-domain name, or "none — global-only">
Variable Name:              <space-separated words, e.g. "Tag Drop">

Scoped Type ID:             <odd uint, or "none — global-only">

Data item:                  <CBOR shape description — e.g. "map { 0: bytes, 2: uint }">
Semantics:                  <one-line functional description>
Point of contact:           <email or URL>
Reference:                  <link to spec/README defining this Type>
```

**Variable Name** is a space-separated word sequence for generating
identifiers in any language — snake_case, CamelCase, UPPER_CASE, etc.
Tools can derive `tag_drop_route`, `TagDropRoute`, `TAG_DROP_ROUTE`
from the same source field.

Every ID/Name field is optional — a Type that's only ever used
namespace-scoped has no Record Type ID row to fill in, and vice versa.
That's deliberate: it documents *whichever forms actually exist* for a
given logical Type, not requiring both. The Name's presence implies the
ID was hash-derived from it (spec §3.1); its absence means the ID was
drawn at random with no recoverable name.

### Worked hypothetical example

A project called "TagDrop" defines a `route` Record Type for directing
payloads to a physical delivery target. It uses both a global byte string
Record Type ID (for standalone codes) and a Scoped Type ID (for codes
within TagDrop's own namespace):

```
Record Type ID:             h'34e1e4af'
Record Type Name:           com.example.tagdrop/route
Variable Name:              Tag Drop Route

Namespace ID:               h'663c1cf2'
Namespace Name:             com.example.tagdrop-paper
Variable Name:              Tag Drop

Scoped Type ID:             1

Data item:                  map { 0: bytes (destination), 2: uint (priority) }
Semantics:                  Routes payload to a physical delivery target
Point of contact:           tagdrop-maintainers@example.com
Reference:                  https://github.com/mofosyne/tagdrop/blob/main/SPEC.md#route
```

The same logical Type, two completely independent identifiers, both
documented so a reader who encounters either form on the wire can
recover the other from the registry.

### Why not just mirror CBOR's four-field shape?

CBOR tags don't have QDEF's namespace-scoping wrinkle — a CBOR tag
number is always the *whole* identity, there's no compound-key
relationship to another field the way `(Namespace ID, Scoped Type ID)`
works here. So CBOR's template needs only one identity field ("Data
item: unsigned integer"). QDEF needs two identity pairs (Record Type
ID/Name and Namespace ID/Name) plus the Scoped Type ID, because the
compound key `(N, T)` is the real lookup key once a namespace is
declared, and documenting only `T` without `N` leaves the entry
incomplete for any reader who encounters the scoped form.

## CBOR tag-number collision (resolved — the tag route was removed)

An earlier draft wrapped every Record Map in a CBOR semantic tag equal to
its Type ID (the "Smart Route"), alongside the mandatory key `0` on the
map. Found broken on two independent grounds, not one:

- **Empirical.** CBOR tag numbers are a shared IANA registry (RFC 8949
   §3.4), and the low numbers QDEF's standard record types picked are already assigned:
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

Key `0` was never implicated by either argument: there is no IANA registry
for map keys, only for tags, so a bare Record Map has no built-in semantic
layer for a generic decoder to misinterpret — verified directly
(FINDINGS.md #11): the identical Record Map round-trips cleanly when
untagged, and decodes to `Invalid Date` only when wrapped in a tag.
**Decision: the tag route is removed. The prefix typeIDs are the sole routing
mechanism** (spec §3.1) — simpler, and every prototype test already routed
through them alone, tag or no tag. The place a CBOR tag still legitimately
appears in QDEF is unrelated to routing: spec §3.2 allows any tag number
to wrap a field's own definite-length string value directly, a
Record-Type author's own opt-in choice about one field's content, which
is exactly the "predefined, universal meaning" use tags are for — not a
mechanism QDEF's core depends on. See "Field values may carry any CBOR
tag" below for why this widened from an initial tag-`24`-only rule. A
single shared
"this map is a QDEF Record" tag (the way
tag `55799` means "self-describe CBOR") was considered as a middle ground
and set aside for the same reason: one more optional mechanism to document
and implement, for a benefit the prefix typeIDs already provide
unconditionally.

## Field values may carry any CBOR tag, not just tag 24 — widened per FINDINGS.md #15/#16

Issue #8's original fix (FINDINGS.md #15) restricted the field-value-
shape rule's tag exception to tag `24` specifically, out of caution: it
was the one case already known to be both skip-safe and to have a real,
non-QDEF-specific meaning. Revisited once actually asked directly: what
does the rest of the IANA CBOR tag registry (tags under ~1000) actually
look like, content-shape-wise — is "only 24" doing real work, or just
being narrower than it needs to be?

Checked directly against the registry, not from memory: tags split
cleanly into two groups by their own RFC 8949 definitions. Genuinely
scalar- or string-shaped (dates, URIs, UUIDs, regex, bignums, base64/
base16 conversion hints, typed numeric arrays wire-encoded as byte
strings) versus genuinely array- or map-shaped by definition (decimal
fractions and bigfloats — a 2-element array; rational numbers; language-
tagged strings — `[language, text]`, easy to mistake for a bare string;
COSE structures; the "expected conversion" hints `21`–`23`, confirmed
directly against RFC 8949 to apply recursively over arbitrary structure,
not just a byte string). The *content-shape check* (definite-length
string, directly, never another tag) is what makes a tag skip-safe — that
holds regardless of which tag number is on the wire, so restricting to
`24` alone was stricter than the actual safety property required, and the
registry itself already sorts into the right buckets without QDEF needing
to maintain an allowlist of "safe" tag numbers.

**Superseded, not just widened, by a later change: §3.2's field-value-
shape rule was dropped entirely** (a field value may now be any
well-formed CBOR item — see "Field-value-shape rule — rationale,"
below), so every analysis in this section of which specific tags are
"safe" no longer gates anything at the wire-format level; any tag
wrapping any content is legal now, regardless of shape. Left here
because the underlying skip-safety mechanism it worked out —
content-shape checking generalizes cleanly across tag numbers, and
doesn't need a private allowlist — is exactly what made the later, full
relaxation safe to do at all: `skip_any_item` already walked arbitrary
tag content with a bounded stack before field values ever needed the
same treatment.

Two things confirmed this wasn't accidentally reopening either hazard the
narrower rule was guarding against, back when the rule still restricted
field-value shape:

- **Not the recursion hazard.** The bound that matters is "tag content is
  checked to be a definite-length string directly, never another tag" —
  unrelated to which specific tag number is involved. Tag `24` wrapping
  tag `0`, or tag `0` wrapping tag `24`, are equally out of bounds; a real
  fixture (`STRUCTURED_TAG_WRAPPED_VALUE_CONTAINER`, tag `4` wrapping a
  genuine `[-2, 27315]` decimal-fraction array) proves a real, plausible,
  correctly-formed tagged value still gets rejected when its content
  isn't a string, same as any bare array would.
- **Not the private-enumeration hazard.** This isn't QDEF choosing or
  interpreting tag numbers for its own routing purposes the way the old
  Smart Route did (findings #11–#12) — it's letting Record authors use
  *real* IANA registrations for their own intended, standardized meaning.
  That's the correct use of CBOR tags per RFC 8949's own design
  philosophy, not a reopening of the mechanism that was removed.

## Type Hint (Key 1): dropped from the map, then the mechanism itself retired

Key `1` was originally reserved globally for Type Hint — an optional
recoverable name for a decentralized Type ID (spec §3.1, then). With the
introduction of the prefix typeIDs format, Type Hint moved out of the
map and into the prefix alongside the Type ID itself, freeing key `1`
for each Record Type's own use. **Later, once decentralized Type IDs
were retired entirely** (the job they did — self-certifying,
zero-coordination identity — turned out to be better and more cheaply
served by a declared namespace, §3.5), Type Hint itself had nothing left
to attach a name to and was retired alongside it, not just relocated
again. The bare-text-string slot that used to carry it (and, before
that, a reserved-for-future "Named ID" typeID form) now carries the
NDEF-ID-equivalent instead (spec §3.1) — one unambiguous meaning for a
position that used to be split between two retired purposes.

## Media Payload (Type 6): why it never reused the (now-retired) decentralized-ID + Hint pattern

The first draft of spec §4.3 copied Type Hint's decentralized-ID + Hint +
opportunistic-hash-verify pattern (as it existed in §3.1 at the time)
onto Media Type wholesale — same mechanism, one layer down. That turned
out to be a mistake worth recording, not just quietly fixing: it
mechanically reapplied a pattern without checking whether the problem it
solves was even present at this layer. (Type Hint itself was later
retired entirely — see above — but the reasoning below for why Media
Type never needed its own version of that pattern still holds, and is
worth keeping as the general argument for *when* a hash-derivation
Hint earns its cost, since namespace IDs, §3.5, still use exactly this
pattern today.)

**Type ID and Media Type were never the same shape of problem.** A
decentralized Type ID had *no* identity besides the bytes — that's
exactly why a Hint had to exist (to attach a name) and why the hash
check had to exist (to prove that name wasn't tampered with). A media
type isn't like that: `"text/vcard"` is already a stable, globally
meaningful string, defined by RFC 6838's own Media Types registry,
completely independent of whether CoAP ever assigned it a compact number.
CoAP's numeric registry is a compactness shortcut for the popular cases,
not the source of a media type's identity. So when a media type isn't in
CoAP's table, there's no opacity to resolve — the plain string already is
the recoverable name, with nothing left for a Hint field or a hash check
to add. Settled on the simpler two-form design instead: a CoAP uint when
registered, the plain MIME string otherwise, nothing else.

This also answers a question worth asking directly: does CoAP itself have
a private-use/decentralized tier the way QDEF's Type ID used to? No — its
tiers are Expert Review, IETF Review, First-Come-First-Served, and a small
Experimental range explicitly barred from real use ("MUST NOT be used in
operational deployments"), never a "pick a large random number, no
registration needed" escape hatch. Partly structural (Content-Format is a
16-bit field in the CoAP wire protocol itself, so there's only 65536
numbers total — too few for uncoordinated random self-assignment to be
collision-safe), but more fundamentally because media types don't need
one: they already have external, stable names outside CoAP's registry. A
decentralized Type ID needed a private-use escape hatch because it had
no other identity; media types already had one.

**Relying on CoAP's registry at all is a conditional choice, not a
default.** It's justified specifically because that registry has good
prospects of staying maintained — IANA-run, IETF-governed, updated as
recently as 2025 (RFC 9876) — not merely because some external numbering
scheme happened to exist. Spec §4.3 asks adopters to keep a periodic
mirror of the table regardless, so QDEF's ecosystem isn't stranded if that
maintenance prospect ever turns out to be wrong.

## Standard library governance

Related but narrower (spec §4): who maintains the reserved `1`–`99` range
itself — additions like §4.1/§4.2/§4.3 need some process for becoming
part of "the standard record types" rather than just another vendor's Record Type
squatting on a low number.

**This is where a QDEF registry's effort is actually best spent — not on
allocating namespace or application-specific Type IDs.** Namespace IDs
are always self-certifying now (no Allocated tier, "Namespace IDs are
always Decentralized," below) and application Type IDs inside a declared
namespace are the namespace operator's own numbering to manage — neither
needs a central authority at all, by design. What genuinely benefits
from shared, reviewed curation is the opposite direction: growing §4's
common vocabulary itself (new standard record types any conformant
decoder can recognize, the way `Split`/`Compress`/`Encrypt`/`Fallback
Hint`/`Media Payload`/`App Route` already do) so unrelated apps get
*more* structure they don't have to invent themselves, rather than a
registry whose main effect would be encouraging every app to mint and
register its own bespoke namespace instead of reaching for what's
already standard. A registry that reviews and extends §4 is worth
building when there's real demand for it; a registry that allocates
namespace or app-specific Type IDs was never worth building at all,
since self-certification already does that job for free.

## Magic-header overhead for QR

5 bytes fixed cost matters for a single-record payload in a
size-constrained QR version; is it worth gating on payload size (e.g. omit
magic when embedded via a scheme that already identifies the format,
mirroring the NFC case in spec §2)? A real data point from an adopter
comparison (verified directly against `mofosyne/tagdrop`'s SPEC.md):
TagDrop's native envelope costs 2 bytes total (`version`+`type`, both
small CBOR uints, SPEC.md §2), against roughly 10–15 bytes for QDEF's
magic+version+map-framing overhead (prefix typeIDs plus map headers)
on the same small payload — a large proportional cost for TagDrop's
smallest codes (a short text snippet can be under 50 bytes total).
Doesn't change the conclusion elsewhere in the spec that QDEF wrapping
stays strictly opt-in, never the default framing (spec §6, §7) — but it's
a concrete number to weigh if the conditional-magic-header idea above is
ever worth building.

## Relationship to existing standards

NDEF already solves "multiple typed records, one message" for NFC (spec
§2's `application/vnd.qdef` MIME framing leans on this directly). This
draft's actual net-new contribution is narrower than it first appears: a
*magic-header-plus-CBOR-Sequence* convention for the optical/QR case
specifically, plus the even/odd criticality rule, which NDEF itself does
not have (NDEF has no per-key criticality signal at all, only per-record
TNF/Type). The closest shipped analog for the QR case specifically is
[BBQr](https://bbqr.org/BBQr.html) (magic header + single-char file-type
byte + QR-series splitting, used for Bitcoin PSBTs/transactions) — but it
identifies exactly one file type per *entire QR series*, not multiple
heterogeneous Records within one payload, has no per-field criticality or
versioning signal, and encodes alphanumeric rather than native byte-mode.
QDEF's multi-Record-per-payload model and even/odd rule are real deltas
against it, not restatements. The general "magic bytes + sequence of
self-describing typed records" pattern itself is well-proven elsewhere
(e.g. [MCAP](https://mcap.dev/spec) for robotics data logs) — QDEF's
contribution is applying it to the constrained-optical-scanner case, not
inventing the pattern. The idea itself predates this repo: `mofosyne/tagdrop`
issue [#16](https://github.com/mofosyne/tagdrop/issues/16) (2016) proposed
an NDEF-like binary header for QR codes a decade before this draft
existed; QDEF is the first attempt to actually build it out.

## Standard Record Type coverage against NDEF's own Record Type Definitions (RTDs) — checked directly, not assumed

Prompted by asking whether QDEF and NDEF content should be convertible
in both directions, with an explicit escape hatch: not converting is an
acceptable outcome where trying would cost more design/decoder
complexity than the conversion is worth, not something to force through
regardless of cost. Checked every real NFC Forum RTD directly (their own
published specifications, not memory) against what QDEF's standard
record types (§4) already cover:

```
+------------------------+---------------------------+----------------------------------------------+
| NDEF RTD / mechanism    | Purpose                   | QDEF status                                  |
+------------------------+---------------------------+----------------------------------------------+
| Text RTD                | Plain text + language tag | Covered -- Media Payload (§4.3), a text/*     |
|                          |                            | MIME type; no dedicated Text type needed      |
| URI RTD                 | Compact URI encoding      | Partial -- Fallback Hint (§4.2) covers the    |
|                          |                            | fallback case; general "URI as primary        |
|                          |                            | content" falls to Media Payload or an app     |
|                          |                            | Type. Not an exact duplicate, not a gap       |
| Smart Poster RTD        | URI + Text + action code  | Closed -- Fallback Hint gained language (key  |
|                          |                            | 3) and action (key 5) fields, below           |
| Signature RTD           | Cryptographic signing     | Known gap, already tracked -- QDEF's own Sign |
|                          |                            | wrapper, decided but unbuilt (see below)      |
| Device Information RTD  | Device model/identity     | Out of scope -- device pairing, not content   |
|                          |                            | distribution                                  |
| Multiple URI RTD        | List of URIs, one record  | Not needed -- repeated Fallback Hint siblings |
|                          |                            | already generalize this, no new mechanism     |
| Verb RTD                 | Handover service verbs    | Out of scope -- tied to Connection Handover    |
| Connection Handover      | Live, bidirectional       | Out of scope entirely -- see below            |
| (Alternative Carrier,    | Bluetooth/WiFi carrier    |                                                |
| Handover Req/Sel/Med.)  | negotiation                |                                                |
| Android Application      | App dispatch on scan      | Covered -- App Route (§4.4), designed as the  |
| Record (AAR, not a real  |                            | explicit cross-platform equivalent            |
| RTD, but functionally    |                            |                                                |
| adjacent)                |                            |                                                |
+------------------------+---------------------------+----------------------------------------------+
```

**Closed: Smart Poster's language tag and action code, both cheap and
additive.** Fallback Hint gained two new odd/optional fields — `3`
(BCP 47 language tag for the label) and `5` (action code: `0` = perform
the action, `1` = save for later, `2` = open for editing, borrowed
directly from Smart Poster's own three values rather than inventing a
new enum). Both are odd/optional specifically so a decoder that doesn't
recognize either still gets a fully working URI and label — the
graceful-degrade guarantee Fallback Hint already made for its original
two fields, now extended rather than compromised. Multiple languages or
multiple URIs need no new mechanism at all: QDEF already allows any
number of same-Type sibling Records in one Sequence, so repeating
Fallback Hint once per language/URI variant reproduces Smart Poster's
multi-title behavior and Multiple URI RTD's list behavior for free.

**Deliberately not adopted: NDEF URI RTD's compact prefix-code trick** (a
1-byte code standing in for a common URI scheme prefix like
`"http://www."`), even though QDEF readily borrows external tables
elsewhere when the byte savings are real and a stable table already
exists (CoAP Content-Formats for Media Payload, COSE Algorithm IDs for
Encrypt). Checked concretely why this one doesn't transfer cleanly,
rather than skipping it for being unfamiliar: representing `[prefix
code, remainder]` as a single field value needs either a 2-element
array (which §3.2's field-value-shape rule disallows outright as a field
value) or a CBOR tag number standing in for the code (reopening the
exact tag-number-collision risk with the wider CBOR ecosystem already
rejected once, for container routing — "CBOR tag-number collision,"
below). The remaining option — splitting the URI field into a separate
prefix-code field plus a prefix-stripped remainder — would mean a
decoder that recognizes Fallback Hint's Type but not that specific field
split sees a broken, prefix-less string instead of a working URI,
undermining the one property Fallback Hint exists to guarantee: *any*
decoder recognizing the Type gets a complete, usable URI, no sub-feature
support required. A few bytes saved on an already-short field isn't
worth trading that guarantee away — the escape hatch this comparison
started with, actually exercised rather than left theoretical.

**Out of scope, and stated as a deliberate boundary rather than a gap:
Device Information RTD, Verb RTD, and the entire Connection Handover
family** (Alternative Carrier, Handover Request/Select/Mediation).
Connection Handover is a live, bidirectional negotiation protocol —
two devices exchanging multiple messages (Requester, Selector, and
optionally a Mediator) to agree on a Bluetooth or WiFi carrier for
further data exchange. QDEF has no notion of a session, a response, or
a multi-message exchange anywhere in its design — it is a static,
scan-once, one-way format, full stop. Representing Handover's state
machine inside QDEF Records would mean growing an entirely foreign
concept into the format's core model for a use case QDEF was never
aimed at. Device Information RTD and Verb RTD are both tightly coupled
to that same device-pairing use case, so the identical reasoning
applies to both. This is the clearest instance of the "acceptable not to
convert" escape hatch this whole comparison was framed around from the
start.

**Already tracked, not newly in scope.** Signature RTD's job is already
covered by QDEF's own planned Sign/detached-authenticity wrapper —
direction decided (content-hash-based coverage, sibling not wrapper
form), prerequisite (canonical encoding) resolved, but not built,
waiting for a real adopter's actual need (see "Sign / detached-
authenticity wrapper," below). NDEF conversion is a new argument for
prioritizing it sooner, not a reason to change the existing plan or
build it speculatively ahead of a real want.

## NDEF's ID field — two competing experimental prototypes, resolved later by a third option neither anticipated

The NDEF RTD comparison above left one open question: NDEF's `ID` field
(§3.2.11/§2.4.3 of the NFC Forum spec) is a URI-reference string every
record can carry, letting *external* systems reference a specific
record's payload by a stable, type-independent identity — NDEF declines
to standardize what uses it, but Signature RTD's hashed bytes include it
when present, as one real example. QDEF has nothing structurally
equivalent.

The first instinct — that ordinary field-map extensibility already
covers this, since any Record Type can define whatever keys it wants —
was checked and is wrong. A per-Type map key is owned by that Type's
author (Fallback Hint's new `language`/`action` keys, for example). An
NDEF-`ID` equivalent needs to be *type-independent*: any Record, of any
Type, gets one, and no Record Type's own key numbering can collide with
or redefine it. That puts it at the same architectural layer as the
typeID prefix items and the namespace-pairing item (§3.1) — parsed by
the mandatory core, before any Type-specific interpretation begins — not
inside any one Type's map.

**Resolved later, by neither of the two options explored below — see the
wrap-up at the end of this entry.** The two prototypes here predate
that resolution and are kept as the real feasibility-checking trail,
including a genuine cross-implementation bug they surfaced (below) that
needed fixing regardless of which option, if any, ultimately shipped.

Two structurally sound, mutually exclusive shapes were prototyped to
check feasibility (`prototype/src/core.js`, `prototype/test/
experimental-external-id.test.js` and `experimental-core-metadata-negkey.
test.js` — both since deleted as dead code once the actual resolution
landed). **Neither was adopted or spec-documented** — this was
feasibility-checking only.

**Option A: a 1-element array prefix item, `[externalId]`.** Sits next to
the existing typeID and namespace-pairing prefix items, disambiguated
purely by array length (1 element here, 2 for namespace-pairing, bare
scalar for an ordinary typeID) — no CBOR tag, so it doesn't reopen the
tag-number-collision risk already rejected twice elsewhere (see "CBOR
tag-number collision," above). Confirmed to coexist cleanly with backup
typeIDs and namespace-pairing without displacing either. Visible in
Phase 1, before the field map is even reached.

**Option B: a reserved negative integer map key, `-1`.** CBOR permits
negative-integer map keys generally, and the spec never restricted map
keys to non-negative uints (only a typeID *prefix item's value*
excludes negint — a separate axis, already resolved as "excluded, not
reserved," see "Text string Type IDs," above). This option reuses the
existing even/odd criticality machinery for free: parity is well-defined
on negative numbers (`-1` odd, `-2` even), so an unrecognized negative
key can be even/odd-checked exactly like an unrecognized positive one —
except enforced by the mandatory core against every Record regardless of
Type, never deferred to that Type's own criticality check. The cost:
it's only visible once the map is actually parsed, one phase later than
a prefix item.

**Byte cost is a wash, checked directly rather than assumed.** An
earlier hypothesis that the negative-key form would be cheaper once the
map already has other fields (by "amortizing" into the existing map
header instead of adding a whole separate array) was tested and
disproven: a CBOR map or array header only grows past one byte once
entry/element count crosses 23, and going from 1 to 2 entries never does.
Both forms cost exactly one byte of framing (an array-of-1 header, or a
one-byte negint key header) plus the string itself, in every case that
was checked. Whatever these two options are actually being chosen
between on, it isn't wire size.

**A real, unrelated bug this exploration surfaced: the two prototype
implementations disagreed on negative map keys even before either
option existed.** The Node prototype silently accepted a negative
integer as an ordinary map key (JS's `%` preserves sign, so its existing
even/odd check kept working unmodified). The Rust core's hand-rolled
`read_key` had no match arm for CBOR major type 1 (negint) and hard-
errored (`NotAKey`) — and because the `Records` iterator treats any
`parse_record` error as unrecoverable (it can no longer determine where
the malformed item ends, so it can't safely resume the Sequence), a
single negative map key anywhere silently killed decoding of every
*subsequent* Record too, not just the one that had it. Fixed by adding
`cbor::Key::NegInt` so `read_key` reads major type 1 instead of
rejecting it; `check_criticality` (Type-level) now explicitly skips it,
matching how it already skipped byte-string/text-string keys, and a new
`extract_core_metadata` function (mirroring the Node prototype's own)
does the mandatory-core-level even/odd check against it instead. This
fix was needed regardless of whether Option B is ever adopted — it was
a real cross-implementation disagreement on legal CBOR, not a consequence
of either experimental design.

**Does reserving negative keys for core metadata justify "locking in"
the Record's prefix-item shape set, so the parser never needs to
recognize a new shape again?** Worth separating into two different
"header" concepts this argument could apply to:

- **The per-Record prefix-item shapes (Phase 1, §3.1) — yes, genuinely.**
  Every prefix-item mechanism added so far (namespace-pairing, and
  experimentally, the array-wrapper externalId) has meant teaching Phase
  1 a new array-length-disambiguated shape. That's a small, closed cost
  each time, but it's still a growing list a decoder's prefix-scanning
  loop has to keep recognizing, and more shapes sharing the same
  small-array-length space raises long-run collision risk between
  future mechanisms — the same category of concern already raised (and
  rejected on) for CBOR tag numbers. If all *future* mandatory-core,
  per-Record metadata is designed to live in reserved negative map keys
  instead, Phase 1's shape set can be treated as closed for good: bare
  typeID, namespace-pairing array, done. No new mechanism ever needs a
  fourth shape, because the map — already fully opaque to Phase 1 either
  way — absorbs all of that growth instead, in a space (negative
  integers) that's unbounded and self-describing with no new parsing
  rule required per addition.
- **The container discriminator (§3.5) — no, not directly.** The
  discriminator is a once-per-container item, not a once-per-Record map;
  it isn't a map in most of its own shapes (several are bare scalars or
  arrays). Reserving negative Record-map keys says nothing about whether
  the discriminator's own shape set is closed — that's a separate
  question, not addressed by this exploration, and not something this
  finding should be read as answering.

So the idea holds, but only for the layer it actually touches. It's a
real, additional argument in favor of Option B over Option A if QDEF
ever does adopt an NDEF-`ID` equivalent — not because of wire cost (a
wash), but because it keeps Phase 1's parsing surface from growing
indefinitely. It is not, by itself, a reason to freeze the discriminator,
and no decision has been made to adopt either option or to formally close
Phase 1's shape set.

**Resolution, much later: a third option, made possible by an unrelated
change, adopted instead of either A or B.** Once decentralized Type IDs
were retired (§3.1) and Type Hint went with them, the bare-text-string
prefix position that used to be split between two other retired
purposes — a reserved-for-future "Named ID" typeID form, and Type
Hint's own verification string — was sitting unclaimed, already
structurally reserved, already at the correct architectural layer (Phase
1, parsed by the mandatory core before any Type-specific interpretation,
exactly the property this whole entry was checking for). A bare CBOR
text string immediately following the typeID-bearing item became the
NDEF-ID-equivalent: no new prefix-item shape for Phase 1 to learn (it's
just "a text string, if present, right after the typeID" — dispatched by
CBOR major type like everything else in the prefix), no reserved
negative map key needed, and — the deciding property neither Option A
nor B could claim — literally zero design cost, since the slot already
existed and had already been paid for structurally by two now-retired
mechanisms. Both experimental prototypes were deleted as dead code once
this shipped; see spec §3.1's "NDEF-ID-equivalent" and FINDINGS.md.

This doesn't retroactively validate or invalidate the Option A/B
tradeoff analysis above — that reasoning is still correct for what it
was actually deciding between, it just turned out a fourth possibility
existed that neither was checked against, because the prefix-item slot
it reuses didn't become available until a much later, unrelated
redesign freed it.

## Why not just carry a literal NDEF message as the QR byte-mode payload, instead of a new format?

It's technically possible — nothing stops encoding actual NDEF bytes into
a QR code — but it wouldn't actually avoid inventing anything, for three
concrete reasons. First, byte economics: NDEF's Type field is a URN, MIME
string, or `domain:type` string (TNF_WELL_KNOWN/MIME_MEDIA/EXTERNAL_TYPE),
so every record pays bytes proportional to a string's length for its type
tag, where QDEF's Type ID is a CBOR uint (often 1–3 bytes) — the same
economics argument as the magic-header-overhead entry above, one layer
deeper. Second, a structural mismatch: NDEF's chunk flag (CF) solves "this
record's payload is bigger than one read from a continuous tag session" —
chunk continuation requires TNF `0x06` and zero Type Length on every
middle chunk, a scheme that assumes one uninterrupted message stream. It
does not solve "this message is spread across several independently-
scanned physical codes, any one of which might fail to scan," which is
what spec §4.1's Split Wrapper (with XOR parity, fragment-loss recovery)
actually addresses — reusing NDEF's envelope wouldn't provide that
mechanism at all. Third, granularity: NDEF's TNF/Type gets you
record-level dispatch only — nothing inside an NDEF payload has any
per-field optional/critical signal, so an adopter would still need to
invent their own internal structure for "which fields are safe to
ignore," which is exactly what spec §3.2's even/odd rule already is.
Wrapping literal NDEF bytes would add NDEF's tag-session-oriented framing
(MB/ME message-boundary flags, meaningless for a payload delivered
atomically in a single scan) on top, without saving QDEF's actual
contribution.

## Encrypt key provisioning (resolved — Algorithm/Key Algorithm fields, borrowing COSE)

Type 4 originally named a cipher only in a comment (`e.g. AES-GCM`), with
no field for it, and never specified where the key comes from at all — see
FINDINGS.md #6 for how the prototype surfaced this. Considered leaving it
out of scope entirely (an application-layer concern) versus adding a
field; resolved toward a field, but not a QDEF-specific one.

The same asymmetry check that killed Media Type's decentralized-ID layer
applies here identically: a cipher and a key-agreement scheme are both
things with a stable identity independent of QDEF, so there's no opacity
problem for a hint-plus-hash layer to solve — just borrow an existing
numbering scheme, the same playbook as Media Type. The fit is even
tighter than CoAP was for Media Type, because it's the same domain:
IANA's COSE Algorithms registry (RFC 9053/9054) already covers both the
content-encryption algorithm and the key-agreement/wrap/derivation
algorithm, is CBOR-native (COSE structures are CBOR), and is actively
governed with the same tiered structure QDEF's own Type ID space uses.

Spec §4.1 adds two optional fields to Type 4 (key `3` Algorithm, key `5`
Key Algorithm — a COSE Algorithm ID or a plain string, encoder's choice)
and keeps both odd/optional rather than critical, deliberately matching
`parity_scheme`'s precedent over nonce/ciphertext's: two apps that already
agree out of band (§8's worked example) pay nothing, and a decoder that
doesn't recognize either field just falls back to its own assumption,
which fails safely regardless since AEAD's own auth tag catches a
wrong-algorithm attempt. The fields exist specifically for the
interoperable-key-transfer case an unrelated adopter would need — flagged
during a discussion of what "QDEF spreading to more QR apps" would
actually require in practice, not a hypothetical gap.

Worth flagging as an implementation caution, not a wire-format concern:
a decoder that *does* honor these fields must not let them broaden which
algorithms it's willing to run — the same "alg" confusion vulnerability
class JOSE/JWT is known for. Treat the value as something to check against
an application-chosen allowlist, never as an instruction to trust
outright.

**Checked against a real adopter after the fact, surfacing a limitation
worth keeping:** `mofosyne/tagdrop` uses AES-256-GCM (exact match for
`A256GCM` = 3, confirming the cipher-ID choice) and PBKDF2 for
passphrase-based key derivation — the latter has no COSE algorithm ID at
all (COSE's key-derivation entries are all HKDF variants), so Key
Algorithm's plain-string fallback covers this case, not the numeric one.
More significantly, TagDrop's encryption is deliberately *undeclared* —
"discovery, not declaration," confirmed via trial decryption rather than
a stated algorithm, specifically so ciphertext stays indistinguishable
from random. A Type-4 Wrapper can't preserve that regardless of field
shape: being wrapped in Type `4` at all is itself a visible declaration to
any QDEF-aware parser walking the Sequence. See FINDINGS.md #13 for the
full reasoning — a genuine, principled scope boundary, not a gap to close,
and confirmation that TagDrop's own §6 registration (encryption entirely
inside the opaque blob, invisible to QDEF) was already the right call.

## Media Payload: checked against a real adopter, confirmed compatible but never reached

`mofosyne/tagdrop` does have typed content-tagging (`mime_type`, a
free-form string, never a numeric ID) — confirming that if this were ever
exposed at the QDEF layer, it would use Media Type's plain-string
fallback, not CoAP's numeric registry. But it can't come up for TagDrop's
actual §6 registration at all: that registration already carries TagDrop's
entire existing CBOR sequence (`mime_type` included) as one opaque blob
under a single key, deliberately invisible to QDEF by the same reasoning
§7 settled for compression and splitting generally. Not a gap — Media
Payload was never going to be reached by an adopter whose own format is
already opaque to QDEF by design; it's aimed at an adopter with no
existing format of its own to protect (§1's "when QDEF earns its place").

## Split chunking vs. per-code capacity — costs nothing against at least one real adopter's design, general case still open

The uniform `chunkLen = ceil(total_bytes/count)` rule (spec §4.1) is what
makes single-fragment XOR parity well-defined, but it also prevents an
encoder from sizing each fragment to match that specific code's actual
capacity (different QR version/ECC level per code, or a QR code alongside
a smaller-capacity NFC tag in the same group). Checked against a real
adopter rather than left as a hypothetical concern: `mofosyne/tagdrop`'s
own sectorization already assumes uniform chunk length across a split
group (every sector but the last is the same length, per its own spec —
verified directly against `mofosyne/tagdrop`'s SPEC.md), so QDEF's
uniform-chunking rule matches what that adopter's format already does
rather than imposing a new constraint on it. That's evidence for one real
usage pattern, not a general resolution — an adopter that genuinely needs
heterogeneous per-code capacity within one group (the
QR-alongside-smaller-NFC-tag case) still hits this constraint. Resolving
that general case still needs either accepting uniform-chunking as a real
limitation, or specifying a fragment-length manifest redundant enough to
survive one missing fragment. See FINDINGS.md #3.

## Canonical encoding (resolved — spec §3.4)

Spec §4.1's `group_id` was a hash of encoded bytes that silently assumed
two conformant encoders given the same logical content produce identical
CBOR — true only because every worked example used simple, unambiguous
field values. CBOR permits multiple valid encodings of the same value
(e.g. an integer encoded with a longer-than-necessary argument width, or
a map with keys in a different order), so this wasn't automatically true
in general, and matters more the moment QDEF is used for hashing/signing
beyond `group_id`'s narrow use (spec §8's PGP-backup example already sits
right next to that use case, and any future Sign mechanism below depends
on it entirely).

Resolved by adopting CBOR's own deterministic-encoding rules (RFC 8949
§4.2.1 — shortest-form arguments, no indefinite-length items, map keys
sorted in bytewise lexicographic order of their encoded bytes) as a MUST
for encoders — nothing QDEF-specific invented, the same borrow-don't-
invent instinct as everywhere else in this document. Distinct from, and
not solved by, the field-value-shape rule (spec §3.2), which constrains
*what shape* a value may be, not which of several valid *encodings* of
that shape an encoder must pick — the two rules are complementary, not
overlapping.

Worth being precise about what was and wasn't actually broken: `group_id`
verification was never *incorrect* for its narrowest existing use (a
single encoder hashes bytes it's about to fragment, a decoder reassembles
and re-hashes the identical bytes — pure corruption detection, unaffected
by canonicalization either way). What canonical encoding actually fixes is
the *stronger* property `group_id`'s own spec text already implicitly
claimed — "content-addressed... no coordination is needed between
independent encoders" only holds if independent encoders of equivalent
content produce identical bytes, which nothing guaranteed before this
rule existed. Closed proactively, before Split/group_id saw real
production traffic, rather than after a cross-encoder mismatch surfaced
one in the field.

## Sign / detached-authenticity wrapper (new, requested)

There is no way today to prove a *plain, readable* Record is authentic
without also hiding it: the Encrypt wrapper's AES-GCM tag provides
integrity only as a side effect of confidentiality, and there is no
standalone sign primitive. Adding one is not the clean parallel to Encrypt
it first looks like, and that is the finding:

- **Sign-as-wrapper (opaque form).** Mechanically identical to Encrypt
  (Type 4) — the signed Record's bytes become the wrapper's opaque
  payload, plus a signature/MAC field. It inherits Encrypt's visibility,
  though: an unaware parser skips the whole thing and sees *nothing*. That
  is fine only when the inner Record was going to be opaque anyway (a
  Type-950 key backup, a proprietary blob), where it *is* a clean
  parallel. It cannot achieve "sign a Wi-Fi record and keep it readable" —
  being readable and being a wrapper payload are mutually exclusive.
- **Sign-as-sibling (detached form).** The signature is a *separate*
  Record (like the Fallback Hint spec §4.2 is a sibling, not a wrapper),
  carrying a reference to which Record(s) it covers plus the signature
  bytes. The signed Records stay plain and readable; an unaware parser
  reads them normally and skips the unrecognized signature Record by Type
  ID. This is the form that delivers "readable *and* verifiable" — but it
  depends on two things: **canonical encoding** (spec §3.4, now resolved
  above — a verifier must reconstruct the exact signed bytes) and a
  **coverage-identification scheme** (which Records, addressed how — by
  index? by content hash? — surviving reordering and unrelated siblings,
  still open). Coverage identification is the same signed-bytes/verified-
  bytes divergence hazard this project's origin story (TagDrop's signing
  bug) is a caution about, so it must not be hand-waved.

**Coverage-identification scheme — direction decided, not yet built.**
Cover by content hash of each covered Record's own canonical bytes, never
by Sequence index: an index breaks the moment anything is reordered or an
unrelated Record is inserted, while a hash doesn't care where a Record
sits. This also reuses the canonical-encoding machinery `group_id` already
needs (above) rather than inventing a second addressing concept. Two
refinements this needs to get right, both surfaced by checking the
proposal against rules already settled elsewhere in the spec rather than
taking the shape on faith:

- **The hash list MUST be a packed, fixed-width byte string, not a bare
  CBOR array.** Spec §3.2's field-value-shape rule forbids a bare array as
  a field value — `N` concatenated 32-byte SHA-256 hashes in one
  definite-length byte string (skip-safe, decoded by whatever
  Sign-Record-aware handler chooses to) is the compliant shape; a naive
  CBOR array of hashes is not, and a conformant core parser would reject
  it outright (spec §3.3).
- **A hash covers a Record's fully unwrapped, reassembled canonical
  bytes — never a Wrapper's per-fragment or per-code bytes.** Hashing
  Split-fragment bytes directly would make a signature depend on how many
  physical codes the content happened to be fragmented into, an
  implementation/transport detail with no business affecting whether a
  signature verifies. Sign a Record after any Wrapper stack resolves, the
  same layer `group_id`'s own hash already operates on.

Strippable-but-not-forgeable is an accepted property of this design, not a
gap to close: deleting a sibling Sign Record from the Sequence downgrades
signed to unsigned, trivially, the same way `mofosyne/tagdrop` already
documents "signature can be stripped but not forged or retargeted" as an
accepted limitation of its own scheme (§6) rather than something it
structurally prevents.

Direction when taken up: specify the sibling form (it is the one worth
having), but only *after* the canonical-encoding question is resolved — a
detached signature is meaningless without it. The wrapper form can be
dropped in at any time as a straight parallel to Encrypt if an
opaque-payload use case ever wants it. Prototype it the same way
everything else here was: sign two sibling Records, reorder them, insert
an unrelated third Record, and confirm verification still finds exactly
the right two — the sort of end-to-end check that catches what design
review alone doesn't (see FINDINGS.md).

## Nesting order enforcement — now answered, not open

A prototype confirmed a generically-written decoder cannot detect or
reject a non-conformant Wrapper nesting order (FINDINGS.md #7); spec
§4.1's text has been corrected accordingly. This entry is resolved and
kept here only as a record of the change from the prior draft's "leaning
toward" language.

## Type ID inheritance within a Sequence — backlog, needs a version bump

Raised alongside [GitHub issue #10](https://github.com/mofosyne/qdef/issues/10):
allow a Record's primary typeID in the prefix to be omitted, meaning
"same Type ID as the immediately preceding Record in this CBOR Sequence"
— a wire-efficiency optimization for adjacent same-type Records with a
wide private-use Type ID (the repeated calendar-event case in
`IMPLEMENTATION-NOTES.md` is exactly this shape).

Not something this draft can add as a plain additive extension the way
everything else in this document was. Spec §3.1 already defines a
missing prefix typeID as a MUST-abort condition — redefining that meaning
is a behavior change to already-shipped semantics, not an addition, so
two decoder versions would interpret identical bytes differently depending
on which one they implement. That's exactly the class of change spec §2
reserves the Version byte for ("a future version is free to change...
the routing rules... themselves"), not something to introduce via the
odd-key extensibility path the way Type Hint, Media Payload, and the
tag-24 generalization all were.

Scope, resolved as a side effect of a separate discussion (checking
issue #10's cross-code repeated-Type-ID cost against this idea): "the
immediately preceding Record" can only ever mean within one Sequence —
there's no cross-code Record continuity in the format at all, since each
physical code is parsed as its own independent container from a blank
slate. This means the mechanism would help intra-Sequence repetition
(the calendar-events case) but not cross-code repetition (issue #10's
motivating Preview cost) — worth being clear these are two different
problems with two different possible fixes, not one problem with two
names.

Backlog, not urgent: tracked for whenever a version bump happens for
some other reason, not a reason to force one on its own.

## Reference/value-sharing tags for intra-Sequence repetition — future path, not built

A related idea to Type ID inheritance above, raised while looking for a
general fix to repeated-large-value wire cost: CBOR already has
registered tags for exactly this — tag `25` ("reference the nth
previously seen string") and the pair `28`/`29` ("mark value as shared" /
"reference nth marked value," content a plain uint index). Checked
directly against the IANA registry, not assumed. Mechanically skip-safe
under one more small widening of the same rule generalized twice already
(§3.2, FINDINGS.md #15/#16) — a tag wrapping a scalar directly is exactly
as bounded as a tag wrapping a string, since the mandatory core only ever
needs to skip the reference, never resolve what it points to; resolution
is Record-Type-specific, optional work, same as unwrapping any other
opaque content.

**Doesn't solve the problem that motivated it, and that's worth being
explicit about rather than letting the idea imply otherwise.** A
reference requires shared decode state across everything it reaches
into; two physical codes have none — each is parsed from a blank slate,
in any order, with any of them possibly missing. So this hits the exact
same wall as Type ID inheritance above, for the identical structural
reason: it could only ever help repetition *within* one code's Sequence,
never App Route's or Preview's cross-code repetition, which is the cost
that actually prompted looking for a fix.

Where it would genuinely help: the same large value repeated multiple
times within one code — e.g. `IMPLEMENTATION-NOTES.md`'s calendar Option
B (several sibling Records, same wide private-use Type ID, all small
enough to sit on one code without needing Split). Real, but narrower
than "wire bloat" as originally framed, and it comes with cost beyond the
rule-widening: precise scope rules for what counts as "the stream" a
reference can reach into (one Record's map? the whole Sequence? does a
Wrapper's unwrapped content restart it?), and weaker real-world tooling
support than tag `24` had — tags `25`/`28`/`29` come from an informal
spec (schmorp.de's stringref/value-sharing drafts), not RFC 8949 proper,
so "generic CBOR tooling already reads this" is a much weaker claim here.

Not built. Noted as a future path specifically for the single-code
repetition case, not a general wire-bloat fix — worth a concrete same-
code case actually hitting this before adding the complexity, same
discipline as everything else deferred in this document.

**The same "no cross-code state" wall killed a later, unrelated idea
too — worth cross-referencing rather than re-litigating.** While
designing the namespace-pairing prefix item (§3.5), a "quick-select"
variant was proposed: let a short (1–3 byte) value in the namespace slot
act as a prefix-match back-reference to a full-length namespace declared
earlier in the same container, instead of always repeating the full
namespace bytes. Same fatal flaw as reference/value-sharing tags above —
it requires a decoder to carry memory of previously-seen records across
the position it's currently parsing, which conflicts with every physical
code being parsed independently from a blank slate. Deferred as a future
evolution idea, not built, for the identical reason this section gives.

## App Route's hash-derived form — a second use case surfaced late, not a second mechanism

**Renamed from "decentralized form."** At the time this section was
written, App Route's pre-filter form reused the same decentralized-ID +
Hint pattern Type IDs (§3.1, then) used. Once decentralized Type IDs
were retired and Type Hint went with them, "decentralized" stopped
having a stable meaning at that layer — App Route's key `0` was never a
Type ID to begin with, just an ordinary field value using the shared
hash-derivation algorithm (now homed at spec §3.5, since namespace IDs
are its primary surviving user). Renamed to "hash-derived form" to avoid
the collision; the mechanism itself is unchanged.

The domain-verified form of App Route (§4.4, FINDINGS.md #17) was built
to answer one question: which installed application should this scanned
code auto-launch. Working through GitHub issue #10 with TagDrop surfaced
a second, genuinely different question that key `0` also turns out to
answer well: *before* attempting reassembly at all, is this scanned code
even plausibly part of the group the scanner thinks it's building —
cheap, per-code triage against a misread or an unrelated nearby code,
layered ahead of §4.1's `group_id` integrity check rather than
duplicating it.

These two questions have different stakes, and conflating them would
have been the actual design error. Auto-launch dispatch is a
security-relevant decision — get it wrong and the wrong application
opens, so it needs the domain form's real, platform-verified ownership
proof (Android App Links / iOS Universal Links). The pre-filter is not
security-relevant — get it wrong and a decoder wastes a little effort
before `group_id` catches the mismatch anyway, exactly the same outcome
as not pre-filtering at all. That gap in stakes is *why* the
hash-derived form is allowed to reuse the cheaper, unauthenticated
hash-derivation pattern (a hash-derived byte string at key `0`, an
optional recoverable name at key `1`) instead of requiring domain
verification for both — it would be a mistake to make the pre-filter pay
the domain form's registration cost for a property it doesn't need, and
an even bigger mistake to let the pre-filter's weaker guarantee quietly
become load-bearing for dispatch.

Concretely this is the same "magic byte" idea raised earlier in this
project's history (see the ref-pointer/wire-bloat discussion above),
given a specific pre-filter role instead of staying an abstract
possibility. Landed as one Record Type with two forms rather than a new
Record Type, since the wire shape, skip behavior, and the shared
hash-derivation name-binding pattern (§3.5) are all identical; only the
trust model and the etiquette guidance around repetition differ (§4.4).

## Container discriminator redesign

**Supersedes the optional Type `0` header documented below — read this
first.** Everything from here down through
"Own-URI-scheme carriers skip magic AND namespace-scoping" documents the
optional-Record header design (Record Type `0`, an ordinary odd/optional
key on an ordinary Record). That design shipped, was used in production
analysis and TagDrop's own cost comparisons, and is kept below as the
real trail of reasoning that led here — but it has since been replaced
by a **mandatory container discriminator** (spec §3.5). This section
records why, and is the current source of truth; treat every "Type `0`"
reference below this point as historical unless it's also true of the
discriminator (most of the *namespace semantics* — even/odd scoping,
Hint-name qualification, per-code repetition — carried forward
unchanged; only the *container-level wire shape* changed).

**The problem the optional-Record design turned out to have.** An
optional leading item that's a bare uint or byte string is structurally
ambiguous: nothing on the wire distinguishes "this is the container's
declared namespace" from "this is the first (or a backup) typeID
belonging to the container's actual first Record." Both are the
identical CBOR shape in the identical position, and a decoder has no
principled way to tell them apart without already knowing which one it
is — which is circular. This was not a hypothetical concern: tracing it
through the actual JS parser's Phase-1 typeID accumulation confirmed it
accepts uint/bstr/tstr items with no way to distinguish "header" from
"second prefix item of the real Record 1." A CBOR tag number could have
marked the difference unambiguously, but tag-number collision risk with
other CBOR-based ecosystems already ruled that mechanism out once
(FINDINGS.md #11, [below](#cbor-tag-routing--removed)). The only
remaining way to resolve the ambiguity *structurally*, rather than by an
encoder convention that a careless implementation could violate, is to
make the discriminator unconditionally present — exactly one item,
always first, no exceptions.

**The trade-off, argued through explicitly rather than assumed.** Making
the discriminator mandatory means giving up "zero cost when unused,"
which the optional-Record design had treated as an important property
(every other standard record type mechanism has it). Every container now
pays at least 1 byte (`uint 0`) even when it wants no namespace at all.
The case for accepting this: MCU-constrained parsing cost is not the
relevant constraint for this project's actual priorities (smartphone
scanning first, deeply-constrained embedded scanners a nice-to-have) —
wire size is what actually matters, and a single byte answering "is this
a generic QDEF record or a specific application's own file format" is
proportionally negligible against any realistic payload, closer to a
RIFF form-type field than to wasted padding. It is not really "unused
overhead" the way a genuinely optional field would be: it's a
universally meaningful piece of self-description every container
benefits from having answered cheaply and unambiguously, the same job
RIFF's own form-type byte does immediately after RIFF's own magic.

**What it buys back.** The discriminator's recognized shapes (spec
§3.5) are each individually cheaper than the old Type `0` Record shape,
since none of them pay for a typeID prefix item plus a Map wrapper the
way an ordinary Record does. Verified against the actual encoder: a bare
4-byte decentralized namespace value costs 5 bytes as a discriminator,
versus 8 bytes as the old optional Type `0` Record (`Prefix: 0` + `Map: {
1: h'...' }`). Repeating that discriminator on every code of a
multi-code group (still required, for the same single-point-of-failure
reason as before) now costs 5 bytes/code instead of 8 — enough that a
single shrunk namespace-scoped odd uint Type ID (saving ≥8 bytes against
a private-use-random byte string baseline) already nets a **win**
per code on its own, not merely a breakeven the way the old 8-byte
header required two shrunk IDs to clear.

**What did not change.** The mandatory core still needs zero semantic
knowledge of the discriminator — it only knows how to skip exactly one
well-formed CBOR item to find where the Record Sequence starts
(`Container::discriminator()` in `rust/qdef-core`, backed by the
crate's existing generic `skip_any_item`; no discriminator-shape-aware
code was added). Interpretation — namespace/hint extraction — stays
entirely in `prototype/src/header.js`'s `parseDiscriminator`, matching
the original two-layer core/stdlib split. The own-URI-scheme and NDEF
carrier paths (`decodeSequence`) are unaffected: they never had a magic
prefix or a Type `0` header, and they never get a discriminator item
either, for the identical reason.

**This is a breaking wire-format change**, made deliberately rather than
incrementally, because the spec is still Draft status and explicitly
"not yet used in production anywhere" — see spec §1. There is no
version-negotiation machinery to preserve compatibility with (the
project removed the version byte earlier, on the theory that even/odd
criticality already provides forward compatibility), so this redesign
is a one-time, pre-production correction, not something requiring a
migration path.

Prototyped end to end: `prototype/src/core.js` (`encodeContainer`/
`decodeContainer` split off exactly one discriminator item),
`prototype/src/header.js` (`parseDiscriminator`, all recognized shapes),
`prototype/src/wrappers.js` (`resolveStack` reads each code's
discriminator via `parseDiscriminator` instead of scanning
`records[0]`), and `rust/qdef-core` (`Container::discriminator()`,
cross-validated against Node-encoded fixtures in `fixtures.rs`). See
FINDINGS.md for a real gap this redesign surfaced during
implementation: the Rust fixtures had gone stale and the test suite was
passing for the wrong reason before they were regenerated.

## The container header collapsed to magic + a CBOR Sequence, full stop

**Historical — the wire shape described here (Type `0` as an ordinary
optional Record) has since been superseded by the mandatory container
discriminator; see
["Container discriminator redesign"](#container-discriminator-redesign)
above.** Kept as the real trail of reasoning that led to the current
design, not as a description of current behavior.

What started as "can the header carry an optional format namespace for
fast identification" ended somewhere more radical: there is no longer a
distinct header structure at all. The container is `QDEF` (4 bytes) plus
a CBOR Sequence of Records — nothing else, ever. Each Record in the
Sequence carries its type identity in a prefix typeIDs array before its
map (spec §3.1), and Record Type `0` is reserved for what used to be
header-level metadata (spec §3.5), but it's an ordinary Record, decoded
by the exact same code path as any other Type, not a second wire
structure living alongside the Sequence.

Getting there took several real corrections along the way, worth naming
because each one fixed something that would have been a genuine
inconsistency if it had shipped:

- **A fixed-width raw namespace field, then a mandatory CBOR-uint one,
  both rejected in favor of an ordinary optional Record.** Both earlier
  shapes taxed every container that didn't use the mechanism at all (5,
  then up to 13 bytes, always paid). Landing it as a plain odd/optional
  key on Type `0` means a container using only known Type IDs pays
  *nothing* — not even one byte — the same "unaware party pays nothing"
   property every other standard record type mechanism already has.
- **"Different Type ID = different header version" was a real mistake,
  caught directly, not just a style preference.** It wasted low Type ID
  space on hypothetical future header revisions and was inconsistent
   with how every other standard record type Record actually evolves here (Encrypt and
  App Route both gained fields on their *existing* Type IDs, never new
  Types, when real needs showed up later). Corrected: Type `0` is the
  one, permanent header Record; a genuinely incompatible future change
  is just a new even/critical key on it, whenever actually needed —
  even/odd extensibility already *is* the version mechanism, no
  dedicated field required.
- **Key `1` was briefly considered for a "version code" field and
  rejected once the collision was spotted.** Key `1` was previously,
  globally, Type Hint (§3.1) — now in the prefix typeIDs. For a standard
  record type ID (even uint, which `0` is), a Type Hint at key `1` would
  have meant "the legacy ID this Type was promoted from." A generic
  Type-Hint-aware decoder would have actively misread a version integer
  sitting there as a bogus legacy-ID claim, not just ignored it. No
  field ended up needed there at all, so the question resolved itself,
  but the near-miss is worth recording: reusing an already-load-bearing
  key for a second, unrelated purpose is exactly the mistake this
  project already rejected once before, for even/odd itself (see
  "Registry governance," above) — worth catching a second time rather
  than assuming it wouldn't recur.

**Why the version byte itself is gone, not just smaller.** The old
container-level version byte existed to gate *any* future change to the
framing — a necessarily blunt, all-or-nothing tool, since a decoder has
no way to know in advance which future changes a version bump will
cover. §3.2's even/odd rule already solves this more precisely for
ordinary Record evolution (skip an unrecognized Type, ignore an
unrecognized odd key, abort just one Record on an unrecognized even
key). The only gap left was safety for changes to the outermost framing
itself — and Type `0` closes that gap using the identical mechanism,
just aimed one level further in, rather than needing a cruder,
separate all-or-nothing tool bolted on top of it. One extensibility
story for the whole format, not two.

Format namespace values reuse Type ID's own four-tier convention (§9's
Registry governance) rather than inventing a second, parallel governance
scheme — the same collision-safety math that makes a large random Type
ID viable without a registry applies identically to a namespace value.

Prototyped end to end: `prototype/src/header.js` and
`prototype/test/header.test.js` on the Node side, and
`rust/qdef-core`'s `record_type_0_needs_no_special_handling_from_this_crate`
test proving the claim in the name directly — the Rust mandatory core
required zero new code to handle Type `0` correctly, only a fixture
proving it.

**Consequence: App Route's Companion ID (key `5`) is removed, not kept
alongside this.** Companion ID existed for exactly one job — a cheap,
per-code misread pre-filter — and the namespace field now does that job
better: structurally guaranteed first (Companion ID lived on App Route,
which is explicitly *not* positionally special, so a scanner had to
find it), and genuinely zero-cost when unused (Companion ID required a
whole separate decentralized-form App Route record on every sibling
code). Keeping both would have meant two decentralized-plus-Hint
mechanisms answering the same question from two different Record Types
— exactly the kind of duplication this project avoids elsewhere (see
"Registry governance," above, on not inventing a second governance
scheme where one already fits). Nothing shipped yet, so this was a
clean removal rather than a deprecation: §4.4's domain form and plain
decentralized form are back to their pre-Companion-ID shape, and the
domain form's key `1` is a label again, not unified with the
decentralized form's Hint-name role — that unification's only real
justification (letting Companion ID be hash-checked) is gone with it.

## Namespace-scoped Type IDs (32768+) — resolved, not left open, once a real adopter had a concrete want

§3.5's namespace mechanism launched with one deliberate gap: whether and
how Type IDs `100`+ become namespace-local once a namespace is declared
— the original truncation idea that motivated building a namespace
mechanism at all — was left unresolved, on the theory that landing
identification cleanly mattered more than guessing at a scoping rule
nobody had asked for yet. TagDrop asking directly, with a concrete want
(shrinking four existing 64-bit Type IDs) rather than a hypothetical
one, was exactly the signal this project has waited for before building
speculative things — the same pattern that produced App Route and,
later, its own removal.

**The resolution reuses the existing flat numbering space; it doesn't
carve out a new one.** Once Type `0` declares namespace `N`, a
subsequent Record's primary typeID `T` in the prefix above the always-global
floor is looked up as the compound key `(N, T)`, not `T` alone — the same
relationship a Bluetooth short UUID has to whichever Base UUID it's
declared against.
This was the crux design question, and the reason it took real thought
rather than a quick answer: the obvious alternative (reserve a new
numeric sub-range exclusively for namespace-local IDs) risks collision
with whatever's already been allocated in the existing tiers, and
doesn't actually need solving once you notice that a *compound* key
removes the ambiguity structurally — `T` in isolation was never the
real lookup key once a namespace is present, so there's nothing for a
reserved range to protect against colliding with.

**The one sharp edge, named explicitly rather than glossed over:** a
decoder that implements specific semantics for any namespace-scopable
Type ID and does *not* check for a declared namespace first can
misapply its global interpretation to a namespace-scoped Record that
merely shares the same number — a wrong match, not a clean miss, which
is a worse failure mode than anything else in this spec produces.
Nothing forces this check today (nothing has shipped), so it's being
written into the correct definition of that tier's routing from the
start rather than patched in later. Framed the same way Type Hint's
dual-mode prefix role already is: Record-Type-interpretation-specific
handling (spec §3.3's optional tier), never a mandatory-core concern —
the mandatory core still just reads prefix typeIDs, unchanged, with zero
namespace awareness.

**Follow-on, asked directly right after the first resolution landed:
should the always-global floor really stop at `99`, or does that leave
the sharp edge exposed exactly where it's most likely to actually bite
someone?** The original design let namespace-scoping apply to anything
`100`+, reusing the *entire* common-vocabulary and first-come space.
Reconsidered once the actual risk profile was thought through properly:
the sharp edge isn't equally dangerous everywhere in that range. A
decoder implementer who only cares about the reviewed, well-known
common-vocabulary tier (`100`–`999`, as it was numbered at the time) has
no reason to ever read §3.5 at all — they're not choosing to accept the
sharp edge, they may never even learn it exists, which is a meaningfully
worse failure mode than "an implementer who read the spec and got the
check wrong." The first-come tier (`1000`–`0xFFFF`, as it existed at the
time) was different in kind, not just degree: it was explicitly
uncurated ("registered, but no review gate beyond not-already-taken"),
so a decoder hardcoding against one specific registration there was
both a rarer thing to do and a lower-stakes thing to get wrong.

Resolved by extending the always-global floor from `100` to `1000` —
`1`–`999` (standard record types *and* common-vocabulary) stayed
unconditionally global; only the first-come tier was namespace-scopable.
Verified the real cost of this choice rather than asserting it was
cheap: the cheapest possible namespace-scoped Type ID moved from 4
bytes (`100`) to 5 bytes (`1000`) — one extra byte, traded for closing
off the specific failure mode most likely to occur in practice rather
than the theoretically cheapest design. A third, stricter option
(require namespace-scoped IDs to be odd uints) was considered and set aside: it
closes the first-come tier's sharp edge too, at 7 bytes minimum — a
real, defensible choice, but one paying for safety margin against a
risk already judged low-stakes, for a proportionally much larger
wire-cost regression against what motivated building this mechanism in
the first place.

**Second follow-on, same day: does the floor's exact number (`1000`)
have any principled basis, or is it just a round number this project
picked?** It was the latter — and the user pointed at a better anchor:
IANA's own CBOR tag registry
([iana.org/assignments/cbor-tags](https://www.iana.org/assignments/cbor-tags/cbor-tags.xhtml))
already draws this exact three-way distinction, verbatim: `0`–`23`
"Standards Action," `24`–`32767` "Specification Required," `32768`+
"First Come First Served." Verified directly against the registry
rather than assumed. Checked the real wire cost of moving the floor
from `1000` to `32768` before adopting it, the same way every other
boundary choice here has been checked rather than asserted: both values
fall inside CBOR's same 2-extra-byte uint encoding class (`256`–`65535`),
so `cost(1000) == cost(32768) == 5` bytes — moving the floor is a free
upgrade, not a tradeoff, and was adopted on that basis. The
common-vocabulary tier's ceiling moved with it, `999` → `32767`,
deliberately mapped onto IANA's "Specification Required" span — which
is conceptually the right label for it, since that tier already *is* a
review-gated allocation, just one QDEF governs itself rather than IANA.
`1`–`99` (standard record types) was deliberately left unaligned with IANA's `0`–`23`:
renumbering seven already-shipped-in-examples mechanism IDs to fit a
foreign registry's unrelated tier (Standards Action is about who can
change the *CBOR* spec, not "generic tools must unwrap this regardless
of namespace") would have bought nothing.

**Third follow-on, same day: since namespace-scoping only ever applies
above the common-vocabulary ceiling, and it's disabled (falls back to
plain global) whenever no namespace is declared, does the first-come
tier still earn its place at all?** Asked directly, and the answer was
no — see "No separate 'first-come-first-served' tier (considered,
dropped)" under "Registry governance," above, for the full reasoning.
In short: first-come tried to give a cheap, uncoordinated, small Type
ID without picking any of the three actual sources of collision-safety
(curation, width, or namespace scoping), which is exactly why it never
had a real governance model — and namespace-scoping already covers its
entire use case with a mechanism that does. Dropping it needed no code
or wire-format change at all: `resolveLookupKey`'s floor check never
implemented "first-come" as a distinct mechanism to begin with, so
removing the tier is purely a governance/vocabulary simplification —
`GLOBAL_TIER_CEILING`'s value and the paragraphs above already describe
the result (everything at or above the ceiling is either namespace-
scoped or expected to be decentralized byte string, never an ungoverned flat
number) without needing a separate tier concept to explain it.

**Fourth follow-on, same day: is a namespace-local Type ID actually a
truncated version of a wider ID?** Asked directly, worth answering
precisely because "shrinking four existing 64-bit Type IDs" (TagDrop's
original want, above) reads ambiguously — it could mean "derive the
small ID mathematically from the wide one" as much as "replace the wide
one with an unrelated small one." It's the latter, deliberately: a
namespace-local ID is freshly chosen, with no formula connecting it to
any wider ID. This isn't a style preference — literal truncation would
actively break the mechanism. `resolveLookupKey` only checks magnitude
against the ceiling; it cannot distinguish a freshly-picked small number
from the low bits of a truncated wide one. A truncated value's
magnitude is effectively random with respect to the ceiling, so it can
land below `32768` by chance — and a Type ID below the ceiling is
*always* interpreted globally regardless of any declared namespace, so
a truncation-derived ID would silently discard its own namespace
scoping some fraction of the time, exactly the "wrong match, not a
clean miss" failure mode named above, just triggered at ID-selection
time instead of decode time. Made explicit in spec prose (§3.5) rather
than left to be inferred from the "shrinking" framing, and demonstrated
rather than just asserted: `prototype/test/header.test.js` constructs
exactly this case (a value equal to a real 64-bit decentralized byte string ID
truncated to its low 15 bits) and confirms it resolves globally, not
namespace-scoped, despite a namespace being declared.

**Fully additive.** An app's existing global decentralized Type
IDs keep working forever; adopting namespace-scoped small IDs for new
content is an independent, opt-in choice that never invalidates or
collides with the old ones, since an unnamespaced old ID was never
namespace-scoped to begin with.

Prototyped in `prototype/src/header.js`'s `resolveLookupKey` and
`prototype/test/header.test.js`: the same Type ID resolving to different
compound keys under different namespaces, `1`–`32767` staying global
   regardless (both the standard record type range and, deliberately, the full
IANA-aligned common-vocabulary range up to `32767`), a namespace-aware
dispatcher correctly *not* falling back to a recognized global meaning
for an unrecognized namespace-scoped Record above the ceiling (the
sharp edge, demonstrated rather than just described), a naive decoder
that never checks for a namespace at all still correctly resolving a
common-vocabulary Type ID (the specific failure mode the floor
extension exists to close off), and TagDrop's actual migration case end
to end — verified real byte counts, not claimed ones: an existing
64-bit global Type ID costs 11 bytes as a bare Record; a namespace-
scoped small ID (`32768`, the current floor) costs 5, the same as it
would have cost at the old `1000` floor.

## Namespace repetition across a multi-code Split group — TagDrop asked before committing, not after shipping it wrong

Once §3.5's namespace mechanism landed, TagDrop asked directly whether a
Type `0` declaration needs to repeat on every physical code of a
multi-code Split group, or can appear once — before adopting it for real,
specifically because the answer changes their byte-cost math a lot
either way. Worth answering by tracing the actual mechanics, not by
analogy alone.

**It must repeat on every code, for the same reason Preview and App
Route's hash-derived form already do.** Each physical code is parsed as
its own independent container, from a blank slate, with no cross-code
state — already established, for a different reason, in "Type ID
inheritance within a Sequence" and "Reference/value-sharing tags," above.
A decoder holding one code out of a group has no way to learn a namespace
declared on some other code it hasn't seen.

**The harder part, and the reason this needed real thought rather than a
quick "yes": does a namespace even reach a Type ID that's only
discoverable after a Wrapper stack fully resolves, at all?** Checked the
actual mechanics rather than assuming: `§4.1`'s Wrapper resolution always
re-parses fully reassembled bytes as one standalone Record, decoupled
from whatever Sequence the outer Wrapper Record came from — and the
prototype's own resolver (`resolveStack`) only ever inspected `records[0]`
of each code, with no defined behavior at all for a Type `0` sibling
coexisting with a Wrapper Record in the same code's Sequence. This wasn't
a design choice anyone made; it was simply never asked before. Resolved
by extending the same namespace to cover both cases uniformly: a
namespace declared by a Type `0` sibling in a code's Sequence applies to
every other Record in that Sequence *and* to whatever a Wrapper stack in
that Sequence ultimately resolves to.

**Considered and rejected: a weaker rule where a Wrapper-reachable Type
ID only needs the namespace on *some* code contributing to reassembly,
not literally every code.** Tempting at first, since full reassembly
already requires having scanned enough codes to gather every fragment (or
enough with `parity_scheme`), so a namespace on any one of those already-
scanned codes would, in principle, already be in hand by the time
reassembly finishes. Rejected once the actual robustness story was
checked: `parity_scheme` recovers a missing *fragment's bytes*, but a
Type `0` Record is a whole sibling Record living outside the Split
group's own fragment data — losing the one code that happened to carry it
loses the namespace outright, with nothing to recover it, even while the
Split-protected *content* itself is fully intact via parity. Accepting
"content is loss-tolerant, but the namespace needed to interpret it isn't"
would have been a real, inconsistent robustness story and a genuine
regression from what a plain sibling like Preview already guarantees.
Requiring literal per-code repetition, uniformly, avoids that asymmetry
entirely and needs no special-casing between "plain sibling" and
"Wrapper-reachable" namespace-scoped Type IDs.

**The wire-cost answer TagDrop actually needed, verified against the real
encoder rather than estimated:** shrinking one namespace-scoped Type ID
from a decentralized byte string (10 bytes bare) to a small odd uint (4
bytes bare) saves 6 bytes; the cheapest legal repeated Type `0` header (a
4-byte byte string namespace, no Hint name) costs 8 bytes *per code*. A
single namespace-scoped ID repeating alone nets **+2 bytes/code — a
regression**, confirming TagDrop's own worry that the header's overhead
could offset the savings; it takes at least two namespace-scoped Type
IDs' worth of per-code savings to turn it into a net win. This is exactly
the kind of number this project checks rather than asserts — see
FINDINGS.md.

**Correction, found while chasing the same question further: `4 bytes
bare` wasn't the cheapest legal odd uint, it was a leftover example
value.** The `32769`-style examples used throughout this section (and,
worse, in §3.5's own worked example) predate the parity-based redesign
and were never actually the minimum — under the current rule there is no
magnitude floor at all, only parity. A genuinely minimal odd uint (`1`,
`3`, `5`...) costs **2 bytes bare**, not 4, since CBOR packs any value
`0`–`23` into the initial byte with no argument bytes at all. Recomputed
the breakeven with the real minimum: saving per shrunk ID against the
same 10-byte decentralized baseline becomes 8 bytes, not 6 — meaning **a
single repeating namespace-scoped ID already clears the 8-byte Type `0`
tax on its own** (8 saved ≥ 8 spent), reversing the "need two IDs"
conclusion above for the common case of small, hand-picked sequential
IDs specifically. The "two IDs" framing still holds for the *specific*
scenario it was computed for (Preview repeating + Body reassembled once,
where Body's one-time saving doesn't stack with a per-code tax the way
two *repeating* IDs would) — it just isn't the general rule this section
implied. Fixed the stale examples in both places; see FINDINGS.md.

**Stated as its own general principle, not just a footnote on one worked
scenario — a real implementer-facing gap, closed after being asked how
much it actually mattered in practice.** The distinction buried in the
paragraph above generalizes: a plain sibling Record's namespace-scoped
Type ID is typically repeated on every code, so shrinking it saves the
shrink *N times*; a Type ID only reachable after a Wrapper stack fully
resolves exists exactly once for the whole group (fragmented or
otherwise encoded, reconstructed once), so shrinking it saves the shrink
*exactly once*, full stop — never something that scales with code count.
Getting this backwards — crediting a Wrapper-reachable ID's shrink as if
it repeated N times — overstates how quickly a repeating discriminator's
own per-code cost gets cleared. Worth being explicit about since nothing
forces an implementer doing this math themselves to notice the
difference; the "Preview vs. Body" example above is one instance of the
general rule, not a special case. Now also stated directly in spec §3.5.

**Superseded numbers, not re-derived here.** The `8 bytes` repeated-header
cost above was the optional Type `0` Record's cost; the mandatory
container discriminator (["Container discriminator
redesign"](#container-discriminator-redesign), above) replaced it at 5
bytes/code for the equivalent bare 4-byte decentralized namespace,
making a single repeating shrunk ID a net win outright rather than a
breakeven. The qualitative conclusions in this section (repetition is
required per code, a Wrapper-reachable namespace-scoped ID gets no
parity protection, disagreement is rejected) are unchanged — only the
Type `0`-specific byte totals are dated.

Prototyped in `prototype/src/wrappers.js`'s `resolveStack` (reads each
code's discriminator via `header.parseDiscriminator`, requires agreement
across every code that declares one, and applies it to the resolved
terminal Record) and
`prototype/test/multi-code-namespace.test.js`: the repeated case
resolving correctly through full Split reassembly, the single-point-of-
failure case reproduced directly (a namespace declared on only one code
survives while that code is present and aborts the instant it's the one
dropped, even though parity fully recovers the content regardless),
disagreeing codes rejected outright, and the no-namespace-anywhere case
aborting the same as the already-covered single-code case.

**Stale-content note, found while locating where to add this entry.** The
"Namespace-scoped Type IDs (32768+)" section immediately below describes
the *pre-redesign* mechanism — a magnitude-based `GLOBAL_TIER_CEILING`
floor (`1000`, later `32768`) that no longer exists in the current spec,
which classifies by parity (even uint = always global, odd uint =
namespace-scoped) instead. A terminology pass evidently touched that
section's wording (e.g. "standard record type") without updating its
substance to match the parity-based redesign. Left as-is here rather than
silently rewritten mid-unrelated-change; needs its own dedicated pass.

## Own-URI-scheme carriers skip magic AND namespace-scoping — a real gap found by pushing TagDrop's cost question one step further

Asked directly, once the corrected small-odd-uint numbers still left a
real gap against TagDrop's own lean per-sector cost: how much of QDEF's
remaining tax is actually necessary for an adopter in TagDrop's specific
position, versus tax being paid for a guarantee that position doesn't
need? Checking TagDrop's real SPEC.md (`mofosyne/tagdrop`, added to this
session and read directly rather than assumed) rather than treating them
as a hypothetical answered it: every one of their codes is
`tagdrop:<base41-cbor-sequence>` — their own URI scheme, not byte-mode
QR. §1 already has a rule for exactly this: an application with its own
scheme should carry its envelope directly under that scheme, since the
scheme prefix already does the recognition job magic bytes exist for.
That rule was being stated but not actually being *applied* to the cost
comparisons in this document, which had been including a 4-byte magic
header per code the whole time.

**Pushed one step further than "drop magic": does the same isolation
argument also remove the need for namespace-scoping?** Yes, and for the
identical reason. Namespace-scoping (§3.5) exists to let genuinely
unrelated apps' small Type IDs coexist in one *shared, generic*
container without central coordination. An application whose carrier
already guarantees nothing but its own decoder will ever see these bytes
— a URI scheme, or an app-specific NDEF MIME type — has already solved
the problem namespace-scoping solves, by a different, pre-existing
mechanism. Paying Type `0`'s repeated-per-code tax on top of that buys
nothing: a small, self-allocated even Type ID (the `32768`+ First-Come
tier, no registry needed, spec §4) is exactly as collision-safe *in that
application's actual deployment* as a namespace-scoped one would be,
since the two decoders that could theoretically disagree about what a
given number means never both see the same bytes in the first place.

**The corrected cost picture, verified against the real encoder at each
step, not asserted:**

```
+---------------------------------------------+-------+-------+
| Approach (per group of N codes, N=4 shown)   | bytes | delta |
+---------------------------------------------+-------+-------+
| TagDrop's own envelope (version + type)      |     8 |     — |
| QDEF, magic + discriminator + namespace-     |    44 |   +36 |
|   scoped (original)                          |       |       |
| QDEF, no magic (own scheme dispatches)       |    28 |   +20 |
| QDEF, no magic, no discriminator (own scheme |    16 |    +8 |
|   also isolates -- self-allocated even ID)   |       |       |
+---------------------------------------------+-------+-------+
```

**Numbers updated for the mandatory container discriminator** (["Container
discriminator redesign"](#container-discriminator-redesign), above),
which replaced the old optional Type `0` Record header this table
originally priced (58/+50, 42/+34, 20/+12) — the discriminator's cheapest
namespace-bearing shape costs less than the old header's typeID+map
framing, so every row that carries a namespace got cheaper. Recomputed
directly from `prototype/test/custom-scheme-carrier.test.js`'s own
verified per-code figures (11, 7, 4) × 4 codes, not hand-estimated.

Each row is a real, previously-unapplied instance of a principle this
document already stated, not a new mechanism — the fix was recognizing
that "own URI scheme" and "own MIME type" already buy *two* things
(dispatch AND isolation), and this project's own cost comparisons had
only been crediting the first.

**The remaining +8 byte gap (own-scheme, self-allocated ID vs. TagDrop's
own envelope) is not waste, and shouldn't be chased away.** It's the cost
of a typeID being a self-describing, open-ended
registry entry — meaningful to any future or generic reader, not just
one application's own decoder — versus TagDrop's `type` byte, a closed,
app-private 2-value enum. That's a genuinely different capability, not
inefficiency, and this project's whole discipline has been to distinguish
the two rather than reflexively minimize bytes without asking what a
given cost is actually buying.

**Gap found in the process, closed rather than left implied:** §2 stated
the "own URI scheme, skip magic" principle but, unlike the NDEF case,
never worked it out concretely or tested it — no example, no prototype
coverage. Fixed: §2 now has a paragraph parallel to NDEF's, §3.5 gets the
matching namespace-skip guidance connected to the same "already isolated"
reasoning, and `prototype/test/custom-scheme-carrier.test.js` demonstrates
both — a bare Sequence round-tripping via the same `decodeSequence` path
NDEF already used, and the corrected byte counts verified directly against
the encoder (`11` bytes shared-container path vs. `4` bytes own-scheme
path, per occurrence — the shared-container figure reflects the mandatory
container discriminator, cheaper than the optional Type `0` Record header
in place when this figure was first measured).

**A real gap in the isolation argument, found by pressure-testing it
against TagDrop's actual implementation practice, not a hypothetical.**
Isolation-based collision safety for a self-allocated even Type ID
(above) is a property of *the carrier at the point of consumption*, not
of the bytes — nothing in an even Type ID's own encoding marks it as
"only ever reachable through an isolating wrapper." Asked TagDrop
directly whether that assumption actually holds for how they build
things, rather than assuming it does because the spec says so: it
doesn't, cleanly. TagDrop deliberately reuses the identical CBOR-
sequence bytes across two carriers for implementation simplicity — the
same bytes get Base41-encoded into their `tagdrop:` URI *and* dropped
raw into an NDEF record under their own `application/vnd.tagdrop` MIME
type. Both of TagDrop's *current* carriers happen to preserve isolation
(distinct scheme, distinct MIME type — neither is a shared/generic
dispatch context), so nothing is actually broken today. But the
practice itself — one shared codepath producing bytes that get wrapped
differently depending on transport — is exactly the shape of thing that
silently stops being safe the moment a *third* carrier is added without
equivalent exclusivity (a bare byte-mode QR with no distinguishing
wrapper, or a shared/generic MIME type), since nothing at the wire level
would notice or block it.

**The deeper issue isn't a bug to fix, it's a real tension this
mechanism has that the spec previously understated.** An application
that wants any degree of recognizability by tools other than its own
decoder — which is presumably *part of the point* of adopting QDEF's
shared Record format at all, rather than keeping a fully bespoke
private wire format — is, by definition, choosing not to stay
permanently isolated. For that application, leaning on isolation as the
collision-safety mechanism for its even Type IDs works against its own
stated goal. Namespace-scoping (§3.5) or an eventual First Come First
Served registry entry (§4, "Governed vs. ungoverned," above) are the
carrier-independent alternatives — either stays collision-safe
regardless of which carrier the bytes end up traveling through, which
self-allocated-and-isolated even IDs structurally cannot offer.

Added the caution directly to spec §2/§3.5 rather than leaving it
implied — an implementer reusing binary internals across carriers needs
to verify *every* carrier those bytes can reach provides isolation, not
just the primary one, and an application whose actual goal includes
interoperability should treat this tier's isolation story as an argument
*against* using it, not for it. See FINDINGS.md for the full story of
how this surfaced.

**A better pattern than either self-allocated-even or transmitted-
namespace, surfaced by asking TagDrop directly what their own decoder
actually does internally, not assumed from the outside.** TagDrop's own
implementation already "reinserts" a container discriminator internally
when content arrives via a carrier that implies it (their `tagdrop:`
URI) — even though the transmitted bytes never carry one, matching §2's
guidance. Asked what value gets reinserted: a *real* namespace value,
not a placeholder, whenever the content genuinely came from their own
scheme.

That's the key fact that makes a stronger pattern available: an
isolated-carrier application doesn't have to pick between "cheap but
carrier-dependent" (self-allocated even IDs, the original guidance) and
"safe but the discriminator costs bytes" (an ordinary namespace
declaration). It can fix a real namespace value once and have its own
decoder assume that value applies to anything reaching it through any of
its own carriers, without ever transmitting it — odd, namespace-scoped
Type IDs at the identical wire cost as the even-ID pattern (a bare uint,
no discriminator), but with the fail-*closed* property namespace-scoping
always has (§3.5: an odd Type ID with no namespace present MUST abort)
instead of the fail-*open* exposure an unprotected even ID has if it
ever reaches an unisolated carrier. It also converts to real,
transmitted-namespace interoperability later at zero cost to the Type
IDs themselves — only the carrier changes, not the numbers.

Added to spec §3.5 as the now-recommended pattern for any isolated-
carrier application, superseding the plain self-allocated-even
recommendation as the default suggestion (self-allocated even IDs are
still valid, just no longer the first thing to reach for). Requires
exactly one discipline the spec now states plainly: the implied
namespace value must be identical across every one of the application's
own carriers, or the pattern's safety collapses back to the even-ID
case. See FINDINGS.md #29.

§3.1's form boundary excludes CBOR major type 1 (negative integer) from
valid typeID prefix forms, alongside array/map/tag/simple for
skip-safety and sense-as-an-identifier reasons. Negint is different from
those: it's a scalar, exactly as skip-safe as uint, and structurally
available — checked directly against the actual parser
(`prototype/src/core.js`'s `isTypeId`/`parseRecords`), not just the
prose, that an unrecognized negint prefix item is already silently
skipped as forward-compat padding today, and a Record relying solely on
it for identity already degrades to `ignored: true` cleanly. That makes
it the one remaining major type a future revision could assign a
typeID-adjacent meaning to without a version bump — genuinely reserved
space, not merely unused space.

Two candidate uses were raised for it and both were set aside:

**Split the standard/scoped distinction across uint vs. negint, instead
of even/odd-on-uint.** Would remove one real hazard — an implementer
who forgets to force a scoped ID's parity odd, or a truncated/hashed ID
that randomly lands on the wrong parity, silently becoming "standard
global" instead of erroring. But even/odd-on-uint already shipped and
works, and CBOR negint costs a value-transform tax most host languages'
CBOR libraries impose (`index = -1 - value`) for no corresponding wire
or safety benefit over what a parity check in the generate/validate
tooling would already catch more cheaply. Not worth the churn.

**Reserve negint for a future back-reference/pointer typeID, resolving
"Type ID inheritance" and "Reference/value-sharing tags," both above,
without their original version-bump blocker.** This one is worth
recording in more detail, because it changes what actually blocked
those two backlog entries. Both were shelved specifically because their
original shape — redefining "no prefix typeID present" to mean "inherit
the previous Record's" — silently changes the meaning of already-shipped
bytes: an old decoder and a new decoder would read the identical Record
differently. An *explicit* negint-form back-reference item doesn't have
that problem: checked against `isTypeId`/`parseRecords` directly, an old
decoder sees a well-formed CBOR item it doesn't recognize as a typeID
form, skips it as padding (same as any other future extension) — the
Record's typeID identity comes only from whatever bare uint or
namespace-pairing item precedes it in the prefix, exactly as it does
today (§3.1: one typeID-bearing item per Record, no backup accumulation
since that mechanism was retired); if there is none, the Record is
simply `ignored: true`, same as any other Record with no recognized
typeID — never a silent reinterpretation, never corruption. So the
version-bump objection that shelved both ideas does not actually apply
to this specific shape. Worth writing down since it may matter if either
backlog item is revisited later.

That said, the concrete case both ideas exist to solve —
`IMPLEMENTATION-NOTES.md`'s repeated-calendar-event Records, Option B —
is already solved today, for free, by namespace-scoping: declare a
namespace once, use a cheap sequential odd uint per repeated Record, and
the "wide ID repeated N times" cost this would compact never happens in
the first place. That leaves only a narrower residual case (an
*unnamespaced* container with many repeated wide byte-string IDs) where
a back-reference would still add anything — real, but not the load-
bearing motivation it first looked like, and not enough on its own to
justify committing the one remaining major type to a specific future
shape today.

**Resolution: leave negint excluded, not formally reserved for
anything.** The wire behavior is identical either way — an old decoder
skips an unrecognized negint as padding whether or not the spec has
pre-announced what it's for. The only thing "reserve" would buy over
"exclude" is an advance promise about future meaning, and this project's
own pattern (App Route, namespace-scoping, both left unbuilt until a
real adopter had a concrete want) argues against making that promise
before a real need identifies what it should actually say. If one shows
up, it picks from whatever's still unclaimed then — including negint,
still available, exactly as it is today.

## Multiple namespaces per container — built via a per-Record namespace-pairing prefix item

Asked directly: should one container support declaring more than one
namespace, so a single physical code could mix content from several
genuinely unrelated apps, each with its own compact, namespace-scoped
Type IDs? Framed against a stated assumption worth checking first: one
code tends to belong to one application, which relies on common
community standards *plus* its own extension.

**That framing already describes exactly what the existing single-
namespace design provides, without needing a second namespace at all.**
"Community standards" already live in the always-global even tier
(standard record types, common-vocabulary registrations) — interpretable
unconditionally, regardless of whether any namespace is declared.
Declaring a namespace doesn't consume or compete with that tier; it only
adds a second, compact lookup space for the *one* app's own odd Type
IDs. So "one app, its own extension, plus shared standards" is already
fully served by Type `0`'s existing single-declaration design — there is
nothing in that scenario a second namespace would add.

**The scenario that would actually need a second namespace is a
different one: two genuinely unrelated apps, in the same code, both
wanting their own compact namespace-scoped IDs simultaneously.** That's
real in principle, but it isn't unserved today — any number of unrelated
apps can already share one physical code as sibling Records, each
dispatched by its own distinct *global* Type ID (common-vocabulary or
self-allocated, `32768`+, no registry needed — see "Own-URI-scheme
carriers," above, for the same tier used a different way). What multiple
apps sharing a code can't both get is the compact, namespace-scoped
small-ID discount at the same time — that stays reserved for whichever
one app owns the code's single Type `0` slot, the same way it always
has.

**Both ways to build actual multi-namespace support cost real
compactness for the common case, in exchange for a rarer one nobody has
asked for:**

- *Multiple Type `0`-shaped Records, position-based* (a second one starts
  a new scope for whatever follows it) reintroduces stateful,
  order-dependent parsing this project has deliberately kept out of
  every other mechanism — there is no cross-code Record continuity
  anywhere else in the format (see "Type ID inheritance," "Reference/
  value-sharing tags," above, both rejected partly for the identical
  reason), and nesting order elsewhere is a documented convention, never
  something a decoder is required to track. A decoder would need to
  track "which segment of the Sequence am I currently scoped under"
  instead of the flat, order-independent lookup every other Type ID
  gets.
- *Type `0` carries an array of namespaces, each scoped Record selects
  one explicitly* adds a mandatory selector field to *every*
  namespace-scoped Record, not just the header — directly undermining
  namespace-scoping's entire value proposition, which is "pay once at
  the header, every subsequent small ID is free." Making every
  subsequent Record pay again defeats the reason to reach for this
  mechanism in the first place.

**Both objections above turned out to be specific to those two
mechanisms, not to multi-namespace support in general — a third option
sidesteps both.** Revisited once a concrete third shape was proposed:
let a Record's own prefix optionally carry a **namespace-pairing item**,
a 2-element array `[namespace, typeId]`, instead of a bare typeID
(spec §3.1). When present, it declares/overrides *that one Record's*
namespace, independent of — and taking priority over — whatever the
container discriminator declared as the ambient namespace. Every other
Record in the container is unaffected.

This avoids both prior objections directly:

- **No stateful, position-dependent parsing.** A pairing item is
  entirely local to the one Record whose prefix carries it — there is
  no "current scope" a decoder has to track across the Sequence, and no
  cross-code state either. Each Record is still parsed independently,
  exactly like every other mechanism in this format.
- **No mandatory selector on every namespace-scoped Record.** The
  common case — one app, its own namespace, sibling Records that all
  want it — pays nothing extra: those Records still use a bare typeID
  and inherit the container's ambient namespace, exactly as before.
  Only a Record that actually wants a *different* namespace than
  ambient pays for a pairing item, and only that one Record.

**Structural, not semantic, at the mandatory-core level.** The core
needs exactly one new recognition rule — a definite-length 2-element
array at a typeID-accumulation position is *also* a valid prefix-item
shape — and pulls the array's second element in as an ordinary typeID
candidate. It never learns what the first element *means*; it's exposed
raw (`Record.localNamespace` in the Node prototype;
`Record::local_namespace()` in `rust/qdef-core`), the same "core exposes
it, an interpretation layer decides what it means" split the container
discriminator itself already uses. `header.js` gained one new function,
`resolveLookupKeyForRecord`, that prefers a Record's own
`localNamespace` over the container's ambient header when both are
present — everything else about namespace *semantics* (even always
global, odd requires a namespace, the "wrong match is worse than a
clean miss" rule) is completely unchanged; only where the applicable
namespace value comes from is new.

**Not a cheaper way to get a decentralized ID — an opt-in override,
verified against the actual encoder, not assumed.** Unlike the
container discriminator (paid once, amortized across every Record in
the container), a pairing item is paid fresh on every Record that uses
it — there's no amortization. Cost of the prefix item alone (excluding
the Record's own field Map, which every Record pays regardless of
routing form):

```
+-------------------------------------------------+-------+
| Form                                             | bytes |
+-------------------------------------------------+-------+
| [Decentralized Namespace ID (4B), scoped typeId] |     7 |
| bare typeID, no override (today)                 |     2 |
+-------------------------------------------------+-------+
```

(An Allocated/uint namespace row, and a "standalone decentralized Record
ID" row, both previously appeared here too; the former was removed once
the Allocated namespace tier itself was dropped — see "Namespace IDs are
always Decentralized," below — and the latter once decentralized Record
Type IDs were retired entirely, §3.1: there's no longer a standalone
decentralized form to compare against.)

A pairing costs *more* than a bare typeID with no override (7 > 2) — it
bundles a full namespace declaration onto the one Record using it. So
this mechanism doesn't replace, and shouldn't be reached for instead of,
the container discriminator (the cheap, amortized, common-case path): it
answers a narrower question — "can this one Record use a namespace
other than the container's ambient one" — that the discriminator alone
can't answer without taxing everyone else.

**An even (Allocated/global) typeId inside a pairing is vacuous.** The
existing invariant — even uints are always globally interpreted,
regardless of any declared namespace — is unchanged and unconditional;
pairing a namespace with an even typeId has no effect on its lookup. The
mechanism is only meaningful for odd (scoped) typeIds, which is its
entire purpose.

Prototyped in `prototype/src/core.js` (Phase 1 typeID recognition
handles the pairing shape, `encodeRecordBytes` takes an optional
`localNamespace` parameter), `prototype/src/header.js`
(`resolveLookupKeyForRecord`), `prototype/src/wrappers.js`
(`resolveStack`'s terminal-Record resolution prefers a local override),
and `prototype/test/record-namespace-pairing.test.js` — round-trip for
the Decentralized namespace form (the only valid one; a uint in the
namespace slot is confirmed to fall through as unrecognized), local-
overrides-ambient and falls-back-to-ambient resolution, the
even-typeId-is-vacuous case, a `resolveStack` case where the
Wrapper-resolved terminal Record carries its own override, and the
byte-cost FINDING above. (A pairing item stacking with a following
NDEF-ID-equivalent text string, §3.1, is covered separately — see
`prototype/test/ndef-id.test.js`; there's no longer a backup-typeID
interaction to test, since that mechanism was retired.)

Cross-validated in `rust/qdef-core`: `parse_record`'s Phase 1 gained the
identical structural recognition rule (a definite-length 2-element array
is a valid prefix-item shape; its second element is pulled in as an
ordinary typeID, its first is exposed raw via the new
`Record::local_namespace()`), with zero namespace-semantic code added to
the crate — matching the container discriminator's own precedent. Tests
confirm the pairing round-trips for both namespace forms and degrades
correctly when a Record carries no pairing item.

## Text string Type IDs — historical: the reserved slot went to the NDEF-ID-equivalent instead

**Superseded.** This entry originally worked out placeholder-grade
caution guidance (definite-length required, exact byte comparison, a
reverse-domain-naming cross-reference) for a then-reserved-for-future
"Named ID" text string Type ID form. That form never shipped, and the
underlying premise it was building caution for — a bare text string
prefix item, positioned where the parser would otherwise treat it as a
kind of Type ID — no longer exists at all: §3.1's redesign retired
decentralized Type IDs entirely (both the byte string and the reserved
text string forms) once a declared namespace turned out to do that job
strictly better, and repurposed the now-freed bare-text-string prefix
position for something with a clearer job: the NDEF-ID-equivalent, a
stable external reference immediately following the typeID-bearing
item, mirroring NDEF's own `ID` field (spec §3.1).

Every one of the three gaps this entry originally closed carried
forward into the NDEF-ID-equivalent's own spec text almost verbatim,
since they're properties of "a bare text string prefix item," not
specific to what it used to mean as a Type ID: definite-length required
(§3.4 already covers this for every encoder-emitted string, not just
this position), exact raw-UTF-8-byte comparison for anyone matching
against it, and no ambiguity about what "reserved" meant, since the slot
is no longer reserved at all — it has exactly one meaning now. See
"Implementer caution for the NDEF-ID-equivalent," spec §3.1.

This entry is kept for the historical trail: the reasoning that "an
unclaimed-but-parseable text string slot accumulates informal, hard-to-
retrofit convention faster than an unclaimed number does" is worth
remembering the next time this project reserves something without
building it.

## The hash-derivation algorithm was never actually pinned — a real bug, not just a documentation gap

**Historical — written while Type Hint (§3.1, then) was still the
mechanism's primary home; it was retired entirely once decentralized
Type IDs were (see "Text string Type IDs," above, and FINDINGS.md).**
Kept for the real bug-fix trail; the algorithm itself is unaffected and
lives on at §3.5, the namespace mechanism being its main surviving
direct user today.

Three separate mechanisms (Type Hint, §3.1 at the time; App Route's
hash-derived form, §4.4; the format namespace, §3.5) all describe an
optional strengthening: derive a decentralized ID from a hash of its own
name, so the binding is independently checkable. The spec text always
wrote this
as `ID = truncate(hash(name), N)` — which sounds precise but isn't: it
never said which hash function, how the string gets encoded, how
truncation/byte-order works, or what `N` actually is. §3.1 called `N`
"an open parameter" outright.

Asked directly whether this had actually been pinned down, the honest
answer was no — and checking the real prototype rather than just the
prose surfaced a live bug matching the gap exactly: `verifyTypeHint`
called `deriveHashId` with no width argument, so it always truncated to
4 bytes regardless of the candidate ID's actual magnitude. A genuinely
wide ID — exactly what §9 recommends and what TagDrop's own existing
Type IDs actually are — could never verify, silently, no matter how it
was derived. "Anyone can independently check" (the whole point of
building this) was false in practice for the width this project's own
real adopter uses.

**Fixed by making `N` a developer choice, outputting a byte string.**
With the prefix typeIDs design (spec §3.1), decentralized IDs are now
CBOR byte strings (major type 2), not uints. The developer chooses `N`
directly — wider means more collision-safe. The derivation algorithm
produces the first `N` bytes of the SHA-256 digest as a definite-length
byte string. SHA-256 over the name's raw UTF-8 bytes (not any CBOR
encoding of the string). No new primitives — SHA-256 is the same "borrow
an already-ubiquitous primitive" instinct behind `group_id` and the
COSE/CoAP registry reuse elsewhere in this spec. The full 32-byte
digest lives in documentation for verification; only the truncated form
appears on the wire.

**A second, related bug caught while fixing the first:** comparing the
derived byte string against the candidate ID needed to use `Buffer.equals()`
rather than `===`, since byte string comparison by reference is unsafe.
Fixed by normalizing both sides through Buffer comparison.

**The namespace mechanism's own hash-check went from claimed to real.**
§3.5 described `namespace = truncate(hash(name), N)` in prose from the
day it landed, with nothing in the prototype actually implementing or
testing it — caught in the same pass. `header.js`'s `verifyNamespaceHint`
was implemented for the first time here, calling `typeHint.js`'s
derivation directly rather than a second implementation of the same
algorithm, so namespace values and Type IDs were checked identically by
construction, not by two conventions that happened to look similar and
could silently drift apart later.

**Postscript, caught much later: `verifyNamespaceHint` itself quietly
disappeared, and nobody noticed for a while.** When Type Hint moved from
the field Map into the prefix (an unrelated redesign pass), `typeHint.js`
was deleted and `verifyNamespaceHint` — which depended on it — went with
it, without a corresponding doc update anywhere. QDEF-SPEC.md and this
file kept citing it as prototyped for weeks of real history, across
several later redesigns, before a routine documentation-consistency
sweep during the record-architecture redesign (this document's own
"Registry governance" and neighboring sections) actually re-checked the
claim against `prototype/src/header.js` and found it false. Restored as
a small, now-standalone function in `header.js` (no `typeHint.js` to
depend on anymore — Type Hint itself is gone, so `deriveHashId` now
lives directly in `header.js`, `N` simply the candidate namespace's own
byte length rather than a magnitude-inferred uint width), with a fresh
regression test set in `prototype/test/header.test.js` covering both
narrow and wide widths, an unverified-Hint case, a no-Hint
not-applicable case, and a real decode-to-verify round trip. Worth
recording as its own small finding: a doc that cites a specific function
name is a checkable claim, not just prose, and drifted silently here for
longer than it should have.

Prototyped in `prototype/test/header.test.js`. See FINDINGS.md #21 for
the original bug, and FINDINGS.md for this restoration.

## Pinning the algorithm only solved half the naming problem — the input still has to be collision-resistant

Fixing the hash-derivation algorithm (above) answered "how do two
implementations compute the same thing." It didn't answer a different,
equally real question, asked directly right after: does the spec tell
anyone how to *choose the name* so two unrelated implementations don't
land on the same thing by accident? It didn't, anywhere.

This isn't a minor omission — it's the difference between hash-
derivation actually delivering the collision-safety it claims and
merely looking like it does. `ID = truncate(SHA-256(name), N)` is only
as collision-resistant as `name` is diverse. Two unrelated projects
independently naming their config record `"config"` derive the *exact
same* ID — not a low-probability birthday-bound collision, a
certain one, because the function is deterministic and "short sensible
English words for a common concept" is a small, heavily-overlapping
space across unrelated authors. A pure random draw doesn't have this
failure mode at all; a bad hash *input* reintroduces it through the
back door of a mechanism that was supposed to remove exactly this kind
of ambiguity.

**The fix is the same one every other namespaced-identifier system
already uses, not a new invention:** qualify the name by something the
namer actually, verifiably controls — reverse-domain notation, the
Java-package/XML-namespace/MIME-subtype convention — rather than a bare
word. This isn't stylistic. A domain two unrelated parties could both
plausibly register is already vanishingly unlikely by DNS's own
allocation guarantees, which is precisely what makes the hash output
behave like an actual random draw again, restoring the birthday-bound
math this project already leans on elsewhere for private-use tiers.

**Scoped correctly, not applied everywhere uniformly:** this only
matters where nothing else already protects the value — a namespace's
own Hint name (§3.5), and a standalone (non-namespaced) private-use-
random Type ID's Hint name. A Record-Type-local Hint name used *inside*
an already-declared namespace doesn't need qualifying at all, since
collision-safety there already comes from the namespace itself, not
from the local name — piling a second layer of protection where one
already exists would just be needless verbosity, not correctness.

Illustrated with real hash output, not just argued in prose:
`prototype/test/type-hint.test.js` proves two unrelated "projects"
naming the same concept `"config"` derive an *identical* ID (the
certain-collision hazard, demonstrated), and that qualifying each by a
domain they actually control resolves it (`"com.example-a/config"` vs
`"com.example-b/config"` — different IDs).

## Container framing choices

### No version byte

An earlier draft had one, gating the interpretation of everything after it
— but that design forces a hard, global "I cannot safely interpret any of
this" failure for *any* future change to the container, however small, since
a decoder has no way to know in advance which changes a version bump will
cover. §3.2's even/odd criticality rule already provides graceful, *local*
forward compatibility for ordinary Record evolution — new Record Types are
skipped, new odd keys are ignored, new even keys abort only the one Record
that has them. The only thing a version byte still gave beyond that was
safety for changes to the container's own outermost framing — and even that
need is now covered without one: see §3.5 (the container discriminator's
map form), which extends exactly the same even/odd tools inward, rather
than needing a separate, cruder all-or-nothing gate around them.

### No record count or total payload size

Suggested more than once as a natural addition to a binary header, and
deliberately left out. Either field would require an encoder to know its
final size before writing the header, and a decoder to trust a value that
duplicates information already recoverable by walking the Sequence, adding a
way for the two to disagree with no benefit: the entire point of a CBOR
*Sequence* over a wrapping array is that a Record's presence is
self-delimiting and a constrained parser can stream through Records one at a
time without ever needing to know the total count up front. A count/size
field would sit unused by that parser and be one more thing a fuzzer or a
malformed input could make lie.

## CBOR tag routing — removed

An earlier draft also wrapped the Record Map in a CBOR semantic Tag matching
the Type ID, as a second, redundant routing path for tag-aware CBOR
libraries. That mechanism has been removed — see "CBOR tag-number
collision" below and FINDINGS.md #11 for why. The prefix-based typeID
mechanism is sufficient on its own.

## Field-value-shape rule — dropped, once what it cost was checked against what it protected

**Historical, then superseded.** §3.2 originally restricted field values
to scalars, definite-length strings, or tags wrapping a definite-length
string directly — determining a field's length ordinarily requires
walking into its structure (an array's or map's true byte length isn't
known until every element inside it has been walked, recursively for
nested structure), which is an unbounded-recursion hazard on a target
with only a few KB of stack. A byte or text string's length, by
contrast, is always stated directly in its own head — skipping one is
pure cursor arithmetic, never a walk. Restricting every field value to
that shape meant a conformant core parser never needed to recurse *at
all* to skip a field it didn't recognize — not "recursion bounded by a
depth guard," but no recursion, structurally.

**Dropped entirely, once what that guarantee actually cost turned out to
matter more than what it protected.** The restriction forced a real
indirection tax on any Record Type that ever wanted natural nested
structure — pre-encode it separately, carry it as an opaque byte string,
decode it again by hand. Raised directly: is "no recursion at all, not
even bounded" a property most real decoders actually need, or one the
format's own physical medium (a QR code tops out around 800 bytes at
practical error-correction levels) already limits well enough on its
own? Checked, not assumed: the answer was the latter.

**What made the relaxation safe to do at zero new risk, not just cheap
to do.** `skip_any_item` — the function that already walked prefix items
(namespace-pairing arrays, tag-wrapped content) — never used true
recursion to begin with; it already used a bounded explicit stack
(`MAX_DEPTH`, an implementation choice, not a wire-format requirement).
The stricter, definite-length-string-only `skip_value` function used for
field values specifically was a separate, narrower function living
alongside it. Merging field-value skipping into `skip_any_item` didn't
reopen the "constrained embedded scanner" property this project cares
about — it just meant field values now go through the same bounded-stack
mechanism prefix items already trusted. The one genuinely new capability
needed was skipping indefinite-length (chunked) strings, which
`skip_any_item` gained via an inline chunk-reading loop (`rust/qdef-core`
's `cbor::Error::MalformedIndefiniteString` catches a malformed chunk
sequence — mismatched major type or a nested-indefinite chunk — rather
than walking it).

**Depth cap: advisory guidance, not a wire-format requirement.** No hard
spec-level cap on nesting depth or indefinite-length usage — an
implementer's note warns against excessive nesting and suggests a
practical bound, but doesn't mandate one; a decoder MAY enforce its own
limit as an implementation choice (`rust/qdef-core` keeps its existing
`MAX_DEPTH: usize = 16`, documented as this decoder's own practical
safety choice, not something the spec requires). The physical medium's
own small size is what actually bounds real-world complexity here, the
same reasoning that justified dropping the shape restriction in the
first place.

Prototyped in `rust/qdef-core/src/cbor.rs` (`skip_value` removed,
merged into `skip_any_item`) and `prototype/test/nested-field-values.test.js`
(bare array/map field values, multi-level nesting, criticality unaffected
by value shape for both even and odd keys). See docs/FINDINGS.md.

## Wrapper Records — why a wrapper, not a reserved key range

Wrapping avoids a cross-record correctness hazard a sibling/key-range
approach doesn't. If spanning info were just extra keys inside, say, a
"Photo Fragment" Record Type, a parser that recognizes that Type but not the
spanning convention would happily treat one fragment as if it were the whole
photo. A Wrapper Record can't be misread that way: its payload is opaque
bytes, not a valid inner Record, so a parser that doesn't implement Type 2
just skips the entire record like any other unrecognized Type ID — it never
sees anything to misinterpret.

## Why not build compression or splitting into the container

Both stay entirely inside each Record Type's own payload definition. Why not
build them into the container:

- *Compression:* §3.1's prefix-based routing only works if a bare-metal
  scanner can read the typeID prefix at zero decode cost to decide whether a
  record concerns it. If the CBOR Sequence itself were compressed, that
  scanner would need a DEFLATE implementation just to *skip* a record it
  doesn't recognize — directly against the point of routing at all (§3.1).
  Keeping compression a per-Record-Type concern means a parser that doesn't
  recognize a given Type never touches a compressed byte it didn't ask for.
- *Splitting:* QDEF is deliberately scoped to one physical code's records
  (§2). Reassembling a payload spread across multiple codes (ordering,
  missing/duplicate parts, parity, content-addressing) is a much harder
  problem than routing. An application that already has its own proven answer
  to that problem should keep using it rather than adopt a second,
  possibly-disagreeing addressing scheme at the QDEF layer.

The same reasoning applies to signing: an application with its own proven
authentication mechanism (e.g. a single hash-then-sign step over the fully
reassembled payload) needs no QDEF Sign primitive for that content either,
for the identical reason — it already solved this, adopting a second,
QDEF-native mechanism would just be a second thing that could disagree with
the first.

## A confession (Parkinson's Law of Triviality, self-reported)

C. Northcote Parkinson's original example: a committee approves a
multi-million-pound nuclear reactor in about two minutes, then spends
forty-five debating the design of the bike shed. This repo is not immune.
Removing the entire CBOR-tag routing mechanism — a genuine architectural
reversal, half the core's routing model gone — took exactly one finding
(FINDINGS.md #11) and one commit. Deciding whether a single reserved map
key's decentralized-ID hint belonged on the old key `1` or key `3` took a
multi-message negotiation, a rejected alternative design, and its own
section above. Draw your own conclusions about which of those two
decisions actually mattered more, and which one got more words spent on
it in this very document.
