import { useEffect, useRef, useState } from 'react';
import type { LocalMessage } from '@/db/db';
import { searchMessages } from '@/lib/search';
import { useUiStore } from '@/state/uiStore';

/** Search within one chat (FR-7.4): newest match first, ↑/↓ or Enter to step through. */
export default function ChatSearchBar({ conversationId }: { conversationId: string }) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<LocalMessage[]>([]);
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const close = () => useUiStore.getState().setChatSearchOpen(false);

  useEffect(() => input.current?.focus(), []);

  useEffect(() => {
    let cancelled = false;
    void searchMessages(query, { conversationId, limit: 500 }).then((found) => {
      if (cancelled) return;
      setHits(found);
      setIndex(0);
      if (found[0]?.messageId) useUiStore.getState().jumpToMessage(found[0].messageId);
    });
    return () => {
      cancelled = true;
    };
  }, [query, conversationId]);

  function step(delta: number) {
    if (hits.length === 0) return;
    const next = (index + delta + hits.length) % hits.length;
    setIndex(next);
    const id = hits[next].messageId;
    if (id) useUiStore.getState().jumpToMessage(id);
  }

  return (
    <div className="flex items-center gap-2 border-b border-stroke bg-panel px-4 py-2">
      <input
        ref={input}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') close();
          if (e.key === 'Enter' || e.key === 'ArrowUp') { e.preventDefault(); step(1); }
          if (e.key === 'ArrowDown') { e.preventDefault(); step(-1); }
        }}
        placeholder="Search this chat"
        aria-label="Search this chat"
        className="flex-1 rounded-lg bg-panel-alt px-3 py-1.5 text-sm outline-none"
      />
      <span className="w-16 text-center text-xs text-text-secondary" aria-live="polite">
        {query.trim().length < 2 ? '' : hits.length ? `${index + 1} of ${hits.length}` : 'No results'}
      </span>
      <button onClick={() => step(1)} aria-label="Older match" className="rounded p-1 text-text-secondary hover:bg-panel-hover">▲</button>
      <button onClick={() => step(-1)} aria-label="Newer match" className="rounded p-1 text-text-secondary hover:bg-panel-hover">▼</button>
      <button onClick={close} aria-label="Close search" className="rounded p-1 text-text-secondary hover:bg-panel-hover">✕</button>
    </div>
  );
}
