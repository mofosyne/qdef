#!/usr/bin/env node
'use strict';
// Validate a Record Type ID or Namespace ID against its name,
// checking the hash derivation (spec §3.1), name quality, and constraints.
// Exits 0 if valid, 1 if any check fails.
//
// Usage:
//   node scripts/validate-type-id.js <name> <hex-id>
//   node scripts/validate-type-id.js --namespace <name> <hex-id>
//   node scripts/validate-type-id.js --reverse <hex-id> <name>
//
// The ID should be provided as a hex string (e.g. "34E1E4AF986C74E2").
//
// Checks performed:
//   1. Hash derivation matches (SHA-256 truncated to the given byte length)
//   2. Name is reverse-domain qualified (warning if not)
//   3. Name doesn't use collision-prone bare generic words (warning)
//   4. ID meets minimum byte length (>= 2 bytes)

const crypto = require('crypto');
const { MIN_BYTE_LENGTH, verifyTypeHint } = require('../src/typeHint');

function deriveHashId(name, byteWidth) {
  if (byteWidth < MIN_BYTE_LENGTH) {
    throw new Error(`byteWidth must be >= ${MIN_BYTE_LENGTH}, got ${byteWidth}`);
  }
  const digest = crypto.createHash('sha256').update(name, 'utf8').digest();
  return Buffer.from(digest.subarray(0, byteWidth));
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

function parseHexId(str) {
  str = str.trim();
  // Accept h'...' CBOR byte string notation or raw hex
  if (str.startsWith("h'") && str.endsWith("'")) {
    str = str.slice(2, -1);
  }
  if (str.startsWith('0x') || str.startsWith('0X')) {
    str = str.slice(2);
  }
  // Must be even length
  if (str.length % 2 !== 0) {
    throw new Error(`Hex string must have even length, got ${str.length}`);
  }
  return Buffer.from(str, 'hex');
}

function validate() {
  const { mode, name, id: idStr } = parseArgs(process.argv);

  if (mode === 'help') {
    console.error(`Usage: node scripts/validate-type-id.js [--namespace] [--reverse] <name> <hex-id>

Validate a decentralized Record Type ID or Namespace ID against its name.

Arguments:
  name        Reverse-domain qualified name (e.g. "com.example.myapp/route")
  hex-id      The ID as a hex string (e.g. "34E1E4AF986C74E2" or h'34E1E4AF986C74E2')

Flags:
  --namespace Validate as a Namespace ID (same algorithm, different use)
  --reverse   Argument order is <hex-id> <name> instead of <name> <hex-id>

Checks performed:
  1. Hash derivation matches (SHA-256 truncated to byte length)
  2. Name is reverse-domain qualified (warning if not)
  3. Name avoids collision-prone bare generic words (warning)
  4. ID meets minimum byte length (>= 2 bytes)

Examples:
  node scripts/validate-type-id.js com.example.myapp/route 34E1E4AF986C74E2
  node scripts/validate-type-id.js --namespace com.example/myapp-paper h'A7F90B3C'`);
    process.exit(0);
  }

  if (mode === 'error') {
    console.error('Error: expected <name> <hex-id> (or use --help).');
    process.exit(1);
  }

  const errors = [];
  const warnings = [];

  // Parse the ID as a byte string
  let typeId;
  try {
    typeId = parseHexId(idStr);
  } catch (e) {
    console.error(`Error: "${idStr}" is not a valid hex string: ${e.message}`);
    process.exit(1);
  }

  if (typeId.length < MIN_BYTE_LENGTH) {
    errors.push(`ID must be at least ${MIN_BYTE_LENGTH} bytes, got ${typeId.length}.`);
  }

  const isNamespace = mode === 'namespace';

  // 1. Hash derivation check
  const expected = deriveHashId(name, typeId.length);
  const matches = expected.equals(typeId);

  console.log(`Validating: ${isNamespace ? 'Namespace ID' : 'Record Type ID'} for "${name}"`);
  console.log(`  Candidate ID:  h'${typeId.toString('hex')}' (${typeId.length} bytes)`);
  console.log(`  Expected hash: h'${expected.toString('hex')}' (${expected.length} bytes)`);
  console.log('');

  if (matches) {
    console.log('  ✓ Hash derivation matches.');
  } else {
    errors.push(`Hash derivation does not match.`);
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

  // 4. Minimum byte length check
  if (typeId.length >= 4) {
    console.log(`  ✓ Byte length ${typeId.length} is adequate for global use.`);
  } else if (typeId.length >= 2) {
    console.log(`  ℹ Byte length ${typeId.length} is suitable for namespace-scoped use.`);
    if (!isNamespace) {
      warnings.push(`2-byte ID is recommended for namespace-scoped use only.`);
      console.warn(`  ⚠ 2-byte IDs are recommended for namespace-scoped use only.`);
      console.warn(`    Use 4+ bytes for global (unnamespaced) use.`);
    }
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
