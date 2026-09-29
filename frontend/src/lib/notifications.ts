import { db, getMeta, setMeta, type LocalMessage } from '@/db/db';
import { api } from '@/lib/api';
import { mediaPreview } from '@/lib/media/labels';
import { inQuietHours } from '@/lib/quietHours';

/**
 * Notifications on this device: Web Push when the tab is closed (FR-8.1), and in-page alerts
 * with a sound when it is open but not looking at that chat (FR-8.2). One switch turns both off
 * for this device (FR-8.3 global mute); per-chat mute is a server-side setting.
 */

const ENABLED_KEY = 'notificationsEnabled';

export function notificationsSupported(): boolean {
  return 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;
}

export async function notificationsEnabled(): Promise<boolean> {
  return (await getMeta<boolean>(ENABLED_KEY)) !== false;
}

let registration: Promise<ServiceWorkerRegistration> | null = null;
function serviceWorker(): Promise<ServiceWorkerRegistration> {
  registration ??= navigator.serviceWorker.register('/sw.js', { scope: '/' });
  return registration;
}

function urlBase64ToBytes(base64: string): Uint8Array {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

/**
 * Makes sure this device is subscribed. Idempotent, and cheap when already subscribed, so it
 * runs on every start: browsers occasionally rotate subscriptions behind our back.
 */
export async function ensurePushSubscription(): Promise<void> {
  if (!notificationsSupported() || Notification.permission !== 'granted') return;
  if (!(await notificationsEnabled())) return;
  const sw = await serviceWorker();
  let subscription = await sw.pushManager.getSubscription();
  if (!subscription) {
    const { publicKey } = await api.vapidPublicKey();
    subscription = await sw.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToBytes(publicKey).buffer as ArrayBuffer,
    });
  }
  const json = subscription.toJSON();
  await api.subscribePush({
    endpoint: subscription.endpoint,
    keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' },
  });
}

/** Must be called from a click: browsers only show the permission prompt for a user gesture. */
export async function enableNotifications(): Promise<NotificationPermission> {
  const permission = await Notification.requestPermission();
  if (permission === 'granted') {
    await setMeta(ENABLED_KEY, true);
    await ensurePushSubscription();
  }
  return permission;
}

/** Turns this device's notifications off, including telling the server to stop pushing. */
export async function disableNotifications(): Promise<void> {
  await setMeta(ENABLED_KEY, false);
  if (!notificationsSupported()) return;
  const subscription = await (await serviceWorker()).pushManager.getSubscription();
  if (subscription) {
    await api.unsubscribePush(subscription.endpoint).catch(() => undefined);
    await subscription.unsubscribe().catch(() => undefined);
  }
}

/** Sign-out: the next person to use this browser must not receive the last one's pushes. */
export async function dropPushSubscription(): Promise<void> {
  if (!notificationsSupported()) return;
  const subscription = await (await navigator.serviceWorker.getRegistration('/'))?.pushManager.getSubscription();
  if (subscription) {
    await api.unsubscribePush(subscription.endpoint).catch(() => undefined);
    await subscription.unsubscribe().catch(() => undefined);
  }
}

export function isMuted(mutedUntil: number | undefined): boolean {
  return !!mutedUntil && mutedUntil > Date.now();
}

/**
 * A live message arrived while the tab is open. Sound if the user is not looking at that chat;
 * a system notification too if the tab is in the background. Here, unlike in the service worker,
 * the text is available -- it was decrypted on this device -- so the notification can show it.
 */
export async function notifyIncoming(
  message: LocalMessage,
  activeConversationId: string | null,
  selfUserId: string | null,
): Promise<void> {
  const looking = !document.hidden && activeConversationId === message.conversationId;
  if (looking || !(await notificationsEnabled()) || (await inQuietHours())) return;

  const conversation = await db.conversations.get(message.conversationId);
  const mentioned = !!selfUserId && (message.mentions?.includes(selfUserId) ?? false);
  // FR-4.7: an @mention gets through a muted group.
  if (!conversation || (isMuted(conversation.mutedUntil) && !mentioned)) return;

  playChime();

  if (!document.hidden || !notificationsSupported() || Notification.permission !== 'granted') return;
  const sender = await db.users.get(message.senderId);
  const senderName = sender?.displayName ?? 'Someone';
  const text = message.undecryptable
    ? 'New message'
    : message.media
      ? mediaPreview(message.media, message.body)
      : message.body;
  const group = conversation.type === 'GROUP';
  await (await serviceWorker()).showNotification(group ? conversation.subject ?? 'Group' : senderName, {
    body: group ? `${mentioned ? '@you · ' : ''}${senderName}: ${text}` : text,
    tag: message.conversationId,
    data: { conversationId: message.conversationId },
    // FR-8.3: reply without opening the app, where the platform supports inline replies.
    actions: [{ action: 'reply', title: 'Reply', type: 'text', placeholder: 'Reply' }],
  } as NotificationOptions);
}

let audio: AudioContext | null = null;
/** A short two-tone chime, synthesised: no audio asset to ship or cache. */
function playChime(): void {
  try {
    audio ??= new AudioContext();
    const now = audio.currentTime;
    [880, 1320].forEach((frequency, i) => {
      const osc = audio!.createOscillator();
      const gain = audio!.createGain();
      osc.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, now + i * 0.12);
      gain.gain.exponentialRampToValueAtTime(0.15, now + i * 0.12 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.12 + 0.25);
      osc.connect(gain).connect(audio!.destination);
      osc.start(now + i * 0.12);
      osc.stop(now + i * 0.12 + 0.3);
    });
  } catch {
    // Autoplay policy may block audio before the first user interaction; silence is fine.
  }
}
