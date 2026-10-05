# CSV Diff

Compares two CSV exports by record identity, in the browser. Files are parsed and
compared in a Web Worker and never leave the machine.

Plan and scope: [`docs/build-plan.md`](docs/build-plan.md).

## Commands

```
npm run dev        # vite dev server
npm run build      # tsc -b && vite build
npm run lint       # oxlint
npm test           # vitest run
npm run typecheck  # tsc -b
```

## Layout

- `src/engine/` — pure TypeScript: parsing, key classification, value rules, diff. No React or DOM.
- `src/worker/` — the worker entry, its typed message protocol, and the client the UI calls.
- `src/ui/` — React components.
- `fixtures/<case>/{old,new}.csv` — one fixture pair per edge case, used by the engine tests.
