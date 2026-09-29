/* Chatter service worker: Web Push (FR-8.1).
 *
 * Pushes carry ids only -- the server never has message content. Names come from the app's own
 * IndexedDB ("chatter", written by Dexie), so a notification reads "Alice in Weekend plans"
 * without any of that ever passing through the server or the browser vendor's push service.
 */

// --- Offline shell (FR-9.1) ----------------------------------------------------------------------
// The app renders from IndexedDB, so once the shell itself is cached it opens with no network and
// shows local history. Built assets are content-hashed, so cache-first is safe for them; the page
// is network-first so a deploy is picked up on the next online load.
const SHELL = 'chatter-shell-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL).then((cache) => cache.addAll(['/', '/manifest.webmanifest', '/icon.svg'])).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('chatter-shell-') && k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  // Only our own static shell. API calls, sockets and media URLs always go to the network.
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/ws') || url.pathname.startsWith('/.well-known')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          void caches.open(SHELL).then((cache) => cache.put('/', copy));
          return response;
        })
        .catch(() => caches.match('/').then((cached) => cached ?? Response.error())),
    );
    return;
  }
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ??
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              void caches.open(SHELL).then((cache) => cache.put(request, copy));
            }
            return response;
          }),
      ),
    );
  }
});

function readLocal(storeName, key) {
  return new Promise((resolve) => {
    // No version: open whatever schema the app last created. If the app never ran here, the
    // database does not exist and we fall back to a generic notification.
    const open = indexedDB.open('chatter');
    open.onerror = () => resolve(undefined);
    open.onupgradeneeded = () => {
      // We just created an empty database the app will want to create itself; abort that.
      open.transaction.abort();
      resolve(undefined);
    };
    open.onsuccess = () => {
      const db = open.result;
      try {
        const request = db.transaction(storeName, 'readonly').objectStore(storeName).get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(undefined);
      } catch {
        resolve(undefined);
      } finally {
        db.close();
      }
    };
  });
}

async function describe(data) {
  const [sender, conversation] = await Promise.all([
    readLocal('users', data.senderId),
    readLocal('conversations', data.conversationId),
  ]);
  const senderName = sender?.displayName ?? 'Someone';
  if (conversation?.type === 'GROUP') {
    return { title: conversation.subject ?? 'Group', body: `${senderName}: New message` };
  }
  return { title: sender ? senderName : 'Chatter', body: 'New message' };
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  if (data.type !== 'message') return;

  event.waitUntil(
    (async () => {
      const { title, body } = await describe(data);
      await self.registration.showNotification(title, {
        body,
        // One notification per chat, replaced as more arrive (FR-8.1 per-chat collapse).
        tag: data.conversationId,
        renotify: true,
        icon: '/icon.svg',
        data: { conversationId: data.conversationId },
        // FR-8.3 reply from the notification, where the platform supports inline replies.
        actions: [{ action: 'reply', title: 'Reply', type: 'text', placeholder: 'Reply' }],
      });
    })(),
  );
});

/**
 * Parks a notification reply in the app's own IndexedDB. The worker cannot send it: encrypting
 * needs the Signal sessions and ratchet state, which only the page may advance -- two writers
 * racing one ratchet would corrupt it. The page sends parked replies when it next connects.
 */
function parkReply(conversationId, text) {
  return new Promise((resolve) => {
    const open = indexedDB.open('chatter');
    open.onerror = () => resolve(false);
    open.onupgradeneeded = () => {
      open.transaction.abort();
      resolve(false);
    };
    open.onsuccess = () => {
      const db = open.result;
      try {
        const store = db.transaction('meta', 'readwrite').objectStore('meta');
        const get = store.get('pendingReplies');
        get.onsuccess = () => {
          const list = get.result?.value ?? [];
          store.put({ key: 'pendingReplies', value: [...list, { conversationId, text, at: Date.now() }] });
          resolve(true);
        };
        get.onerror = () => resolve(false);
      } catch {
        resolve(false);
      } finally {
        db.close();
      }
    };
  });
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const conversationId = event.notification.data?.conversationId;
  if (event.action === 'reply' && event.reply && conversationId) {
    event.waitUntil(
      (async () => {
        await parkReply(conversationId, event.reply);
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        if (windows[0]) windows[0].postMessage({ type: 'send-pending-replies' });
        // No window open: the reply goes out the next time Chatter is opened.
      })(),
    );
    return;
  }
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = windows[0];
      if (existing) {
        existing.postMessage({ type: 'open-chat', conversationId });
        return existing.focus();
      }
      return self.clients.openWindow(conversationId ? `/?chat=${encodeURIComponent(conversationId)}` : '/');
    })(),
  );
});
