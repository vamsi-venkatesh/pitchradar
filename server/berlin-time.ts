// Europe/Berlin calendar helpers. Berlin is +01:00 (CET) in winter and +02:00
// (CEST) in summer — a hardcoded offset produces wrong day boundaries for
// roughly five months of the year, so every calendar-day conversion goes
// through the IANA zone via Intl instead.

const OFFSET_PROBE = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false
});

function berlinOffsetMinutes(instant: Date): number {
  const parts = Object.fromEntries(OFFSET_PROBE.formatToParts(instant).map((part) => [part.type, part.value]));
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second)
  );
  return (asUtc - instant.getTime()) / 60_000;
}

/** The exact instant of `YYYY-MM-DD` at the given Berlin wall-clock time. */
export function berlinDate(dateKey: string, hour = 0, minute = 0, second = 0): Date {
  const [year, month, day] = dateKey.split("-").map(Number);
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const offset = berlinOffsetMinutes(guess);
  const corrected = new Date(guess.getTime() - offset * 60_000);
  const recheck = berlinOffsetMinutes(corrected);
  return recheck === offset ? corrected : new Date(guess.getTime() - recheck * 60_000);
}

/** The calendar year/month (1-12) an instant falls in, in Berlin time. */
export function berlinYearMonth(instant: Date): { year: number; month: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit" })
      .formatToParts(instant)
      .map((part) => [part.type, part.value])
  );
  return { year: Number(parts.year), month: Number(parts.month) };
}

/** Number of days in a month (month is 1-12). */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
