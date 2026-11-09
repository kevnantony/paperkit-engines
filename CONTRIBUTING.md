# Contributing

Thanks for helping. These engines are extracted from the PaperKit app, so changes should stay small and environment-agnostic.

- **Setup:** Node 20+ for development (packages support Node 18+). `npm install`, then `npm run verify` (typecheck, lint, test, build, smoke).
- **Rules:** no DOM globals at import time, no network access except through an injected `fetch`, and no GPL/AGPL dependencies (the repo is MIT).
- **Tests:** every behaviour change needs a Vitest test in `packages/<name>/test`. Fixtures live in `packages/<name>/test/fixtures`.
- **README examples** must run: `npm run build && npm run examples`.
- **Pull requests:** one topic per PR, with a short description of the problem and the fix. Bug reports with a minimal `.bib`, `.tex` or PDF that reproduces the issue are very welcome.
