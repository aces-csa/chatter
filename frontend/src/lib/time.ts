/**
 * Turns a server timestamp into epoch millis, defensively.
 *
 * <p>Accepts ISO-8601 strings (what the API sends) and raw epoch numbers (what a
 * misconfigured serialiser sends, as we found out the hard way). Crucially it never returns
 * NaN: Dexie's `orderBy` silently skips records whose indexed value is NaN, so one bad parse
 * makes a conversation disappear from the list with no error anywhere.
 */
export function toEpochMillis(value: string | number | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined;
    // Heuristic: anything below this is implausible as millis and is almost certainly seconds.
    return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}
