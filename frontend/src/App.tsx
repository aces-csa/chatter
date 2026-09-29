import { useEffect } from 'react';
import { useAuthStore } from '@/state/authStore';
import { useUiStore } from '@/state/uiStore';
import { realtimeService } from '@/realtime/RealtimeService';
import LoginPage from '@/features/auth/LoginPage';
import ChatShell from '@/features/shell/ChatShell';

export default function App() {
  const status = useAuthStore((s) => s.status);
  const user = useAuthStore((s) => s.user);
  const deviceId = useAuthStore((s) => s.deviceId);
  const restore = useAuthStore((s) => s.restore);
  const setConnection = useUiStore((s) => s.setConnection);

  useEffect(() => {
    void restore();
  }, [restore]);

  // A notification click: from the service worker while a tab is open, or as /?chat=ID when
  // it had to open a new one.
  useEffect(() => {
    if (status !== 'signed-in' || !('serviceWorker' in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === 'open-chat' && event.data.conversationId) {
        useUiStore.getState().setActiveConversation(event.data.conversationId);
      }
      if (event.data?.type === 'send-pending-replies') {
        void realtimeService.sendPendingReplies();
      }
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [status]);

  useEffect(() => {
    if (status !== 'signed-in') return;
    const url = new URL(window.location.href);
    const chat = url.searchParams.get('chat');
    if (!chat) return;
    useUiStore.getState().setActiveConversation(chat);
    url.searchParams.delete('chat');
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
  }, [status]);

  // An invite link is /?join=CODE. It waits in the URL through sign-in, then moves into UI
  // state and out of the address bar, so a refresh does not reopen it.
  useEffect(() => {
    if (status !== 'signed-in') return;
    const url = new URL(window.location.href);
    const code = url.searchParams.get('join');
    if (!code) return;
    useUiStore.getState().setJoinCode(code);
    url.searchParams.delete('join');
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
  }, [status]);

  useEffect(() => {
    if (status !== 'signed-in' || !user || !deviceId) return;

    // Not keyed on the access token: a routine refresh must not tear the socket down. The
    // connection asks for a fresh token itself whenever it (re)connects.
    const offStatus = realtimeService.onStatus(setConnection);
    void realtimeService.start(user.id, deviceId);

    return () => {
      offStatus();
      realtimeService.stop();
    };
  }, [status, user?.id, deviceId, setConnection]);

  if (status === 'loading') {
    return (
      <div className="flex h-full items-center justify-center text-text-secondary">
        <span className="animate-pulse">Loading Chatter…</span>
      </div>
    );
  }

  return status === 'signed-in' ? <ChatShell /> : <LoginPage />;
}
