import { describe, expect, it } from "vitest";
import type { SourceProbeResult } from "./source-probe";
import {
  organizerIntelligenceTargets,
  reconcileMissingFields,
  verifyOrganizerTarget
} from "./intelligence";

function healthy(bodyText: string, url: string): SourceProbeResult {
  return {
    sourceId: "test",
    sourceName: "Test source",
    requestedUrl: url,
    finalUrl: url,
    checkedAt: "2026-07-27T17:00:00.000Z",
    state: "healthy",
    ok: true,
    status: 200,
    contentType: "text/html",
    bodyHash: "abc123",
    bodyText,
    bytesReviewed: bodyText.length
  };
}

describe("organizer intelligence verification", () => {
  it("keeps a reachable general form separate from event capacity", () => {
    const target = organizerIntelligenceTargets[0];
    const result = verifyOrganizerTarget(target, [
      healthy(
        `<main>FoodTrucker / Trailer / Stand · Spezialität · Stadt/Städte/Region</main>`,
        target.applicationUrl
      ),
      healthy(
        `<p>info@example-foodtruck-festivals.de · +49 30 0000000</p>`,
        target.contact!.sourceUrl
      )
    ]);
    expect(result.routeReachable).toBe(true);
    expect(result.contact?.email).toBe("info@example-foodtruck-festivals.de");
    expect(result.verifiedRequirements).toHaveLength(3);
    expect(result.finding).toMatch(/capacity.*direct confirmation/i);
  });

  it("does not persist an unverified contact", () => {
    const target = organizerIntelligenceTargets[1];
    const result = verifyOrganizerTarget(target, [
      healthy(`<main>Direktbewerbung · Foodtruck-Partnerbetreuung</main>`, target.applicationUrl)
    ]);
    expect(result.routeReachable).toBe(true);
    expect(result.contact).toBeUndefined();
    expect(result.warnings.join(" ")).toMatch(/contact details could not all be verified/i);
  });

  it("records an unreachable route honestly", () => {
    const target = organizerIntelligenceTargets[3];
    const result = verifyOrganizerTarget(target, [{
      ...healthy("", target.applicationUrl),
      ok: false,
      state: "unavailable",
      status: null,
      error: "Timed out"
    }]);
    expect(result.routeReachable).toBe(false);
    expect(result.finding).toMatch(/no event-specific public application route/i);
  });

  it("removes only gaps that the organizer refresh actually resolved", () => {
    expect(reconcileMissingFields(
      ["Organizer contact", "Application route", "speciality category capacity", "Pitch fee"],
      { contact: organizerIntelligenceTargets[0].contact, routeReachable: true }
    )).toEqual(["speciality category capacity", "Pitch fee"]);
  });
});
