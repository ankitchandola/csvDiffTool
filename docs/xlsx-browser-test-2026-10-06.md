# Deployed XLSX test report

Test date: 2026-10-06. Site: https://ankitchandola.github.io/csvDiffTool/
Live Chrome browser through the public UI. Workbooks independently generated with Python XlsxWriter, with deliberate XML modifications for missing cached results and declared-range tests. CSV expectations authored independently. These are not Excel-generated workbook/CSV pairs.

## Release-blocking finding: missing formula caches are accepted as empty

1. Load `multi.xlsx` as old and `multi.csv` as new.
2. Keep old sheet `Broken`, choose matching column `id`, compare.
3. Old B2 contains `<c r="B2"><f>1+1</f></c>`: formula, no stored `<v>` result. Old A2 is the text ID `1` with its valid shared-string reference.
4. Expected: record problem and comparison blocked; user asked to save the workbook from Excel.
5. Actual: old file Ready, one record. Comparison completes with 2 added, 1 changed, 0 unchanged, **Problems 0**. Change for ID1 reports `value` before `""`, after `alpha`.
6. Reproduced after a fresh page reload. Screenshot and exported JSON included.

Related manifestation: `missing-only-row.xlsx` has row2 containing only an uncached formula. Actual: Ready, 0 records, comparison setup enabled. Expected: report a record problem, not skip it as blank.

`missing-header.xlsx` is blocked, but reports `Column 1 has an empty header`, rather than identifying the missing saved formula result.

Fix direction: preserve and validate formula/cache presence before blank-row filtering and before turning cells into displayed strings. Distinguish absent result from valid empty-string, numeric zero, and Boolean FALSE results. This is an implementation suggestion; source code was not reviewed during these live tests.

## Test results

| Case | Observed result |
|---|---|
| Formatted XLSX -> CSV | 2 unchanged; no changes/problems under exact rules. Amount 1,234.50, ISO date, 12%, $1,234.50, text and number-format leading zeros, multiline Unicode text, formula zero/FALSE/empty. |
| CSV -> formatted XLSX | 2 unchanged. With currency and percent numeric rules enabled, 8 expected warnings (2 records × 2 columns × 2 sides); no changes. |
| Explicit string-type empty formula cache | `formatted-str.xlsx` uses `t="str"` with empty `<v>`; 2 unchanged against formatted.csv, including valid empty cache. |
| XLSX -> XLSX known changes | old.xlsx/new.xlsx: exactly 1 added, 1 removed, 1 changed, 1 unchanged; Problems0. |
| Header below blank rows | Valid sheet header on worksheet row3 parsed correctly. |
| Short rows | Missing trailing note cells padded empty; 3 unchanged against multi.csv. |
| Hidden rows/merged range | Hidden record included; notes show 1 hidden row and 1 merged range. 3 unchanged. Empty merged extension beyond header ignored. |
| Multi-sheet selection | Independent old/new sheet pickers; selected sheets parsed correctly. |
| Picker after rejected first sheet | multi-invalid.xlsx Broken sheet rejected for extra value; picker remains visible. Switching to Valid loads 3 records. |
| Delimiter change | Selected Valid sheet retained; CSV re-read on Comma selection. |
| Cancel/re-read | Cancelled Wide parse, then Read again retained Wide rather than Decoy. Both sides re-read successfully. |
| Extra data beyond header | extra.xlsx rejected with record1 extra values diagnostic. |
| Field cap | Sparse over-fields.xlsx declares B1000002; rejected with 2,000,000-field limit. This tests declared range guard, not a fully populated 2m-field workbook. |
| File cap | Synthetic 25MiB+1 file rejected before format parsing with 25MiB message. |
| Declared unpacked cap | Synthetic central-directory entry declares >256MiB; rejected before spreadsheet parsing. Tests declarations, not actual decompression or zip-bomb protection. |
| OLE/legacy signature | Synthetic .xls with OLE signature rejected with save as .xlsx (without password) or CSV UTF-8 message. Not a real encrypted or historical .xls workbook. |
| Missing cached formula data | FAIL: read as empty, false change, no problem. |
| Formula-only row missing cache | FAIL: skipped as blank, file accepted. |

## Browser benchmark

Two workbooks, each with Decoy sheet and Wide sheet. Wide: 10,000 records ×50 columns =500,000 fields. File sizes approximately 2.65MiB and 3.08MiB. ID is the key; c1 changes on every even ID.

Observed 5,000 changed /5,000 unchanged, no added/removed/problems. Virtual list scrolled through to ID10000. Both exports downloaded. Every one of 5,000 CSV rows and 5,000 JSON changes was checked against independently constructed expectations: key even IDs 2..10000, column c1, before v<ID>-1, after changed. All passed.

Coarse UI elapsed times including automation overhead: old re-read plus new Decoy start ~2.57s; selecting and parsing new Wide ~3.62s; compare ~0.28s; CSV export ~0.29s; JSON export ~0.95s. These are smoke-test timings, not controlled performance measurements. No browser memory profiling; cannot validate the provisional caps from this run.

Captured error/warning logs contained no app errors in the returned set after filtering browser-extension messages.

## Still unverified

- Excel-generated workbook pairs against Excel's actual CSV UTF-8 exports: original release check remains open.
- Browser performance/memory at or near caps; other devices/browsers.
- Actual password-protected workbook, actual .xls, .xlsb, .ods.
- Worker crash/OOM recovery, and claim that the page itself always survives.
- Locale-dependent/custom format compatibility, hidden columns, complex populated merges, profiles with spreadsheet inputs, lazy loading/network chunk behavior.

Do not mark XLSX fully supported until missing-cache validation is fixed and the Excel-generated release check is completed.
