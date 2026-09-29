import React, { lazy, Suspense, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { crypto } from '@/lib/crypto/LibsignalProvider';
import { useAuthStore } from '@/state/authStore';
import type { SignedInSession } from '@/lib/api';
// Carries the QR encoder; most sign-ins never open it.
const LinkThisBrowser = lazy(() => import('./LinkThisBrowser'));

/** "Chrome on Windows" -- what the approving device and the device list show. */
function deviceLabel(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : 'unknown OS';
  return `${browser} on ${os}`;
}

/**
 * Smaller than Signal's 100 on purpose: each key is a pure-JS curve25519 keygen, and the
 * registration screen should not hang while it grinds through a hundred of them. The background
 * top-up on connect raises the pool once the user is in.
 */
const ONE_TIME_PREKEY_BATCH = 25;

type Step = 'phone' | 'code' | 'keys' | 'link';

export default function LoginPage() {
  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [code, setCode] = useState('');
  const [otpToken, setOtpToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setSession = useAuthStore((s) => s.setSession);

  async function requestCode(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { otpToken: token } = await api.startRegistration(phone.trim());
      setOtpToken(token);
      setStep('code');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not send a code. Try again.');
    } finally {
      setBusy(false);
    }
  }

  /**
   * Shared by OTP sign-in and QR linking: a linked browser is a new device with its own Signal
   * identity, so it generates and publishes keys exactly like a fresh sign-in.
   */
  async function finishSignIn(result: SignedInSession) {
    // The session has to exist before key registration, because that call is authenticated.
    setSession(result.user, result.deviceId, result.tokens.accessToken, result.tokens.refreshToken);
    setStep('keys');
    const keys = await crypto.generateRegistrationKeys(ONE_TIME_PREKEY_BATCH);
    await api.registerKeys(keys);
  }

  async function verify(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.verify({
        otpToken,
        code: code.trim(),
        displayName: displayName.trim() || undefined,
        deviceName: deviceLabel(),
        platform: 'web',
      });
      await finishSignIn(result);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That did not work. Try again.');
      setStep('code');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-chat-bg px-4">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent">
            <svg viewBox="0 0 24 24" className="h-8 w-8 fill-white" aria-hidden="true">
              <path d="M12 2a10 10 0 0 0-8.7 14.9L2 22l5.3-1.4A10 10 0 1 0 12 2Zm0 18a8 8 0 0 1-4.1-1.1l-.3-.2-3 .8.8-2.9-.2-.3A8 8 0 1 1 12 20Z" />
            </svg>
          </div>
          <h1 className="text-2xl font-semibold text-text-primary">Chatter</h1>
          <p className="mt-1 text-sm text-text-secondary">
            End-to-end encrypted messaging for the web
          </p>
        </div>

        <div className="rounded-xl border border-stroke bg-panel-alt p-6">
          {step === 'phone' && (
            <form onSubmit={requestCode} className="space-y-4">
              <Field label="Phone number" hint="International format, e.g. +919876543210">
                <input
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+919876543210"
                  inputMode="tel"
                  autoFocus
                  className={inputClass}
                />
              </Field>
              <Field label="Your name" hint="Shown to people you message">
                <input
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Alex"
                  className={inputClass}
                />
              </Field>
              <SubmitButton busy={busy} label="Send code" busyLabel="Sending…" />
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setStep('link');
                }}
                className="w-full text-sm text-text-secondary hover:text-text-primary"
              >
                Already use Chatter elsewhere? Link this browser
              </button>
            </form>
          )}

          {step === 'link' && (
            <Suspense fallback={<p className="py-8 text-center text-sm text-text-secondary">Loading…</p>}>
            <LinkThisBrowser
              deviceName={deviceLabel()}
              onLinked={(session) =>
                void finishSignIn(session).catch((e) => {
                  setError(e instanceof ApiError ? e.message : 'Linking failed. Try again.');
                  setStep('link');
                })
              }
              onBack={() => setStep('phone')}
            />
            </Suspense>
          )}

          {step === 'code' && (
            <form onSubmit={verify} className="space-y-4">
              <Field label="Verification code" hint={`Sent to ${phone}. Check the app server log in dev.`}>
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="000000"
                  inputMode="numeric"
                  autoFocus
                  className={`${inputClass} text-center text-2xl tracking-[0.5em]`}
                />
              </Field>
              <SubmitButton busy={busy} label="Verify" busyLabel="Verifying…" />
              <button
                type="button"
                onClick={() => setStep('phone')}
                className="w-full text-sm text-text-secondary hover:text-text-primary"
              >
                Use a different number
              </button>
            </form>
          )}

          {step === 'keys' && (
            <div className="space-y-3 py-4 text-center">
              <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
              <p className="text-sm text-text-primary">Generating your encryption keys…</p>
              <p className="text-xs text-text-secondary">
                This happens once, in your browser. The private keys never leave this device —
                which also means losing this browser means losing your history.
              </p>
            </div>
          )}

          {error && (
            <p className="mt-4 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</p>
          )}
        </div>
      </div>
    </div>
  );
}

const inputClass =
  'w-full rounded-lg border border-stroke bg-panel px-3 py-2.5 text-text-primary ' +
  'placeholder:text-text-secondary/60 outline-none focus:border-accent';

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-text-primary">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-text-secondary">{hint}</span>}
    </label>
  );
}

function SubmitButton({ busy, label, busyLabel }: { busy: boolean; label: string; busyLabel: string }) {
  return (
    <button
      type="submit"
      disabled={busy}
      className="w-full rounded-lg bg-accent py-2.5 font-medium text-white transition
                 hover:brightness-110 disabled:opacity-50"
    >
      {busy ? busyLabel : label}
    </button>
  );
}
