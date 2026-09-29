/** Stopwatch: marks disappearing messages and the chat-level timer. */
export default function TimerIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path d="M15 1H9v2h6V1Zm-4 13h2V8h-2v6Zm8-6.6 1.4-1.4c-.4-.5-.9-1-1.4-1.4L17.6 6A9 9 0 1 0 19 7.4ZM12 21a7 7 0 1 1 0-14 7 7 0 0 1 0 14Z" />
    </svg>
  );
}
