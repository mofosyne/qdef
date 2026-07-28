# QDEF Record Type Examples

These are informative examples — actual QDEF payloads decoded into human-readable
Record Type definitions. They are not part of the normative spec; see
[QDEF-SPEC.md](QDEF-SPEC.md) for the format definition. These same
examples are validated by CI on the
[qdef-format.github.io](https://github.com/qdef-format/qdef-format.github.io)
repo (via `assets/validator-examples.js` and `scripts/test-validator.js`),
which this repo's `docs/` mirrors.

> **Note:** The hex strings below can be pasted directly into the
> [online Validator](https://qdef-format.github.io/qdef/tools/validator.html)
> to inspect the CBOR tree and generate QR codes.

## Wi-Fi + URL Bundle

A Bundle of two Records — an illustrative Wi-Fi credential (type [100]) and a standard Open/Hint URI (type [5]). Fields use key 2=SSID, 4=password, 6=encryption.

Hex: `51 44 45 46 82 82 18 64 A3 02 6E 4D 79 20 43 6F 66 66 65 65 20 53 68 6F 70 04 68 67 75 65 73 74 31 32 33 06 02 82 05 A1 00 78 1F 68 74 74 70 73 3A 2F 2F 65 78 61 6D 70 6C 65 2E 63 6F 6D 2F 63 6F 66 66 65 65 2D 6D 65 6E 75`

```js
[ 2 items // Bundle
  [ 2 items // Record [100]
    100 // typeId=[100] (global)
    { 3 keys
      2: "My Coffee Shop" // even/critical
      4: "guest123" // even/critical
      6: 2 // even/critical
    }
  ]
  [ 2 items // Record [5] — Open/Hint URI
    5 // typeId=[5] (global) - Open/Hint URI
    { 1 keys
      0: "https://example.com/coffee-menu" // payload
    }
  ]
]
```


## TagDrop Route (scoped)

A scoped Record under namespace h'89d414e0' (TagDrop) with typeId [1], payload at key 0.

Hex: `51 44 45 46 81 83 44 89 D4 14 E0 01 A2 00 48 53 6F 6D 65 44 65 73 74 02 01`

```js
[ 1 items // Bundle
  [ 3 items // TagDrop Record [1] — Content Extension
    h'89d414e0' (4 B) // namespace: 89d414e0 (TagDrop)
    1 // typeId=[1] (scoped) - Content Extension
    { 2 keys
      0: h'536f6d6544657374' // payload
      2: 1 bstr // Group ID (even/critical)
    }
  ]
]
```


## Media Preview + Payload

A Media Preview (type [7]) with keys 2=media type, 3=content hash, 5=filename. Nested Media Payload (type [3]) with content at key 0 and media type at key 1.

Hex: `51 44 45 46 81 83 07 A3 02 6A 74 65 78 74 2F 70 6C 61 69 6E 03 48 12 9D A0 88 D6 D3 61 BC 05 69 68 65 6C 6C 6F 2E 74 78 74 82 03 A2 00 58 1A 48 65 6C 6C 6F 20 66 72 6F 6D 20 54 61 67 44 72 6F 70 20 43 6F 6E 74 65 6E 74 01 6A 74 65 78 74 2F 70 6C 61 69 6E`

```js
[ 1 items // Bundle
  [ 3 items // Record [7] — Media Preview
    7 // typeId=[7] (global) - Media Preview
    { 3 keys
      2: "text/plain" uint or tstr // Media Type (even/critical)
      3: h'129da088d6d361bc' bytes // related (odd/optional)
      5: "hello.txt" bytes // signature (odd/optional)
    }
    [ 2 items // Record [3] — Media Payload
      3 // typeId=[3] (global) - Media Payload
      { 2 keys
        0: h'48656c6c6f206672...' // payload
        1: "text/plain" uint or tstr // Media Type (odd/optional)
      }
    ]
  ]
]
```


## TagDrop Content Extension

A scoped Record (typeId [1]) under namespace h'89d414e0' with three extension fields.

Hex: `51 44 45 46 81 83 44 89 D4 14 E0 01 A3 03 64 68 69 6E 74 0B 6B 64 65 73 63 72 69 70 74 69 6F 6E 0D 42 01 02`

```js
[ 1 items // Bundle
  [ 3 items // TagDrop Record [1] — Content Extension
    h'89d414e0' (4 B) // namespace: 89d414e0 (TagDrop)
    1 // typeId=[1] (scoped) - Content Extension
    { 3 keys
      3: "hint" text // hint (odd/optional)
      11: "description" text // description (odd/optional)
      13: h'0102' bytes // collection_id (odd/optional)
    }
  ]
]
```


## Single URL (type [5] — Open/Hint URI)

A minimal Open/Hint URI Record (type [5]) with the URI as payload at key 0.

Hex: `51 44 45 46 82 05 A1 00 78 18 68 74 74 70 73 3A 2F 2F 65 78 61 6D 70 6C 65 2E 63 6F 6D 2F 71 64 65 66`

```js
[ 2 items // Record [5] — Open/Hint URI
  5 // typeId=[5] (global) - Open/Hint URI
  { 1 keys
    0: "https://example.com/qdef" // payload
  }
]
```


## Empty Bundle (no subrecords)

The smallest valid QDEF payload — a Bundle containing zero Records.

Hex: `51 44 45 46 80`

```js
[] // Bundle
```


## UUID-only Bundle (tag identity)

A minimal payload with just a UUID on a Bundle — no content subrecords. Useful for inventory tracking or tag identity. (The spec allows it; which convention an app follows is an open design question.)

Hex: `51 44 45 46 81 A1 22 50 00 11 22 33 44 55 66 77 88 99 AA BB CC DD EE FF`

```js
[ 1 items // Bundle
  { 1 keys
    -3: h'0011223344556677...' // UUID (common)
  }
]
```


## Invalid: no magic header

A payload missing the QDEF magic header — the validator falls back to raw CBOR parsing and reports the mismatch.

Hex: `00 01 02 03 81 01`

```js
00 01 02 03 81 01
```

*Not a valid QDEF Bundle.*

## Namespace cascade (inherit marker)

A Bundle with namespace and ns annotation, subrecord uses h'' to inherit the namespace.

Hex: `51 44 45 46 83 44 89 D4 14 E0 67 54 61 67 44 72 6F 70 84 40 01 65 52 6F 75 74 65 A2 00 44 64 65 73 74 02 01`

```js
[ 3 items // TagDrop Record []
  h'89d414e0' (4 B) // namespace: 89d414e0 (TagDrop)
  "TagDrop" // annotation: "TagDrop"
  [ 4 items // Record [1] — Split
    h'' // namespace: 
    1 // typeId=[1] (scoped) - Split
    "Route" // annotation: "Route"
    { 2 keys
      0: h'64657374' // payload
      2: 1 bstr // Group ID (even/critical)
    }
  ]
]
```


