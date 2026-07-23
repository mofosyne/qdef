'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('../src/core');
const wrappers = require('../src/wrappers');

// ---------------------------------------------------------------------
// §4.2's Open/Hint URI (Type 10): a plain sibling standard record type,
// not a wrapper -- a URI to open (a QR code's whole content) or a
// fallback hint alongside other Records, identical bytes either way.
// Keys 3 (language) and 5 (action) exist for lossless
// conversion to and from NDEF's Smart Poster RTD (spec §4.2, DESIGN.md's
// "Relationship to existing standards") -- both odd/optional, so a
// decoder that doesn't recognize either still gets a fully working URI
// and label.
// ---------------------------------------------------------------------

test('a bare URI + label (no language, no action) round-trips -- the pre-existing minimal shape is unaffected', () => {
  const container = core.encodeContainer({ subrecords: [
    {
      typeId: wrappers.OPEN_HINT_URI_TYPE,
      fields: new Map([[0, 'https://example.com/open-this'], [1, 'Open in MyApp']]),
    },
  ] });

  const root = core.decodeContainer(container);
  const records = root.subrecords;
  const rec = core.applyCriticality(records[0], wrappers.OPEN_HINT_URI_KNOWN_KEYS);

  assert.equal(rec.aborted, false);
  assert.equal(rec.map.get(0), 'https://example.com/open-this');
  assert.equal(rec.map.get(1), 'Open in MyApp');
  assert.equal(rec.map.get(3), undefined);
  assert.equal(rec.map.get(5), undefined);
});

test('language (key 3) and action (key 5) round-trip -- the Smart Poster equivalent shape', () => {
  const container = core.encodeContainer({ subrecords: [
    {
      typeId: wrappers.OPEN_HINT_URI_TYPE,
      fields: new Map([
        [0, 'https://example.com/open-this'],
        [1, 'Open in MyApp'],
        [3, 'en'],
        [5, 0], // 0 = perform the action
      ]),
    },
  ] });

  const root = core.decodeContainer(container);
  const records = root.subrecords;
  const rec = core.applyCriticality(records[0], wrappers.OPEN_HINT_URI_KNOWN_KEYS);

  assert.equal(rec.aborted, false);
  assert.equal(rec.map.get(3), 'en');
  assert.equal(rec.map.get(5), 0);
});

test('a decoder unaware of language/action still gets a complete, working URI and label -- the graceful-degrade guarantee both new keys were designed to preserve', () => {
  const container = core.encodeContainer({ subrecords: [
    {
      typeId: wrappers.OPEN_HINT_URI_TYPE,
      fields: new Map([
        [0, 'https://example.com/open-this'],
        [1, 'Open in MyApp'],
        [3, 'en'],
        [5, 2], // 2 = open for editing
      ]),
    },
  ] });

  const root = core.decodeContainer(container);
  const records = root.subrecords;
  // An older decoder that only ever knew about keys 0/1 -- both odd
  // (optional) keys are silently ignored, never aborting the Record.
  const rec = core.applyCriticality(records[0], new Set([0, 1]));

  assert.equal(rec.aborted, false);
  assert.deepEqual(rec.ignoredKeys.sort(), [3, 5]);
  assert.equal(rec.map.get(0), 'https://example.com/open-this');
  assert.equal(rec.map.get(1), 'Open in MyApp');
});

test('multiple languages/URIs need no new mechanism -- repeated Open/Hint URI siblings, one per variant, reproduce Smart Poster multi-title and Multiple URI RTD behavior', () => {
  const container = core.encodeContainer({ subrecords: [
    {
      typeId: wrappers.OPEN_HINT_URI_TYPE,
      fields: new Map([[0, 'https://example.com/open-this'], [1, 'Open in MyApp'], [3, 'en']]),
    },
    {
      typeId: wrappers.OPEN_HINT_URI_TYPE,
      fields: new Map([[0, 'https://example.com/open-this'], [1, 'Ouvrir dans MyApp'], [3, 'fr']]),
    },
  ] });

  const root = core.decodeContainer(container);
  const records = root.subrecords;
  const hints = records
    .filter((r) => r.typeId === wrappers.OPEN_HINT_URI_TYPE)
    .map((r) => core.applyCriticality(r, wrappers.OPEN_HINT_URI_KNOWN_KEYS));

  assert.equal(hints.length, 2);
  const byLang = new Map(hints.map((h) => [h.map.get(3), h.map.get(1)]));
  assert.equal(byLang.get('en'), 'Open in MyApp');
  assert.equal(byLang.get('fr'), 'Ouvrir dans MyApp');
});
