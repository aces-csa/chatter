import { useEffect, useRef, useState } from 'react';
import type { LocalMessage } from '@/db/db';
import {
  canEdit,
  canForward,
  canReact,
  canReply,
  MORE_REACTIONS,
  QUICK_REACTIONS,
} from '@/lib/messageActions';
import { realtimeService } from '@/realtime/RealtimeService';
import { useUiStore } from '@/state/uiStore';

/**
 * The per-message menu: quick reactions on top, then Reply, Copy, Forward, Star, Edit, Delete,
 * Select. Opened from a chevron that appears on hover or keyboard focus.
 */
export default function MessageActions({
  message,
  selfUserId,
  outgoing,
}: {
  message: LocalMessage;
  selfUserId: string;
  outgoing: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [moreEmoji, setMoreEmoji] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const ui = useUiStore.getState;

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const act = (fn: () => void) => () => {
    setOpen(false);
    setMoreEmoji(false);
    fn();
  };
  const mine = message.reactions?.[selfUserId];

  const items: Array<{ label: string; run: () => void; show: boolean; danger?: boolean }> = [
    { label: 'Reply', show: canReply(message), run: () => ui().setReplyingTo(message) },
    {
      label: 'Copy',
      show: !!message.body && !message.deletedForAll,
      run: () => void navigator.clipboard?.writeText(message.body),
    },
    { label: 'Forward', show: canForward(message), run: () => ui().setForwarding([message]) },
    {
      label: message.starredAt ? 'Unstar' : 'Star',
      show: !message.deletedForAll,
      run: () => void realtimeService.toggleStar([message]),
    },
    { label: 'Edit', show: canEdit(message, selfUserId), run: () => ui().setEditing(message) },
    {
      label: 'Info',
      show: message.senderId === selfUserId && !!message.messageId && !message.deletedForAll,
      run: () => ui().setMessageInfo(message),
    },
    { label: 'Select', show: true, run: () => ui().setSelection([message.clientMessageId]) },
    { label: 'Delete', show: true, danger: true, run: () => ui().setDeleting([message]) },
  ];

  return (
    <div
      ref={root}
      className={`absolute top-1 z-10 ${outgoing ? 'left-1' : 'right-1'} ${
        open ? 'opacity-100' : 'opacity-0 focus-within:opacity-100 group-hover:opacity-100'
      }`}
    >
      <button
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Message options"
        className="rounded-full bg-black/30 p-0.5 text-text-secondary hover:text-text-primary"
      >
        <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current" aria-hidden="true">
          <path d="m7 10 5 5 5-5z" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          className={`absolute top-6 z-40 w-56 rounded-lg border border-stroke bg-panel-alt py-1 shadow-xl ${
            outgoing ? 'right-0' : 'left-0'
          }`}
        >
          {canReact(message) && (
            <div className="border-b border-stroke px-2 pb-1.5 pt-1">
              <div className="flex items-center justify-between">
                {QUICK_REACTIONS.map((emoji) => (
                  <button
                    key={emoji}
                    role="menuitem"
                    onClick={act(() => void realtimeService.react(message, emoji))}
                    aria-label={`React with ${emoji}`}
                    aria-pressed={mine === emoji}
                    className={`rounded-full p-1 text-xl leading-none hover:bg-panel-hover ${
                      mine === emoji ? 'bg-panel-hover' : ''
                    }`}
                  >
                    {emoji}
                  </button>
                ))}
                <button
                  onClick={() => setMoreEmoji(!moreEmoji)}
                  aria-label="More reactions"
                  aria-expanded={moreEmoji}
                  className="rounded-full px-2 py-1 text-text-secondary hover:bg-panel-hover"
                >
                  +
                </button>
              </div>
              {moreEmoji && (
                <div className="mt-1 grid grid-cols-6 gap-0.5">
                  {MORE_REACTIONS.map((emoji) => (
                    <button
                      key={emoji}
                      onClick={act(() => void realtimeService.react(message, emoji))}
                      aria-label={`React with ${emoji}`}
                      className="rounded p-1 text-lg leading-none hover:bg-panel-hover"
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {items
            .filter((item) => item.show)
            .map((item) => (
              <button
                key={item.label}
                role="menuitem"
                onClick={act(item.run)}
                className={`block w-full px-4 py-2 text-left text-sm hover:bg-panel-hover ${
                  item.danger ? 'text-red-300' : ''
                }`}
              >
                {item.label}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
