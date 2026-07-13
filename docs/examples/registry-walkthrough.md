# Registry Example: Registering a Decentralized Type ID

A step-by-step walkthrough of generating, validating, and using a
hash-derived byte string Record Type ID in a QDEF container.

## Quick Start

```bash
cd prototype

# 1. Generate a Type ID for your record type
node scripts/gen-type-id.js com.example.myapp/route

# 2. Validate it
node scripts/validate-type-id.js com.example.myapp/route "h'216e6add'"

# 3. Use it in a Type 0 header (see below)
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

  4-byte (recommended minimum for global use):
    Value (hex): h'216e6add'

  8-byte (maximum safety):
    Value (hex): h'216e6add56100127'
```

The 4-byte value `h'216e6add'` is your Type ID. It goes into a Record's
key `0` as a byte string.

**Width choice:**

| Width | Use case |
|-------|----------|
| 2 bytes | Namespace-scoped only (must appear under Type 0's key 3) |
| 4 bytes | Global use — recommended minimum (spec §3.1) |
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

### Step 4: Use in a Type 0 Container Header

The first Record in a QDEF Sequence is the Type 0 header. When you use
a byte string Type ID, the container declares a namespace:

```
Type 0: {                            // Container Header (standard record type)
  0: 0,                              // CRITICAL: key 0 is always 0,
                                      //   value 0 means "this is the header"
  3: h'3cf2',                        // OPTIONAL: namespace ID (byte string)
  5: "com.example/myapp-paper"       // OPTIONAL: human-readable name
}
```

**Key points:**

- Key `0` is always the uint `0` — it identifies the record as Type 0
- Key `3` (namespace) is a byte string — this scopes all other Records
  in the Sequence to that namespace
- Key `5` (hint) is a human-readable recovery name for the namespace

A decoder seeing `key 3 = h'3cf2'` knows that odd-numbered Type IDs in
this container are namespace-local, not globally registered.

### Step 5: Use in a Regular Record

Once the container has a namespace header, your records use the byte string
Type ID directly in key `0`:

```
Type 0: {                            // Container Header
  0: 0,                              //   CRITICAL: fixed
  3: h'3cf2',                        //   OPTIONAL: namespace
  5: "com.example/myapp-paper"       //   OPTIONAL: name
}

{                                     // Your record
  0: h'216e6add',                    //   CRITICAL: byte string Type ID
  1: "route data here",              //   ... your fields ...
}
```

The byte string Type ID is self-describing: a decoder that recognizes
the name `com.example.myapp/route` can verify the ID by re-deriving
the hash. A decoder that doesn't recognize the name gracefully skips
the record — no hard failure.

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

For the Type 0 header's key `3` (namespace ID), use `--namespace`:

```bash
node scripts/gen-type-id.js --namespace --width 2 com.example/myapp-paper
```

Output:

```
Name:        com.example/myapp-paper
Derivation:  SHA-256(UTF-8("com.example/myapp-paper")) → first 2 bytes
Value (hex): h'3cf2'
CBOR wire:   423cf2

Note: 2-byte IDs are recommended for namespace-scoped use only.
  Use 4+ bytes for global (unnamespaced) use.

Usage in wire format: first Record in Sequence is Type 0, with
  key 3 (Namespace ID) = h'3cf2' (byte string)
  key 5 (name)         = "com.example/myapp-paper"
```

2 bytes is fine for a namespace ID because it only needs to be unique
within the container — it's scoped by the Type 0 header.

## Collision Safety

Hash-derivation trades off between name qualification and ID width:

- **Same name, different widths** → different IDs (`h'216e6add'` vs
  `h'216e6add56100127'` — not equal, not interchangeable)
- **Different qualified names, same width** → almost certainly different
  IDs (SHA-256 collision probability)
- **Same bare name, different projects** → **same ID** — this is the
  exact hazard the naming guidance exists to prevent

Always reverse-domain qualify your names. See spec §3.1.
