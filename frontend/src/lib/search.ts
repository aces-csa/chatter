import { db, type LocalMessage } from '@/db/db';

/**
 * Message search, entirely on this device (FR-7.4). Under end-to-end encryption the server holds
 * only ciphertext, so there is nowhere else it could run.
 *
 * <p>A scan rather than an index: IndexedDB has no full-text index, and at personal-archive
 * scale (tens of thousands of messages) a filtered cursor answers in well under a second. The
 * upgrade path at larger scale is a client-side inverted index (FlexSearch) built incrementally.
 */
export async function searchMessages(
  query: string,
  options: { conversationId?: string; limit?: number } = {},
): Promise<LocalMessage[]> {
  const needle = query.trim().toLocaleLowerCase();
  if (needle.length < 2) return [];
  const limit = options.limit ?? 50;
  const source = options.conversationId
    ? db.messages.where('conversationId').equals(options.conversationId)
    : db.messages.toCollection();
  const matches = await source
    .filter(
      (m) =>
        !m.control &&
        !m.deletedForAll &&
        !m.undecryptable &&
        !m.contentType.startsWith('system/') &&
        (m.body.toLocaleLowerCase().includes(needle) ||
          (m.media?.name?.toLocaleLowerCase().includes(needle) ?? false)),
    )
    .toArray();
  return matches.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

/** Splits text around a query so the match can be highlighted without HTML injection. */
export function highlight(text: string, query: string): Array<{ text: string; hit: boolean }> {
  const needle = query.trim();
  if (!needle) return [{ text, hit: false }];
  const parts: Array<{ text: string; hit: boolean }> = [];
  const lower = text.toLocaleLowerCase();
  const n = needle.toLocaleLowerCase();
  let from = 0;
  for (let i = lower.indexOf(n); i >= 0; i = lower.indexOf(n, from)) {
    if (i > from) parts.push({ text: text.slice(from, i), hit: false });
    parts.push({ text: text.slice(i, i + n.length), hit: true });
    from = i + n.length;
  }
  if (from < text.length) parts.push({ text: text.slice(from), hit: false });
  return parts;
}
