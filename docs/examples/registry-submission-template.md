# QDEF Registry Submission

Submit this document as a GitHub Issue or Pull Request to register your
Record Type ID with the QDEF project.

Fill in every field marked `<...>`. Delete lines marked `(or "none")`
if they don't apply. Run the validation commands and paste the output
in the Validation section.

---

## Registration

```
Record Type ID:             h'4b1f561b'
Record Type Name:           com.example.smartlight/status
Full SHA-256:               h'<paste full 32-byte hash from gen-type-id output>'

Namespace ID:               h'c103'
Namespace Name:             com.example.smartlight
Full SHA-256:               h'<paste full 32-byte hash from gen-type-id output>'

Scoped Type ID:             1

Data item:                  map { 2: uint (on/off), 4: uint (brightness 0-100) }
Semantics:                  Reports current state of a smart light fixture
Point of contact:           <your email or URL>
Reference:                  <link to your spec/README defining this Type>
```

## Validation

Paste the output of these commands:

```bash
# Validate Record Type ID
node scripts/validate-type-id.js com.example.smartlight/status "h'4b1f561b'"

# Validate Namespace ID
node scripts/validate-type-id.js --namespace com.example.smartlight "h'c103'"
```

Expected output:

```
Validating: Record Type ID for "com.example.smartlight/status"
  Candidate ID:  h'4b1f561b' (4 bytes)
  Expected hash: h'4b1f561b' (4 bytes)

  ✓ Hash derivation matches.
  ✓ Name is reverse-domain qualified.
  ✓ Name avoids known collision-prone patterns.
  ✓ Byte length 4 is adequate for global use.

Validation passed.

Validating: Namespace ID for "com.example.smartlight"
  Candidate ID:  h'c103' (2 bytes)
  Expected hash: h'c103' (2 bytes)

  ✓ Hash derivation matches.
  ✓ Name is reverse-domain qualified.
  ✓ Name avoids known collision-prone patterns.
  ℹ Byte length 2 is suitable for namespace-scoped use.

Validation passed.
```

## Description

<Brief description of what this Record Type is for and how it's used.
One to three sentences is fine.>

## Wire Example

If you have a sample CBOR encoding of a Record using this Type ID,
paste the hex dump or link to it here. Otherwise delete this section.

```
a2                              # map(2)
   00                           # unsigned(0) — key: Type ID
   44 4b1f561b                  # bytes(4) — value: h'4b1f561b'
   02                           # unsigned(2) — key: payload
   a2                           # map(2)
      02                        # unsigned(2) — brightness
      18 64                     # unsigned(100)
      04                        # unsigned(4) — color temp
      19 0fa0                   # unsigned(4000)
```

---

## Checklist

- [ ] Record Type ID is a valid hex byte string (4+ bytes for global use)
- [ ] Record Type Name is reverse-domain qualified (e.g. `com.example.myapp/route`)
- [ ] `validate-type-id.js` passes for Record Type ID
- [ ] `validate-type-id.js --namespace` passes for Namespace ID (if applicable)
- [ ] Data item shape is described (map keys and value types)
- [ ] Point of contact is provided
- [ ] Reference link to your spec/README is provided
