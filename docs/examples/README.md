# QDEF Examples

Working examples of QDEF patterns, tools, and wire formats.

## Contents

- `registry-walkthrough.md` — Step-by-step guide to generating, validating,
  and using a hash-derived byte string Record Type ID
- `generate-examples.js` — Re-generates the example output shown in the
  walkthrough (run from `docs/examples/`)

## Running

```bash
# From repo root
node docs/examples/generate-examples.js

# Or from prototype/scripts/
cd prototype/scripts
node gen-type-id.js com.example.myapp/route
node validate-type-id.js com.example.myapp/route "h'216e6add'"
```
