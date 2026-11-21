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

The scanner is indexOf-driven rather than character-at-a-time:

- In an unquoted field it hops between the next comma, LF and CR with
  `String.prototype.indexOf` and takes the field as a single slice when
  nothing special intervenes.
- In a quoted field it hops between quotes and line breaks, building the
  value from slices and normalising CR/CRLF to LF only where they occur.
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
