# Architecture

## The pipeline

Every stage is deterministic unless this document says otherwise. Each one writes a receipt, and the whole sequence runs as one idempotent cycle (`npm run cycle:scheduled`) behind a PostgreSQL advisory lock, so two overlapping runs cannot both collect.

```mermaid
flowchart TD
    S["Registered sources<br/>municipal · tourism · organizer · directory · procurement"]
    E["Extraction<br/>Tribe API · JSON-LD · ICS · HTML adapters"]
    R["Raw occurrences<br/>immutable · content-hashed · source_runs receipt"]
    N["Normalize + dedup<br/>city/date/name score, merge at ≥ 0.65"]
    V["Vendor-relevance gate<br/>relevant · irrelevant · unclear"]
    K["Deterministic scoring<br/>travel radius · trading days · week occupancy"]
    C["Organizer + contact resolution<br/>route owner, scope, reachability, content hash"]
    D["Deadline monitor<br/>published · not_found · none_rolling → 30/14/7/2-day alerts"]
    W["Weather enrichment<br/>city precision · score-neutral"]
    RPT["Three-layer reporting"]
    B["Decision brief (HTML)<br/>60 seconds: act now, top opportunities, deadline radar"]
    REG["Operational register (XLSX)<br/>every non-irrelevant event in the snapshot"]
    EV["Evidence sheets<br/>sources · drafts · system QA"]
    A["Owner approval<br/>proposal-only → approved_waiting_connector"]

    S --> E --> R --> N --> V --> K --> C --> D --> W --> RPT
    RPT --> B
    RPT --> REG
    RPT --> EV
    B --> A
    REG --> A
```

Two properties of the diagram are load-bearing:

- **Raw occurrences are never edited.** Normalization writes canonical events beside them and links back; discovery stays auditable after the fact.
- **The pipeline ends at a proposal.** Nothing downstream of the owner's approval exists — see [Limitations](limitations.md).

## The entity graph

Discovery produces occurrences; the graph is what turns them into decisions. A raw occurrence is what one source said on one day. A canonical event is the thing itself, and the two are joined by typed, confidence-scored match edges rather than by overwriting.

```mermaid
erDiagram
    SOURCE ||--o{ RAW_OCCURRENCE : "collected in a source_run"
    RAW_OCCURRENCE }o--|| EVENT_SOURCE_LINK : "match edge"
    EVENT_SOURCE_LINK }o--|| EVENT : "canonicalises to"
    EVENT }o--o| ORGANIZER : "principal organizer"
    ORGANIZER ||--o{ CONTACT : "named route owner"
    EVENT ||--o{ APPLICATION_WINDOW : "route, deadline, capacity"
    APPLICATION_WINDOW ||--o{ WINDOW_CHECK : "content-hashed check receipt"
    EVENT ||--o{ EVENT_EVIDENCE : "field-level proof"
    EVENT ||--o{ WEATHER_FORECAST : "near-term, display only"
    EVENT ||--o{ BOOKING : "outcome, once committed"
```

- **`EVENT_SOURCE_LINK` carries `match_method` and `match_confidence`.** A merge is a recorded claim with a method and a number behind it, so a wrong merge can be found and reversed instead of being indistinguishable from a correct one.
- **`EVENT_EVIDENCE` is field-level.** Evidence supports *named fields* (`dates`, `city`, `organizer`, `food_zone`) with a publisher, an observed timestamp and a content hash — the mechanism that lets the brief show why it believes each claim.
- **`APPLICATION_WINDOW` separates route from capacity.** "A general organizer application route exists" and "a pitch in my category is still free at this event" are different facts with different evidence, and conflating them is the single most expensive error this domain offers. Capacity stays `unknown` until event-specific proof exists.

## Model-use boundary

The language model is used for exactly two things: reading ambiguous free text that rules cannot settle, and drafting prose for a human to approve. Everything a decision depends on is deterministic.

| Stage | Deterministic | Model |
| --- | --- | --- |
| Extraction (API / JSON-LD / ICS / HTML) | ✅ | — |
| Normalization and dedup | ✅ | — |
| Vendor-relevance gate | ✅ | — |
| Fit scoring and ranking | ✅ | — |
| Deadline evidence and alerts | ✅ | — |
| Weather enrichment | ✅ | — |
| Report rendering (all three layers) | ✅ | — |
| Ambiguous free-text interpretation in an owner turn | — | ✅ |
| Organizer / owner draft prose | — | ✅ |

Three guarantees hold that line:

1. **Receipted.** Every model call's token usage is written to `llm_usage` and enforced against a daily Europe/Berlin cap. Usage is a measured number, not an estimate.
2. **Fallback is audible.** With no API key, an exhausted cap, or a failed call, the deterministic core answers — and in the last two cases the reply says so explicitly rather than degrading silently.
3. **Model prose is never promoted to fact.** A completed turn stores the owner's question and the titles of the live records used. Generated prose is not written into memory as though it were evidence.

The containment rules around tool use — the per-turn web guard, proposal-only external action, and untrusted-page handling — are specified in [`AGENT_OPERATING_MODEL.md`](../AGENT_OPERATING_MODEL.md).
