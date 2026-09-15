import {
  Activity,
  ArrowRight,
  BadgeCheck,
  Building2,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock3,
  ExternalLink,
  FileCheck2,
  FileText,
  Gauge,
  LockKeyhole,
  LogOut,
  Mail,
  MapPin,
  Menu,
  Phone,
  Radar,
  Search,
  ShieldCheck,
  Sparkles,
  Store,
  Target,
  UserRound,
  X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { applicationDecision, applicationIntelligenceFor } from "./application-intelligence";
import { useOwnerAuth } from "./AuthGate";
import { bookingBadgeFor, bookingHoldsTruck, bookingLifecycleFor } from "./booking-state";
import type { BriefingView } from "./briefing";
import { authFetch } from "./auth-client";
import { fetchProductSnapshot, type ProductSnapshot } from "./product-data";
import { rankOpportunities } from "./ranking";
import { sourceLayerLabels, type RegisteredSource, type SourceLayer } from "./source-registry";
import type {
  AvailabilityVerificationRequest,
  ClientBooking,
  ClientProfile,
  EventOpportunity,
  OpportunityTier
} from "./types";
import { groupByCalendarWeek, type EventWeek } from "./week-planning";
import { AgentPanel } from "./AgentPanel";
import { ClientIntake } from "./ClientIntake";

type View = "command" | "plan" | "events" | "applications" | "organizers" | "sources" | "reports" | "business";
type Filter = "all" | OpportunityTier;

const dateFormat = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" });
const shortDate = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short" });
const briefDateFormat = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long" });
const monthChipFormat = new Intl.DateTimeFormat("en-GB", { month: "short" });

function currentWeekChip(now = new Date()) {
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const dayOf = (date: Date) => String(date.getDate()).padStart(2, "0");
  return { month: monthChipFormat.format(monday).toUpperCase(), range: `${dayOf(monday)}–${dayOf(sunday)}` };
}

function formatDate(value: string) {
  return dateFormat.format(new Date(value));
}

/** Check dates are null until a real check happened. Never print a date we don't have. */
function formatCheckDate(value: string | null | undefined) {
  return value ? formatDate(value) : "Not yet checked";
}

function dateRange(item: Pick<EventOpportunity | ClientBooking, "startsAt" | "endsAt">) {
  const start = new Date(item.startsAt);
  const end = new Date(item.endsAt);
  if (start.toDateString() === end.toDateString()) return formatDate(item.startsAt);
  return `${shortDate.format(start)} – ${formatDate(item.endsAt)}`;
}

function inclusiveDays(item: Pick<EventOpportunity | ClientBooking, "startsAt" | "endsAt">) {
  const duration = new Date(item.endsAt).getTime() - new Date(item.startsAt).getTime();
  return Math.max(1, Math.round(duration / 86_400_000) + 1);
}

function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`ss-logo ${compact ? "is-compact" : ""}`}>
      <span><Radar /></span>
      {!compact && <strong>PitchRadar</strong>}
    </div>
  );
}

function priorityEvents(ranked: EventOpportunity[], bookings: ClientBooking[]) {
  return ranked
    .filter((event) =>
      event.tier !== "REJECTED" &&
      !bookings.some((booking) =>
        new Date(event.startsAt) <= new Date(booking.endsAt) &&
        new Date(booking.startsAt) <= new Date(event.endsAt)
      )
    )
    .sort((a, b) => {
      const weight = { act: 0, prepare: 1, verify: 2, watch: 3, blocked: 4 };
      const aDecision = applicationDecision(a);
      const bDecision = applicationDecision(b);
      const urgency = weight[aDecision.urgency] - weight[bDecision.urgency];
      if (urgency) return urgency;
      if (aDecision.daysRemaining !== undefined && bDecision.daysRemaining !== undefined) {
        return aDecision.daysRemaining - bDecision.daysRemaining;
      }
      if (aDecision.daysRemaining !== undefined) return -1;
      if (bDecision.daysRemaining !== undefined) return 1;
      return (b.score ?? 0) - (a.score ?? 0);
    });
}

const nav: Array<{ view: View; label: string; icon: typeof Radar }> = [
  { view: "command", label: "Command centre", icon: Radar },
  { view: "plan", label: "Booking plan", icon: CalendarDays },
  { view: "events", label: "Events", icon: Target },
  { view: "applications", label: "Applications", icon: FileCheck2 },
  { view: "organizers", label: "Organizers", icon: Building2 },
  { view: "sources", label: "Sources", icon: Activity },
  { view: "reports", label: "Reports", icon: FileText },
  { view: "business", label: "Business", icon: UserRound }
];

function SideRail({
  view,
  changeView,
  onOpenAgent,
  onLogout,
  canLogout
}: {
  view: View;
  changeView: (view: View) => void;
  onOpenAgent: () => void;
  onLogout: () => void;
  canLogout: boolean;
}) {
  return (
    <aside className="side-rail">
      <Logo />
      <nav aria-label="Product navigation">
        {nav.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.view}
              className={view === item.view ? "active" : ""}
              onClick={() => changeView(item.view)}
              aria-label={item.label}
              title={item.label}
            >
              <Icon />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>
      <div className="rail-foot">
        <span className="status-beacon" />
        <button className="rail-agent" onClick={onOpenAgent} aria-label="Ask PitchRadar" title="Ask PitchRadar"><Sparkles /></button>
        {canLogout && <button onClick={onLogout} aria-label="Lock PitchRadar" title="Lock PitchRadar"><LogOut /></button>}
      </div>
    </aside>
  );
}

function MobileTopbar({
  onOpenShortlist,
  onOpenAgent,
  count
}: {
  onOpenShortlist: () => void;
  onOpenAgent: () => void;
  count: number;
}) {
  return (
    <header className="mobile-topbar">
      <Logo />
      <button className="mobile-scout" onClick={onOpenAgent} aria-label="Ask PitchRadar" title="Ask PitchRadar"><Sparkles /><em>Ask AI</em></button>
      <button onClick={onOpenShortlist} aria-label="Open approval queue"><ShieldCheck />{count > 0 && <b>{count}</b>}</button>
    </header>
  );
}

function MobileNav({
  view,
  changeView,
  onOpenMore
}: {
  view: View;
  changeView: (view: View) => void;
  onOpenMore: () => void;
}) {
  const mobileItems = nav.filter((item) =>
    ["command", "plan", "events", "applications"].includes(item.view)
  );
  const moreActive = ["organizers", "sources", "reports", "business"].includes(view);
  return (
    <nav className="mobile-bottom-nav" aria-label="Mobile navigation">
      {mobileItems.map((item) => {
        const Icon = item.icon;
        const mobileLabels: Partial<Record<View, string>> = {
          command: "Command",
          plan: "Plan",
          applications: "Apps",
          business: "Business"
        };
        const label = mobileLabels[item.view] ?? item.label;
        return <button key={item.view} className={view === item.view ? "active" : ""} onClick={() => changeView(item.view)}><Icon /><span>{label}</span></button>;
      })}
      <button className={moreActive ? "active" : ""} onClick={onOpenMore} aria-label="More sections">
        <Menu />
        <span>More</span>
      </button>
    </nav>
  );
}

function MobileMoreMenu({
  view,
  changeView,
  onClose,
  onLogout,
  canLogout
}: {
  view: View;
  changeView: (view: View) => void;
  onClose: () => void;
  onLogout: () => void;
  canLogout: boolean;
}) {
  const items = nav.filter((item) => ["organizers", "sources", "reports", "business"].includes(item.view));
  const descriptions: Record<"organizers" | "sources" | "reports" | "business", string> = {
    organizers: "Verified contacts and application routes",
    sources: "Coverage, checks and evidence freshness",
    reports: "Every weekly brief, register and PDF written",
    business: "Menu, operating rules and truth gaps"
  };

  function selectView(next: View) {
    onClose();
    changeView(next);
  }

  return (
    <>
      <button className="mobile-more-backdrop" onClick={onClose} aria-label="Close more sections" />
      <aside className="mobile-more-sheet" role="dialog" aria-modal="true" aria-labelledby="mobile-more-title">
        <header>
          <div><p className="overline">Workspace</p><h2 id="mobile-more-title">More operations</h2></div>
          <button onClick={onClose} aria-label="Close more sections"><X /></button>
        </header>
        <nav aria-label="More product sections">
          {items.map((item) => {
            const Icon = item.icon;
            const itemView = item.view as "organizers" | "sources" | "reports" | "business";
            return (
              <button key={item.view} className={view === item.view ? "active" : ""} onClick={() => selectView(item.view)}>
                <span><Icon /></span>
                <span><strong>{item.label}</strong><small>{descriptions[itemView]}</small></span>
                <ChevronRight />
              </button>
            );
          })}
        </nav>
        {canLogout && <footer><button onClick={onLogout}><LogOut /> Lock PitchRadar</button></footer>}
      </aside>
    </>
  );
}

function AppHeader({
  view,
  onOpenAgent,
  onOpenQueue,
  queueCount
}: {
  view: View;
  onOpenAgent: () => void;
  onOpenQueue: () => void;
  queueCount: number;
}) {
  const titles: Record<View, { title: string; subtitle: string }> = {
    command: { title: "Command centre", subtitle: "Today’s operating brief" },
    plan: { title: "Booking plan", subtitle: "Protect every trading week" },
    events: { title: "Events", subtitle: "Opportunity and evidence in one place" },
    applications: { title: "Applications", subtitle: "Prepare, approve and follow through" },
    organizers: { title: "Organizers", subtitle: "Relationships that unlock more dates" },
    sources: { title: "Sources", subtitle: "Coverage, freshness and honest gaps" },
    reports: { title: "Reports", subtitle: "Every weekly artifact the generator wrote" },
    business: { title: "Business", subtitle: "The operating profile behind every decision" }
  };
  return (
    <header className="app-header">
      <div><p>{titles[view].subtitle}</p><h1>{titles[view].title}</h1></div>
      <div className="app-header-tools">
        <span className="header-live"><i />PitchRadar ready</span>
        <button className="header-agent" onClick={onOpenAgent}><Sparkles /> Ask PitchRadar</button>
        <button className="header-queue" onClick={onOpenQueue}><ShieldCheck /> {queueCount} to review</button>
      </div>
    </header>
  );
}

/**
 * B — THE BUSINESS KPI ROW.
 *
 * The same eight numbers and the same computed sentence the weekly brief
 * prints, read straight off the snapshot's briefing field. Nothing here is
 * derived a second time: a KPI the web computes for itself is a KPI that can
 * disagree with the artifact the owner actually sends people.
 */
function KpiRow({ briefing }: { briefing: BriefingView }) {
  const kpis = briefing.kpis;
  const cells: Array<[string, number, string]> = [
    ["Events checked", kpis.eventsChecked, "everything the sources carried"],
    ["Vendor-relevant", kpis.vendorRelevant, "a possible pitch, not a listing"],
    ["Shortlisted", kpis.shortlisted, "strong + good fit"],
    ["Recommended", kpis.recommended, "strong fit"],
    ["Action now", kpis.actionNow, `${kpis.actionNowEvents} events in ${kpis.actionNow} task${kpis.actionNow === 1 ? "" : "s"}`],
    ["Deadlines ≤30d", kpis.upcomingDeadlines, "published deadlines"],
    ["Current bookings", kpis.currentBookings, "holding the truck"],
    ["Conflicts", kpis.conflicts, "prospects colliding with a booking"]
  ];
  return (
    <section className="kpi-row" aria-label="Business key figures">
      <div className="kpi-cells">
        {cells.map(([label, value, note]) => (
          <article key={label}>
            <small>{label}</small>
            <strong>{value}</strong>
            <span>{note}</span>
          </article>
        ))}
      </div>
      <p className="kpi-summary">{briefing.summarySentence}</p>
    </section>
  );
}

/** B4 — the five deadlines closest to closing, straight from the brief. */
function DeadlineRadarBlock({ items }: { items: BriefingView["deadlineRadar"] }) {
  return (
    <section className="deadline-radar-block" aria-label="Deadline radar">
      <header><p className="overline">Deadline radar</p><h2>Closest published deadlines</h2></header>
      {items.length ? (
        <ul>
          {items.map((item) => (
            <li key={item.eventId} className={`is-${item.severity.toLowerCase()}`}>
              <span><strong>{item.eventName}</strong><small>{item.locationLine}</small></span>
              <span><strong>{item.deadlineLabel}</strong><small>{item.routeStatus}</small></span>
              <b>{item.daysRemaining} day{item.daysRemaining === 1 ? "" : "s"}</b>
              <em className={`severity is-${item.severity.toLowerCase()}`}>{item.severity}</em>
            </li>
          ))}
        </ul>
      ) : (
        <p className="deadline-radar-empty">No event carries a published future deadline. Where a deadline is unknown the register says whether it was never found or whether applications are rolling.</p>
      )}
    </section>
  );
}

/**
 * B2 — bookings that are OVER. The command centre used to pin the ended
 * Seefest am Demo-Ufer into the current week as a live client operation; a booking the
 * clock has passed belongs here, with what is still wanted from it.
 */
function BookingHistory({ bookings, now }: { bookings: ClientBooking[]; now: Date }) {
  const past = bookings
    .map((booking) => ({ booking, lifecycle: bookingLifecycleFor(booking, now) }))
    .filter((row) => row.lifecycle !== "live" && row.lifecycle !== "upcoming");
  if (!past.length) return null;
  return (
    <section className="booking-history" aria-label="Booking history">
      <header><p className="overline">Bookings</p><h2>Completed and closed</h2></header>
      {past.map(({ booking, lifecycle }) => (
        <article key={booking.id} className={`is-${lifecycle}`}>
          <span className="booking-badge">{bookingBadgeFor(lifecycle)}</span>
          <div>
            <strong>{booking.eventName}</strong>
            <small>{dateRange(booking)} · {booking.city}</small>
          </div>
          {lifecycle === "completed_outcome_pending" && (
            <p>Still wanted: {booking.missingOutcomeInputs.join("; ") || "the trading outcome"}</p>
          )}
        </article>
      ))}
    </section>
  );
}

function BookingHorizon({
  booking,
  events,
  onOpen,
  catalogueMode,
  loadedAt,
  now
}: {
  booking: ClientBooking;
  events: EventOpportunity[];
  onOpen: (event: EventOpportunity) => void;
  catalogueMode: ProductSnapshot["mode"];
  loadedAt: string;
  now: Date;
}) {
  const weeks = groupByCalendarWeek(events, [booking]).slice(0, 8);
  const deadlines = events
    .filter((event) => event.application?.deadline && event.tier !== "REJECTED")
    .sort((a, b) => new Date(a.application!.deadline!).getTime() - new Date(b.application!.deadline!).getTime())
    .slice(0, 3);

  return (
    <section className="booking-horizon">
      <header className="booking-horizon-head">
        <div>
          <p className="overline">Eight-week operating view</p>
          <h2>Booking coverage</h2>
        </div>
        <span><i />{catalogueMode === "postgres" ? "Live catalogue" : "Local mode"} · {formatDate(loadedAt)}</span>
      </header>

      <article className="current-booking">
        <span className="operation-mark"><Store /></span>
        <div>
          <small>Current operation · {dateRange(booking)}</small>
          <strong>{booking.eventName}</strong>
          <p>{booking.standOrZone} · {booking.city}</p>
        </div>
        <span className="operation-duration"><strong>{inclusiveDays(booking)}</strong><small>trading days</small></span>
        {/* The badge is DERIVED, never the stored state: only a booking that
            still holds the truck reaches this hero at all. */}
        <span className="operation-state"><BadgeCheck /> {bookingBadgeFor(bookingLifecycleFor(booking, now))}</span>
      </article>

      <div className="coverage-weeks" aria-label="Eight-week booking coverage">
        {weeks.map((week) => {
          const first = week.events.find((item) => !["Closed", "Blocked"].includes(item.role));
          return (
            <article
              key={week.key}
              className={week.bookings.length ? "is-booked" : week.activeCount ? "has-options" : "is-gap"}
            >
              <header>
                <span>W{week.weekNumber}</span>
                <small>{shortDate.format(week.startsAt)}–{shortDate.format(week.endsAt)}</small>
              </header>
              {week.bookings.length ? (
                <div><BadgeCheck /><strong>Booked</strong><small>{week.bookings[0].eventName}</small></div>
              ) : first ? (
                <button onClick={() => onOpen(first.event)}>
                  <span>{first.role}</span>
                  <strong>{first.event.name}</strong>
                  <small>{week.activeCount} option{week.activeCount === 1 ? "" : "s"}</small>
                </button>
              ) : (
                <div><Search /><strong>Coverage gap</strong><small>Deepen discovery</small></div>
              )}
            </article>
          );
        })}
      </div>

      <div className="deadline-brief">
        <span className="deadline-brief-label"><Clock3 /><b>Nearest deadlines</b></span>
        {deadlines.map((event) => {
          const decision = applicationDecision(event);
          return (
            <button key={event.id} onClick={() => onOpen(event)}>
              <span><strong>{event.name}</strong><small>{formatDate(event.application!.deadline!)}</small></span>
              <b>{decision.label}</b>
              <ChevronRight />
            </button>
          );
        })}
      </div>
    </section>
  );
}

function EvidenceBars({ event }: { event: EventOpportunity }) {
  const level = event.verification === "verified" ? 4 : event.verification === "partial" ? 3 : 1;
  return <span className="evidence-bars" aria-label={`${event.verification} evidence`}>{[1, 2, 3, 4].map((bar) => <i key={bar} className={bar <= level ? "on" : ""} />)}</span>;
}

function DecisionRunway({
  events,
  tryList,
  onOpen,
  onToggle,
  onViewAll
}: {
  events: EventOpportunity[];
  tryList: Set<string>;
  onOpen: (event: EventOpportunity) => void;
  onToggle: (event: EventOpportunity) => void;
  onViewAll: () => void;
}) {
  return (
    <section className="decision-runway">
      <header>
        <div><p className="overline">Recommended next</p><h2>This week’s best moves</h2></div>
        <button onClick={onViewAll}>See all events <ArrowRight /></button>
      </header>
      <div className="runway-labels" aria-hidden="true"><span>Priority</span><span>Opportunity</span><span>Deadline</span><span>Evidence</span><span>Fit</span><span>Decision</span></div>
      <div className="runway-list">
        {events.slice(0, 4).map((event, index) => {
          const decision = applicationDecision(event);
          return (
            <article key={event.id} className={index === 0 ? "is-leading" : ""}>
              <span className="runway-node">{index + 1}</span>
              <button className="runway-open" onClick={() => onOpen(event)}>
                <span className="runway-event"><strong>{event.name}</strong><small>{event.city} · {dateRange(event)}</small></span>
                <span className={`runway-deadline is-${decision.urgency}`}><strong>{decision.label}</strong><small>{event.application?.deadline ? formatDate(event.application.deadline) : "Date not published"}</small></span>
                <span className="runway-evidence"><EvidenceBars event={event} /><small>{event.verification}</small></span>
                <span className="runway-fit"><strong>{event.score}</strong><i><b style={{ width: `${event.score}%` }} /></i></span>
                <span className="runway-decision"><strong>{decision.urgency === "act" ? "Verify place" : "Prepare"}</strong><small>{decision.nextAction}</small></span>
                <ChevronRight />
              </button>
              <button className={`star-action ${tryList.has(event.id) ? "active" : ""}`} onClick={() => onToggle(event)} aria-label={tryList.has(event.id) ? `Remove ${event.name} from shortlist` : `Add ${event.name} to shortlist`}>
                {tryList.has(event.id) ? <Check /> : <Target />}
              </button>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function sourceHealthLabel(source: RegisteredSource) {
  if (!source.lastCheckedAt) return "not checked";
  if (source.healthState === "healthy") return "reachable";
  if (source.healthState === "restricted") return "manual check";
  return "needs attention";
}

function AgentActivityRail({
  sources,
  discovery
}: {
  sources: RegisteredSource[];
  discovery: ProductSnapshot["discovery"];
}) {
  const sourceCount = sources.length;
  const checked = sources.filter((source) => source.lastCheckedAt).length;
  const healthy = sources.filter((source) => source.healthState === "healthy").length;
  const manual = sources.filter((source) => source.healthState === "restricted").length;
  const layers = [
    { icon: Search, title: "Source map", detail: `${sourceCount} researched sources`, state: "mapped", tone: "mint" },
    {
      icon: BadgeCheck,
      title: "Event normalization",
      detail: `${discovery.linked} linked · ${discovery.pending} pending`,
      state: discovery.pending ? "working" : "current",
      tone: discovery.pending ? "amber" : "mint"
    },
    { icon: Clock3, title: "Deadline intelligence", detail: "2027 windows surfaced", state: "ready", tone: "amber" },
    {
      icon: Radar,
      title: "Collector receipts",
      detail: checked ? `${checked}/${sourceCount} sources checked` : "Awaiting first collection",
      state: checked === sourceCount ? "checked" : "ready",
      tone: checked === sourceCount ? "mint" : "amber"
    }
  ];
  return (
    <section className="agent-rail">
      <header><div><p className="overline">PitchRadar activity</p><h2>Finding the next fit</h2></div><span className="agent-state"><i /> Working now</span></header>
      <div className="agent-core">
        <span className="agent-orbit"><Radar /></span>
        <div><strong>{discovery.rawOccurrences} source occurrences reviewed</strong><p>Events, organizers and application windows are linked without treating a public form as confirmed capacity.</p></div>
      </div>
      <div className="activity-stack">
        {layers.map((item) => {
          const Icon = item.icon;
          return <div key={item.title} className={`tone-${item.tone}`}><span><Icon /></span><p><strong>{item.title}</strong><small>{item.detail}</small></p><b>{item.state}</b></div>;
        })}
      </div>
      <div className="coverage-meter">
        <div><span>Source reachability</span><strong>{healthy} live · {manual} manual</strong></div>
        <i><b /></i>
        <p>Each source keeps a current receipt. More extraction adapters and consented private-demand coverage remain open.</p>
      </div>
    </section>
  );
}

function OwnerApproval({
  queue,
  onReview
}: {
  queue: AvailabilityVerificationRequest[];
  onReview: () => void;
}) {
  const queued = queue.filter((item) =>
    ["owner_review", "blocked_contact_missing"].includes(item.status)
  );
  const ready = queued.filter((item) => item.status === "owner_review").length;
  const blocked = queued.length - ready;
  return (
    <section className="approval-rail">
      <header><div><p className="overline">Availability queue</p><h2>{queued.length ? `${queued.length} events prepared` : "No drafts waiting"}</h2></div><ShieldCheck /></header>
      {queued.length ? (
        <>
          <div className="approval-summary">
            <span><strong>{ready}</strong> ready to review</span>
            <span><strong>{blocked}</strong> route to find</span>
          </div>
          <div className="approval-items">
            {queued.slice(0, 2).map((item) => (
              <article key={item.id}>
                <button onClick={onReview}>
                  <span><strong>{item.eventName}</strong><small>{item.weekKey} · {item.weeklyRole.replace("_", " ")} · {item.channel}</small></span>
                  <ChevronRight />
                </button>
              </article>
            ))}
          </div>
          <button className="approval-review-all" onClick={onReview}>Review every draft <ArrowRight /></button>
        </>
      ) : <p className="approval-empty">The verifier has not prepared any event-specific availability requests yet.</p>}
      <footer><span className="lock-dot" /><p>Owner approval records intent only. No message can be sent.</p></footer>
    </section>
  );
}

function CommandBriefing({
  priorities,
  queue,
  onOpen,
  onOpenQueue,
  onOpenAgent
}: {
  priorities: EventOpportunity[];
  queue: AvailabilityVerificationRequest[];
  onOpen: (event: EventOpportunity) => void;
  onOpenQueue: () => void;
  onOpenAgent: () => void;
}) {
  const reviewable = queue.filter((item) => item.status === "owner_review").length;
  const blocked = queue.filter((item) => item.status === "blocked_contact_missing").length;
  const next = priorities[0];
  return (
    <section className="command-briefing">
      <div>
        <p className="overline">{briefDateFormat.format(new Date())} · owner brief</p>
        <h2>{reviewable ? `${reviewable} decisions can protect the next free weeks.` : "The next free weeks are ready to plan."}</h2>
        <p>
          {blocked
            ? `${blocked} event still needs a verified route. No external action can happen without owner approval.`
            : "Every prepared action remains held until the owner approves it."}
        </p>
      </div>
      <div className="briefing-focus">
        <span>Highest-priority event</span>
        <strong>{next?.name ?? "No actionable event"}</strong>
        <small>{next ? `${next.city} · ${applicationDecision(next).label}` : "Continue source discovery"}</small>
        {next && <button onClick={() => onOpen(next)}>Open decision <ArrowRight /></button>}
      </div>
      <div className="briefing-actions">
        <button onClick={onOpenQueue}><ShieldCheck /><span><strong>Review {reviewable} drafts</strong><small>Owner-controlled</small></span></button>
        <button onClick={onOpenAgent}><Sparkles /><span><strong>Ask PitchRadar</strong><small>Research or decide</small></span></button>
      </div>
    </section>
  );
}

function WorkstreamStrip({
  sources,
  discovery,
  queue,
  bookings,
  weeks
}: {
  sources: RegisteredSource[];
  discovery: ProductSnapshot["discovery"];
  queue: AvailabilityVerificationRequest[];
  bookings: ClientBooking[];
  weeks: EventWeek[];
}) {
  const checked = sources.filter((source) => source.lastCheckedAt).length;
  const ready = queue.filter((item) => item.status === "owner_review").length;
  const blocked = queue.filter((item) => item.status === "blocked_contact_missing").length;
  const coveredWeeks = weeks.filter((week) => week.bookings.length || week.activeCount).length;
  const streams = [
    {
      icon: Search,
      label: "Scout",
      detail: `${checked}/${sources.length} sources checked`,
      state: checked === sources.length ? "Current" : "Working",
      progress: sources.length ? (checked / sources.length) * 100 : 0
    },
    {
      icon: BadgeCheck,
      label: "Verify",
      detail: `${discovery.linked} linked · ${discovery.pending} pending`,
      state: discovery.pending ? "Working" : "Current",
      progress: discovery.rawOccurrences ? (discovery.linked / discovery.rawOccurrences) * 100 : 0
    },
    {
      icon: FileCheck2,
      label: "Applications",
      detail: `${ready} ready · ${blocked} blocked`,
      state: ready ? "Needs owner" : "Held",
      progress: queue.length ? (ready / queue.length) * 100 : 0
    },
    {
      icon: CalendarDays,
      label: "Schedule",
      detail: `${coveredWeeks} weeks covered · ${bookings.length} booking`,
      state: bookings.length ? "Protected" : "Open",
      progress: weeks.length ? (coveredWeeks / weeks.length) * 100 : 0
    }
  ];
  return (
    <section className="workstream-strip" aria-label="PitchRadar workstreams">
      {streams.map((stream) => {
        const Icon = stream.icon;
        return (
          <article key={stream.label}>
            <span><Icon /></span>
            <div><strong>{stream.label}</strong><small>{stream.detail}</small><i><b style={{ width: `${Math.min(100, stream.progress)}%` }} /></i></div>
            <em>{stream.state}</em>
          </article>
        );
      })}
    </section>
  );
}

function MobileMission({
  booking,
  now,
  events,
  onOpen,
  onToggle,
  tryList,
  sources,
  discovery
}: {
  /** Only a booking that still HOLDS the truck. Undefined when none does. */
  booking?: ClientBooking;
  now: Date;
  events: EventOpportunity[];
  onOpen: (event: EventOpportunity) => void;
  onToggle: (event: EventOpportunity) => void;
  tryList: Set<string>;
  sources: RegisteredSource[];
  discovery: ProductSnapshot["discovery"];
}) {
  const top = events[0];
  const deadlines = events.filter((event) => event.application?.deadline).slice(0, 3);
  const checked = sources.filter((source) => source.lastCheckedAt).length;
  return (
    <div className="mobile-mission">
      <header className="mobile-section-title"><div><p>Mission control</p><h2>Your next good booking</h2></div><span>Plan. Verify. Decide.</span></header>
      <section className="mobile-horizon">
        <div className="mobile-scan" />
        <div className="mobile-week"><span>{currentWeekChip().month}</span><strong>{currentWeekChip().range}</strong></div>
        {booking
          ? <div className="mobile-live"><i /><p><small>{bookingBadgeFor(bookingLifecycleFor(booking, now))}</small><strong>{booking.eventName}</strong><span>{booking.city} · through {shortDate.format(new Date(booking.endsAt))}</span></p></div>
          : <div className="mobile-live is-free"><i /><p><small>No booking holds the truck</small><strong>The week is open</strong><span>Every date below is available to pursue</span></p></div>}
        {deadlines.map((event) => {
          const decision = applicationDecision(event);
          const deadline = event.application?.deadline;
          return <button key={event.id} onClick={() => onOpen(event)}><span>{deadline ? monthChipFormat.format(new Date(deadline)).toUpperCase() : "NEXT"}</span><i /><p><small>Application deadline</small><strong>{event.name}</strong><b>{decision.label}</b></p></button>;
        })}
      </section>
      {top && <section className="mobile-next">
        <header><span>Next decision</span><button onClick={() => onToggle(top)}>{tryList.has(top.id) ? <Check /> : <Target />}</button></header>
        <div>
          <span className="mobile-event-mark"><Store /></span>
          <p>
            <strong>{top.name}</strong>
            <span className="mobile-event-meta"><CalendarDays /> {dateRange(top)} <i /> <MapPin /> {top.city}</span>
            <b>{applicationDecision(top).label}</b>
            <small>Evidence confidence <EvidenceBars event={top} /></small>
          </p>
        </div>
        <button className="mobile-review" onClick={() => onOpen(top)}>Review application <ArrowRight /></button>
      </section>}
      <details className="mobile-agent">
        <summary><span><i /><Radar /> Scout research state</span><b>{checked === sources.length ? "Checked" : "Ready"} <ChevronDown /></b></summary>
        <p>{checked}/{sources.length} sources have durable receipts. {discovery.linked} occurrences are linked to decisions and {discovery.pending} await normalization.</p>
      </details>
    </div>
  );
}

function HorizonView({
  ranked,
  bookings,
  briefing,
  now,
  sources,
  discovery,
  catalogueMode,
  loadedAt,
  verificationQueue,
  tryList,
  onOpen,
  onOpenQueue,
  onOpenAgent,
  onToggle,
  onViewAll
}: {
  ranked: EventOpportunity[];
  bookings: ClientBooking[];
  briefing?: BriefingView;
  now: Date;
  sources: RegisteredSource[];
  discovery: ProductSnapshot["discovery"];
  catalogueMode: ProductSnapshot["mode"];
  loadedAt: string;
  verificationQueue: AvailabilityVerificationRequest[];
  tryList: Set<string>;
  onOpen: (event: EventOpportunity) => void;
  onOpenQueue: () => void;
  onOpenAgent: () => void;
  onToggle: (event: EventOpportunity) => void;
  onViewAll: () => void;
}) {
  // ONE derivation of what a booking is, shared with the weekly brief. Only a
  // booking that still holds the truck may block a week, filter a prospect out,
  // or occupy the current-operation hero.
  const holding = bookings.filter((item) => bookingHoldsTruck(item, now));
  const priorities = priorityEvents(ranked, holding);
  const booking = holding[0];
  const weeks = groupByCalendarWeek(ranked, holding).slice(0, 12);
  return (
    <>
      <div className="desktop-mission">
        {briefing && <KpiRow briefing={briefing} />}
        <CommandBriefing priorities={priorities} queue={verificationQueue} onOpen={onOpen} onOpenQueue={onOpenQueue} onOpenAgent={onOpenAgent} />
        <div className="mission-grid">
          <div className="mission-primary">
            {booking
              ? <BookingHorizon booking={booking} events={ranked} onOpen={onOpen} catalogueMode={catalogueMode} loadedAt={loadedAt} now={now} />
              : <section className="catalogue-notice"><CircleAlert /><div><h2>No booking currently holds the truck</h2><p>Every week below is open. A completed booking is listed under Bookings, not here.</p></div></section>}
            <DecisionRunway events={priorities} tryList={tryList} onOpen={onOpen} onToggle={onToggle} onViewAll={onViewAll} />
            <BookingHistory bookings={bookings} now={now} />
          </div>
          <aside className="mission-side">
            {briefing && <DeadlineRadarBlock items={briefing.deadlineRadar} />}
            <OwnerApproval queue={verificationQueue} onReview={onOpenQueue} />
            <AgentActivityRail sources={sources} discovery={discovery} />
          </aside>
        </div>
        <WorkstreamStrip sources={sources} discovery={discovery} queue={verificationQueue} bookings={holding} weeks={weeks} />
      </div>
      <MobileMission booking={booking} now={now} events={priorities} onOpen={onOpen} onToggle={onToggle} tryList={tryList} sources={sources} discovery={discovery} />
    </>
  );
}

function DecisionsView({
  events,
  bookings,
  now,
  tryList,
  onOpen,
  onToggle
}: {
  events: EventOpportunity[];
  bookings: ClientBooking[];
  now: Date;
  tryList: Set<string>;
  onOpen: (event: EventOpportunity) => void;
  onToggle: (event: EventOpportunity) => void;
}) {
  // Same shared derivation as the command centre: a completed booking blocks
  // nothing, so it neither fills a week chip nor hides a prospect.
  const holding = bookings.filter((booking) => bookingHoldsTruck(booking, now));
  const priorities = priorityEvents(events, holding);
  const weeks = groupByCalendarWeek(events, holding);
  const visibleWeeks = weeks.slice(0, 12);
  return (
    <section className="product-page plan-page">
      <header className="page-intro">
        <div><p className="overline">Portfolio planning</p><h2>12-week booking plan</h2><p>Apply wide, keep credible backups and commit only after an organizer confirms the place.</p></div>
        <div className="page-facts">
          <span><strong>{priorities.length}</strong><small>open prospects</small></span>
          <span><strong>{weeks.filter((week) => week.activeCount > 0).length}</strong><small>weeks with options</small></span>
          <span><strong>{holding.length}</strong><small>booking{holding.length === 1 ? "" : "s"} holding the truck</small></span>
        </div>
      </header>
      <section className="booking-atlas">
        <header>
          <div><p className="overline">Calendar portfolio</p><h3>Every week, every credible route</h3></div>
          <div className="atlas-legend"><span className="confirmed">Confirmed</span><span className="primary">Primary</span><span className="backup">Backup</span><span className="verify">Verify first</span></div>
        </header>
        <div className="atlas-scroll">
          <div className="atlas-grid">
            {visibleWeeks.map((week) => (
              <article key={week.key} className={week.bookings.length ? "is-booked" : week.activeCount ? "has-options" : "is-gap"}>
                <header><span>W{week.weekNumber}</span><small>{shortDate.format(week.startsAt)}–{shortDate.format(week.endsAt)}</small></header>
                {week.bookings.map((item) => <div className="atlas-booking" key={item.id}><BadgeCheck /><strong>{item.eventName}</strong><small>Confirmed · {item.city}</small></div>)}
                {week.events.slice(0, 3).map((item) => (
                  <button
                    key={item.event.id}
                    className={`atlas-event is-${item.role.toLowerCase().replaceAll(" ", "-")}`}
                    onClick={() => onOpen(item.event)}
                  >
                    <span>{item.role}</span>
                    <strong>{item.event.name}</strong>
                    <small>{item.event.city} · {item.tradingDays} day{item.tradingDays === 1 ? "" : "s"}</small>
                  </button>
                ))}
                {!week.bookings.length && !week.events.length && <div className="atlas-gap"><Search /><strong>Coverage gap</strong><small>Keep scouting</small></div>}
                <footer><span>{week.activeCount} actionable</span><small>{week.recommendation}</small></footer>
              </article>
            ))}
          </div>
        </div>
      </section>
      <DecisionRunway events={priorities} tryList={tryList} onOpen={onOpen} onToggle={onToggle} onViewAll={() => undefined} />
    </section>
  );
}

function EvidenceView({
  events,
  briefing,
  filter,
  setFilter,
  onOpen
}: {
  events: EventOpportunity[];
  briefing?: BriefingView;
  filter: Filter;
  setFilter: (filter: Filter) => void;
  onOpen: (event: EventOpportunity) => void;
}) {
  const filtered = filter === "all" ? events : events.filter((event) => event.tier === filter);
  const verified = events.filter((event) => event.verification === "verified").length;
  const routeKnown = events.filter((event) => applicationIntelligenceFor(event).route !== "unknown").length;
  return (
    <section className="product-page events-page">
      <header className="page-intro event-intro">
        <div><p className="overline">Event intelligence</p><h2>Opportunities with their proof attached</h2><p>Compare the opportunity, application route, evidence and next action without crossing between separate dashboards.</p></div>
        <div className="page-facts">
          <span><strong>{events.length}</strong><small>known events</small></span>
          <span><strong>{verified}</strong><small>verified</small></span>
          <span><strong>{routeKnown}</strong><small>routes identified</small></span>
        </div>
      </header>
      {briefing && briefing.pipelineCounts.length > 0 && (
        <div className="pipeline-strip" aria-label="Pipeline">
          <span className="pipeline-strip-label">Pipeline</span>
          {briefing.pipelineCounts.map((row) => (
            <span key={row.label} className="pipeline-chip"><strong>{row.count}</strong> {row.label}</span>
          ))}
        </div>
      )}
      <div className="event-toolbar">
        <div><Search /><span>Filter by decision tier</span></div>
        <div className="filter-cluster">{(["all", "A", "B", "C", "REJECTED"] as Filter[]).map((item) => <button key={item} className={filter === item ? "active" : ""} onClick={() => setFilter(item)}>{item === "all" ? "All" : item === "REJECTED" ? "Closed" : item}</button>)}</div>
      </div>
      <div className="evidence-ledger">
        <div className="evidence-ledger-labels"><span>Event</span><span>Application status</span><span>Organizer route</span><span>Evidence</span><span>Fit</span></div>
        {filtered.map((event) => {
          const decision = applicationDecision(event);
          const intel = applicationIntelligenceFor(event);
          return <button key={event.id} className={event.tier === "REJECTED" ? "rejected" : ""} onClick={() => onOpen(event)}><span><strong>{event.name}</strong><small><MapPin />{event.city} · {dateRange(event)}</small></span><span><b className={`state-text is-${decision.urgency}`}>{decision.label}</b><small>{decision.nextAction}</small></span><span><strong>{intel.routeOwner ?? "Unresolved"}</strong><small>{intel.route.replaceAll("_", " ")}</small></span><span><EvidenceBars event={event} /><small>{event.sources.length} sources · {event.missingFields.length} gaps</small></span><span className="ledger-score"><strong>{event.tier === "REJECTED" ? "—" : event.score}</strong><small>{event.tier}</small></span><ChevronRight /></button>;
        })}
      </div>
    </section>
  );
}

function ApplicationsView({
  requests,
  onOpenRequest
}: {
  requests: AvailabilityVerificationRequest[];
  onOpenRequest: (requestId?: string) => void;
}) {
  const ready = requests.filter((item) => item.status === "owner_review");
  const blocked = requests.filter((item) => item.status === "blocked_contact_missing");
  const held = requests.filter((item) => item.status === "approved_waiting_connector");
  return (
    <section className="product-page applications-page">
      <header className="page-intro">
        <div><p className="overline">Application operations</p><h2>Move from verified route to owner decision</h2><p>Every draft keeps its event, recipient, evidence and approval state together. Approval still sends nothing.</p></div>
        <button className="primary-page-action" onClick={() => onOpenRequest()}><ShieldCheck /> Review owner queue <ArrowRight /></button>
      </header>

      <section className="application-statebar" aria-label="Application queue status">
        <article><span>01</span><div><strong>{ready.length} ready for review</strong><small>Verified route and prepared draft</small></div></article>
        <article><span>02</span><div><strong>{blocked.length} research blocker</strong><small>Recipient or route still missing</small></div></article>
        <article><span>03</span><div><strong>{held.length} approved and held</strong><small>No delivery connector enabled</small></div></article>
      </section>

      <section className="application-ledger">
        <header><div><p className="overline">Prepared outreach</p><h3>Availability verification queue</h3></div><span>{requests.length} event-specific requests</span></header>
        <div className="application-ledger-labels"><span>Priority</span><span>Event and week</span><span>Route</span><span>State</span><span>Owner action</span></div>
        {requests.map((request) => (
          <button key={request.id} onClick={() => onOpenRequest(request.id)}>
            <span className={`application-role is-${request.weeklyRole}`}>{request.weeklyRole.replace("_", " ")}</span>
            <span><strong>{request.eventName}</strong><small>{request.weekKey} · {request.city} · {dateRange(request)}</small></span>
            <span><strong>{request.recipientName || request.recipientEmail || request.channel}</strong><small>{request.routeVerified ? "Verified public route" : "Route unresolved"}</small></span>
            <span className={`application-status is-${request.status}`}>
              <strong>{request.status === "owner_review" ? "Ready to review" : request.status === "blocked_contact_missing" ? "Research required" : request.status.replaceAll("_", " ")}</strong>
              <small>{request.channel}</small>
            </span>
            <span><b>{request.status === "owner_review" ? "Review draft" : request.status === "blocked_contact_missing" ? "Inspect blocker" : "View receipt"}</b><ChevronRight /></span>
          </button>
        ))}
      </section>
    </section>
  );
}

function OrganizersView({
  events,
  briefing,
  onOpen
}: {
  events: EventOpportunity[];
  briefing?: BriefingView;
  onOpen: (event: EventOpportunity) => void;
}) {
  const organizerMap = new Map<string, EventOpportunity[]>();
  events.forEach((event) => {
    // The SAME identity rule the report groups tasks by: the recorded organizer
    // first. Keying this map differently is how the next action for an
    // organizer would fail to find the organizer it belongs to.
    const organizer = event.organizer || applicationIntelligenceFor(event).routeOwner;
    if (!organizer) return;
    organizerMap.set(organizer, [...(organizerMap.get(organizer) || []), event]);
  });
  const briefed = new Map((briefing?.organizers ?? []).map((row) => [row.name, row]));
  const organizers = [...organizerMap.entries()]
    .map(([name, organizerEvents]) => ({
      name,
      events: organizerEvents.sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime()),
      verified: organizerEvents.filter((event) => event.verification === "verified").length,
      contacts: new Set(organizerEvents.flatMap((event) => [event.contactEmail, event.contactPhone].filter(Boolean))).size
    }))
    .sort((a, b) => b.events.length - a.events.length);

  return (
    <section className="product-page organizers-page">
      <header className="page-intro">
        <div><p className="overline">Relationship intelligence</p><h2>One organizer can unlock several trading weeks</h2><p>PitchRadar keeps reusable contacts, application routes and recurring events together without guessing private contact data.</p></div>
        <div className="page-facts">
          <span><strong>{organizers.length}</strong><small>named organizers</small></span>
          <span><strong>{organizers.filter((item) => item.contacts > 0).length}</strong><small>with public contact</small></span>
          <span><strong>{organizers.reduce((total, item) => total + item.events.length, 0)}</strong><small>linked events</small></span>
        </div>
      </header>

      <div className="organizer-workspace">
        <section className="organizer-ledger">
          <header><span>Organizer</span><span>Upcoming series</span><span>Resolved contact</span><span>Open questions</span><span>Next action</span><span>Next event</span></header>
          {organizers.map((organizer) => {
            const next = organizer.events[0];
            // Contact, open questions and the next action are the report's own
            // derivations, read off the briefing — the page does not resolve a
            // contact of its own beside the one the brief would print.
            const brief = briefed.get(organizer.name);
            const contact = brief?.contactPerson || brief?.contactEmail || brief?.contactPhone;
            return (
              <button key={organizer.name} onClick={() => next && onOpen(next)}>
                <span className="organizer-name"><i><Building2 /></i><strong>{organizer.name}</strong><small>{organizer.contacts ? `${organizer.contacts} public contact route${organizer.contacts === 1 ? "" : "s"}` : "Contact not resolved"}</small></span>
                <span><strong>{organizer.events.length} event{organizer.events.length === 1 ? "" : "s"}</strong><small>{organizer.events.slice(0, 2).map((event) => event.city).join(" · ")}</small></span>
                <span className="organizer-contact"><strong>{contact ?? "Not resolved"}</strong><small>{brief?.contactStatus ?? "No route recorded"}</small></span>
                <span className="organizer-questions"><strong>{brief?.openQuestions ?? 0}</strong><small>unconfirmed capacity or fee</small></span>
                <span className="organizer-next-action"><strong>{brief?.nextAction ?? "—"}</strong><small>{organizer.verified ? `${organizer.verified} verified` : "Partial evidence"}</small></span>
                <span><strong>{next?.name}</strong><small>{next ? dateRange(next) : "No future event"}</small></span>
                <ChevronRight />
              </button>
            );
          })}
        </section>
        <aside className="relationship-brief">
          <p className="overline">Operating principle</p>
          <h3>Build the relationship once. Reuse the evidence carefully.</h3>
          <p>A general organizer form proves a route exists. It never proves that a speciality pitch remains for a specific event.</p>
          <div><span><BadgeCheck /></span><p><strong>Verified route</strong><small>Public business contact or application path</small></p></div>
          <div><span><Clock3 /></span><p><strong>Next-cycle memory</strong><small>Opening clues and deadlines stay attached</small></p></div>
          <div><span><LockKeyhole /></span><p><strong>Owner control</strong><small>No message or submission without approval</small></p></div>
        </aside>
      </div>
    </section>
  );
}

function CoverageView({ sourceRegistry }: { sourceRegistry: RegisteredSource[] }) {
  const layers = (Object.keys(sourceLayerLabels) as SourceLayer[]).map((layer) => ({
    layer,
    label: sourceLayerLabels[layer],
    sources: sourceRegistry.filter((source) => source.layer === layer)
  }));
  const checked = sourceRegistry.filter((source) => source.lastCheckedAt).length;
  const healthy = sourceRegistry.filter((source) => source.healthState === "healthy").length;
  const restricted = sourceRegistry.filter((source) => source.healthState === "restricted").length;
  return (
    <section className="product-page sources-page">
      <header className="page-intro">
        <div><p className="overline">Discovery operations</p><h2>Coverage you can measure and challenge</h2><p>Sources are grouped by the commercial question they answer—not displayed as a technical architecture diagram.</p></div>
        <div className="page-facts">
          <span><strong>{checked}/{sourceRegistry.length}</strong><small>checked</small></span>
          <span><strong>{healthy}</strong><small>reachable</small></span>
          <span><strong>{restricted}</strong><small>manual route</small></span>
        </div>
      </header>

      <div className="source-truth"><CircleAlert /><p><strong>National completeness is not claimed.</strong><span>The source census is monitored; additional extraction adapters and private-demand coverage remain open work.</span></p></div>

      <div className="source-operations">
        {layers.map(({ layer, label, sources }, index) => (
          <article key={layer} className={sources.length ? "" : "gap"}>
            <header>
              <span>0{index + 1}</span>
              <div><small>{sources.length ? `${sources.length} sources mapped` : "Known blind spot"}</small><h3>{label}</h3></div>
              <b>{sources.filter((source) => source.healthState === "healthy").length}/{sources.length || "—"} live</b>
            </header>
            <p>{sources.length ? sources[0].businessValue : "A consented marketplace or relationship feed is required for corporate and private demand."}</p>
            <div className="source-list">
              {sources.map((source) => (
                <a key={source.id} href={source.baseUrl} target="_blank" rel="noreferrer">
                  <span className={`source-health is-${source.healthState || "unchecked"}`}><i /></span>
                  <span><strong>{source.name}</strong><small>{sourceHealthLabel(source)} · {source.cadence}</small></span>
                  <ExternalLink />
                </a>
              ))}
              {!sources.length && <div className="source-gap"><Search /><span><strong>Coverage gap</strong><small>No reliable source family connected yet</small></span></div>}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function ProfileView({
  clientProfile,
  missingProfileInputs,
  onOpenAgent
}: {
  clientProfile: ClientProfile;
  missingProfileInputs: string[];
  onOpenAgent: () => void;
}) {
  return (
    <section className="product-page business-page">
      <header className="page-intro business-intro">
        <div><p className="overline">Business readiness</p><h2>Complete the facts behind every recommendation</h2><p>Known constraints drive decisions. Missing economics remain visible and block fabricated revenue projections.</p></div>
        <button className="primary-page-action" onClick={onOpenAgent}><Sparkles /> Complete with PitchRadar <ArrowRight /></button>
      </header>
      <section className="business-readiness">
        <div><span><Store /></span><p><strong>{clientProfile.menu.length} menu lines recorded</strong><small>{clientProfile.menu.filter((item) => item.confirmationRequired).length} labels still require confirmation</small></p></div>
        <div><span><CircleAlert /></span><p><strong>{missingProfileInputs.length} operating inputs outstanding</strong><small>Routing and economics remain deliberately unavailable</small></p></div>
        <div><span><ShieldCheck /></span><p><strong>Truth guard active</strong><small>No invented profit, distance or capacity</small></p></div>
      </section>
      <div className="profile-workbench">
        <section className="menu-module"><header><Store /><div><small>Client offer</small><h3>Speciality menu</h3></div></header>{clientProfile.menu.map((item) => <div key={item.name}><span>{item.name}{item.confirmationRequired && <small>confirm</small>}</span><strong>{item.priceEur.toFixed(2).replace(".", ",")} €</strong></div>)}</section>
        <section className="rules-module"><header><Gauge /><div><small>Ranking guardrails</small><h3>Operating rules</h3></div></header><dl><div><dt>Base</dt><dd>Brandenburg</dd></div><div><dt>Days</dt><dd>Fri–Sun</dd></div><div><dt>Optional</dt><dd>Thursday</dd></div><div><dt>Preferred travel</dt><dd>≤ 8 hours</dd></div><div><dt>Exceptional</dt><dd>≤ 10 hours</dd></div></dl></section>
        <section className="missing-module"><header><CircleAlert /><div><small>Commercial blockers</small><h3>Required next</h3></div></header><ul>{missingProfileInputs.map((item) => <li key={item}><span />{item}</li>)}</ul></section>
      </div>
    </section>
  );
}

/**
 * The Business page holds two surfaces: the client intake (what the owner
 * fills in) and the readiness overview (what PitchRadar already knows). The
 * intake opens first because it is the one that still needs the client.
 */
/* ===================================================================
   THE REPORTS LIBRARY
   =================================================================== */

interface ReportFileEntry {
  kind: "brief" | "register" | "pdf" | "manifest";
  name: string;
  bytes: number;
  modifiedAt: string;
}

interface ReportSet {
  isoWeek: string;
  files: ReportFileEntry[];
  manifest: {
    isoWeek: string;
    generatedAt: string;
    now: string;
    mode: string;
    snapshotCounts: { events: number; sources: number };
    gitSha: string;
  } | null;
}

function fileSize(bytes: number) {
  return bytes >= 1_048_576
    ? `${(bytes / 1_048_576).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function reportStamp(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? "not recorded"
    : `${formatDate(value)}, ${parsed.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
}

/**
 * THE GENERATED ARTIFACTS, AS THEY ARE ON DISK.
 *
 * This page states what exists, not what should exist: a week that was written
 * without the PDF shows an em-dash where the download would be. There is no
 * button here that leads to a 404.
 */
function ReportsView() {
  const [sets, setSets] = useState<ReportSet[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    authFetch("/api/reports", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`The reports library returned ${response.status}.`);
        return response.json() as Promise<{ reports: ReportSet[] }>;
      })
      .then((payload) => setSets(payload.reports || []))
      .catch((cause) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => controller.abort();
  }, []);

  const rows = sets || [];
  const withPdf = rows.filter((set) => set.files.some((file) => file.kind === "pdf")).length;

  function fileOf(set: ReportSet, kind: ReportFileEntry["kind"]) {
    return set.files.find((file) => file.kind === kind);
  }

  function action(set: ReportSet, kind: ReportFileEntry["kind"], label: string) {
    const file = fileOf(set, kind);
    if (!file) return <span key={kind} className="report-missing" title={`No ${label.toLowerCase()} in this set`}>—</span>;
    return (
      <a
        key={kind}
        href={`/api/reports/${encodeURIComponent(set.isoWeek)}/${encodeURIComponent(file.name)}`}
        target={kind === "brief" ? "_blank" : undefined}
        rel={kind === "brief" ? "noreferrer" : undefined}
      >
        {label} <small>{fileSize(file.bytes)}</small>
      </a>
    );
  }

  return (
    <section className="product-page reports-page">
      <header className="page-intro">
        <div>
          <p className="overline">Generated artifacts</p>
          <h2>Every weekly report this machine has written</h2>
          <p>The brief, the operational register and the printed snapshot, exactly as the generator left them on disk. Nothing is rendered on request: what is listed here is what exists.</p>
        </div>
        <div className="page-facts">
          <span><strong>{rows.length}</strong><small>report sets</small></span>
          <span><strong>{withPdf}</strong><small>with a printed PDF</small></span>
        </div>
      </header>

      <section className="application-ledger">
        <header>
          <div><p className="overline">Reports library</p><h3>Weekly artifacts on disk</h3></div>
          <span>{rows.length} week{rows.length === 1 ? "" : "s"}</span>
        </header>
        <div className="application-ledger-labels">
          <span>Week</span><span>Generated</span><span>Snapshot origin</span><span>Commit</span><span>Files</span>
        </div>
        {error && <p className="report-note" role="alert">{error}</p>}
        {!error && sets === null && <p className="report-note">Reading the reports directory…</p>}
        {!error && sets !== null && rows.length === 0 && (
          <p className="report-note">No report has been generated yet. Run <code>npm run report -- --now=&lt;ISO&gt; --pdf</code> and this list fills itself.</p>
        )}
        {rows.map((set) => {
          const manifest = set.manifest;
          const newest = set.files
            .map((file) => file.modifiedAt)
            .sort()
            .at(-1);
          return (
            <div className="ledger-row" key={set.isoWeek}>
              <span><strong>{set.isoWeek}</strong></span>
              <span>
                {/* Two different clocks: the report's own `--now`, and when the
                    files were actually written. Printing the first twice would
                    have looked like corroboration and carried nothing. */}
                <strong>{manifest ? reportStamp(manifest.now) : newest ? reportStamp(newest) : "not recorded"}</strong>
                <small>{newest ? `written ${reportStamp(newest)}` : "no file timestamp"}</small>
              </span>
              <span>
                <strong>{manifest ? manifest.mode : "unknown"}</strong>
                <small>{manifest ? `${manifest.snapshotCounts.events} events · ${manifest.snapshotCounts.sources} sources` : "counts not recorded"}</small>
              </span>
              <span><strong>{manifest ? manifest.gitSha : "—"}</strong></span>
              <span className="report-actions">
                {action(set, "brief", "Open brief")}
                {action(set, "pdf", "PDF")}
                {action(set, "register", "XLSX")}
              </span>
            </div>
          );
        })}
      </section>
    </section>
  );
}

function BusinessPage({
  clientProfile,
  missingProfileInputs,
  onOpenAgent
}: {
  clientProfile: ClientProfile;
  missingProfileInputs: string[];
  onOpenAgent: () => void;
}) {
  const [businessTab, setBusinessTab] = useState<"intake" | "overview">("intake");
  return (
    <>
      <nav className="business-switch" aria-label="Business views">
        <button
          className={businessTab === "intake" ? "is-active" : ""}
          aria-current={businessTab === "intake" ? "page" : undefined}
          onClick={() => setBusinessTab("intake")}
        >Client intake</button>
        <button
          className={businessTab === "overview" ? "is-active" : ""}
          aria-current={businessTab === "overview" ? "page" : undefined}
          onClick={() => setBusinessTab("overview")}
        >Readiness overview</button>
      </nav>
      {businessTab === "intake"
        ? <ClientIntake />
        : <ProfileView
            clientProfile={clientProfile}
            missingProfileInputs={missingProfileInputs}
            onOpenAgent={onOpenAgent}
          />}
    </>
  );
}

function DetailDrawer({ event, onClose }: { event: EventOpportunity; onClose: () => void }) {
  const decision = applicationDecision(event);
  const intel = applicationIntelligenceFor(event);
  const routeScope = intel.routeScope === "event_specific"
    ? "Event-specific"
    : intel.routeScope === "organizer_general"
      ? "Organizer-wide"
      : intel.routeScope === "portal_general"
        ? "Trader portal"
        : "Not classified";
  return (
    <div className="detail-backdrop" onMouseDown={onClose}>
      <aside className="detail-drawer" role="dialog" aria-modal="true" aria-labelledby="detail-title" onMouseDown={(e) => e.stopPropagation()}>
        <header>
          <div><p className="overline">Event dossier</p><h2 id="detail-title">{event.name}</h2><span><MapPin />{event.city}, {event.state} · {dateRange(event)}</span></div>
          <div className="detail-head-score"><small>Opportunity fit</small><strong>{event.tier === "REJECTED" ? "—" : event.score}</strong><span>{event.tier}</span></div>
          <button onClick={onClose} aria-label="Close"><X /></button>
        </header>
        <div className="detail-scroll">
          <section className={`detail-decision is-${decision.urgency}`}><Clock3 /><div><small>Application intelligence</small><strong>{decision.label}</strong><p>{decision.nextAction}</p></div></section>
          <section className="detail-instruments"><div><small>Capacity</small><strong>{intel.capacityState.replaceAll("_", " ")}</strong></div><div><small>Route</small><strong>{intel.route.replaceAll("_", " ")}</strong></div><div><small>Route scope</small><strong>{routeScope}</strong></div><div><small>Recheck</small><strong>{formatCheckDate(intel.nextCheckAt)}</strong></div><div><small>Last checked</small><strong>{formatCheckDate(intel.lastCheckedAt)}</strong></div></section>
          <section className="detail-copy"><h3>What the evidence says</h3><p>{intel.note}</p></section>
          {(event.contactEmail || event.contactPhone) && <section className="detail-contact">
            <div><p className="overline">Verified organizer contact</p><h3>{intel.routeOwner ?? event.organizer ?? "Organizer"}</h3><small>Use this route to ask about speciality category capacity for this exact event.</small></div>
            <nav>
              {event.contactEmail && <a href={`mailto:${event.contactEmail}`}><Mail />{event.contactEmail}</a>}
              {event.contactPhone && <a href={`tel:${event.contactPhone.replace(/\s+/g, "")}`}><Phone />{event.contactPhone}</a>}
            </nav>
          </section>}
          {intel.requirements && intel.requirements.length > 0 && <section className="detail-requirements">
            <div><p className="overline">Application pack</p><h3>Prepare before contact</h3></div>
            <ul>{intel.requirements.map((requirement) => <li key={requirement}><Check />{requirement}</li>)}</ul>
          </section>}
          {event.rejectionReason && <section className="detail-blocked"><CircleAlert /><div><strong>Do not pursue this cycle</strong><p>{event.rejectionReason}</p></div></section>}
          <section className="detail-two"><div><h3>Why it may fit</h3><ul>{event.fitSignals.map((signal) => <li key={signal}><Check />{signal}</li>)}</ul></div><div><h3>Risks and unknowns</h3><ul>{event.riskSignals.map((signal) => <li key={signal}><CircleAlert />{signal}</li>)}</ul></div></section>
          <section className="detail-sources"><h3>Evidence trail</h3>{event.sources.map((source) => <a key={source.url} href={source.url} target="_blank" rel="noreferrer"><span><strong>{source.label}</strong><small>{source.publisher} · checked {formatDate(source.observedAt)}</small></span><ExternalLink /></a>)}</section>
          <section className="detail-gaps"><h3>Close before effort</h3>{event.missingFields.map((field) => <span key={field}><i />{field}</span>)}</section>
        </div>
        <footer>{event.applicationUrl && event.tier !== "REJECTED" ? <a href={event.applicationUrl} target="_blank" rel="noreferrer">Open official route <ExternalLink /></a> : <button disabled>{event.tier === "REJECTED" ? "Closed this cycle" : "Route not verified"}</button>}<p>External actions remain locked until owner approval.</p></footer>
      </aside>
    </div>
  );
}

function OutreachQueuePanel({
  requests,
  initialSelectedId,
  onClose,
  onDecision
}: {
  requests: AvailabilityVerificationRequest[];
  initialSelectedId?: string;
  onClose: () => void;
  onDecision: (request: AvailabilityVerificationRequest, decision: "approve" | "cancel") => Promise<void>;
}) {
  const [selectedId, setSelectedId] = useState(initialSelectedId || requests[0]?.id || "");
  const [language, setLanguage] = useState<"de" | "en">("de");
  const [busy, setBusy] = useState(false);
  const selected = requests.find((item) => item.id === selectedId) || requests[0];

  async function decide(decision: "approve" | "cancel") {
    if (!selected || busy) return;
    setBusy(true);
    try {
      await onDecision(selected, decision);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button className="panel-backdrop" onClick={onClose} aria-label="Close availability queue" />
      <aside className="outreach-panel" role="dialog" aria-modal="true" aria-labelledby="outreach-title">
        <header>
          <div><p className="overline">Application command</p><h2 id="outreach-title">Owner review queue</h2><span>{requests.length} events across the first free weeks · nothing sends automatically</span></div>
          <button onClick={onClose} aria-label="Close availability queue"><X /></button>
        </header>
        {selected ? (
          <div className="outreach-workspace">
            <nav aria-label="Prepared event requests">
              {requests.map((item) => (
                <button
                  key={item.id}
                  className={item.id === selected.id ? "active" : ""}
                  onClick={() => setSelectedId(item.id)}
                >
                  <span className={`queue-role is-${item.weeklyRole}`}>{item.weeklyRole.replace("_", " ")}</span>
                  <strong>{item.eventName}</strong>
                  <small>{item.weekKey} · {dateRange(item)} · {item.city}</small>
                  <i className={`queue-state is-${item.status}`}>
                    {item.status === "blocked_contact_missing" ? "Route missing" : item.status === "approved_waiting_connector" ? "Approved · held" : `${item.channel} ready`}
                  </i>
                </button>
              ))}
            </nav>
            <section className="outreach-review">
              <header>
                <div>
                  <p className="overline">{selected.weekKey} · {selected.weeklyRole.replace("_", " ")}</p>
                  <h3>{selected.eventName}</h3>
                  <span>{selected.city} · {dateRange(selected)}</span>
                </div>
                <div className="language-switch" aria-label="Draft language">
                  <button className={language === "de" ? "active" : ""} onClick={() => setLanguage("de")}>DE</button>
                  <button className={language === "en" ? "active" : ""} onClick={() => setLanguage("en")}>EN</button>
                </div>
              </header>
              <div className="outreach-route">
                <span>{selected.channel === "email" ? <Mail /> : selected.channel === "phone" ? <Phone /> : selected.channel === "portal" ? <ExternalLink /> : <Search />}</span>
                <p>
                  <small>{selected.routeVerified ? "Verified public route" : "Research blocker"}</small>
                  <strong>{selected.recipientEmail || selected.recipientPhone || selected.applicationUrl || "No recipient or application route verified"}</strong>
                </p>
                {selected.applicationUrl && <a href={selected.applicationUrl} target="_blank" rel="noreferrer" aria-label="Open verified route"><ExternalLink /></a>}
              </div>
              {selected.status === "blocked_contact_missing" ? (
                <div className="outreach-blocker">
                  <Search />
                  <div><strong>Find the decision-maker before outreach</strong><p>This event remains visible because it belongs to the week, but PitchRadar will not invent a recipient or approve a blind message.</p></div>
                </div>
              ) : (
                <>
                  <div className="outreach-subject"><small>Subject</small><strong>{selected.subject}</strong></div>
                  <pre>{language === "de" ? selected.draftDe : selected.draftEn}</pre>
                </>
              )}
              <div className="outreach-controls">
                <p><LockKeyhole /> No connector is enabled. Approval cannot send this message.</p>
                {selected.status === "owner_review" ? (
                  <div>
                    <button onClick={() => decide("cancel")} disabled={busy}>Cancel draft</button>
                    <button onClick={() => decide("approve")} disabled={busy}>Approve & hold <ShieldCheck /></button>
                  </div>
                ) : selected.status === "approved_waiting_connector" ? (
                  <strong><Check /> Owner-approved and safely held</strong>
                ) : (
                  <strong><Search /> Verification work required</strong>
                )}
              </div>
            </section>
          </div>
        ) : (
          <div className="shortlist-empty"><ShieldCheck /><h3>No prepared requests.</h3><p>Run the event-specific verifier after organizer routes have been checked.</p></div>
        )}
      </aside>
    </>
  );
}

function CatalogueState({
  state,
  message,
  onRetry
}: {
  state: "loading" | "error";
  message?: string;
  onRetry: () => void;
}) {
  return (
    <section className={`catalogue-state is-${state}`} aria-live="polite">
      <span className="catalogue-state-icon">{state === "loading" ? <Radar /> : <CircleAlert />}</span>
      <div>
        <p className="overline">{state === "loading" ? "Connecting product truth" : "Catalogue unavailable"}</p>
        <h2>{state === "loading" ? "Loading the operating picture…" : "PitchRadar will not substitute demo data."}</h2>
        <p>{state === "loading"
          ? "Reading events, bookings, sources and the client profile."
          : message || "The PostgreSQL catalogue could not be read. No fixture data was shown in its place."}</p>
        {state === "error" && <button onClick={onRetry}>Try again <ArrowRight /></button>}
      </div>
    </section>
  );
}

function App() {
  const { mode: authMode, logout } = useOwnerAuth();
  const [view, setView] = useState<View>("command");
  const [filter, setFilter] = useState<Filter>("all");
  const [snapshot, setSnapshot] = useState<ProductSnapshot | null>(null);
  const [catalogueError, setCatalogueError] = useState("");
  const [catalogueAttempt, setCatalogueAttempt] = useState(0);
  const [selected, setSelected] = useState<EventOpportunity | null>(null);
  const [queueOpen, setQueueOpen] = useState(false);
  const [queueSelectedId, setQueueSelectedId] = useState<string | undefined>();
  const [agentOpen, setAgentOpen] = useState(false);
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  const [tryList, setTryList] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState("");
  const selectionWrites = useRef(new Set<string>());
  const ranked = useMemo(
    () => snapshot ? rankOpportunities(snapshot.events, snapshot.profile) : [],
    [snapshot]
  );
  // One clock per snapshot read. Every booking-lifecycle question on this page
  // is answered against it, so two surfaces can never disagree about whether a
  // booking is still live.
  const now = useMemo(() => new Date(), [snapshot]);
  const briefing = snapshot?.briefing;
  const verificationQueue = snapshot?.verificationQueue || [];
  const pendingVerificationCount = verificationQueue.filter((item) =>
    ["owner_review", "blocked_contact_missing"].includes(item.status)
  ).length;

  useEffect(() => {
    const controller = new AbortController();
    setCatalogueError("");
    fetchProductSnapshot(controller.signal)
      .then((next) => setSnapshot(next))
      .catch((error) => {
        if (controller.signal.aborted) return;
        setSnapshot(null);
        setCatalogueError(error instanceof Error ? error.message : String(error));
      });
    return () => controller.abort();
  }, [catalogueAttempt]);

  const syncAgentSelections = useCallback((selections: Record<string, "shortlist" | "watch" | "skip">) => {
    setTryList(new Set(
      Object.entries(selections)
        .filter(([, selection]) => selection === "shortlist")
        .map(([id]) => id)
    ));
  }, []);

  useEffect(() => {
    authFetch("/api/agent/state", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((state: { selections?: Record<string, "shortlist" | "watch" | "skip"> } | null) => {
        if (!state?.selections) return;
        syncAgentSelections(state.selections);
      })
      .catch(() => undefined);
  }, [syncAgentSelections]);

  function changeView(next: View) {
    setView(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function toggleTry(event: EventOpportunity) {
    if (event.tier === "REJECTED" || selectionWrites.current.has(event.id)) return;
    const wasSelected = tryList.has(event.id);
    selectionWrites.current.add(event.id);
    setActionError("");
    setTryList((current) => {
      const next = new Set(current);
      if (wasSelected) next.delete(event.id);
      else next.add(event.id);
      return next;
    });
    try {
      const response = await authFetch(`/api/events/${encodeURIComponent(event.id)}/selection`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selection: wasSelected ? null : "shortlist" })
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || "Could not save the shortlist.");
    } catch (error) {
      setTryList((current) => {
        const next = new Set(current);
        if (wasSelected) next.add(event.id);
        else next.delete(event.id);
        return next;
      });
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      selectionWrites.current.delete(event.id);
    }
  }

  function openQueue(requestId?: string) {
    setQueueSelectedId(requestId);
    setQueueOpen(true);
  }

  async function decideVerification(
    request: AvailabilityVerificationRequest,
    decision: "approve" | "cancel"
  ) {
    const response = await authFetch(`/api/outreach/requests/${request.id}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision })
    });
    const body = await response.json() as { error?: string };
    if (!response.ok) throw new Error(body.error || "Could not record the owner decision.");
    setSnapshot(await fetchProductSnapshot());
  }

  return (
    <div className="pitchradar-app">
      <SideRail
        view={view}
        changeView={changeView}
        onOpenAgent={() => setAgentOpen(true)}
        canLogout={authMode === "required"}
        onLogout={() => {
          if (authMode === "required") void logout();
        }}
      />
      <MobileTopbar count={pendingVerificationCount} onOpenAgent={() => setAgentOpen(true)} onOpenShortlist={() => openQueue()} />
      <div className="product-shell">
        <AppHeader
          view={view}
          onOpenAgent={() => setAgentOpen(true)}
          onOpenQueue={() => openQueue()}
          queueCount={pendingVerificationCount}
        />
        {actionError && (
          <div className="product-action-error" role="alert">
            <CircleAlert />
            <span>{actionError}</span>
            <button onClick={() => setActionError("")} aria-label="Dismiss error"><X /></button>
          </div>
        )}
        <main className="product-main">
          {!snapshot && !catalogueError && <CatalogueState state="loading" onRetry={() => setCatalogueAttempt((value) => value + 1)} />}
          {!snapshot && catalogueError && <CatalogueState state="error" message={catalogueError} onRetry={() => setCatalogueAttempt((value) => value + 1)} />}
          {snapshot && view === "command" && <HorizonView ranked={ranked} bookings={snapshot.bookings} briefing={briefing} now={now} sources={snapshot.sources} discovery={snapshot.discovery} catalogueMode={snapshot.mode} loadedAt={snapshot.loadedAt} verificationQueue={verificationQueue} tryList={tryList} onOpen={setSelected} onOpenQueue={() => openQueue()} onOpenAgent={() => setAgentOpen(true)} onToggle={toggleTry} onViewAll={() => changeView("events")} />}
          {snapshot && view === "plan" && <DecisionsView events={ranked} bookings={snapshot.bookings} now={now} tryList={tryList} onOpen={setSelected} onToggle={toggleTry} />}
          {snapshot && view === "events" && <EvidenceView events={ranked} briefing={briefing} filter={filter} setFilter={setFilter} onOpen={setSelected} />}
          {snapshot && view === "applications" && <ApplicationsView requests={verificationQueue} onOpenRequest={openQueue} />}
          {snapshot && view === "organizers" && <OrganizersView events={ranked} briefing={briefing} onOpen={setSelected} />}
          {snapshot && view === "sources" && <CoverageView sourceRegistry={snapshot.sources} />}
          {snapshot && view === "reports" && <ReportsView />}
          {snapshot && view === "business" && <BusinessPage clientProfile={snapshot.profile} missingProfileInputs={snapshot.missingProfileInputs} onOpenAgent={() => setAgentOpen(true)} />}
        </main>
      </div>
      <MobileNav view={view} changeView={changeView} onOpenMore={() => setMobileMoreOpen(true)} />
      {mobileMoreOpen && (
        <MobileMoreMenu
          view={view}
          changeView={changeView}
          onClose={() => setMobileMoreOpen(false)}
          canLogout={authMode === "required"}
          onLogout={() => {
            setMobileMoreOpen(false);
            if (authMode === "required") void logout();
          }}
        />
      )}
      {queueOpen && <OutreachQueuePanel requests={verificationQueue} initialSelectedId={queueSelectedId} onDecision={decideVerification} onClose={() => setQueueOpen(false)} />}
      {selected && <DetailDrawer event={selected} onClose={() => setSelected(null)} />}
      <AgentPanel
        open={agentOpen}
        onClose={() => setAgentOpen(false)}
        onSelectionsChange={syncAgentSelections}
      />
    </div>
  );
}

export default App;
