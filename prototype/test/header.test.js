'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('../src/core');
const header = require('../src/header');
const { deriveHashId } = require('../src/typeHint');

// ---------------------------------------------------------------------
// Record Type 0: reserved container-level metadata (format namespace +
// optional Hint name), landed after collapsing what had been a separate
// fixed/positional header concept into "just another Record" -- no
// version byte, no non-Record header structure at all. The container is
// now literally magic + a CBOR Sequence of Records, full stop.
// ---------------------------------------------------------------------

test('a Type 0 header record round-trips namespace and hint', () => {
  const container = core.encodeContainer([
    { typeId: header.HEADER_TYPE, fields: new Map([[3, 12271745624591856273n], [5, 'com.example/tagdrop-paper']]) },
    { typeId: 100, fields: new Map([[2, 'SSID'], [4, 'pass'], [6, 2]]) },
  ]);

  const { records } = core.decodeContainer(container);
  const h = header.extractHeader(records);

  assert.equal(h.namespace, 12271745624591856273n);
  assert.equal(h.hint, 'com.example/tagdrop-paper');
});

test('both namespace and hint are independently optional -- a bare Type 0 record is valid', () => {
  const container = core.encodeContainer([
    { typeId: header.HEADER_TYPE, fields: new Map() },
    { typeId: 100, fields: new Map([[2, 'SSID'], [4, 'pass'], [6, 2]]) },
  ]);

  const { records } = core.decodeContainer(container);
  const h = header.extractHeader(records);

  assert.ok(h);
  assert.equal(h.namespace, undefined);
  assert.equal(h.hint, undefined);
});

test('no Type 0 record present at all is a valid, unnamespaced container', () => {
  const container = core.encodeContainer([
    { typeId: 100, fields: new Map([[2, 'SSID'], [4, 'pass'], [6, 2]]) },
  ]);

  const { records } = core.decodeContainer(container);
  assert.equal(header.extractHeader(records), undefined);
});

// ---------------------------------------------------------------------
// The positional requirement: Type 0 only counts as the header if it's
// literally the first Record. Unlike App Route/Media Payload/Fallback
// Hint (all explicitly "not positionally special"), Type 0's entire
// purpose is early identification without scanning the whole Sequence
// -- so a decoder that finds it elsewhere treats the container as
// unnamespaced rather than searching for it or hard-failing.
// ---------------------------------------------------------------------

test('a Type 0 record anywhere but first is not treated as the header', () => {
  const container = core.encodeContainer([
    { typeId: 100, fields: new Map([[2, 'SSID'], [4, 'pass'], [6, 2]]) },
    { typeId: header.HEADER_TYPE, fields: new Map([[3, 42]]) },
  ]);

  const { records } = core.decodeContainer(container);
  assert.equal(header.extractHeader(records), undefined);
  // The misplaced Type 0 record is still just an ordinary, decodable
  // Record in the Sequence -- nothing about this is malformed, it's
  // simply not recognized as the header.
  assert.equal(records[1].typeId, 0);
});

// ---------------------------------------------------------------------
// Type ID 0 is falsy in JS. Any code checking `if (record.typeId)`
// instead of `record.map.has(0)` or `typeId === undefined` would
// silently misroute a Type 0 record -- exactly the class of bug
// FINDINGS.md #14 already caught once for a different reason. Testing
// it explicitly rather than assuming the surrounding code is careful.
// ---------------------------------------------------------------------

test('a Type 0 record is not confused with "missing key 0" (typeId 0 vs null)', () => {
  const container = core.encodeContainer([
    { typeId: header.HEADER_TYPE, fields: new Map([[3, 1]]) },
  ]);

  const { records } = core.decodeContainer(container);
  assert.equal(records[0].aborted, false);
  assert.equal(records[0].typeId, 0);
  assert.notEqual(records[0].typeId, null);
  // The falsy-zero trap: `if (records[0].typeId)` would wrongly treat
  // this as absent. Guard against that class of bug directly.
  assert.equal(records[0].typeId === 0, true);
  assert.equal(Boolean(records[0].typeId), false); // confirms the trap exists
  assert.equal(records[0].map.has(0), true); // the correct way to check presence
});

// ---------------------------------------------------------------------
// An unrecognized odd key on a Type 0 record degrades exactly like any
// other Record Type's unrecognized odd key -- no special-cased logic
// needed for Type 0 beyond what §3.2 already provides everywhere else.
// ---------------------------------------------------------------------

test('an unrecognized odd key on a Type 0 record is ignored, not aborting', () => {
  const container = core.encodeContainer([
    { typeId: header.HEADER_TYPE, fields: new Map([[3, 42], [9, 'future-field']]) },
  ]);

  const { records } = core.decodeContainer(container);
  const checked = core.applyCriticality(records[0], header.HEADER_KNOWN_KEYS);

  assert.equal(checked.aborted, false);
  assert.deepEqual(checked.ignoredKeys, [9]);
  assert.equal(checked.map.get(3), 42);
});

// ---------------------------------------------------------------------
// The container as a whole: no version byte anywhere, magic + Sequence
// only. Confirms the collapse is real, not just true of the header
// module in isolation.
// ---------------------------------------------------------------------

test('the container is exactly magic + CBOR Sequence, no version byte', () => {
  const container = core.encodeContainer([
    { typeId: header.HEADER_TYPE, fields: new Map([[3, 1]]) },
  ]);

  assert.deepEqual(container.subarray(0, 4), core.MAGIC);
  // Byte immediately after magic is the start of a CBOR map (major type
  // 5), not a version integer -- there is nothing in between.
  assert.equal(container[4] >> 5, 5);
});

// ---------------------------------------------------------------------
// Namespace-scoped Type IDs (32768+): resolveLookupKey is what a
// decoder that interprets specific Type IDs must use instead of
// looking typeId up directly, so a namespace-scoped Record never gets
// silently misread as the *global* meaning of the same number -- a
// wrong match, not a clean miss, which is the one sharp edge this
// mechanism has.
//
// The floor is 32768, not 100: 1-32767 (stdlib mechanisms, §4, PLUS
// the reviewed common-vocabulary tier, §9 -- aligned with IANA's own
// CBOR tag registry boundary for its "Specification Required" span)
// stays unconditionally global. That's a deliberate widening of the
// always-global range beyond just stdlib -- the common-vocabulary tier
// is exactly what a decoder is most likely to hardcode against without
// ever reading this section at all, so it gets the same unconditional
// protection stdlib mechanisms already have. There is no separate
// "first-come-first-served" governed tier below this floor (considered
// and dropped, DESIGN.md's Registry governance section): everything
// at or above the floor is either namespace-scoped or expected to be a
// self-certifying private-use-random ID if left unnamespaced -- never
// an ungoverned flat small number.
// ---------------------------------------------------------------------

test('the same Type ID resolves to a different compound key under different namespaces', () => {
  const keyA = header.resolveLookupKey({ namespace: 111n }, 32768);
  const keyB = header.resolveLookupKey({ namespace: 222n }, 32768);

  assert.notDeepEqual(keyA, keyB);
  assert.deepEqual(keyA, { scope: 'namespace', namespace: 111n, typeId: 32768 });
  assert.deepEqual(keyB, { scope: 'namespace', namespace: 222n, typeId: 32768 });
});

test('Type IDs 1-32767 always resolve globally, regardless of any declared namespace', () => {
  // The stdlib range (7 = App Route), the low common-vocabulary range
  // (100 = Wi-Fi Provisioning, §5), and the top of the extended
  // common-vocabulary range (32767, the IANA-aligned ceiling) all get
  // the same unconditional protection -- the whole point of extending
  // the floor beyond just stdlib mechanisms.
  for (const typeId of [7, 100, 999, 32767]) {
    const withNamespace = header.resolveLookupKey({ namespace: 111n }, typeId);
    const withoutNamespace = header.resolveLookupKey(undefined, typeId);

    assert.deepEqual(withNamespace, { scope: 'global', typeId });
    assert.deepEqual(withoutNamespace, { scope: 'global', typeId });
  }
});

test('Type IDs 32768+ resolve globally when no namespace is declared', () => {
  assert.deepEqual(header.resolveLookupKey(undefined, 32768), { scope: 'global', typeId: 32768 });
  assert.deepEqual(
    header.resolveLookupKey({ namespace: undefined }, 32768),
    { scope: 'global', typeId: 32768 },
  );
});

test('a namespace-local ID accidentally chosen below the ceiling -- e.g. by truncating a wide ID instead of freshly picking one -- silently falls back to global, not namespace-scoped', () => {
  // The hazard: resolveLookupKey only checks magnitude, it cannot tell
  // a freshly-chosen small ID from the low bits of a truncated wide
  // one. A truncated value's magnitude is effectively random with
  // respect to the ceiling, so it can easily land below it by chance --
  // demonstrated here with a value that would result from truncating a
  // wide ID to its low 15 bits.
  const TAGDROP_NAMESPACE = 12271745624591856273n;
  const ACCIDENTALLY_TRUNCATED_ID = 12271745624591856273n & 0x7fffn; // < 32768

  const key = header.resolveLookupKey({ namespace: TAGDROP_NAMESPACE }, ACCIDENTALLY_TRUNCATED_ID);

  // Not namespace-scoped, despite a namespace being declared -- the
  // declared namespace is silently ignored for this Record, which is
  // never what an implementer reaching for namespace-scoping wants.
  assert.deepEqual(key, { scope: 'global', typeId: ACCIDENTALLY_TRUNCATED_ID });
  assert.notEqual(key.scope, 'namespace');
});

test('a namespace-aware dispatcher never misapplies a recognized global Type ID to an unrecognized namespace-scoped one', () => {
  // Simulates two independent decoders: one that only knows some
  // adopter's own unnamespaced Type ID (an ungoverned flat number --
  // there is no registry backing it, it's just whatever that adopter
  // happened to pick), one that's namespace-aware but has never heard
  // of this particular namespace. Both must skip cleanly, never fall
  // back to the global interpretation for a namespaced Record that
  // merely shares the same number.
  const GLOBAL_KNOWN_TYPES = new Map([[40000, "Some Adopter's Own Unnamespaced ID"]]);
  const NAMESPACE_KNOWN_TYPES = new Map(); // empty: this namespace is unrecognized

  function dispatch(header_, typeId) {
    const key = header.resolveLookupKey(header_, typeId);
    if (key.scope === 'global') return GLOBAL_KNOWN_TYPES.get(key.typeId);
    const nsTable = NAMESPACE_KNOWN_TYPES.get(key.namespace);
    return nsTable ? nsTable.get(key.typeId) : undefined;
  }

  // Unnamespaced Type 40000 resolves to the real global meaning.
  assert.equal(dispatch(undefined, 40000), "Some Adopter's Own Unnamespaced ID");

  // The SAME Type 40000, inside a declared-but-unrecognized namespace,
  // must NOT resolve to that global meaning -- that would be a wrong
  // match (a namespace-scoped Record misread as something it isn't),
  // not a clean skip.
  assert.equal(dispatch({ namespace: 999999n }, 40000), undefined);
});

test('a common-vocabulary Type ID stays global even inside a declared namespace -- the exact naive-decoder case this floor exists to close off', () => {
  // A decoder that only knows the common-vocabulary registry (never
  // reads §3.5, has no reason to) hardcodes Type 100 = Wi-Fi
  // Provisioning directly. That assumption must hold even inside an
  // arbitrary declared namespace -- unlike a Type ID above the ceiling
  // (tested above), this one is NOT allowed to be silently
  // reinterpreted.
  const GLOBAL_KNOWN_TYPES = new Map([[100, 'Wi-Fi Provisioning']]);
  function naiveDispatch(typeId) {
    return GLOBAL_KNOWN_TYPES.get(typeId); // no namespace check at all -- and none needed
  }

  const key = header.resolveLookupKey({ namespace: 12271745624591856273n }, 100);
  assert.deepEqual(key, { scope: 'global', typeId: 100 });
  assert.equal(naiveDispatch(key.typeId), 'Wi-Fi Provisioning');
});

test("TagDrop's migration case: an existing global 64-bit Type ID keeps working, a new small namespace-scoped one for \"the same\" logical type never collides with it", () => {
  const TAGDROP_NAMESPACE = 12271745624591856273n;
  const OLD_GLOBAL_TYPE_ID = 18446744073709551615n; // pre-existing, unnamespaced
  const NEW_NAMESPACE_LOCAL_ID = 32768; // cheap, chosen after adopting Type 0

  const oldStyleContainer = core.encodeContainer([
    { typeId: OLD_GLOBAL_TYPE_ID, fields: new Map([[2, 'legacy payload']]) },
  ]);
  const newStyleContainer = core.encodeContainer([
    { typeId: header.HEADER_TYPE, fields: new Map([[3, TAGDROP_NAMESPACE]]) },
    { typeId: NEW_NAMESPACE_LOCAL_ID, fields: new Map([[2, 'new payload']]) },
  ]);

  const oldRecords = core.decodeContainer(oldStyleContainer).records;
  assert.equal(
    header.resolveLookupKey(header.extractHeader(oldRecords), oldRecords[0].typeId).scope,
    'global',
  );

  const newRecords = core.decodeContainer(newStyleContainer).records;
  const newHeader = header.extractHeader(newRecords);
  const newKey = header.resolveLookupKey(newHeader, newRecords[1].typeId);
  assert.deepEqual(newKey, {
    scope: 'namespace',
    namespace: TAGDROP_NAMESPACE,
    typeId: NEW_NAMESPACE_LOCAL_ID,
  });

  // The old ID and the new one are simply different keys in different
  // scopes -- nothing forces a choice between them, and nothing about
  // adopting one invalidates the other.
  assert.notEqual(oldRecords[0].typeId, newKey.typeId);

  // The real wire-cost win: verify it, don't just claim it.
  const oldTypeIdBytes = core.encodeRecordBytes({ typeId: OLD_GLOBAL_TYPE_ID, fields: new Map() });
  const newTypeIdBytes = core.encodeRecordBytes({ typeId: NEW_NAMESPACE_LOCAL_ID, fields: new Map() });
  assert.ok(newTypeIdBytes.length < oldTypeIdBytes.length);
});

// ---------------------------------------------------------------------
// §3.5's optional self-certifying strengthening for the namespace field
// itself (`namespace = truncate(hash(name), N)`), reusing Type Hint's
// exact algorithm (§3.1) via typeHint.js -- previously described in
// spec prose only, with nothing in the prototype actually implementing
// or testing it.
// ---------------------------------------------------------------------

test('a hash-derived namespace verifies against its own Hint name', () => {
  const name = 'com.example/tagdrop-paper';
  const namespace = deriveHashId(name, 8); // realistic: a 64-bit-class namespace

  const container = core.encodeContainer([
    { typeId: header.HEADER_TYPE, fields: new Map([[3, namespace], [5, name]]) },
  ]);
  const h = header.extractHeader(core.decodeContainer(container).records);

  assert.equal(header.verifyNamespaceHint(h.namespace, h.hint), 'verified');
});

test('a namespace unrelated to its Hint name degrades to unverified, not an error', () => {
  assert.equal(
    header.verifyNamespaceHint(12271745624591856273n, 'com.example/totally-different-name'),
    'unverified',
  );
});

test('namespace hash-check is not-applicable with no Hint name present', () => {
  assert.equal(header.verifyNamespaceHint(12271745624591856273n, undefined), 'not-applicable');
});
