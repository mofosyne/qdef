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

## Fixes folded back into the spec

### 1. Hardware Parity: what happens when the tag and key 0 disagree?

§3.1 says a Record's CBOR tag and its `map[0]` carry "the *same* ID" but
never says what a decoder should do if they don't — e.g. a Record tagged
`105` whose `map[0]` says `100`. Left unspecified, a tag-aware decoder and a
constrained (key-0-only) decoder could each read a *different* Type ID out
of the identical bytes, silently disagreeing about what the Record even is.

**Fix:** a tag/key-0 mismatch is now a hard abort of that Record (same
class of failure as an unrecognized critical key) — verified in
`prototype/test/core.test.js`.

### 2. A Record with no key 0 at all

Not addressed anywhere. Key 0 is how *every* parser (tag-aware or not)
routes a Record, so a Record missing it can't be routed by anyone.

**Fix:** treat a missing key 0 the same as an unrecognized-critical-key
abort of that Record.

### 3. Split's fragment-chunking algorithm doesn't exist in the spec

§4.1's Type-2 example shows the *fields* of a Split fragment (`group_id`,
`index`, `count`, `fragment bytes`, `total_bytes`, `parity_scheme`) but
never says how the original bytes get sliced into fragments in the first
place. That's invisible right up until you need two independent
encoders/decoders to agree on it — which `parity_scheme` does, immediately:
XOR parity needs every fragment zero-padded to a common length before
XOR'ing, and recovering a missing fragment needs to know *that fragment's*
true length, which nothing in the spec provides if it's simply absent.

**Fix applied in the prototype:** fixed, deterministic chunking —
`chunkLen = ceil(total_bytes / count)`, fragments sliced sequentially, last
fragment shorter if `total_bytes` isn't an exact multiple of `count`. Any
two independent implementations that follow this formula agree without
coordination — the same content-addressing goal `group_id` already serves.

**Real tradeoff this exposes, left as an open question (see below):**
uniform chunking is what makes single-fragment XOR recovery well-defined,
but it's also *less* flexible than what a real encoder probably wants —
different physical codes (different QR versions/ECC levels, an NFC tag with
a smaller capacity than a QR sibling) plausibly need different-sized
fragments, chosen per-code rather than by one global formula. Uniform
chunking and per-code-flexible sizing are in tension, and the spec needs to
pick one (or specify a length manifest that survives a missing fragment) —
it currently does neither.

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

**Not fixed** — this is a real open question now added to §9, not resolved
by this prototype pass. Candidates: leave key provisioning explicitly
out-of-scope of the wrapper (an application-layer concern, documented as
such rather than silently assumed), or add an optional key-hint/KDF-params
field to Type 4.

### 7. Nesting order is *not* decoder-detectable — confirmed, not just assumed

§9 already asked whether `Split → Encrypt → Compress` is "just documented
convention" or something a decoder could reject if violated, and leaned
("not resolved") toward trusting the encoder. The prototype turned this
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

**Fix:** §9's open question is now answered, not open — "trust the
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
independent implementation of the mandatory core only (not the stdlib
Wrapper layer), written `#![no_std]`, with zero dependencies and zero heap
allocation — including hand-rolling the CBOR primitives instead of using a
crate for them, since using one would just re-test the Node prototype's
finding a second time.

### 8. The "minimal core" claim is true, and now has a number attached

Built in release mode for `thumbv6m-none-eabi` (Cortex-M0 — one of the most
constrained ARM targets in common use, no atomics beyond the basics), the
entire mandatory core — magic/version framing, full CBOR-Sequence walking,
key-0 routing, Hardware Parity mismatch detection, plus the even/odd
criticality helper and a field-lookup helper — compiles to **~4.4 KB of
code**, with **zero `unsafe`** and **zero heap allocation**. §3.3's claim
that a minimal implementer's surface area is genuinely small was previously
just prose confidence; it's now a measured, reproducible number tied to a
real embedded target.

### 9. Unbounded recursion depth is a real hardening gap prose review (and the Node prototype) couldn't see

Skipping past a Record field (or an entire Record) the parser doesn't
recognize requires generically walking arbitrarily-nested CBOR structures —
arrays inside maps inside tags, etc. Written the natural way (recursively),
this has no inherent bound on stack depth: a malformed or adversarial input
with deeply nested structures could exhaust the stack on a small MCU with a
few KB of RAM. This is invisible when a hosted CBOR library does the
walking for you inside a process with megabytes of stack and its own
(possibly absent) guard — which is exactly why it never came up in the Node
prototype. `rust/qdef-core/src/cbor.rs` added an explicit `MAX_DEPTH` guard
(`skip_value` returns `Error::TooDeep` past a fixed recursion limit),
verified by a dedicated test that constructs a pathologically nested input
and confirms it's rejected rather than blowing the stack.

**Fix:** the spec should say a conformant core parser must bound recursion
depth while walking structures it doesn't otherwise interpret — not a
wire-format change, but a real robustness requirement for anyone
implementing the "skip what you don't recognize" behavior §3.2/§3.3 already
require.

### 10. A malformed (not just unrecognized) Record can desync the whole Sequence — the spec's "isolated failure" promise has an unstated precondition

§3.2 promises an aborted Record doesn't affect its siblings in the same
Sequence. That promise silently assumes the Record is at least *well-formed*
CBOR — its byte length needs to be determinable to know where the next
Record starts. A genuinely malformed byte stream (truncated, an invalid
length prefix, a reserved additional-info value) means the parser can no
longer find that boundary, so it can't safely resume the Sequence at all —
a fundamentally different, worse failure than "this Record's Type/keys
aren't recognized." This distinction was invisible in the Node prototype,
where `cbor.decodeAllSync` either decodes the whole sequence or throws for
all of it — there was never a point where "resume after this specific
byte-level failure" was an explicit decision to make. Writing the Rust
`Records` iterator by hand forced the decision: it now distinguishes
"Record aborted but Sequence continues" (missing key 0, tag mismatch — see
findings #1–#2) from "Sequence itself is unrecoverable" (malformed CBOR),
and only the former lets iteration continue.

**Fix:** §3.2 should state this precondition explicitly rather than leave
it implicit — an aborted-but-well-formed Record doesn't affect siblings;
malformed CBOR at the Sequence level is a stronger failure with no
per-Record isolation possible.

## Confirmed working as designed (no fix needed)

- **Magic + version + CBOR-Sequence-of-Records** round-trips exactly as
  drawn in §2's diagram, including rejecting bad magic / wrong version.
- **Dual routing (§3.1):** a Record encoded with no CBOR tag at all (the
  "Constrained Route only" case) still routes correctly off `map[0]` alone
  — verified with a `tagged: false` encoder path in the prototype.
- **Even/odd criticality (§3.2):** an unrecognized even key aborts only
  that Record; an unrecognized odd key is silently ignored and the rest of
  the Record still processes; one aborted Record in a Sequence doesn't
  affect its siblings.
- **NDEF path (§2):** a bare CBOR Sequence with no magic/version prefix
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

None of this changes the four load-bearing design decisions called out as
settled (two-layer core/stdlib split, Hardware Parity dual routing,
even/odd criticality, Wrapper Records over a sibling key range, fixed
nesting order as encoder convention). What changed is precision: several
places that read as complete prose turned out to be underspecified the
moment two independent implementations needed to agree on wire bytes
without talking to each other first. That gap is exactly what a prototype
catches and prose review doesn't.

The Rust pass added a second kind of value beyond the Node prototype: not
just "does the design round-trip," but "does the *minimal-core* claim,
specifically, survive contact with a language and target that can't lean on
a hosted CBOR library or an OS to hide the hard parts." It did — with two
concrete hardening gaps (#9, #10) that only became visible once the
CBOR-walking and Sequence-iteration logic had to be written by hand instead
of delegated to a library call.
