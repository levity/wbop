# AGENTS.md

Project-specific maintenance notes for `wbop`.

## Release/versioning checklist

When bumping the package version, keep all user-visible version strings in sync:

- `package.json` → `version`
- `package-lock.json` → root package version
- `wbop.js` → `const VERSION = "..."`
- `README.txt` → trailing footer line like `v0.1.4`

Do not publish if these are out of sync.

## Testing checklist

Before committing or publishing:

- run `npm run test`
- make sure `node --check wbop.js` passes (already included in `npm run test`)
- if packaging changes, verify `npm publish --dry-run`

## Packaging checklist

- If new runtime files are added, ensure they are included in `package.json` `files`
- Keep the npm `bin` entry warning-free (`"wbop": "wbop.js"`)
- Prefer fast unit tests for pure logic; avoid adding slow browser/e2e tests unless needed

## CLI/docs consistency

When CLI behavior changes, update both:

- `wbop.js`
- `README.txt`

This includes:

- usage lines
- environment/configuration docs
- examples
- behavior notes (window sizing, viewport semantics, etc.)
