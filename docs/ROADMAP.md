# QDEF — Roadmap

Where this project actually is, what's deliberately left undone, and
where it's headed — for anyone landing on this repo cold. See
[`QDEF-SPEC.md`](QDEF-SPEC.md) for the format itself,
[`DESIGN.md`](DESIGN.md) for why it looks the way it does, and
[`FINDINGS.md`](FINDINGS.md) for what two rounds of actually building it
found that prose review didn't.

## Done

**The core is validated, not just written.** Magic framing, the
mandatory container discriminator, the CBOR-Sequence-of-Records layout,
per-Record prefix typeID routing, and the even/odd criticality rule have
each been built twice, independently — a Node prototype covering the
full design, and a `#![no_std]`, zero-dependency Rust prototype of just
the mandatory core that also builds for a bare-metal Cortex-M0 target.
Cross-validated against each other (the Rust decoder parses containers
the Node encoder produced, not just its own output); test counts have
grown substantially past any specific number quoted here — see each
prototype's own `test/` directory for current coverage rather than
trusting a number in this document to stay current.

**The standard library is complete and tested**, not aspirational:

- **Split** (fragmenting a payload across multiple codes, with optional
  XOR single-fragment parity)
- **Compress** (DEFLATE)
- **Encrypt** (AES-GCM-class ciphers, with optional Algorithm/Key
  Algorithm fields borrowing IANA's COSE Algorithms registry rather than
  inventing one)
- **Fallback Hint** (a URI a generic tool can follow even with no
  QDEF-specific support)
- **Media Payload** (a standard media blob — image, document — tagged
  with IANA's CoAP Content-Formats registry or a plain MIME string)
- **App Route** (letting a generic scanner offer to launch a specific
  handling application, comparable to NFC's Android Application Record,
  using a domain-verified identifier rather than an unverifiable string
  claim — plus a second, hash-derived form for scanners that just need
  a fast, no-authority misread pre-filter ahead of reassembly)

Every one of these round-trips in the Node prototype; none is spec-text
only.

**Format-wide mechanisms resolved and prototyped:** the NDEF-ID-
equivalent (a bare text string following a Record's typeID, mirroring
NDEF's own `ID` field, costing the mandatory core nothing beyond
recognizing one more prefix-item shape), namespace-scoped Type IDs and
their hash-derivation self-certification (§3.5, the general-purpose
primitive Type Hint originally introduced before being retired
alongside decentralized Type IDs — see FINDINGS.md), and canonical
encoding (§3.4, RFC 8949's deterministic CBOR rules as a MUST for
encoders, closing a live gap in `group_id`'s integrity guarantee before
it saw real use).

**Checked against a real adopter, not just designed in the abstract.**
`mofosyne/tagdrop` — the project QDEF's design was first worked out
alongside — confirmed its own sectorization already matches Split's
uniform-chunking rule, its own signing already covers the
fully-reassembled-stream case without needing a QDEF Sign mechanism, and
its §6-pattern registration is ready to use today. The same check also
surfaced a real limitation (documented, not hidden): TagDrop's
deliberately-undeclared encryption can't map onto the Encrypt Wrapper,
because being wrapped in a Type-`4` Record is itself a visible
declaration — a genuine scope boundary, not a bug (FINDINGS.md #13).

## Deliberately not done yet

- **Sign / detached-authenticity wrapper.** Direction is decided
  (content-hash-based coverage, sibling not wrapper form) and its
  prerequisite (canonical encoding) is now resolved, but it's not built.
  Waiting for a real adopter's actual need rather than building it
  speculatively — the same discipline that's driven every other decision
  here.
- **Registry governance authority.** No body currently allocates
  application Type IDs (`100`+) officially, for either the
  Specification Required (`100`–`32767`) or First Come First Served
  (`32768`+) tier; everything in the spec today is an illustrative
  placeholder — unless an adopter instead declares its own namespace
  (§3.5, always a self-chosen byte string) and uses namespace-scoped
  odd uints, which need no authority at all, ever, by design — see
  `DESIGN.md`'s "Governed vs. ungoverned, made explicit" for the full
  breakdown of which tier needs what. See "Where this is headed" below.
- **Split's general per-code capacity flexibility.** Costs nothing
  against TagDrop's own design specifically; an adopter needing
  heterogeneous fragment sizes across physically different codes still
  hits a real, open constraint.
- **A production-grade reference library.** Everything validated so far
  is explicitly throwaway (see both prototypes' own READMEs) — proof the
  design works, not something meant to be depended on.

## Where this is headed

**Near-term:** `mofosyne/tagdrop` adopting the §6 registration pattern in
its real codebase is the next actual milestone — a live pressure test,
not another design pass. Stewardship of the spec itself is intended to
move to **NFCDAB**, a wireless-art collective in the same spirit as
existing QR-art and NFC-art communities, taking on the registry-
governance role that's explicitly unresolved today.

**Longer-term:** the aim is eventual formal standardization — an IANA
registry and an RFC — once the format has real-world adoption and a
stable maintaining body behind it, rather than pursuing that path before
either exists.

This roadmap will drift out of date as work lands; check `git log` on
this file or the repo's recent commits for what's actually current.
