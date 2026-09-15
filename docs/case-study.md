# Case study — ten defects a real corpus found

Every defect below was found against a live corpus, not against a fixture. Each
one is written the same way: the symptom that was visible in the product, the
root cause underneath it, the fix, and the regression test that now holds it.

The tests named here are in this repository and run in the same `npm test`
suite as everything else. Where a fix is a *calibration* rather than a
correction, it is labelled as one — a threshold moved after a measurement is not
the same kind of change as a rule that was wrong.

The client is not named anywhere in this repository, and the fixture snapshot
these tests run against carries invented organizers, events and contacts. The
counts and dates in this document are the real measurements from the corpus
that found each defect.

---

## 1. A consumer calendar is not a list of vendor opportunities

**Symptom.** A guided church tour, a planetarium show and a Christmas market all
ranked in the same shortlist. "Emporenführung auf Deutsch" and "Jüdisches
Museum, Ausstellung" sat in a list whose whole purpose is places a food truck
can trade.

**Root cause.** Municipal and tourism calendars are census sources: they answer
"what is happening in this city?" for *every* public happening, and all of it
arrives through one feed in one shape. The obvious guard — filter on
`events.event_type` — cannot work, because the normalizer defaults an
unrecognised occurrence to `street_food`. In the collection that exposed this,
the guided tour and the museum exhibition were both stored as `street_food`.
The category was evidence of nothing.

**Fix.** A separate relevance verdict (`relevant` / `irrelevant` / `unclear`)
decided by keyword rules over the event's own recorded text, with a defined
precedence: a strong food or market token wins even when an irrelevant token is
also present ("Museumsfest" is an event at a museum, not a museum), otherwise an
irrelevant token decides, and a weak token ("regional") never beats one
("Regionalliga" is football). Nothing matched is `unclear` — an honest verdict
that is ranked lower and tagged, never silently dropped. Deterministic and
offline: no model, no network, no clock.

**Regression test.** `server/vendor-relevance.test.ts` — including
"keeps a Kunstmarkt that happens to stand next to a museum", "excludes an
Emporenführung, which carries no market token at all" and "still excludes
Regionalliga football despite the word regional".

---

## 2. The weather cap starved the events the weather was for

**Symptom.** Events inside the forecast window — the ones a weather risk can
actually change a decision about — had no forecast attached, including the
week's Primary recommendation.

**Root cause.** The enrichment pass was bounded at 50 events per run. Measured
on 2026-09-15 the corpus held 160 relevant events inside the 10-day window, so
the cap silently starved two thirds of them. The bound was never wrong in
principle — an unbounded pass against a public API is a different bug — but it
had been set far below the season it had to survive.

**Fix.** The cap was raised to 400, which comfortably exceeds a busy season's
in-window population and still sits far inside Open-Meteo's free allowance. This
is a calibration, and the constant carries its measurement in a comment so the
next person can see what the number was fitted to.

**Regression test.** `server/weather.test.ts` — the window rules
("defaults to ten days and rejects nonsense", "leaves an event outside the
window completely untouched") plus the standing invariant that scoring is
byte-identical with and without a forecast attached.

---

## 3. Long-running rows crowded out the events being forecast

**Symptom.** Related to the cap, and hidden behind it: within whatever budget
the pass had, the wrong events consumed it.

**Root cause.** The selection is `ends_at >= now and starts_at <= horizon`,
ordered by `starts_at`. A season-long market that opened months ago and closes
in autumn satisfies the window and sorts to the very front — ahead of every
event that actually *starts* inside the next ten days. With a tight cap, those
long-running rows took the budget first.

**Fix.** The bound was raised past the point where the ordering can starve
anything (defect 2), so the head of the ordering no longer decides who gets a
forecast at all. The ordering itself is left deterministic on purpose: the pass
must produce the same result for the same snapshot.

**Regression test.** `server/weather.test.ts` drives the real selection window
against multi-day and single-day events; `server/cycle.test.ts` holds the
receipt the pass writes.

---

## 4. Cities that were not cities

**Symptom.** The product printed places that do not exist. The 2026-09-15
collection stored "Kirchplatz, Federal state unverified" and "Vorplatz
Einkaufszentrum" as cities, and "Alter Messplatz Landau" — a fairground, with
the actual city trailing behind it.

**Root cause.** Source rows carry a "location" that is sometimes a city and
sometimes the venue inside it, and nothing separated the two.

**The trap inside the fix.** German venue words are compound suffixes —
Kirch+platz, Stadt+halle, Markt+platz, Schloss+park. But several of those stems
are also complete city names: Halle is a city of 240,000 people, and Park, Markt
and Brück begin real place names. A naive substring rule would have thrown away
every event in Halle.

**Fix.** The venue check fires only on a stem that *ends a longer word*:
"Stadthalle" is a venue, "Halle" is a city, and the prefix is the difference. A
short list of strings that are venues even standing alone (Marktplatz,
Einkaufszentrum) is handled separately. A row that fails is kept out with the
reason recorded — the product never invents a city it could not read.

**Regression test.** `server/city-hygiene.test.ts` — "separates the city Halle
from a Stadthalle", "separates the town Neumarkt from a Kornmarkt", "does not
mistake a real city for a placeholder", and "names the word that decided, so the
verdict can be audited".

---

## 5. Geocoding failures that were name failures

**Symptom.** Events in real German towns had no coordinates and therefore no
forecast, with the geocoder simply returning nothing.

**Root cause.** Two name shapes the geocoder rejects verbatim: the abbreviated
saint ("St. Goarshausen"), and a venue word sitting in front of the city
("Kornmarkt Bad Kreuznach").

**Fix.** A deterministic, bounded candidate list — the name as recorded, then
`St.` expanded to `Sankt`, then the leading token dropped — tried in order,
never more than three lookups, and an error naming every candidate that was
tried when all of them fail. No fuzzy matching and no fallback coordinate: an
unlocatable city stays unlocated and says so.

**Regression test.** `server/weather.test.ts` covers `geocodeCandidates` for
both shapes and for the no-op case.

---

## 6. One festival, two opportunities, 0.625

**Symptom.** "Street Food Drink & Music Festival Sankt Augustin" and
"Streetfood Drink & Music Festival Sankt Augustin" — the same event, published
by two sources — ranked as two separate opportunities.

**Root cause.** Deduplication compares name tokens and merges at a confidence of
0.65 or above. German writes the same compound both ways, and a token comparison
cannot see inside a word: "Streetfood" and "Street Food" share no token, and the
pair scored 0.625 — just under the gate.

**Fix.** The known compounds are split to their two-word form *before*
tokenizing (`streetfood` → `street food`, `foodtrucks` → `food truck`, and the
same for a handful of others). The rule is reverse-safe by construction: both
spellings normalize to the split form, so it never depends on which spelling a
given source happened to publish. Because the normalizer never revisits an event
it has already written, a separate catch-up pass (`npm run dedup:merge`,
dry-run by default) re-applies the corrected rule to rows written under the old
one, moving all evidence to the keeper rather than deleting any.

**Regression test.** `server/dedup.test.ts` — "scores the real pair well above
the 0.65 merge threshold", "is reverse-safe — the compound and the split form
normalize the same way", and the guard "does not make the compound rule merge
unrelated street-food events". `scripts/merge-duplicates.test.ts` covers the
catch-up pass.

---

## 7. A booking that had ended was still holding the truck

**Symptom.** A client booking that ended on 2026-08-09 still carried
`state = 'live'`. It rendered under "Live bookings" in the weekly report and —
worse — every week it touched was still marked Blocked, so the report kept
recommending *against* work in weeks the truck was already free.

**Root cause.** Nothing ever transitioned a booking. `client_bookings.state` was
written once by the owner at intake, and no stage ever read the clock against
`ends_at`.

**Fix.** A lifecycle stage at the data layer, where the fact lives — not in the
renderer, which would have left the database wrong for every other reader. A
booking whose end is past and whose state is still `live` or `confirmed` becomes
`completed`. `cancelled` is never touched: a cancelled booking did not happen,
so it cannot have completed. What `completed` does *not* mean is that the
outcome is known — the report derives "Completed — outcome pending" from the
absence of an outcome row and keeps asking for the numbers still wanted.

**Regression test.** `server/booking-lifecycle.test.ts` — including "never
touches a cancelled booking", "leaves a booking that has not ended yet alone,
including one ending later today", and "completes a booking the instant its
recorded end has passed, and not before". `src/booking-state.test.ts` holds the
same derivation on the web side, so the two surfaces cannot drift.

---

## 8. Missing evidence was charged twice

**Symptom.** A freshly discovered event was structurally incapable of reaching
STRONG FIT. Every card read as low confidence however solid its sources were,
and the top of the list was occupied by whatever somebody had already
researched rather than by whatever fits best.

**Root cause.** One axis was doing two jobs. The fit score deducted for facts
that had not been gathered yet — an unknown pitch fee, a missing visitor count —
*and* the same gaps drove the confidence label. A gap was therefore charged
twice, and a new event could never climb out of the hole its newness put it in.

**Fix.** Two axes, separated. FIT scores only what is KNOWN: what the event is,
when it trades, where it is, how long it runs, whether the application window is
shut. Evidence adds a bonus on top; it never subtracts. Everything not yet
gathered goes to KEY UNKNOWNS and to the CONFIDENCE axis, which carries its own
recorded cause so a level is never printed without the reason for it. An event
with no commercial evidence at all can be a STRONG FIT — that is the point.

**The recalibration that followed.** Separating the axes moved every score, so
the tier bands were re-fitted against the live corpus (283 non-rejected events,
`--now 2026-09-15`). The scores form a top cluster at 72–74, a second at 64–68,
a mass at 60–61 and a tail below. B sits at 62, inside a real gap — nothing
scores 62 or 63 — so the GOOD/WATCH line falls *between* two clusters rather
than through one. A sits at 72, two points below the measured ceiling and inside
the top cluster. An out-of-region reference event still scored STRONG, which is
the intended semantics: unmeasured travel is a confidence question, not a fit
question.

**Regression test.** `src/ranking.test.ts` — "prints exactly eight components:
five known-fact, two evidence bonuses, one deductions line", "keeps verified
open opportunities above incomplete leads without inflating the tier", and "does
not fabricate travel distance from a region-only home location".

---

## 9. Chromium printed the disclosures shut

**Symptom.** The printed brief was missing content that the on-screen brief
showed: a tour's stops and a task's member events were simply absent from the
PDF. The HTML contained them; the paper did not.

**Root cause.** The brief folds those lists into `<details>` elements, and the
print stylesheet opened them with `details > summary ~ * { display: block }` —
which is not enough on Chromium 131 and later. The folded content lives behind
the `::details-content` pseudo-element, which the user-agent stylesheet hides
with `content-visibility`. `display: block` on the children never reaches it.

**Fix.** An explicit `details::details-content { content-visibility: visible;
block-size: auto }` in the print block, alongside the older rule so browsers
without the pseudo-element are unaffected. Found by printing the brief and
reading the PDF back — not by reading the HTML.

**Regression test.** `server/report-pdf.test.ts` — "prints every disclosure
open — paper has no triangle to click", which asserts against the produced
document rather than against the markup.

---

## 10. "106 events need action" was not 106 pieces of work

**Symptom.** The action queue showed one card per event. A hundred-odd cards is
not a to-do list; it is a wall. Separately, a touring operator running the same
festival through eight towns occupied eight rows of the opportunity radar and
crowded out everything else.

**Root cause.** The product was counting event mass and calling it work. Eight of
those events belonged to one festival operator and were one phone call.

**Fix.** Two display-level groupings, both deterministic.

- **The action queue thinks in organizers.** A task is an organizer, the events
  behind it, and the single ask that moves all of them. On the corpus that
  exposed this, 106 event cards became 7 tasks.
- **The radar thinks in series.** A tour is one row with its stops inside a
  disclosure, expandable.

Neither grouping merges a record. Every event keeps its own row in the
operational register, and the same snapshot always produces the same keys —
nothing in the grouping reads a clock or a locale default.

**Regression test.** `server/report-grouping.test.ts` — "groups the real Street
Food Festival tour across Bad Kreuznach, Groß-Gerau and Grünstadt", the guard
"NEVER groups two organizers running a similarly named festival", "falls back to
the source family when no organizer is recorded, and never groups the
unattributed", and "shows one radar row per tour while every stop keeps its own
register row".

---

## What these have in common

Six of the ten were invisible in fixtures and only appeared against a real
corpus: the noise in a municipal calendar, the venue-word cities, the compound
spelling, the booking nobody transitioned, the starved forecast budget, the
disclosure that printed shut. Two more — the double penalty and the tier bands —
could only be *measured* against one.

The pattern in every fix is the same. Find the fact where it lives rather than
patching the renderer that showed it. Keep the honest verdict (`unclear`,
"outcome pending", "no German geocoding result") instead of inventing a
confident one. And write the regression against the artifact that failed — the
produced PDF, the real row, the actual pair of names — not against a
reconstruction of it.
