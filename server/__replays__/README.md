# Source-adapter replay fixtures

One captured-page body per source family, plus the byte-level expected output of
the shipped extractor for each. `server/replay-harness.test.ts` runs every body
through its mapped extractor with a pinned clock and compares the FULL result —
event count and every field of every occurrence — against
`expected/<name>.json`.

## Provenance — read this before trusting a body

**These bodies are NOT fresh crawls.** Every one of them was lifted out of this
repo's own test fixtures, where they had been written inline as template
literals:

| replay | body file | lifted from |
| --- | --- | --- |
| foodtruckmeile | `foodtruckmeile.html` | `server/source-adapters.test.ts` ("extracts a Foodtruckmeile tour row…") |
| tour-agentur | `tour-agentur.json` | `server/source-adapters.test.ts` ("extracts Tour-Agentur accordion headings…") |
| haendler-portal | `haendler-portal.html` | `server/source-adapters.test.ts` ("extracts Händlerportal events…") |
| json-ld | `json-ld.html` | `server/source-adapters.test.ts` (the four JSON-LD cases, merged into one page) |
| ics | `street-food-market.ics` | `server/source-adapters.test.ts` (the ICS calendar plus its separate UTC-stamp calendar, merged into one file) |
| german-list | `german-list.html` | `server/source-adapters.test.ts` ("pairs a date row with the nearest preceding heading…") |
| tribe-events | `tribe-events.json` | `server/source-probe.test.ts` ("extracts stable occurrences from a Tribe Events API response") |

Those inline fixtures were authored during the 2026-07 / 2026-08 adapter work.
They are REPRESENTATIVE of the real pages' structure — that is what they were
written for — but they are hand-written reductions, not bytes off a live server,
and no claim beyond that may be made from them. In particular:

* they prove the adapters still parse what we believed those pages looked like;
* they prove NOTHING about whether the live pages still look that way today.
  Answering that needs a real crawl, which this offline suite deliberately does
  not do.

The dates inside the bodies (2026-07 through 2027-06) are fixture dates, not
capture dates.

## The pinned clock

`REPLAY_CLOCK` = `2026-08-01T09:00:00.000Z`, the same instant the original
adapter tests pin. Several extractors drop events that have already ended, so
without a pinned clock the expected output would shrink on its own as real time
passed and the lock would rot into a tautology.

## Refreshing a capture

Refreshing is an explicit, reviewed act — never a side effect of an adapter
edit:

1. Replace the body file (and say in the commit message where the new bytes came
   from, honestly).
2. Regenerate the expected file:
   `npx tsx -e 'import {REPLAYS,replaySnapshot,expectedPath} from "./server/__replays__/index.ts";
   import {writeFileSync} from "node:fs";
   for (const r of REPLAYS) writeFileSync(expectedPath(r.name), JSON.stringify(replaySnapshot(r),null,2)+"\n");'`
3. READ the diff. A field-level change in `expected/` is the harness doing its
   job; committing it without reading it defeats the whole point of the lock.

If an adapter change makes the harness fail, the diff is the evidence: decide
whether the new extraction is correct, and only then regenerate.
