# Prototype findings: what round-tripping actual bytes found

The QDEF design (`docs/QDEF-SPEC.md`) went through several rounds of prose
review before any code existed. This document records what changed once a
[throwaway Node prototype](../prototype) actually encoded and decoded QDEF
containers — the four scenarios required were: a plain Record, a
wrapped-third-party-payload Record, a full Split(parity)→Encrypt→plain
Wrapper Record stack with fragment loss/recovery, and the even/odd
criticality rule. All four round-trip correctly; the value was in what
building them forced the design to actually decide.

Nothing here is catastrophic — the core shape of the design holds up. But
"holds up" required making several decisions the prose left implicit, and
one place where the prose's own stated rationale turned out to be
overstated. That's the actual point of building this: prose review can't
surface either kind of gap.

**Non-normative, and not a maintained snapshot.** [`QDEF-SPEC.md`](QDEF-SPEC.md)
is the only source of truth for the current wire format; if anything
below conflicts with it, `QDEF-SPEC.md` wins. Entries here are numbered
chronologically and describe a mechanism *as it stood when written* — a
later entry can supersede an earlier one without the earlier one being
rewritten, only marked (**Later superseded**) when someone notices.
Landing on an entry via search rather than reading in order can surface
something already replaced; check for that marker before trusting a
wire-shape detail as current, and verify against `QDEF-SPEC.md` directly
when in doubt. This applies to an LLM agent reading this file too:
treat it as a decision trail, not a spec.

## Fixes folded back into the spec

### 1. Hardware Parity: what happens when the tag and key 0 disagree? (historical)

§3.1 originally said a Record's CBOR tag and its `map[0]` carry "the *same*
ID" but never said what a decoder should do if they don't — e.g. a Record
tagged `105` whose `map[0]` says `100`. Left unspecified, a tag-aware
decoder and a constrained (key-0-only) decoder could each read a *different*
Type ID out of the identical bytes, silently disagreeing about what the
Record even is.

**Fix (historical):** a tag/key-0 mismatch was a hard abort of that Record
(same class of failure as an unrecognized critical key) — verified in
`prototype/test/core.test.js`.

**Later superseded:** the tag route and key-0 routing this finding is about
no longer exist — see finding #12. Routing is now via prefix typeIDs. Kept
here as an accurate record of what shipped at the time; the mismatch case
it fixed is moot once both routes were removed.

### 2. A Record with no prefix typeIDs at all (historical)

Not addressed anywhere when key 0 was the routing mechanism. Prefix typeIDs
are now how *every* parser routes a Record, so a Record missing its prefix
can't be routed by anyone.

**Fix (historical):** treat a missing prefix typeID the same as an
unrecognized-critical-key abort of that Record.

### 3. Split's fragment-chunking algorithm doesn't exist in the spec

§4.1's Type-2 example shows the *fields* of a Split fragment (`group_id`,
`index`, `count`, `fragment bytes`, `total_bytes`, `parity_scheme`) but
never says how the original bytes get sliced into fragments. That's
invisible until two independent encoders/decoders need to agree on it —
which `parity_scheme` does immediately: XOR parity needs every fragment
zero-padded to a common length, and recovering a missing fragment needs
to know *that fragment's* true length, which nothing provides if it's
simply absent.

**Fix applied in the prototype:** fixed, deterministic chunking —
`chunkLen = ceil(total_bytes / count)`, fragments sliced sequentially,
last fragment shorter if `total_bytes` isn't an exact multiple of
`count`. Any two independent implementations following this formula
agree without coordination.

**Real tradeoff this exposes, left as an open question:** uniform
chunking is what makes single-fragment XOR recovery well-defined, but
it's less flexible than what a real encoder probably wants — different
physical codes (different QR versions/ECC levels, an NFC tag smaller
than a QR sibling) plausibly need different-sized fragments, chosen
per-code. Uniform chunking and per-code-flexible sizing are in tension;
the spec picks neither yet.

**Update:** checked against a real adopter — `mofosyne/tagdrop`'s own
sectorization already assumes uniform chunk length within a split group,
so this tension costs that adopter nothing; QDEF's rule matches what its
format already does. Evidence for one usage pattern, not a general
resolution — see DESIGN.md's updated entry.

### 4. `total_bytes` (key 9) is documented OPTIONAL but isn't, once `parity_scheme` is set

§4.1 frames `total_bytes` as a nice-to-have (progress bars, buffer
pre-sizing) and deliberately gives it an odd/optional key number. That's
correct for the no-parity case — plain reassembly is just "concatenate
fragments `0..count-1`, whatever lengths they carry." But the moment
`parity_scheme` is set and a fragment is actually missing, the decoder
*must* know that missing fragment's exact byte length to correctly truncate
the XOR-recovered, zero-padded result — and (given fix #3's uniform
chunking) that length is only derivable from `total_bytes`.

**Fix:** `total_bytes` stays an odd/optional *key* (the even/odd wire rule
is unaffected — an old decoder that doesn't understand key 9 should still
ignore it, not abort), but Type 2's own Record-Type definition now states:
`total_bytes` MUST be present whenever `parity_scheme` is present. This is
a Type-2-specific validity constraint, not a change to core criticality
semantics — verified by `splitDecode` refusing to guess in
`prototype/src/wrappers.js`.

### 5. `group_id` is content-addressed — the spec should say decoders MUST verify it

§4.1 already explains *why* `group_id` is a content hash rather than an
issued serial (no coordination needed between independent encoders). What
it doesn't say: that same hash is a free integrity check after reassembly,
and a decoder that skips it can hand an application silently-corrupted
bytes if a fragment was damaged in a way that didn't change its length.

**Fix:** the prototype's `splitDecode` recomputes the hash over the
reassembled bytes and rejects a mismatch; the spec should mandate this
rather than leave it as an implementer nicety.

### 6. Encrypt names a cipher but never a key source

§4.1's Type 4 example says "e.g. AES-GCM" and shows `nonce` +
`ciphertext+tag` fields, but nothing in the draft says where the key comes
from — passphrase KDF, pre-shared secret, recipient public key wrap,
something else. For §8's PGP-backup example specifically this is not a
minor omission: "Encrypt wrapper" is meaningless as an interoperable
mechanism without it, since two independent apps using Type 4 need to agree
not just on AES-GCM but on how the key got there. The prototype sidesteps
this entirely (tests pass a raw 32-byte key directly) — which is precisely
how prose review missed that the spec never actually answers it.

**Update:** resolved — spec §4.1 adds an optional Algorithm field (key `5`)
and Key Algorithm field (key `7`) to Type 4, both a COSE Algorithm ID
(RFC 9053/9054) or a plain string. Borrows an existing, actively
maintained IANA registry rather than inventing a QDEF-specific one — the
same pattern §4.3's Media Type uses, and for the same reason: a cipher
and a key-agreement scheme both already have a stable identity independent
of QDEF. See DESIGN.md's "Encrypt key provisioning" entry for the full
reasoning, including why this doesn't need Type Hint's decentralized-ID
layer either.

### 7. Nesting order is *not* decoder-detectable — confirmed, not just assumed

The spec (now DESIGN.md) already asked whether `Split → Encrypt → Compress`
is "just documented convention" or something a decoder could reject if
violated, and leaned ("not resolved") toward trusting the encoder. The prototype turned this
from a guess into a demonstrated fact: `prototype/src/wrappers.js`'s
`resolveStack` is a generic, type-directed resolver (unwrap whatever
wrapper Type ID is next, recurse, stop at the first non-wrapper Record) —
built once, with zero knowledge of "correct" order. It was run against both
the documented order (Split outermost) and a deliberately reversed one
(Encrypt applied per-fragment, Split innermost) — both decode to the
identical terminal Record with no error, no signal, nothing to distinguish
them (`prototype/test/nesting-order.test.js`).

This also means §4.1's stated rationale for the fixed order overstates its
case. It says "Split must be outermost — decompression/decryption need the
complete byte string, which only exists after reassembly," phrased as a
structural necessity. It isn't one: encrypting each fragment individually
(reversed order) is well-defined and round-trips fine, just at the cost of
a separate nonce/auth-tag per fragment instead of one for the whole
payload. The real reason to prefer Split-outermost is efficiency and
simplicity (one encrypt/compress operation instead of N), not correctness.

**Fix:** DESIGN.md's open question is now answered, not open — "trust the
encoder" is confirmed correct, but for a different reason than stated:
non-conformant order isn't just *undetected*, it's *unenforceable* by any
decoder built the natural (generic, recursive) way, and there is no
efficient way to make it enforceable without wrapper types carrying
redundant "what should be outside me" metadata that the format doesn't
otherwise need. §4.1's rationale text should be corrected to say
"recommended for efficiency," not "required for correctness."

## Findings from the Rust core-parser prototype

The Node prototype above validated the *design* — but it validated it using
Node's `cbor` npm package, which does all the real CBOR work (tags, maps,
streaming) for it. That left one of the spec's own claims (§3.3: a "deeply
constrained embedded scanner with no semantic-tag-aware CBOR library" can
implement the mandatory core) completely unverified — Node can't tell you
whether that's true. [`rust/qdef-core`](../rust/qdef-core) is a second,
independent implementation of the mandatory core only (not the standard record type
Wrapper layer), written `#![no_std]`, with zero dependencies and zero heap
allocation — including hand-rolling the CBOR primitives instead of using a
crate for them, since using one would just re-test the Node prototype's
finding a second time.

### 8. The "minimal core" claim is true, and now has a number attached

Built in release mode for `thumbv6m-none-eabi` (Cortex-M0 — one of the most
constrained ARM targets in common use, no atomics beyond the basics), the
entire mandatory core — magic framing, full CBOR-Sequence walking,
prefix-typeID routing, Hardware Parity mismatch detection, plus the even/odd
criticality helper and a field-lookup helper — compiles to **~3.7 KB of
code** (see #9 below for why that number moved), with **zero `unsafe`** and
**zero heap allocation**. §3.3's claim that a minimal implementer's surface
area is genuinely small was previously just prose confidence; it's now a
measured, reproducible number tied to a real embedded target.

### 9. Unbounded recursion depth wasn't just bounded — it was designed away entirely (historical: the field-value-shape rule this produced was later dropped)

**Later superseded.** The field-value-shape rule this finding produced
(MUST be a scalar or definite-length string, never a bare array/map/tag)
was itself dropped entirely in a later redesign — a field value MAY now
be any well-formed CBOR item (see the "Field-value-shape rule" entry
below, and DESIGN.md). The *mechanism* this finding is really about —
skip-safety without true recursion, via a bounded explicit stack instead
of a shape restriction — survived and is exactly what made that later
relaxation safe to do: `skip_value`'s non-recursive arithmetic became
`skip_any_item`'s bounded-stack walk, generalized to arbitrary shapes
rather than eliminating the need to walk them. Kept here as the real
trail for how that mechanism was first discovered and validated.

First pass: skipping past a Record field (or an entire Record) the parser
doesn't recognize requires generically walking arbitrarily-nested CBOR
structures — arrays inside maps inside tags, etc. Written the natural way
(recursively), this has no inherent bound on stack depth: a malformed or
adversarial input with deeply nested structures could exhaust the stack on
a small MCU with a few KB of RAM. This is invisible when a hosted CBOR
library does the walking for you inside a process with megabytes of stack
and its own (possibly absent) guard — which is exactly why it never came up
in the Node prototype. The first fix was a `MAX_DEPTH` guard in
`rust/qdef-core/src/cbor.rs` (`skip_value` erroring past a fixed recursion
limit) — bounded, but still recursive.

A follow-up design review (prompted by comparing QDEF's problem to how
Protobuf's wire format handles the identical concern) asked a sharper
question: where does the recursion actually come from? Not from every CBOR
type — unsigned/negative integers, simple values, floats, and
definite-length byte/text strings are all skippable in O(1), because their
length is stated directly in their own head bytes. The recursion is
entirely confined to bare arrays, nested maps, and tags as a field's
*value* — types whose length isn't knowable without walking their contents.

**Fix:** rather than bound that recursion, remove the case that causes it.
§3.2 now includes a field-value-shape rule: a Record field's value (for any
key, recognized or not) MUST be a scalar or a definite-length string —
never a bare array, map, or tag. Structured content must be CBOR-encoded
separately and carried as a byte string's payload instead (the same
opaque-until-unwrapped pattern §4.1's Wrapper Records already use, applied
one level down, at individual fields instead of only whole Records). This
is the same trick Protobuf's wire format uses for exactly the same reason —
every field is varint/fixed-width/length-delimited, so skipping an unknown
one is always cheap — not a novel or risky pattern.

Checked against every existing worked example before adopting it: Wi-Fi
(100), Ticket (105), and all three Wrapper Records (Split/Compress/Encrypt)
already only ever use scalar or byte/text-string field values. Zero
retrofit cost. `rust/qdef-core/src/cbor.rs`'s `skip_value` was rewritten
from a recursive walker with a depth guard to pure non-recursive,
non-looping arithmetic — `MAX_DEPTH` and the whole recursive
skip_string/skip_items/skip_until_break machinery were deleted outright,
not just tuned. That shrank `skip_value` itself from 836 bytes to 284 bytes
(release, Cortex-M0) and the crate as a whole from ~4.4 KB to ~3.7 KB (#8).
Tests confirm both directions: a bare array as a field value is rejected
outright even under an otherwise-ignorable odd/optional key
(`field_value_shape_rule_rejects_a_bare_array_even_under_an_odd_optional_key`),
and the sanctioned byte-string-wrapped alternative round-trips its opaque
nested CBOR payload byte-for-byte
(`structured_content_is_carried_as_an_opaque_byte_string_and_skips_at_zero_cost`).

The broader lesson: the first fix (bound the recursion) treated the symptom
and would have shipped as "good enough." Asking *why* the recursion existed
at all — rather than just how deep it could safely go — found a fix that's
smaller, simpler to reason about, and cheaper to run, not merely safer.

### 10. A malformed (not just unrecognized) Record can desync the whole Sequence — the spec's "isolated failure" promise has an unstated precondition

§3.2 promises an aborted Record doesn't affect its siblings in the same
Sequence. That promise silently assumes the Record is at least
*well-formed* CBOR — its byte length needs to be determinable to know
where the next Record starts. A genuinely malformed byte stream
(truncated, an invalid length prefix, a reserved additional-info value)
means the parser can no longer find that boundary, so it can't safely
resume the Sequence at all — a fundamentally different, worse failure
than "this Record's Type/keys aren't recognized." (At the time this was
found, the same was also true of a Record violating finding #9's
field-value-shape rule; that rule was later dropped, so this second
case no longer applies — see finding #9's own update.) This distinction
was invisible in the Node prototype, where `cbor.decodeAllSync` either
decodes the whole sequence or throws for all of it. Writing the Rust
`Records` iterator by hand forced the decision: it distinguishes
"Record aborted but Sequence continues" (missing prefix typeIDs — see
findings #1–#2) from "Sequence itself is unrecoverable" (malformed
CBOR), and only the former lets iteration continue.

**Fix:** §3.2 should state this precondition explicitly rather than leave
it implicit — an aborted-but-well-formed Record doesn't affect siblings;
malformed CBOR at the Sequence level is a stronger failure with no
per-Record isolation possible.

## Findings from a spec review pass

### 11. The Smart Route's tag numbers collide with the IANA CBOR tag registry — Hardware Parity's key-0 route does not, verified both ways

A fresh review pass questioned whether "wrap the Record in a CBOR tag equal
to the Type ID" (§3.1's Smart Route) is actually safe, given CBOR tag
numbers are a shared IANA registry (RFC 8949 §9.2), not QDEF's own
namespace. Checked against a real decoder rather than left as a plausible
worry:

```
Tagged(2, <byte string>)  ->  decodes to a BigInt   (tag 2 = unsigned bignum)
Tagged(0, "2026-...")     ->  decodes to a Date      (tag 0 = date/time string)
Tagged(0, <a Record map>) ->  decodes to Invalid Date
```

Types 2/3/4/5 (the entire Wrapper standard record types) and Type 100 (the flagship Wi-Fi
example) all reuse tag numbers IANA has already assigned real, live meaning
to. QDEF's own worked examples aren't hypothetically at risk — they're
already using colliding numbers today. A permissive decoder happens to fall
back to passthrough when the tagged content doesn't match the registered
type's expected shape (a byte string for a bignum, a text string for a
date) — but a stricter conformant decoder, precisely the tag-aware audience
the Smart Route exists to serve, is entitled to reject or mangle it, and
wrapping an actual Record map in tag 0 demonstrably does mangle it.

The follow-up question — does Hardware Parity's *other* route, key `0`,
have the same problem? — was checked, not assumed. It does not, and the
reason is structural: CBOR's IANA Considerations register tag numbers
and simple values, but there is no registry for map keys, because a
bare CBOR map carries no built-in semantic layer the way a tag does. A
generic decoder has nothing to coerce key `0` into; it's just data until
a QDEF-aware parser gives it meaning. Verified: encoding the identical
Record map with *no* tag round-trips through a generic decoder as inert
data (`map.get(0) === 100`, no coercion), while the same map wrapped in
tag `0` decodes to `Invalid Date`.

**Fix:** at the time this was written, left open pending a decision between
three wire-format resolutions. Superseded — see finding #12: the tag route
was removed outright, for a reason beyond the collision this finding
verified.

### 12. The tag route wasn't just collision-prone — it was the wrong mechanism, and removing it simplified the core

Finding #11 verified a real, reproduced IANA tag-number collision and
confirmed key `0` was unaffected. That was enough to justify *a* fix, but
not enough on its own to justify which fix — a wider or offset tag range
would have dodged the specific collision without addressing why it
happened. A follow-up review pass asked what a CBOR tag number is actually
*for*: RFC 8949 §3.4's model is one tag number carrying one predefined,
universal interpretation of a data item (a byte string *is* a bignum, a
text string *is* a date) that any implementation can look up and apply —
not a private space handed out in bulk for one application's internal
dispatch table. Under that model, "tag == Type ID" was never a sound
mechanism, independent of which specific numbers happened to be free at
any given moment; "offset into unassigned tag space" (one of finding #11's
three candidate fixes) would have preserved the exact category error on
numbers that merely hadn't collided *yet*.

**Fix:** the tag route (the "Smart Route") is removed outright. Prefix
typeIDs are now the sole Record Type ID routing mechanism — §3.1 no longer
describes two routes, only one. This is a genuine simplification of the
mandatory core, not just a safer version of the old design: `rust/qdef-core`'s
`parse_record` no longer needs to branch on CBOR major type 6 to detect an
optional tag, the `Record` struct no longer carries a `tag` field, and
`AbortReason::HardwareParityMismatch` (finding #1's fix) is dead code once
there's nothing left to mismatch against. The one place a CBOR tag still
legitimately appears in QDEF — §3.2's optional tag-24 hint on an
individual field's byte-string *value* — was never affected by any of
this: it's a Record-Type author's own opt-in annotation about one field's
content, exactly the "predefined, universal meaning" use tags are
correctly for, not a mechanism QDEF's core routing depends on.

### 13. A Wrapper Record's Type ID is itself a public declaration — fine for Split/Compress, a real problem for Encrypt when deniability matters

Checked against a real adopter's threat model, not surfaced by prototyping
or prose review: `mofosyne/tagdrop`'s own encryption (SPEC.md §9) uses
AES-256-GCM — an exact match for COSE's `A256GCM` (= 3), confirming §4.1's
Encrypt Algorithm field picked the right registry and the right value for
at least one real cipher choice. But TagDrop's `encryption` field is
explicitly documented as "an optional hint, not a precondition": the real
mechanism is trial decryption against known keys, confirmed only by
AES-GCM's own auth-tag success ("discovery, not declaration"), because
SPEC.md's stated goal is that ciphertext stays indistinguishable from
random. A QDEF Encrypt Wrapper can't preserve that property regardless of
how its fields are shaped: being wrapped in a Type-`4` Record at all is
itself a visible declaration — "this is encrypted" — to any QDEF-aware
parser walking the Sequence, even one that can't decode the payload,
because Type ID routing (§3.1) is unconditional and happens before any
per-Record-Type logic runs. Every Wrapper Record makes this same kind of
declaration (Split says "this is one fragment of something," Compress
says "this is compressed") — it's simply invisible as a cost for those,
since neither Split nor Compress has a reason to want to look like
un-fragmented, uncompressed data. Encrypt is the one Wrapper where an
adopter might specifically need the opposite: to not be identifiable as
encrypted at all.

**Not a bug to fix — a genuine, principled scope boundary**, the same
category as §1's "when QDEF earns its place": an application whose threat
model requires ciphertext indistinguishable from random has a requirement
QDEF's routing model is structurally unable to satisfy, since self-
describing dispatch is the format's entire reason for existing. TagDrop's
own §6 registration already sidesteps this correctly — its encryption
happens entirely inside the opaque registered blob, never at the QDEF
layer — which is exactly the right call, not a workaround. Also confirmed
directly against the IANA COSE Algorithms registry: PBKDF2 (TagDrop's
passphrase-based key-provisioning mode) has no COSE algorithm ID at all —
COSE's key-derivation entries are all HKDF variants — so even an adopter
without TagDrop's deniability requirement would hit Key Algorithm's
plain-string fallback for this specific case, not the numeric one.

### 14. The Node prototype's own dependency mis-encodes large Type IDs — caught only because a real adopter used the private-use tier as recommended

TagDrop is the first adopter actually using §9's `0x10000`+ private-use
tier as intended — a real ~64-bit random Type ID, not an illustrative
placeholder like every worked example in this repo (`100`, `105`, `2`–`5`,
`900`, `950`) has ever been. Checking that against this repo's own
prototype, not TagDrop's, surfaced a real bug: reproduced directly against
the `cbor` npm package used throughout `prototype/src/`, `cbor.encode()`
wraps *every* BigInt-typed input in CBOR tag 2 (bignum) — regardless of
magnitude, confirmed from `100n` (which trivially fits as a one-byte
native uint) up through `2n**64n - 1n`. Not a magnitude threshold, purely
"BigInt in, tag 2 out."

Why this would matter: any Type ID wide enough to need a JS BigInt (which
is exactly what §9 recommends for this tier, and exactly what routes
through `typeIds: [typeId]` in the record prefix) would violate §3.1's
requirement that prefix typeIDs be plain uints — for the one field the
entire minimal-core-parser design depends on being trivially readable. It's the
same underlying hazard findings #11/#12 already found and thought was
closed by removing the old Smart-Route tag-wrapping mechanism, resurfacing
through a completely different path: not QDEF's own wire-format design
this time, but a widely-used library's default behavior for a JS type
(`BigInt`) none of this repo's own worked examples ever needed, since
every one of them fits comfortably in a plain `Number`.

**Not currently live, but only by accident, not by design.** Checked
directly: `core.encodeRecordBytes` uses `cbor.encodeCanonical`, not plain
`cbor.encode` — a change made for an unrelated reason (§3.4's canonical-
encoding requirement) — and `encodeCanonical` does not exhibit this bug at
any magnitude tested. So the exact scenario reported (a real BigInt-class
Type ID) currently encodes correctly, verified against the live code, not
assumed. That's a fortunate side effect of the canonical-encoding switch,
not something anyone verified or tested for at the time it happened —
before that change (i.e. for this repo's entire history prior to this
session's canonical-encoding work), this bug would have been live for any
adopter following §9's own advice.

**Fix:** added a regression test suite
(`prototype/test/large-type-id.test.js`) that locks this in rather than
leaving it as an unverified side effect — including a test that documents
the dependency bug directly, so a future change back toward plain
`cbor.encode()` (for any reason) would be caught immediately rather than
rediscovered the same way this was. Also added a cross-implementation
fixture (`LARGE_TYPE_ID_CONTAINER`, Type ID = `u64::MAX`) proving the Rust
decoder reads a real large Type ID correctly too, not just assumed to
handle the full `u64` range from its `type_id: Option<u64>` field type.

**Worth generalizing as implementer guidance, not just a fixed bug:** any
QDEF implementation in a language with a similar split between "small
integer" and "big integer" CBOR encoding paths should verify its specific
encoder — not just its CBOR library's existence — actually produces a
native uint for a Type ID wide enough to need the bigger path, especially
for §9's private-use tier where that's the expected, recommended case,
not an edge case. This repo's own reference prototype had exactly this
gap for its entire history until now, never caught by any of its own
worked examples, only surfaced by a real adopter following the spec's own
advice literally.

### 15. §3.2's field-value-shape rule was more restrictive than it needed to be — tag 24 is skip-safe too, if bounded correctly

Filed as [GitHub issue #8](https://github.com/mofosyne/qdef/issues/8): the
original rule banned *every* CBOR tag as a field value, including tag `24`
("encoded CBOR data item," RFC 8949 §3.4.5.1), even though a tag wrapping
a definite-length string directly is exactly as skip-safe as a bare
string — its length is still just "read the string's own head," one fixed
step later than usual, never a walk. The existing "opaque byte string,
optionally tag-24'd *inside* its own re-decoded contents" pattern already
let an author signal "this is re-parseable CBOR" to something that opts
in, but never to a generic CBOR tool walking the container from the
outside — from there, a QDEF field's byte string looked identical whether
it held raw opaque bytes or further CBOR, unless that tool already had
out-of-band schema knowledge of the specific Record Type.

**The rule change needed one careful bound, not just a blanket
relaxation.** "Allow tags that are skip-safe" is true but dangerous if
stated loosely: if "skip-safe" is defined recursively (a tag wrapping
anything itself skip-safe, including another tag), adversarial input can
nest tag `24` inside tag `24` inside tag `24` arbitrarily deep — reopening
exactly the unbounded-recursion hazard the field-value-shape rule exists
to close (finding #9). The correct, narrower rule: tag `24` may wrap a
definite-length string *directly*, checked by one extra fixed header read
inline, never by calling the skip function back into itself. Verified this
distinction is real, not theoretical, with a dedicated fixture
(`NESTED_TAG24_CONTAINER`) constructed so the outer tag's immediately-
following item is itself a tag — genuinely different from (and still
allowed) a byte string whose own *contents*, once independently decoded,
happen to be tag-24'd, since that's invisible to the outer skip either way.

**Also narrower than "any skip-safe tag" for a second, independent
reason:** allowing arbitrary tag numbers here — not just `24` — would
reopen the "private, per-application enumeration" hazard the old
CBOR-tag routing mechanism was removed for (findings #11-#12), just at
the field level instead of the whole-Record level. Tag `24` specifically
is the one exception with a real, IANA-standardized, non-QDEF-specific
meaning; a fixture using tag `0` ("standard date/time string," also a
real registered tag) wrapping a byte string confirms it's still rejected.

**Fix:** `rust/qdef-core/src/cbor.rs`'s `skip_value` gained one new match
arm — tag `24` wrapping a definite-length string, verified inline rather
than recursively — keeping the "conformant core parser never needs to
recurse at all" property intact rather than merely bounding recursion
depth. Spec §3.2 rewritten accordingly. Three new cross-implementation
fixtures prove all three cases: the allowed shape round-trips, tag-in-tag
nesting is rejected, and a non-`24` tag is rejected. `clippy`, `fmt`, and
the `thumbv6m-none-eabi` embedded build all still pass.

**Update:** the "only tag `24`, no other tag" restriction described above
was itself narrower than it needed to be — widened in finding #16 below
after actually surveying what the rest of the tag registry looks like,
rather than assuming a wider rule was automatically unsafe.

### 16. The "only tag 24" restriction was itself overly cautious — surveyed the registry instead of assuming

**Later superseded again, more fully this time.** The content-shape
check this finding widened tag-24's restriction into (any tag number,
but content must be a definite-length string directly) was itself
dropped along with the rest of the field-value-shape rule (finding #9's
update) — a field value MAY now be any well-formed CBOR item, including
a tag wrapping an array or map. The bounded, non-recursive skip
mechanism this finding validated (`skip_any_item`'s explicit stack)
still does the safety work; it's just no longer paired with a content-
shape restriction on top of it. Kept for the real trail of how "any tag
number is safe, not just 24" was established.

Asked directly, rather than left as an assumption: does the rest of the
IANA CBOR tag registry (tags under ~1000) actually need excluding, or was
restricting finding #15's fix to tag `24` alone stricter than the real
safety property required? Checked the registry directly, not from memory.
It splits cleanly by each tag's own RFC 8949 definition — genuinely
scalar/string-shaped (dates, URIs, UUIDs, regex, bignums, base64/base16
conversion hints, typed numeric arrays wire-encoded as byte strings)
versus genuinely array/map-shaped by definition (decimal fractions and
bigfloats — a 2-element array; rational numbers; language-tagged strings,
`[language, text]`, easy to mistake for a bare string; COSE structures;
the "expected conversion" hints `21`–`23`, confirmed directly against RFC
8949 §3.4.5.2 to apply recursively over arbitrary structure, not just a
byte string, on request rather than assumed).

The content-shape check already built for tag `24` — content must be a
definite-length string *directly*, never another tag — turns out to be
exactly the right and sufficient bound regardless of *which* tag number is
on the wire, so restricting to a single number was doing no additional
safety work, just narrower than necessary. Verified this holds correctly
in both directions with new fixtures: `OTHER_TAG_WRAPPED_VALUE_CONTAINER`
(tag `0`, a real IANA tag, wrapping a definite-length text string) is now
correctly accepted; `STRUCTURED_TAG_WRAPPED_VALUE_CONTAINER` (tag `4`,
"decimal fraction," wrapping a real, plausible `[-2, 27315]` — meaning
273.15, not a contrived value) is still correctly rejected, proving the
bound tracks content shape, not tag number.

**Fix:** `skip_value`'s tag branch widened from `6 if head.arg == 24` to
plain `6` (any tag major type), with the same inline, non-recursive
content check as before. Spec §3.2 and DESIGN.md's rationale both
rewritten to describe the general rule rather than the tag-`24`-specific
case. `clippy`, `fmt`, and the `thumbv6m-none-eabi` embedded build all
still pass; 15 Rust tests (2 new) and 35 Node tests all green.

### 17. App Route (Type 7) — the AAR-equivalent deferred earlier in this project, built once a real adopter actually needed it

Building TagDrop's Paper port on QDEF surfaced three related questions
about the private-use Type ID tier, filed as [GitHub issue
#10](https://github.com/mofosyne/qdef/issues/10). One of them — should a
generic scanner be able to route a scanned code to a specific handling
application, the way NFC's Android Application Record does — had already
come up once earlier in this project's history and was deliberately left
unbuilt: "figure out later... as long as our QDEF system is flexible to
assign a Type ID to it later." This is that later.

Landed as spec §4.4, a plain standard record type (Type `7`, not a wrapper):

- **Domain-verified, not a bare string claim.** A package name or
  reverse-domain string can't prove anything — any app can claim to be
  `com.example.official`. A domain, verified the way Android App Links
  and iOS Universal Links already require (a `.well-known` file on a
  domain the claimant controls), inherits proven, already-deployed
  platform trust machinery instead of QDEF inventing a new one — the
  same "borrow, don't invent" instinct behind the COSE and CoAP registry
  choices elsewhere in this document.
- **Decoupled from payload-shape Type IDs, not folded into them.**
  TagDrop's own first draft of this idea (structuring a private-use Type
  ID as an app-id prefix plus a self-allocated subtype) was reconsidered
  and set aside in favor of this decoupled sibling-Record approach — it
  keeps an open, shared payload shape interoperable across independent
  handling applications, and needs no adopter to restructure their
  existing Type IDs to get auto-launch support. The structured-Type-ID
  idea wasn't wasted, though: kept as general private-use tier guidance
  (DESIGN.md's "Registry governance" entry) for implementers who want to
  reduce CSPRNG draws across their own several Record Types, independent
  of routing.
- **Dispatch stays local and OS-level**, matched only against what's
  actually installed on-device — no QDEF-level or central registry
  needed for routing to function at all, the same reasoning that already
  keeps registry governance (still open, above) from blocking anyone
  using the private-use tier today.

Prototyped in `prototype/test/app-route.test.js`: round-trips with and
without the optional label, isn't positionally special (routes
identically whether first or last in the Sequence), skips cleanly for an
application with no interest in it, and — since §4.4 recommends
repeating it verbatim across every code in a multi-code group — proves
two independent encodes of the same fields produce byte-identical
output, exercising §3.4's canonical-encoding guarantee rather than
assuming it holds for a new Record Type too.

**Update:** the original spec text described OS-level dispatch as
working "the same way Android already resolves AAR/Intent-filter
matches" — asked directly whether that actually holds for iOS too, not
just Android, and it doesn't uniformly. Checked directly against Apple's
own Universal Links documentation: iOS has the same domain-verification
*trust model* (`apple-app-site-association`, functionally equivalent to
Android's `assetlinks.json`), but no equivalent *query* API — Android
exposes an explicit "which installed app claims this" lookup, while iOS
dispatch happens as a side effect of a scanner constructing and opening
an actual `https://` URL from the domain, with no separate lookup step
available. End-user outcome is the same either way; the mechanism a
scanner implementation needs is not. Spec §4.4 corrected to describe both
paths explicitly rather than implying one uniform cross-platform API.

**Second update:** A scenario raised during design discussion surfaced a
use for key `0` the domain form can't serve well — a fast, per-code
check that a scanned code plausibly belongs to the group being
reassembled, run *before* attempting reassembly, independent of which
code(s) in the group happen to carry a full domain-form Record. Chasing
whether CBOR reference tags could cut
cross-code repetition (see DESIGN.md's reference-tags entry) confirmed
those can't reach across physically separate codes at all — no shared
decode state exists between them — which ruled that out as a fix for
this but clarified the actual shape of what would work: something
cheap, present on every code, checkable with no shared state. §4.4 now
documents App Route's key `0` as two forms: the domain string (auto-
launch dispatch, real authorization) and a private-use-random uint
reusing Type Hint's exact name-binding pattern (§3.1) for this pre-
filter role — no anti-spoofing property, explicitly not a substitute for
`group_id` (§4.1), which remains the actual integrity check. Prototyped
in `prototype/test/app-route.test.js`: the uint form round-trips, and a
decoder that only checks Type ID `7` presence skips it cleanly without
needing to know key `0`'s shape in advance.

**Third update:** briefly added, then removed, a Companion ID field
(key `3`) letting the domain form vouch for the decentralized form's
per-code pre-filter with real, App-Links-verified trust instead of just
hash-derivation self-consistency — TagDrop independently confirmed its
session-scoping bound was correctly shaped for their own (session-
discontinuous) use case, not a gap. Removed once §3.5's format-namespace
mechanism (Record Type `0`) landed and turned out to do the same
per-code pre-filter job better: structurally guaranteed first (Companion
ID lived on App Route, explicitly *not* positionally special) and
genuinely zero-cost when unused (Companion ID needed a full decentralized-
form App Route record on every sibling code). Two mechanisms answering
the same question from different Record Types would have been exactly
the duplication this project avoids elsewhere — see FINDINGS #19 and
DESIGN.md's "container header collapsed" entry for the full reasoning.
Nothing had shipped, so this was a clean removal: §4.4 is back to its
pre-Companion-ID shape, including the domain form's key `1` reverting to
a plain label (the unification with the decentralized form's Hint-name
role existed only to make Companion ID hash-checkable).

**Fourth update:** TagDrop checked the decentralized form's 41-byte
figure independently (prefix typeIDs + map head + `{0:<uint64>}` + `{1:"..."}`,
byte for byte) and it matched, but flagged something the spec text
hadn't said explicitly: mandatory per-code repetition means "cheap"
describes one code's cost, not a multi-code group's total — a 7-code
group pays 7×41 = 287 bytes for App Route alone. Verified directly
against the actual encoder (`core.encodeRecordBytes`) rather than
re-deriving the arithmetic by hand: 41 bytes with a Hint name, 13
without, confirming both the flagged number and the cheaper
no-Hint-name variant. §4.4 still says this explicitly, independent of
the Companion ID removal above.

### 18. "Private-use" was being misread as "closed/internal" — the tier description was wrong, not just imprecise

While drafting a reply to TagDrop about App Route's decentralized form,
the spec text (DESIGN.md's "Registry governance" and both Scope notes
this fed) described the `0x10000`+ private-use-random Type ID tier as
"the correct answer for closed/internal Record Types that will never be
published or need to interoperate with an unrelated implementer."
Challenged directly: that's not what "decentralized" means. Distributing
who's allowed to *mint* an ID (no registry gatekeeping) is a different
axis from restricting who's allowed to *see or use* it — and the spec's
own mechanisms already contradicted the description. Type Hint's whole
purpose (§3.1) is letting an unrelated implementer recognize a
self-allocated ID; App Route's decentralized form (finding #17's
"Second update," above) is a second, freshly-built mechanism doing
exactly that. The tier's own description was the outlier, not those
mechanisms.

The parallel offered — Bluetooth's private/random device addresses,
self-assigned without any central authority but never meant to imply
"nobody else will ever see or connect to this device" — is the same
distinction Unicode's Private Use Areas already demonstrate (self-
allocated codepoints that shipped in real, shared icon fonts and
pre-standardization emoji long before any registry blessed them). Same
shape of correction as findings #15/#16: the restriction was written for
a narrower case than the one actually being served, caught by an outside
challenge to specific wording rather than an accident of implementation.

Corrected in DESIGN.md's "Registry governance" tier description and both
Scope notes (DESIGN.md's private-use-tier one and spec §4.4's App Route
one) — the tier is now described as decentralized-by-authority, not
scoped-by-visibility, and the "genuine widening" framing both Scope notes
built on top of the wrong premise is removed rather than patched, since
there was no widening to warn about once the premise is fixed. Nothing
about the wire format, the Node prototype, or any Rust code needed to
change — this was a documentation-only error, never a shipped behavior.

### 19. The container header collapsed to magic + a CBOR Sequence — no version byte, no separate header structure

What began as a request for an optional format-namespace field on the
header (RIFF's `WAVE` form-type was the explicit reference point) ended
as a wire-format simplification: the container is now `QDEF` (4 bytes)
plus a CBOR Sequence of Records, nothing else. The version byte is gone.
Container-level metadata (a format namespace, an optional recoverable
name for it) lives inside the Sequence as Record Type `0` — an ordinary
Record, not a second wire structure, decoded by the exact same prefix-typeID/
even-odd machinery as everything else (spec §3.5).

Landed after several rounds that each corrected a real, specific
overreach rather than converging in one pass — three worth naming since
each would have shipped a genuine inconsistency otherwise: a fixed-width
header field taxing every container regardless of use, "different Type
ID = different header version" wasting Type ID space and breaking with
how every other standard record type actually evolves, and a near-miss reusing
key `1` for a version field despite it already being globally reserved
as Type Hint. See DESIGN.md's "The container header collapsed" entry for
the full reasoning on each.

**Concretely, what changed:**

- `prototype/src/core.js`: `encodeContainer`/`decodeContainer` no longer
  read or write a version byte. `core.VERSION` no longer exists.
- `prototype/src/header.js` (new): Type `0`, namespace at key `3`, Hint
  name at key `5`, both odd/optional, positional-first requirement
  enforced by `extractHeader()` with a graceful (never hard-failing)
  degrade to unnamespaced otherwise.
- `rust/qdef-core`: `VERSION` constant, the `version` field on
  `Container`, and the `UnsupportedVersion` error variant all removed.
  No Type-0-specific code added — proven, not just asserted, by
  `record_type_0_needs_no_special_handling_from_this_crate` decoding a
  Type `0` + Wi-Fi container through the unmodified generic path.
- `prototype/scripts/gen-rust-fixtures.js` had six stray references to
  the now-removed `core.VERSION` that would have silently produced
  `Buffer.from([undefined])` garbage bytes into the committed fixtures —
  caught by CI's fixtures-in-sync check failing on push, not by manual
  inspection. Regenerated correctly, plus a new cross-implementation
  fixture (`HEADER_CONTAINER`) for the Type `0` case.

Verified: Node 55/55, Rust 16/16, `clippy` clean, `fmt` clean,
`thumbv6m-none-eabi` release build succeeds, PR #12 CI green on both
jobs across two pushes (the second push fixing exactly the fixture-sync
failure the first one caused).

### 20. Namespace-scoped Type IDs resolved — TagDrop's concrete want, not a hypothetical one, is what unblocked it

**Historical, partially superseded.** The magnitude-based "always-global
floor" this finding works out (`100` → `1000` → `32768`) was itself
later dropped entirely, replaced by pure even/odd parity: every even
uint is always global, every odd uint is always namespace-scoped,
regardless of magnitude — no floor to consult at all. The compound-key
`(namespace, TypeID)` resolution and the sharp-edge/truncation findings
below carried forward into that later design unchanged; only "which
Type IDs are scopable" stopped being a magnitude question.

§3.5 shipped with the `100`+ scoping question deliberately open. Asked
directly by TagDrop, with a concrete want (shrinking four existing
64-bit Type IDs, not a hypothetical future need) once they saw the
namespace mechanism's detection win was cheaper than expected — the
same "wait for a real adopter" discipline that shaped App Route.

Resolved as a compound-key lookup, `(namespace, TypeID)` rather than
`TypeID` alone, once a namespace is declared — reusing the existing flat
numbering space rather than reserving a new sub-range for it, since a
compound key removes the collision ambiguity structurally (see
DESIGN.md's full entry for why the reserved-range alternative doesn't
actually need solving once that's noticed).

Named the one real sharp edge rather than leaving it implicit: a
decoder implementing specific namespace-scopable Type ID semantics that
doesn't check for a namespace first can misapply a global interpretation
to a namespace-scoped Record sharing the same number — a wrong match,
not a clean miss. Framed as Record-Type-interpretation-specific handling
(same category as Type Hint's dual-mode key `1`), so the mandatory core
stays exactly as minimal as already validated — no changes to `core.js`
or `rust/qdef-core` were needed or made.

**Follow-up, same day:** asked directly whether the always-global floor
(originally `100`) actually protected the right range. It didn't fully
— a decoder hardcoding against the *reviewed, well-known*
common-vocabulary tier (`100`–`999`) has no reason to ever read §3.5,
meaning it wasn't accepting the sharp edge, it just never knew the edge
existed. Extended the floor to `1000`: `1`–`999` (standard record types *and*
common-vocabulary) now stays unconditionally global; only the
less-curated first-come tier (`1000`+) is actually namespace-scopable.
Cost verified, not assumed: cheapest namespace-scoped Type ID moved from
4 bytes to 5. A stricter 32-bit-class floor (`≥0x10000`, closing the
first-come tier's edge too) was considered and set aside at 7 bytes
minimum — real, but paying for safety margin against a risk already
judged lower-stakes than the one actually being closed.

**Second follow-up, same day: is `1000` a principled number, or just a
round one?** The latter — corrected once pointed at IANA's own CBOR tag
registry, which draws the identical three-way split verbatim: `0`–`23`
Standards Action, `24`–`32767` Specification Required, `32768`+ First
Come First Served (checked directly against
[iana.org/assignments/cbor-tags](https://www.iana.org/assignments/cbor-tags/cbor-tags.xhtml),
not from memory). Checked the real cost before moving, the same
discipline as every other boundary decision here: `1000` and `32768`
both fall inside CBOR's `256`–`65535` uint class, so both cost 5 bytes
minimum — moving the floor to `32768` was a free upgrade (more
common-vocabulary headroom, an externally-citable boundary), not a
tradeoff. `1`–`99` (standard record types) was deliberately left un-aligned with
IANA's `0`–`23` — that tier answers a different question (what a
generic tool must unwrap regardless of namespace) than IANA's Standards
Action band (who can change the CBOR spec itself), and renumbering
seven already-shipped mechanism IDs would have bought nothing.

**Third follow-up, same day: does the first-come tier still earn its
place, now that namespace-scoping exists?** Asked directly, once it was
noticed that first-come is exactly the range namespace-scoping applies
to, and is a no-op the moment no namespace is declared. No — dropped
it. Collision-avoidance for a Type ID only ever comes from one of
three sources: registry curation, the ID's own numeric width, or a
declared namespace. First-come tried to be cheap *and* uncoordinated
without picking any of the three, which is exactly why it never had a
real governance model (this project's own earlier "no registry
authority exists yet" admission, and its own §6 worked example already
steered real adopters toward private-use-random instead, in practice).
Declaring a namespace and using small sequential IDs inside it already
covers the first-come tier's entire use case, with a mechanism that has
a real governance story. Needed no code change: `resolveLookupKey`'s
floor check never implemented "first-come" as a distinct mechanism, so
this was purely a governance/vocabulary simplification, not a wire
change.

**Fourth follow-up, same day: is a namespace-local Type ID a truncated
wide ID, or a freshly chosen one?** Asked directly because "shrinking
four existing 64-bit Type IDs" reads ambiguously either way. It's the
latter, and it matters which: `resolveLookupKey` only checks magnitude
against the ceiling, so it can't tell a freshly-picked small number
from the low bits of a truncated wide one — and a truncated value's
magnitude is effectively random with respect to the ceiling, meaning it
can land below it purely by chance. A Type ID below the ceiling is
*always* global regardless of any declared namespace, so a truncation-
derived ID would silently lose its own namespace scoping some fraction
of the time — the same wrong-match failure mode named earlier, this
time triggered at ID-selection time rather than decode time. Made
explicit in §3.5 rather than left inferrable from the "shrinking"
phrasing, and demonstrated, not just asserted: a new test constructs a
real 64-bit private-use-random ID truncated to its low 15 bits and
confirms it resolves globally, not namespace-scoped, despite a
namespace being declared.

Prototyped in `prototype/src/header.js`'s `resolveLookupKey` and
`prototype/test/header.test.js`: compound-key resolution differs by
namespace, `1`–`32767` stays global unconditionally (both standard record types and
the full IANA-aligned common-vocabulary range, tested explicitly), a
namespace-aware dispatcher correctly refuses to fall back to a
recognized global meaning for an unrecognized namespace-scoped pairing
above the ceiling (the sharp edge, demonstrated rather than described),
a naive decoder with zero namespace awareness still correctly resolves
a common-vocabulary Type ID (the specific failure mode the floor
extension exists to close), a truncated-ID pick landing below the
ceiling silently loses its namespace scoping (the ID-selection-time
version of the same sharp edge), and TagDrop's own migration case end
to end with real, verified byte counts: 11 bytes for a bare Record
under an existing 64-bit global Type ID, 5 bytes for the same under a
namespace-scoped small one at the current `32768` floor — unchanged
from the old `1000` floor, confirming the free-upgrade cost claim
against the actual encoder rather than just the size-class table.

### 21. The hash-derivation algorithm was never pinned — and the prototype had a live bug matching the gap exactly

Asked directly whether §3.1's `ID = truncate(hash(name), N)` had ever
actually been specified precisely enough for independent implementations
to agree. It hadn't: no hash function was named, no string encoding, no
truncation/byte-order rule, and `N` was explicitly called "an open
parameter." Checking the real prototype rather than trusting the prose
surfaced a live bug matching the gap: `verifyTypeHint` called
`deriveHashId` with no width argument, silently defaulting to a 4-byte
truncation regardless of the candidate ID's actual magnitude — meaning a
genuinely 64-bit-class ID (exactly what §9 recommends and what TagDrop's
own existing Type IDs actually are) could never verify, no matter how it
was derived. The "anyone can independently check" claim this whole
mechanism exists to deliver was false in practice for the one adopter
actually positioned to use it.

Fixed by making `N` derived from the candidate ID's own byte-width (4 if
it fits in 32 bits, 8 otherwise) instead of a free parameter, and pinning
the rest: SHA-256 over the name's raw UTF-8 bytes, first `N` digest bytes
as a big-endian uint. A second bug caught in the same pass: comparing a
narrow (Number) and wide (BigInt) derivation with `===` is unsafe --
`5 === 5n` is `false` in JS -- fixed by normalizing both sides through
`BigInt(...)` before comparing. Also implemented `header.js`'s
`verifyNamespaceHint` for the first time: §3.5 described the namespace
mechanism's own hash-check in prose since it landed, with nothing in the
prototype actually backing it. It calls `typeHint.js`'s derivation
directly rather than reimplementing the algorithm, so namespace values
and Type IDs are checked identically by construction.

Prototyped in `prototype/test/type-hint.test.js` (a regression test
proving a 64-bit-class ID now verifies where it silently couldn't
before, and a narrow-vs-wide cross-verification test) and
`prototype/test/header.test.js` (the namespace hash-check exercised for
the first time, mirroring Type Hint's own three-way verify/degrade/
not-applicable split). See DESIGN.md's matching entry for the full
reasoning behind each fix.

### 22. Pinning the hash algorithm didn't fix the naming problem — the input needs its own collision-resistance guidance

Asked directly, right after #21 landed: does the spec tell anyone how
to *choose* the name fed into hash-derivation, so two unrelated
implementations don't collide by accident? It didn't, anywhere — only
"e.g. a reverse-domain string" appeared once, as an illustrative
example, never as guidance.

This is a real gap, not a nice-to-have: `ID = truncate(SHA-256(name),
N)` is only as collision-resistant as `name` is diverse. Two unrelated
projects independently naming their config record `"config"` derive the
*identical* ID — a certain collision, not a probabilistic one, since
the function is deterministic and short, sensible English words for a
common concept are a small space heavily shared across unrelated
authors. Demonstrated directly with real hash output rather than argued
abstractly: `deriveHashId('config', 8)` computed twice, simulating two
independent projects, produces the same value both times.

Fixed by recommending the same convention every other namespaced-
identifier system already uses — reverse-domain qualification
(`"com.example.tagdrop"`, not bare `"tagdrop"`) — with the reasoning
spelled out for why it actually works (a domain two unrelated parties
could both plausibly register is already vanishingly unlikely by DNS's
own allocation guarantees, which is what restores the "behaves like a
random draw" property hash-derivation depends on) rather than presented
as unmotivated style guidance.

Scoped precisely, not applied blanket: only a namespace's own Hint name
(§3.5) and a standalone (non-namespaced) private-use-random Type ID's
Hint name actually need this — a Record-Type-local Hint name used
*inside* an already-declared namespace is already protected by the
namespace itself and doesn't need qualifying.

Prototyped in `prototype/test/type-hint.test.js`: two unrelated
"projects" naming the same concept `"config"` derive an identical ID
(the hazard, demonstrated), and the same two projects qualifying by a
domain they each control do not collide.

### 23. `resolveStack` had no defined behavior for a Type `0` header coexisting with a Wrapper Record — TagDrop's multi-code question exposed it before it shipped wrong

TagDrop asked directly whether a namespace declaration needs to repeat
on every physical code of a multi-code Split group before adopting
namespace-scoping for real. Tracing the actual mechanics to answer it
precisely (not by analogy to Preview/App Route alone) found a real gap:
`prototype/src/wrappers.js`'s `resolveStack` only ever inspected
`records[0]` of each code, with no path at all for a Type `0` sibling to
coexist with a Split/Compress/Encrypt Wrapper Record in the same code's
Sequence — and no defined rule for whether a namespace declared that way
even reaches a Record only discoverable after full Wrapper resolution.
Neither was a deliberate scope decision; the interaction had simply
never been asked about before.

**Fixed on both counts.** `resolveStack` now locates a Type `0` sibling
per code (routing from the *second* Record instead of the first when one
is present), requires every code that declares a namespace to agree, and
applies the agreed namespace to whatever Record the stack ultimately
resolves to — including one only reachable after full Split reassembly.
Throws via the same `resolveLookupKey` check §3.5 already defines for
the plain-sibling case if the terminal Record's Type ID is namespace-
scoped and no namespace was found anywhere in the group.

**The harder finding: repetition isn't just a cost question, it's a
robustness asymmetry that already-shipped machinery doesn't cover.**
`parity_scheme` recovers a missing *fragment's bytes*; a Type `0` Record
is a whole sibling Record, entirely outside the Split group's own
fragment data, so parity gives it no protection at all. Demonstrated
directly rather than argued: a namespace declared on exactly one code,
with that code then dropped, aborts the namespace-scoped Type ID even
though XOR parity fully recovers the Split-protected content from the
remaining codes. Requiring uniform per-code repetition — the same rule
Preview and App Route's decentralized form already follow — closes this
rather than leaving Split-protected content more fragile in namespace
terms than in content terms.

**Real, sometimes negative, wire cost — verified against the actual
encoder:** shrinking one namespace-scoped Type ID (10-byte decentralized
byte string → 4-byte small odd uint) saves 6 bytes; the cheapest legal
repeated Type `0` header costs 8 bytes/code. One shrunk ID alone is a net
+2 bytes/code regression; breakeven needs at least two namespace-scoped
Type IDs' worth of savings sharing the same code's header cost.

Prototyped in `prototype/test/multi-code-namespace.test.js`: the
repeated case resolving correctly through full Split reassembly, the
single-point-of-failure case reproduced directly (survives while its
code is present, aborts the instant that code is dropped, despite full
content recovery via parity), disagreeing codes across a group rejected
outright, and the no-namespace-anywhere case aborting the same way the
already-covered single-code case does.

### 24. Two stale examples used a magnitude that stopped mattering once the redesign removed the floor — and the cost comparisons using them undercounted the real savings

While working through finding #23's byte math further, checking whether
TagDrop's real remaining gap could shrink more: the `32769`-style "small
odd uint" examples used throughout §3.5 and DESIGN.md's namespace entry
were never actually the minimum. They're leftover from the pre-redesign
spec, where `32768` was a hard floor; the current parity-based rule has
no floor at all. A genuinely minimal odd uint (`1`, `3`, `5`...) costs
**2 bytes bare**, not 4 — CBOR packs `0`–`23` into the initial byte with
no argument bytes. Recomputed the breakeven with the real number:
per-ID saving against a 10-byte decentralized baseline is 8 bytes, not
6, meaning a *single* repeating namespace-scoped ID already clears the
8-byte Type `0` tax on its own, reversing the "need two IDs" framing for
the common case of small, hand-picked sequential IDs. Fixed both the
`§3.5` worked example and the DESIGN.md cost claim; the earlier "two
IDs" conclusion is kept as a correctly-scoped special case (Preview
repeating + Body reassembled once specifically), not a general rule.

### 25. `§2`'s "own URI scheme, skip magic" principle was asserted but never worked out — and pushing it one step further removes namespace-scoping's cost too, for the same reason

Checking `mofosyne/tagdrop`'s real SPEC.md directly (added to this
session, read rather than assumed) to answer whether their field
encoding was maps or arrays surfaced something more consequential: every
one of their codes is `tagdrop:<base41-cbor-sequence>` — their own URI
scheme, not byte-mode QR. Every cost comparison in this document up to
that point had been charging a 4-byte magic header per code, even though
§1/§2 already say an app with its own scheme shouldn't pay that cost.
The principle existed; it just hadn't been applied.

Pushed one step further, checking rather than assuming it stopped there:
does the same isolation that removes the need for magic also remove the
need for a declared namespace? Yes — namespace-scoping exists to let
unrelated apps' Type IDs coexist in a *shared, generic* container, and
an app whose carrier already guarantees nothing but its own decoder ever
sees these bytes has already solved that problem by a different,
pre-existing mechanism. A small self-allocated even Type ID (`32768`+,
no registry) is exactly as collision-safe in that deployment as a
namespace-scoped one, at a fraction of the cost.

**Verified against the real encoder, not estimated:** for a 4-code
group, the original comparison (magic + namespace-scoped, using the
already-corrected minimal odd-uint width from finding #24) cost 58 bytes
against TagDrop's own 8-byte envelope; dropping magic alone brings it to
42; dropping namespace-scoping too (self-allocated even ID) brings it to
20 — a 38-byte reduction from the original estimate, achieved entirely
by applying principles this document already stated rather than by
building anything new. The remaining ~12-byte gap reflects a real
capability difference (an open-ended, self-describing typeID vs.
TagDrop's closed 2-value enum), not waste, and is called out as such
rather than framed as more overhead to eliminate. (An earlier version of
this note said 68/+60/48-byte reduction — that reused the pre-#24
32769-width figure for this one row while the other two rows already
used the corrected width. Caught when a reader asked the table to
explain itself and the arithmetic didn't hold together; fixed to be
internally consistent.)

Fixed the actual gap this exposed: §2 had NDEF's magic-skip case fully
worked out (paragraph, example, prototype test) but nothing equivalent
for the URI-scheme case despite stating the same principle applies.
Added the matching paragraph, connected §3.5's namespace-skip guidance
to the same reasoning, and added
`prototype/test/custom-scheme-carrier.test.js`: a bare Sequence
round-tripping via the same `decodeSequence` path NDEF already
validated, `resolveLookupKey` confirming a self-allocated even ID needs
no namespace to resolve correctly with or without one declared, and the
corrected byte counts (14 vs. 4 per occurrence) asserted directly against
the encoder rather than left as a comment.

## Confirmed working as designed (no fix needed)

- **Magic + CBOR-Sequence-of-Records** round-trips exactly as
  drawn in §2's diagram, including rejecting bad magic.
- **Prefix-typeID routing (§3.1):** a Record encoded with no CBOR tag at
  all still routes correctly off prefix typeIDs alone — verified with a
  tag-free encoder path in the prototype. The tag path was later removed
  entirely (finding #12); this bullet just confirms prefix typeIDs alone
  were always sufficient, which is exactly why removing the other route
  cost nothing.
- **Even/odd criticality (§3.2):** an unrecognized even key aborts only
  that Record; an unrecognized odd key is silently ignored and the rest of
  the Record still processes; one aborted Record in a Sequence doesn't
  affect its siblings.
- **NDEF path (§2):** a bare CBOR Sequence with no magic prefix
  (simulating the `application/vnd.qdef` MIME-typed NDEF case) decodes via
  the same record-routing logic, confirming the magic header really is
  QR-path-only, not load-bearing for the container's actual structure.
- **The streaming claim (§2):** "a constrained parser can process each
  record as it streams in, without buffering the whole payload first" holds
  up against a real incremental CBOR decoder fed the byte sequence in
  arbitrary small chunks.
- **The Wrapper mechanism's core promise (§4.1):** one resolver function
  with no per-Record-Type knowledge correctly unwraps Split/Encrypt in
  combination and reassembles from fragments — including recovering a
  missing fragment (both a full-length one and the shorter last one) via
  XOR parity, and correctly failing when 2 of the 4 fragments (more than
  single-parity can cover) are missing.
- **Cross-implementation agreement:** containers encoded by the Node
  prototype's `cbor`-package-based encoder decode correctly through the
  Rust prototype's independent, hand-rolled decoder with no coordination
  beyond the spec text itself (`rust/qdef-core/src/fixtures.rs`) — the
  closest thing this exercise has to a real interop test between two
  unrelated implementations.

## Net effect on the spec

None of this changes three of the four load-bearing design decisions
called out as settled (two-layer core/standard-record-type split, even/odd criticality,
Wrapper Records over a sibling key range, fixed nesting order as encoder
convention). What changed for those is precision: several places that read
as complete prose turned out to be underspecified the moment two
independent implementations needed to agree on wire bytes without talking
to each other first. That gap is exactly what a prototype catches and
prose review doesn't.

The fourth — Hardware Parity dual routing — didn't survive: finding #12
removed the tag half of it outright. That's a genuine reversal of a
previously-settled decision, not just a precision fix, and it happened for
the same reason the others got sharpened: a concrete finding (§11's
reproduced IANA collision), not a stylistic second-guess.

The Rust pass added a second kind of value beyond the Node prototype: not
just "does the design round-trip," but "does the *minimal-core* claim,
specifically, survive contact with a language and target that can't lean on
a hosted CBOR library or an OS to hide the hard parts." It did — with two
concrete hardening gaps (#9, #10) that only became visible once the
CBOR-walking and Sequence-iteration logic had to be written by hand instead
of delegated to a library call.

## 23. Prefix typeIDs: replacing the three-tier integer system with a three-type classification

**Historical, superseded.** The three-row classification this finding
introduces (uint even / uint odd / byte string) later collapsed to two
rows: decentralized byte string Type IDs were retired entirely once a
declared namespace turned out to give every odd uint inside it the
identical zero-coordination collision safety at a fraction of the
per-ID cost (see the record-architecture-redesign entries further
below, and DESIGN.md). What this finding gets right and still holds:
self-describing classification by CBOR major type and parity, no magic
threshold constants, explicit truncation visibility — all carried
forward into the two-row design unchanged. Kept for the real trail of
why key-0-only integer tiers were replaced with prefix typeIDs at all.

The original design used three tiers of integer Type IDs in key 0
(`1`–`99` standard record types, `100`–`32767` common vocabulary, `32768`+ private-use),
all encoded as CBOR uints. Namespace scoping was determined by a magnitude
check against a magic ceiling (`32768`). This worked but had structural
limitations:

- **Truncation was invisible on the wire.** A 64-bit private-use ID
  truncated to 32 bits was indistinguishable from a naturally-32-bit
  registered ID. The spec explicitly forbade this (old §3.5), but the
  prohibition was enforced by convention, not by the wire format.

- **The ceiling was a magic number.** `32768` carried semantic meaning
  (the boundary between "always global" and "namespace-scoped if declared")
  that wasn't visible in the CBOR encoding itself — a parser had to know
  the threshold.

- **Three tiers of the same type.** All three categories (standard,
  scoped, decentralized) were encoded as CBOR uints. A parser couldn't
  determine which category an ID belonged to without comparing against
  external thresholds.

The new design replaces tiers with three distinct CBOR types as prefix
typeIDs:

| CBOR type | Class | Scope |
|---|---|---|
| uint, even | Standard record type | Always global |
| uint, odd | Scoped record type | Requires namespace |
| byte string | Decentralized/random | Always global |

This change was adopted after research into analogous protocols (CBOR,
XML, NDEF, Protocol Buffers, HTTP/2+3, Bluetooth, ZIP) confirmed that
infrastructure mechanisms are universally kept globally interpretable —
matching the even-uint-always-global rule.

Key benefits:
- **Self-describing.** The CBOR major type and parity carry all the
  semantic meaning. No magic constants, no threshold comparisons.
- **Explicit truncation.** Byte string length visible on wire. A 2-byte
  ID visibly declares its collision tolerance.
- **Clean namespace scoping.** Odd uints require a namespace; even uints
  and byte strings are always global. No ceiling check needed.
- **Hash-derivation simplified.** Output is now a byte string (truncated
  SHA-256 digest), eliminating the old Number/BigInt comparison hazard
  (Finding #21) entirely.

Costs:
- **Breaking wire format change.** All existing fixtures must be
  regenerated. Containers using old odd-numbered types (3, 5, 7, 105)
  without a Type 0 header will be rejected.
- **Standard record type renumbering.** Types 3→8 (Compress), 5→10 (Open/Hint URI),
  7→12 (App Route), 105→106 (Event Ticket) to ensure all standard record
  type IDs are even.
- **Prefix-typeID routing.** Parsers must now read the prefix typeID
  before entering the map, adding a step to the routing path. The
  prefix is a straightforward CBOR major-type check — trivial cost,
  but present.

### 26. The optional Type `0` header was structurally ambiguous with an ordinary Record's own prefix typeIDs — replaced with a mandatory container discriminator

Type `0` (§3.5) worked as an *optional* leading Record: a bare uint or
byte string, present or absent, MUST-be-first if present. Walking through
exactly how a decoder tells "the header is present" apart from "the
header is absent and this is just the first real Record's own prefix
typeID" surfaced a real structural gap: both cases are the identical CBOR
shape (uint or byte string) in the identical position. Tracing the
actual JS parser confirmed it: Phase-1 typeID accumulation
(`core.js`/`isTypeId`) accepts uint/bstr/tstr items with no way to
distinguish "this is a header" from "this is the second prefix item of
Record 1." A CBOR tag number could mark the difference unambiguously, but
tag-based routing was already rejected once for real collision risk
(Finding #11). The only remaining fix that resolves the ambiguity
structurally, rather than relying on encoder discipline that could be
violated, is to make the discriminator unconditionally present.

**Redesigned as a mandatory container discriminator**, always exactly
one CBOR item, always immediately after magic: `uint 0` (no namespace),
`uint N>0` (allocated namespace), byte string (decentralized namespace),
`[uint, bstr]` (allocated + decentralized backup), `[bstr, tstr]`
(decentralized + hint), or the full map form (extensible, same shape the
old Type `0` Record's own map had). An unrecognized shape degrades to
"no namespace," matching every other graceful-degrade path in this
format.

**This gives up "zero cost when unused"** — every container now pays at
least 1 byte, even one wanting no namespace. Initially rejected on that
basis (a mandatory tax on the common case), but reconsidered after being
pointed at the wrong framing: MCU-constrained parsing cost isn't this
project's actual binding constraint (smartphone-first; embedded scanners
are a nice-to-have), and a single byte answering "generic QDEF record vs.
specific application file format" is proportionally negligible against
any realistic payload — closer to RIFF's form-type byte than to wasted
padding. It also isn't purely a tax: the discriminator's shapes are each
cheaper than the old Type `0` Record's typeID+map framing, verified
against the actual encoder — a bare 4-byte decentralized namespace costs
5 bytes as a discriminator versus 8 bytes as the old optional Record,
enough that a single repeating namespace-scoped ID now nets a real win
per code rather than merely breaking even (see DESIGN.md's ["Container
discriminator redesign"](DESIGN.md#container-discriminator-redesign)).

**Verified the mandatory core stays minimal, not just asserted it.**
`rust/qdef-core`'s `Container::parse` needed exactly one addition — call
the crate's existing generic `skip_any_item` once to split the
discriminator off before parsing Records — and zero discriminator-shape
interpretation code. `header.js`'s `parseDiscriminator` is the only place
that understands what the six shapes mean.

**A real gap surfaced while implementing this: the Rust test suite was
green for the wrong reason.** After updating the JS encoder/decoder, all
60 Node tests passed as expected, but `cargo test` also reported all
green *before* `fixtures.rs` was regenerated — because `rust/qdef-core`
has zero discriminator-awareness of its own (by design), it was still
correctly parsing the *old*-format fixture bytes, never actually
exercising the new split-off-one-item behavior at all. A green Rust run
proved nothing here. Caught by reasoning through why that had to be
suspicious before trusting it, then confirmed for real by regenerating
`fixtures.rs` from the updated Node encoder and rerunning — which
surfaced two genuine failures (a stale fixture built by manually
concatenating magic + record bytes with no discriminator, and a
bare-NDEF-sequence test that stripped only magic off a full container,
leaving the discriminator byte in front of the real Record). Both fixed:
the manually-built fixture gained an explicit `uint 0` discriminator, and
the bare-sequence fixture was rebuilt directly via `encodeRecordBytes`
(bypassing `encodeContainer` entirely) instead of slicing a full
container — the same fix pattern already applied on the JS side in
`custom-scheme-carrier.test.js`. This is the general lesson, not
specific to this change: a cross-language fixture-based test only proves
what it was last regenerated against, and a decoder with intentionally
no semantic knowledge of a wire-format detail (by design, here) can stay
green on stale bytes indefinitely without ever really testing the new
shape.

### 27. "Multiple namespaces per container" was rejected for reasons specific to the two mechanisms considered, not to the goal itself — and the fix that avoids both isn't a cheaper decentralized ID either

Revisiting "Multiple namespaces per container" (previously "considered,
not built") after a concrete third design was proposed: a Record's own
prefix can carry a **namespace-pairing item**, `[namespace, typeId]`,
declaring/overriding that one Record's namespace independent of the
container discriminator's ambient one. Checking it against the two
previously-rejected mechanisms' actual objections — rather than assuming
the rejection generalized to "multi-namespace support is a bad
trade" — showed both objections were specific to those two shapes, not
to the goal: position-based re-scoping was rejected for introducing
stateful, order-dependent parsing (a pairing item needs none — it's
local to one Record, no cross-Record state); a header-level namespace
array with a per-Record selector was rejected for taxing *every*
namespace-scoped Record with a mandatory field (a pairing item is
opt-in, paid only by a Record that actually wants an override). Neither
objection applies to a self-contained, per-Record array.

**A related intuition needed checking too, and turned out wrong:**
whether this pairing form could also replace standalone decentralized
Record IDs (§3.1's byte string typeID), since a namespace + small odd
uint had already been shown cheaper than a standalone decentralized ID
*when amortized across multiple Records under one container-level
discriminator* (a separate finding). Verified against the actual
encoder rather than assumed: a per-Record pairing does **not**
amortize — it's paid fresh on every Record that carries one — so
`[decentralized namespace, scoped id]` costs 7 bytes bare versus 5 for a
plain standalone decentralized Record ID. The pairing form is strictly
worse for "I want one collision-safe global ID"; it only earns its cost
for the narrower question "can this one Record use a namespace other
than ambient." Caught before it was written into the spec as a
replacement it isn't.

Implemented identically in both languages, confirming the mandatory core
stays free of namespace semantics a second time: `core.js`'s Phase 1 and
`rust/qdef-core`'s `parse_record` each gained exactly one new
structural-recognition rule (a definite-length 2-element array at a
typeID position), with zero code anywhere in either mandatory core that
knows what a namespace *is* — matching the container discriminator's own
precedent (Finding #26) rather than needing a new pattern. See
DESIGN.md's "Multiple namespaces per container" and spec §3.1's
namespace-pairing prefix item.

### 28. "Own-URI-scheme carriers skip magic AND namespace-scoping" understated a real risk — isolation is a carrier property, not a byte property, and doesn't survive being reused across carriers

The guidance that an app whose carrier already isolates it (own URI
scheme, own NDEF MIME type) can safely use a small, self-allocated even
Type ID with no namespace (spec §3.5, Finding #25) was correct as far as
it went, but understated what "isolated" actually depends on. Pressure-
tested against TagDrop's real implementation practice rather than left
as a theoretical concern: TagDrop deliberately reuses identical
CBOR-sequence bytes across two carriers, for implementation
simplicity — the same bytes get Base41-encoded into their `tagdrop:`
URI and dropped raw into an NDEF record under their own
`application/vnd.tagdrop` MIME type.

Both of TagDrop's *current* carriers happen to preserve isolation
(distinct scheme, distinct MIME type — neither is shared/generic
dispatch), so nothing is broken today. But the underlying practice —
one shared codepath, wrapped differently depending on transport — is
exactly the shape of thing that stops being safe the moment a *third*
carrier is added without equivalent exclusivity (a bare byte-mode QR
with no distinguishing wrapper, or a shared/generic MIME type), and
nothing at the wire level would notice: an even Type ID carries zero
self-protection of its own, so "isolated" and "unisolated" copies of the
identical bytes are bit-for-bit indistinguishable. Isolation is a
property of the carrier at the point of consumption, never of the bytes
themselves, and the original guidance didn't say so.

**A deeper tension underneath the wire-format gap, not just a
missing caveat.** An application that wants any degree of
recognizability by tools other than its own decoder — presumably part
of the point of adopting a shared Record format at all, rather than
keeping a fully bespoke wire format — is, by definition, choosing not
to stay permanently isolated. For that application, isolation-based
collision safety for self-allocated even Type IDs works against its own
goal: the more it wants broader interoperability, the less true "nothing
else ever sees these bytes" actually is. Namespace-scoping, or an
eventual First Come First Served registry entry, are the
carrier-independent alternatives — either stays collision-safe
regardless of which carrier the bytes travel through, which
self-allocated-and-isolated even IDs structurally cannot offer.

Added the caution directly to spec §2/§3.5 (an implementer reusing
binary internals across carriers must verify *every* reachable carrier
provides isolation, not just the primary one) rather than leaving it
implied. See DESIGN.md's "Own-URI-scheme carriers skip magic AND
namespace-scoping" for the full writeup.

### 29. A namespace can be implied by an isolated carrier instead of transmitted — strictly better than self-allocated even IDs at the same cost, and it resolves whether decentralized Record IDs still need to be the general "cheap ID" recommendation

**Later superseded further.** This finding narrowed decentralized
(byte string) Type IDs down to one remaining niche job: standing alone
as a self-certifying identity with no namespace involved. A later pass
checked whether any concrete case (TagDrop or otherwise) actually
exercised that niche — none did — and retired decentralized Type IDs
entirely rather than keeping a mechanism nothing used. See the
record-architecture-redesign entries further below.

Asked TagDrop directly what their own decoder does internally with
content that arrives via a carrier implying isolation (their `tagdrop:`
URI), rather than assuming the answer — Finding #28 had just established
that isolation-based safety is carrier-dependent, so the natural
follow-up was whether TagDrop's actual implementation had already found
a way around that. It had, without necessarily naming it as such:
TagDrop "reinserts" a container discriminator internally whenever
content arrives via its own scheme, and the reinserted value is a *real*
namespace, not a placeholder.

That fact generalizes into a genuinely better pattern than the one spec
§3.5 originally recommended for isolated-carrier applications. Instead
of choosing between self-allocated even IDs (cheap, but safety is
entirely carrier-contingent, per Finding #28) and an ordinary
transmitted namespace declaration (safe, but costs a discriminator on
the wire), an application can fix a real namespace value once and have
its own decoder assume it applies to any content reaching it through any
of its own carriers, without ever transmitting it. This costs exactly
what the even-ID pattern costs (a bare uint, no discriminator, as small
as one byte) but inherits namespace-scoping's fail-*closed* property: an
odd Type ID with no namespace present is a spec-mandated abort (§3.5),
so bytes that leak into an unisolated carrier get correctly refused
instead of silently, successfully misrouted the way an unprotected even
ID would be. It also converts to genuine, transmitted-namespace
interoperability later at zero cost to the Type IDs themselves — only
the carrier's dispatch changes, not the numbers. The one discipline it
requires: the implied value must be identical across every one of the
application's own carriers, or the safety collapses back to the even-ID
case.

**Second-order consequence, reached by asking the next obvious
question rather than stopping at the first answer: if namespace-scoped
odd uints are now the better default even for an isolated, single-app
carrier, does decentralized (byte string) Record Type IDs still need to
be the general "cheap ID with no registry" recommendation at all?** No —
checked against the actual numbers, not asserted. A byte string Type ID
costs 4+ bytes per Record Type, forever; a namespace-scoped odd uint
costs as little as 1 byte and is collision-free once a namespace exists,
regardless of whether that namespace itself is centrally allocated or
self-chosen. The "cost" — the namespace operator must not reuse a
number they've already issued — is trivial local bookkeeping for anyone
running one namespace. This holds whether the namespace is community-run
or centrally controlled, which is exactly the choice a byte string
*namespace* value still exists to provide (§3.5, "Governed vs.
ungoverned") — the decentralized byte-string mechanism's real, load-
bearing job turns out to live one level up from where it was originally
recommended: namespace governance, not per-Record-Type identity. A byte
string Type ID keeps exactly one job nothing else can do: standing alone
as an independently self-certifying identity, verifiable against its own
name with no namespace, registry, or reachable-author trust needed at
all — real and worth keeping, but a narrow, specific justification, not
the general-purpose "decentralized" recommendation it read as before.

Re-scoped spec §3.1's guidance and DESIGN.md's Registry governance
section to state this plainly: reach for a namespace first, reach for a
byte string Type ID only when self-certification (or pre-registry
provisional identity ahead of a common-vocabulary allocation, §8) is the
actual property needed. No wire-format change — both mechanisms already
existed and worked exactly as specified; this is a recommendation
correction, driven by a real adopter's actual implementation being
checked rather than assumed.

### 30. The discriminator's hint-carrying array shape only covered Decentralized namespace IDs — a real asymmetry, closed by generalizing one existing check rather than adding a parallel one

Noticed while discussing whether an Allocated (uint) namespace ID
deserved its own compact hint-carrying array shape, the way a
Decentralized (byte string) one already had (`[byte string, text
string]`): there was no principled reason for the asymmetry. Checked the
actual byte cost of adding a dedicated new shape for it first, rather
than assuming it was worth it — `[uint, text string]` vs. the
equivalent map form saved only 2 bytes (32 → 30), and a further
3-element form adding a Decentralized backup on top saved only 3 bytes
(42 → 39) over the map form. Neither clears the bar this project has
held elsewhere for adding shape-recognition surface (the same reasoning
that killed the old first-come-first-served tier and the header-array-
with-selector design) — on cost alone, neither looked worth it.

**What changed the calculus: the existing `[byte string, text string]`
shape's recognition rule already checks "is element 1 a text string,"
independent of element 0's type — supporting an Allocated ID here isn't
a new code path, it's loosening one existing guard from "element 0 must
be a byte string" to "element 0 must be a uint or a byte string."**
Once framed that way, the actual marginal implementation cost is closer
to zero than "one more shape to recognize," so the earlier byte-cost
objection stopped being the deciding factor. Generalized `[byte string,
text string]` into `[namespace ID (uint or byte string), text string]`
— one shape, disambiguated purely by the ID's own major type, covering
both an Allocated hint (plain, not self-certifying — a uint can't be
hash-derived from a name) and a Decentralized hint (self-certifying) —
and this project chose to be comprehensive about the whole shape family
rather than stopping at just the 2-element generalization: added the
3-element `[uint, byte string, text string]` form (Allocated +
Decentralized backup + hint together) despite it genuinely needing a new
length-based branch (not a widened guard) and the map form's own
key `5` for the same combination, so all three of the discriminator's
extensible forms (2-element, 3-element, map) can now express the same
set of {namespace, hint, backup} combinations, with array length
disambiguating shapes before any element is even inspected.

No mandatory-core changes — this is entirely within
`prototype/src/header.js`'s `parseDiscriminator`, the
Record-Type-interpretation layer, exactly as every other discriminator
shape already was. `rust/qdef-core` needed nothing at all, since it
never interprets the discriminator's contents in the first place
(Finding #26).

**The actual motivation for an Allocated ID's hint, stated plainly:
reverse-engineering, not verification.** A uint can't be hash-derived
from a name the way a byte string can, so unlike a Decentralized
namespace's hint, an Allocated one's hint is never self-certifying — it
was worth being explicit about why it's still useful anyway. Anyone
examining a QDEF container found in the wild, without access to
whichever registry eventually governs the Allocated tier (or looking at
older content predating one), can read the namespace's own name straight
off the wire instead of guessing or needing external lookup. Same job
Type Hint (§3.1) already does for Record Type IDs, one level up.

### 31. Three documentation-clarity gaps, surfaced by implementer-experience-shaped feedback: a buried cost-math distinction, no decision guide for six Type ID mechanisms, and no single scannable list of assigned IDs

None of these change the wire format or any decoder's behavior — all
three are about a reader/implementer being able to find and apply
information that was already correct, just hard to locate.

**A Wrapper-wrapped Record's inner Type ID is never bare and never
repeated the way a plain sibling Record's is, and that changes
namespace-scoping cost math — the fact was already present, but only as
a parenthetical aside on one specific worked example ("Namespace
repetition across a multi-code Split group," above), not stated as its
own general principle.** A plain sibling Record's namespace-scoped Type
ID is typically repeated on every code, so shrinking it saves the shrink
*N times*; a Type ID only reachable after a Wrapper stack fully resolves
exists exactly once for the whole group, so shrinking it saves the
shrink *exactly once* — never something that scales with code count.
Conflating the two overstates how quickly a repeating discriminator's
own per-code cost gets cleared. Stated as its own clearly-labeled
principle in both `DESIGN.md` and spec §3.5, rather than left implicit
in a footnote about a different correction.

**Six Type ID mechanisms (§4's range table) with no guide for picking
among them — real feedback was that the taxonomy took multiple
clarifying rounds even with direct access to ask.** Added a step-by-step
decision tree to spec §4, ordered so most application Record Types
resolve at step 3 (a declared namespace, implied or explicit, with small
sequential odd uints inside it) — matching where this project's own
analysis (Findings #29/#30) already concluded most real usage should
land, now made discoverable without having to reconstruct the reasoning
from scattered sections.

**No single place listing every currently-assigned standard Record Type
ID, only prose scattered across §4.1–§4.4 — a real implementation-
mistake risk, not just an inconvenience.** A typo here (the wrong number
for a standard Type) collides silently with whatever real ID that number
belongs to, rather than failing loudly the way an unrecognized ID would.
Added a compact, scannable table gathering all six assigned IDs (Split
`2`, Encrypt `4`, Media Payload `6`, Compress `8`, Open/Hint URI `10`,
App Route `12`) in one place at the top of §4, cross-referencing each
one's full definition rather than duplicating it.

### 32. Checking QDEF against every real NDEF RTD, not just NDEF in the abstract, surfaced one cheap gap worth closing and confirmed several others are correctly out of scope

Asked directly whether QDEF and NDEF content should convert in both
directions, with an explicit escape hatch stated up front: not
converting is an acceptable outcome where closing the gap would cost
more decoder/design complexity than it's worth. `DESIGN.md`'s
"Relationship to existing standards" had discussed NDEF at an
architectural level since early in this project, but had never actually
checked QDEF's standard record types (§4) against the NFC Forum's real,
published RTD list one by one. Did that directly against the actual
specifications rather than from memory.

**One real, cheap gap: Smart Poster's language tag and action code.**
Open/Hint URI (§4.2) had a URI and a label, but nowhere to put a BCP 47
language tag or Smart Poster's action code (perform/save/open). Closed
it with two new odd/optional fields (keys `3` and `5`) — cheap
specifically because both are optional: a decoder that doesn't recognize
either still gets a fully working URI and label, the exact same
graceful-degrade guarantee Open/Hint URI already made for its original
two fields. Multiple languages or multiple URIs (Smart Poster's
multi-title behavior, Multiple URI RTD) needed no new mechanism at all —
QDEF already permits repeated same-Type sibling Records, so repeating
Open/Hint URI once per variant already reproduces both behaviors for
free.

**One real efficiency trick checked and correctly declined, not just
skipped for being unfamiliar.** NDEF URI RTD's 1-byte prefix-code scheme
(standing in for common prefixes like `"http://www."`) is exactly the
kind of external table QDEF has borrowed before when it was worth it
(CoAP Content-Formats, COSE Algorithm IDs) — so the instinct to check it
seriously was right. It doesn't transfer cleanly: representing
`[prefix code, remainder]` as one field value needs either a bare array
(legal now that §3.2's field-value-shape rule was later dropped, but it
would silently change the field's type out from under any decoder
expecting a plain URI string there) or a CBOR tag standing in for the
code (reopening the tag-number-collision risk already rejected once for
container routing, Finding #11). Splitting the URI field into a
separate code-plus-remainder pair would work structurally, but at a real
cost: a decoder recognizing Open/Hint URI's Type but not that specific
split would see a broken, prefix-less string instead of a working URI —
undermining the one guarantee Open/Hint URI exists to make. Declined,
for a stated, checked reason, not because efficiency doesn't matter here
(it clearly does everywhere else in this project) — this was the "not
worth the complexity" escape hatch actually exercised, not left
theoretical.

**Confirmed, not just asserted, that Connection Handover (Alternative
Carrier, Handover Request/Select/Mediation), Device Information RTD, and
Verb RTD are correctly out of scope.** All three are tied to live,
bidirectional device-pairing negotiation — multiple devices exchanging
messages to agree on a Bluetooth/WiFi carrier. QDEF has no session, no
response, no multi-message exchange concept anywhere in its design; it's
static and scan-once by construction. Representing Handover's state
machine would require growing a concept foreign to the format's entire
model, for a use case QDEF was never aimed at. Signature RTD maps onto
QDEF's own already-decided, already-tracked Sign wrapper (not built,
waiting for a real adopter) — NDEF conversion is a new argument for
prioritizing it sooner, not new scope. AAR was already covered by App
Route.

Prototyped in `prototype/test/open-hint-uri.test.js`: the pre-existing
bare-URI-plus-label shape round-trips unaffected, the new language/action
fields round-trip together, an unaware decoder still gets a complete
working URI and label with both new keys silently ignored, and repeated
siblings correctly reproduce multi-language behavior.

### 33. Negative CBOR map keys — a real cross-implementation disagreement, and a competing prototype for the NDEF-`ID` question that #32 left open

Raised while following up on #32's one open thread: NDEF's `ID` field
has no QDEF equivalent, and a per-Type map key isn't architecturally the
same thing (see DESIGN.md's "NDEF's ID field" for the full layering
argument — a per-Type key is owned by that Type's author; a true
`ID`-equivalent needs to be type-independent, parsed by the mandatory
core). An array-wrapper prefix item (`[externalId]`) was already
prototyped as one candidate shape. Asked whether a reserved *negative*
CBOR map key could be a competing shape for the same job, and whether
that choice could belong to "QDEF header metadata" instead.

**Checked first: does CBOR even allow negative map keys, and does QDEF's
spec already forbid them?** Yes to the first, no to the second. General
CBOR permits any key type including negint; QDEF's spec discusses negint
only as a typeID *prefix item value* (already resolved as "excluded, not
reserved," see the Text-string-Type-IDs finding), never as a *map key*
restriction — that axis was simply never addressed.

**That gap was live, not theoretical: the Node and Rust prototypes
already disagreed on it.** Checked directly in both. The Node prototype
silently accepts a negative-integer map key and applies its existing
even/odd check unmodified (JS's `%` preserves sign, so parity still
comes out right). The Rust core's hand-rolled `cbor::read_key` had no
match arm for major type 1 (negint) and returned `Err(NotAKey)` — and
because `Records::next` treats any `parse_record` error as
unrecoverable (a malformed item's end can't be determined, so the
Sequence can't safely resume), that single unhandled key silently killed
decoding of every *subsequent* Record in the same Sequence, not just the
one that had it. Confirmed with a regression test
(`a_negative_map_key_no_longer_kills_decoding_of_sibling_records_in_the_
same_sequence` in `rust/qdef-core/src/tests.rs`) that reproduces exactly
this: a two-Record Sequence where only the first Record has a negative
key used to come back as one `Ok` followed by an `Err`.

**Fixed regardless of which design direction (if any) gets adopted**,
per the standing rule that a real Rust/JS disagreement on legal input is
a bug independent of any pending design decision. Added
`cbor::Key::NegInt(u64)` (storing the raw CBOR argument; RFC 8949 §3.1's
`-1 - arg` reconstruction and its even/odd shortcut live in
`neg_int_value`/`neg_int_is_even`), so `read_key` now reads major type 1
instead of rejecting it. `check_criticality` (Type-level) explicitly
skips `NegInt` keys, the same treatment it already gave byte-string/
text-string keys — Type-owned criticality only ever applies to `Uint`
keys. All 6 existing Rust tests plus 6 new ones pass; the `no_std`
embedded target (`thumbv6m-none-eabi`) still builds clean.

**Prototyped the negative-key shape itself as `extract_core_metadata`**
(`rust/qdef-core/src/lib.rs`) and its Node mirror (`extractCoreMetadata`
in `core.js`, exercised by `prototype/test/experimental-
core-metadata-negkey.test.js`): key `-1` reserved for `externalId`, with
an unrecognized negative key even/odd-checked at the mandatory-core
level — critical (aborts) if even, silently ignored if odd — applied
identically to every Record regardless of Type, distinct from that
Type's own `check_criticality`/`applyCriticality` pass. Byte cost against
the array-wrapper prototype was checked directly and found to be a wash
in every case tested (both add exactly one byte of framing), disproving
an initial hypothesis that the map-key form would amortize cheaper once
the map already had other fields — a CBOR container header only grows
past one byte once entry count crosses 23, and 1-to-2 never does.

**One real structural argument survives, though only for one of the two
layers it could apply to.** Reserving negative map keys for all future
mandatory-core, per-Record metadata means Phase 1's prefix-item shape
set (bare typeID, namespace-pairing array) never needs a new
array-length-disambiguated shape again — every future addition lands in
the map instead, which was already opaque to Phase 1 regardless. That
argument does not extend to the container discriminator (§3.5): it's a
once-per-container item, not a once-per-Record map, and several of its
own shapes are bare scalars, not maps, so nothing about reserving
Record-map keys says anything about whether the discriminator's shape
set is closed. See DESIGN.md for the full writeup.

**Neither option is adopted.** Both remain feasibility prototypes,
mutually exclusive, checked to the point of a fair side-by-side
comparison, with no decision made to build either into the spec.

### 34. The discriminator's eight shapes were the same governed/ungoverned dichotomy special-cased four times over — collapsed to four, reversing part of #30

Raised directly, not from a bug report: "too many shapes to represent
lots of different semantics is not easy for humans to reason [about]."
Named the specific instance precisely rather than treating "the spec
feels complex" as a vague complaint: both the namespace-ID layer (§3.5)
and the Record-Type-ID layer (§3.1) independently implement the same
governed(uint)/ungoverned(bytestring) identity choice, but the
discriminator had grown to eight recognized shapes while the Type ID
mechanism stayed at roughly two base shapes plus a repetition pattern.

**Diagnosed the actual cause, not just the symptom.** The Type ID layer
never gave "backup" or "hint" its own bespoke wire shape: a backup typeID
is just another bare item in the same prefix-item run (no combined
shape needed), and a hint is a *naming convention* (a hash-derivable
string used as the ID's own Hint field, §3.1), not a companion CBOR item
at all. The discriminator did the opposite: Finding #30 and the
"let's be comprehensive, allow all 3 forms" decision that followed it
gave every combination of (id-kind × hint-present × backup-present) its
own positional array shape — `[uint, byte string]`, `[id, text string]`,
`[uint, byte string, text string]` — on top of the map form that could
already express all of them. Four ways to say the same handful of
things is a direct, self-inflicted instance of the complaint, not
something borrowed from elsewhere in the design.

**Checked whether the array forms were pulling their weight before
cutting them, rather than cutting on aesthetic grounds alone.** They
saved a small, one-time number of bytes over the map form (a map header
plus one to two integer key bytes per optional field present) — but the
discriminator is paid exactly once per *container*, not once per
Record. This is the identical "wrapper cost math" principle already
documented for §4.1 (one-time costs don't justify the same design
pressure as a per-Record-repeated one): a few bytes saved once isn't
worth a decoder permanently carrying three more shapes to recognize.

**Cut: the three positional array forms are no longer recognized.** Any
array discriminator now degrades gracefully to "no namespace" — the
same treatment any other unrecognized shape already got, so this isn't
a new failure mode, just a narrower set of shapes that don't fail. The
discriminator is now bare uint (`0` or Allocated `N`), bare byte string
(Decentralized), or the map form — the map being the *only* way to carry
a hint or backup, with no expressiveness lost, only the redundant
compact-array shortcuts. `prototype/src/header.js`'s `parseDiscriminator`
dropped its `Array.isArray` branch entirely (arrays now simply fall
through to the existing "unrecognized" return); `prototype/test/
header.test.js`'s four array-specific tests were replaced with one test
confirming every previously-recognized array shape now degrades.
`rust/qdef-core` needed no change — it has never interpreted the
discriminator's contents, only skipped it as one opaque CBOR item, so
this entire cut was invisible to it by construction.

**A second thread the same conversation raised — whether decentralized
(byte-string) *namespace* IDs are worth keeping at all — was
deliberately not resolved here.** Unlike the discriminator-shape cut
(a strict simplification with no expressiveness lost, decidable from
spec-internal reasoning alone), this is a real design question about
whether a real adopter needs the capability, the same category of
question that resolved the analogous question for decentralized
*Record Type* IDs earlier in this project (#20, #29) — it needs TagDrop's
actual answer, not another guess from this side. One relevant, testable
hypothesis was raised in that conversation, worth recording here even
unresolved: a QR/NFC tag is typically "one file, one context," so
namespaces (roughly one per vendor/app) are far coarser-grained than
Record Types (many per namespace) — meaning the collision pressure that
justified decentralized Type IDs doesn't obviously transfer to
namespaces at the same strength, in either direction. Not decided;
flagged for the same real-adopter-feedback loop that has resolved every
other open governance question in this project.

### 35. `resolveStack`'s multi-code namespace-consistency check used reference equality on Buffers — every existing test only exercised the uint path, so it went uncaught

Surfaced while reasoning through finding #34's follow-up question:
leaning toward dropping the Allocated (uint) namespace tier entirely and
making namespace IDs always Decentralized (byte string), the question
came up whether namespace matching needs to check length *and* content
as two separate things. It doesn't — byte-string equality already
requires equal length as a precondition (two different-length byte
strings can never be byte-for-byte equal), so this is a free structural
property, not a mechanism to build. Worth noting because of what it
implied for a question from the previous exchange: since different-
length namespaces can never collide with each other, a shorter namespace
ID minted early is never retroactively endangered by other adopters
later choosing longer ones — only by other adopters choosing the *same*
length. That resolves the objection raised against letting namespace
length grow over time as adoption grows (informed by a live registry of
observed usage, an idea raised in the same conversation): the "already-
printed tags become unsafe later" risk this project was worried about
doesn't apply across length classes, only within one.

Checking whether the implementation actually does content-based
comparison (not something weaker) surfaced a real, pre-existing bug:
`wrappers.js`'s `resolveStack` checked multi-code namespace agreement
with a bare `groupHeader.namespace !== codeHeader.namespace`. For a
Buffer (Decentralized namespace), `!==` is reference identity, not
content equality — two independently `core.decodeContainer`'d Buffers
holding byte-for-byte identical namespace values are never the same
object, so this check always reported them as different. Every
multi-code Split/Wrapper group repeating a byte-string namespace across
its physical codes (exactly the pattern `multi-code-namespace.test.js`
exists to verify, spec §3.5) would have incorrectly thrown "codes in
this group declare inconsistent namespaces," even when every code
declared byte-for-byte the same namespace. A second, narrower version of
the same class of bug exists for uint namespaces too: `500 === 500n` is
`false` in JS even though they're the same logical value, so a group
mixing a `number`-typed and a `bigint`-typed encoding of the identical
namespace would also have spuriously failed.

**Why no existing test caught this:** every prior multi-code-namespace
test used a single bigint namespace constant (`NAMESPACE =
12271745624591856273n`) reused as the literal JS value on every code, so
`!==` happened to work by accident — a literal reused across `encode`
calls is still the same bigint value, and there was never a Buffer-typed
or cross-type case to exercise the actual bug.

**Fixed with a dedicated `header.namespaceEquals(a, b)`**: content
comparison (`Buffer.equals`) when either side is a Buffer, `BigInt(a) ===
BigInt(b)` otherwise (normalizing away the number/bigint representation
difference, the same trick `parseDiscriminator`'s own zero-check already
used for exactly this reason). `wrappers.js`'s `resolveStack` now calls
it instead of `!==`. Verified the fix actually matters, not just that
tests pass: reverted the one-line fix, confirmed the new regression test
fails exactly as predicted, then restored it.

Prototyped in `prototype/test/multi-code-namespace.test.js`: a
byte-string namespace repeated identically (via separate `Buffer.from()`
calls, guaranteeing distinct object identity) across a multi-code Split
group now resolves correctly; codes genuinely disagreeing on a
byte-string namespace (different content, same length) are still
correctly rejected; and `namespaceEquals` is checked directly against a
number/bigint pair for the same value.

### 36. The Allocated (uint) namespace tier was dropped — namespace IDs are always Decentralized now

Continuing the same "too many shapes to reason about" thread that
produced #34's discriminator collapse: does the namespace layer actually
need the same governed/ungoverned choice §3.1 gives Record Type IDs, or
was that duplication inherited from Type IDs without checking whether it
earns its own keep one level up? Resolved with a concrete data point
rather than more abstract reasoning: TagDrop, the project's one real
adopter, already treats its namespace as always decentralized in
practice. Combined with recognizing a namespace is architecturally
different from a Type ID — it's the *global root of trust* for
everything scoped inside it, and it's exactly the value most likely to
end up baked into physical, already-printed QR/NFC media with no way to
retroactively fix a bad choice — the Allocated (uint) namespace tier was
dropped entirely. A namespace value is now always a byte string.

**Cascading effects, all fixed together rather than left to drift:** the
container discriminator's shape table drops to three real shapes (`uint
0`, byte string, map) — any nonzero uint now degrades gracefully to "no
namespace" instead of meaning "Allocated Namespace ID." §3.1's
namespace-*pairing* prefix item followed the identical uint-or-
byte-string convention, so it needed the identical fix: a uint in the
`namespace` slot of `[namespace, typeId]` is no longer recognized as a
pairing item at all, meaningfully different from before, since the
Record now loses its only typeID (not just its namespace) and becomes
unroutable. Fixed identically in `prototype/src/core.js`'s
`isNamespacePairing` and `rust/qdef-core`'s `parse_namespace_pairing`,
with `rust/qdef-core/src/fixtures.rs` regenerated to match (the old
`ALLOCATED_NAMESPACE_PAIRING_CONTAINER` fixture is now
`UINT_NAMESPACE_SLOT_UNRECOGNIZED_CONTAINER`, same bytes, corrected
meaning and assertions). A namespace Hint is now always the fully
self-certifying case too (§3.1's hash-verification strengthening applies
to every namespace, since every namespace is a byte string) — one fewer
distinction to track versus Type ID hints, which stay split between the
plain (uint) and self-certifying (byte string) cases.

**Byte-length policy, grounded in the actual birthday-bound math rather
than picked by feel.** The naive read of keyspace size is wrong for
self-allocated IDs with no coordination — the population a width safely
supports is governed by `√N`, not `N`. Checked directly: 3 bytes (`2^24`)
reaches ~3% collision risk at just 1,000 independent picks and is
essentially guaranteed to collide by 10,000; 4 bytes (`2^32`) stays
comfortable into the tens of thousands. **Resolution: self-certify
freely at 4 bytes or longer (no coordination needed); shorter is
reserved, not self-allocatable** — safe only with uniqueness guaranteed
by direct coordination, which has no formal registry process today,
deliberately (see DESIGN.md's "Standard library governance," expanded
alongside this finding: a QDEF registry's real value is growing §4's
shared standard record types, not allocating namespace or app-specific
Type IDs that self-certification already handles for free).

**A hybrid was considered and rejected: registry-curated allocation
specifically for a 1–3 byte range, self-certification above it.**
Structurally sound — curated allocation sidesteps the birthday bound
entirely, getting the full keyspace instead of `√N`, the same way any
reviewed numeric tier does — but rejected for reintroducing the exact
governed/ungoverned split this whole pass was cutting, for a
self-admittedly niche need, without a real operating authority to run
it. Same "don't build registry infrastructure ahead of real demand"
discipline already applied to Type IDs and App Route elsewhere in this
project.

**The 4-byte floor deliberately doesn't bend toward a smaller, more
"honest" population estimate**, even though one was raised directly:
QDEF being a niche format, the real long-run namespace count might
plausibly be closer to 10–20 than 1,000+. Not disputed as a median
guess — but the two ways to be wrong about it aren't symmetric.
Over-provisioning costs a few bytes, once, forever negligible.
Under-provisioning is unfixable the moment it's printed on physical
media the format succeeds beyond the humble estimate. That asymmetry is
why the floor is sized for a plausible-upside scenario, not the median
one. Separately confirmed and load-bearing for this whole resolution:
different-length byte strings can never be byte-for-byte equal, so
cross-length collision is structurally impossible — a namespace minted
short and early is never retroactively endangered by other adopters
later choosing longer lengths, only by other adopters choosing that same
short length. That's what makes "self-certify at 4+ bytes, no
coordination, no need to track ecosystem-wide adoption over time"
durable rather than a ticking clock.

Full reasoning, the birthday-math table, and the rejected-hybrid
analysis in DESIGN.md's "Namespace IDs are always Decentralized"
section. Prototyped and cross-validated in both `prototype/src/core.js`
/ `prototype/src/header.js` and `rust/qdef-core`, all tests updated
in-place to construct namespace values as byte strings throughout rather
than left pointing at a now-nonexistent shape.

### 37. Decentralized Type IDs, backup typeIDs, and Type Hint all retired — a namespace-scoped odd uint does every job they did, cheaper

Continuing the same reality-check discipline that produced #36:
decentralized (byte string) Record Type IDs were the one Type ID form
namespace-scoped odd uints didn't obviously subsume, since they alone
could stand as a self-certifying identity with no namespace, registry,
or reachable-author trust involved at all. Raised directly: does any
concrete case — TagDrop or otherwise — actually need that property
today, or was it carried forward from an earlier design generation
without checking whether it still earns its keep? No concrete case did.
Once a declared namespace (§3.5) gives every odd uint inside it the
identical zero-coordination collision safety at 1 byte instead of 4+
per Record Type, forever, decentralized Type IDs stopped being the
cheaper option for the case they were actually being reached for in
practice — they only remained the *only* option for standing alone with
zero namespace involved, a property nobody was using.

**Three mechanisms retired together, not independently, because their
survival was interlinked:**

- **Decentralized (byte string) and reserved (text string) Record Type
  IDs.** The classification table collapses to two rows: uint even
  (Standard, always global) and uint odd (Scoped, namespace-required).
  Byte string and text string are no longer valid typeID forms at all —
  a Record's prefix now recognizes exactly two shapes, a bare uint or a
  namespace-pairing array wrapping one.
- **Backup typeIDs.** Their only remaining job — promotion between a
  decentralized form and a later-registered numeric one — evaporated
  the moment decentralized Type IDs did; there was nothing left to
  promote *from*. A Record's prefix now carries exactly one
  typeID-bearing item; a second typeID-shaped item after it is no
  longer accumulated, just silently skipped as an unrecognized prefix
  item, identical to any other unrecognized forward-compat padding.
- **Type Hint.** Existed only to attach a recoverable name to a
  decentralized Type ID and let the binding be independently verified.
  With nothing left to name, it was retired outright rather than kept
  as an orphaned mechanism. The underlying hash-derivation *algorithm*
  survives and was relocated to spec §3.5 (namespace IDs and App
  Route's hash-derived form, §4.4, are its remaining direct users) —
  only its Type-ID-specific application went away, not the primitive
  itself.

**Deliberately not built, and explicitly noted as future-evolution
ideas instead, per direct instruction:** a structured/subscoped Type ID
as a multi-element array (`[typeId, subscope, subscope, ...]`), for
hierarchical organization without strict sequential numbering — set
aside over parser-complexity concerns (unclear even/odd semantics for
subscope elements, and disambiguating the shape from the surviving
namespace-pairing array needs care); and a namespace "quick-select"
mechanism — a short (1–3 byte) back-reference letting a Record cheaply
select a namespace declared earlier in the same container instead of
repeating its full bytes — rejected for conflicting with the project's
standing "no cross-code/cross-record state, every physical code parsed
independently from a blank slate" invariant, the same one that already
killed CBOR reference/value-sharing tags and Type-ID-inheritance
(DESIGN.md's "Reference/value-sharing tags for intra-Sequence
repetition"). Neither is built; both are recorded in DESIGN.md as
deferred ideas, not silently dropped.

Verified, not just asserted: Node prototype rewritten
(`prototype/src/core.js`'s `isTypeId`/`isNamespacePairing`/
`parseRecords`), `rust/qdef-core` rewritten in lockstep
(`lib.rs`'s `parse_record`, `cbor.rs`), roughly a dozen Node test files
mechanically and manually updated (`typeIds: [X]` → `typeId: X`
throughout, plus rewritten assertions for backup-typeID and byte-
string-typeID tests), `rust/qdef-core/src/tests.rs` rewritten (28
tests), `rust/qdef-core/src/fixtures.rs` regenerated from the Node
encoder and confirmed byte-identical on re-generation both immediately
after and again after all subsequent code changes (no drift). Final
counts: 93 Node tests, 28 Rust tests, all passing;
`cargo clippy --all-targets` and a `thumbv6m-none-eabi` build both
clean.

### 38. NDEF-ID-equivalent: the freed prefix slot became the payload slot

#33 explored two competing, mutually exclusive designs for an NDEF-`ID`
equivalent (a stable, type-independent external reference any Record
can carry) — a 1-element array prefix item, and a reserved negative map
key — and left the question open, adopting neither. #37's retirement of
decentralized Type IDs and Type Hint surfaced a third option neither
prototype anticipated, because the slot it reuses didn't exist yet at
the time: the bare CBOR text string immediately following the
typeID-bearing item, previously split between two purposes (a
reserved-for-future "Named ID" typeID form, and Type Hint's own
verification string), both retired and freed at the same time.

**Zero incremental design cost, the deciding property over both #33
options.** Phase 1 already needed to check "is there a text string
right after the typeID" for reasons predating this feature (Type Hint
used to live there); repurposing that check for a general external-ID
reference added no new prefix-item shape, no new CBOR major-type
dispatch, and no reserved negative map key.

**Later replaced by the payload slot (spec §3.1).** The NDEF-ID
equivalency proved unnecessary: QDEF Records are stateless scans routed
by typeId alone, and NDEF's own `ID` field solves a problem (stable
cross-NDEF-reference) that doesn't exist in QDEF's domain. The slot was
repurposed for payload — accepting both byte strings (opaque wrapper
bytes, §4.1) and text strings (plaintext) — which wrapper records and
media content actually needed. See the spec's "Payload" subsection,
§3.1, and DESIGN.md's "Why not carry a literal NDEF message" entry.

The one still-meaningful residual test (a stray text string with no
preceding typeID is unroutable, not mistaken for payload) now lives in
`prototype/test/core.test.js` alongside the format's other Phase-1/
Phase-2 routing tests, since `ndef-id.test.js` had nothing left to say
once the payload slot shipped its own real coverage (see the spec's
"Payload" subsection's own citation).

### 39. The field-value-shape rule was dropped entirely — `skip_any_item`'s existing bounded-stack mechanism already covered the case that mattered

§3.2 used to restrict a Record field's value to flat scalars,
definite-length strings, or a tag wrapping a definite-length string
directly — anything more structured had to be pre-encoded separately
and carried as an opaque byte string, decoded again by hand. Raised
directly, prompted by the observation that a QR code's own physical
size (around 800 bytes at practical error-correction levels) already
bounds real-world complexity: is "no recursion at all, not even
bounded" a property most real decoders actually need, given that
bound, or one this project kept enforcing past the point it earned its
cost?

**Checked against the actual implementation before deciding, not
assumed safe.** The concern the old rule guarded against was
unstructured recursion overflowing a constrained embedded parser's
stack. But `skip_any_item` — the function already used to skip prefix
items (namespace-pairing arrays, tag-wrapped content) — never used true
recursion for that job; it already walked with a bounded explicit stack
(`MAX_DEPTH`, a `rust/qdef-core` implementation choice, not a
wire-format requirement). The stricter, definite-length-string-only
`skip_value` used specifically for field values was a separate,
narrower function living alongside it, enforcing a shape restriction
`skip_any_item` didn't need for its own safety. Merging field-value
skipping into `skip_any_item` and deleting `skip_value` didn't reopen
the "constrained embedded scanner, no true recursion" property this
project has repeatedly protected elsewhere — it just meant field values
now go through the identical bounded-stack mechanism prefix items
already trusted.

**One genuinely new capability was needed, not just a rule relaxation:
skipping indefinite-length (chunked) strings.** Previously only
indefinite-length *containers* were supported (a `u64::MAX` stack
sentinel); an indefinite-length byte or text string needs its own
chunk-walking loop, since each chunk carries its own length and the
terminator is a bare `0xFF` byte, not a container element count.
Implemented as an inline loop inside `skip_any_item`'s existing
byte/text-string branch; a new `cbor::Error::MalformedIndefiniteString`
catches a chunk sequence with a mismatched major type or a
nested-indefinite chunk (both illegal per RFC 8949) rather than walking
into it. §3.4's canonical-encoding requirement is unchanged — conformant
*encoders* still MUST produce definite-length forms; this is a
decoder-robustness improvement only.

**No hard depth cap at the spec level, by explicit decision — advisory
guidance instead.** Encoders SHOULD NOT nest field values more deeply
than genuinely useful content needs; a decoder MAY enforce its own
practical bound as an implementation choice (`rust/qdef-core` keeps its
existing `MAX_DEPTH: usize = 16`, now documented as this decoder's own
choice, not a wire-format mandate). The format's own physical medium is
the real-world limiter, the same reasoning that motivated dropping the
rule in the first place.

Prototyped in `prototype/test/nested-field-values.test.js` (5 tests: a
bare nested array field value, a bare nested map field value, multi-
level nesting, and criticality proven unaffected by value shape for
both even and odd keys) and `rust/qdef-core/src/tests.rs` (three tests
inverted from asserting `DisallowedFieldValueShape` errors to asserting
success, plus two new tests for indefinite-length chunked strings — one
confirming a well-formed chunk sequence skips cleanly, one confirming a
malformed one is rejected, not silently walked). Cross-validated via
`rust/qdef-core/src/fixtures.rs` regeneration (`arrayValueContainer`,
`nestedTag24Container`, and others renamed from their old
`disallowed*`/pre-relaxation names to reflect their now-legal status).

### 40. `verifyNamespaceHint` had silently disappeared from the prototype months before anyone noticed — a cited function name is a checkable claim, not just prose

While relocating §3.1's hash-derivation algorithm description to §3.5
during #37's redesign (namespace IDs are its primary surviving direct
user once Type Hint was retired), a routine check of the specific claim
being carried forward — "prototyped in `prototype/src/header.js`'s
`verifyNamespaceHint`" — against the actual current file turned up
nothing: the function didn't exist. `header.js` had no hash-derivation
code at all.

**Traced to a real, years-old regression, not a wording error in this
redesign.** `verifyNamespaceHint` was implemented for the first time in
the commit that pinned the hash-derivation algorithm and fixed a live
64-bit verification bug (`01bb2a9`, see #22's entry above — "Pinning
the hash algorithm"). A later, unrelated commit (`f31737d`, "prefix-
based typeID routing, drop Type Hint") deleted `prototype/src/typeHint.js`
as part of moving Type Hint from the field Map into the prefix, and
`verifyNamespaceHint` — which called into `typeHint.js`'s
`deriveHashId` — was deleted alongside it, with no corresponding note
in DESIGN.md or QDEF-SPEC.md that the namespace-Hint-verification
capability itself had gone away, not just been relocated. Both
documents kept citing it as prototyped across every redesign pass
since, including this session's own §3.5 rewrite, until this specific
check caught it.

**Restored, not just corrected in prose.** Namespace Hint verification
is real, load-bearing functionality — the self-certifying strengthening
§3.5 describes is only actually true if something in the prototype
checks it — so the fix was re-implementing the function, not lowering
the doc's claim to match reality. Reimplemented directly in
`prototype/src/header.js` as a small, self-contained function (no
`typeHint.js` to depend on anymore, since Type Hint itself is gone):
`deriveHashId(name, byteWidth)` using Node's `crypto` module, and
`verifyNamespaceHint(namespace, hint)` returning `'verified'` /
`'unverified'` / `'not-applicable'`. `N` is simply the candidate
namespace's own byte length now (a namespace value is always a byte
string, §3.5) rather than a magnitude-inferred uint width the way the
original, Type-Hint-era version needed — one fewer inference step,
since there's no uint form to guess a width from anymore.

Six new tests added to `prototype/test/header.test.js`: narrow (4-byte)
and wide (8-byte) verification, an unverified-Hint case (wrong name),
an unverified case for a namespace with no hash-derivation backing it
at all, a not-applicable case for a namespace or Hint that's absent,
and a real decode-to-verify round trip through `parseDiscriminator`.
All pass; full Node suite confirmed at 93/93 afterward.

**The general lesson, worth stating plainly:** a design document citing
a specific file and function name as evidence a mechanism is real is
making a falsifiable claim, not writing prose — and that claim can go
stale silently across many later, unrelated commits if nothing
re-checks it against the actual source. This project's own stated
discipline ("verify every claim directly, not by memory of what used to
be true") caught this one; it's worth treating any DESIGN.md or
QDEF-SPEC.md sentence naming a specific function as due for exactly
this kind of periodic re-check, not a one-time fact.

### 41. TagDrop's Media Preview/Payload proposal relied on Record position — tracing the failure paths (not the happy path) found the actual break, resolved as a new Phase-1 array shape instead of a Wrapper Type ID

**Later superseded.** `ID[]{}` (the optional array positioned before a
Record's mandatory Map) was replaced by making every Record its own
self-delimited CBOR array, with subrecords as ordinary trailing
elements — see #42. The diagnosis here (positional correlation's two
concrete breaks) and the decision to reject it are unaffected; only the
specific wire mechanism this entry adopted was later superseded. Kept
for the real trail.

TagDrop, integrating the spec for real, proposed a Media Preview
standard record type correlated with its Body (a Media Payload or a
Split fragment) **positionally**: "the first Record in the Sequence is
always the Preview, the second is always the Body." Evaluated by tracing
what actually happens along failure paths already defined elsewhere in
the spec, not just the happy-path example the proposal itself gave.

**Two concrete breaks, neither hypothetical.** First: §3.2's abort is
per-Record, not per-container. An unrecognized critical Preview drops
out of the Sequence and the real Body — previously "index 1" — becomes
"index 0," with no coherent reading of "index 0 is Preview" once the
thing that used to hold index 0 is gone. Every other QDEF correlation
mechanism (`group_id`, namespace pairing, payload slot) survives this because
none of them depend on index. Second: Open/Hint URI (§4.2) is an
already-shipped plain sibling Record with no position requirement, and
TagDrop already uses it — an encoder emitting it before the content
Records (entirely reasonable) silently breaks "Record 0 is Preview."
Both are the same bug shape as #26's retired optional Type-`0` header:
correct on the example given, wrong once a failure path already defined
elsewhere in the spec is actually traced.

**The common case turned out to need no new mechanism at all.** One
content item per container — Preview and Body/fragment as ordinary
plain siblings, dispatched by their own Type IDs, any order — already
fixes both breaks at zero extra bytes. Only multiplexing more than one
content item into a single container genuinely needs explicit grouping,
since nothing else then disambiguates which Preview belongs to which
Body.

**Resolved as `ID[]{}`: a new optional Phase-1 item, not a new Wrapper
Type ID.** A definite-length array positioned between a Record's
typeID/map/payload prefix items and its mandatory field Map, parsed
recursively with the *same* Record grammar already defined for the
top-level Sequence. Checked directly for safety before adopting: the
byte pattern `typeID, [array], no Map yet` was already malformed under
the pre-existing grammar (a bare typeID always required its own Map
first), so this claims previously-invalid space, not currently-valid
space — confirmed by both the Node and Rust decoders accepting it with
no change to existing fixture behavior.

**Considered and rejected, each for a concrete reason, not aesthetics:**
an array *after* the Map (`ID{}[]`) — collides with the already-legal
"Map closes, next Record starts namespace-paired" pattern, not just
ambiguous but already spoken for; letting the array replace the Map
entirely, no terminator required — makes a Record's terminator
state-dependent, so a schema-blind tool relying on "a Record always ends
at a Map" would need the full Phase-1 state machine to avoid
misreading it; a reserved negative map key signaling the shape — claims
either one fixed criticality or the entire negative-key space for a
per-Type convenience, when FINDINGS #33's negative-key groundwork was
earmarked for genuine mandatory-core metadata instead; reserving key `0`
as a Record's own typeID — collides with all four shipped standard
record types, which already use key `0` as an ordinary CRITICAL field;
an anonymous Record with no typeID at all — removes routing,
criticality, and field meaning simultaneously, one layer further than
§3.5 has ever allowed an application to omit (namespace only, never the
typeID itself).

**Prototyped and cross-validated in both decoders.** Node:
`parseRecords`/`recordToItems` in `core.js`, called recursively — an
embedded array is parsed by literally the same function as the
top-level Sequence, since a definite-length CBOR array's elements and a
CBOR Sequence's items are byte-for-byte the same shape once decoded.
Rust: `Record::embedded_records` in `rust/qdef-core` reuses the existing
`Records` iterator directly on the array's own element-byte range
(computed via the already-existing `skip_any_item`), at zero additional
parsing cost — no second buffer, no new iteration mode. 106 Node tests
and 35 Rust tests pass, including the specific regression this whole
finding turns on: an array between two sibling top-level Records (one
namespace-paired) is confirmed to start the next Record, never get
misread as a trailing embedded-Records array belonging to the first.
See DESIGN.md's "Embedded Records" entry for the full writeup and
QDEF-SPEC.md §3.1 for the normative shape.

### 42. Every Record became a self-delimited CBOR array — a companion namespace sub-scoping proposal's rejected cost led to the actual fix, which also closed a real Sequence-resumption gap for free

Raised while comparing `ID[]{}` against an alternative ordering
(`ID{}[]`): asked whether there was a real difference "besides parser
complexity." Tracing the actual objection found it wasn't complexity at
all — `map, then array` was already how a namespace-paired Record
legitimately starts, so a second meaning for the same bytes is
undecidable, not merely harder to parse. No memory-ordering argument
existed either: the array and the Map are each independently
self-describing, so there's no "more natural to build in memory" case
for either ordering.

**A companion proposal — `NAMESPACE [stream]` sub-scoping, with a
mandatory trailing `[]` on every Record as an end-of-record marker —
surfaced a real problem and an unnecessary cost in the same breath.**
Namespace-pairing being paid fresh on every Record with no amortization
is a genuine gap once several Records in one container want a shared
non-ambient namespace. But taxing every ordinary Record (fields, no
subrecords — the overwhelmingly common case) to spare the rare
subrecord-using one inverted this format's own established discipline
(Wrapper Records opt-in, payload free when absent, `ID[]{}` itself free
when unused). Checked the actual byte cost before rejecting it, not on
aesthetic grounds alone — same standing discipline used throughout this
project's cost tradeoffs.

**Resolved by wrapping every Record in its own definite-length CBOR
array** — `[namespace?, typeId, map?, payload?, subrecord*]` — subsuming
both `ID[]{}` and the earlier `[namespace, typeId]` 2-element pairing
array. The precise thing this buys: not easier interpretation of a
Record already being read (Phase 1's own logic is unchanged in
complexity), but fully generic *skipping* of a Record not being read —
no Record-grammar knowledge needed to advance past one, same as
skipping an unknown field value already required no Type-specific
knowledge. More significantly, it permanently retires the whole
*category* of ambiguity this entire redesign kept re-encountering — the
retired Type-`0` header (#26), `ID[]{}` vs `ID{}[]` (this entry), "is
this array a namespace pairing or the next Record starting" — every
instance was some version of a boundary inferred from context rather
than declared. An explicit-length array around every Record means no
boundary is ever inferred again, at any nesting depth.

**A real Sequence-resumption bug got fixed as a direct, unplanned
consequence, not a separate effort.** The prior `Records` iterator
(Rust) had a documented limitation: a malformed Record made the rest of
the Sequence unrecoverable, since the parser needed to fully interpret
a Record to know where it ended. With every Record self-bounded,
`Records::next` now determines a Record's total span *generically*
(`skip_any_item` on the whole array, requiring only well-formed CBOR,
not valid Record grammar) *before* attempting interpretation — checked
directly with a new regression test
(`a_malformed_subrecord_does_not_corrupt_its_parent_or_any_sibling_top_level_record`)
constructing a Record whose own array contents are well-formed CBOR but
invalid Record grammar (a bare Map with no typeId), confirming the
Sequence still correctly reaches the next sibling.

**Byte cost checked directly, not assumed.**
`prototype/test/custom-scheme-carrier.test.js`'s existing byte-cost
FINDING moved from 11/4 bytes (shared-container / own-URI-scheme paths)
to 12/5 — exactly one array-header byte higher on each side, confirming
the *relative* saving from skipping magic/discriminator/namespace-
scoping is unaffected, since both paths now pay the identical one-time
array-header cost.

**One concrete behavior change, checked and accepted deliberately, not
overlooked.** With namespace now a flat leading element (byte string
immediately followed by a valid typeId) instead of a nested 2-element
pairing array, a uint where a namespace was intended is no longer
detectably wrong — `core.decodeSequence` on such a Record now reports
`typeId: 100, ignored: false` (the "namespace" value read directly as
the typeId) where the old pairing-array form reported `ignored: true`
(the whole malformed pairing falling through unrecognized). Confirmed
directly in both `prototype/test/record-namespace-pairing.test.js` and
`rust/qdef-core`'s equivalent test, renamed to describe the new
behavior rather than leaving a stale "still ignored" assertion in
place. Accepted: the new failure mode is still safe (a routable Record
with an unintended typeId, not a security hole), traded for the byte
and conceptual savings of a flat namespace on *every* namespaced
Record, not just the malformed case.

**Namespace cascading to subrecords resolved the sub-scoping problem
that motivated this whole entry, via composing two already-existing
mechanisms rather than building a third.** A subrecord with no
namespace of its own now resolves against its immediate parent's own
effective namespace, recursively — implemented as `header.js`'s new
`resolveLookupKeysDeep`, which generalizes the existing container-
ambient/per-Record-override rule (§3.5) one level further rather than
introducing separate logic. Checked with a dedicated test pairing an
odd typeId that inherits its parent's namespace against a sibling
subrecord with its own override, confirming both resolve correctly in
the same tree.

**Full re-implementation, not an add-on — scope acknowledged before
starting, not discovered partway through.** Unlike `ID[]{}` (purely
additive), this changed the wire shape of every existing standard
record type (Wi-Fi, Split, Compress, Encrypt, Open/Hint URI, Media
Payload, App Route) in both prototype languages. 8 of 15 Node test
files needed fixes (hand-constructed byte sequences using the old flat
grammar, or exact byte-cost assertions), `embedded-records.test.js` was
fully replaced by `subrecords.test.js` (9 tests, new semantics), and
`rust/qdef-core`'s `tests.rs` was rewritten in full (33 tests): fixture-
generated cases updated automatically once `core.js`'s encoder changed,
hand-rolled byte constants (negative-key and indefinite-string
fixtures, which canonical CBOR can't produce) recomputed and verified
via a throwaway Node script before hardcoding. 102 Node tests and 33
Rust tests pass; clippy, fmt, and the `no_std` Cortex-M0 build all
confirmed clean; `gen-rust-fixtures.js`'s output reconfirmed
byte-identical to the committed `fixtures.rs`.

### 43. TagDrop's Media Preview (Type 14) revision wrapped two sibling Records in an array that doesn't round-trip — the container is a Sequence, not an array of Records

Reviewing TagDrop's second Media Preview proposal (subrecord-based,
correctly reworked around #41/#42's shipped grammar), its "multi-item"
example wrote two sibling Records as `[ [14, ...], [14, ...] ]` — an
outer array enclosing both. Checked against the actual decoder rather
than trusted on read: encoding that shape and decoding it returns
`{typeId: null, ignored: true}`, not two Records. The outer array's
first element is itself an array — neither a namespace byte string nor
a typeId uint — so `parseRecordArray` finds no valid prefix and the
whole thing is silently dropped, exactly the same forward-compat
tolerance that makes a genuinely malformed Record fail closed rather
than corrupt its siblings (§3.1, #41). The fix has no new mechanism:
drop the enclosing brackets. QDEF's container is a CBOR *Sequence*
(RFC 8742) of independently-decoded top-level items, not an array
containing them — two Records are two consecutive items, never one
item wrapping two. TagDrop's bot fixed this correctly on the next
revision; confirmed via `prototype/test/media-preview.test.js`, which
decodes both Records independently with subrecords intact.

The proposal's other fix — inverting Media Preview/Split nesting so
Split stays outermost (§4.1's convention) with Media Preview as its
subrecord — was proposed in review and verified at zero implementation
cost: `wrappers.js`'s `splitDecode` never reads `subrecords`, so an old
Split-only decoder with no knowledge of Type 14 reassembles a fragment
group correctly regardless of what identification metadata rides along
on each fragment. Confirmed with a `resolveStack` call whose
`knownKeysRegistry` has no entry for Type 14 at all, reassembling
successfully anyway.

### 44. Media Preview's key 1 wrongly cited §3.5's derivation algorithm, then adopted multihash instead of plain SHA-256 once the fix was already in flight

TagDrop bot's next review pass on the merged spec text caught a real
error: key 1's description cited "§3.5's derivation algorithm," but
that algorithm hashes a UTF-8 *name string* (namespace IDs, App Route's
hash-derived form) — key 1 hashes the *content bytes*, a different
input entirely despite both being SHA-256-based. Fixed to plain
"truncated SHA-256 of the content bytes" first (PR #27).

Before that fix even shipped, a design question ("committing to
SHA-256 — new key if it ever goes bad?") led to TagDrop proposing
multihash instead: a 1-byte multicodec hash-function code (`0x12` =
sha2-256) prefixing the digest, so the algorithm is self-describing
and future changes need no new key at all. Checked TagDrop's specific
adaptation before accepting it: canonical multiformats multihash also
carries its own length as a second varint byte, which TagDrop's
version drops — correctly, since this value is already a
length-delimited CBOR byte string (major type 2), so a second embedded
length would be pure redundancy. Confirmed the omission costs nothing
in interop: recovering byte-identical canonical multihash is a
one-byte insertion (the digest's own length, already known once the
CBOR byte string is decoded), not a reinterpretation.

Recognized this as the same pattern §4.1's Encrypt already uses for
its own Algorithm field (key 3, COSE's registry) — borrowing an
external registry for algorithm-agility inside one field — rather than
a new, inconsistent mechanism. `group_id` (Split) and §3.5's namespace
hash stay plain SHA-256, deliberately: they're structural/core, not
app-level convenience fields, so COSE-style tagging isn't the right
tool there. Implemented as `wrappers.js`'s `contentHashPrefix` and a
`MULTIHASH_SHA2_256` constant; `media-preview.test.js` gained a
dedicated test proving the 1-byte-function-code-plus-digest shape and
the one-byte conversion to canonical multihash. 109 Node tests pass.

### 45. "Fallback Hint" renamed to "Open/Hint URI" — the name undersold half of what the Type actually does

Surfaced while writing the README's wire-format preview: the simplest
possible QDEF payload — one QR code, one URL, nothing else — uses
exactly the same Record, byte-for-byte, as the "something useful
happens even without the specific app" companion role the old name was
named after. A developer scanning the Type list for "how do I just put
a URL in a QR code" had no reason to expect "Fallback Hint" to be the
answer — the name only described the secondary role, not the primary
one, even though nothing about the wire format distinguishes the two
uses at all.

Considered and rejected: two separate Types (one "primary," one
"fallback") for the identical field layout. No real difference exists
between the two uses — same critical URI key, same optional
label/language/action fields — so two Type IDs would mean two numbers
to recognize for identical bytes, with no decoder-enforceable
distinction behind the split; a producer could pick either one for
either role with nothing to catch the mismatch. That's the same naming
ambiguity moved one level over, not resolved, for the cost of doubled
docs, tests, and implementation surface — cutting against the same
"don't duplicate near-identical mechanisms" discipline that kept Media
Payload and Media Preview as two Types only because their *fields*
genuinely differ (§4.5).

Renamed to **Open/Hint URI** instead — a pure documentation/identifier
change, zero wire-format impact (still Type `10`, same field keys).
Swept `QDEF-SPEC.md` §4.2 (including the Type-ID table, now also noting
the primary-content role explicitly), `README.md`, `DESIGN.md`
(including fixing one now-stale verdict: the NDEF URI RTD comparison
table previously called this coverage "Partial," restricted to the
fallback case, with primary URI content wrongly assigned to Media
Payload -- corrected to "Covered," both roles, once the name itself no
longer hid that they were always the same mechanism), `ROADMAP.md`,
`prototype/README.md`, and `prototype/src/wrappers.js`'s
`FALLBACK_HINT_TYPE`/`FALLBACK_HINT_KNOWN_KEYS` constants (now
`OPEN_HINT_URI_TYPE`/`OPEN_HINT_URI_KNOWN_KEYS`) plus the renamed test
file (`open-hint-uri.test.js`). 109 Node tests still pass, unchanged in
count — confirms the wire format truly didn't move.

### 46. The payload slot's mandatory `null` marker is unrecoverable if an encoder forgets it — a silent reinterpretation, not a decode error

**Superseded.** The mechanism this entry warns about — array-shaped
payload, and the mandatory `null` marker it required — was reverted in
#48, on direct adopter feedback. A mistake that can no longer be made
needs no warning label; this entry is kept as the real trail (the
footgun was genuine at the time, verified concretely, not hypothetical)
rather than deleted.

Surfaced while auditing the payload-slot generalization (payload MAY
now be any well-formed CBOR item, including a nested Record, §3.1) for
implementer-facing clarity, not while writing the mechanism itself. The
mechanism that makes a record-shaped payload unambiguous against
subrecord 0 — a conformant encoder MUST emit a bare CBOR `null`
whenever there's no real payload but subrecords follow — has a sharp
edge nothing catches: a hand-crafted Record (or a buggy encoder) that
omits the marker doesn't fail to parse. It parses into a different,
fully well-formed Record than the one intended, with the first
subrecord silently absorbed into the payload slot instead.

Verified concretely rather than just reasoned about:
`payload-any-shape.test.js`'s `GOTCHA` test builds
`[20, {0: "image/png"}, [6, {0: "image/png"}], [7, {0: "extra"}]]` — two
subrecords intended, no `null` before them — and confirms the decoder
reads `[6, ...]` as `rec.payload` (a record-shaped payload) and only
`[7, ...]` survives as `rec.subrecords`, with the first intended
subrecord gone, not errored. Mirrored in
`rust/qdef-core/src/tests.rs`'s
`gotcha_a_missing_null_marker_silently_reads_the_first_intended_subrecord_as_payload_instead`
against hand-constructed bytes (not run through `gen-rust-fixtures.js`,
which always emits a correct encoder's output and so could never
produce this case).

Not a decoder bug — both prototypes are doing exactly what §3.1
requires, and requiring anything else (e.g. "guess based on whether the
array looks more like a Record or more like a bare subrecord") would
reintroduce real ambiguity with no reliable signal to resolve it by.
The fix is entirely on the encoder side: `prototype/src/core.js`'s
`recordToItems` already inserts the marker automatically whenever
`subrecords` is non-empty and no `payload` was given, so any caller
going through it is safe by construction — the trap only exists for
someone hand-assembling a Record array directly, or writing a second
encoder that doesn't replicate this rule. Documented as a "Caution for
your own encoder" note in `IMPLEMENTATION-NOTES.md`'s new payload-vs-
subrecord decision guidance, so a future Type author reaches for the
warning before hitting the bug, not after.

### 47. The negative-key criticality divergence (#33) was fixed, not just documented — and it retroactively completed an entry that had wrongly declared itself resolved

Prompted by a user question connecting two previously separate threads:
"can the negative-key space carry standard, cross-Type semantics for a
debugger?" turned out to require actually fixing #33's cross-
implementation disagreement first, and answering it surfaced a real
correction owed to the "NDEF's ID field" DESIGN.md entry, which had
declared the question resolved by the payload slot — checked against
what NDEF's `ID` field is actually documented to do, that was wrong:
the payload slot answers "where does a Record's own content live," not
"how does a Record get a stable, external, Type-independent reference
identity," which is what NDEF's `ID` actually provides. Neither the
payload slot nor subrecords (which solve a narrower, structural,
intra-container correlation problem) ever delivered that.

**The criticality fix.** `rust/qdef-core::check_criticality` matched
only `cbor::Key::Uint`, silently skipping every `Key::NegInt` regardless
of parity — while `prototype/src/core.js`'s `applyCriticality` already
(if accidentally) computed parity correctly, since the `cbor` package
decodes a negint item to its real signed value directly. Fixing Rust to
match had one sharp edge worth getting precisely right: `Key::NegInt`
carries the *raw CBOR argument*, not the actual value (RFC 8949 §3.1:
value = `-1 - argument`) — so the argument's own parity is the
*inverse* of the value's. A fix that ran `arg % 2 == 0` directly, as if
`arg` were the value, would compile, look plausible, and classify every
single negative key backwards. Converted to the real value first, then
applied the identical even/odd check `Key::Uint` already had — pinned
with a dedicated test walking all four small cases (`arg 0 → value -1,
odd`; `arg 1 → value -2, even`; `arg 2 → value -3, odd`; `arg 3 → value
-4, even`). `CriticalityOutcome::Aborted` and the `on_ignored` callback
both widened from `u64` to `i64` to carry negative values at all — a
breaking API change to an unstable, pre-1.0 crate, same judgment call
as the payload-slot grammar change (#46-adjacent). 42 Rust tests pass,
`cargo fmt`/`clippy -D warnings` clean.

**What it unblocked.** With both decoders agreeing, negative keys could
finally be trusted to carry cross-implementation-consistent meaning —
exactly the property a spec-governed, Type-independent "Common Field
Key" tier (§3.6) needs to be worth anything. Shipped six starter keys:
`ID` (`-1`, the actual NDEF-`ID` equivalent the DESIGN.md entry above
went looking for and, per this entry's correction, never actually
found) and `UUID` (`-3`, deliberately separate — a stronger, globally-
unique identifier, not conflated with `ID`'s weaker local-correlation
guarantee) from the user's own request; `Label` (`-7`) and `Language`
(`-9`) because Open/Hint URI's key `1`/`3` and App Route's key `1`
already, independently, duplicate the identical fields — two Types
reinventing the same thing is itself the evidence a common version is
worth having, not a hypothetical; `Content Hash` (`-11`) generalizes
Media Preview's key `1` multihash-style shape (§4.5) the same way;
`Date` (`-5`) is the one deliberately speculative addition, justified
only by how cheap it is (CBOR's own tag 0/1) and being the user's
original suggestion. All six odd/optional — none load-bearing, an old
decoder that's never heard of any of them keeps working unchanged.
Implemented in `prototype/src/commonKeys.js`,
`prototype/test/common-keys.test.js` (8 new Node tests, 129 total), and
`rust/qdef-core/src/tests.rs`'s negative-key tests. See DESIGN.md's
"Common Field Keys" entry and its correction to "NDEF's ID field."

### 48. Array-shaped payload reverted — real adopter feedback caught something design review and testing both missed: the mechanism had a real migration cost and zero usable benefit

`mofosyne/tagdrop` pushed back directly on #46's mechanism after
checking it against their own four Record Types: two of them
(`Media Preview → Media Payload`, `Split → Media Preview`) already
shipped as `[typeId, map, subrecord]`, with nothing between map and
subrecord — both would need a backward-incompatible re-encode to insert
the mandatory `null`. That's a real, measured migration cost, raised as
a direct question, not a complaint: does array-shaped payload buy
anything a first subrecord doesn't already give you?

Traced against the actual justification given when array-shaped payload
was built (a debugger telling "opaque bytes" from "nested Record"
without Type-specific knowledge): it doesn't survive. Knowing an item is
*structurally* flagged canonical tells a schema-ignorant reader nothing
about what it *means* — exactly as useless as not knowing what an
unrecognized map key means, which nothing about the payload/subrecord
distinction changes. A schema-*aware* reader doesn't need the flag
either, since it already knows which subrecord Type to look for. Neither
audience the mechanism was built for could actually use it. Tagdrop's
own follow-up sharpened this further: under subrecord-only rules, a
decoder needs no major-type check at all to know a subrecord is a
nested Record — that's true unconditionally, by grammar. Array-shaped
payload didn't just fail to deliver its claimed win; it added a check
the subrecord-only path never needed, making it strictly more complex
on the implementer side too, not merely a wash.

**Reverted:** payload excludes arrays again, permanently. An array
immediately after the Map (or typeId) is unconditionally subrecord 0 —
no marker, no lookahead, no ambiguity to resolve. The mandatory-`null`-
placeholder rule goes with it, since every other payload shape was
already unambiguous against subrecords on its own (subrecords are
exclusively arrays; nothing else was ever confusable with them). This
makes #46's footgun impossible rather than merely documented — deleted
the tests demonstrating it (`GOTCHA` in `payload-any-shape.test.js`,
`gotcha_a_missing_null_marker_...` in `rust/qdef-core/src/tests.rs`)
along with the mechanism itself, rather than leaving dead-but-passing
regression coverage for a trap nobody can fall into anymore.

Migration-free for tagdrop and for anything else already built against
what this format shipped with for most of its life — the reverted
grammar is a strict subset of the pre-array-shaped-payload rule, so
nothing that worked before this session's change stopped working after
reverting it. `core.js`'s `recordToItems` now throws a clear error on
an array-shaped or leftover-record-spec payload value instead of
silently mis-encoding it (`cbor.encodeCanonical` was confirmed, by
direct test, to happily encode a stray `{typeId, fields}` object as a
literal CBOR map with string keys — exactly the kind of silent-wrong
output this project treats as worse than a thrown error).
`rust/qdef-core`'s `payload_as_record` method removed outright as dead
code. Three `SUBRECORDS_*` fixtures regenerated back to their
pre-marker byte length. 128 Node tests (down from 129 — tests removed
without replacement, not just rewritten, since the behavior they
covered no longer exists), 39 Rust tests, `cargo fmt`/`clippy -D
warnings` clean. See DESIGN.md's "Array-shaped payload reverted" entry
for the full reasoning.
