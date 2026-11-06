# Contributing

Openfield is a clean-room, MIT-licensed, local-first workspace. Contributions
are welcome as long as they keep those three words true.

Read [`AGENTS.md`](AGENTS.md) for the rules in full; the short version is below.

## The rules that are not negotiable

1. **No code from another product.** Analysis of behaviour is fine; the code is
   ours, written in our own words.
2. **No assets from another product.** No logos, icons, illustrations, fonts,
   sounds or distinctive long strings. Short functional labels are words.
3. **No vendor names or marks** in the product name, installer, package id, URL
   or bundle id.
4. **No network at runtime.** No accounts, no sync service, no telemetry, and no
   contacting another vendor's servers, ever.
5. **Dependencies** stay MIT, BSD, ISC, Apache-2.0 or MPL-2.0, and every one is
   recorded in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

If an instruction would force a breach, stop and say so rather than finding a
way around it.

## Getting set up

```bash
npm install --ignore-scripts     # no native build step
node tools/xtask/ci.mjs          # layering, attribution, typecheck, unit, parity
```

The CLI runs from TypeScript source — there is no build step, so what the tests
exercise is what the CLI runs.

Add the desktop app's own gates when you touch UI:

```bash
npm run build --workspace apps/desktop
node tools/xtask/ci.mjs package e2e
```

## Layer rules

`packages/geom` < `model`/`text`/`db-engine` < `storage`/`formats` < `commands`
< `automation` < `ui-kit`/`editor-ui` < `app-ui` < `apps`.

A package may import only from lower layers, and a relative import may not
escape its own package directory. `tools/xtask/layering.mjs` enforces both and
runs in CI; do not work around it.

## One door into the model

The command registry is the only way anything mutates a document. UI code calls
`run('<command.id>', args)`; it never touches the model directly. That is what
keeps the desktop app, the CLI and the tests on the same path.

## What a change has to come with

- A test for new logic (a branch, a loop, a parser, money, security) — or a
  sentence saying why none is needed.
- Honest language in the PR: say *implemented* when code exists, *working* when
  you ran it, *tested* when a test exists and passed, *verified* only against
  observed behaviour. Do not write "all tests pass" without the summary line.
- Updated documentation when behaviour, commands or the ledger change.

## Reporting a bug

Use the issue form, and reproduce it on a fresh workspace. Never attach real
notes, real account data or a token.
