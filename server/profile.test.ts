import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INTAKE_SECTIONS,
  IntakeValidationError,
  UnknownIntakeSectionError,
  confirmMenu,
  normalizeMenuItems,
  projectLegacyColumns,
  readClientIntake,
  recomputeMissingInputs,
  saveClientIntakeSection,
  totalIntakeFields,
  validateSectionAnswers,
  type IntakeRecord
} from "./profile";

// Vitest sets VITEST=true before application modules load, so database.ts
// refuses to build a pool: every storage path below exercises the local JSON
// runtime inside a temporary directory. The owner's database is never touched.
let runtimeDir = "";

beforeEach(async () => {
  runtimeDir = await mkdtemp(path.join(os.tmpdir(), "pitchradar-intake-test-"));
  vi.stubEnv("PITCHRADAR_RUNTIME_DIR", runtimeDir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  if (runtimeDir) {
    await rm(runtimeDir, { recursive: true, force: true });
    runtimeDir = "";
  }
});

// Answer timestamps are recorded verbatim; pin them so nothing here depends on
// the wall clock the suite happens to run on.
const ANSWERED_AT = "2026-07-27T13:00:00.000Z";

describe("migration 011", () => {
  it("adds the intake columns without disturbing the existing profile columns", async () => {
    const sql = await readFile(
      path.join(process.cwd(), "db", "migrations", "011_client_intake.sql"),
      "utf8"
    );
    expect(sql).toContain("alter table client_profiles");
    expect(sql).toContain("add column if not exists intake jsonb not null default '{}'::jsonb");
    expect(sql).toContain("add column if not exists intake_status jsonb not null default '{}'::jsonb");
    expect(sql).toContain("add column if not exists menu_confirmed_at timestamptz");
    expect(sql).toContain("add column if not exists intake_completed_at timestamptz");
    // Nothing may drop, rename or rewrite what the rest of the product reads.
    expect(sql).not.toMatch(/drop\s+(column|table)/i);
    expect(sql).not.toMatch(/\balter\s+column\b/i);
  });
});

describe("intake schema", () => {
  it("ships all ten sections, each field labelled and explained", () => {
    expect(INTAKE_SECTIONS.map((section) => section.id)).toEqual([
      "business_contact",
      "home_base",
      "menu",
      "capacity",
      "economics",
      "truck_technical",
      "documents",
      "application_material",
      "history_preferences",
      "consent_authority"
    ]);
    for (const section of INTAKE_SECTIONS) {
      expect(section.title.length).toBeGreaterThan(0);
      expect(section.unlocks.length).toBeGreaterThan(0);
      for (const field of section.fields) {
        expect(field.label.length, `${section.id}.${field.id} label`).toBeGreaterThan(0);
        expect(field.helper.length, `${section.id}.${field.id} helper`).toBeGreaterThan(0);
      }
    }
    // Display-only statements are never counted as answerable fields.
    const declared = INTAKE_SECTIONS.reduce((sum, section) => sum + section.fields.length, 0);
    expect(totalIntakeFields()).toBe(declared - 1);
  });
});

describe("section validation", () => {
  it("rejects an unknown section id", () => {
    expect(() => validateSectionAnswers("not_a_section", { anything: "x" }))
      .toThrow(UnknownIntakeSectionError);
  });

  it("rejects a postcode that is not five German digits", () => {
    expect(() => validateSectionAnswers("home_base", { postcode: "1446" }))
      .toThrow(IntakeValidationError);
    expect(() => validateSectionAnswers("home_base", { postcode: "AB123" }))
      .toThrow(/5-digit German postcode/);
    expect(validateSectionAnswers("home_base", { postcode: " 10115 " }).postcode)
      .toMatchObject({ value: "10115", state: "provided" });
  });

  it("rejects negative prices and costs", () => {
    expect(() => validateSectionAnswers("economics", { foodCostPerPortion: -1 }))
      .toThrow(/cannot be negative/);
    expect(() => validateSectionAnswers("economics", { maxPitchFeeEur: "-250" }))
      .toThrow(IntakeValidationError);
    expect(validateSectionAnswers("economics", { foodCostPerPortion: "1,755" }).foodCostPerPortion)
      .toMatchObject({ value: 1.76, state: "provided" });
  });

  it("keeps a blank as unknown and never as zero", () => {
    const blanks = validateSectionAnswers("economics", {
      foodCostPerPortion: "",
      travelCostPerKm: null,
      minProfitPerEvent: "   "
    });
    for (const answer of Object.values(blanks)) {
      expect(answer.value).toBeNull();
      expect(answer.state).toBe("unknown");
      expect(answer.updatedAt).toBeTruthy();
    }
    // A real zero is still a real answer.
    expect(validateSectionAnswers("economics", { maxPitchFeeEur: 0 }).maxPitchFeeEur)
      .toMatchObject({ value: 0, state: "provided" });
  });

  it("persists an explicit \"I don't know yet\" as a timestamped unknown", () => {
    const answers = validateSectionAnswers("capacity", {
      portionsPerHour: { value: 120, state: "unknown" }
    });
    expect(answers.portionsPerHour).toMatchObject({ value: null, state: "unknown" });
    expect(answers.portionsPerHour.updatedAt).toBeTruthy();
  });

  it("requires dimensions to be positive and clamps them to the field maximum", () => {
    expect(() => validateSectionAnswers("truck_technical", { lengthM: 0 }))
      .toThrow(/greater than zero/);
    expect(() => validateSectionAnswers("truck_technical", { widthM: -2.5 }))
      .toThrow(IntakeValidationError);
    expect(validateSectionAnswers("truck_technical", { lengthM: "6,4" }).lengthM)
      .toMatchObject({ value: 6.4 });
    expect(validateSectionAnswers("truck_technical", { lengthM: 900 }).lengthM)
      .toMatchObject({ value: 30 });
  });

  it("shape-checks contact details without over-validating international formats", () => {
    expect(() => validateSectionAnswers("business_contact", { email: "not-an-email" }))
      .toThrow(/email address/);
    expect(() => validateSectionAnswers("business_contact", { phone: "abc" }))
      .toThrow(/phone number/);
    expect(validateSectionAnswers("business_contact", { phone: "+36 (1) 234-5678" }).phone)
      .toMatchObject({ value: "+36 (1) 234-5678", state: "provided" });
    expect(validateSectionAnswers("business_contact", { email: " Owner@Example.DE " }).email)
      .toMatchObject({ value: "owner@example.de" });
    expect(validateSectionAnswers("business_contact", { website: "demo-operator.example" }).website)
      .toMatchObject({ value: "https://demo-operator.example" });
  });

  it("stamps a consent with the moment it was given", () => {
    const answers = validateSectionAnswers("consent_authority", { consentStoreBusinessData: true });
    expect(answers.consentStoreBusinessData.value).toBe(true);
    expect(answers.consentStoreBusinessData.consentedAt).toBeTruthy();
  });

  it("caps free text instead of losing the save", () => {
    const long = "x".repeat(6000);
    const answers = validateSectionAnswers("application_material", { longDescription: long });
    expect(String(answers.longDescription.value)).toHaveLength(4000);
  });

  it("refuses unknown fields, unknown options and display-only statements", () => {
    expect(() => validateSectionAnswers("capacity", { madeUpField: 3 }))
      .toThrow(/does not exist in section/);
    expect(() => validateSectionAnswers("truck_technical", { voltage: "12" }))
      .toThrow(/offered options/);
    expect(() => validateSectionAnswers("consent_authority", { neverSendsWithoutApproval: false }))
      .toThrow(/display-only/);
  });
});

describe("menu confirmation", () => {
  it("holds the whole list unconfirmed while flagging the undecodable lines", async () => {
    const view = await readClientIntake();
    expect(view.storage).toBe("local_json");
    expect(view.menu).toHaveLength(8);
    // Two distinct facts. The client has confirmed nothing at all …
    expect(view.menuConfirmedAt).toBeNull();
    expect(view.missingInputs).toContain("Client confirmation of the menu names and prices");
    // … and three lines additionally carry a name nobody can decode yet.
    expect(view.menuLinesNeedingConfirmation).toBe(3);
    expect(view.menu.filter((item) => item.confirmationRequired).map((item) => item.name))
      .toEqual(["Variante A", "Variante B", "Komplett"]);
    // The menu section can never be complete while the list is unconfirmed.
    expect(view.status.menu.complete).toBe(false);
  });

  it("stamps menu_confirmed_at and clears every confirmationRequired flag", async () => {
    const before = await readClientIntake();
    const confirmed = await confirmMenu(before.menu.map((item) => ({
      name: item.name,
      priceEur: item.priceEur,
      description: item.name === "Variante A" ? "Sour cream, cheese and onion" : "",
      vegetarian: item.name === "Kräuter",
      allergens: "wheat, milk"
    })));

    expect(confirmed.menuConfirmedAt).toBeTruthy();
    expect(confirmed.menuLinesNeedingConfirmation).toBe(0);
    expect(confirmed.menu.every((item) => item.confirmationRequired === false)).toBe(true);
    expect(confirmed.menu.find((item) => item.name === "Variante A")?.description)
      .toBe("Sour cream, cheese and onion");
    expect(confirmed.missingInputs)
      .not.toContain("Client confirmation of the menu names and prices");

    // It survives a reload: the confirmation is stored, not held in memory.
    const reloaded = await readClientIntake();
    expect(reloaded.menuConfirmedAt).toBe(confirmed.menuConfirmedAt);
    expect(reloaded.menuLinesNeedingConfirmation).toBe(0);
  });

  it("validates menu lines and refuses an empty confirmation", async () => {
    expect(() => normalizeMenuItems([{ name: "Kräuter", priceEur: -1 }]))
      .toThrow(/cannot be negative/);
    expect(() => normalizeMenuItems([{ name: "  ", priceEur: 6 }]))
      .toThrow(/needs a name/);
    expect(() => normalizeMenuItems([{ name: "Kräuter", priceEur: "" }]))
      .toThrow(/must be a number/);
    await expect(confirmMenu([])).rejects.toThrow(IntakeValidationError);
  });

  it("accepts a new line the client adds, including drinks", () => {
    const items = normalizeMenuItems([
      { name: "Kräuter", priceEur: "6.5" },
      { name: "Apfelschorle 0,5 l", priceEur: 3, vegan: true }
    ]);
    expect(items).toEqual([
      { name: "Kräuter", priceEur: 6.5, confirmationRequired: false },
      { name: "Apfelschorle 0,5 l", priceEur: 3, confirmationRequired: false, vegan: true }
    ]);
  });
});

describe("missing input recomputation", () => {
  it("starts with every gap open, including the unconfirmed menu and consent", () => {
    const missing = recomputeMissingInputs({}, null);
    expect(missing).toContain("Client confirmation of the menu names and prices");
    expect(missing).toContain("Exact postcode / starting address");
    expect(missing).toContain("Consent to store business data for applications");
    expect(missing).toHaveLength(12);
  });

  it("shrinks as sections are completed, and never on a deferred answer", () => {
    const now = ANSWERED_AT;
    const intake: IntakeRecord = {
      home_base: {
        ...validateSectionAnswers("home_base", { postcode: "10115", streetAddress: "Hauptstr. 1" }, now)
      }
    };
    const afterPostcode = recomputeMissingInputs(intake, null);
    expect(afterPostcode).not.toContain("Exact postcode / starting address");
    expect(afterPostcode).toHaveLength(11);

    // "I don't know yet" is an honest answer, but it closes no gap.
    intake.economics = validateSectionAnswers("economics", {
      foodCostPerPortion: { value: null, state: "unknown" },
      staffCostPerPersonPerDay: 120,
      travelCostPerKm: 0.42
    }, now);
    expect(recomputeMissingInputs(intake, null)).toContain("Food, labour and travel costs");

    intake.economics = {
      ...intake.economics,
      ...validateSectionAnswers("economics", { foodCostPerPortion: 1.1 }, now)
    };
    const afterCosts = recomputeMissingInputs(intake, null);
    expect(afterCosts).not.toContain("Food, labour and travel costs");
    expect(afterCosts).toHaveLength(10);

    expect(recomputeMissingInputs(intake, now)).toHaveLength(9);
  });
});

describe("saving a section", () => {
  it("persists answers, updates section status and shrinks the gap list", async () => {
    const saved = await saveClientIntakeSection("home_base", {
      postcode: "10115",
      streetAddress: "Hauptstraße 1",
      city: "Potsdam",
      operatingDays: [5, 6, 0],
      normalMaxTravelMinutes: "300"
    });

    expect(saved.answers.home_base.postcode).toMatchObject({ value: "10115", state: "provided" });
    expect(saved.status.home_base.answered).toBe(5);
    expect(saved.status.home_base.complete).toBe(false);
    expect(saved.progress.answered).toBe(5);
    expect(saved.missingInputs).not.toContain("Exact postcode / starting address");

    // The legacy profile columns follow the intake, so travel maths and the
    // dashboards see the same postcode the client just typed.
    expect(saved.prefill.home_base.postcode).toBe("10115");
    expect(saved.prefill.home_base.normalMaxTravelMinutes).toBe(300);

    const reloaded = await readClientIntake();
    expect(reloaded.answers.home_base.city).toMatchObject({ value: "Potsdam" });
    expect(reloaded.progress.answered).toBe(5);
  });

  it("merges a second partial save instead of dropping the first", async () => {
    await saveClientIntakeSection("capacity", { portionsPerHour: 80 });
    const second = await saveClientIntakeSection("capacity", { portionsPerDay: 600 });
    expect(second.answers.capacity.portionsPerHour).toMatchObject({ value: 80 });
    expect(second.answers.capacity.portionsPerDay).toMatchObject({ value: 600 });
    expect(second.missingInputs).not.toContain("Portions per hour and per day");
  });

  it("counts a deferred answer as touched but never as known", async () => {
    const saved = await saveClientIntakeSection("capacity", {
      staffCount: { value: null, state: "unknown" }
    });
    expect(saved.status.capacity).toMatchObject({ answered: 0, deferred: 1 });
    expect(saved.progress.deferred).toBe(1);
    expect(saved.progress.answered).toBe(0);
  });

  it("rejects an invalid section save without writing anything", async () => {
    await expect(saveClientIntakeSection("home_base", { postcode: "999" }))
      .rejects.toThrow(IntakeValidationError);
    await expect(saveClientIntakeSection("nope", { postcode: "10115" }))
      .rejects.toThrow(UnknownIntakeSectionError);
    const view = await readClientIntake();
    expect(view.answers.home_base).toBeUndefined();
    expect(view.progress.answered).toBe(0);
  });
});

describe("legacy column projection", () => {
  const current = {
    home_postcode: null,
    normal_days: [5, 6, 0],
    optional_thursday: true,
    preferred_max_travel_minutes: 480,
    exceptional_max_travel_minutes: 600
  };

  it("never writes an exceptional maximum below the preferred one", () => {
    const now = ANSWERED_AT;
    const intake: IntakeRecord = {
      home_base: validateSectionAnswers("home_base", {
        normalMaxTravelMinutes: 700,
        exceptionalMaxTravelMinutes: 300
      }, now)
    };
    const projected = projectLegacyColumns(intake, current);
    expect(projected.preferred_max_travel_minutes).toBe(700);
    expect(projected.exceptional_max_travel_minutes).toBe(700);
  });

  it("leaves the existing columns untouched when the intake is unknown", () => {
    const now = ANSWERED_AT;
    const intake: IntakeRecord = {
      home_base: validateSectionAnswers("home_base", {
        postcode: { value: null, state: "unknown" },
        operatingDays: { value: null, state: "unknown" }
      }, now)
    };
    expect(projectLegacyColumns(intake, current)).toEqual(current);
  });
});
