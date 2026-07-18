# QDEF Examples

Working examples of QDEF patterns, tools, and wire formats.

## Contents

- `registry-walkthrough.md` — Step-by-step guide to choosing a Record
  Type ID and, if you want cheap IDs for more than one Record Type,
  generating and validating a hash-derived Namespace ID
- `registry-submission-template.md` — Fill-in template for submitting a
  Type ID to the QDEF registry (paste into a GitHub Issue or PR)
- `generate-examples.js` — Re-generates the example output shown in the
  walkthrough (run from `docs/examples/`)

## Running

```bash
# From repo root
node docs/examples/generate-examples.js

# Or from prototype/scripts/
cd prototype/scripts
node gen-type-id.js com.example/myapp-paper
node validate-type-id.js com.example/myapp-paper "h'3cf2360e'"
```
