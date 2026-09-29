const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const dateFormat = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

function startOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Today shows a time, this week a weekday, older a date -- the chat-list convention. */
export function formatListTimestamp(timestamp: number): string {
  const today = startOfDay(Date.now());
  if (timestamp >= today) return timeFormat.format(timestamp);
  if (timestamp >= today - 6 * 86_400_000) return dayFormat.format(timestamp);
  return dateFormat.format(timestamp);
}

export function formatMessageTime(timestamp: number): string {
  return timeFormat.format(timestamp);
}

export function formatDayDivider(timestamp: number): string {
  const today = startOfDay(Date.now());
  if (timestamp >= today) return 'Today';
  if (timestamp >= today - 86_400_000) return 'Yesterday';
  return dateFormat.format(timestamp);
}

export function isSameDay(a: number, b: number): boolean {
  return startOfDay(a) === startOfDay(b);
}
