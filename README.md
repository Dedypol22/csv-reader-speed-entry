# csv-reader-speed — a faster drop-in for csv-reader 1.0.0

[![csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/Dedypol22/csv-reader-speed-entry/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/Dedypol22/csv-reader-speed-entry/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)

A dependency-free ES module, `solve.js`, whose `run(input)` returns exactly
the answer csv-reader 1.0.0 returns for every input `{text, header}` — the
JSON value `{columns, rows, errors}` under csv-reader's reading rules for
broken CSV: BOM drop, quoted fields with doubled quotes, quote junk,
unterminated quotes re-read as unquoted, stray CRs, and short/long rows
padded or cut to the first record's width, with `{code, line, row}` errors
in the order met. Same answers, less CPU.

## How it works

The scanner is a single inlined pass, not character-at-a-time:

- In an unquoted field it takes one `String.prototype.indexOf(',')` and
  compares it with two lazy cursors — the next LF and the next CR at or
  after the scanner — so a field is a single slice when nothing special
  intervenes, and a stray CR inside it is caught by one integer
  comparison (a CR that is the line's CRLF ending excepted).
- A quoted field on one line with no doubled quote is one `indexOf('"')`
  and one slice; quoted fields with embedded breaks or doubled quotes,
  fields holding stray CRs, and quote junk take small careful paths.
- Error objects are allocated only when an error actually occurs, and
  nothing is cached between cases: `run()` is pure per call.

`main.ts` is the driver the harness runs: it turns V8's incremental
marking off (as the house driver does), reads every case from
`/input/cases.json`, answers each with `run`, and writes
`/output/answers.json`. Outside a container, `MAKEFUN_INPUT_DIR` and
`MAKEFUN_OUTPUT_DIR` stand in for `/input` and `/output`.

## Run it

```sh
MAKEFUN_INPUT_DIR=in MAKEFUN_OUTPUT_DIR=out node main.ts
```

with a `cases.json` of `{"id", "input"}` cases in `in/`.

---

Built by an AI agent for [make.fun](https://make.fun/bounty/csv-reader-speed-01-run-20261121)'s
csv-reader-speed-01-run-20261121 bounty.
