import { useEffect, useMemo, useRef, useState } from 'react';
import { useUiStore } from '@/state/uiStore';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import {
  isSystemMessage,
  SYSTEM_GROUP_EVENT,
  SYSTEM_IDENTITY_CHANGED,
  type LocalMessage,
} from '@/db/db';
import { describeGroupEvent, type GroupEvent } from '@/lib/groupEvents';
import { formatDayDivider, isSameDay } from '@/lib/format';
import MessageBubble from './MessageBubble';

type Row =
  | { kind: 'divider'; key: string; timestamp: number }
  | { kind: 'message'; key: string; message: LocalMessage };

/**
 * Virtualised. A naive map over 50,000 messages is not a rendering choice, it is a crash.
 */
export default function MessageList({
  messages,
  selfUserId,
  isGroup,
  nameOf,
  onVerify,
}: {
  messages: LocalMessage[];
  selfUserId: string;
  isGroup: boolean;
  nameOf: (userId: string) => string;
  onVerify: (userId: string) => void;
}) {
  const virtuoso = useRef<VirtuosoHandle>(null);

  const rows = useMemo<Row[]>(() => {
    // Sort by seq, with pending messages (MAX_SAFE_INTEGER) naturally landing at the bottom,
    // then snapping into place when the ACK assigns a real sequence.
    // Outgoing control rows (reactions, edits, deletes waiting to send) are plumbing, not content.
    const ordered = messages
      .filter((m) => !m.control)
      .sort((a, b) => a.seq - b.seq || a.createdAt - b.createdAt);

    const result: Row[] = [];
    let previousTimestamp: number | null = null;

    for (const message of ordered) {
      if (previousTimestamp === null || !isSameDay(previousTimestamp, message.createdAt)) {
        result.push({
          kind: 'divider',
          key: `divider-${message.createdAt}`,
          timestamp: message.createdAt,
        });
      }
      result.push({ kind: 'message', key: message.clientMessageId, message });
      previousTimestamp = message.createdAt;
    }
    return result;
  }, [messages]);

  const selection = useUiStore((s) => s.selection);
  const jumpTo = useUiStore((s) => s.jumpTo);
  const [highlight, setHighlight] = useState<string | null>(null);

  // Tapping a quote (or a starred message) scrolls the original into view and flashes it.
  useEffect(() => {
    if (!jumpTo) return;
    const index = rows.findIndex((r) => r.kind === 'message' && r.message.messageId === jumpTo.messageId);
    if (index < 0) return;
    virtuoso.current?.scrollToIndex({ index, align: 'center', behavior: 'smooth' });
    setHighlight(jumpTo.messageId);
    const id = window.setTimeout(() => setHighlight(null), 1600);
    return () => window.clearTimeout(id);
    // rows is deliberately not a dependency: a new message arriving must not re-trigger the jump.
  }, [jumpTo]);

  if (rows.length === 0) {
    return (
      <div className="chat-wallpaper flex flex-1 items-center justify-center">
        <p className="max-w-sm rounded-lg bg-panel-alt/80 px-4 py-3 text-center text-sm text-text-secondary">
          No messages yet. Messages you send here are encrypted on this device before they leave it.
        </p>
      </div>
    );
  }

  return (
    <div className="chat-wallpaper flex-1 overflow-hidden">
      <Virtuoso
        ref={virtuoso}
        data={rows}
        followOutput="smooth"
        initialTopMostItemIndex={rows.length - 1}
        className="scrollbar-thin h-full"
        itemContent={(_index, row) =>
          row.kind === 'divider' ? (
            <div className="flex justify-center py-3">
              <span className="rounded-lg bg-panel-alt/90 px-3 py-1 text-xs text-text-secondary">
                {formatDayDivider(row.timestamp)}
              </span>
            </div>
          ) : isSystemMessage(row.message) ? (
            <SystemNotice
              message={row.message}
              selfUserId={selfUserId}
              nameOf={nameOf}
              onVerify={onVerify}
            />
          ) : (
            <MessageBubble
              message={row.message}
              outgoing={row.message.senderId === selfUserId}
              senderName={
                isGroup && row.message.senderId !== selfUserId
                  ? nameOf(row.message.senderId)
                  : undefined
              }
              selfUserId={selfUserId}
              nameOf={nameOf}
              selecting={selection !== null}
              selected={selection?.includes(row.message.clientMessageId) ?? false}
              highlighted={!!highlight && row.message.messageId === highlight}
            />
          )
        }
      />
    </div>
  );
}

/** Client-generated timeline notices; centred, never ticked, never sent. */
function SystemNotice({
  message,
  selfUserId,
  nameOf,
  onVerify,
}: {
  message: LocalMessage;
  selfUserId: string;
  nameOf: (userId: string) => string;
  onVerify: (userId: string) => void;
}) {
  if (message.contentType === SYSTEM_GROUP_EVENT) {
    let text: string;
    try {
      text = describeGroupEvent(JSON.parse(message.body) as GroupEvent, selfUserId, nameOf);
    } catch {
      return null;
    }
    return (
      <div className="flex justify-center px-4 py-1.5">
        <span className="max-w-md rounded-lg bg-panel-alt/90 px-3 py-1 text-center text-xs text-text-secondary">
          {text}
        </span>
      </div>
    );
  }
  if (message.contentType !== SYSTEM_IDENTITY_CHANGED) return null;
  return (
    <div className="flex justify-center px-4 py-2">
      <button
        onClick={() => onVerify(message.senderId)}
        className="flex max-w-md items-center gap-2 rounded-lg bg-panel-alt/90 px-3 py-1.5 text-center text-xs text-text-secondary hover:bg-panel-hover"
      >
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0 fill-amber-300" aria-hidden="true">
          <path d="M18 8h-1V6a5 5 0 0 0-10 0v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2ZM9 6a3 3 0 0 1 6 0v2H9V6Z" />
        </svg>
        <span>
          {nameOf(message.senderId)}&apos;s security code changed. Tap to verify.
        </span>
      </button>
    </div>
  );
}
