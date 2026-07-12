'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('../src/core');
const wrappers = require('../src/wrappers');

// ---------------------------------------------------------------------
// §4.4's App Route (Type 7): a plain stdlib Record, not a wrapper, for
// letting a generic scanner offer to launch a specific handling
// application (GitHub issue #10) — comparable to NFC's Android
// Application Record. Key 2 is a domain, verified the way Android App
// Links / iOS Universal Links already are; QDEF never touches how that
// verification or dispatch actually happens, only carries the identifier.
// ---------------------------------------------------------------------

test('App Route with a domain and a human-readable label round-trips', () => {
  const container = core.encodeContainer([
    {
      typeId: wrappers.APP_ROUTE_TYPE,
      fields: new Map([
        [2, 'example.com'],
        [3, 'Open in Example App'],
      ]),
    },
  ]);

  const { records } = core.decodeContainer(container);
  const rec = core.applyCriticality(records[0], wrappers.APP_ROUTE_KNOWN_KEYS);

  assert.equal(rec.aborted, false);
  assert.equal(rec.map.get(2), 'example.com');
  assert.equal(rec.map.get(3), 'Open in Example App');
});

test('the label is optional — a domain alone is a complete App Route Record', () => {
  const container = core.encodeContainer([
    { typeId: wrappers.APP_ROUTE_TYPE, fields: new Map([[2, 'example.com']]) },
  ]);

  const { records } = core.decodeContainer(container);
  const rec = core.applyCriticality(records[0], wrappers.APP_ROUTE_KNOWN_KEYS);

  assert.equal(rec.aborted, false);
  assert.equal(rec.map.get(2), 'example.com');
  assert.equal(rec.map.has(3), false);
});

test('App Route is not positionally special — routes the same whether first or last in the Sequence', () => {
  const routeFirst = core.encodeContainer([
    { typeId: wrappers.APP_ROUTE_TYPE, fields: new Map([[2, 'example.com']]) },
    { typeId: 100, fields: new Map([[2, 'SSID'], [4, 'pass'], [6, 2]]) },
  ]);
  const routeLast = core.encodeContainer([
    { typeId: 100, fields: new Map([[2, 'SSID'], [4, 'pass'], [6, 2]]) },
    { typeId: wrappers.APP_ROUTE_TYPE, fields: new Map([[2, 'example.com']]) },
  ]);

  for (const container of [routeFirst, routeLast]) {
    const { records } = core.decodeContainer(container);
    const route = records.find((r) => r.typeId === wrappers.APP_ROUTE_TYPE);
    const checked = core.applyCriticality(route, wrappers.APP_ROUTE_KNOWN_KEYS);
    assert.equal(checked.aborted, false);
    assert.equal(checked.map.get(2), 'example.com');
  }
});

test('an application with no interest in App Route skips the whole Record cleanly by Type ID alone', () => {
  const container = core.encodeContainer([
    { typeId: wrappers.APP_ROUTE_TYPE, fields: new Map([[2, 'example.com']]) },
    { typeId: 100, fields: new Map([[2, 'SSID'], [4, 'pass'], [6, 2]]) },
  ]);

  const { records } = core.decodeContainer(container);
  const KNOWN_TYPES = new Map([[100, new Set([0, 2, 3, 4, 6])]]);
  const handled = records
    .filter((r) => !r.aborted && KNOWN_TYPES.has(r.typeId))
    .map((r) => core.applyCriticality(r, KNOWN_TYPES.get(r.typeId)));

  assert.equal(records.length, 2);
  assert.equal(handled.length, 1);
  assert.equal(handled[0].typeId, 100);
});

// ---------------------------------------------------------------------
// The decentralized form (spec update, GitHub issue #10 follow-up): key
// 2 as a private-use-random uint instead of a domain string, with key 3
// playing Type Hint's "Hint" role rather than a human-readable label.
// Same Record Type, same known-keys set — the shape rule (§3.2) already
// allows a uint at key 2, so this is a usage pattern, not a format
// change. Unlike the domain form, this carries no anti-spoofing property
// and exists only as a fast, per-code misread pre-filter ahead of
// §4.1's group_id check — never a substitute for the domain form's real
// auto-launch dispatch.
// ---------------------------------------------------------------------

test('App Route decentralized form (private-use uint + Hint name) round-trips', () => {
  const container = core.encodeContainer([
    {
      typeId: wrappers.APP_ROUTE_TYPE,
      fields: new Map([
        [2, 12271745624591856273n],
        [3, 'com.example/tagdrop-paper'],
      ]),
    },
  ]);

  const { records } = core.decodeContainer(container);
  const rec = core.applyCriticality(records[0], wrappers.APP_ROUTE_KNOWN_KEYS);

  assert.equal(rec.aborted, false);
  assert.equal(rec.map.get(2), 12271745624591856273n);
  assert.equal(rec.map.get(3), 'com.example/tagdrop-paper');
});

test('a scanner that only understands the domain form still skips a decentralized-form Record cleanly by Type ID alone (no crash on a uint where it might expect a string)', () => {
  const container = core.encodeContainer([
    {
      typeId: wrappers.APP_ROUTE_TYPE,
      fields: new Map([[2, 12271745624591856273n], [3, 'com.example/tagdrop-paper']]),
    },
  ]);

  const { records } = core.decodeContainer(container);
  const rec = core.applyCriticality(records[0], wrappers.APP_ROUTE_KNOWN_KEYS);

  // Nothing in §4.4 requires key 2 to be a particular CBOR type at the
  // routing layer — a decoder that only cares about Type ID 7 existing
  // (e.g. "is *any* App Route present") never needs to inspect key 2's
  // shape at all to skip cleanly.
  assert.equal(rec.aborted, false);
});

// ---------------------------------------------------------------------
// Companion ID (key 5, spec update): lets the domain form declare the
// same private-use-random ID the decentralized form carries standalone
// on sibling codes, so a scanner that verifies this Record's domain
// learns a verified-trust binding for that ID — stronger than the
// decentralized form's own hash-derivation, which only proves
// self-consistency. QDEF itself only carries the bytes; "verification
// succeeded" is a scanner-side fact these tests simulate by choosing to
// trust the domain field, the same way every other App Route test
// simulates OS-level dispatch without an actual OS present.
// ---------------------------------------------------------------------

test('domain form with a Companion ID round-trips both the domain and the ID together', () => {
  const container = core.encodeContainer([
    {
      typeId: wrappers.APP_ROUTE_TYPE,
      fields: new Map([
        [2, 'example.com'],
        [3, 'Open in Example App'],
        [5, 12271745624591856273n],
      ]),
    },
  ]);

  const { records } = core.decodeContainer(container);
  const rec = core.applyCriticality(records[0], wrappers.APP_ROUTE_KNOWN_KEYS);

  assert.equal(rec.aborted, false);
  assert.equal(rec.map.get(2), 'example.com');
  assert.equal(rec.map.get(5), 12271745624591856273n);
});

test('a metadata code (domain form + Companion ID) and a sibling code (decentralized form alone) carry a matching ID a scanner can bind together', () => {
  const metadataCode = core.encodeContainer([
    {
      typeId: wrappers.APP_ROUTE_TYPE,
      fields: new Map([[2, 'example.com'], [5, 12271745624591856273n]]),
    },
  ]);
  const siblingCode = core.encodeContainer([
    { typeId: wrappers.APP_ROUTE_TYPE, fields: new Map([[2, 12271745624591856273n]]) },
  ]);

  const metadataRec = core.applyCriticality(
    core.decodeContainer(metadataCode).records[0],
    wrappers.APP_ROUTE_KNOWN_KEYS,
  );
  const siblingRec = core.applyCriticality(
    core.decodeContainer(siblingCode).records[0],
    wrappers.APP_ROUTE_KNOWN_KEYS,
  );

  // The wire-level fact QDEF guarantees: the two IDs are the same value.
  // Whether a scanner actually treats that as "verified trust" depends on
  // whether it verified the metadata code's domain claim first (§4.4) —
  // out of scope for QDEF itself, simulated here as already having
  // happened.
  assert.equal(metadataRec.map.get(5), siblingRec.map.get(2));
});

test('a decoder from before Companion ID existed still accepts the domain form — key 5 is odd/optional, not a breaking addition', () => {
  const container = core.encodeContainer([
    {
      typeId: wrappers.APP_ROUTE_TYPE,
      fields: new Map([[2, 'example.com'], [5, 12271745624591856273n]]),
    },
  ]);

  const PRE_COMPANION_ID_KNOWN_KEYS = new Set([0, 2, 3]);
  const { records } = core.decodeContainer(container);
  const rec = core.applyCriticality(records[0], PRE_COMPANION_ID_KNOWN_KEYS);

  assert.equal(rec.aborted, false);
  assert.equal(rec.map.get(2), 'example.com');
  assert.deepEqual(rec.ignoredKeys, [5]); // odd key, unrecognized, ignored not aborted
});

test('encoding the same App Route fields twice (simulating repetition across a multi-code group) produces identical bytes', () => {
  // §4.4's etiquette: repeat verbatim on every code in a multi-code group,
  // so a scanner can decide from any single scanned code. That guarantee
  // depends on §3.4's canonical encoding — two independent encode calls
  // for the same logical fields must agree byte-for-byte, not just
  // "look the same" when inspected.
  const fields = new Map([[2, 'example.com'], [3, 'Open in Example App']]);
  const a = core.encodeRecordBytes({ typeId: wrappers.APP_ROUTE_TYPE, fields });
  const b = core.encodeRecordBytes({ typeId: wrappers.APP_ROUTE_TYPE, fields: new Map(fields) });
  assert.deepEqual(a, b);
});
