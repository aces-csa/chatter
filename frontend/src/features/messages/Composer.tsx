import { useEffect, useRef, useState } from 'react';
import { realtimeService } from '@/realtime/RealtimeService';
import { useUiStore } from '@/state/uiStore';
import { formatDuration } from '@/lib/media/labels';
import { useVoiceRecording } from '@/features/media/useVoiceRecording';
import { replyRefFor, snippetOf } from '@/lib/messageActions';

const MAX_ROWS = 6;

export default function Composer({
  conversationId,
  disabledReason = null,
  nameOf,
  mentionable = [],
}: {
  conversationId: string;
  /** When set, the composer is replaced by this explanation. */
  disabledReason?: string | null;
  nameOf: (userId: string) => string;
  /** Groups: members who can be @mentioned (everyone but you). */
  mentionable?: string[];
}) {
  const [draft, setDraft] = useState('');
  const [mentions, setMentions] = useState<string[]>([]);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const candidates =
    mentionQuery === null
      ? []
      : mentionable.filter((id) => nameOf(id).toLocaleLowerCase().startsWith(mentionQuery.toLocaleLowerCase())).slice(0, 6);

  function insertMention(userId: string) {
    const element = textarea.current;
    const caret = element?.selectionStart ?? draft.length;
    const before = draft.slice(0, caret).replace(/@([^\s@]*)$/, `@${nameOf(userId)} `);
    const next = before + draft.slice(caret);
    setDraft(next);
    setMentions((current) => [...new Set([...current, userId])]);
    setMentionQuery(null);
    requestAnimationFrame(() => {
      element?.focus();
      element?.setSelectionRange(before.length, before.length);
    });
  }
  const replyingTo = useUiStore((s) => s.replyingTo);
  const editing = useUiStore((s) => s.editing);
  const [editError, setEditError] = useState<string | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const filePicker = useRef<HTMLInputElement>(null);
  const voice = useVoiceRecording(conversationId);
  const attach = (files: FileList | File[] | null) =>
    useUiStore.getState().setPendingAttachments(files ? Array.from(files) : null);

  // FR-5.7: a pasted screenshot or file goes to the preview, not into the text box.
  function onPaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    if (event.clipboardData.files.length > 0) {
      event.preventDefault();
      attach(event.clipboardData.files);
    }
  }

  // Reset the draft when switching conversations, or you paste into the wrong chat.
  // Also stop typing in the chat we are leaving, or the indicator hangs there for its full TTL.
  useEffect(() => {
    setDraft('');
    return () => realtimeService.sendTyping(conversationId, 'stop');
  }, [conversationId]);

  useEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = 'auto';
    const lineHeight = 24;
    element.style.height = `${Math.min(element.scrollHeight, lineHeight * MAX_ROWS)}px`;
  }, [draft]);

  // Editing loads the message into the box; replying just focuses it.
  useEffect(() => {
    if (editing) setDraft(editing.body);
    if (editing || replyingTo) textarea.current?.focus();
  }, [editing, replyingTo]);

  function cancelMode() {
    if (editing) setDraft('');
    useUiStore.getState().setReplyingTo(null);
    useUiStore.getState().setEditing(null);
    setEditError(null);
  }

  // The "hold to record" hint fades on its own.
  useEffect(() => {
    if (!voice.error) return;
    const id = window.setTimeout(voice.clearError, 4000);
    return () => window.clearTimeout(id);
  }, [voice.error, voice.clearError]);

  async function send() {
    const body = draft.trim();
    if (!body) return;
    if (editing) {
      try {
        await realtimeService.editMessage(editing, body);
        setDraft('');
        useUiStore.getState().setEditing(null);
      } catch (e) {
        setEditError(e instanceof Error ? e.message : 'Could not edit that message.');
      }
      return;
    }
    const replyTo = replyingTo ? replyRefFor(replyingTo) : undefined;
    // Only mentions still present in the text count; deleting "@Sam" un-mentions Sam.
    const stillMentioned = mentions.filter((id) => body.includes(`@${nameOf(id)}`));
    setDraft(''); // clear first: the optimistic bubble is the feedback, not a spinner
    setMentions([]);
    setMentionQuery(null);
    useUiStore.getState().setReplyingTo(null);
    realtimeService.sendTyping(conversationId, 'stop');
    await realtimeService.composeText(conversationId, body, { replyTo, mentions: stillMentioned });
  }

  function onChange(event: React.ChangeEvent<HTMLTextAreaElement>) {
    const value = event.target.value;
    setDraft(value);
    if (mentionable.length > 0) {
      const match = /(?:^|\s)@([^\s@]*)$/.exec(value.slice(0, event.target.selectionStart ?? value.length));
      setMentionQuery(match ? match[1] : null);
    }
    // Throttled inside the service, so this is safe to call on every keystroke. An edit is not
    // new typing as far as the other person is concerned.
    if (!editing) realtimeService.sendTyping(conversationId, value.trim() ? 'start' : 'stop');
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (candidates.length > 0 && (event.key === 'Enter' || event.key === 'Tab')) {
      event.preventDefault();
      insertMention(candidates[0]);
      return;
    }
    // Enter sends, Shift+Enter is a newline. The opposite convention loses people messages.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send();
    } else if (event.key === 'Escape' && (editing || replyingTo)) {
      event.preventDefault();
      cancelMode();
    }
  }

  if (disabledReason) {
    return (
      <div className="border-t border-stroke bg-panel px-4 py-4 text-center text-sm text-text-secondary">
        {disabledReason}
      </div>
    );
  }

  const recording = voice.mode !== 'idle';
  const showMic = !draft.trim() && !editing;
  const quoted = editing ?? replyingTo;

  return (
    <div className="relative border-t border-stroke bg-panel px-4 py-2.5">
      {voice.error && (
        <p
          role="status"
          className="absolute -top-9 right-4 rounded-lg bg-panel-alt px-3 py-1.5 text-xs text-text-secondary shadow"
        >
          {voice.error}
        </p>
      )}
      {candidates.length > 0 && !recording && (
        <ul role="listbox" aria-label="Mention someone" className="mb-2 overflow-hidden rounded-lg border border-stroke bg-panel-alt">
          {candidates.map((id, i) => (
            <li key={id}>
              <button
                role="option"
                aria-selected={i === 0}
                onMouseDown={(e) => { e.preventDefault(); insertMention(id); }}
                className={`block w-full px-3 py-2 text-left text-sm hover:bg-panel-hover ${i === 0 ? 'bg-panel-hover' : ''}`}
              >
                @{nameOf(id)}
              </button>
            </li>
          ))}
        </ul>
      )}
      {quoted && !recording && (
        <div className="mb-2 flex items-center gap-2 rounded-lg border-l-4 border-accent bg-panel-alt px-3 py-2">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-accent">
              {editing ? 'Editing message' : `Replying to ${nameOf(quoted.senderId)}`}
            </p>
            <p className="truncate text-sm text-text-secondary">{snippetOf(quoted)}</p>
            {editError && <p className="text-xs text-red-300">{editError}</p>}
          </div>
          <button
            onClick={cancelMode}
            aria-label={editing ? 'Cancel editing' : 'Cancel reply'}
            className="shrink-0 rounded-full p-1 text-text-secondary hover:bg-panel-hover"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current" aria-hidden="true">
              <path d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z" />
            </svg>
          </button>
        </div>
      )}
      <div className="flex items-end gap-2">
        {recording ? (
          <RecordingBar
            elapsedMs={voice.elapsedMs}
            level={voice.level}
            dragPx={voice.dragPx}
            locked={voice.mode === 'locked'}
            onCancel={() => void voice.cancel()}
          />
        ) : (
          <>
            <AttachMenu
              onFiles={() => filePicker.current?.click()}
              onLocation={() => useUiStore.getState().setLocationOpen(true)}
            />
            <input
              ref={filePicker}
              type="file"
              multiple
              hidden
              onChange={(event) => {
                attach(event.target.files);
                event.target.value = ''; // picking the same file twice must fire again
              }}
            />
            <textarea
              onPaste={onPaste}
              ref={textarea}
              value={draft}
              onChange={onChange}
              onKeyDown={onKeyDown}
              rows={1}
              placeholder="Type a message"
              aria-label="Message"
              className="scrollbar-thin max-h-36 flex-1 resize-none rounded-lg bg-panel-alt px-4 py-2.5
                         text-[15px] outline-none placeholder:text-text-secondary/60"
            />
          </>
        )}

        {voice.mode === 'locked' ? (
          <button
            onClick={() => void voice.send()}
            aria-label="Send voice message"
            className="mb-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent text-white hover:brightness-110"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current" aria-hidden="true"><path d="M2 21l21-9L2 3v7l15 2-15 2z" /></svg>
          </button>
        ) : showMic || recording ? (
          <button
            {...voice.pointerHandlers}
            aria-label={recording ? 'Recording. Release to send' : 'Record voice message. Hold to record, tap to record hands-free'}
            title="Hold to record"
            // No text selection or scrolling while a finger is held on the mic.
            style={{ touchAction: 'none' }}
            className={`mb-0.5 flex h-10 w-10 shrink-0 select-none items-center justify-center rounded-full text-white transition ${
              recording ? 'scale-125 bg-red-500' : 'bg-accent hover:brightness-110'
            }`}
          >
            <MicIcon />
          </button>
        ) : (
          <button
            onClick={() => void send()}
            aria-label={editing ? 'Save edit' : 'Send message'}
            className="mb-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full
                       bg-accent text-white transition hover:brightness-110"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current" aria-hidden="true"><path d="M2 21l21-9L2 3v7l15 2-15 2z" /></svg>
          </button>
        )}
      </div>
    </div>
  );
}

function RecordingBar({
  elapsedMs,
  level,
  dragPx,
  locked,
  onCancel,
}: {
  elapsedMs: number;
  level: number;
  dragPx: number;
  locked: boolean;
  onCancel: () => void;
}) {
  return (
    <div className="flex h-11 flex-1 items-center gap-3 rounded-lg bg-panel-alt px-3" aria-live="polite">
      {locked ? (
        <button onClick={onCancel} aria-label="Discard voice message" className="rounded-full p-1.5 text-red-300 hover:bg-panel-hover">
          <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current" aria-hidden="true">
            <path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12ZM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4Z" />
          </svg>
        </button>
      ) : (
        <span className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-red-500" aria-hidden="true" />
      )}
      <span className="w-12 shrink-0 font-mono text-sm tabular-nums">{formatDuration(elapsedMs) || '0:00'}</span>
      {/* Live input meter: proof the microphone is actually hearing something. */}
      <span className="flex h-6 flex-1 items-center gap-0.5 overflow-hidden" aria-hidden="true">
        {Array.from({ length: 24 }, (_, i) => (
          <span
            key={i}
            className="w-1 rounded-full bg-accent/80 transition-[height]"
            style={{ height: `${Math.max(12, level * 100 * (0.6 + 0.4 * Math.sin(i + elapsedMs / 120)))}%` }}
          />
        ))}
      </span>
      {!locked && (
        <span
          className="shrink-0 text-xs text-text-secondary"
          style={{ transform: `translateX(${-Math.min(dragPx, 100)}px)`, opacity: 1 - Math.min(dragPx, 100) / 140 }}
        >
          ‹ Slide to cancel
        </span>
      )}
    </div>
  );
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current" aria-hidden="true">
      <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V21h2v-3.1a7 7 0 0 0 6-6.9h-2Z" />
    </svg>
  );
}

/** The paperclip: files and photos, or a location. */
function AttachMenu({ onFiles, onLocation }: { onFiles: () => void; onLocation: () => void }) {
  const [open, setOpen] = useState(false);
  const pick = (action: () => void) => () => {
    setOpen(false);
    action();
  };
  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        aria-label="Attach"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Attach"
        className="mb-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-text-secondary hover:bg-panel-hover"
      >
        <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current" aria-hidden="true">
          <path d="M16.5 6v11.5a4 4 0 0 1-8 0V5a2.5 2.5 0 0 1 5 0v10.5a1 1 0 0 1-2 0V6H10v9.5a2.5 2.5 0 0 0 5 0V5a4 4 0 0 0-8 0v12.5a5.5 5.5 0 0 0 11 0V6h-1.5Z" />
        </svg>
      </button>
      {open && (
        <div role="menu" className="absolute bottom-12 left-0 z-30 w-48 rounded-lg border border-stroke bg-panel-alt py-1 shadow-xl">
          <button role="menuitem" onClick={pick(onFiles)} className="block w-full px-4 py-2 text-left text-sm hover:bg-panel-hover">
            Photos &amp; files
          </button>
          <button role="menuitem" onClick={pick(onLocation)} className="block w-full px-4 py-2 text-left text-sm hover:bg-panel-hover">
            Location
          </button>
        </div>
      )}
    </div>
  );
}
