# QDEF — Quick Data Exchange Format

QDEF is a general-purpose binary container for multi-action 2D barcodes (QR,
Data Matrix, Aztec) and NFC tags. It plays the role for optical/byte-mode
payloads that [NDEF](https://en.wikipedia.org/wiki/NFC_Data_Exchange_Format)
already plays for NFC — "carry one or more typed records in a single
scan/tap" — a container format that doesn't exist today for the plain
byte-mode QR case.

A single QDEF payload can carry several independent, unrelated pieces of
information at once — a Wi-Fi credential and an event ticket on the same
sticker, for example — where each piece is parsed by whichever app
recognizes its type and ignored by every app that doesn't.

## What a QDEF payload actually looks like

A single scan carrying a Wi-Fi credential *and* a fallback URL — two
unrelated Records, each independently routable, in one 74-byte payload
(CBOR diagnostic notation, [cbor.me](https://cbor.me) style):

```
51 44 45 46                              # "QDEF" magic (4 bytes,
                                          #   NFC drops this -- see below)

82                                        # root Record: array(2) -- typeId
                                          #   omitted, defaults to 0 (Bundle);
                                          #   its 2 items are its subrecords

   82                                    #   Record 1: array(2)
      18 64                             #     typeID: 100 (Wi-Fi, illustrative)
      a3                                #     field map(3)
         00   6e 4d 79 20 43 6f 66 66 65 65 20 53 68 6f 70
                                        #       key 0: "My Coffee Shop"
         02   68 67 75 65 73 74 31 32 33 #     key 2: "guest123"
         04   02                        #       key 4: 2 (WPA2)

   82                                    #   Record 2: array(2)
      0a                                #     typeID: 10 (Open/Hint URI,
                                          #       standard record type)
      a1                                #     field map(1)
         00   78 1f 68 74 74 70 73 3a 2f 2f 65 78 61 6d 70
              6c 65 2e 63 6f 6d 2f 63 6f 66 66 65 65 2d 6d
              65 6e 75
                                        #       key 0: "https://example.com/coffee-menu"
```

In JSON-ish terms, that's:

```jsonc
// magic, then the root Record: typeId omitted (implicit Bundle),
// its 2 subrecords each self-contained with their own typeId
[
  [100, { "0": "My Coffee Shop", "2": "guest123", "4": 2 }],
  [10,  { "0": "https://example.com/coffee-menu" }]
]
```

A Wi-Fi app reads Record 1 and ignores Record 2; a generic scanner with
no Wi-Fi support at all still offers the fallback URL from Record 2.
Neither app needs to know the other's Type exists — this is the whole
point, the same one [NDEF](https://en.wikipedia.org/wiki/NFC_Data_Exchange_Format)
already solves for NFC (see the FAQ below). Full grammar in
[`docs/QDEF-SPEC.md`](docs/QDEF-SPEC.md) §3; more worked examples in
[`docs/EXAMPLES.md`](docs/EXAMPLES.md).

## Status

**Draft, not yet implemented as a reference library — but the design is
validated, not just written.** The core wire format and the full standard
library (Split, Compress, Encrypt, Open/Hint URI, Media Payload) are all
round-trip tested, across two independent throwaway prototypes:

- [`/prototype`](prototype) (Node) — real code encoding and decoding real
  QDEF bytes end to end, including the multi-fragment split/encrypt worked
  example with fragment-loss recovery.
- [`/rust/qdef-core`](rust/qdef-core) (Rust, `#![no_std]`) — an independent
  reimplementation of just the mandatory core, with hand-rolled CBOR
  primitives and zero dependencies, that also builds for a bare-metal
  Cortex-M0 target — checking the spec's "a deeply constrained scanner can
  implement this" claim against an actual constrained target rather than
  leaving it as prose.

Neither has been used in production anywhere, and Record Type IDs
referenced in the spec (`100`, `105`, `900`, `950`, etc.) are illustrative
placeholders, not an allocated registry.

See [`docs/FINDINGS.md`](docs/FINDINGS.md) for what both prototypes found
and fixed — several real interop and hardening gaps that careful prose
review alone hadn't caught — and [`docs/ROADMAP.md`](docs/ROADMAP.md) for
what's done, what's deliberately not done yet, and where this is headed.

## Why QDEF

Existing text barcode schemas (`WIFI:S:...;;`, `BEGIN:VCARD`) are rigid,
single-purpose, and text-only. NDEF solves multi-record framing, but only
for NFC. Nothing today fills the equivalent role for a plain byte-mode
optical code, or for an NFC payload with no application-specific MIME type
already routing it.

QDEF is:

- **Binary-first**, not text-safe — no alphanumeric-mode constraint, so no
  base32/base41-style encoding overhead.
- **Multi-action** — one self-delimited CBOR array of Records, so
  unrelated applications can share one physical code.
- **Layered**, on purpose: a minimal mandatory *core* (routing and
  criticality only) plus a separate, optional *standard library*
  (splitting a payload across multiple codes, compression, encryption, a
  URI to open or fall back to) — the same relationship C-the-language
  has with libc. A minimal implementer never needs a compression or
  reassembly library just to route Records.
- **Usable by a deeply constrained scanner.** Every Record's type is
  readable at zero decode cost from a plain map key — no CBOR tag support
  needed, no semantic-tag-aware library at all. QDEF doesn't use CBOR tags
  for routing (an earlier draft did; dropped after finding it collided
  with the IANA tag registry — see `docs/FINDINGS.md` #11–#12).

QDEF is meant for adoption by unrelated applications with no shared
history. The format's own spec works through a Wi-Fi-provisioning example
and a full worked example of backing up a passphrase-protected secret key
across several printed QR codes — see §5 and §8 of the spec.

**When QDEF is *not* the right fit:** if your application already has its
own text/URI scheme (something a user could type or click), encode your
data directly under that scheme instead of wrapping it in QDEF — the scheme
prefix already does the recognition job QDEF's magic header exists for.
QDEF earns its place on carriers with no pre-existing dispatch: a plain
byte-mode QR with no URI at all, or an NFC payload with no app-specific
MIME type already routing it.

## FAQ

**Why not just use NDEF?** NDEF already solves multi-record framing —
but only for NFC. There's no equivalent for a plain byte-mode QR, Data
Matrix, or Aztec code, and that gap is what QDEF's magic bytes exist to
fill. Over NFC itself, QDEF isn't a replacement for NDEF at all: it
rides inside NDEF's own MIME-type record (`application/vnd.qdef`) with
no magic bytes and no discriminator needed (§2) — NDEF already did the
recognition job.

**Why not a plain text scheme, like `WIFI:S:...;;` or `BEGIN:VCARD`?**
Those are rigid and single-purpose — one scheme, one kind of data, no
way to carry a second, unrelated piece of information in the same code.
They're also text, which costs real bytes in a QR's alphanumeric mode
(base32/base41-style encoding overhead) that a binary format like QDEF
never pays.

**Why CBOR instead of JSON or Protobuf?** JSON is text — the same
byte-cost problem as the text schemes above. Protobuf needs an
externally shared `.proto` schema just to parse a message at all, which
conflicts with QDEF's whole premise: unrelated applications, with no
shared history, each recognizing only the Records they care about and
skipping the rest with zero schema knowledge. CBOR's self-describing
major-type framing is exactly the property that skip works on (§3.1).

**Isn't this just binary XML?** Checked, not assumed — see
[`docs/DESIGN.md`](docs/DESIGN.md)'s "Checked against binary-XML
precedent" entry. EXI, Fast Infoset, and YANG/CBOR all lean on a shared
schema for their real compactness gains, which is the same conflict
Protobuf has with QDEF's zero-coordination requirement. ASN.1/BER (CBOR's
own actual lineage) and SenML's Base Name (independently convergent with
QDEF's own ambient-namespace design, §3.5) are the closer relatives.
Nothing found there worth importing.

**Is this ready to use today?** No — draft status. The design is
validated by two independent throwaway prototypes round-tripping the
full wire format (see Status, above), but neither is a reference
library, no implementation has shipped in production, and Record Type
IDs in the spec are illustrative placeholders, not an allocated
registry yet. See [`docs/ROADMAP.md`](docs/ROADMAP.md) for what that
actually blocks.

## Repository layout

- [`docs/QDEF-SPEC.md`](docs/QDEF-SPEC.md) — the format specification
  (normative).
- [`docs/DESIGN.md`](docs/DESIGN.md) — why the spec looks the way it does:
  mechanisms tried and removed, alternatives weighed and rejected, and
  what's still unresolved. Non-normative.
- [`docs/FINDINGS.md`](docs/FINDINGS.md) — what the round-trip prototype
  found and changed in the spec.
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — what's done, what's deliberately
  deferred, and where the project is headed.
- [`docs/IMPLEMENTATION-NOTES.md`](docs/IMPLEMENTATION-NOTES.md) — worked
  examples for data shapes beyond the spec's simple, flat, single-Record
  cases (a calendar with multiple events, and the options for representing
  it). Non-normative.
- [`prototype/`](prototype) — a throwaway Node.js implementation used to
  validate the design by actually encoding and decoding QDEF bytes. Not a
  reference library; see its own README for scope and how to run it.
- [`rust/qdef-core/`](rust/qdef-core) — a throwaway `#![no_std]` Rust
  reimplementation of just the mandatory core, used to check that layer's
  "genuinely minimal, no CBOR library required" claim against a real
  bare-metal target. Not a reference library either; see its own README.

## Roadmap

Near-term: `mofosyne/tagdrop` adopting the §6 registration pattern in its
real codebase is the next milestone — a live pressure test, not another
design pass. Spec stewardship is intended to move to **NFCDAB**, a
wireless-art collective in the same spirit as existing QR-art and
NFC-art communities, taking on the registry-governance role that's
explicitly unresolved today (see `docs/DESIGN.md`). Longer-term, the aim
is eventual formal standardization — an IANA registry and an RFC — once
the format has real-world adoption and a stable maintaining body behind
it. Full detail, including what's deliberately not built yet and why, in
[`docs/ROADMAP.md`](docs/ROADMAP.md).

## Origin

QDEF's design was first worked out while building
[`mofosyne/tagdrop`](https://github.com/mofosyne/tagdrop), a dead-drop/QR
content-sharing app that needed exactly this kind of container for its own
byte-mode QR/NFC path. TagDrop is one adopter of QDEF, not the reason the
format exists — the spec is written for, and the worked examples include,
applications with nothing to do with TagDrop.
