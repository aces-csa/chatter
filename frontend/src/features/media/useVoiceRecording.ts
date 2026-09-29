import { useCallback, useEffect, useRef, useState } from 'react';
import {
  MAX_VOICE_MS,
  MicrophoneUnavailableError,
  MIN_VOICE_MS,
  VoiceRecorder,
} from '@/lib/media/voiceRecorder';
import { realtimeService } from '@/realtime/RealtimeService';
import { useUiStore } from '@/state/uiStore';
import { replyRefFor } from '@/lib/messageActions';

/** 'holding': finger/mouse down, release sends. 'locked': recording hands-free, buttons decide. */
export type RecordingMode = 'idle' | 'holding' | 'locked';

/** A press released sooner than this is a tap, and a tap locks recording on. */
const TAP_MS = 300;
/** Drag this far left while holding and the note is thrown away. */
const CANCEL_DRAG_PX = 100;
/** Resent while recording; the peer's indicator lapses 5 s after the last one. */
const INDICATOR_EVERY_MS = 3_000;

/**
 * Hold-to-record (FR-5.4) with WhatsApp's gestures: hold and release to send, slide left to
 * cancel, tap -- or use the keyboard -- to record hands-free with explicit Send and Discard.
 */
export function useVoiceRecording(conversationId: string) {
  const [mode, setMode] = useState<RecordingMode>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [level, setLevel] = useState(0);
  const [dragPx, setDragPx] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const recorder = useRef<VoiceRecorder | null>(null);
  const pressedAt = useRef(0);
  const startX = useRef(0);
  const modeRef = useRef<RecordingMode>('idle');
  modeRef.current = mode;

  const reset = useCallback(() => {
    recorder.current = null;
    setMode('idle');
    setElapsedMs(0);
    setLevel(0);
    setDragPx(0);
    realtimeService.sendTyping(conversationId, 'stop');
  }, [conversationId]);

  const cancel = useCallback(async () => {
    const active = recorder.current;
    reset();
    await active?.cancel();
  }, [reset]);

  const send = useCallback(async () => {
    const active = recorder.current;
    if (!active) return;
    const tooShort = active.elapsedMs < MIN_VOICE_MS;
    reset();
    if (tooShort) {
      await active.cancel();
      setError('Hold to record, release to send');
      return;
    }
    const prepared = await active.finish();
    const replyingTo = useUiStore.getState().replyingTo;
    useUiStore.getState().setReplyingTo(null);
    await realtimeService.composeMedia(conversationId, prepared, '', {
      replyTo: replyingTo ? replyRefFor(replyingTo) : undefined,
    });
  }, [conversationId, reset]);

  const start = useCallback(
    async (next: RecordingMode) => {
      setError(null);
      const session = new VoiceRecorder();
      recorder.current = session;
      setMode(next);
      try {
        await session.start();
      } catch (e) {
        reset();
        setError(e instanceof MicrophoneUnavailableError ? e.message : 'Could not start recording.');
        return;
      }
      // Released before the microphone even opened: treat it as the tap it was.
      if (recorder.current !== session) await session.cancel();
    },
    [reset],
  );

  // Timer, meter, the peer's "recording audio…" indicator, and the length cap.
  useEffect(() => {
    if (mode === 'idle') return;
    realtimeService.sendTyping(conversationId, 'recording');
    let lastIndicator = Date.now();
    const tick = window.setInterval(() => {
      const session = recorder.current;
      if (!session) return;
      setElapsedMs(session.elapsedMs);
      setLevel(session.level);
      if (Date.now() - lastIndicator > INDICATOR_EVERY_MS) {
        realtimeService.sendTyping(conversationId, 'recording');
        lastIndicator = Date.now();
      }
      if (session.elapsedMs >= MAX_VOICE_MS) void send();
    }, 100);
    return () => window.clearInterval(tick);
  }, [mode, conversationId, send]);

  // Leaving the chat mid-recording discards it; a note must never land in the wrong chat.
  useEffect(() => () => void recorder.current?.cancel(), [conversationId]);

  const pointerHandlers = {
    onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0 || modeRef.current !== 'idle') return;
      event.currentTarget.setPointerCapture(event.pointerId);
      pressedAt.current = Date.now();
      startX.current = event.clientX;
      void start('holding');
    },
    onPointerMove: (event: React.PointerEvent<HTMLButtonElement>) => {
      if (modeRef.current !== 'holding') return;
      const dragged = Math.max(0, startX.current - event.clientX);
      setDragPx(dragged);
      if (dragged > CANCEL_DRAG_PX) void cancel();
    },
    onPointerUp: () => {
      if (modeRef.current !== 'holding') return;
      if (Date.now() - pressedAt.current < TAP_MS) {
        setMode('locked');
        setDragPx(0);
      } else {
        void send();
      }
    },
    onPointerCancel: () => {
      if (modeRef.current === 'holding') void cancel();
    },
    /** Keyboard activation (Enter/Space) arrives as a click with no pointer: record hands-free. */
    onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
      if (event.detail === 0 && modeRef.current === 'idle') void start('locked');
    },
  };

  return { mode, elapsedMs, level, dragPx, error, clearError: () => setError(null), send, cancel, pointerHandlers };
}
