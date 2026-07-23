# Registry Example: Registering a Record Type ID

A step-by-step walkthrough of choosing a Record Type ID for a new QDEF
Record Type, and — if you want cheap IDs for more than one Record Type —
declaring a namespace to hold them.

**Decentralized (byte string) Record Type IDs no longer exist** (spec
§3.1) — a namespace-scoped odd uint gives every Record Type inside a
declared namespace the identical zero-coordination collision safety at
a fraction of the cost (1 byte instead of 4+, every Record Type,
forever), so there's no self-certifying byte-string ID form to register
here anymore. Choosing a Type ID is just picking a number now; the only
step that still involves hash-derivation is declaring a *namespace*
(below), if you want one.

## Quick Start

```bash
cd prototype

# 1. If you're defining more than one Record Type, declare a namespace
node scripts/gen-type-id.js com.example/myapp-paper

# 2. Validate it
node scripts/validate-type-id.js com.example/myapp-paper "h'3cf2360e'"

# 3. Pick small sequential odd uints for your Record Types under it
#    (1, 3, 5, ... -- see "Choosing a Type ID," below)
```

## Choosing a Type ID

Work through spec §4's decision tree; the short version:

| Your situation | Type ID form | Cost |
|---|---|---|
| Part of QDEF's own standard-record-type infrastructure | even uint `0`–`22` (Standards Action, spec-maintained) | n/a — not self-picked |
| Want unrelated implementers to eventually recognize this Type, even with no registry yet | even uint `100`–`32767` (Specification Required) — ship with an illustrative number, no hash-derivation needed | 1–3 bytes |
| Have (or are willing to declare) your own namespace | odd uint inside it, small and sequential (`1`, `3`, `5`, ...) | as little as 1 byte |
| Isolated carrier (own URI scheme / own NDEF MIME type) and don't want to declare a namespace | self-allocated even uint `32768`+ (First Come First Served) | 1–3 bytes, carrier-dependent safety |

Most application Record Types land in the third row — declare a
namespace once, then use cheap sequential odd uints under it. That's
the only row involving hash-derivation, so it's the one this
walkthrough covers in detail.

## Declaring a Namespace

### Step 1: Choose a Name

Pick a reverse-domain qualified name that uniquely identifies your
namespace. This is what gets hashed — the name is never sent on the
wire, only the truncated hash.

```
com.example/myapp-paper
```

Reverse-domain qualification prevents collisions: two unrelated
projects picking `foo` and `bar` as bare names could plausibly collide;
`com.foo` and `com.bar` can't, since DNS registration is itself a
collision-free allocation system.

### Step 2: Generate the Namespace ID

```bash
node scripts/gen-type-id.js com.example/myapp-paper
```

Output:

```
Name:        com.example/myapp-paper
Derivation:  SHA-256(UTF-8("com.example/myapp-paper"))

  Full SHA-256:
    h'3cf2360eb5e7d190c46324525d13f1031a47b02f642cf14f3ad1413ffc4d1f31'

  4-byte (recommended minimum, self-certify freely):
    Value (hex): h'3cf2360e'

  8-byte (maximum safety):
    Value (hex): h'3cf2360eb5e7d190'
```

The 4-byte value `h'3cf2360e'` is your namespace value. It's written as
the leading byte string of a Record (spec §3.1) — most often the
container root itself, immediately after the container's magic bytes.

Namespace IDs MUST be at least 4 bytes, because a namespace is the
*global root of trust* for everything scoped inside it: two unrelated
namespaces colliding means every Type ID scoped to each collides too.
This is unlike a namespace-scoped Type ID itself, where 2 bytes is
plenty — collision safety there comes from the namespace, not the ID's
own width.

You can force a width:

```bash
node scripts/gen-type-id.js --width 8 com.example/myapp-paper
```

### Step 3: Validate

```bash
node scripts/validate-type-id.js com.example/myapp-paper "h'3cf2360e'"
```

Output:

```
Validating: Namespace ID for "com.example/myapp-paper"
  Candidate ID:  h'3cf2360e' (4 bytes)
  Expected hash: h'3cf2360e' (4 bytes)

  ✓ Hash derivation matches.
  ✓ Name is reverse-domain qualified.
  ✓ Name avoids known collision-prone patterns.
  ✓ Byte length 4 is adequate to self-certify freely.

Validation passed.
```

### Step 4: Use it as the root namespace

```
h'3cf2360e'                          // root namespace, no hint (cheapest form)
1, {                                 // typeId + map, namespace-scoped —
  1: "route data here",              //   this Record IS the root, no
}                                     //   Bundle indirection needed
```

To also carry a recoverable Hint name for the namespace, add a Bundle
map (typeId `0`, or simply omitted — Bundle is the default) right after
the namespace instead of going straight to your first Record:

```
h'3cf2360e', { 3: "com.example/myapp-paper" }   // namespace + hint, still Bundle
[ 1, { 1: "route data here" } ]                 // your Record as a subrecord
```

**Key points:**

- The namespace is not a separate container-level item — it's the
  ordinary leading byte string of a Record (root or subrecord alike,
  spec §3.1), recognized unconditionally, with no typeID-pairing
  requirement to satisfy
- A namespace with no hint costs nothing beyond the byte string itself;
  a Record can sit flat at the root right after it with zero Bundle
  indirection
- A recoverable Hint name costs one Bundle map (`{3: "..."}`) — at that
  point your own Record(s) become the root Bundle's subrecords, since
  the map slot is taken
- Once a namespace is declared, odd uint Type IDs become namespace-local
  (compound key `(namespace, TypeID)`) instead of requiring a
  registration of their own — small, sequential values (`1`, `3`, `5`...)
  are genuinely minimal on the wire and collision-free by construction,
  since collision safety comes from the namespace rather than the ID's
  own width

### Step 5: Verify on the Wire (optional)

The CBOR wire encoding of the byte string `h'3cf2360e'` is:

```
44 3c f2 36 0e
│  └────────── 4 bytes of data
└───────────── CBOR major type 2 (byte string), length 4
```

The `44` prefix means "byte string of length 4."

## Collision Safety

Hash-derivation trades off between name qualification and ID width:

- **Same name, different widths** → different IDs (`h'3cf2360e'` vs
  `h'3cf2360eb5e7d190'` — not equal, not interchangeable)
- **Different qualified names, same width** → almost certainly different
  IDs (SHA-256 collision probability)
- **Same bare name, different projects** → **same ID** — this is the
  exact hazard the naming guidance exists to prevent

Always reverse-domain qualify your names. See spec §3.5.

## Submitting to the Registry

Once you've chosen a Type ID (and declared a namespace, if applicable),
use `registry-submission-template.md` in this directory to fill out a
submission document. Submit it as a GitHub Issue or Pull Request to the
QDEF repository.
