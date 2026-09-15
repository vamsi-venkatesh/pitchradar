import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  CircleAlert,
  CircleHelp,
  Loader2,
  Plus,
  Printer,
  ShieldCheck,
  Sparkles,
  Store,
  Trash2
} from "lucide-react";
import { authFetch } from "./auth-client";

/*
 * PitchRadar client intake.
 *
 * Mobile first: the owner fills this in on a phone, standing next to the truck.
 * Every field can be answered, or honestly marked "I don't know yet" — which is
 * stored as an unknown, never as a blank and never as a zero. The form is
 * driven entirely by the schema the server returns, so the API and the screen
 * can never drift apart.
 */

type FieldState = "unknown" | "provided" | "confirmed";

interface FieldOption {
  value: string;
  label: string;
}

interface FieldDefinition {
  id: string;
  label: string;
  helper: string;
  unlocks?: string;
  kind: string;
  unit?: string;
  options?: FieldOption[];
  parts?: Array<"reference" | "issuer" | "expiry">;
  required?: boolean;
  hardGate?: boolean;
  maxLength?: number;
  min?: number;
  max?: number;
}

interface SectionDefinition {
  id: string;
  title: string;
  intro: string;
  unlocks: string;
  fields: FieldDefinition[];
}

interface Answer {
  value: unknown;
  state: FieldState;
  updatedAt: string;
  consentedAt?: string;
}

interface SectionStatus {
  total: number;
  answered: number;
  deferred: number;
  untouched: number;
  complete: boolean;
  updatedAt?: string;
}

interface MenuItem {
  name: string;
  priceEur: number;
  description?: string;
  vegetarian?: boolean;
  vegan?: boolean;
  allergens?: string;
  confirmationRequired?: boolean;
}

interface IntakeView {
  storage: "postgres" | "local_json";
  sections: SectionDefinition[];
  answers: Record<string, Record<string, Answer>>;
  status: Record<string, SectionStatus>;
  progress: {
    totalFields: number;
    answered: number;
    deferred: number;
    outstanding: number;
    sectionsComplete: number;
    sectionsTotal: number;
  };
  prefill: Record<string, Record<string, unknown>>;
  menu: MenuItem[];
  menuConfirmedAt: string | null;
  menuLinesNeedingConfirmation: number;
  intakeCompletedAt: string | null;
  missingInputs: string[];
}

interface DraftEntry {
  value: unknown;
  state: FieldState;
}

type Draft = Record<string, Record<string, DraftEntry>>;

type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; at: string }
  | { kind: "error"; message: string };

interface MenuDraftRow {
  key: string;
  name: string;
  priceEur: string;
  description: string;
  vegetarian: boolean;
  vegan: boolean;
  allergens: string;
  confirmationRequired: boolean;
}

const WEEKDAYS = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 0, label: "Sun" }
];

const timeFormat = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });
const dayFormat = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" });

function toInputString(value: unknown) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function menuRowKey() {
  return `menu-${Math.random().toString(36).slice(2, 10)}`;
}

function toMenuDraft(items: MenuItem[]): MenuDraftRow[] {
  return items.map((item) => ({
    key: menuRowKey(),
    name: item.name,
    priceEur: Number.isFinite(item.priceEur) ? String(item.priceEur) : "",
    description: item.description || "",
    vegetarian: item.vegetarian === true,
    vegan: item.vegan === true,
    allergens: item.allergens || "",
    confirmationRequired: item.confirmationRequired === true
  }));
}

function buildDraft(view: IntakeView): Draft {
  const draft: Draft = {};
  for (const section of view.sections) {
    draft[section.id] = buildSectionDraft(view, section);
  }
  return draft;
}

function buildSectionDraft(view: IntakeView, section: SectionDefinition) {
  const entries: Record<string, DraftEntry> = {};
  for (const field of section.fields) {
    if (field.kind === "statement") continue;
    const answer = view.answers[section.id]?.[field.id];
    if (answer) {
      entries[field.id] = { value: answer.value, state: answer.state };
      continue;
    }
    // No answer yet. A prefill is PitchRadar's own record, shown so the client
    // can confirm or correct it — it is never counted as an answer.
    const prefill = view.prefill[section.id]?.[field.id];
    entries[field.id] = {
      value: prefill === undefined ? null : prefill,
      state: "unknown"
    };
  }
  return entries;
}

/* ------------------------------------------------------------------ *
 * Field editors
 * ------------------------------------------------------------------ */

function FieldRow({
  field,
  entry,
  answer,
  prefill,
  onValue,
  onUnknown,
  onConfirm
}: {
  field: FieldDefinition;
  entry: DraftEntry;
  answer?: Answer;
  prefill: unknown;
  onValue: (value: unknown) => void;
  onUnknown: () => void;
  onConfirm: () => void;
}) {
  const answered = Boolean(answer) && answer!.state !== "unknown";
  const deferred = Boolean(answer) && answer!.state === "unknown";
  const showConfirm = !answer && prefill !== undefined && prefill !== null;
  const controlId = `intake-${field.id}`;

  return (
    <div className={`intake-field${answered ? " is-answered" : ""}${deferred ? " is-deferred" : ""}`}>
      <div className="intake-field-head">
        <label htmlFor={controlId}>
          {field.label}
          {field.unit && <span className="intake-unit">{field.unit}</span>}
          {field.required && <span className="intake-required">required</span>}
          {field.hardGate && <span className="intake-gate">hard gate</span>}
        </label>
        <span className="intake-field-state" aria-hidden="true">
          {answered ? <Check /> : deferred ? <CircleHelp /> : null}
        </span>
      </div>
      <p className="intake-helper">{field.helper}</p>
      {field.unlocks && <p className="intake-unlocks"><Sparkles />{field.unlocks}</p>}
      {showConfirm && (
        <p className="intake-prefill">
          PitchRadar has this on record already. Confirm it or change it — it is not counted until you do.
        </p>
      )}

      <FieldControl field={field} entry={entry} controlId={controlId} onValue={onValue} />

      <div className="intake-field-foot">
        {showConfirm && (
          <button type="button" className="intake-confirm" onClick={onConfirm}>
            <Check /> That is correct
          </button>
        )}
        <button
          type="button"
          className={`intake-unknown${deferred ? " is-active" : ""}`}
          onClick={onUnknown}
        >
          <CircleHelp /> I don&apos;t know yet
        </button>
        {deferred && <span className="intake-field-note">Recorded as unknown — PitchRadar will not guess it.</span>}
      </div>
    </div>
  );
}

function FieldControl({
  field,
  entry,
  controlId,
  onValue
}: {
  field: FieldDefinition;
  entry: DraftEntry;
  controlId: string;
  onValue: (value: unknown) => void;
}) {
  switch (field.kind) {
    case "longtext":
      return (
        <textarea
          id={controlId}
          className="intake-input intake-textarea"
          rows={4}
          maxLength={field.maxLength}
          value={toInputString(entry.value)}
          onChange={(event) => onValue(event.target.value)}
        />
      );
    case "integer":
    case "money":
    case "percent":
    case "dimension":
      return (
        <input
          id={controlId}
          className="intake-input"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          placeholder="—"
          value={toInputString(entry.value)}
          onChange={(event) => onValue(event.target.value)}
        />
      );
    case "email":
    case "phone":
    case "url":
    case "postcode":
    case "text":
      return (
        <input
          id={controlId}
          className="intake-input"
          type={field.kind === "email" ? "email" : field.kind === "phone" ? "tel" : "text"}
          inputMode={field.kind === "postcode" ? "numeric" : undefined}
          autoComplete="off"
          maxLength={field.maxLength}
          placeholder="—"
          value={toInputString(entry.value)}
          onChange={(event) => onValue(event.target.value)}
        />
      );
    case "boolean":
      return (
        <div className="intake-choice" role="group" aria-labelledby={controlId}>
          <button
            type="button"
            className={entry.value === true ? "is-active" : ""}
            onClick={() => onValue(true)}
          >Yes</button>
          <button
            type="button"
            className={entry.value === false ? "is-active" : ""}
            onClick={() => onValue(false)}
          >No</button>
        </div>
      );
    case "consent":
      return (
        <label className="intake-consent" htmlFor={controlId}>
          <input
            id={controlId}
            type="checkbox"
            checked={entry.value === true}
            onChange={(event) => onValue(event.target.checked)}
          />
          <span>Yes, I agree</span>
        </label>
      );
    case "select":
      return (
        <div className="intake-choice intake-choice-wrap" role="group" aria-labelledby={controlId}>
          {(field.options || []).map((option) => (
            <button
              key={option.value}
              type="button"
              className={entry.value === option.value ? "is-active" : ""}
              onClick={() => onValue(option.value)}
            >{option.label}</button>
          ))}
        </div>
      );
    case "multiselect": {
      const selected = new Set(asArray(entry.value).map(String));
      return (
        <div className="intake-choice intake-choice-wrap" role="group" aria-labelledby={controlId}>
          {(field.options || []).map((option) => (
            <button
              key={option.value}
              type="button"
              className={selected.has(option.value) ? "is-active" : ""}
              onClick={() => {
                const next = new Set(selected);
                if (next.has(option.value)) next.delete(option.value);
                else next.add(option.value);
                onValue([...next]);
              }}
            >{option.label}</button>
          ))}
        </div>
      );
    }
    case "weekdays": {
      const selected = new Set(asArray(entry.value).map(Number));
      return (
        <div className="intake-choice intake-choice-wrap" role="group" aria-labelledby={controlId}>
          {WEEKDAYS.map((day) => (
            <button
              key={day.value}
              type="button"
              className={selected.has(day.value) ? "is-active" : ""}
              onClick={() => {
                const next = new Set(selected);
                if (next.has(day.value)) next.delete(day.value);
                else next.add(day.value);
                onValue([...next]);
              }}
            >{day.label}</button>
          ))}
        </div>
      );
    }
    case "stringlist":
      return (
        <textarea
          id={controlId}
          className="intake-input intake-textarea"
          rows={3}
          placeholder="One per line"
          value={asArray(entry.value).map(String).join("\n")}
          onChange={(event) => onValue(event.target.value.split("\n").map((line) => line.trim()).filter(Boolean))}
        />
      );
    case "document": {
      const value = asRecord(entry.value);
      return (
        <div className="intake-compound">
          <div className="intake-choice intake-choice-wrap" role="group" aria-labelledby={controlId}>
            {(field.options || []).map((option) => (
              <button
                key={option.value}
                type="button"
                className={value.held === option.value ? "is-active" : ""}
                onClick={() => onValue({ ...value, held: option.value })}
              >{option.label}</button>
            ))}
          </div>
          {(field.parts || []).includes("issuer") && (
            <label className="intake-sub">
              <span>Insurer / issuer</span>
              <input
                className="intake-input"
                type="text"
                value={toInputString(value.issuer)}
                onChange={(event) => onValue({ ...value, issuer: event.target.value })}
              />
            </label>
          )}
          {(field.parts || []).includes("reference") && (
            <label className="intake-sub">
              <span>Reference / policy number</span>
              <input
                className="intake-input"
                type="text"
                value={toInputString(value.reference)}
                onChange={(event) => onValue({ ...value, reference: event.target.value })}
              />
            </label>
          )}
          {(field.parts || []).includes("expiry") && (
            <label className="intake-sub">
              <span>Expires on</span>
              <input
                className="intake-input"
                type="date"
                value={toInputString(value.expiry)}
                onChange={(event) => onValue({ ...value, expiry: event.target.value })}
              />
            </label>
          )}
        </div>
      );
    }
    case "asset": {
      const value = asRecord(entry.value);
      return (
        <div className="intake-compound">
          <div className="intake-choice" role="group" aria-labelledby={controlId}>
            <button
              type="button"
              className={value.have === true ? "is-active" : ""}
              onClick={() => onValue({ ...value, have: true })}
            >I have it</button>
            <button
              type="button"
              className={value.have === false ? "is-active" : ""}
              onClick={() => onValue({ ...value, have: false })}
            >Not yet</button>
          </div>
          <label className="intake-sub">
            <span>Link (optional)</span>
            <input
              className="intake-input"
              type="text"
              inputMode="url"
              placeholder="https://…"
              value={toInputString(value.link)}
              onChange={(event) => onValue({ ...value, link: event.target.value })}
            />
          </label>
          <label className="intake-sub">
            <span>Note (optional)</span>
            <input
              className="intake-input"
              type="text"
              value={toInputString(value.note)}
              onChange={(event) => onValue({ ...value, note: event.target.value })}
            />
          </label>
          <p className="intake-helper intake-sub-note">
            File upload comes in a later pass. For now PitchRadar only records whether the file exists and where to find it.
          </p>
        </div>
      );
    }
    case "event_history": {
      const rows = asArray(entry.value).map(asRecord);
      return (
        <div className="intake-rows">
          {rows.map((row, index) => (
            <div className="intake-row" key={`past-${index}`}>
              <div className="intake-row-grid">
                <label className="intake-sub">
                  <span>Event name</span>
                  <input
                    className="intake-input"
                    type="text"
                    value={toInputString(row.name)}
                    onChange={(event) => {
                      const next = [...rows];
                      next[index] = { ...row, name: event.target.value };
                      onValue(next);
                    }}
                  />
                </label>
                <label className="intake-sub">
                  <span>City</span>
                  <input
                    className="intake-input"
                    type="text"
                    value={toInputString(row.city)}
                    onChange={(event) => {
                      const next = [...rows];
                      next[index] = { ...row, city: event.target.value };
                      onValue(next);
                    }}
                  />
                </label>
                <label className="intake-sub">
                  <span>Year</span>
                  <input
                    className="intake-input"
                    type="text"
                    inputMode="numeric"
                    value={toInputString(row.year)}
                    onChange={(event) => {
                      const next = [...rows];
                      next[index] = { ...row, year: event.target.value };
                      onValue(next);
                    }}
                  />
                </label>
              </div>
              <div className="intake-choice intake-choice-wrap">
                {[
                  { value: "strong", label: "Went strong" },
                  { value: "ok", label: "It was ok" },
                  { value: "poor", label: "Went poorly" }
                ].map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={row.outcome === option.value ? "is-active" : ""}
                    onClick={() => {
                      const next = [...rows];
                      next[index] = { ...row, outcome: option.value };
                      onValue(next);
                    }}
                  >{option.label}</button>
                ))}
              </div>
              <div className="intake-choice intake-choice-wrap">
                <button
                  type="button"
                  className={row.wouldReturn === true ? "is-active" : ""}
                  onClick={() => {
                    const next = [...rows];
                    next[index] = { ...row, wouldReturn: true };
                    onValue(next);
                  }}
                >Would return</button>
                <button
                  type="button"
                  className={row.wouldReturn === false ? "is-active" : ""}
                  onClick={() => {
                    const next = [...rows];
                    next[index] = { ...row, wouldReturn: false };
                    onValue(next);
                  }}
                >Would not return</button>
              </div>
              <label className="intake-sub">
                <span>Notes</span>
                <input
                  className="intake-input"
                  type="text"
                  value={toInputString(row.notes)}
                  onChange={(event) => {
                    const next = [...rows];
                    next[index] = { ...row, notes: event.target.value };
                    onValue(next);
                  }}
                />
              </label>
              <button
                type="button"
                className="intake-row-remove"
                onClick={() => onValue(rows.filter((_, position) => position !== index))}
              ><Trash2 /> Remove this event</button>
            </div>
          ))}
          <button
            type="button"
            className="intake-add"
            onClick={() => onValue([...rows, { name: "" }])}
          ><Plus /> Add a past event</button>
        </div>
      );
    }
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ *
 * Menu — confirm or correct
 * ------------------------------------------------------------------ */

function MenuEditor({
  rows,
  confirmedAt,
  busy,
  error,
  onChange,
  onConfirm
}: {
  rows: MenuDraftRow[];
  confirmedAt: string | null;
  busy: boolean;
  error: string;
  onChange: (rows: MenuDraftRow[]) => void;
  onConfirm: () => void;
}) {
  function patch(key: string, partial: Partial<MenuDraftRow>) {
    onChange(rows.map((row) => (row.key === key ? { ...row, ...partial } : row)));
  }

  return (
    <div className="intake-menu">
      {!confirmedAt && (
        <p className="intake-menu-warning" role="status">
          <CircleAlert />
          <span>
            <strong>These prices and names are not confirmed yet — please check every line.</strong>
            PitchRadar wrote this list from the founder&apos;s notes, not from you. Nothing here is treated as
            fact until you confirm it.
          </span>
        </p>
      )}
      {confirmedAt && (
        <p className="intake-menu-confirmed" role="status">
          <ShieldCheck />
          <span>Confirmed by you on {dayFormat.format(new Date(confirmedAt))}. Change any line and confirm again to update it.</span>
        </p>
      )}
      <div className="intake-menu-rows">
        {rows.map((row) => (
          <div className={`intake-menu-row${row.confirmationRequired ? " needs-confirm" : ""}`} key={row.key}>
            {row.confirmationRequired && (
              <p className="intake-menu-flag">Name / composition needs your confirmation</p>
            )}
            <div className="intake-menu-grid">
              <label className="intake-sub">
                <span>Name</span>
                <input
                  className="intake-input"
                  type="text"
                  value={row.name}
                  onChange={(event) => patch(row.key, { name: event.target.value })}
                />
              </label>
              <label className="intake-sub intake-menu-price">
                <span>Price €</span>
                <input
                  className="intake-input"
                  type="text"
                  inputMode="decimal"
                  value={row.priceEur}
                  onChange={(event) => patch(row.key, { priceEur: event.target.value })}
                />
              </label>
            </div>
            <label className="intake-sub">
              <span>Short description</span>
              <input
                className="intake-input"
                type="text"
                placeholder="What is actually on it?"
                value={row.description}
                onChange={(event) => patch(row.key, { description: event.target.value })}
              />
            </label>
            <div className="intake-choice intake-choice-wrap">
              <button
                type="button"
                className={row.vegetarian ? "is-active" : ""}
                onClick={() => patch(row.key, { vegetarian: !row.vegetarian })}
              >Vegetarian</button>
              <button
                type="button"
                className={row.vegan ? "is-active" : ""}
                onClick={() => patch(row.key, { vegan: !row.vegan })}
              >Vegan</button>
            </div>
            <label className="intake-sub">
              <span>Contains allergens</span>
              <input
                className="intake-input"
                type="text"
                placeholder="e.g. wheat, milk, egg"
                value={row.allergens}
                onChange={(event) => patch(row.key, { allergens: event.target.value })}
              />
            </label>
            <button
              type="button"
              className="intake-row-remove"
              onClick={() => onChange(rows.filter((item) => item.key !== row.key))}
            ><Trash2 /> Delete this line</button>
          </div>
        ))}
      </div>
      <button
        type="button"
        className="intake-add"
        onClick={() => onChange([...rows, {
          key: menuRowKey(),
          name: "",
          priceEur: "",
          description: "",
          vegetarian: false,
          vegan: false,
          allergens: "",
          confirmationRequired: false
        }])}
      ><Plus /> Add a line (food or drink)</button>
      {error && <p className="intake-error" role="alert"><CircleAlert />{error}</p>}
      <button type="button" className="intake-menu-confirm" onClick={onConfirm} disabled={busy}>
        {busy ? <Loader2 className="intake-spin" /> : <Check />}
        {confirmedAt ? "Save and confirm again" : "Confirm this menu"}
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The intake itself
 * ------------------------------------------------------------------ */

export function ClientIntake() {
  const [view, setView] = useState<IntakeView | null>(null);
  const [loadError, setLoadError] = useState("");
  const [draft, setDraftState] = useState<Draft>({});
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({});
  const [saveStates, setSaveStates] = useState<Record<string, SaveState>>({});
  const [menuRows, setMenuRows] = useState<MenuDraftRow[]>([]);
  const [menuBusy, setMenuBusy] = useState(false);
  const [menuError, setMenuError] = useState("");

  const draftRef = useRef<Draft>({});
  const dirtyRef = useRef<Record<string, Set<string>>>({});
  const timersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const viewRef = useRef<IntakeView | null>(null);

  const setDraft = useCallback((next: Draft) => {
    draftRef.current = next;
    setDraftState(next);
  }, []);

  const adopt = useCallback((next: IntakeView, sectionId?: string) => {
    viewRef.current = next;
    setView(next);
    if (sectionId) {
      const section = next.sections.find((candidate) => candidate.id === sectionId);
      if (section) {
        setDraft({ ...draftRef.current, [sectionId]: buildSectionDraft(next, section) });
      }
    } else {
      setDraft(buildDraft(next));
    }
    setMenuRows((current) => (sectionId && current.length ? current : toMenuDraft(next.menu)));
  }, [setDraft]);

  useEffect(() => {
    const controller = new AbortController();
    const timers = timersRef.current;
    (async () => {
      try {
        const response = await authFetch("/api/profile/intake", {
          headers: { Accept: "application/json" },
          signal: controller.signal
        });
        const body = await response.json() as IntakeView & { error?: string };
        if (!response.ok) throw new Error(body.error || `Intake request failed with HTTP ${response.status}.`);
        viewRef.current = body;
        setView(body);
        setDraft(buildDraft(body));
        setMenuRows(toMenuDraft(body.menu));
        setOpenSections({ [body.sections[0]?.id || ""]: true });
      } catch (error) {
        if (controller.signal.aborted) return;
        setLoadError(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      controller.abort();
      for (const timer of Object.values(timers)) clearTimeout(timer);
    };
  }, [setDraft]);

  const saveSection = useCallback(async (sectionId: string) => {
    const dirty = dirtyRef.current[sectionId];
    if (!dirty || dirty.size === 0) return;
    const fields = [...dirty];
    const answers: Record<string, { value: unknown; state: FieldState }> = {};
    for (const fieldId of fields) {
      const entry = draftRef.current[sectionId]?.[fieldId];
      if (!entry) continue;
      answers[fieldId] = { value: entry.value, state: entry.state };
    }
    setSaveStates((current) => ({ ...current, [sectionId]: { kind: "saving" } }));
    try {
      const response = await authFetch(`/api/profile/intake/${encodeURIComponent(sectionId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers })
      });
      const body = await response.json() as IntakeView & { error?: string };
      if (!response.ok) throw new Error(body.error || `Save failed with HTTP ${response.status}.`);
      for (const fieldId of fields) dirty.delete(fieldId);
      adopt(body, sectionId);
      setSaveStates((current) => ({
        ...current,
        [sectionId]: { kind: "saved", at: timeFormat.format(new Date()) }
      }));
    } catch (error) {
      setSaveStates((current) => ({
        ...current,
        [sectionId]: { kind: "error", message: error instanceof Error ? error.message : String(error) }
      }));
    }
  }, [adopt]);

  const queueSave = useCallback((sectionId: string) => {
    clearTimeout(timersRef.current[sectionId]);
    timersRef.current[sectionId] = setTimeout(() => void saveSection(sectionId), 1200);
  }, [saveSection]);

  const editField = useCallback((
    sectionId: string,
    fieldId: string,
    value: unknown,
    state: FieldState
  ) => {
    const section = draftRef.current[sectionId] || {};
    setDraft({ ...draftRef.current, [sectionId]: { ...section, [fieldId]: { value, state } } });
    dirtyRef.current[sectionId] = dirtyRef.current[sectionId] || new Set();
    dirtyRef.current[sectionId].add(fieldId);
    setSaveStates((current) => ({ ...current, [sectionId]: { kind: "idle" } }));
    queueSave(sectionId);
  }, [queueSave, setDraft]);

  const confirmMenuNow = useCallback(async () => {
    setMenuBusy(true);
    setMenuError("");
    try {
      const items = menuRows.map((row) => ({
        name: row.name,
        priceEur: row.priceEur,
        description: row.description,
        vegetarian: row.vegetarian,
        vegan: row.vegan,
        allergens: row.allergens
      }));
      const response = await authFetch("/api/profile/menu/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items })
      });
      const body = await response.json() as IntakeView & { error?: string };
      if (!response.ok) throw new Error(body.error || `Menu confirmation failed with HTTP ${response.status}.`);
      viewRef.current = body;
      setView(body);
      setMenuRows(toMenuDraft(body.menu));
    } catch (error) {
      setMenuError(error instanceof Error ? error.message : String(error));
    } finally {
      setMenuBusy(false);
    }
  }, [menuRows]);

  function toggleSection(sectionId: string) {
    const open = openSections[sectionId];
    setOpenSections((current) => ({ ...current, [sectionId]: !open }));
    // Collapsing is a natural save point: never leave an edit in the air.
    if (open) {
      clearTimeout(timersRef.current[sectionId]);
      void saveSection(sectionId);
    }
  }

  if (loadError) {
    return (
      <section className="product-page intake-page">
        <div className="intake-load-error" role="alert">
          <CircleAlert />
          <div>
            <strong>The intake could not be loaded</strong>
            <p>{loadError}</p>
          </div>
        </div>
      </section>
    );
  }

  if (!view) {
    return (
      <section className="product-page intake-page">
        <div className="intake-loading"><Loader2 className="intake-spin" /> Loading the intake…</div>
      </section>
    );
  }

  const { progress } = view;
  const percent = progress.totalFields
    ? Math.round((progress.answered / progress.totalFields) * 100)
    : 0;

  return (
    <section className="product-page intake-page">
      <header className="page-intro intake-intro">
        <div>
          <p className="overline">Client intake</p>
          <h2>Everything PitchRadar needs from you</h2>
          <p>
            Answer what you know. Where you do not know something yet, say so — PitchRadar records it as
            unknown and never invents a number in its place.
          </p>
        </div>
        <div className="intake-intro-tools">
          <button type="button" className="intake-print" onClick={() => window.print()}>
            <Printer /> Print / save as PDF
          </button>
        </div>
      </header>

      <section className="intake-progress" aria-label="Intake progress">
        <div className="intake-progress-head">
          <strong>{progress.answered} of {progress.totalFields} answered</strong>
          <span>
            {progress.deferred} marked not known yet · {progress.sectionsComplete} of {progress.sectionsTotal} sections complete
          </span>
        </div>
        <div className="intake-progress-bar"><i style={{ width: `${percent}%` }} /></div>
        {view.missingInputs.length > 0 && (
          <ul className="intake-open-list">
            {view.missingInputs.map((item) => <li key={item}><span />{item}</li>)}
          </ul>
        )}
        {view.intakeCompletedAt && (
          <p className="intake-complete"><ShieldCheck /> Every section answered. PitchRadar is working from your facts now.</p>
        )}
      </section>

      <ol className="intake-sections">
        {view.sections.map((section, index) => {
          const status = view.status[section.id];
          const open = Boolean(openSections[section.id]);
          const saveState = saveStates[section.id] || { kind: "idle" } as SaveState;
          const pending = (dirtyRef.current[section.id]?.size || 0) > 0;
          return (
            <li
              key={section.id}
              className={`intake-section${open ? " is-open" : ""}${status?.complete ? " is-complete" : ""}`}
            >
              <button
                type="button"
                className="intake-section-head"
                aria-expanded={open}
                aria-controls={`intake-body-${section.id}`}
                onClick={() => toggleSection(section.id)}
              >
                <span className="intake-step">{status?.complete ? <Check /> : index + 1}</span>
                <span className="intake-section-title">
                  <strong>{section.title}</strong>
                  <small>{section.intro}</small>
                </span>
                <span className="intake-section-count">
                  {status ? `${status.answered}/${status.total}` : "—"}
                </span>
                <ChevronDown className="intake-chevron" />
              </button>
              <div
                id={`intake-body-${section.id}`}
                className={`intake-section-body${open ? "" : " is-collapsed"}`}
              >
                <p className="intake-section-unlocks">
                  {section.id === "menu" ? <Store /> : <Sparkles />}
                  <span><strong>What this unlocks: </strong>{section.unlocks}</span>
                </p>

                {section.id === "menu" && (
                  <MenuEditor
                    rows={menuRows}
                    confirmedAt={view.menuConfirmedAt}
                    busy={menuBusy}
                    error={menuError}
                    onChange={setMenuRows}
                    onConfirm={() => void confirmMenuNow()}
                  />
                )}

                {section.fields.map((field) => {
                  if (field.kind === "statement") {
                    return (
                      <p className="intake-statement" key={field.id}>
                        <ShieldCheck />
                        <span><strong>{field.label}</strong>{field.helper}</span>
                      </p>
                    );
                  }
                  const entry = draft[section.id]?.[field.id] || { value: null, state: "unknown" as FieldState };
                  return (
                    <FieldRow
                      key={field.id}
                      field={field}
                      entry={entry}
                      answer={view.answers[section.id]?.[field.id]}
                      prefill={view.prefill[section.id]?.[field.id]}
                      onValue={(value) => editField(section.id, field.id, value, "provided")}
                      onUnknown={() => editField(section.id, field.id, null, "unknown")}
                      onConfirm={() => editField(section.id, field.id, entry.value, "confirmed")}
                    />
                  );
                })}

                <div className="intake-section-foot">
                  <button
                    type="button"
                    className="intake-save"
                    onClick={() => {
                      clearTimeout(timersRef.current[section.id]);
                      void saveSection(section.id);
                    }}
                    disabled={saveState.kind === "saving" || !pending}
                  >
                    {saveState.kind === "saving" ? <Loader2 className="intake-spin" /> : <Check />}
                    {pending ? "Save this section" : "Nothing to save"}
                  </button>
                  <span className={`intake-save-state is-${saveState.kind}`} role="status">
                    {saveState.kind === "saving" && "Saving…"}
                    {saveState.kind === "saved" && `Saved at ${saveState.at}`}
                    {saveState.kind === "error" && saveState.message}
                    {saveState.kind === "idle" && pending && "Not saved yet"}
                  </span>
                </div>
              </div>
            </li>
          );
        })}
      </ol>

      <footer className="intake-foot">
        <ShieldCheck />
        <p>
          PitchRadar never sends anything on your behalf without your approval, and never fills a gap with a
          guess. Answers are stored {view.storage === "postgres" ? "in the operating database" : "in this local runtime"} and
          can be changed at any time.
        </p>
      </footer>
    </section>
  );
}

export default ClientIntake;
