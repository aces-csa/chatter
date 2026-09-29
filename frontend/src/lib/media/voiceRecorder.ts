import { bufferToBase64 } from '@/lib/bytes';
import type { PreparedMedia } from './prepare';

/** Bars in a stored waveform. Enough to look like speech at bubble width; ~88 bytes base64. */
const WAVEFORM_BARS = 64;
/** A voice note is a message, not a podcast. Recording stops itself here. */
export const MAX_VOICE_MS = 15 * 60 * 1000;
/** Shorter than this is almost always a mis-tap on the mic, not something to send. */
export const MIN_VOICE_MS = 700;

/** Opus first (FR-5.4); MP4/AAC is the fallback for browsers whose MediaRecorder lacks Opus. */
const CANDIDATE_TYPES = [
  'audio/webm;codecs=opus',
  'audio/ogg;codecs=opus',
  'audio/mp4',
  'audio/webm',
];

export class MicrophoneUnavailableError extends Error {}

/**
 * One recording session: microphone -> MediaRecorder, with an analyser alongside that samples
 * loudness for the live meter and for the waveform stored with the note.
 */
export class VoiceRecorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private readonly chunks: Blob[] = [];
  private readonly levels: number[] = [];
  private sampler: number | null = null;
  private startedAt = 0;

  async start(): Promise<void> {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (error) {
      throw new MicrophoneUnavailableError(
        error instanceof DOMException && error.name === 'NotAllowedError'
          ? 'Microphone access was blocked. Allow it in the browser to record voice messages.'
          : 'No microphone is available.',
      );
    }

    const mimeType = CANDIDATE_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
    this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType, audioBitsPerSecond: 32_000 } : undefined);
    this.recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    };

    this.context = new AudioContext();
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 512;
    this.context.createMediaStreamSource(this.stream).connect(this.analyser);
    const samples = new Uint8Array(this.analyser.fftSize);
    this.sampler = window.setInterval(() => {
      this.analyser?.getByteTimeDomainData(samples);
      let peak = 0;
      for (const sample of samples) peak = Math.max(peak, Math.abs(sample - 128));
      this.levels.push(Math.min(1, peak / 100));
    }, 50);

    this.startedAt = performance.now();
    // Timeslices, so a very long note is not held as one giant buffer until the end.
    this.recorder.start(1000);
  }

  get elapsedMs(): number {
    return this.startedAt ? performance.now() - this.startedAt : 0;
  }

  /** Latest loudness, 0..1, for the live meter. */
  get level(): number {
    return this.levels[this.levels.length - 1] ?? 0;
  }

  /**
   * Stops and packages the note. Duration is measured here rather than read from the file:
   * MediaRecorder's WebM output carries no duration header, and the player needs one.
   */
  async finish(): Promise<PreparedMedia> {
    const durationMs = Math.round(this.elapsedMs);
    const blob = await this.stop();
    const mime = (this.recorder?.mimeType || blob.type || 'audio/webm').split(';')[0];
    return {
      blob,
      descriptor: {
        kind: 'audio',
        mime,
        name: `Voice message.${mime.includes('mp4') ? 'm4a' : mime.split('/')[1]}`,
        size: blob.size,
        durationMs,
        voice: true,
        waveform: this.waveform(),
      },
    };
  }

  /** Discards everything; nothing recorded leaves the device. */
  async cancel(): Promise<void> {
    await this.stop().catch(() => undefined);
    this.chunks.length = 0;
  }

  private stop(): Promise<Blob> {
    return new Promise((resolve) => {
      const done = () => {
        this.release();
        resolve(new Blob(this.chunks, { type: this.recorder?.mimeType || 'audio/webm' }));
      };
      if (this.recorder && this.recorder.state !== 'inactive') {
        this.recorder.onstop = done;
        this.recorder.stop();
      } else {
        done();
      }
    });
  }

  /** Mic light off as soon as we are done with it, whichever way the session ended. */
  private release(): void {
    if (this.sampler !== null) window.clearInterval(this.sampler);
    this.sampler = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    void this.context?.close().catch(() => undefined);
    this.stream = null;
    this.context = null;
  }

  /** Buckets the sampled levels into a fixed number of bars, normalised to the loudest. */
  private waveform(): string {
    const bars = new Uint8Array(WAVEFORM_BARS);
    if (this.levels.length > 0) {
      const perBar = this.levels.length / WAVEFORM_BARS;
      const peaks = Array.from({ length: WAVEFORM_BARS }, (_, i) => {
        const slice = this.levels.slice(Math.floor(i * perBar), Math.max(Math.floor((i + 1) * perBar), Math.floor(i * perBar) + 1));
        return slice.length ? Math.max(...slice) : 0;
      });
      const loudest = Math.max(...peaks, 0.05);
      peaks.forEach((peak, i) => {
        bars[i] = Math.round((peak / loudest) * 255);
      });
    }
    return bufferToBase64(bars.buffer as ArrayBuffer);
  }
}

export function decodeWaveform(encoded: string | undefined): number[] {
  if (!encoded) return Array.from({ length: WAVEFORM_BARS }, () => 0.15);
  return Array.from(atob(encoded), (char) => Math.max(0.08, char.charCodeAt(0) / 255));
}
