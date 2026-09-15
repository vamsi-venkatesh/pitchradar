# PitchRadar operating model

## Product promise

PitchRadar is not an event calendar. It is a booking-intelligence and operating-memory system for a food-truck business.

The product must answer:

1. Which events exist in every relevant week?
2. Who actually controls the food pitch?
3. When does the application open and close?
4. Is a speciality pitch still available?
5. Is the opportunity commercially and operationally suitable?
6. Which opportunities should the owner try in parallel?
7. Which confirmed booking protects the week?
8. Did the booking make money and should the client return?

## Discovery graph

One event can have several commercial actors:

`public event → municipality → principal organizer → zone operator → trader portal or tender → category decision-maker`

The agent must follow that graph. A public event page is discovery evidence, not proof that a vendor can apply.

### Layer 1: event census

Municipal calendars, tourism calendars and regional event lists provide broad occurrence discovery. They answer only “where and when?”

### Layer 2: organizer networks

Multi-city food-festival operators, city-festival contractors and zone operators expose tour schedules and reusable relationships. One verified relationship can unlock several weeks.

### Layer 3: applications and trader portals

Application pages, trader portals, municipal calls and event-team contacts reveal the booking window, deadline, route owner and requirements.

### Layer 4: procurement

Tender and concession notices can expose opportunities months before visitor marketing starts. They also reveal rents, selection criteria and contractual duties.

### Layer 5: private demand

Corporate bookings, private properties and inbound catering requests need a consented marketplace or relationship feed. This remains a declared coverage gap.

## Application lifecycle

Every prospect needs these fields:

- application route and route owner
- route scope: event-specific, organizer-wide or portal-wide
- whether the published route was reachable at the last check
- opening date, deadline and next expected cycle
- remaining capacity: available, limited, full, rolling, not yet open or unknown
- last checked and next check
- evidence URL and observed time
- category conflict or exclusivity
- pitch fee and utilities
- required documents
- an immutable check receipt for changed official evidence

“Application open” never means “speciality pitch available.” The agent must verify both separately.

## Weekly business logic

- A live or confirmed booking occupies every calendar week it overlaps.
- Conflicting prospects are blocked from recommendation.
- In a free week, pursue a Primary and Backup in parallel until acceptance.
- A long booking gains duration value but cannot override poor economics or impossible logistics.
- An event with a near deadline can outrank a higher-fit event whose application remains far away.
- The owner approves all calls, messages, applications, prices and contracts.

## Learning loop

After every booking, collect:

- daily revenue and portions sold
- pitch, food, labour, travel and accommodation costs
- weather and stock loss
- organizer reliability
- owner rating
- repeat invitation
- next-cycle opening clue

The next ranking model should use these real outcomes. Until they exist, PitchRadar must not invent revenue or margin.

## Operational automation

The queue in `src/agent-operations.ts` creates five job classes:

1. protect current bookings
2. recheck application windows
3. prepare before deadlines
4. scan mapped sources at their cadence
5. close explicit coverage gaps

All generated jobs are internal. External action is always `false` until an approved action record exists.

### Source collector

`npm run sources:collect` reads the enabled source registry from PostgreSQL and selects only sources due by cadence. `npm run sources:collect:all` forces a complete audit.

Each source run:

- performs a bounded public-network request with redirect, timeout and response-size controls
- classifies the source as reachable, access-restricted, broken, degraded or unavailable
- stores an immutable `source_runs` receipt and updates the source's last-check fields
- extracts supported structured events into `raw_event_occurrences`
- deduplicates unchanged occurrences by source and content hash
- normalizes pending occurrences into canonical events after collection
- links each accepted event to its raw source row and field-level evidence
- keeps a general application route separate from event-specific speciality capacity

Beispiel Events reads its official Tribe Events API across a rolling 18-month window. Foodtruckmeile, Beispiel Tour-Agentur and Händlerportal use dedicated page adapters. The normalizer ignores expired and clearly foreign occurrences, preserves partial verification for discovered events, and records application capacity as `unknown` until event-specific evidence proves otherwise. Other registered sources currently receive health receipts but still require dedicated HTML, PDF, portal or procurement adapters before their events become raw occurrences.

`npm run intelligence:refresh` follows the normalized events into five high-value organizer and trader-portal routes. It verifies only contacts and application fields that remain present on official pages, updates every future event in that organizer network, and records a content-hashed application-check receipt. A healthy general route becomes `route_reachable=true`; category capacity remains `unknown` until event-specific proof exists.

Scheduling is deployment-specific: the private deployment runs the cycle from hardened systemd timer units, which are not part of this repository.

## Owner agent runtime

PitchRadar exposes one owner-facing Command Agent backed by nine runtime roles: Command, Scout, Verifier, Opportunity, Application, Schedule, Memory, Approval and Pipeline. These are routing and responsibility boundaries, not decorative UI labels.

Every turn follows one auditable decision path:

`owner question → Command Agent → specialist route → relevant live retrieval → deterministic answer, bounded tool, or DeepSeek synthesis → safety validation → shared memory update`

The Command Agent knows the complete agent and tool registries, and it classifies the turn to pick the
specialist route, the preferred model and the retrieved context. The route does **not** scope the tool
set: `routeTurn` in `server/retrieval.ts` returns `allToolNames` on every route, so all thirteen tools
below are offered on every turn, and the system prompt says so explicitly ("You have the full tool set
regardless").

Containment is therefore enforced at call time, not by the route:

- **Per-turn web guard.** `search_public_web` (when it reaches the network), `live_check_event` and
  `fetch_public_page` set `webFetched` on the turn context. Once that flag is set, the three write
  tools — `set_opportunity_state`, `remember_business_fact` and `propose_external_action` — refuse for
  the rest of the turn and return an `unavailable` receipt. Fetched page text can never seed an
  internal state change, a durable memory or an owner approval queue entry.
- **Proposal-only external action.** `propose_external_action` never executes; it can only create a
  held proposal for owner approval.
- **Untrusted page content.** Public page fetches permit only HTTP(S), resolve DNS before access, block
  private/loopback/link-local targets, cap response size and time, and treat page content as untrusted
  evidence.

### Read and verification tools

- `query_opportunities` — ranked opportunities, application status, evidence gaps and next actions
- `query_calendar` — events overlapping an exact date, a month or a date range
- `read_business_profile` — menu, travel rules, operating days, live bookings, missing commercial inputs
- `query_research_queue` — deterministic due work across scans, rechecks, booking protection and gaps
- `query_availability_queue` — availability drafts, verified routes, blockers and owner-approval state
- `search_registered_sources` — search the registered source network
- `search_public_web` — public web search; results are candidates, not verified facts *(sets `webFetched`)*
- `live_check_event` — fetch an event's strongest official source now, with a receipt *(sets `webFetched`)*
- `fetch_public_page` — read one public HTTP(S) page as untrusted evidence *(sets `webFetched`)*
- `recall_memory` — recall durable event-operations facts and decisions

### Internal mutation tools

- `set_opportunity_state` — shortlist, watch, skip or update the internal pipeline
- `remember_business_fact` — store tenant-scoped event-operations memory

Each mutation returns a receipt and changes PitchRadar only. Both refuse after a web fetch in the same turn.

### Approval-gated tools

- `propose_external_action` — email, application, organizer contact or calendar action; also refuses after a web fetch in the same turn

The proposal is never execution. Approval currently records owner intent as `approved_waiting_connector`; it still sends nothing. A delivery connector must be separately implemented, secured and audited.

### The external boundary

PitchRadar discovers, qualifies, recommends, prepares and records owner-approved intent. It does not autonomously contact organizers or submit applications. External execution remains outside the published proof. An approval is a state
change recorded against the owner's decision, never a delivery: it moves a held proposal to
`approved_waiting_connector` and stops there. No delivery integration exists in this repository, and
the private owner threshold is the only way a decision is ever recorded.

### Event-specific availability queue

`npm run verification:queue` turns the first free calendar weeks into a durable owner-review queue. It includes every actionable event in those weeks, preserves Primary, Backup and Verify-first order, snapshots the verified contact or portal route, and prepares German organizer copy with an English owner translation.

Missing recipients remain visible as `blocked_contact_missing`; they cannot be approved. Reviewable drafts can become `approved_waiting_connector`, but that state still performs zero external actions. Creation, refresh, approval and cancellation each receive an immutable database receipt.

### Model and memory modes

- With `PITCHRADAR_LLM_API_KEY`, DeepSeek v4 Flash handles ordinary synthesis and DeepSeek v4 Pro handles comparisons and multi-record reasoning.
- DeepSeek is never the first router. The Command Agent classifies the turn and retrieves a live hybrid context from PostgreSQL plus scoped memory before a model call.
- The router never selects a deterministic mode. When an API key is configured, `routeTurn` always returns `mode: "language_model"`; the deterministic core is a *fallback*, entered only when no key is configured, when the daily token cap is exhausted, or when the model call throws. In the last two cases the reply says so explicitly.
- The model sees conversation history, not only the current question. `runLanguageTurn` in `server/agent.ts` replays the last 12 messages of the session — user turns *and* prior assistant prose — between the system prompt and the current owner question. Shared memory retrieval supplies durable state on top of that replay, it does not replace it.
- Exact month/event lists, queue reads and internal mutations do not depend on model availability.
- Broad search can use Brave Search or a private self-hosted SearXNG endpoint.
- Without it, deterministic owner commands still read the product, recheck known official sources, change internal state, draft replies and create approval proposals.
- Memory is shared across specialists by `tenantId=demo-operator` and `appId=event_ops`; `agentId` records which specialist contributed the fact, decision or episode, while `sessionId` preserves conversational provenance.
- Every completed turn stores the owner question and titles of the live records used. Model prose is not promoted to memory as fact.
- The current adapter persists shared memory in PostgreSQL when configured, with isolated local JSON only as an explicit fallback. A different retrieval/consolidation backend can replace the adapter without changing the orchestration contract.

## Production status and remaining release gates

The private web product is operational: owner authentication and HTTPS cookies are configured,
PostgreSQL is the source of truth, raw discoveries are retained and deduplicated, organizers and
contacts form a reusable relationship graph, the owner can approve or reject held actions, the
daily operating cycle is installed, and restore-validated backups run on the private server.
Coverage is measured without claiming “all Germany.”

The following capabilities are separate expansion gates, not enabled-product defects:

- build the remaining high-value source-specific extraction adapters
- store delivery receipts and organizer responses after a connector is legally enabled
- capture booking outcomes so actual economics can train the next-cycle ranking
