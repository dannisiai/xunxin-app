const DAY_MS = 86_400_000;

type CalendarDate = { year: number; month: number; day: number };

export type RelationshipAnniversary = {
  year: number;
  date: string;
  daysRemaining: number;
  daysSince: number;
  isPast: boolean;
};

export function localDateKey(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

// Compare calendar dates in UTC so 23/25-hour daylight-saving days still count once.
function ordinal(date: CalendarDate): number {
  const value = new Date(0);
  value.setUTCFullYear(date.year, date.month - 1, date.day);
  value.setUTCHours(0, 0, 0, 0);
  return value.getTime() / DAY_MS;
}

function parseDate(key: string | null): CalendarDate | null {
  const parts = key?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!parts) return null;
  const date = { year: Number(parts[1]), month: Number(parts[2]), day: Number(parts[3]) };
  const value = new Date(ordinal(date) * DAY_MS);
  return value.getUTCFullYear() === date.year && value.getUTCMonth() + 1 === date.month
    && value.getUTCDate() === date.day ? date : null;
}

function startDate(createdAt: string | undefined): CalendarDate | null {
  if (!createdAt) return null;
  const date = new Date(createdAt);
  return Number.isFinite(date.getTime()) ? parseDate(localDateKey(date)) : null;
}

function anniversaryDate(start: CalendarDate, year: number): CalendarDate | null {
  const targetYear = start.year + year;
  if (!Number.isInteger(year) || year < 1 || targetYear > 9999) return null;
  const monthEnd = new Date(0);
  monthEnd.setUTCFullYear(targetYear, start.month, 0);
  // A February 29 start celebrates on February 28 in non-leap years.
  return { year: targetYear, month: start.month, day: Math.min(start.day, monthEnd.getUTCDate()) };
}

function formatDate(date: CalendarDate): string {
  return `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

function milestone(start: CalendarDate, today: CalendarDate, year: number): RelationshipAnniversary | null {
  const date = anniversaryDate(start, year);
  if (!date) return null;
  const distance = ordinal(date) - ordinal(today);
  return { year, date: formatDate(date), daysRemaining: Math.max(0, distance),
    daysSince: Math.max(0, -distance), isPast: distance < 0 };
}

export function getRelationshipAnniversary(
  createdAt: string | undefined, year: number, todayKey: string | null,
): RelationshipAnniversary | null {
  const start = startDate(createdAt);
  const today = parseDate(todayKey);
  return start && today ? milestone(start, today, year) : null;
}

export function getRelationshipDays(createdAt: string | undefined, todayKey: string | null): {
  dayNumber: number;
  startedOn: string;
  anniversaries: RelationshipAnniversary[];
} | null {
  const start = startDate(createdAt);
  const today = parseDate(todayKey);
  if (!start || !today) return null;
  let nextYear = Math.max(1, today.year - start.year);
  const candidate = milestone(start, today, nextYear);
  if (candidate?.isPast) nextYear++;
  const anniversaries: RelationshipAnniversary[] = [];
  for (let offset = 0; offset < 5; offset++) {
    const item = milestone(start, today, nextYear + offset);
    if (item) anniversaries.push(item);
  }
  return { dayNumber: Math.max(1, ordinal(today) - ordinal(start) + 1),
    startedOn: formatDate(start), anniversaries };
}
