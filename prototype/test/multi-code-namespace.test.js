'use strict';
// TagDrop asked directly whether a namespace declaration needs to repeat
// on every physical code of a multi-code Split group, or can appear
// once. Answered by tracing the actual mechanics: each code is parsed as
// its own independent container with no cross-code state (DESIGN.md's
// "Type ID inheritance"/"Reference tags" entries already established this
// for a different reason), and `parity_scheme` recovers missing *fragment
// bytes*, never a missing *discriminator* -- so a namespace declared on
// only one code is a single point of failure `resolveStack` cannot recover
// from, unlike the Split-protected content itself.
//
// `resolveStack` (wrappers.js) reads each code's discriminator, requires
// every code that declares a namespace to agree, and applies the agreed
// namespace to whatever Record the stack ultimately resolves to --
// including one only reachable after full Split reassembly.

const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('../src/core');
const wrappers = require('../src/wrappers');
const header = require('../src/header');

const NAMESPACE = Buffer.from('a9d6e1f30b7c4482', 'hex');
const NAMESPACE_SCOPED_TYPE = 32769; // odd uint -- requires a declared namespace
const KNOWN_KEYS = new Map([
  [wrappers.SPLIT_TYPE, wrappers.SPLIT_KNOWN_KEYS],
  [NAMESPACE_SCOPED_TYPE, new Set([0])],
]);

function buildCodes({ repeatNamespaceOnEveryCode }) {
  const innerBytes = core.encodeRecordBytes({
    typeIds: [NAMESPACE_SCOPED_TYPE],
    fields: new Map([[0, 'namespace-scoped payload']]),
  });
  const fragmentRecords = wrappers.splitEncode(innerBytes, {
    count: 3,
    parityScheme: wrappers.PARITY_SCHEME_XOR,
  });

  return fragmentRecords.map((fragRec, i) => {
    const discriminator = repeatNamespaceOnEveryCode || i === 0 ? NAMESPACE : undefined;
    return core.encodeContainer([fragRec], discriminator);
  });
}

test('a namespace repeated on every code resolves correctly after full Split reassembly', () => {
  const codes = buildCodes({ repeatNamespaceOnEveryCode: true });
  const terminal = wrappers.resolveStack(codes, {}, KNOWN_KEYS);

  assert.equal(terminal.typeId, NAMESPACE_SCOPED_TYPE);
  assert.ok(terminal.namespace.equals(NAMESPACE));
  assert.equal(terminal.map.get(0), 'namespace-scoped payload');
});

test('the repeated namespace survives losing any one code, same as the data it describes', () => {
  const codes = buildCodes({ repeatNamespaceOnEveryCode: true });
  // Drop one of the 4 codes (3 data + 1 parity) -- XOR parity recovers the
  // missing fragment bytes, and since the namespace was declared on every
  // code, its copy survives on whichever 3 codes remain.
  const droppedOneCode = [codes[0], codes[1], codes[3]];

  const terminal = wrappers.resolveStack(droppedOneCode, {}, KNOWN_KEYS);
  assert.ok(terminal.namespace.equals(NAMESPACE));
  assert.equal(terminal.map.get(0), 'namespace-scoped payload');
});

test('FINDING: a namespace declared on only one code is a single point of failure the data itself is NOT -- losing that one code loses the namespace even though parity fully recovers the content', () => {
  const codes = buildCodes({ repeatNamespaceOnEveryCode: false }); // namespace only on codes[0]
  // Drop exactly the code carrying the only declared namespace. Parity
  // still recovers the missing fragment's bytes fine -- the content is
  // intact.
  const droppedTheNamespaceCode = [codes[1], codes[2], codes[3]];

  assert.throws(
    () => wrappers.resolveStack(droppedTheNamespaceCode, {}, KNOWN_KEYS),
    /odd uint Type ID .* requires a declared namespace/,
  );

  // Confirming it's really the namespace that's missing, not the data:
  // keeping the namespace-carrying code alongside the same dropped
  // fragment resolves fine, since the namespace (and enough fragments)
  // are both present.
  const keepingTheNamespaceCode = [codes[0], codes[1], codes[3]];
  const terminal = wrappers.resolveStack(keepingTheNamespaceCode, {}, KNOWN_KEYS);
  assert.ok(terminal.namespace.equals(NAMESPACE));
});

test('codes disagreeing on the declared namespace is rejected, not silently resolved one way or the other', () => {
  const innerBytes = core.encodeRecordBytes({
    typeIds: [NAMESPACE_SCOPED_TYPE],
    fields: new Map([[0, 'payload']]),
  });
  const fragmentRecords = wrappers.splitEncode(innerBytes, { count: 2 });
  const codes = [
    core.encodeContainer([fragmentRecords[0]], Buffer.from('11111111', 'hex')),
    core.encodeContainer([fragmentRecords[1]], Buffer.from('22222222', 'hex')),
  ];

  assert.throws(
    () => wrappers.resolveStack(codes, {}, KNOWN_KEYS),
    /inconsistent namespace/,
  );
});

test('a namespace-scoped Type ID with no namespace declared anywhere in the group still aborts, same as the single-code case', () => {
  const innerBytes = core.encodeRecordBytes({
    typeIds: [NAMESPACE_SCOPED_TYPE],
    fields: new Map([[0, 'payload']]),
  });
  const fragmentRecords = wrappers.splitEncode(innerBytes, { count: 2 });
  const codes = fragmentRecords.map((f) => core.encodeContainer([f]));

  assert.throws(
    () => wrappers.resolveStack(codes, {}, KNOWN_KEYS),
    /odd uint Type ID .* requires a declared namespace/,
  );
});

// ---------------------------------------------------------------------
// A real bug found while checking a namespace-matching question: the
// group-consistency check above used to compare namespaces with a bare
// `!==`. That's correct for a plain uint but silently wrong for a
// Decentralized (byte string) namespace -- two independently-decoded
// Buffers holding identical bytes are never `===`, so `!==` always
// reported them as different, and every multi-code group repeating a
// byte-string namespace across its codes would incorrectly throw
// "inconsistent namespaces." No existing test caught this because every
// prior multi-code-namespace test above only ever used a bigint
// namespace. Fixed via header.namespaceEquals (content comparison for
// Buffers, BigInt-normalized comparison for number/bigint so the same
// numeric value never spuriously mismatches by JS type either).
// ---------------------------------------------------------------------

test('a decentralized (byte string) namespace repeated identically across every code resolves correctly -- regression for the !== reference-equality bug', () => {
  const decentralizedNamespace = Buffer.from('a9d6e1f30b7c4482', 'hex');
  const innerBytes = core.encodeRecordBytes({
    typeIds: [NAMESPACE_SCOPED_TYPE],
    fields: new Map([[0, 'namespace-scoped payload']]),
  });
  const fragmentRecords = wrappers.splitEncode(innerBytes, { count: 2 });
  const codes = fragmentRecords.map((f) =>
    core.encodeContainer(
      [f],
      // Buffer.from() on each call produces a fresh instance -- exactly
      // the "same content, different object identity" shape the old
      // `!==` check got wrong.
      Buffer.from('a9d6e1f30b7c4482', 'hex'),
    ),
  );

  const terminal = wrappers.resolveStack(codes, {}, KNOWN_KEYS);

  assert.equal(terminal.typeId, NAMESPACE_SCOPED_TYPE);
  assert.ok(terminal.namespace.equals(decentralizedNamespace));
});

test('codes disagreeing on a decentralized namespace (different bytes, same length) are still correctly rejected', () => {
  const innerBytes = core.encodeRecordBytes({
    typeIds: [NAMESPACE_SCOPED_TYPE],
    fields: new Map([[0, 'payload']]),
  });
  const fragmentRecords = wrappers.splitEncode(innerBytes, { count: 2 });
  const codes = [
    core.encodeContainer([fragmentRecords[0]], Buffer.from('a9d6e1f30b7c4482', 'hex')),
    core.encodeContainer([fragmentRecords[1]], Buffer.from('ffffffffffffffff', 'hex')),
  ];

  assert.throws(
    () => wrappers.resolveStack(codes, {}, KNOWN_KEYS),
    /inconsistent namespace/,
  );
});

test('namespaceEquals stays defensively correct for number/bigint even though a real container can never carry one as a namespace anymore', () => {
  // There is no Allocated (uint) namespace tier (docs/FINDINGS.md) -- a
  // uint discriminator now always degrades to "no namespace"
  // (header.test.js covers that), so this scenario can't arise through
  // any real encodeContainer/resolveStack path. Checked directly against
  // namespaceEquals itself only as defensive-correctness insurance for
  // the map form's namespace key (`1`), which is never type-checked at
  // the structural-decode layer -- a non-conformant encoder could still
  // put a uint there, and this makes sure that degrades to a safe
  // comparison instead of a silent bug.
  assert.equal(header.namespaceEquals(500, 500n), true);
  assert.equal(header.namespaceEquals(500n, 500), true);
});
