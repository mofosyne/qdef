# QDEF Registry Submission

Submit this document as a GitHub Issue or Pull Request to register your
Record Type ID with the QDEF project.

Fill in every field marked `<...>`. Delete lines marked `(or "none")`
if they don't apply. Run the validation commands and paste the output
in the Validation section.

---

Pick **one** of the two ID patterns below, depending on whether your
Record Type ID is common-vocabulary global (an even uint, spec §3.1) or
namespace-scoped (a small odd uint, requiring a declared namespace on
the root Record or an enclosing Record, spec §3.5). Don't fill in both
unless you're genuinely registering two different things.

**Option A — common-vocabulary global Type ID** (even uint `100`–`32767`,
no namespace needed; no hash-derivation involved, just a number):

```
Record Type ID:              105
Record Type Name:            com.example.smartlight/status
Variable Name:               Smart Light Status

Data item:                   map { 2: uint (on/off), 4: uint (brightness 0-100) }
Semantics:                   Reports current state of a smart light fixture
Point of contact:            <your email or URL>
Reference:                   <link to spec/README defining this Type>
```

**Option B — namespace-scoped Type ID** (small odd uint, cheaper on the
wire once you have more than one Record Type; requires the root Record
(or an enclosing Record) to declare the namespace, spec §3.5):

```
Namespace ID:                h'c103df40'
Namespace Name:              com.example/smartlight
Variable Name:               Smart Light

Full SHA-256:                h'c103df40c55c77a3bb6a9342dbc81389bb3a7315f20a92c73a7f8cfc226a1bf0'

Scoped Type ID:               1

Data item:                   map { 2: uint (on/off), 4: uint (brightness 0-100) }
Semantics:                   Reports current state of a smart light fixture
Point of contact:            <your email or URL>
Reference:                   <link to spec/README defining this Type>
```

**Variable Name** is a space-separated word sequence for generating
identifiers in any language:

| Convention | From "Smart Light Status" |
|------------|--------------------------|
| snake_case | `smart_light_status` |
| CamelCase | `SmartLightStatus` |
| UPPER_CASE | `SMART_LIGHT_STATUS` |
| camelCase | `smartLightStatus` |

## Validation

Option A (a plain number) needs no validation command — there's nothing
to hash-derive. If you're using Option B, paste the output of:

```bash
# Validate Namespace ID
node scripts/validate-type-id.js com.example/smartlight "h'c103df40'"
```

Expected output:

```
Validating: Namespace ID for "com.example/smartlight"
  Candidate ID:  h'c103df40' (4 bytes)
  Expected hash: h'c103df40' (4 bytes)

  ✓ Hash derivation matches.
  ✓ Name is reverse-domain qualified.
  ✓ Name avoids known collision-prone patterns.
  ✓ Byte length 4 is adequate to self-certify freely.

Validation passed.
```

## Description

<Brief description of what this Record Type is for and how it's used.
One to three sentences is fine.>

## Wire Example

If you have a sample CBOR encoding of a Record using this Type ID,
paste the hex dump or link to it here. Otherwise delete this section.

A Record is one CBOR array — `[typeID, field Map]` (spec §3.1) — the
typeID is never a map key:

```
82                                # array(2) — this Record's own array
   18 69                          # unsigned(105) — typeID: 105
   a2                             # map(2) — the Record's field Map
      02                          # unsigned(2) — brightness
      18 64                       # unsigned(100)
      04                          # unsigned(4) — color temp
      19 0fa0                     # unsigned(4000)
```

If this Type ID is namespace-scoped (an odd uint), show the namespace
declaration (spec §3.5) it's scoped under too — the ordinary leading
byte string of the root Record, or of an enclosing Record:

```
44 c103df40                      # bytes(4) — root namespace: h'c103df40'
82                                # array(2) — this Record's own array
   01                             # unsigned(1) — typeID: 1 (namespace-scoped)
   a2                             # map(2) — the Record's field Map
      02  18 64                   # brightness: 100
      04  19 0fa0                 # color temp: 4000
```

---

## Checklist

- [ ] Record Type ID is either a plain even uint (Option A) or a small
      odd uint scoped to a declared namespace (Option B)
- [ ] Record Type Name is reverse-domain qualified (e.g. `com.example/myapp-route`)
- [ ] Variable Name is a space-separated word sequence
- [ ] (Option B only) Full SHA-256 is pasted from `gen-type-id.js` output
- [ ] (Option B only) `validate-type-id.js` passes for the Namespace ID
- [ ] Data item shape is described (map keys and value types)
- [ ] Point of contact is provided
- [ ] Reference link to your spec/README is provided
