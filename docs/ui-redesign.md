# UI redesign

The current interface refines the earlier design from `csv-diff-tool-design.zip` into a focused, three-step tool. It does not change the engine, worker, profile formats, export formats, or GitHub Pages workflow. Historical browser results below describe their recorded snapshots.

## Visual system

- Cool off-white workspace (`#f4f4f1`), white panels, near-black ink (`#17171a`) and muted text (`#5e5e66`). Primary actions and the current step use a deep violet (`#5235d6`, soft `#eeeafd`). The original purple lightning favicon is unchanged; the header shows it on a dark ink tile, resolved through Vite's base URL for GitHub Pages.
- IBM Plex Sans for interface text; IBM Plex Mono for amounts, keys and data values. Fonts are self-hosted through Fontsource package imports.
- Lucide React icons, bundled with the app. Primary controls retain visible text labels. All disclosures use a thin CSS chevron instead of native markers or decorative leading icons.
- Teal for money in, confirmations and new values; rose for removals/old values; amber for changed records, warnings and an open closing difference. Text labels identify each meaning independently of color.
- Counts and balances sit in joined tiles. In Reconcile's review step, a row of balance tiles (bank and books closing balance, closing difference, confirmed matches) spans the top, the reconciliation checks and suggestion details form a left rail, and the review list fills the rest. Below 960px the rail stacks above the list.

## Layout and interaction

1. A compact header contains the actual brand icon, local-processing indicator, and on-demand help. There is no marketing hero, permanent guide sidebar, or future-step placeholder.
2. Files, Match, and Results are mutually exclusive views. Loading both files enables the explicit next action; it does not append rules or move the user automatically. Completing a comparison opens Results. Back and step navigation retain loaded files and rules. Missing files return the view to Files, and changed rules disable stale results. Step changes move keyboard focus to the heading and reset page scroll.
3. Profiles are collapsed beneath setup. Existing save, apply, delete, import, export and storage-failure behavior is retained.
4. Paired baseline/updated file cards accept a native file picker or a dropped file. The picker remains keyboard-accessible and supports reselecting the same file. Loaded files show their names, counts, and expandable previews.
5. Delimiter selection sits with the source files. All three select surfaces (delimiter, saved profiles, changed-column filter) use a shared custom combobox/listbox. It supports arrows, Home/End, typeahead, Enter/Space, Escape, Tab, outside-click dismissal, and touch selection. Menus are portalled, positioned within the viewport, and scroll long option lists.
6. Key columns are the primary control on Match. Key normalization, value rules, and numeric-format help open on demand. Active settings remain summarized. Missing-key recovery and key-problem counts remain visible.
7. Results span the workspace width, with a compact count strip and export actions above the table. Exclusions and numeric warnings remain visible rather than being folded into successful comparison counts.
8. CSV and JSON exports have distinct buttons. One collapsed details area contains formula protection, full-comparison scope, format notes, and the rules audit.
9. Existing worker-backed paging and virtualization remain in place. Result tabs support arrow keys, Home and End; scrollable results are keyboard-focusable. Before/after values have separate backgrounds, a directional arrow, screen-reader labels and a nearby legend.
10. At narrower widths, file cards stack, actions wrap, and result tabs form two columns. Wide data tables scroll inside their containers. Desktop table height responds to viewport height; mobile, warnings, previews and expanded settings may still require normal page scrolling. Content is never clipped to force a fixed-height screen.

## Additional corrections

Cancellation help now accurately states that users must explicitly read files again. Previously it implied an automatic reread. Data processing behavior is unchanged.

## Focused-workspace validation (2026-10-06)

- `npm test`: 146 tests passed in 10 files.
- `npm run build`: TypeScript (including browser tests/config) and Vite production build passed.
- `npm run lint`: passed.
- `npm run test:ui`: 11 Playwright tests passed using installed Google Chrome and a local Vite development server. The suite is committed in `e2e/workspace.spec.ts`; it uses isolated browser contexts.
- Checks cover mutually exclusive views, focus on step change, preserved files/rules, stale-result gating, missing-key recovery, delimiter reparsing, saved-profile reload/apply, advanced numeric/case rules, exclusions/warnings, JSON content and CSV download, and result-tab keyboard navigation.
- Custom dropdown checks cover keyboard navigation, typeahead, selection, Escape/Tab/outside dismissal, touch, viewport bounds, and long scrolling lists.
- Screenshots were inspected at 1440px desktop and 390px mobile; automated layout checks cover 1440px, 768px and 390px. Initial desktop setup and basic results fit a 900px-tall viewport without document scrolling. No document-level horizontal overflow was found, including long column names.
- This is not a new large-file benchmark, production-browser smoke test, screen-reader audit, or Safari/Firefox verification. Historical tests below remain scoped to their earlier interface.

## Earlier redesign validation (2026-10-06)

- `npm test`: 146 tests passed in 10 files.
- `npm run build`: TypeScript and Vite production build passed.
- `npm run lint`: passed.
- The existing tests primarily cover engine, profiles, workers and paging; they do not establish redesigned UI correctness.
- A local production-preview smoke check passed in installed Chrome 154.0.8037.98 on the same M4 / 16 GiB Mac used for the historical browser verification. Loaded results at 1440px, 768px and 390px had no document-level horizontal overflow. Desktop and mobile screenshots were visually inspected; the tablet layout received automated checks.
- Browser checks covered the native file-input control, a synthetic DOM file-drop event, same-file re-selection, composite keys, numeric tolerance, case rules, all result tabs and problem categories, changed-column filtering, and tab navigation with arrows, Home and End.
- Saving a profile, reloading the page, applying it and recomparing reproduced the known counts: one added, one removed, one changed and three unchanged records, with one ambiguous key, two empty-key records and two numeric warnings.
- Actual protected CSV and JSON downloads succeeded. The JSON summary, record arrays, diagnostics and comparison rules matched the historical known-file report; the CSV retained its BOM, header and escaped formula example.
- The bundled Inter font loaded. No uncaught page errors or off-origin page requests were observed during this check.
- This is a smoke check, not a repeat of the large-file benchmarks or spreadsheet-import verification. Cancellation, large-table scrolling, long names, other browsers, profile-file controls, storage failure and assistive-technology behavior still need redesigned-UI verification. The historical browser measurements remain evidence for their original snapshot only.

## Browser review before deploying

- Check 1440px desktop, 768px tablet and 390px mobile layouts with long filenames and column names.
- Load files by picker and by drag-and-drop; change delimiter; preview records; reselect a file.
- Compare with single/composite keys, numeric rules, exclusions and warnings. Confirm key-problem details and missing-key recovery remain usable.
- Navigate tabs with keyboard arrows/Home/End and scroll large virtualized tables. Check focus visibility and screen-reader reading order.
- Exercise profile save/apply/import/export, storage failure, task cancellation and explicit reread.
- Download protected/unprotected CSV and JSON, including after a changed-column filter.

## Run locally

```sh
npm ci
npm run dev
```

Use `npm run build` and `npm run preview` for a production preview. Deploy through the repository's existing GitHub Pages workflow after review. No hosting configuration or audience change is part of this redesign.
