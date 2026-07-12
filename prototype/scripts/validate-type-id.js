#!/usr/bin/env node
'use strict';
// Validate a Record Type ID or Namespace ID against its name,
// checking the hash derivation (spec §3.1), name quality, and tier
// constraints. Exits 0 if valid, 1 if any check fails.
//
// Usage:
//   node scripts/validate-type-id.js <name> <id>
//   node scripts/validate-type-id.js --namespace <name> <namespace-id>
//   node scripts/validate-type-id.js --reverse <id> <name>
//
// Modes:
//   (default)    Verify that <id> was derived from <name>
//   --namespace  Verify that <namespace-id> was derived from <name>
//   --reverse    Argument order is <id> <name> instead of <name> <id>
//
// The tool checks:
//   1. Hash derivation matches (SHA-256 truncated to the right width)
//   2. Name is reverse-domain qualified (warning if not)
//   3. Name doesn't use collision-prone bare generic words (warning)
//   4. ID is in the correct tier (>= 0x10000 for private-use random)
//   5. Width consistency: 4-byte IDs fit in uint32, 8-byte in uint64

const crypto = require('crypto');
const {
  PRIVATE_USE_RANDOM_FLOOR,
  HASH_ID_NARROW_WIDTH,
  HASH_ID_WIDE_WIDTH,
  widthForId,
  verifyTypeHint,
} = require('../src/typeHint');

function deriveHashId(name, byteWidth) {
  const digest = crypto.createHash('sha256').update(name, 'utf8').digest();
  if (byteWidth === HASH_ID_WIDE_WIDTH) {
    return digest.readBigUInt64BE(0);
  }
  return digest.readUIntBE(0, byteWidth);
}

// Bare generic words that two unrelated projects are likely to pick for
// similar concepts — the "config" / "settings" / "data" class of names
// that destroy hash-derivation's collision-safety.
const COLLISION_PRONE = new Set([
  'config', 'settings', 'data', 'meta', 'info', 'content', 'payload',
  'message', 'record', 'entry', 'item', 'blob', 'stream', 'event',
  'update', 'sync', 'cache', 'store', 'queue', 'task', 'job', 'job',
  'auth', 'token', 'session', 'user', 'admin', 'system', 'core',
  'base', 'common', 'shared', 'util', 'helper', 'service', 'handler',
]);

function parseArgs(argv) {
  const args = argv.slice(2);
  const result = { mode: 'derive', name: null, id: null };

  if (args.includes('--help') || args.includes('-h')) {
    result.mode = 'help';
    return result;
  }

  if (args.includes('--namespace')) {
    result.mode = 'namespace';
    args.splice(args.indexOf('--namespace'), 1);
  }

  if (args.includes('--reverse')) {
    result.mode = 'reverse';
    args.splice(args.indexOf('--reverse'), 1);
  }

  if (args.length !== 2) {
    result.mode = 'error';
    return result;
  }

  if (result.mode === 'reverse') {
    result.id = args[0];
    result.name = args[1];
  } else {
    result.name = args[0];
    result.id = args[1];
  }

  return result;
}

function parseTypeId(str) {
  str = str.trim();
  if (str.startsWith('0x') || str.startsWith('0X')) {
    return BigInt(str);
  }
  return BigInt(str);
}

function validate() {
  const { mode, name, id: idStr } = parseArgs(process.argv);

  if (mode === 'help') {
    console.error(`Usage: node scripts/validate-type-id.js [--namespace] [--reverse] <name> <id>

Validate a Record Type ID or Namespace ID against its name.

Arguments:
  name        Reverse-domain qualified name (e.g. "com.example.myapp/route")
  id          The Record Type ID or Namespace ID to validate (decimal or 0x hex)

Flags:
  --namespace Validate as a Namespace ID (same algorithm, different tier)
  --reverse   Argument order is <id> <name> instead of <name> <id>

Checks performed:
  1. Hash derivation matches (SHA-256 truncated to 4 or 8 bytes)
  2. Name is reverse-domain qualified (warning if not)
  3. Name avoids collision-prone bare generic words (warning)
  4. ID is in the correct tier (>= 0x10000 for private-use)
  5. Width consistency: 4-byte fits in uint32, 8-byte in uint64

Examples:
  node scripts/validate-type-id.js com.example.myapp/route 0x34E1E4AF986C74E2
  node scripts/validate-type-id.js --namespace com.example/myapp-paper 2430554185501560802`);
    process.exit(0);
  }

  if (mode === 'error') {
    console.error('Error: expected <name> <id> (or use --help).');
    process.exit(1);
  }

  let exitCode = 0;
  const errors = [];
  const warnings = [];

  // Parse the ID
  let typeId;
  try {
    typeId = parseTypeId(idStr);
  } catch (e) {
    console.error(`Error: "${idStr}" is not a valid integer.`);
    process.exit(1);
  }

  if (typeId < 0n) {
    errors.push(`ID must be non-negative, got ${typeId}.`);
  }

  const width = widthForId(typeId);
  const isNamespace = mode === 'namespace';

  // 1. Hash derivation check
  const expected = deriveHashId(name, width);
  const matches = BigInt(expected) === typeId;

  console.log(`Validating: ${isNamespace ? 'Namespace ID' : 'Record Type ID'} for "${name}"`);
  console.log(`  Candidate ID:  ${typeId} (0x${typeId.toString(16).toUpperCase()})`);
  console.log(`  Width:         ${width} bytes (${width === 4 ? '32-bit' : '64-bit'} class)`);
  console.log(`  Expected hash: ${BigInt(expected)} (0x${BigInt(expected).toString(16).toUpperCase()})`);
  console.log('');

  if (matches) {
    console.log('  ✓ Hash derivation matches.');
  } else {
    errors.push(`Hash derivation does not match: expected ${BigInt(expected)}, got ${typeId}.`);
    console.error('  ✗ Hash derivation does NOT match.');
  }

  // 2. Name quality: reverse-domain qualified?
  if (!name.includes('.') && !name.includes('/')) {
    warnings.push(`"${name}" does not look reverse-domain qualified.`);
    console.warn(`  ⚠ Name is not reverse-domain qualified (spec §3.1 recommends qualifying).`);
  } else {
    console.log('  ✓ Name is reverse-domain qualified.');
  }

  // 3. Name quality: bare generic word?
  const lastSegment = name.split(/[./]/).pop().toLowerCase();
  if (COLLISION_PRONE.has(lastSegment)) {
    warnings.push(`"${name}" ends with a collision-prone generic word ("${lastSegment}").`);
    console.warn(`  ⚠ Name ends with "${lastSegment}" — a word two unrelated projects are likely`);
    console.warn(`    to pick independently. Consider a more specific name for better`);
    console.warn(`    collision-safety. See spec §3.1.`);
  } else {
    console.log('  ✓ Name avoids known collision-prone patterns.');
  }

  // 4. Tier check
  if (!isNamespace) {
    if (typeId < BigInt(PRIVATE_USE_RANDOM_FLOOR)) {
      if (typeId < 1000n) {
        console.log('  ℹ ID is in the stdlib range (1-99) — hash-derivation is not applicable.');
      } else if (typeId < 32768n) {
        console.log('  ℹ ID is in the common-vocabulary range (100-32767).');
      }
    } else {
      console.log(`  ✓ ID is in the private-use-random tier (>= 0x${PRIVATE_USE_RANDOM_FLOOR.toString(16).toUpperCase()}).`);
    }
  } else {
    console.log(`  ℹ Namespace IDs have no tier constraint (any uint is valid).`);
  }

  // 5. Width consistency
  if (width === 4 && typeId >= (1n << 32n)) {
    errors.push(`Width mismatch: 4-byte derivation cannot produce value ${typeId} (>= 2^32).`);
    console.error('  ✗ Width inconsistency: 4-byte truncation cannot represent this value.');
  } else if (width === 8 && typeId < (1n << 32n)) {
    warnings.push(`8-byte derivation produced a value that fits in 32 bits. Consider using 4-byte width instead.`);
    console.warn('  ⚠ 8-byte derivation produced a value that fits in 32 bits.');
    console.warn('    Consider using 4-byte width (smaller on the wire).');
  } else {
    console.log(`  ✓ Width is consistent with the ID's magnitude.`);
  }

  // Summary
  console.log('');
  if (warnings.length > 0) {
    console.log(`${warnings.length} warning(s), ${errors.length} error(s).`);
  }
  if (errors.length > 0) {
    console.error(`${errors.length} error(s) — validation FAILED.`);
    process.exit(1);
  } else {
    console.log('Validation passed.');
    process.exit(0);
  }
}

validate();
