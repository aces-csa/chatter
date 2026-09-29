import type { LocalMessage, MessageState } from '@/db/db';
import { formatMessageTime } from '@/lib/format';
import { realtimeService } from '@/realtime/RealtimeService';
import { useUiStore } from '@/state/uiStore';
import TimerIcon from './TimerIcon';
import MediaView from '@/features/media/MediaView';
import MessageActions from './MessageActions';
import LocationCard from '@/features/location/LocationCard';

export default function MessageBubble({
  message,
  outgoing,
  senderName,
  selfUserId,
  nameOf,
  selecting,
  selected,
  highlighted,
}: {
  message: LocalMessage;
  outgoing: boolean;
  /** Groups only: who sent an incoming message. */
  senderName?: string;
  selfUserId: string;
  nameOf: (userId: string) => string;
  /** Selection mode: a click toggles selection instead of doing anything else. */
  selecting: boolean;
  selected: boolean;
  /** Just jumped to from a quote or the starred list. */
  highlighted: boolean;
}) {
  const toggle = () => useUiStore.getState().toggleSelected(message.clientMessageId);

  return (
    <div
      className={`flex items-start gap-2 px-4 py-0.5 transition-colors ${
        highlighted ? 'bg-accent/15' : selected ? 'bg-accent/10' : ''
      } ${outgoing ? 'justify-end' : 'justify-start'} ${selecting ? 'cursor-pointer' : ''}`}
      onClick={selecting ? toggle : undefined}
    >
      {selecting && (
        <input
          type="checkbox"
          checked={selected}
          onChange={toggle}
          onClick={(event) => event.stopPropagation()}
          aria-label="Select message"
          className={`mt-2 h-4 w-4 accent-accent ${outgoing ? 'order-first mr-auto' : ''}`}
        />
      )}
      <div className={`flex max-w-[min(65ch,75%)] flex-col ${outgoing ? 'items-end' : 'items-start'}`}>
        <div
          className={`group relative rounded-lg px-2.5 py-1.5 text-[15px] leading-snug shadow-sm ${
            outgoing ? 'bg-bubble-out' : 'bg-bubble'
          }`}
        >
          {!selecting && !message.control && (
            <MessageActions message={message} selfUserId={selfUserId} outgoing={outgoing} />
          )}

          {senderName && <p className="mb-0.5 text-xs font-medium text-accent">{senderName}</p>}

          {message.deletedForAll ? (
            <p className="flex items-center gap-1.5 pr-14 italic text-text-secondary">
              <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 fill-current" aria-hidden="true">
                <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20ZM4 12a8 8 0 0 1 12.9-6.3L5.7 16.9A8 8 0 0 1 4 12Zm8 8a8 8 0 0 1-4.9-1.7L18.3 7.1A8 8 0 0 1 12 20Z" />
              </svg>
              {outgoing ? 'You deleted this message' : 'This message was deleted'}
            </p>
          ) : (
            <>
              {message.forwarded && (
                <p className="mb-0.5 flex items-center gap-1 text-xs italic text-text-secondary">
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-current" aria-hidden="true">
                    <path d="M14 9V5l7 7-7 7v-4.1c-5 0-8.5 1.6-11 5.1 1-5 4-10 11-11Z" />
                  </svg>
                  Forwarded
                </p>
              )}
              {message.replyTo && (
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    useUiStore.getState().jumpToMessage(message.replyTo!.messageId);
                  }}
                  className="mb-1 block w-full rounded-md border-l-4 border-accent bg-black/20 px-2 py-1 text-left"
                  aria-label={`Replying to ${nameOf(message.replyTo.senderId)}. Go to original message`}
                >
                  <span className="block text-xs font-medium text-accent">
                    {message.replyTo.senderId === selfUserId ? 'You' : nameOf(message.replyTo.senderId)}
                  </span>
                  <span className="line-clamp-2 text-xs text-text-secondary">{message.replyTo.preview}</span>
                </button>
              )}
              {message.media && !message.undecryptable && <MediaView message={message} outgoing={outgoing} />}
              {message.location && !message.undecryptable && (
                <LocationCard message={message} outgoing={outgoing} />
              )}
              {message.undecryptable ? (
                <p className="flex items-center gap-1.5 italic text-text-secondary">
                  <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 fill-current" aria-hidden="true">
                    <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm1 15h-2v-2h2Zm0-4h-2V7h2Z" />
                  </svg>
                  Waiting for this message
                </p>
              ) : message.body ? (
                <p className={`whitespace-pre-wrap break-words ${message.editedAt ? 'pr-24' : 'pr-14'}`}>
                  <MentionText body={message.body} mentions={message.mentions} nameOf={nameOf} selfUserId={selfUserId} />
                </p>
              ) : (
                // Uncaptioned attachment: keep a line for the timestamp so it does not sit on the image.
                <div className="h-4" aria-hidden="true" />
              )}
            </>
          )}

          <span
            className="absolute bottom-1 right-2 flex items-center gap-1 text-[11px] text-text-secondary/80"
            aria-label={`Sent at ${formatMessageTime(message.createdAt)}, ${describeState(message.state)}${
              message.editedAt ? ', edited' : ''
            }${message.starredAt ? ', starred' : ''}`}
          >
            {message.starredAt && (
              <svg viewBox="0 0 24 24" className="h-3 w-3 fill-current" aria-hidden="true">
                <path d="m12 17.3 6.2 3.7-1.6-7L22 9.2l-7.2-.6L12 2 9.2 8.6 2 9.2 7.4 14l-1.6 7z" />
              </svg>
            )}
            {message.expiresAt && <TimerIcon className="h-3 w-3 fill-current" />}
            {message.editedAt && !message.deletedForAll && <span className="italic">edited</span>}
            {formatMessageTime(message.createdAt)}
            {outgoing && !message.deletedForAll && <Ticks state={message.state} />}
          </span>

          {message.state === 'FAILED' && (
            <button
              onClick={() => void realtimeService.retry(message.clientMessageId)}
              className="mt-1 block text-xs font-medium text-red-300 underline"
            >
              Not delivered — tap to retry
            </button>
          )}
        </div>

        <Reactions message={message} selfUserId={selfUserId} nameOf={nameOf} />
      </div>
    </div>
  );
}

/** Grouped chips under the bubble; tapping one reacts with it, or takes back your own. */
function Reactions({
  message,
  selfUserId,
  nameOf,
}: {
  message: LocalMessage;
  selfUserId: string;
  nameOf: (userId: string) => string;
}) {
  const entries = Object.entries(message.reactions ?? {});
  if (entries.length === 0 || message.deletedForAll) return null;

  const byEmoji = new Map<string, string[]>();
  for (const [userId, emoji] of entries) {
    byEmoji.set(emoji, [...(byEmoji.get(emoji) ?? []), userId]);
  }

  return (
    <div className="-mt-1.5 flex flex-wrap gap-1 px-1">
      {[...byEmoji.entries()].map(([emoji, userIds]) => {
        const mine = userIds.includes(selfUserId);
        const who = userIds.map((id) => (id === selfUserId ? 'You' : nameOf(id))).join(', ');
        return (
          <button
            key={emoji}
            onClick={(event) => {
              event.stopPropagation();
              void realtimeService.react(message, emoji);
            }}
            title={who}
            aria-label={`${emoji} from ${who}${mine ? '. Tap to remove yours' : ''}`}
            className={`flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs shadow ${
              mine ? 'border-accent bg-accent/20' : 'border-stroke bg-panel-alt'
            }`}
          >
            <span className="text-sm leading-none">{emoji}</span>
            {userIds.length > 1 && <span>{userIds.length}</span>}
          </button>
        );
      })}
    </div>
  );
}

function describeState(state: MessageState): string {
  switch (state) {
    case 'PENDING':
      return 'sending';
    case 'SENT':
      return 'sent';
    case 'DELIVERED':
      return 'delivered';
    case 'READ':
      return 'read';
    case 'FAILED':
      return 'not delivered';
  }
}

/** Clock, one tick, two ticks, two blue ticks -- the whole delivery story in 14 pixels. */
function Ticks({ state }: { state: MessageState }) {
  if (state === 'FAILED') {
    return (
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-red-400" aria-hidden="true">
        <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm.7 10.5h-1.4v-1.4h1.4Zm0-2.8h-1.4V4.5h1.4Z" />
      </svg>
    );
  }

  if (state === 'PENDING') {
    return (
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-current opacity-70" aria-hidden="true">
        <path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Zm0 11.8A5.3 5.3 0 1 1 8 2.7a5.3 5.3 0 0 1 0 10.6ZM8.4 4.8h-.9v3.6l3.1 1.9.5-.8-2.7-1.6Z" />
      </svg>
    );
  }

  const read = state === 'READ';
  return (
    <svg
      viewBox="0 0 18 12"
      className={`h-3.5 w-4 ${read ? 'fill-sky-400' : 'fill-current opacity-70'}`}
      aria-hidden="true"
    >
      <path d="M5.6 10.6.9 5.9l1-1 3.7 3.7L12.2.9l1 1z" />
      {state !== 'SENT' && <path d="M10.6 10.6 5.9 5.9l1-1 3.7 3.7L17.2.9l1 1z" />}
    </svg>
  );
}

/** Renders "@Name" for mentioned users as highlighted text (no HTML, so nothing to inject). */
function MentionText({
  body,
  mentions,
  nameOf,
  selfUserId,
}: {
  body: string;
  mentions?: string[];
  nameOf: (userId: string) => string;
  selfUserId: string;
}) {
  if (!mentions?.length) return <>{body}</>;
  const tokens = mentions.map((id) => ({ id, text: `@${nameOf(id)}` }));
  const parts: Array<{ text: string; id?: string }> = [];
  let rest = body;
  while (rest) {
    let best: { index: number; token: (typeof tokens)[number] } | null = null;
    for (const token of tokens) {
      const index = rest.indexOf(token.text);
      if (index >= 0 && (!best || index < best.index)) best = { index, token };
    }
    if (!best) {
      parts.push({ text: rest });
      break;
    }
    if (best.index > 0) parts.push({ text: rest.slice(0, best.index) });
    parts.push({ text: best.token.text, id: best.token.id });
    rest = rest.slice(best.index + best.token.text.length);
  }
  return (
    <>
      {parts.map((part, i) =>
        part.id ? (
          <span key={i} className={`font-medium ${part.id === selfUserId ? 'rounded bg-accent/25 px-0.5 text-accent' : 'text-accent'}`}>
            {part.text}
          </span>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}
