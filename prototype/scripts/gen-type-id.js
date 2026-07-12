#!/usr/bin/env node
'use strict';
// Generate a hash-derived private-use-random Record Type ID (or Namespace ID)
// from a qualified name, per spec §3.1's pinned algorithm:
//
//   digest = SHA-256(UTF-8(name))
//   N      = 4 if ID fits in 32 bits, else 8
//   ID     = big-endian uint from digest[0..N]
//
// Usage:
//   node scripts/gen-type-id.js <name>
//   node scripts/gen-type-id.js --namespace <name>
//   node scripts/gen-type-id.js --width 4|8 <name>
//
// Names SHOULD be reverse-domain qualified (e.g. "com.example.myapp/route")
// for collision-safety — see spec §3.1 and DESIGN.md's "Pinning the algorithm"
// section. Unqualified names are accepted with a warning.
//
// Without --namespace: derives a Record Type ID (private-use-random tier, >= 0x10000).
// With --namespace:    derives a Namespace ID (same algorithm, different
//   intended use — the value goes into Type 0's key 3, not a Record's key 0).
//
// --width lets you pick 4-byte (32-bit class) or 8-byte (64-bit class) output.
// Without it, both are shown and you pick.

const crypto = require('crypto');
const { PRIVATE_USE_RANDOM_FLOOR, HASH_ID_NARROW_WIDTH, HASH_ID_WIDE_WIDTH } = require('../src/typeHint');

function deriveHashId(name, byteWidth) {
  const digest = crypto.createHash('sha256').update(name, 'utf8').digest();
  if (byteWidth === HASH_ID_WIDE_WIDTH) {
    return digest.readBigUInt64BE(0);
  }
  return digest.readUIntBE(0, byteWidth);
}

function usage() {
  console.error(`Usage: node scripts/gen-type-id.js [--namespace] [--width 4|8] <name>

Derive a hash-based private-use Record Type ID or Namespace ID from a name.

Arguments:
  name            Reverse-domain qualified name (e.g. "com.example.myapp/route")
  --namespace     Derive a Namespace ID instead of a Record Type ID
  --width 4|8     Output width: 4 = 32-bit class, 8 = 64-bit class.
                  Without this flag, both are shown.

Algorithm (spec §3.1):
  SHA-256(UTF-8(name)), truncated to 4 or 8 bytes big-endian uint.
  Width is 4 bytes if the result fits in 32 bits, 8 otherwise.

Examples:
  node scripts/gen-type-id.js com.example.myapp/route
  node scripts/gen-type-id.js --namespace com.example/myapp-paper
  node scripts/gen-type-id.js --width 8 com.example.myapp/route`);
}

const args = process.argv.slice(2);
let asNamespace = false;
let forcedWidth = null;

// Parse flags
const flagIdx = {
  namespace: args.indexOf('--namespace'),
  width: args.indexOf('--width'),
};

if (flagIdx.namespace !== -1) {
  asNamespace = true;
  args.splice(flagIdx.namespace, 1);
}

if (flagIdx.width !== -1) {
  const wIdx = args.indexOf('--width');
  forcedWidth = parseInt(args[wIdx + 1], 10);
  if (forcedWidth !== 4 && forcedWidth !== 8) {
    console.error('Error: --width must be 4 or 8.');
    process.exit(1);
  }
  args.splice(wIdx, 2);
}

if (args.includes('--help') || args.includes('-h') || args.length !== 1) {
  usage();
  process.exit(args.includes('--help') || args.includes('-h') ? 0 : 1);
}

const name = args[0];

if (!name || name.length === 0) {
  console.error('Error: name must not be empty.');
  process.exit(1);
}

// Warn on unqualified names (no dot or slash — likely not reverse-domain).
if (!name.includes('.') && !name.includes('/')) {
  console.error(`Warning: "${name}" does not look reverse-domain qualified.`);
  console.error('  Names SHOULD be qualified (e.g. "com.example.myapp/route")');
  console.error('  for collision-safety. See spec §3.1.');
  console.error('');
}

function formatResult(value, width) {
  const asHex = '0x' + BigInt(value).toString(16).toUpperCase();
  const below = BigInt(value) < BigInt(PRIVATE_USE_RANDOM_FLOOR);
  return { value, width, asHex, below };
}

if (forcedWidth) {
  const raw = deriveHashId(name, forcedWidth);
  const result = formatResult(raw, forcedWidth);
  console.log(`Name:        ${name}`);
  console.log(`Derivation:  SHA-256(UTF-8("${name}")) → first ${forcedWidth} bytes`);
  console.log(`Value (dec): ${result.value}`);
  console.log(`Value (hex): ${result.asHex}`);
  if (result.below && !asNamespace) {
    console.error(`\nWarning: value is below the private-use-random floor`);
    console.error(`  (0x${PRIVATE_USE_RANDOM_FLOOR.toString(16).toUpperCase()}).`);
    console.error('  Cannot serve as a private-use Record Type ID per spec §3.1.');
  }
} else {
  const narrow = formatResult(deriveHashId(name, HASH_ID_NARROW_WIDTH), HASH_ID_NARROW_WIDTH);
  const wide = formatResult(deriveHashId(name, HASH_ID_WIDE_WIDTH), HASH_ID_WIDE_WIDTH);
  console.log(`Name:        ${name}`);
  console.log(`Derivation:  SHA-256(UTF-8("${name}"))\n`);
  console.log(`  4-byte (32-bit class):`);
  console.log(`    Value (dec): ${narrow.value}`);
  console.log(`    Value (hex): ${narrow.asHex}`);
  if (narrow.below && !asNamespace) {
    console.error(`    ⚠ below private-use-random floor (0x${PRIVATE_USE_RANDOM_FLOOR.toString(16).toUpperCase()})`);
  }
  console.log(`\n  8-byte (64-bit class):`);
  console.log(`    Value (dec): ${wide.value}`);
  console.log(`    Value (hex): ${wide.asHex}`);
  if (wide.below && !asNamespace) {
    console.error(`    ⚠ below private-use-random floor (0x${PRIVATE_USE_RANDOM_FLOOR.toString(16).toUpperCase()})`);
  }
}

if (asNamespace) {
  console.log('\nUsage in wire format: first Record in Sequence is Type 0, with');
  console.log('  key 3 (Namespace ID) = <value above>');
  console.log(`  key 5 (name)         = "${name}"`);
}
