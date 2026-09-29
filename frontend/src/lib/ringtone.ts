/** A synthesised ring, so there is no audio asset to ship. Repeats until stopped. */
let context: AudioContext | null = null;
let timer: number | null = null;

function ringOnce(): void {
  try {
    context ??= new AudioContext();
    const now = context.currentTime;
    for (let i = 0; i < 2; i += 1) {
      const osc = context.createOscillator();
      const gain = context.createGain();
      osc.frequency.value = i === 0 ? 480 : 620;
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.12, now + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.9);
      osc.connect(gain).connect(context.destination);
      osc.start(now);
      osc.stop(now + 1);
    }
  } catch {
    // Autoplay policy may block audio until the user has interacted with the page.
  }
}

export function startRingtone(): void {
  if (timer !== null) return;
  ringOnce();
  timer = window.setInterval(ringOnce, 2_500);
}

export function stopRingtone(): void {
  if (timer !== null) window.clearInterval(timer);
  timer = null;
}
