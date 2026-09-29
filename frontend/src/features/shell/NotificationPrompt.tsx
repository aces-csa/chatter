import { useState } from 'react';
import { enableNotifications, notificationsSupported } from '@/lib/notifications';

const DISMISSED_KEY = 'chatter.notificationPromptDismissed';

function dismissedBefore(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Browsers only show the permission prompt in response to a click, so we ask with a banner
 * rather than on load -- which is also the polite way to ask.
 */
export default function NotificationPrompt() {
  const [hidden, setHidden] = useState(
    () => !notificationsSupported() || Notification.permission !== 'default' || dismissedBefore(),
  );
  if (hidden) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISSED_KEY, '1');
    } catch {
      // Private window: the banner simply comes back next time.
    }
    setHidden(true);
  };

  return (
    <div className="flex items-center gap-3 bg-sky-900/40 px-4 py-3 text-sm">
      <svg viewBox="0 0 24 24" className="h-8 w-8 shrink-0 fill-sky-300" aria-hidden="true">
        <path d="M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2Zm6-6v-5c0-3.1-1.6-5.6-4.5-6.3V4a1.5 1.5 0 0 0-3 0v.7C7.6 5.4 6 7.9 6 11v5l-2 2v1h16v-1l-2-2Z" />
      </svg>
      <div className="min-w-0 flex-1">
        <p className="font-medium">Get notified of new messages</p>
        <button
          onClick={() => void enableNotifications().finally(() => setHidden(true))}
          className="text-sky-300 hover:underline"
        >
          Turn on desktop notifications ›
        </button>
      </div>
      <button onClick={dismiss} aria-label="Dismiss" className="shrink-0 p-1 text-text-secondary hover:text-text-primary">
        <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current" aria-hidden="true">
          <path d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z" />
        </svg>
      </button>
    </div>
  );
}
