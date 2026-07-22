# QDEF — Design Rationale, Rejected Alternatives, and Open Questions

**Non-normative.** [`QDEF-SPEC.md`](QDEF-SPEC.md) defines the wire format;
this document explains why it looks the way it does — mechanisms that were
tried and removed, alternatives weighed and rejected, and questions this
draft hasn't resolved yet. Nothing here is required reading to implement a
conformant parser; it exists for reviewers, future contributors, and
anyone deciding how to resolve what's still open. See
[`FINDINGS.md`](FINDINGS.md) for the empirical, prototype-driven
discoveries that prompted many of these decisions.

**If this document and `QDEF-SPEC.md` ever disagree, `QDEF-SPEC.md` is
correct.** This is a chronological trail, not a maintained snapshot —
entries describe the mechanism *as it was when written*, and a later
entry can supersede an earlier one without the earlier one being
rewritten (only marked, when someone happens to notice). A section
reached by searching rather than reading start to finish may describe
something already replaced. Check for a **Superseded** note at the top
of a section before treating its wire-shape details as current, and
when in doubt, verify directly against `QDEF-SPEC.md` rather than
against prose here — that includes for an LLM agent proposing a change
against this repo: treat this file as historical context, never as a
source of truth for the current wire format.

## Registry governance — allocation shape proposed, authority still open

Who allocates application-specific Record Type IDs (`100`+) is still
open — no registry authority exists yet, and IDs in the spec remain
illustrative placeholders. The *shape* of the range has an answer
though: tier it the way CBOR's own tag registry (RFC 8949 §9.2) tiers
tag numbers — a small reviewed span, then a private-use span, no third
ungoverned middle tier. QDEF doesn't use CBOR tags itself (see "CBOR
tag-number collision" below), but the governance *pattern* is worth
borrowing on its own merits. Two options were weighed:

- **Tiered ranges (recommended):** three tiers, not two, each with a
  different reason to exist:
  - `1`–`99`: mechanism/plumbing (already spec'd, §4) — Wrapper Records
    and other standard record type infrastructure, not application content.
  - `100`–`32767`: **common vocabulary** — reviewed, widely-recognized
    content types (Wi-Fi, a URL/URI record — NDEF's "Well Known Type"
    equivalent). Ceiling aligned with IANA's CBOR tag registry boundary
    between "Specification Required" and "First Come First Served"; see
    "Namespace-scoped Type IDs," below.
  - `32768`+: **First Come First Served — self-allocate freely, recorded
    once a registry authority exists, never reviewed.** A real, distinct
    governance model, not "no governance" — the term is IANA's own: an
    allocation authority still tracks every assignment once recorded, it
    just never gates who requests one. Self-allocation is immediate and
    free; recording (no authority exists yet, see below) is what
    prevents a collision, not the numeric width. See "Governed vs.
    ungoverned," below, for why this tier would be pointless if it meant
    permanently untracked — a strictly worse decentralized byte string
    ID (smaller ID space, same "nobody's tracking it" property).
  Exact boundaries are a policy decision for whoever runs the registry,
  not a wire-format one.
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
  registered but with no review gate) was considered and dropped** — a
  different mechanism from the `32768`+ tier above despite the shared
  name. It predates the even/odd parity redesign, meant to give a cheap
  small number before namespace-scoping was a distinct wire-format
  concept. Dropped once namespace-scoped Type IDs (§3.5) made it
  redundant: collision-avoidance only ever comes from registry curation,
  registry recording, or a declared namespace, and this tier tried to be
  cheap and uncoordinated without picking any of the three. Anyone
  wanting a cheap ID with zero upfront coordination can declare their
  own namespace and use small sequential odd uints inside it instead.
- **Even/odd for governance tier — adopted.** Even uint = always-global
  standard record type, odd uint = namespace-scoped, reusing the same
  even/odd vocabulary already load-bearing for map key criticality
  (spec §3.2) on a different axis; the two never overlap. The split
  only costs half of the *global* uint space, not the ecosystem's total
  addressable IDs — every declared namespace (§3.5) gets its own
  independent range of odd uints. See spec §3.1.

### Governed vs. ungoverned, made explicit

TagDrop asked directly, after self-allocating four `32768`+ even Type
IDs under §2/§3.5's own-URI-scheme-isolation guidance: does that tier
eventually get a registry, or stay permanently uncoordinated? Answered
with a table, since an earlier version of this section conflated two
different axes (CBOR major type vs. numeric range) under one heading.

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

**Why Type ID `0` is assigned to the Bundle record type** rather than
sitting unassigned. An earlier design used `0` for an optional leading
container-level header Record; a decoder couldn't structurally tell
"header present" from "header absent, this is Record 1's own prefix
typeID `0`" (FINDINGS.md #26), which is why the container discriminator
(spec §3.5) exists instead — mandatory, positionally fixed, dispatched
by CBOR major type rather than by being typeID-prefixed at all. That
fix meant `0` carried no live ambiguity risk and could be assigned to
an ordinary standard Record Type. The Bundle record (§4.6) fills this
slot: a structural grouping record with no map data of its own, whose
subrecords are the bundled content. An empty map is implicit and
typically omitted (`[0, [Rec1][Rec2]]`). Future container-level (not
per-Record) metadata has its own growth point already — the
discriminator's extensible map form — so `0` isn't earmarked for that.

**Built without a concrete adopter asking for it — worth flagging
against this project's own stated discipline** (see the Sign entry
below, held back explicitly for lack of one). The distinction that
makes this a reasonable exception rather than a lapse: Bundle's
marginal cost was close to zero — no new grammar, no new parsing logic
in either prototype, just an assigned number plus subrecords and
namespace-pairing composing the way they already did. Sign would need
real, hard-to-reverse choices (a signature algorithm, a coverage
encoding) that a real adopter's constraints should inform; Bundle
needed none. "Wait for a real need" scales with what there is to get
wrong, not applied as a blanket rule regardless of cost.

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
latter, it would be strictly dominated by declaring a namespace (§3.5)
and using a cheap odd uint inside it: same "nobody reviews it" property,
but collision safety from the namespace rather than luck, and a
1-byte-forever cost instead of a global uint the whole ecosystem draws
from. Same reasoning that killed the older first-come tier above: cheap
and uncoordinated without picking one of the three real collision-safety
sources never has a viable governance model. The `32768`+ tier only
earns its place because it *will* get tracked, just not reviewed.

**Nothing is registered today, for any tier.** TagDrop's four
self-allocated values are exactly as safe today as they'll ever need to
be — their own `tagdrop:` scheme already isolates them from every other
QDEF-aware decoder (§2/§3.5), so no external collision is possible
regardless of registry timing. Submitting already-in-use values once a
registry exists is good practice, not urgent.

**Historical: structured composition within the decentralized byte
string Type ID space** — the use case behind [GitHub issue
#10](https://github.com/mofosyne/qdef/issues/10), resolved a different
way. The issue asked how to structure a decentralized byte string ID
for several related Record Types (a fixed prefix plus a self-assigned
suffix), and the guidance that used to live here worked out the
prefix/suffix birthday-bound math (a 56-bit prefix gives 56-bit-class
safety once suffix clustering is accounted for; 32-bit is unsafe at any
serious scale). None of that's needed anymore: decentralized byte
string Type IDs were retired entirely (§3.1), and the problem — several
related Record Types under one implementer, no per-Type coordination —
is exactly what a namespace (§3.5) with sequential odd uints already
does, cheaper and with no prefix-width sizing decision to get wrong.

The one caution from this thread that's still live, restated in current
terms: if a namespace value's own prefix bytes start getting treated as
an *implicit* cross-implementer routing signal — "anything sharing my
namespace prefix is safe to auto-launch for" — that's quietly
reinventing App Route (§4.4) without App Route's domain-verified trust
model behind it. Use App Route explicitly when routing is the actual
goal; don't let a namespace-prefix convention become an accidental
second routing channel nobody decided to build.

## Namespace IDs are always Decentralized — the Allocated (uint) namespace tier was dropped

Raised directly: does QDEF's namespace layer need the same
governed/ungoverned choice §3.1 gives Record Type IDs, or was that
duplication carried over without checking whether it earns its keep one
level up? TagDrop, the project's one real adopter, already treats its
namespace as always decentralized. A namespace is also architecturally
different from a Type ID — it's the *global root of trust* for
everything scoped inside it (two colliding namespaces collide every
Type ID scoped to each), and it ends up baked into physical,
already-printed media with no way to fix a bad choice retroactively —
so the Allocated (uint) namespace tier was dropped entirely. A
namespace value is now always a byte string.

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

**Byte-length policy, worked out from the actual collision math.** The
naive read ("`2^24` is 16.7 million possibilities, plenty") is wrong for
self-allocated IDs with no coordination — the safe *population* a width
supports is governed by `√N`, not `N`:

```
bytes | keyspace (N) | wire cost | namespaces for 1% risk | for 1-in-a-million
------|---------------|-----------|-------------------------|--------------------
  3   | 16.7M         | 4 bytes   | 579                     | 6
  4   | 4.3B          | 5 bytes   | 9,268                   | 93
  5   | 1.1T          | 6 bytes   | 148,291                 | 1,483
  8   | 18.4Qi        | 9 bytes   | 607M                    | 6.07M
```

3 bytes reaches ~3% collision risk at just 1,000 independent picks, and
is essentially guaranteed to collide by 10,000 — not hypothetical for
an open format. **Resolution: self-certify freely at 4 bytes or
longer; shorter is reserved, not self-allocatable** — safe only with
uniqueness guaranteed by direct coordination, and there is no formal
registry process for that today, deliberately (see "Standard library
governance," above). A sub-4-byte namespace is something to ask for
directly if the need is ever real, not infrastructure worth
pre-building.

**A hybrid was considered and rejected: registry-*curated* allocation
for the 1–3 byte range, self-certification above it.** A registry that
reviews before granting sidesteps the birthday bound entirely (the
*full* keyspace, not `√N`), so a curated 1–3-byte tier could genuinely
serve the rare ultra-compact case. Rejected anyway, for the same reason
the Allocated namespace tier itself was dropped: it reintroduces the
governed/ungoverned split this whole pass was cutting, for a
self-admittedly niche need, requiring an actual operating authority —
the same "don't build registry infrastructure ahead of real demand"
discipline applied everywhere else in this project.

**Why the 4-byte floor doesn't bend toward a smaller, more "honest"
population estimate.** QDEF is niche; the real long-run namespace count
might be closer to 10–20 than 1,000+. Shouldn't move the floor though:
over-provisioning costs a few extra bytes, once, forever negligible.
Under-provisioning is unfixable once baked into printed media. Sizing
for a plausible-upside scenario is the only choice that doesn't risk
being caught out by the format's own success. (One resolved
sub-question: does a namespace minted short and early become
retroactively unsafe once later adopters pick longer
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
registry (RFC 8949 §9.2). QDEF needs one more field than that lean
four-field original, because a single logical Record Type can have two
independent identifiers: a global Record Type ID (a plain even uint,
§3.1 — no namespace needed) and a Scoped Type ID (cheap, only means
anything paired with a declared namespace, §3.5). Nothing connects them
by formula — a scoped ID is freshly chosen, not derived from the global
one — so an entry recording only one form wouldn't let a reader who
encounters the *other* form recognize it as the same thing.

**Note: this template predates the retirement of decentralized Type
IDs** (§3.1) — a Record Type ID is now always a plain uint, never a
hex byte string. A namespace value is still a hash-derivable byte
string (§3.5); that's the only ID/Name pair in this template that still
uses hash-derivation.

### Template

```
Record Type ID:             <even uint, or "none — namespace-only">
Record Type Name:           <reverse-domain name, e.g. com.example.tagdrop/route
                              -- documentation only, not hash-derived>
Variable Name:              <space-separated words, e.g. "Tag Drop Route">

Namespace ID:               <hex byte string, or "none — global-only">
Namespace Name:             <reverse-domain name, or "none — global-only"
                              -- MAY be hash-derived from the Namespace ID>
Variable Name:              <space-separated words, e.g. "Tag Drop">

Scoped Type ID:             <odd uint, or "none — global-only">

Data item:                  <CBOR shape description — e.g. "map { 0: bytes, 2: uint }">
Semantics:                  <one-line functional description>
Point of contact:           <email or URL>
Reference:                  <link to spec/README defining this Type>
```

**Variable Name** is a space-separated word sequence for generating
identifiers in any language — snake_case, CamelCase, UPPER_CASE, etc.

Every ID/Name field is optional — a Type used only namespace-scoped has
no Record Type ID row, and vice versa. This documents whichever forms
actually exist for a given logical Type, not requiring both.

### Worked hypothetical example

A project called "TagDrop" defines a `route` Record Type. It uses both
a global even Record Type ID (for standalone codes) and a Scoped Type
ID (for codes within TagDrop's own namespace):

```
Record Type ID:             105
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

The same logical Type, two independent identifiers, both documented so
a reader who encounters either form on the wire can recover the other.

### Why not just mirror CBOR's four-field shape?

A CBOR tag number is always the whole identity — no compound-key
relationship to another field the way `(Namespace ID, Scoped Type ID)`
works here. QDEF needs two identity pairs plus the Scoped Type ID,
because the compound key `(N, T)` is the real lookup key once a
namespace is declared, and documenting only `T` without `N` leaves the
entry incomplete for a reader who encounters the scoped form.

## CBOR tag-number collision (resolved — the tag route was removed)

An earlier draft wrapped every Record Map in a CBOR semantic tag equal to
its Type ID (the "Smart Route"), alongside the mandatory key `0` on the
map. Found broken on two independent grounds, not one:

- **Empirical.** CBOR tag numbers are a shared IANA registry (RFC 8949
   §3.4), and the low numbers QDEF's standard record types picked are already assigned:
  tag `2`/`3` are bignums, tag `4` is a decimal fraction, tag `5` is a
  bigfloat — exactly Types 2 (Split), 3 (Compress), 4 (Encrypt), 5
  (Open/Hint URI). Type `100` (Wi-Fi) collides with RFC 8943's
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
shape rule's tag exception to tag `24` specifically, out of caution — the
one case already known to be skip-safe with a real, non-QDEF-specific
meaning. Revisited: what does the rest of the IANA CBOR tag registry
(tags under ~1000) actually look like, content-shape-wise?

Checked directly against the registry: tags split into genuinely
scalar/string-shaped ones (dates, URIs, UUIDs, regex, bignums, base64/
base16 hints) and genuinely array/map-shaped ones by definition
(decimal fractions, bigfloats, rational numbers, language-tagged
strings, COSE structures, the "expected conversion" hints `21`–`23`,
confirmed to apply recursively). The *content-shape check* (definite-
length string, directly, never another tag) is what makes a tag
skip-safe, regardless of which tag number is on the wire — restricting
to `24` alone was stricter than the actual safety property required.

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
that, a reserved-for-future "Named ID" typeID form) later became the
payload slot (spec §3.1) — one unambiguous meaning for a position that
used to be split between two retired purposes.

## Media Payload (Type 6): why it never reused the (now-retired) decentralized-ID + Hint pattern

The first draft of spec §4.3 copied Type Hint's decentralized-ID + Hint
+ opportunistic-hash-verify pattern (as it existed in §3.1 at the time)
onto Media Type wholesale. That was a mistake worth recording: it
reapplied a pattern without checking whether the problem it solves was
even present at this layer. (Type Hint was later retired entirely, but
the reasoning below for why Media Type never needed it still holds, and
is the general argument for *when* a hash-derivation Hint earns its
cost, since namespace IDs, §3.5, still use this pattern today.)

**Type ID and Media Type were never the same shape of problem.** A
decentralized Type ID had *no* identity besides the bytes — that's why
a Hint had to exist (to attach a name) and a hash check had to exist
(to prove the name wasn't tampered with). A media type isn't like that:
`"text/vcard"` is already a stable, globally meaningful string, defined
by RFC 6838's Media Types registry, independent of whether CoAP ever
assigned it a compact number. So when a media type isn't in CoAP's
table, there's no opacity to resolve — the plain string already is the
recoverable name. Settled on the simpler two-form design: a CoAP uint
when registered, the plain MIME string otherwise.

Does CoAP itself have a private-use/decentralized tier? No — its tiers
are Expert Review, IETF Review, First-Come-First-Served, and a small
Experimental range barred from real use, never a "pick a large random
number" escape hatch — partly because Content-Format is only a 16-bit
field (too few numbers for uncoordinated self-assignment to be
collision-safe), but mainly because media types already have external,
stable names outside CoAP's registry.

**Relying on CoAP's registry at all is a conditional choice, not a
default** — justified because that registry has good prospects of
staying maintained (IANA-run, IETF-governed, updated as recently as
2025). Spec §4.3 asks adopters to keep a periodic mirror of the table
regardless, so QDEF's ecosystem isn't stranded if that changes.

## Standard library governance

Related but narrower (spec §4): who maintains the reserved `1`–`99` range
itself — additions like §4.1/§4.2/§4.3 need some process for becoming
part of "the standard record types" rather than just another vendor's Record Type
squatting on a low number.

**This is where a QDEF registry's effort is actually best spent — not
on allocating namespace or application-specific Type IDs.** Namespace
IDs are always self-certifying now (no Allocated tier) and application
Type IDs inside a declared namespace are the namespace operator's own
numbering — neither needs a central authority. What genuinely benefits
from shared, reviewed curation is growing §4's common vocabulary itself
(new standard record types any conformant decoder can recognize) so
unrelated apps get more structure they don't have to invent, rather
than a registry that just encourages every app to mint its own bespoke
namespace instead of reaching for what's already standard.

## Magic-header overhead for QR

5 bytes fixed cost matters for a single-record payload in a
size-constrained QR version. A real data point (`mofosyne/tagdrop`'s
SPEC.md): TagDrop's native envelope costs 2 bytes total (`version`+
`type`, small CBOR uints), against roughly 10–15 bytes for QDEF's
magic+discriminator+map-framing overhead on the same small payload — a
large proportional cost for TagDrop's smallest codes (under 50 bytes
total). Doesn't change the conclusion elsewhere that QDEF wrapping
stays strictly opt-in, never the default framing (spec §6, §7).

## Relationship to existing standards

NDEF already solves "multiple typed records, one message" for NFC
(spec §2's `application/vnd.qdef` MIME framing leans on this directly).
This draft's net-new contribution is narrower than it first appears: a
magic-header-plus-CBOR-Sequence convention for the optical/QR case, plus
the even/odd criticality rule, which NDEF doesn't have (only per-record
TNF/Type, no per-key criticality signal). The closest shipped analog
for the QR case is [BBQr](https://bbqr.org/BBQr.html) (magic header +
single-char file-type byte + QR-series splitting, for Bitcoin
PSBTs/transactions) — but it identifies one file type per entire QR
series, not multiple heterogeneous Records within one payload, has no
per-field criticality signal, and encodes alphanumeric rather than
native byte-mode. QDEF's multi-Record model and even/odd rule are real
deltas against it. The general "magic bytes + sequence of
self-describing typed records" pattern is well-proven elsewhere (e.g.
[MCAP](https://mcap.dev/spec) for robotics data logs) — QDEF applies it
to the constrained-optical-scanner case, not inventing the pattern.
`mofosyne/tagdrop` issue [#16](https://github.com/mofosyne/tagdrop/issues/16)
(2016) proposed an NDEF-like binary header for QR codes a decade before
this draft existed; QDEF is the first attempt to build it out.

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
| URI RTD                 | Compact URI encoding      | Covered -- Open/Hint URI (§4.2) handles both  |
|                          |                            | roles identically: a lone primary URI record, |
|                          |                            | or an accompanying fallback alongside other   |
|                          |                            | Records. No separate "primary URI" type needed|
| Smart Poster RTD        | URI + Text + action code  | Closed -- Open/Hint URI gained language (key  |
|                          |                            | 3) and action (key 5) fields, below           |
| Signature RTD           | Cryptographic signing     | Known gap, already tracked -- QDEF's own Sign |
|                          |                            | wrapper, decided but unbuilt (see below)      |
| Device Information RTD  | Device model/identity     | Out of scope -- device pairing, not content   |
|                          |                            | distribution                                  |
| Multiple URI RTD        | List of URIs, one record  | Not needed -- repeated Open/Hint URI siblings |
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
additive.** Open/Hint URI gained two new odd/optional fields — `3`
(BCP 47 language tag for the label) and `5` (action code: `0` = perform
the action, `1` = save for later, `2` = open for editing, borrowed
directly from Smart Poster's own three values rather than inventing a
new enum). Both are odd/optional specifically so a decoder that doesn't
recognize either still gets a fully working URI and label — the
graceful-degrade guarantee Open/Hint URI already made for its original
two fields, now extended rather than compromised. Multiple languages or
multiple URIs need no new mechanism at all: QDEF already allows any
number of same-Type sibling Records in one Sequence, so repeating
Open/Hint URI once per language/URI variant reproduces Smart Poster's
multi-title behavior and Multiple URI RTD's list behavior for free.

**Deliberately not adopted: NDEF URI RTD's compact prefix-code trick** (a
1-byte code standing in for a common URI scheme prefix like
`"http://www."`), even though QDEF readily borrows external tables
elsewhere when the byte savings are real (CoAP Content-Formats, COSE
Algorithm IDs). Representing `[prefix code, remainder]` as a 2-element
array field value is legal now (§3.2 permits any field-value shape),
but it would silently change the field's type out from under any
decoder that already expects a plain URI string there — the same
graceful-degrade break the remaining option (splitting the URI field
into a separate prefix-code field plus remainder) causes on purpose: a
decoder recognizing Open/Hint URI's Type but not that specific field
split would see a broken, prefix-less string instead of a working URI.
That undermines the one property Open/Hint URI exists to guarantee —
any decoder recognizing the Type gets a complete, usable URI. A few
bytes saved on an already-short field isn't worth trading that away.

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
covers this — was checked and is wrong. A per-Type map key is owned by
that Type's author. An NDEF-`ID` equivalent needs to be
*type-independent*: any Record gets one, and no Record Type's own key
numbering can collide with or redefine it — the same architectural
layer as the typeID prefix items and the namespace-pairing item (§3.1),
parsed by the mandatory core before any Type-specific interpretation.

**Resolved later, by neither of the two options explored below** — see
the wrap-up at the end. The two prototypes here predate that resolution
and are kept as the feasibility-checking trail, including a genuine
cross-implementation bug they surfaced.

Two structurally sound, mutually exclusive shapes were prototyped
(`prototype/src/core.js`, both test files since deleted as dead code).
**Neither was adopted or spec-documented** — feasibility-checking only.

**Option A: a 1-element array prefix item, `[externalId]`.** Sits next
to the existing typeID and namespace-pairing prefix items, disambiguated
purely by array length — no CBOR tag, so no tag-number-collision risk.
Visible in Phase 1, before the field map is even reached.

**Option B: a reserved negative integer map key, `-1`.** CBOR permits
negative-integer map keys, and the spec never restricted map keys to
non-negative uints. Reuses even/odd criticality for free: parity is
well-defined on negative numbers, so an unrecognized negative key can be
checked exactly like a positive one — enforced by the mandatory core
against every Record, never deferred to Type-level criticality. Cost:
only visible once the map is parsed, one phase later than a prefix item.

**Byte cost is a wash, checked directly.** A CBOR map or array header
only grows past one byte once element count crosses 23, and going from
1 to 2 entries never does — both forms cost exactly one byte of framing
plus the string itself. Whatever these options are chosen between on,
it isn't wire size.

**A real, unrelated bug surfaced here: the two prototypes disagreed on
negative map keys even before either option existed.** The Node
prototype silently accepted a negative integer as an ordinary map key
(JS's `%` preserves sign). The Rust core's hand-rolled `read_key` had no
match arm for CBOR major type 1 and hard-errored — and since the
`Records` iterator treats any `parse_record` error as unrecoverable, a
single negative map key anywhere silently killed decoding of every
*subsequent* Record too. Fixed by adding `cbor::Key::NegInt`;
`check_criticality` now explicitly skips it, matching byte/text-string
keys. This fix was needed regardless of whether Option B ever shipped —
a real cross-implementation disagreement on legal CBOR, not a
consequence of either experimental design.

**Does reserving negative keys for core metadata justify closing the
Record's prefix-item shape set for good?** For per-Record prefix-item
shapes (Phase 1, §3.1) — yes: every prefix mechanism added so far has
meant teaching Phase 1 a new array-length-disambiguated shape, a
growing list with long-run collision risk between future mechanisms
(the same concern already raised for CBOR tag numbers). If future
mandatory-core, per-Record metadata lives in reserved negative map keys
instead, Phase 1's shape set stays closed: bare typeID, namespace-pairing
array, done — the map, already opaque to Phase 1 either way, absorbs
the growth. For the container discriminator (§3.5) — no: it's a
once-per-container item, not a once-per-Record map, and several of its
shapes aren't maps at all; reserving negative Record-map keys says
nothing about whether the discriminator's own shape set is closed.

So the idea holds, but only for the layer it actually touches — an
argument for Option B over Option A if QDEF ever adopted an NDEF-`ID`
equivalent, not because of wire cost, but because it keeps Phase 1's
parsing surface from growing indefinitely.

**Resolution, much later: a third option, made possible by an unrelated
change, adopted instead of either A or B.** Once decentralized Type IDs
were retired (§3.1) and Type Hint went with them, the bare-text-string
prefix position that used to be split between two other retired
purposes — a reserved-for-future "Named ID" typeID form, and Type
Hint's own verification string — was sitting unclaimed, already
structurally reserved, already at the correct architectural layer (Phase
1, parsed by the mandatory core before any Type-specific interpretation,
exactly the property this whole entry was checking for). A bare CBOR
text or byte string immediately following the typeID-bearing item (or
the field Map) became the payload slot: no new prefix-item shape for
Phase 1 to learn (it's dispatched by CBOR major type like everything
else in the prefix), no reserved negative map key needed, and — the
deciding property neither Option A nor B could claim — literally zero
design cost, since the slot already existed and had already been paid
for structurally by two now-retired mechanisms, plus the NDEF-ID that
occupied it briefly before payload replaced it. See spec §3.1.

This doesn't retroactively validate or invalidate the Option A/B
tradeoff analysis above — that reasoning is still correct for what it
was actually deciding between, it just turned out a fourth possibility
existed that neither was checked against, because the prefix-item slot
it reuses didn't become available until a much later, unrelated
redesign freed it.

**Correction, later still: the "Resolution" above conflated two
different problems, and only actually solved one of them.** Re-read
against what NDEF's `ID` field is actually *for* (line one of this
section: "letting *external* systems reference a specific record's
payload by a stable, type-independent identity") rather than against
the payload slot's own eventual justification: the payload slot answers
"where does a Record's own bulk content live" — a real, separate
question, worth solving on its own merits, but not the same question.
Giving a Record a stable, cross-reference identity that survives
independent of container structure — the actual NDEF-`ID` job — was
never delivered by the payload slot at all. (The identity/correlation
problem QDEF *did* independently solve in the meantime is a narrower
one: subrecords, §3.1, let a Media Preview find its own Media Payload
by nesting, replacing TagDrop's positional proposal — see "Embedded
Records" below. That's intra-container structural correlation between a
parent and its own children, not a portable identity any Record can
carry on its own.) Surfaced by a user question connecting this gap
directly to the Common Field Key tier's `-1` (§3.6, added once the
JS/Rust negative-key criticality divergence noted above was actually
fixed rather than just documented) — `ID` there is, at last, the literal
NDEF-`ID` equivalent this section originally set out to find: Type-
independent, parsed the same way regardless of what Record carries it,
costing nothing when absent, degrading safely (odd/optional) when
unrecognized. See that section for why it landed as a *reserved*
negative key after all, once negative-key criticality could actually be
trusted to work identically in both shipped decoders.

## Embedded Records (§3.1's `ID[]{}` shape) — resolved, replacing a TagDrop proposal that relied on Record position

**Superseded.** `ID[]{}` — a single optional array positioned before a
Record's mandatory field Map — was replaced shortly after by making
*every* Record its own self-delimited CBOR array, with subrecords as
ordinary trailing elements needing no dedicated array slot at all (see
"Every Record became a self-delimited array" below). The problem this
entry solves (TagDrop's positional Preview/Body correlation) and the
reasoning behind rejecting positional correlation are still exactly
right; only the specific wire shape changed. Kept for the real trail.

TagDrop proposed a Media Preview standard record type (identification:
media type, content hash, filename) as a plain sibling Record, correlated
with its Body (a Media Payload or a Split fragment) **positionally**:
"the first Record in the Sequence is always the Preview, the second is
always the Body."

**Positional correlation doesn't survive two things already true of
QDEF.** First, §3.2's abort is per-Record, not per-container: an
unrecognized critical Preview drops out of the Sequence, and the real
Body — previously "index 1" — is now sitting at "index 0," with no
coherent way to say what "index 0 means Preview" should do once the
thing that used to occupy index 0 is gone. Every other QDEF correlation
mechanism (`group_id`, namespace pairing, payload) survives partial loss
because none of them depend on index. Second, Open/Hint URI (§4.2) is
already a real, shipped plain sibling Record with no position
requirement — an encoder emitting it before the content Records (a
reasonable choice) silently breaks "Record 0 is Preview," and TagDrop
already uses Open/Hint URI today, so this isn't hypothetical. Both
failures are the same shape as FINDINGS.md #26's retired optional
Type-`0` header: implicit meaning inferred from position, invisible on
the happy path, discoverable only by tracing a failure.

**The common case needs nothing new.** One content item per container —
Preview and Body/fragment as ordinary plain siblings, each dispatched by
its own Type ID, any order — already fixes both problems at zero extra
bytes, the same way Open/Hint URI already coexists with anything else.
The only case plain sibling dispatch can't resolve is more than one
content item sharing a container (two files multiplexed into one NFC
payload, two Split groups sharing a code): nothing then disambiguates
which Preview belongs to which Body. That's the one place explicit
grouping is structurally required.

**Resolved as a new optional Phase-1 item, not a new Wrapper Type ID.**
A definite-length array positioned between the typeID/map/payload prefix
items and the mandatory field Map, whose elements parse with the *same*
Record grammar already defined for the top-level Sequence — recursion,
not a second grammar. This was checked against, and preferred over,
generalizing Wrapper Records (§4.1) into a "Bundle" holding a nested
CBOR Sequence inside an opaque byte string: the array form needs no
Type ID allocation, no byte-string re-parse pass, and stays fully
legible to a generic CBOR viewer at any nesting depth, where the
byte-string form is opaque until a QDEF-aware tool re-decodes it.

**Why the field Map stays mandatory, even when an embedded-Records array
precedes it.** The alternative considered — letting the array itself
optionally *replace* the Map, terminating the Record with no Map at all
— was rejected because it makes a Record's terminator shape
state-dependent: a schema-blind tool wanting only the simplest possible
rule for finding Record boundaries ("a Record always ends at a Map")
would need the full Phase-1 state machine to avoid misreading one
terminator shape as the other. Keeping the Map unconditional preserves
that invariant at a cost of one byte (`0xA0`) on a Record with nothing
else to say — the same trade the mandatory container discriminator
already made once, for the same reason (replacing the optional Type-`0`
header, FINDINGS.md #26).

**Why this is safe to add: it doesn't collide with anything already
legal.** `typeID, [array]` with no Map yet was already malformed under
the pre-existing grammar — a bare typeID has always required its own Map
before anything else could start — so this claims previously-invalid
byte patterns, not currently-valid ones.

**Rejected: an array appearing *after* the Map (`ID{}[]`).** Once a
Record's Map closes, Phase 1 resets and expects the next Record's typeID
or namespace-pairing array — an array right there is already how a
namespace-paired Record legitimately starts today. `Map, then array` is
not an ambiguous pattern needing a tiebreaker; it already has a shipped
meaning, and a second meaning for the same bytes would either silently
reinterpret real containers or need its own marker — strictly worse than
putting the array before the Map instead.

**Rejected: a reserved negative map key signaling "this field is an
embedded-Records array."** Two variants were considered: one fixed key
(bakes in one parity, hence one fixed criticality, and collapses
multiple embedded roles into one undifferentiated bag) and any negative
key (more flexible, but claims the entire negative-key space for a
per-Type convenience). Both were dropped in favor of recognizing the
shape structurally instead — the negative-key space stays reserved for
genuine mandatory-core, type-independent metadata (FINDINGS.md #33's
`extract_core_metadata` groundwork), not repurposed as a general
per-Type "I have embedded content" flag.

**Rejected: reserving key `0` as a Record's own typeID**, i.e. a
self-contained `{0: typeId, ...}` Record with no separate prefix item at
all. Every shipped standard record type already uses key `0` as an
ordinary CRITICAL data field (Split's `group_id`, Compress's deflate
bytes, Encrypt's nonce, Open/Hint URI's URI) — reserving it for typeID
would break all four, or force each to carry two different
field-numbering schemes depending on whether it's top-level or embedded.

**Rejected: an anonymous Record with no typeID at all** (`[]{}` or bare
`{}`). A different kind of cut than the others — it removes the typeID
itself, not just its framing, taking three load-bearing things with it
simultaneously: routing (§3.1's dispatch has nothing to look up),
criticality (even/odd lives entirely on the typeID; an anonymous Record
can't tell an unaware decoder whether it's safe to skip or must abort),
and field meaning (a Map's key numbering is Type-owned; with no Type, no
key means anything to anyone). §3.5 already establishes the applicable
precedent: an application MAY omit the *namespace* and rely on carrier
isolation, but the typeID itself stays mandatory even there. An
application wanting genuinely zero QDEF framing, meaning entirely
implied by context, already has that option today — carry the bytes as
their own NDEF record outside any QDEF Sequence entirely, rather than a
QDEF Record shape that pays QDEF's framing cost with none of its
benefits.

**Field-embedded Records, kept only as a fallback.** A Type needing more
than one independently-named embedded slot (both a "payload" and a
separately-purposed "thumbnail", say) can still host the same
embedded-Records array shape as an ordinary field's value inside its own
Map, at a Type-owned key. This isn't a second mechanism — it's the same
array shape, just hosted at a Type-owned position instead of the
universal Phase-1 one. Most Types won't need it, since dispatch-by-
typeID inside the Phase-1 array already covers "more than one embedded
thing" as long as they don't need separate names.

Prototyped end to end in `prototype/src/core.js` (`parseRecords`,
`recordToItems`, called recursively) and `rust/qdef-core`
(`Record::embedded_records`, reusing the `Records` iterator on the
array's own element bytes at zero extra parsing cost — a definite-length
CBOR array's payload is byte-for-byte identical in shape to a CBOR
Sequence of the same items). See `prototype/test/embedded-records.test.js`
and the embedded-Records tests in `rust/qdef-core/src/tests.rs`.

## Every Record became a self-delimited array — resolved, replacing `ID[]{}` and the flat namespace-pairing array

Raised while comparing `ID[]{}` (array before the mandatory Map) against
`ID{}[]` (array after it): is there a real difference beyond parser
complexity? The honest answer is that complexity was never the actual
objection to `ID{}[]` — safety was. `map, then array` was already how a
namespace-paired Record legitimately starts; giving it a second meaning
isn't a lookahead problem, it's undecidable, since the bytes are
identical either way regardless of how sophisticated the parser is.
There's also no genuine memory-ordering argument between the two shapes:
the array and the Map are each independently self-describing (no field
in one depends on content in the other to be interpreted), so there's no
"more natural to build in memory" case for putting the array before or
after — the collision is the whole reason, not a proxy for it.

**A companion proposal — a `NAMESPACE [stream]` construct for namespace
sub-scoping, with every Record paying a mandatory trailing empty array
as an end-of-record marker — surfaced a real, separate problem worth
solving and a cost not worth paying.** Namespace-pairing being "paid
fresh on every Record, no amortization" (already documented) is a real
gap when several Records in one container want the same non-ambient
namespace. But the proposed fix (a universal trailing `[]`, present even
when empty) taxes the overwhelmingly common case — ordinary fields, no
subrecords — to spare the rare one, backwards from the zero-cost-when-
unused discipline this format has followed everywhere else (Wrapper
Records opt-in, payload free when absent, `ID[]{}` itself free when
unused). The sub-scoping problem is real; that specific fix didn't earn
its cost.

**Resolved instead by making every Record its own self-delimited CBOR
array — `[namespace?, typeId, map?, payload?, subrecord*]`** — replacing
both `ID[]{}` and the earlier 2-element `[namespace, typeId]` pairing
array. What this actually buys, precisely: not easier interpretation of
a Record you care about (Phase 1's own recognition logic is exactly as
complex as before, just now scoped inside a known-length array) — the
real win is that *skipping* a Record you don't care about becomes fully
generic. A decoder no longer needs any Record-grammar knowledge at all
to advance past an uninteresting Record; it skips one CBOR array, the
same generic operation already used for skipping unknown field values.
More importantly, it permanently closes the entire *category* of
ambiguity this whole redesign kept running into at every level — the
retired Type-`0` header, `ID[]{}` vs `ID{}[]`, "is this array a
namespace pairing or the next Record starting" — every one of those was
some version of "a boundary has to be inferred from context because
nothing declares it explicitly." An explicit-length array around every
Record means a boundary is never inferred again, at any nesting depth.

**The same principle, for a different audience: a human or an LLM
reading raw diagnostic notation with zero protocol knowledge.** Before
subrecords existed, "the Map is the Record's own end" was a reliable,
always-true visual rule — nothing ever followed a Record's Map in any
earlier design. A reader could partition `uint, map, uint, map, ...`
into Records correctly just by counting Map closes, no understanding of
Type IDs or namespaces required. Subrecords silently broke that rule:
`uint, map, uint, map` became genuinely ambiguous to a naive reader —
is the second pair a new sibling Record, or a subrecord nested inside
the first? — since telling them apart requires tracking nesting depth,
which a glance doesn't give you. Bracket matching restores the same
"reliable at a glance" property for the now-recursive case: `[uint,
map, [uint, map]]` is unambiguous on sight, since bracket-matching is a
structural primitive both humans and LLMs are already good at, where
"did that Map belong to the current nesting level" isn't.

**A genuine, unplanned robustness improvement fell out of this for
free.** The previous design's `Records` iterator had a documented
limitation: a malformed Record made the rest of the Sequence
unrecoverable, since the parser couldn't determine where the malformed
item ended. With every Record self-bounded, `Records::next` now
determines a Record's total byte span *generically* (`skip_any_item` on
its whole array — this only needs well-formed CBOR, not valid Record
grammar) *before* attempting to interpret its contents. A Record whose
own contents don't parse as valid Record grammar still can't corrupt
discovery of the next sibling; only genuinely malformed CBOR (not just
malformed Record grammar) still ends a Sequence early, which is a
narrower, unavoidable failure mode. See `rust/qdef-core`'s
`a_malformed_subrecord_does_not_corrupt_its_parent_or_any_sibling_top_level_record`
test.

**Cost is real but bounded and was checked, not assumed.** One
array-header byte per Record, universally — but typical QDEF payloads
carry one or two Records, so the realistic per-payload cost is small,
not a multiplier across the whole format. Verified directly:
`prototype/test/custom-scheme-carrier.test.js`'s byte-cost FINDING moved
from 11/4 to 12/5 bytes (own-URI-scheme vs. shared-container path) —
exactly one byte higher on each side, the relative saving of skipping
magic/discriminator/namespace-scoping unaffected, since both paths now
pay the same array-header cost once.

**Namespace becomes a flat leading element instead of a nested pairing
array, avoiding double-nesting.** Once every Record is already
array-wrapped, keeping namespace-pairing as its own separate 2-element
array (`[[namespace, typeId], {...}]`) would nest an array inside an
array for no reason. `namespace` and `typeId` are simply the outer
array's own first two elements when a namespace is present
(`[namespace, typeId, {...}]`), recognized the same way as before: the
first element's CBOR major type (byte string vs. uint) determines
whether a namespace is present, and if it is, the *following* element
must also validate as a typeId or the byte string isn't committed as a
namespace at all (falls through, Record unroutable) — the same
"malformed prefix means unroutable, not a crash" tolerance the pairing
array always had.

**One concrete behavior change worth being explicit about:** a uint
where a namespace was intended is no longer detectably wrong — it's
simply read as this Record's own typeId directly (since a bare uint is
unconditionally valid typeId shape on its own), and the originally-
intended typeId becomes a skipped stray item. The old 2-element pairing
array could at least fail closed (the whole array falls through
unrecognized, Record unroutable) when a uint appeared in the namespace
slot; the flat form can't distinguish "no namespace, deliberately" from
"namespace omitted by a bug" as cleanly. Accepted as a reasonable
trade — the failure mode is still safe (a routable Record with a
different typeId than intended, not a security hole), and the byte and
conceptual savings from dropping a whole nested-array nesting apply to
*every* namespaced Record, not just the malformed case.

**Subrecords no longer need a dedicated array slot at all.** Since the
outer Record's own array is already exactly self-bounded, every element
after the field Map is unambiguously a subrecord — no separate wrapper
array is needed to say where they start or how many there are, unlike
`ID[]{}`, which needed its own array specifically because the
*enclosing* structure wasn't otherwise bounded. This also lets a Record
carry more than one subrecord without any extra framing beyond each
subrecord's own array header, where `ID[]{}` needed exactly one array
regardless.

**Namespace cascades to subrecords, resolving the sub-scoping problem
that started this whole entry — via composition of already-existing
mechanisms, not a new one.** A subrecord with no namespace of its own
resolves against its immediate parent's own effective namespace
(recursively), not directly against the container's ambient one — so a
Record that leads its own array with a namespace scopes its own
subrecords too, for free. Implemented as `header.js`'s
`resolveLookupKeysDeep`, generalizing the existing "container ambient,
overridable per-Record" rule (§3.5) one level further, reusing
`resolveLookupKeyForRecord`'s own logic rather than inventing a
parallel one.

**Scope of this change, stated plainly:** unlike `ID[]{}` (purely
additive, nothing existing changed shape), this changes the wire shape
of every existing standard record type — Wi-Fi, Split, Compress,
Encrypt, Open/Hint URI, Media Payload, App Route — in both prototype
languages, requiring a full re-implementation rather than an add-on.
Undertaken deliberately, with explicit confirmation, given this document
predates any real-world release.

Prototyped end to end in `prototype/src/core.js`
(`parseRecordArray`/`parseRecordList`/`recordToItems`, all mutually
recursive) and `rust/qdef-core` (`Records::next` determining a Record's
span generically before `parse_record_array` interprets it,
`Record::subrecords()` reusing the same `Records` iterator on the
trailing element bytes at zero extra parsing cost — a definite-length
CBOR array's elements are byte-for-byte identical in shape to a CBOR
Sequence of the same items, recursively, at any depth). See
`prototype/test/subrecords.test.js` and the subrecord tests in
`rust/qdef-core/src/tests.rs`.

## The payload slot and the optional field Map — real byte savings, at a small and bounded cost to the glanceable-Map property above

The field Map became optional (omitted entirely when empty, §3.1) and a
new payload slot — a bare byte or text string immediately after it —
replaced the retired NDEF-ID-equivalent. Both are genuine wins on their
own terms:

- **Real, measured byte savings on the hottest path — not uniform
  across the three, worth being precise about rather than assuming.**
  Every Wrapper Record's opaque content used to live at an arbitrary map
  key (Compress key `0`, Encrypt key `2`, Split's fragment bytes at key
  `6`), paying at minimum a key byte for content that was never actually
  a *field* — it was always meant to be read as raw bytes, not looked up
  by key. Verified directly against the encoder for all three, not
  estimated or assumed identical (`payload-byte-cost.test.js`):
  **Compress saves 2 bytes** — `[8, {0: h'<deflate bytes>'}]` shrinks to
  `[8, h'<deflate bytes>']`, dropping the map header *and* the key byte,
  since Compress's map holds nothing else to justify the map's own
  existence. **Encrypt and Split each save exactly 1 byte** — their maps
  still hold other fields (Encrypt's nonce; Split's `group_id`/index/
  count/`total_bytes`), so only the payload's own key byte goes away,
  not the map header, which is unchanged either way for a map that still
  has content. The minimal Wi-Fi Record case in `large-type-id.test.js`
  shows the same map-elimination pattern as Compress: 4 bytes
  (`82 18 64 a0`, empty map still paying `a0`) to 3 (`81 18 64`, the map
  dropped from the array entirely).
- **A cleaner semantic split.** "Map holds typed fields, payload holds
  raw pass-through bytes" is a real distinction Wrapper Records always
  had implicitly (their map keys were never meant to be *interpreted*,
  just stored) and now have explicitly. Media Payload's own key `2` and
  Split's fragment key were always payload in spirit; they're payload in
  the grammar now.

**A smaller cost than it first looks, and worth being precise about
rather than overstating.** Bracket-matching still finds a Record's own
boundary reliably — nothing about subrecord nesting changed. Inside that
boundary, a reader can no longer assume a fixed array position always
means "the field Map" — but what replaces that assumption is a strictly
ordered, one-directional scan, not open-ended ambiguity: map (if
present) always precedes payload (if present) always precedes
subrecords (if any), never interleaved and never revisited once the
read has moved past a slot, in both shipped parsers. A reader doesn't
need to track nesting depth or resolve a genuine either/or the way the
retired Type-`0` header or `ID[]{}` vs. `ID{}[]` did — just notice each
item's own major type and advance through the same fixed sequence every
time. That's a materially smaller ask than "content, not position,
decides meaning" implies, closer in spirit to counting Map closes than
to real ambiguity. The actual, narrower cost: one more state to track
during the scan (was I still in map-or-earlier territory, or have I
already moved past it) instead of a single fixed assumption — bounded,
recurring on every Record, but not the same category of problem
array-wrapping was built to eliminate.

**Cross-implementation note, found by testing rather than assumed
identical:** an indefinite-length byte or text string in the payload
position is well-formed CBOR either implementation can skip, but the
two shipped prototypes disagree on whether they *recognize* it as
payload — `rust/qdef-core` requires definite-length explicitly, while
the Node prototype's underlying `cbor` library normalizes
indefinite-length strings before application code ever sees them, so it
always recognizes one. Documented as decoder-tolerance-only (§3.1),
matching the same asymmetry §3.2 already allows for indefinite-length
field values: a conformant encoder never produces this shape (§3.4), so
only encoder output is required to round-trip identically everywhere.
See `core.test.js`'s and `tests.rs`'s matching tests for this case.

## Payload generalized to any CBOR shape, with a mandatory presence marker — three rejected alternatives along the way

Two gaps in the payload slot above surfaced together: (1) a QDEF
debugger reading an unrecognized Record's payload has no way to tell
"opaque bytes" from "this is itself a Record" without Type-specific
knowledge, and (2) a Record wanting its content to unambiguously *be* a
single Record — not one of an open-ended, positionally-unordered
subrecord list — had no way to say so at the grammar level, only by
prose convention (Media Preview's spec text saying "typically Media
Payload"). Three fixes were considered and rejected before landing on
the one actually shipped.

**Rejected: reserve map key `0` as "payload."** Every shipped standard
Record Type already uses key `0` for its own ordinary critical field —
Wi-Fi SSID, Split `group_id`, Encrypt nonce, Media Payload/Preview media
type, App Route domain (same collision already documented above for
"key 0 as a Record's own typeID"). Even setting compatibility aside
entirely, reserving `0` globally would force every *future* Type to
start its own critical-field numbering at `2` forever, since `0` sits
inside the same even/critical numbering space every Type already uses
for its first required field — a permanent tax on every Type, including
ones that never want a payload-in-map at all. A negative key doesn't
have this problem: nothing currently uses negative keys for anything, so
reserving one costs nothing against the `0, 1, 2, 3…` convention Types
already rely on.

**Rejected: a reserved negative map key (e.g. `-1`) holding the payload,
of any shape including a Record.** Structurally sound — a map value
never competes with subrecord-array scanning — but two real costs.
First, measured byte cost: moving payload into a map key forces a map
to exist where none did before, undoing exactly the "no map at all"
saving that was the flagship win of the payload slot itself (see
above). Verified directly: Compress (`[8, h'<deflate bytes>']`, no map
today) grows from 15 to 17 bytes moving its payload to `{-1: ...}` — a
worse regression than either shipped alternative, and it lands hardest
on precisely the minimal Wrapper Records that most wanted to stay
mapless. Second, and more fundamental: for `-1` to mean "payload"
*unconditionally regardless of Type*, every decoder needs to recognize
it globally, not per-Type — a core-level parsing rule, not a Type
convention. That's the same bar DESIGN.md's earlier rejected proposal
("a reserved negative key signaling an embedded-Records array," see
above) failed for being "per-Type convenience," except here the
blocker is worse: the two shipped prototypes currently disagree on how
negative keys are even evaluated for criticality. `prototype/src/core.js`'s
`applyCriticality` has no special-casing at all — a negative key goes
through ordinary `key % 2 === 0` parity like any other key (and JS's
`%` preserves sign, so `-2 % 2 === -0 === 0`: treated as
critical/even). `rust/qdef-core`'s `check_criticality` explicitly
matches only `cbor::Key::Uint`, silently skipping every negative key
regardless of parity. Identical wire bytes carrying an unrecognized
negative-even key currently abort under the JS decoder and pass
silently under the Rust one — a genuine, previously undocumented
cross-implementation divergence, found while evaluating this proposal,
independent of it. Not resolved by the payload design adopted here,
which never needs negative keys at all — but not left open either: see
"Common Field Keys" below, where negative keys found an actual use and
the divergence had to be fixed (not just documented) before that use
could be trusted.

**Rejected: widen the existing payload slot to accept major type 4
(array) with no other change.** This looked like the cheapest fix —
reuse the slot payload already has, just relax its shape restriction —
but it broke the exact guarantee that made the slot safe to reference
positionally in the first place. Payload and subrecords could coexist
unambiguously only because payload's shape (byte/text string) never
overlapped with a subrecord's shape (array); once payload can also be
an array, a bare array immediately after the Map is structurally
ambiguous between "the payload is a Record" and "no payload, this is
subrecord 0" — a Type-agnostic decoder cannot tell which without
guessing. This is the identical failure mode already rejected for
"subrecord 0 is always Preview" (TagDrop's original, abandoned design,
see the Embedded Records section above): treating an unmarked position
as meaningful, with nothing on the wire to catch an encoder that
produces the "wrong" one.

**Adopted: the payload slot is mandatory whenever anything follows the
Map, and its value may be any well-formed CBOR item** — the same shape
rule §3.2 already gives field values, reused verbatim rather than
maintained as a second, parallel rule. A conformant encoder emits a
bare CBOR `null` when there is no real payload but subrecords follow,
so the ambiguity above cannot arise: once the payload slot is known to
be present-or-absent unconditionally (never skipped), a bare array in
that position is *always* the payload, never subrecord 0, full stop —
resolved by position and cardinality alone, no shape-based guessing, no
new key space, no map required for records that don't otherwise need
one. This also fixes the debugger problem for free: "is the payload a
Record" is a single major-type check (4, or not), the same certainty a
subrecord already has, no opportunistic CBOR-sniffing needed. The one
shape needing a carve-out is a map-shaped payload: major type 5
immediately after typeId is otherwise always the field Map, so a
map-shaped payload requires the field Map to also be explicitly present
(even empty, one byte: `0xa0`) — every other shape is disambiguated by
position alone.

**Cost, measured, not assumed:** zero except in the specific case of
"subrecords present, no real payload," where it's a flat one byte (the
`null`, `0xf6`) — verified against Media Preview's real shipped shape
(map + Media Payload subrecord, no payload of its own): 28 bytes before,
29 after. That case is narrower than it might sound: checked against
all eight standard Record Types (§4), only Bundle and Media Preview use
subrecords in their own *baseline* shape at all — Split/Encrypt/Compress
only pick one up when something else (typically Media Preview) is
deliberately composed on top, and every other standard Type has none.
Wi-Fi, Media Payload, Open/Hint URI, App Route, and the three Wrapper
Records in their unwrapped form all pay nothing.

Prototyped in `prototype/test/payload-any-shape.test.js` and
`rust/qdef-core/src/tests.rs`'s matching payload-shape tests; the
three regenerated fixtures that gained the `null` marker (`SUBRECORDS_CONTAINER`,
`SUBRECORDS_WITH_NAMESPACE_CONTAINER`, `SUBRECORDS_SIBLING_CONTAINER`)
are cross-validated the same way every other fixture is — encoded by
the Node prototype, decoded by the independent Rust implementation.

## Common Field Keys (§3.6) — the negative-key space's actual use, once the JS/Rust criticality divergence was fixed rather than just documented

The payload section above rejected using negative keys as an
alternative *payload* mechanism. That's a different question from
whether negative keys should be used for anything — this entry is the
answer to the second question, prompted directly by revisiting the
"NDEF's ID field" entry above with a concrete want in mind: a QDEF
debugger that can render certain fields the same way in *any* Record,
regardless of Type, the way a JSON-LD `@id` or a CWT claim works.

**The mechanism costs nothing new — it's the even/odd rule, unmodified,
applied somewhere it already worked but was never actually used.**
Parity is well-defined on any integer; nothing about the existing
critical/optional rule (§3.2) is specific to non-negative numbers. Once
a decoder stops treating negative keys as a special case, "an
unrecognized Common Field Key degrades exactly like an unrecognized
Type-owned key" falls out for free — same abort-on-even, ignore-on-odd
behavior, same forward-compatibility story, zero new grammar.

**This is precisely why the JS/Rust criticality divergence had to be
fixed before this tier could be trusted, not after.** A Common Field
Key's entire value proposition is *consistent* cross-implementation
behavior — that's what makes it debugger-safe. Before the fix, an
unrecognized even Common Field Key aborted under JS and passed silently
under Rust: the exact inconsistency this tier exists to prevent, just
one layer up. Fixed in `rust/qdef-core::check_criticality`, which no
longer special-cases `Key::NegInt` — it converts to the key's actual
value (RFC 8949 §3.1: `-1 - argument`, not the raw encoded argument —
computing parity on the raw argument directly gives the *inverse* of
the correct classification, `check_criticality`'s own doc comment now
spells this out explicitly) and applies the identical even/odd check
`Key::Uint` already got. `CriticalityOutcome::Aborted` and
`on_ignored`'s callback signature both widened from `u64` to `i64`
accordingly — a breaking API change to an unstable, pre-1.0 prototype
crate, judged acceptable the same way the payload-slot grammar change
above was. Pinned with a dedicated test walking all four small
arg-to-value parity cases (`arg 0 → value -1, odd`; `arg 1 → value -2,
even`; `arg 2 → value -3, odd`; `arg 3 → value -4, even`) so a future
regression can't silently flip the classification again without a test
failing. JS needed no corresponding change — its existing `key % 2 ===
0` was already correct, since the `cbor` library decodes a negint item
to its actual signed value directly, not a raw argument.

**Governance: Standards-Action only, deliberately not mirroring the
Type ID tiers' `100+` self-allocation option.** A Type ID collision is
locally survivable — an application picks a namespace and the collision
risk becomes that application's own problem to manage (§3.5). A Common
Field Key that meant different things in different applications'
Records would defeat the entire mechanism: nothing would tell a
debugger which meaning applies to a given `-1` it encounters. So unlike
positive Type IDs, there is no self-allocatable tier here at all — only
this spec (or whatever governance eventually exists for it, same
caveat already noted for the `100`–`32767` Type ID tier) assigns
negative keys, full stop.

**Starter registry, six keys, all odd (optional) — chosen from two
sources, not invented speculatively.** `ID` and `UUID` came directly
from revisiting the "NDEF's ID field" entry above with this mechanism
available: `ID` (`-1`) is the literal NDEF-`ID` equivalent that entry
originally went looking for and didn't find (see the correction added
there); `UUID` (`-3`) is a deliberately separate, stronger key for a
standardized globally-unique identifier, since NDEF's own `ID` field
has no uniqueness guarantee and conflating "cheap local correlation
token" with "globally unique identifier" into one field would force
every consumer to guess which guarantee a given value actually carries.
`Label` (`-7`) and `Language` (`-9`) came from the opposite direction —
checked against the already-shipped standard Types first, not
speculated: Open/Hint URI's key `1` and App Route's key `1` are already
independently, coincidentally the same "human-readable label" field;
Open/Hint URI's key `3` is already a BCP 47 language tag. Two Types
reinventing the identical field is itself the evidence a common version
is worth having — this is the repetition DESIGN.md's own "confession"
entry (below) warns against ignoring. `Content Hash` (`-11`) is the
same move applied to Media Preview's key `1` multihash-style value
(§4.5) — one already-designed, already-tested value shape, generalized
instead of re-invented the next time some other Type wants a content
hash. `Date` (`-5`) is the one genuinely speculative addition — no
existing Type duplicates it yet — justified only by how cheap it is
(CBOR's own tag 0/1, no new format to design or maintain) and how
commonly "when was this created" comes up across unrelated content
types; kept in specifically because it was the user's own original
suggestion, not manufactured need.

**Deliberately not migrating Open/Hint URI's or App Route's own label
fields to the new common key.** They stay exactly as specified — no
breaking change forced on already-designed Types just to prove the new
mechanism works. `Label`/`Language` exist for *future* Types, and for
generic tooling that wants a label from a Record whose Type it doesn't
recognize at all (where there is no Type-specific field to fall back
on) — not as a mandatory replacement for fields that already do their
job.

**Byte cost is ordinary field-cost, not a repeat of the rejected
payload-key proposal.** Attaching a Common Field Key costs exactly what
attaching any other map entry costs — no map is forced into existence
for a Record that wouldn't otherwise need one, unlike the earlier
rejected "`-1` as payload" idea, which taxed every Wrapper Record
wanting a payload regardless of whether it wanted this metadata at all.
This tier is opt-in, additive, and only paid for by a Record that
actually uses it.

Prototyped in `prototype/src/commonKeys.js` and
`prototype/test/common-keys.test.js` (Node), and
`rust/qdef-core/src/tests.rs`'s negative-key criticality tests (Rust,
cross-validated against the same even/odd behavior).

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

## Media Preview (Type 14) — closes the loop on the correlation problem subrecords were built to solve

TagDrop's original four-Type Content-Preview/Body split was the concrete
case that motivated subrecords in the first place (see "Every Record
became a self-delimited array," above). Once subrecords shipped, TagDrop
proposed the natural resolution: one standard Type (14) carrying
identification fields (media type, content hash prefix, filename, label)
with the identified content riding as its own subrecord, typically §4.3
Media Payload — no Bundle Wrapper, no positional correlation, and Media
Payload's own minimal field set stays untouched.

TagDrop's first draft nested the wrong way for the multi-code case: Media
Preview outermost, Split nested inside it. That inverts §4.1's own
outermost-Split convention, and it's not just a style objection — Media
Preview's typeID is even (critical), so an old decoder that has never
heard of Type 14 aborts the *whole* Record, including the Split fragment
nested inside it, losing the ability to reassemble a group it otherwise
knows exactly how to handle. Flipping it — Split outermost, Media Preview
as *its* subrecord — costs nothing (`wrappers.js`'s `splitDecode` never
inspects `subrecords` at all) and restores the property: an old Split-only
decoder ignores the unrecognized subrecord and reassembles regardless
(verified in `prototype/test/media-preview.test.js`, including a
`resolveStack` call whose `knownKeysRegistry` has no entry for Type 14 at
all).

A second, independent bug surfaced during review: an earlier revision of
the multi-item example wrapped two sibling Records in an enclosing array
— `[ [14, ...], [14, ...] ]` — which doesn't round-trip. QDEF's container
is a CBOR *Sequence* of Records (RFC 8742), not an array of them; the
wrapped form decodes as one malformed top-level Record (its first element
is an array, not a valid namespace-or-typeId), not two. Confirmed via the
reference decoder: encoding that shape and decoding it returns `{typeId:
null, ignored: true}`. Fixed by dropping the enclosing brackets — two
independent top-level CBOR items, exactly the same pattern already
rejected in "Do we win anything by wrapping the root in an array?"
(unrecorded chat discussion, no doc entry — the answer was no, for the
same ambiguity reason this bug demonstrates concretely).

## Checked against binary-XML precedent (EXI, Fast Infoset, YANG/CBOR, ASN.1/BER, SenML) — nothing to import

Once Records became recursive, self-delimited, tagged nodes with
attributes and children (the array-wrapping entry above), the shape is
architecturally a tagged tree — worth checking directly against the
real prior art for compact tree-structured binary encoding, rather than
assuming QDEF's version is either novel or missing something obvious.

**EXI (W3C) and Fast Infoset (ITU-T X.891)** are the actual "binary
XML" standards. Both get their compactness from being
schema-dependent — EXI compiles a grammar from an XML Schema/DTD so an
element name encodes as "the Nth possible child at this grammar
position" in a couple of bits; Fast Infoset leans on string tables built
up during a session. **YANG/CBOR (RFC 9254)** is IETF's closer,
CBOR-native answer to the same problem: a numeric SID (Schema Item
iDentifier) stands in for a tag name, requiring a shared SID file — a
compiled schema dictionary distributed out of band.

**All three's core lever is schema-sharing, which QDEF's actual
constraint rules out categorically, not just declines as unnecessary
overhead.** QDEF's job is routing content between apps that have never
coordinated — a QR code or NFC tag decoded by a generic scanner with no
prior relationship to whatever app encoded it. Importing a
grammar-compiled or dictionary-based tag scheme would require exactly
the negotiation QDEF exists to avoid.

**Checked whether anything schema-independent was still worth taking —
found nothing missing, only mechanisms QDEF had already reinvented on
its own:**

- ASN.1's extensibility marker (schema declares "more fields may
  follow, skip unknowns") — §3.2's even/odd criticality does the same
  job without a schema to declare it in.
- EXI's optional self-contained-fragment mode (an element independently
  decodable without full document context) — every QDEF Record is now
  *unconditionally* self-bounded by its own array header (the
  array-wrapping entry above), the same property as EXI's opt-in mode,
  as the default rather than an extra feature to enable.
- SenML's Base Name (RFC 8428 — a shared prefix applied to a flat list
  of records, any one able to locally override it) — architecturally
  the same pattern as §3.5's ambient namespace with per-Record
  override, arrived at independently for a similar problem (compact
  sensor readings, not markup) by a different IETF working group.
- DER's canonical encoding (deterministic bytes for a given value) —
  §3.4 already requires RFC 8949's canonical CBOR for the identical
  reason (stable hashes across independent encoders).

**Conclusion: no mechanism adopted from this comparison.** CBOR itself
is already a simplified descendant of the same ASN.1/BER lineage this
comparison traces (RFC 8949 says as much); QDEF's own even/odd rule and
self-bounded Records are its answer to what schema-driven formats get
for free from a schema they don't have access to.

## Encrypt key provisioning (resolved — Algorithm/Key Algorithm fields, borrowing COSE)

Type 4 originally named a cipher only in a comment (`e.g. AES-GCM`),
with no field for it, and never specified where the key comes from —
see FINDINGS.md #6. Resolved toward adding a field, but not a
QDEF-specific one.

The same asymmetry check that killed Media Type's decentralized-ID
layer applies here: a cipher and a key-agreement scheme both have a
stable identity independent of QDEF, so there's no opacity problem for
a hint-plus-hash layer to solve — just borrow an existing numbering
scheme. IANA's COSE Algorithms registry (RFC 9053/9054) covers both the
content-encryption algorithm and the key-agreement/wrap/derivation
algorithm, is CBOR-native, and is actively governed.

Spec §4.1 adds two optional fields to Type 4 (key `3` Algorithm, key
`5` Key Algorithm — a COSE Algorithm ID or plain string) and keeps both
odd/optional: two apps that already agree out of band pay nothing, and
a decoder that doesn't recognize either field falls back to its own
assumption, which fails safely since AEAD's own auth tag catches a
wrong-algorithm attempt. The fields exist for the interoperable-
key-transfer case an unrelated adopter would need.

**Implementation caution, not a wire-format concern:** a decoder that
*does* honor these fields must not let them broaden which algorithms it
will run — the same "alg" confusion vulnerability class JOSE/JWT is
known for. Treat the value as something to check against an
application-chosen allowlist, never trust outright.

**Checked against a real adopter after the fact, surfacing a limitation
worth keeping:** `mofosyne/tagdrop` uses AES-256-GCM (matching
`A256GCM` = 3) and PBKDF2 for passphrase-based key derivation — PBKDF2
has no COSE algorithm ID at all, so Key Algorithm's plain-string
fallback covers it. More significantly, TagDrop's encryption is
deliberately *undeclared* — discovery via trial decryption, not a
stated algorithm, so ciphertext stays indistinguishable from random. A
Type-4 Wrapper can't preserve that regardless of field shape: being
wrapped in Type `4` at all is itself a visible declaration. See
FINDINGS.md #13 — a genuine scope boundary, and confirmation that
TagDrop's own §6 registration (encryption entirely inside the opaque
blob) was already the right call.

## Media Payload: checked against a real adopter, confirmed compatible but never reached

`mofosyne/tagdrop` has typed content-tagging (`mime_type`, a free-form
string, never a numeric ID) — confirming that if this were ever exposed
at the QDEF layer, it would use Media Type's plain-string fallback, not
CoAP's numeric registry. But it can't come up for TagDrop's actual §6
registration at all: that registration carries TagDrop's entire
existing CBOR sequence as one opaque blob, deliberately invisible to
QDEF. Not a gap — Media Payload targets an adopter with no existing
format of its own to protect (§1).

## Split chunking vs. per-code capacity — costs nothing against at least one real adopter's design, general case still open

The uniform `chunkLen = ceil(total_bytes/count)` rule (spec §4.1) is
what makes single-fragment XOR parity well-defined, but it also
prevents an encoder from sizing each fragment to match that code's
actual capacity (different QR version/ECC level per code, or a QR code
alongside a smaller-capacity NFC tag). Checked against a real adopter:
`mofosyne/tagdrop`'s own sectorization already assumes uniform chunk
length across a split group, so QDEF's rule matches rather than imposes
a new constraint. That's evidence for one real usage pattern, not a
general resolution — an adopter needing heterogeneous per-code capacity
still hits this constraint. Resolving that general case needs either
accepting uniform-chunking as a real limitation, or a fragment-length
manifest redundant enough to survive one missing fragment. See
FINDINGS.md #3.

## Canonical encoding (resolved — spec §3.4)

Spec §4.1's `group_id` was a hash of encoded bytes that silently
assumed two conformant encoders given the same logical content produce
identical CBOR — true only because every worked example used simple,
unambiguous field values. CBOR permits multiple valid encodings of the
same value (a longer-than-necessary integer argument, a differently-
ordered map), so this wasn't automatically true in general, and matters
more the moment QDEF is used for hashing/signing beyond `group_id`'s
narrow use.

Resolved by adopting CBOR's own deterministic-encoding rules (RFC 8949
§4.2.1 — shortest-form arguments, no indefinite-length items, map keys
sorted bytewise) as a MUST for encoders. Distinct from the field-value-
shape rule (spec §3.2), which constrains *what shape* a value may be,
not which *encoding* of that shape an encoder must pick.

`group_id` verification was never *incorrect* for its narrowest
existing use (a single encoder hashes bytes it's about to fragment, a
decoder re-hashes the identical bytes on reassembly — pure corruption
detection, unaffected by canonicalization). What canonical encoding
fixes is the *stronger* property `group_id`'s own spec text already
claimed: "no coordination is needed between independent encoders" only
holds if independent encoders of equivalent content produce identical
bytes, which nothing guaranteed before this rule. Closed proactively,
before Split/`group_id` saw real production traffic.

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
  Record (like the Open/Hint URI spec §4.2 is a sibling, not a wrapper),
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
- **Sign-as-nested-subrecord (TagDrop's own real shape, considered and
  declined).** A real adopter data point, not a hypothetical third
  form: TagDrop shipped signing in its own namespace as a small Content
  Signature Record nested as a *subrecord of the specific Record it
  signs* (their SPEC.md v9 §3.1a/§10;
  [issue #32](https://github.com/mofosyne/qdef/issues/32)) — cheaper
  than the hash-list sibling form for a fixed, known coverage set (no
  `N × 32` bytes of hashes to store or check), but less general:
  verifiable only by a decoder that already knows the app-specific
  coverage convention (TagDrop's actual signed set is three sibling
  Records, only one of which the signature happens to nest inside —
  the nesting position says where the signature bytes travel on the
  wire, not what's covered). Declined as QDEF's own primitive because
  it loses the one property a generic QDEF-level Sign mechanism exists
  to provide: "any QDEF-aware decoder can check this," not just one
  that already speaks the specific app's convention. Recorded here as
  a live tradeoff future adopters weighing the same choice should see,
  not as evidence the hash-list direction was wrong.

**A third coverage-strategy precedent, for the record.** NFC Forum's
own Signature RTD (a sibling NDEF record, same broad family as
sign-as-sibling) uses yet another rule: positional, not hash-based — a
Signature record covers all records preceding it since the start of
the message or the previous Signature record. Between it, TagDrop's
nested form, and the hash-list direction planned below, that's three
distinct coverage strategies now on record (position-since-checkpoint,
position-of-immediate-nesting, and content-hash-list) — cited as
design precedent, not as evidence of real-world demand for any one of
them; issue #32 found no solid data on how widely Signature RTD is
actually deployed.

**Coverage-identification scheme — direction decided, not yet built.**
Cover by content hash of each covered Record's own canonical bytes,
never by Sequence index: an index breaks the moment anything is
reordered or an unrelated Record is inserted, while a hash doesn't care
where a Record sits. This also reuses the canonical-encoding machinery
`group_id` already needs. Two refinements needed:

- **The hash list MUST be a packed, fixed-width byte string, not a bare
  CBOR array** — `N` concatenated 32-byte SHA-256 hashes in one
  definite-length byte string, skip-safe by construction.
- **A hash covers a Record's fully unwrapped, reassembled canonical
  bytes — never a Wrapper's per-fragment or per-code bytes.** Hashing
  Split-fragment bytes directly would make a signature depend on how
  many physical codes the content happened to be fragmented into. Sign
  a Record after any Wrapper stack resolves, the same layer `group_id`'s
  own hash already operates on.

Strippable-but-not-forgeable is an accepted property of this design,
not a gap to close: deleting a sibling Sign Record downgrades signed to
unsigned trivially, the same way `mofosyne/tagdrop` already documents
this as an accepted limitation of its own scheme (§6).

Direction when taken up: specify the sibling form, but only after the
canonical-encoding question is resolved — a detached signature is
meaningless without it. The wrapper form can be dropped in at any time
as a straight parallel to Encrypt if an opaque-payload use case wants
it. Prototype it the same way as everything else here: sign two sibling
Records, reorder them, insert an unrelated third Record, and confirm
verification still finds exactly the right two.

## Nesting order enforcement — now answered, not open

A prototype confirmed a generically-written decoder cannot detect or
reject a non-conformant Wrapper nesting order (FINDINGS.md #7); spec
§4.1's text has been corrected accordingly.

## Type ID inheritance within a Sequence — backlog, needs a version bump

Raised alongside [GitHub issue #10](https://github.com/mofosyne/qdef/issues/10):
allow a Record's primary typeID in the prefix to be omitted, meaning
"same Type ID as the immediately preceding Record in this CBOR
Sequence" — a wire-efficiency optimization for adjacent same-type
Records with a wide private-use Type ID (the repeated calendar-event
case in `IMPLEMENTATION-NOTES.md`).

Not addable as a plain additive extension. Spec §3.1 already defines a
missing prefix typeID as a MUST-abort condition — redefining that
meaning is a behavior change to already-shipped semantics, so two
decoder versions would interpret identical bytes differently. That's
the class of change spec §2 reserves the Version byte for, not
something to introduce via the odd-key extensibility path.

Scope, resolved as a side effect of a separate discussion: "the
immediately preceding Record" can only ever mean within one Sequence —
there's no cross-code Record continuity in the format at all, since
each physical code is parsed as its own independent container from a
blank slate. This helps intra-Sequence repetition (the calendar-events
case) but not cross-code repetition (issue #10's motivating Preview
cost) — two different problems, not one with two names.

Backlog, not urgent: tracked for whenever a version bump happens for
some other reason, not a reason to force one on its own.

## Reference/value-sharing tags for intra-Sequence repetition — future path, not built

A related idea, raised while looking for a general fix to
repeated-large-value wire cost: CBOR already has registered tags for
this — tag `25` ("reference the nth previously seen string") and the
pair `28`/`29` ("mark value as shared" / "reference nth marked value").
Mechanically skip-safe under the same rule already generalized twice
(§3.2, FINDINGS.md #15/#16) — the mandatory core only ever needs to
skip the reference, never resolve what it points to.

**Doesn't solve the problem that motivated it.** A reference requires
shared decode state across everything it reaches into; two physical
codes have none — each is parsed from a blank slate, in any order, with
any of them possibly missing. Same wall as Type ID inheritance above:
it could only ever help repetition *within* one code's Sequence, never
App Route's or Preview's cross-code repetition, the cost that actually
prompted looking for a fix.

Where it would genuinely help: the same large value repeated multiple
times within one code (`IMPLEMENTATION-NOTES.md`'s calendar Option B).
Real, but narrower than "wire bloat" as originally framed, and comes
with cost beyond the rule-widening: precise scope rules for what counts
as "the stream" a reference can reach into, and weaker real-world
tooling support than tag `24` had — tags `25`/`28`/`29` come from an
informal spec, not RFC 8949 proper.

Not built. Noted as a future path for the single-code repetition case
only, not a general wire-bloat fix.

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
to answer one question: which installed application should this
scanned code auto-launch. Working through GitHub issue #10 with
TagDrop surfaced a second question key `0` also answers well: *before*
attempting reassembly, is this scanned code even plausibly part of the
group — cheap, per-code triage against a misread or unrelated nearby
code, layered ahead of §4.1's `group_id` integrity check.

These two questions have different stakes, and conflating them would
have been the actual design error. Auto-launch dispatch is
security-relevant — get it wrong and the wrong application opens, so it
needs the domain form's real, platform-verified ownership proof. The
pre-filter is not security-relevant — get it wrong and a decoder wastes
a little effort before `group_id` catches the mismatch anyway. That gap
in stakes is why the hash-derived form is allowed to reuse the cheaper,
unauthenticated hash-derivation pattern instead of requiring domain
verification for both.

Landed as one Record Type with two forms rather than a new Record
Type, since the wire shape, skip behavior, and shared hash-derivation
name-binding pattern (§3.5) are all identical; only the trust model and
repetition etiquette differ (§4.4).

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
declared namespace" from "this is the typeID belonging to the
container's actual first Record." A CBOR tag number could have marked
the difference, but tag-number collision risk already ruled that
mechanism out (FINDINGS.md #11). The only remaining way to resolve the
ambiguity structurally is to make the discriminator unconditionally
present — exactly one item, always first, no exceptions.

**The trade-off.** Making the discriminator mandatory gives up "zero
cost when unused" — every container now pays at least 1 byte (`uint 0`)
even when it wants no namespace. The case for accepting this: wire size
is what actually matters for this project's priorities, not
MCU-constrained parsing cost, and a single byte answering "is this a
generic QDEF record or a specific application's own file format" is
proportionally negligible against any realistic payload — closer to a
RIFF form-type field than to wasted padding.

**What it buys back.** The discriminator's recognized shapes (spec
§3.5) are each cheaper than the old Type `0` Record shape, since none
pay for a typeID prefix item plus a Map wrapper. Verified against the
actual encoder: a bare 4-byte namespace value costs 5 bytes as a
discriminator, versus 8 bytes as the old optional Type `0` Record.
Repeating that discriminator per code now costs 5 bytes/code instead of
8 — enough that a single shrunk namespace-scoped odd uint Type ID
already nets a win per code, not merely a breakeven.

**What did not change.** The mandatory core still needs zero semantic
knowledge of the discriminator — it only skips exactly one well-formed
CBOR item (`Container::discriminator()` in `rust/qdef-core`, backed by
the crate's existing `skip_any_item`). Interpretation stays entirely in
`prototype/src/header.js`'s `parseDiscriminator`. The own-URI-scheme
and NDEF carrier paths (`decodeSequence`) are unaffected — they never
had a magic prefix or a Type `0` header, and never get a discriminator
item either.

**This is a breaking wire-format change**, made deliberately rather
than incrementally, since the spec is still Draft status and
"not yet used in production anywhere." No version-negotiation machinery
to preserve compatibility with, so this is a one-time, pre-production
correction, not something requiring a migration path.

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

**Historical, partially superseded.** This entry's "always-global
floor" (a magnitude threshold, moved `100` → `1000` → `32768` below)
described an intermediate design. The floor concept itself was later
dropped entirely in favor of pure even/odd parity (§3.1, §3.5): every
even uint is always global regardless of magnitude, every odd uint is
always namespace-scoped regardless of magnitude, no floor to consult.
Kept for the real trail of reasoning — the compound-key resolution
mechanism, the "wrong match, not a clean miss" sharp edge, and the
IANA-boundary-alignment reasoning all carried forward into the parity
redesign unchanged; only "which Type IDs are scopable" stopped being a
magnitude question and became a parity question.

§3.5's namespace mechanism launched with one deliberate gap: whether and
how Type IDs `100`+ become namespace-local once a namespace is declared
was left unresolved, until TagDrop asked directly with a concrete want:
shrinking four existing self-allocated `32768`+ Type IDs.

**The resolution reuses the existing flat numbering space; it doesn't
carve out a new one.** Once the discriminator declares namespace `N`, a
subsequent Record's namespace-scopable typeID `T` is looked up as the
compound key `(N, T)`, not `T` alone — the same relationship a
Bluetooth short UUID has to its Base UUID. A reserved numeric sub-range
for namespace-local IDs wasn't needed once a compound key removes the
ambiguity structurally: `T` in isolation was never the real lookup key
once a namespace is present.

**The one sharp edge:** a decoder implementing specific semantics for a
namespace-scopable Type ID that doesn't check for a declared namespace
first can misapply its global interpretation to a namespace-scoped
Record sharing the same number — a wrong match, not a clean miss, worse
than any other failure mode in this spec. Record-Type-interpretation-
specific handling (spec §3.3's optional tier), never a mandatory-core
concern — the core still just reads prefix typeIDs with zero namespace
awareness.

**Follow-on: should the always-global floor really stop at `99`?** The
original design let namespace-scoping apply to anything `100`+. A
decoder implementer who only cares about the reviewed common-vocabulary
tier has no reason to ever read §3.5 at all — a meaningfully worse
failure mode than an implementer who read the spec and got the check
wrong. Resolved by extending the always-global floor from `100` to
`1000`, later `32768` (below) — only the First Come First Served tier
became namespace-scopable, at the cost of one extra byte for the
cheapest namespace-scoped Type ID.

**Second follow-on: does the floor have a principled basis?** IANA's
own CBOR tag registry already draws this exact three-way distinction:
`0`–`23` Standards Action, `24`–`32767` Specification Required,
`32768`+ First Come First Served. Both `1000` and `32768` fall inside
CBOR's same 2-extra-byte uint encoding class, so moving the floor to
align with IANA's boundary was a free upgrade, adopted on that basis.
`1`–`99` (standard record types) stayed deliberately unaligned with
IANA's `0`–`23` — renumbering already-shipped mechanism IDs to fit a
foreign registry's unrelated tier would have bought nothing.

**Third follow-on: does the first-come tier still earn its place at
all**, since namespace-scoping only applies above the common-vocabulary
ceiling and falls back to global otherwise? No — see "Registry
governance," above. First-come tried to give a cheap, uncoordinated
small Type ID without picking any real collision-safety source, and
namespace-scoping already covers its use case. Dropping it needed no
code change: `resolveLookupKey`'s floor check never implemented
"first-come" as a distinct mechanism.

**Fourth follow-on: is a namespace-local Type ID a truncated version of
a wider ID?** No, deliberately — a namespace-local ID is freshly
chosen, no formula connecting it to any wider ID. Literal truncation
would break the mechanism: `resolveLookupKey` only checks magnitude
against the ceiling, so a truncated value could land below `32768` by
chance and silently lose its namespace scoping (a Type ID below the
ceiling is always global) — the same "wrong match, not a clean miss"
failure mode, triggered at ID-selection time instead of decode time.
`prototype/test/header.test.js` constructs exactly this case and
confirms it resolves globally despite a namespace being declared.

**Fully additive.** An app's existing self-allocated even Type IDs keep
working forever; adopting namespace-scoped small IDs for new content is
an independent, opt-in choice that never collides with the old ones,
since an unnamespaced even ID was never namespace-scoped to begin with.

Prototyped in `prototype/src/header.js`'s `resolveLookupKey` and
`prototype/test/header.test.js`: the same Type ID resolving to
different compound keys under different namespaces, `1`–`32767` staying
global regardless, a namespace-aware dispatcher correctly not falling
back to a global meaning for an unrecognized namespace-scoped Record,
a naive decoder still correctly resolving a common-vocabulary Type ID,
and TagDrop's migration case end to end — verified real byte counts: an
existing self-allocated even Type ID costs 11 bytes as a bare Record; a
namespace-scoped small ID (`32768`, the current floor) costs 5.

## Namespace repetition across a multi-code Split group — TagDrop asked before committing, not after shipping it wrong

Once §3.5's namespace mechanism landed, TagDrop asked directly whether a
namespace declaration needs to repeat on every physical code of a
multi-code Split group, or can appear once — before adopting it for
real, since the answer changes their byte-cost math a lot either way.

**It must repeat on every code, for the same reason Preview and App
Route's hash-derived form already do.** Each physical code is parsed as
its own independent container, from a blank slate, with no cross-code
state. A decoder holding one code out of a group has no way to learn a
namespace declared on another code it hasn't seen.

**The harder part: does a namespace even reach a Type ID only
discoverable after a Wrapper stack fully resolves?** Checked the actual
mechanics: `§4.1`'s Wrapper resolution always re-parses fully
reassembled bytes as one standalone Record, decoupled from whatever
Sequence the outer Wrapper Record came from — and the prototype's own
resolver (`resolveStack`) had no defined behavior for a namespace
declaration coexisting with a Wrapper Record in the same code's
Sequence; this was simply never asked before. Resolved by extending the
namespace to cover both cases uniformly: a namespace declared in a
code's Sequence applies to every Record in it *and* to whatever a
Wrapper stack in that Sequence ultimately resolves to.

**Considered and rejected: a weaker rule where a Wrapper-reachable Type
ID only needs the namespace on *some* code contributing to
reassembly.** Rejected once checked against the actual robustness
story: `parity_scheme` recovers a missing *fragment's bytes*, but a
namespace declaration lives outside the Split group's own fragment
data — losing the one code that carried it loses the namespace
outright, even while the Split-protected content is fully intact via
parity. "Content is loss-tolerant, but the namespace needed to
interpret it isn't" would have been a real, inconsistent robustness
story. Requiring literal per-code repetition avoids that asymmetry
entirely.

**The wire-cost math, verified against the real encoder, went through
one real correction along the way.** An initial estimate used
`32769`-style examples that predate the parity-based redesign and
weren't actually the minimum — a genuinely minimal odd uint (`1`, `3`,
`5`...) costs 2 bytes bare, not 4, since CBOR packs any value `0`–`23`
into the initial byte with no argument bytes. Recomputed with the real
minimum: a single repeating namespace-scoped ID (saving 8 bytes against
a self-allocated-even baseline) already clears the discriminator's own
per-code repetition cost on its own — a net win, not a breakeven the
earlier estimate implied. Fixed the stale examples project-wide; see
FINDINGS.md.

**General principle, not just a footnote on one worked scenario.** A
plain sibling Record's namespace-scoped Type ID is typically repeated
on every code, so shrinking it saves the shrink *N times*; a Type ID
only reachable after a Wrapper stack fully resolves exists exactly once
for the whole group, so shrinking it saves the shrink exactly once,
never something that scales with code count. Crediting a
Wrapper-reachable ID's shrink as if it repeated N times overstates how
quickly a repeating discriminator's own per-code cost gets cleared. Now
also stated directly in spec §3.5.

Prototyped in `prototype/src/wrappers.js`'s `resolveStack` (reads each
code's discriminator via `header.parseDiscriminator`, requires
agreement across every code that declares one) and
`prototype/test/multi-code-namespace.test.js`: the repeated case
resolving correctly through full Split reassembly, the
single-point-of-failure case reproduced directly (a namespace declared
on only one code survives while that code is present and aborts the
instant it's dropped, even though parity fully recovers the content
regardless), disagreeing codes rejected outright, and the
no-namespace-anywhere case aborting the same as the single-code case.

## Own-URI-scheme carriers skip magic AND namespace-scoping — a real gap found by pushing TagDrop's cost question one step further

Asked directly, once the corrected small-odd-uint numbers still left a
real gap against TagDrop's own lean per-sector cost: how much of QDEF's
remaining tax is actually necessary for an adopter in TagDrop's
specific position? Checking TagDrop's real SPEC.md answered it: every
one of their codes is `tagdrop:<base41-cbor-sequence>` — their own URI
scheme, not byte-mode QR. §1 already has a rule for this (an
application with its own scheme should carry its envelope directly
under it), but it wasn't actually being applied to this document's cost
comparisons, which had included a 4-byte magic header per code all
along.

**Pushed one step further: does the same isolation argument also remove
the need for namespace-scoping?** Yes, for the identical reason.
Namespace-scoping (§3.5) exists to let unrelated apps' small Type IDs
coexist in one *shared, generic* container. An application whose
carrier already guarantees nothing but its own decoder will ever see
these bytes has already solved that problem by a different, pre-existing
mechanism. Paying the discriminator's per-code tax on top buys nothing:
a small, self-allocated even Type ID (the `32768`+ First-Come tier, no
registry needed) is exactly as collision-safe *in that deployment* as a
namespace-scoped one, since the two decoders that could disagree never
both see the same bytes.

**The corrected cost picture, verified against the real encoder:**

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

**Numbers updated for the mandatory container discriminator** — cheaper
than the old optional Type `0` Record header this table originally
priced. Recomputed directly from `prototype/test/custom-scheme-carrier.
test.js`'s own verified per-code figures.

Each row is a real, previously-unapplied instance of a principle this
document already stated — recognizing that "own URI scheme" and "own
MIME type" already buy *two* things (dispatch AND isolation), and this
project's own cost comparisons had only been crediting the first.

**The remaining +8 byte gap (own-scheme, self-allocated ID vs.
TagDrop's own envelope) is not waste.** It's the cost of a typeID being
a self-describing, open-ended registry entry, meaningful to any future
or generic reader, versus TagDrop's `type` byte, a closed, app-private
2-value enum. A genuinely different capability, not inefficiency.

**Gap found in the process, closed rather than left implied:** §2
stated the "own URI scheme, skip magic" principle but, unlike the NDEF
case, never worked it out concretely or tested it. Fixed: §2 now has a
parallel paragraph, §3.5 gets matching namespace-skip guidance, and
`prototype/test/custom-scheme-carrier.test.js` demonstrates both.

**A real gap in the isolation argument, found by pressure-testing it
against TagDrop's actual implementation practice.** Isolation-based
collision safety for a self-allocated even Type ID is a property of
*the carrier at the point of consumption*, not of the bytes — nothing
in an even Type ID's own encoding marks it as reachable only through an
isolating wrapper. Asked TagDrop directly whether that assumption holds
for how they build things: it doesn't, cleanly. TagDrop deliberately
reuses the identical CBOR-sequence bytes across two carriers — the same
bytes get Base41-encoded into their `tagdrop:` URI *and* dropped raw
into an NDEF record under their own MIME type. Both current carriers
happen to preserve isolation, so nothing is broken today. But the
practice itself — one shared codepath producing bytes wrapped
differently depending on transport — is exactly the shape of thing that
silently stops being safe the moment a *third* carrier is added without
equivalent exclusivity.

**The deeper issue is a real tension this mechanism has that the spec
previously understated.** An application that wants any recognizability
by tools other than its own decoder is, by definition, choosing not to
stay permanently isolated — for that application, leaning on isolation
as the collision-safety mechanism for its even Type IDs works against
its own stated goal. Namespace-scoping or an eventual First Come First
Served registry entry are the carrier-independent alternatives.

Added the caution directly to spec §2/§3.5 — an implementer reusing
binary internals across carriers needs to verify *every* carrier those
bytes can reach provides isolation, not just the primary one. See
FINDINGS.md for the full story.

**A better pattern than either self-allocated-even or transmitted-
namespace, surfaced by asking TagDrop what their own decoder actually
does internally.** TagDrop's own implementation already "reinserts" a
container discriminator internally when content arrives via a carrier
that implies it (their `tagdrop:` URI) — even though the transmitted
bytes never carry one, matching §2's guidance. What gets reinserted: a
*real* namespace value, not a placeholder.

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
carrier application, superseding plain self-allocated-even as the
default suggestion (still valid, just no longer the first thing to
reach for). Requires exactly one discipline: the implied namespace
value must be identical across every one of the application's own
carriers, or the pattern's safety collapses back to the even-ID case.
See FINDINGS.md #29.

§3.1's form boundary excludes CBOR major type 1 (negative integer) from
valid typeID prefix forms. Negint is different from array/map/tag/
simple: it's a scalar, exactly as skip-safe as uint, and structurally
available — checked directly against the parser
(`isTypeId`/`parseRecords`) that an unrecognized negint prefix item is
already silently skipped as forward-compat padding today. That makes it
the one remaining major type a future revision could assign a
typeID-adjacent meaning to without a version bump.

Two candidate uses were raised and both were set aside:

**Split the standard/scoped distinction across uint vs. negint, instead
of even/odd-on-uint.** Would remove one real hazard (a forgotten-parity
ID silently becoming "standard global" instead of erroring), but
even/odd-on-uint already shipped and works, and CBOR negint costs a
value-transform tax most host languages' CBOR libraries impose for no
corresponding safety benefit over a parity check in generate/validate
tooling. Not worth the churn.

**Reserve negint for a future back-reference/pointer typeID**,
resolving "Type ID inheritance" and "Reference/value-sharing tags,"
both above, without their original version-bump blocker. Both were
shelved because their original shape — redefining "no prefix typeID
present" to mean "inherit the previous Record's" — silently changes
the meaning of already-shipped bytes. An *explicit* negint-form
back-reference doesn't have that problem: an old decoder sees a
well-formed CBOR item it doesn't recognize, skips it as padding, and
the Record's typeID identity comes only from whatever bare uint or
namespace-pairing item precedes it — if none, the Record is simply
`ignored: true`. So the version-bump objection doesn't actually apply
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

**Wire shape updated since this entry was written.** The decision below
(a per-Record namespace override, taking priority over the container's
ambient one) is still exactly current. Its encoding is not: the
2-element `[namespace, typeId]` array this entry describes was later
replaced by a flat leading element on the Record's own array —
`[namespace, typeId, ...]` — once every Record became self-delimited
(see "Every Record became a self-delimited array"). Kept for the real
trail; read `[namespace, typeId]` below as "the namespace and typeId
elements," not a literal nested array.

Asked directly: should one container support declaring more than one
namespace, so a single physical code could mix content from several
genuinely unrelated apps, each with its own compact, namespace-scoped
Type IDs?

**The stated assumption ("one code, one app, plus shared standards")
already describes what the existing single-namespace design provides.**
"Community standards" already live in the always-global even tier,
interpretable unconditionally regardless of any namespace. Declaring a
namespace only adds a second, compact lookup space for the one app's
own odd Type IDs — nothing in that scenario needs a second namespace.

**The scenario that would actually need one — two unrelated apps in the
same code, both wanting their own compact namespace-scoped IDs
simultaneously — isn't unserved today either.** Any number of unrelated
apps can already share one physical code as sibling Records, each
dispatched by its own distinct global Type ID (common-vocabulary or
self-allocated `32768`+, no registry needed). What they can't both get
is the compact small-ID discount at the same time — that stays reserved
for whichever one app owns the code's single namespace declaration.

**Two ways to build actual multi-namespace support both cost real
compactness for the common case, for a rarer one nobody has asked for:**

- *Multiple namespace declarations, position-based* (a second one
  starts a new scope for whatever follows it) reintroduces stateful,
  order-dependent parsing this project has deliberately kept out of
  every other mechanism — there is no cross-code Record continuity
  anywhere in the format. A decoder would need to track "which segment
  am I currently scoped under" instead of a flat, order-independent
  lookup.
- *The discriminator carries an array of namespaces, each scoped Record
  selects one explicitly* adds a mandatory selector field to every
  namespace-scoped Record, undermining namespace-scoping's entire value
  proposition: pay once at the header, every subsequent small ID is
  free.

**A third option sidesteps both objections.** Let a Record's own prefix
optionally carry a **namespace-pairing item**, a 2-element array
`[namespace, typeId]`, instead of a bare typeID (spec §3.1). When
present, it declares/overrides *that one Record's* namespace, taking
priority over the container's ambient one; every other Record is
unaffected. No stateful position-dependent parsing (a pairing item is
entirely local to the one Record carrying it), and no mandatory
selector on every namespace-scoped Record (the common case still uses a
bare typeID and pays nothing extra).

**Structural, not semantic, at the mandatory-core level.** The core
needs exactly one new recognition rule — a definite-length 2-element
array at the typeID position is also a valid prefix-item shape — and
pulls the second element in as an ordinary typeID candidate. It never
learns what the first element *means*; exposed raw
(`Record.localNamespace` / `Record::local_namespace()`), the same
core-exposes-it/interpretation-layer-decides split the discriminator
already uses. `header.js` gained `resolveLookupKeyForRecord`, preferring
a Record's own `localNamespace` over the ambient header when both are
present.

**Not a cheaper way to get a namespace-scoped ID — an opt-in override.**
Unlike the container discriminator (paid once, amortized across every
Record), a pairing item is paid fresh on every Record that uses it.
Cost of the prefix item alone:

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
payload slot, §3.1, is covered in the prototype's core tests; there's no
longer a backup-typeID
interaction to test, since that mechanism was retired.)

Cross-validated in `rust/qdef-core`: `parse_record`'s Phase 1 gained the
identical structural recognition rule (a definite-length 2-element array
is a valid prefix-item shape; its second element is pulled in as an
ordinary typeID, its first is exposed raw via the new
`Record::local_namespace()`), with zero namespace-semantic code added to
the crate — matching the container discriminator's own precedent. Tests
confirm the pairing round-trips for both namespace forms and degrades
correctly when a Record carries no pairing item.

## Text string Type IDs — historical: the reserved slot became the NDEF-ID, then the payload slot

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
position for something with a clearer job: first the NDEF-ID-equivalent
(historical, see earlier entries), then the payload slot (spec §3.1),
which accepts both text strings (as plaintext) and byte strings (as
opaque content).

Every one of the three gaps this entry originally closed carried
forward into the payload slot's own spec text almost verbatim,
since they're properties of "a bare text string prefix item," not
specific to what it used to mean as a Type ID: definite-length required
(§3.4 already covers this for every encoder-emitted string, not just
this position), exact raw-UTF-8-byte comparison for anyone matching
against it, and no ambiguity about what "reserved" meant, since the slot
is no longer reserved at all — it has exactly one meaning now. See
spec §3.1's "Payload" subsection.

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
optional strengthening: derive a decentralized ID from a hash of its
own name, so the binding is independently checkable. The spec text
wrote this as `ID = truncate(hash(name), N)` — precise-sounding but
not: no hash function named, no string encoding, no truncation rule,
`N` an "open parameter."

Checking the real prototype surfaced a live bug matching the gap
exactly: `verifyTypeHint` called `deriveHashId` with no width argument,
so it always truncated to 4 bytes regardless of the candidate ID's
actual magnitude — a genuinely wide ID, exactly what TagDrop's own
existing Type IDs are, could never verify. "Anyone can independently
check" was false in practice for the width this project's own real
adopter uses.

**Fixed by making `N` a developer choice, outputting a byte string.**
With the prefix typeIDs design, decentralized IDs became CBOR byte
strings, not uints — the developer chooses `N` directly, wider means
more collision-safe. Digest[0..N] of SHA-256 over the name's raw UTF-8
bytes, as a definite-length byte string. A second bug caught while
fixing the first: comparing the derived byte string against the
candidate needed `Buffer.equals()`, not `===` (reference identity is
never safe for byte strings).

**The namespace mechanism's own hash-check went from claimed to real**
in the same pass — `header.js`'s `verifyNamespaceHint` was implemented
for the first time, calling the same shared derivation rather than a
second implementation.

**Postscript, caught much later: `verifyNamespaceHint` itself quietly
disappeared, and nobody noticed for a while.** When Type Hint moved
from the field Map into the prefix (an unrelated redesign pass),
`typeHint.js` was deleted and `verifyNamespaceHint` went with it,
with no corresponding doc update. QDEF-SPEC.md and this file kept
citing it as prototyped across several later redesigns, until a
routine documentation-consistency sweep during the record-architecture
redesign re-checked the claim against `prototype/src/header.js` and
found it false. Restored as a small, standalone function in
`header.js` (no `typeHint.js` to depend on anymore — `N` is simply the
candidate namespace's own byte length now), with a fresh regression
test set. Worth recording as its own small finding: a doc that cites a
specific function name is a checkable claim, not just prose, and this
one drifted silently for longer than it should have.

Prototyped in `prototype/test/header.test.js`. See FINDINGS.md #21 for
the original bug, and FINDINGS.md for this restoration.

## Pinning the algorithm only solved half the naming problem — the input still has to be collision-resistant

Fixing the hash-derivation algorithm (above) answered "how do two
implementations compute the same thing." It didn't answer a different,
equally real question, asked directly right after: does the spec tell
anyone how to *choose the name* so two unrelated implementations don't
land on the same thing by accident? It didn't, anywhere.

This is the difference between hash-derivation actually delivering the
collision-safety it claims and merely looking like it does. `ID =
truncate(SHA-256(name), N)` is only as collision-resistant as `name` is
diverse. Two unrelated projects independently naming their config
record `"config"` derive the *exact same* ID — a certain collision, not
a low-probability one, since the function is deterministic and "short
sensible English words for a common concept" is a small, overlapping
space across unrelated authors.

**The fix is the same one every other namespaced-identifier system
uses:** qualify the name by something the namer actually, verifiably
controls — reverse-domain notation, the Java-package/XML-namespace/
MIME-subtype convention — rather than a bare word. A domain two
unrelated parties could both plausibly register is already vanishingly
unlikely by DNS's own allocation guarantees, which restores the
birthday-bound math this project leans on elsewhere.

**Scoped correctly:** this only matters where nothing else already
protects the value — a namespace's own Hint name (§3.5). A
Record-Type-local Hint name used *inside* an already-declared namespace
doesn't need qualifying, since collision-safety there already comes
from the namespace itself.

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
