# Registry Example: Registering a Decentralized Type ID

A step-by-step walkthrough of generating, validating, and using a
hash-derived byte string Record Type ID in a QDEF container.

**Before reaching for this:** a decentralized byte string Type ID is not
the recommended default for "I want a cheap ID with no registry" — a
declared namespace plus a small odd uint is cheaper (as little as 1
byte vs. 4+) and just as coordination-free (spec §3.1/§3.5). This
walkthrough is for the narrower case a namespace-scoped uint can't
cover: a single Type ID that needs to be independently self-certifying
(verifiable against its own name, with no namespace or registry
involved at all), or one shipping provisionally ahead of a
common-vocabulary registration existing yet. If you just want a cheap
ID for your own app's Record Types, see the "Namespace ID" section
below instead, and use small sequential odd uints under it.

## Quick Start

```bash
cd prototype

# 1. Generate a Type ID for your record type
node scripts/gen-type-id.js com.example.myapp/route

# 2. Validate it
node scripts/validate-type-id.js com.example.myapp/route "h'216e6add'"

# 3. Use it as a Record's prefix typeID (see below)
```

## Full Walkthrough

### Step 1: Choose a Name

Pick a reverse-domain qualified name that uniquely identifies your record
type. This is what gets hashed — the name is never sent on the wire, only
the truncated hash.

```
com.example.myapp/route
```

Reverse-domain qualification prevents collisions: two unrelated projects
picking `com.foo/route` and `com.bar/route` will derive different IDs
automatically.

### Step 2: Generate the Type ID

```bash
node scripts/gen-type-id.js com.example.myapp/route
```

Output:

```
Name:        com.example.myapp/route
Derivation:  SHA-256(UTF-8("com.example.myapp/route"))

  Full SHA-256:
    h'216e6add561001272c502d133abc9e71444d0be1ed75a80c24f705a94de5e76d'

  4-byte (recommended minimum for global use):
    Value (hex): h'216e6add'

  8-byte (maximum safety):
    Value (hex): h'216e6add56100127'
```

The 4-byte value `h'216e6add'` is your Type ID. It goes as a prefix
item before your Record's field Map (spec §3.1) — a byte string, not a
map key.

**Width choice:**

| Width | Use case |
|-------|----------|
| 2 bytes | Record Type ID within a declared namespace only |
| 4 bytes | Record Type ID global use (minimum); namespace IDs (minimum) |
| 8 bytes | Maximum collision safety |

You can force a width:

```bash
node scripts/gen-type-id.js --width 8 com.example.myapp/route
```

### Step 3: Validate

```bash
node scripts/validate-type-id.js com.example.myapp/route "h'216e6add'"
```

Output:

```
Validating: Record Type ID for "com.example.myapp/route"
  Candidate ID:  h'216e6add' (4 bytes)
  Expected hash: h'216e6add' (4 bytes)

  ✓ Hash derivation matches.
  ✓ Name is reverse-domain qualified.
  ✓ Name avoids known collision-prone patterns.
  ✓ Byte length 4 is adequate for global use.

Validation passed.
```

### Step 3.5: Choose a Variable Name

Pick a word sequence that tools can transform into identifiers in any
language. This goes into the registry submission as `Variable Name`:

| Convention | From "My App Route" |
|------------|---------------------|
| snake_case | `my_app_route` |
| CamelCase | `MyAppRoute` |
| UPPER_CASE | `MY_APP_ROUTE` |
| camelCase | `myAppRoute` |

See `registry-submission-template.md` for the full submission format.

### Step 4: Use as a standalone global Type ID, or under a declared namespace

A byte string Type ID is always global (spec §3.1) — it doesn't need a
declared namespace to be collision-safe, since collision safety comes
from the byte length you chose, not from a registry or a namespace. You
can use it directly:

```
// prefix typeID: h'216e6add'
{
  1: "route data here",              // ... your fields ...
}
```

The byte string Type ID is self-describing: a decoder that recognizes
the name `com.example.myapp/route` can verify the ID by re-deriving
the hash. A decoder that doesn't recognize the name gracefully skips
the record — no hard failure.

**A declared namespace is a separate, container-level mechanism**
(spec §3.5) — it doesn't change how a byte string Type ID like this one
is looked up (still global, still bare), but it does let you use much
cheaper *namespace-scoped odd uint* Type IDs instead, once you have more
than one Record Type to define. See "Namespace ID," below.

### Step 5: (optional) Declare a namespace for cheap, namespace-scoped Type IDs

If you're defining more than one Record Type, it's cheaper to declare a
decentralized namespace once and use small odd uint Type IDs inside it,
rather than a full byte string Type ID per Record Type. The namespace
goes in the **container discriminator** (spec §3.5) — the mandatory
CBOR item immediately after the container's magic bytes, not an ordinary
Record:

```
h'3cf2360e'                          // discriminator: bare decentralized
                                      //   namespace, no hint (cheapest form)

// prefix typeID: 1                  // your first Record, namespace-scoped
{
  1: "route data here",              // ... your fields ...
}
```

To also carry a recoverable name for the namespace, use the array or map
discriminator form instead of the bare byte string:

```
[h'3cf2360e', "com.example/myapp-paper"]     // array form: [namespace, hint]

{ 1: h'3cf2360e', 3: "com.example/myapp-paper" }   // map form (extensible)
```

**Key points:**

- The discriminator is not a Record — it has no typeID prefix and isn't
  Map-shaped by itself; it's just whichever single well-formed CBOR item
  comes right after magic, dispatched by its own CBOR major type
- A bare byte string discriminator declares a decentralized namespace
  with no hint. Namespace IDs MUST be at least 4 bytes because they are
  the global root of trust for every scoped ID in the container
- Once a namespace is declared, odd uint Type IDs become namespace-local
  (compound key `(namespace, TypeID)`) instead of global — small,
  sequential values (`1`, `3`, `5`...) are genuinely minimal on the wire
  and collision-free by construction, since collision safety now comes
  from the namespace rather than the ID's own width

### Step 6: Verify on the Wire (optional)

The CBOR wire encoding of the byte string `h'216e6add'` is:

```
44 21 6e 6a dd
│  └────────── 4 bytes of data
└───────────── CBOR major type 2 (byte string), length 4
```

The `44` prefix means "byte string of length 4" — this is how a parser
distinguishes a byte string Type ID from a uint Type ID on the wire.

## Namespace ID (same algorithm, different use)

For the container discriminator's namespace value, use `--namespace`
with `--width 4` (minimum for namespace IDs — they are the global root
of trust for all scoped IDs within a container):

```bash
node scripts/gen-type-id.js --namespace --width 4 com.example/myapp-paper
```

Output:

```
Name:        com.example/myapp-paper
Derivation:  SHA-256(UTF-8("com.example/myapp-paper")) → first 4 bytes

  Full SHA-256:
    h'3cf2360eb5e7d190c46324525d13f1031a47b02f642cf14f3ad1413ffc4d1f31'

  Truncated to 4 bytes:
    Value (hex): h'3cf2360e'
    CBOR wire:   443cf2360e

Usage in wire format: the container discriminator (spec §3.5),
the mandatory CBOR item right after magic. Cheapest form is the
bare byte string itself:
  h'<value above>'                          // decentralized namespace, no hint

To also carry a recoverable name, use the array or map form:
  [h'<value above>', "<name>"]              // array form
  { 1: h'<value above>', 3: "<name>" }      // map form
```

Namespace IDs MUST be at least 4 bytes because they are the global root
of trust: two unrelated namespaces with the same ID would cause all their
scoped Type IDs to collide. This is unlike Record Type IDs within a
namespace, where 2 bytes is acceptable because the namespace itself
provides collision safety.

## Collision Safety

Hash-derivation trades off between name qualification and ID width:

- **Same name, different widths** → different IDs (`h'216e6add'` vs
  `h'216e6add56100127'` — not equal, not interchangeable)
- **Different qualified names, same width** → almost certainly different
  IDs (SHA-256 collision probability)
- **Same bare name, different projects** → **same ID** — this is the
  exact hazard the naming guidance exists to prevent

Always reverse-domain qualify your names. See spec §3.1.

## Submitting to the Registry

Once you have a working Type ID, use `registry-submission-template.md`
in this directory to fill out a submission document. Submit it as a
GitHub Issue or Pull Request to the QDEF repository.
