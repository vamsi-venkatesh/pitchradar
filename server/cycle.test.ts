import { describe, expect, it } from "vitest";
import { executeOperatingCycle, type OperatingCycleDependencies } from "./cycle";

function dependencies(
  overrides: Partial<OperatingCycleDependencies> = {}
): OperatingCycleDependencies {
  let tick = 0;
  return {
    bookingLifecycle: async () => ({ bookingsExamined: 1, transitions: [] }),
    collect: async () => ({ receipts: [], sourcesSelected: 2 }),
    normalize: async () => ({ selected: 2, linked: 2 }),
    intelligence: async () => ({ checkedTargets: 5, warnings: [] }),
    contactResolution: async () => ({ eventsTargeted: 3, pagesFetched: 5, failures: [] }),
    ownerQueue: async () => ({ planned: 6, refreshed: 6, externalActions: 0 }),
    deadlineMonitor: async () => ({ dueWindows: 3, alertsCreated: 2 }),
    weather: async () => ({ eventsInWindow: 4, forecastsFetched: 4, failures: [] }),
    now: () => new Date(Date.UTC(2026, 6, 28, 10, 0, tick++)),
    ...overrides
  };
}

describe("recurring PitchRadar operating cycle", () => {
  it("runs the eight evidence stages in binding order and never performs an external action", async () => {
    const order: string[] = [];
    const result = await executeOperatingCycle(dependencies({
      bookingLifecycle: async () => { order.push("booking_lifecycle"); return { transitions: [] }; },
      collect: async () => { order.push("collect"); return { receipts: [] }; },
      normalize: async () => { order.push("normalize"); return { selected: 0 }; },
      intelligence: async () => { order.push("intelligence"); return { warnings: [] }; },
      contactResolution: async () => { order.push("contact_resolution"); return { failures: [] }; },
      ownerQueue: async () => { order.push("owner_queue"); return { planned: 6 }; },
      deadlineMonitor: async () => { order.push("deadline_monitor"); return { dueWindows: 0 }; },
      weather: async () => { order.push("weather"); return { failures: [] }; }
    }));
    expect(order).toEqual([
      // Booking hygiene runs FIRST: an elapsed booking that still reads 'live'
      // would otherwise block weeks the truck is already free for every stage
      // downstream of it.
      "booking_lifecycle",
      "collect",
      "normalize",
      "intelligence",
      // Contact resolution reads the CURRENT report's selection, so it runs
      // after intelligence has had its say about routes and before the owner
      // queue drafts anything that names a recipient.
      "contact_resolution",
      "owner_queue",
      "deadline_monitor",
      "weather"
    ]);
    expect(result.state).toBe("succeeded");
    expect(result.externalActions).toBe(0);
  });

  it("records a partial cycle and continues later stages when one source family fails", async () => {
    const result = await executeOperatingCycle(dependencies({
      collect: async () => ({ receipts: [{ runState: "failed" }, { runState: "succeeded" }] }),
      intelligence: async () => { throw new Error("route temporarily unavailable"); }
    }));
    expect(result.state).toBe("partial");
    expect(result.stages.map((stage) => stage.state)).toEqual([
      "succeeded",
      "partial",
      "succeeded",
      "failed",
      "succeeded",
      "succeeded",
      "succeeded",
      "succeeded"
    ]);
    expect(result.stages[3].error).toMatch(/temporarily unavailable/);
  });

  it("reports a partial cycle when a weather lookup failed, and never rejects the cycle for it", async () => {
    const result = await executeOperatingCycle(dependencies({
      weather: async () => ({
        eventsInWindow: 2,
        forecastsFetched: 1,
        failures: [{ eventId: "event-1", stage: "geocode", error: "No German geocoding result." }]
      })
    }));
    expect(result.state).toBe("partial");
    expect(result.stages.at(-1)).toMatchObject({ name: "weather", state: "partial" });
    expect(result.externalActions).toBe(0);
  });

  it("does not report success when a source is reachable but restricted", async () => {
    const result = await executeOperatingCycle(dependencies({
      collect: async () => ({ receipts: [{ runState: "partial" }] })
    }));
    expect(result.state).toBe("partial");
    expect(result.stages[1].state).toBe("partial");
  });
});
