import { useState, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type GroupMember, type LocalConversation, type LocalUser } from '@/db/db';
import { api, ApiError, type ConversationDto } from '@/lib/api';
import { applyGroupDetails } from '@/db/conversations';
import { useAuthStore } from '@/state/authStore';
import { useUiStore } from '@/state/uiStore';
import Modal from '@/ui/Modal';
import VerifiedIcon from '@/features/security/VerifiedIcon';
import PersonPicker from './PersonPicker';

export function inviteUrl(code: string): string {
  return `${window.location.origin}/?join=${encodeURIComponent(code)}`;
}

/**
 * Group info: subject, description, members and roles, settings, invite link, leave. The server
 * enforces every permission; the UI only hides controls that would be refused anyway.
 */
export default function GroupInfoDialog({ conversation }: { conversation: LocalConversation }) {
  const me = useAuthStore((s) => s.user);
  const close = () => useUiStore.getState().setGroupInfoOpen(false);
  const users = useLiveQuery(() => db.users.toArray(), [], [] as LocalUser[]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const members = conversation.members ?? [];
  const self = members.find((m) => m.userId === me?.id);
  const isAdmin = self?.role === 'OWNER' || self?.role === 'ADMIN';
  const canEditInfo = !conversation.left && (isAdmin || !conversation.onlyAdminsCanEditInfo);
  const nameOf = (userId: string) =>
    userId === me?.id ? 'You' : users.find((u) => u.id === userId)?.displayName ?? 'Unknown';

  /** Runs a mutation; if it returns the group, applies it without waiting for the socket. */
  async function run(action: () => Promise<ConversationDto | void>) {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      if (result) await applyGroupDetails(result);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That did not work. Try again.');
    } finally {
      setBusy(false);
    }
  }

  const sorted = [...members].sort((a, b) => {
    const rank = (m: GroupMember) =>
      m.userId === me?.id ? 0 : m.role === 'OWNER' ? 1 : m.role === 'ADMIN' ? 2 : 3;
    return rank(a) - rank(b) || nameOf(a.userId).localeCompare(nameOf(b.userId));
  });

  return (
    <Modal title="Group info" onClose={close} wide>
      <EditableField
        label="Subject"
        value={conversation.subject ?? ''}
        editable={canEditInfo}
        maxLength={100}
        onSave={(subject) => run(() => api.updateGroup(conversation.id, { subject }))}
        large
      />
      <p className="mb-4 text-sm text-text-secondary">
        Group · {members.length} {members.length === 1 ? 'member' : 'members'}
      </p>

      <EditableField
        label="Description"
        value={conversation.description ?? ''}
        placeholder="Add group description"
        editable={canEditInfo}
        maxLength={512}
        multiline
        onSave={(description) => run(() => api.updateGroup(conversation.id, { description }))}
      />

      {error && (
        <p className="mb-3 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300" role="alert">
          {error}
        </p>
      )}

      {conversation.left ? (
        <p className="my-4 text-sm text-text-secondary">You're no longer a participant in this group.</p>
      ) : (
        <>
          {isAdmin && <InviteSection conversationId={conversation.id} />}
          {isAdmin && (
            <Section title="Settings">
              <Toggle
                label="Only admins can send messages"
                checked={conversation.onlyAdminsCanPost ?? false}
                disabled={busy}
                onChange={(onlyAdminsCanPost) =>
                  run(() => api.updateGroup(conversation.id, { onlyAdminsCanPost }))
                }
              />
              <Toggle
                label="Only admins can edit group info"
                checked={conversation.onlyAdminsCanEditInfo ?? true}
                disabled={busy}
                onChange={(onlyAdminsCanEditInfo) =>
                  run(() => api.updateGroup(conversation.id, { onlyAdminsCanEditInfo }))
                }
              />
            </Section>
          )}

          <Section title={`${members.length} members`}>
            {isAdmin && (
              <AddMembers
                exclude={members.map((m) => m.userId)}
                busy={busy}
                onAdd={(userIds) => run(() => api.addMembers(conversation.id, userIds))}
              />
            )}
            <ul className="space-y-0.5">
              {sorted.map((member) => (
                <MemberRow
                  key={member.userId}
                  member={member}
                  name={nameOf(member.userId)}
                  isSelf={member.userId === me?.id}
                  canManage={isAdmin && member.role !== 'OWNER' && member.userId !== me?.id}
                  busy={busy}
                  onRole={(role) => run(() => api.setRole(conversation.id, member.userId, role))}
                  onRemove={() => run(() => api.removeMember(conversation.id, member.userId))}
                />
              ))}
            </ul>
          </Section>

          <LeaveButton
            busy={busy}
            onLeave={() =>
              run(async () => {
                await api.leaveGroup(conversation.id);
                await db.conversations.update(conversation.id, { left: true });
              })
            }
          />
        </>
      )}
    </Modal>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-5 border-t border-stroke pt-4">
      <h3 className="mb-2 text-sm font-medium text-text-secondary">{title}</h3>
      {children}
    </section>
  );
}

function EditableField({
  label,
  value,
  placeholder,
  editable,
  maxLength,
  multiline = false,
  large = false,
  onSave,
}: {
  label: string;
  value: string;
  placeholder?: string;
  editable: boolean;
  maxLength: number;
  multiline?: boolean;
  large?: boolean;
  onSave: (value: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  if (draft === null) {
    return (
      <div className="mb-1 flex items-start gap-2">
        <p
          className={`min-w-0 flex-1 whitespace-pre-wrap break-words ${
            large ? 'text-xl' : 'text-sm'
          } ${value ? '' : 'text-text-secondary'}`}
        >
          {value || placeholder}
        </p>
        {editable && (
          <button
            onClick={() => setDraft(value)}
            aria-label={`Edit ${label.toLowerCase()}`}
            className="shrink-0 rounded-full p-1.5 text-text-secondary hover:bg-panel-hover"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current" aria-hidden="true">
              <path d="M3 17.2V21h3.8l11-11-3.8-3.8-11 11ZM20.7 7a1 1 0 0 0 0-1.4l-2.3-2.3a1 1 0 0 0-1.4 0l-1.8 1.8 3.8 3.8L20.7 7Z" />
            </svg>
          </button>
        )}
      </div>
    );
  }

  const save = async () => {
    if (draft.trim() !== value) await onSave(draft.trim());
    setDraft(null);
  };
  const Input = multiline ? 'textarea' : 'input';
  return (
    <div className="mb-2">
      <Input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        maxLength={maxLength}
        autoFocus
        aria-label={label}
        rows={multiline ? 3 : undefined}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !multiline) void save();
          if (event.key === 'Escape') {
            event.stopPropagation();
            setDraft(null);
          }
        }}
        className="w-full resize-none rounded-lg border border-accent bg-panel px-3 py-2 outline-none"
      />
      <div className="mt-1 flex justify-end gap-2">
        <button onClick={() => setDraft(null)} className="px-2 py-1 text-sm text-text-secondary">
          Cancel
        </button>
        <button
          onClick={() => void save()}
          disabled={label === 'Subject' && !draft.trim()}
          className="rounded-md bg-accent px-3 py-1 text-sm font-medium text-white disabled:opacity-50"
        >
          Save
        </button>
      </div>
    </div>
  );
}

function Toggle({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 py-1.5 text-sm">
      {label}
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="h-4 w-4 accent-accent"
      />
    </label>
  );
}

function InviteSection({ conversationId }: { conversationId: string }) {
  const [code, setCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(reset: boolean) {
    setError(null);
    setCopied(false);
    try {
      if (reset) await api.revokeGroupInvite(conversationId);
      setCode((await api.groupInvite(conversationId)).code);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not get an invite link.');
    }
  }

  return (
    <Section title="Invite link">
      {code ? (
        <>
          <p className="break-all rounded-lg bg-panel px-3 py-2 font-mono text-xs">{inviteUrl(code)}</p>
          <div className="mt-2 flex gap-2">
            <button
              onClick={() =>
                void navigator.clipboard?.writeText(inviteUrl(code)).then(() => setCopied(true))
              }
              className="rounded-lg border border-stroke px-3 py-1.5 text-sm hover:bg-panel-hover"
            >
              {copied ? 'Copied' : 'Copy link'}
            </button>
            <button
              onClick={() => void load(true)}
              className="rounded-lg border border-stroke px-3 py-1.5 text-sm text-red-300 hover:bg-panel-hover"
            >
              Reset link
            </button>
          </div>
          <p className="mt-2 text-xs text-text-secondary">
            Anyone with this link can join. Resetting it makes the old link stop working.
          </p>
        </>
      ) : (
        <button
          onClick={() => void load(false)}
          className="rounded-lg border border-stroke px-3 py-1.5 text-sm hover:bg-panel-hover"
        >
          Show invite link
        </button>
      )}
      {error && <p className="mt-2 text-sm text-red-300">{error}</p>}
    </Section>
  );
}

function AddMembers({
  exclude,
  busy,
  onAdd,
}: {
  exclude: string[];
  busy: boolean;
  onAdd: (userIds: string[]) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mb-2 flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-sm text-accent hover:bg-panel-hover"
      >
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-accent text-white">+</span>
        Add members
      </button>
    );
  }
  return (
    <div className="mb-3 rounded-lg border border-stroke p-3">
      <PersonPicker selected={selected} onChange={setSelected} exclude={exclude} />
      <div className="mt-3 flex justify-end gap-2">
        <button onClick={() => setOpen(false)} className="px-2 py-1 text-sm text-text-secondary">
          Cancel
        </button>
        <button
          disabled={busy || selected.length === 0}
          onClick={() =>
            void onAdd(selected).then(() => {
              setSelected([]);
              setOpen(false);
            })
          }
          className="rounded-md bg-accent px-3 py-1 text-sm font-medium text-white disabled:opacity-50"
        >
          Add {selected.length || ''}
        </button>
      </div>
    </div>
  );
}

function MemberRow({
  member,
  name,
  isSelf,
  canManage,
  busy,
  onRole,
  onRemove,
}: {
  member: GroupMember;
  name: string;
  isSelf: boolean;
  canManage: boolean;
  busy: boolean;
  onRole: (role: 'ADMIN' | 'MEMBER') => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  const [menu, setMenu] = useState(false);
  const verify = () => useUiStore.getState().setSafetyNumberUserId(member.userId);

  return (
    <li className="rounded-lg px-2 py-2 hover:bg-panel-hover">
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-panel text-xs">
          {name.slice(0, 2).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm">{name}</span>
        {member.role !== 'MEMBER' && (
          <span className="shrink-0 rounded border border-accent/50 px-1.5 py-0.5 text-[11px] text-accent">
            {member.role === 'OWNER' ? 'Owner' : 'Admin'}
          </span>
        )}
        {!isSelf && (
          <button
            onClick={verify}
            title={`Verify security code with ${name}`}
            aria-label={`Verify security code with ${name}`}
            className="shrink-0 rounded-full p-1 text-text-secondary hover:text-text-primary"
          >
            <VerifiedIcon className="h-4 w-4 fill-current" />
          </button>
        )}
        {canManage && (
          <button
            onClick={() => setMenu(!menu)}
            aria-expanded={menu}
            aria-label={`Manage ${name}`}
            className="shrink-0 rounded-full p-1 text-text-secondary hover:text-text-primary"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current" aria-hidden="true">
              <path d="M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm0 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z" />
            </svg>
          </button>
        )}
      </div>
      {menu && canManage && (
        <div className="ml-12 mt-2 flex flex-wrap gap-2">
          <button
            disabled={busy}
            onClick={() => void onRole(member.role === 'ADMIN' ? 'MEMBER' : 'ADMIN').then(() => setMenu(false))}
            className="rounded-md border border-stroke px-2.5 py-1 text-xs hover:bg-panel"
          >
            {member.role === 'ADMIN' ? 'Dismiss as admin' : 'Make group admin'}
          </button>
          <button
            disabled={busy}
            onClick={() => void onRemove().then(() => setMenu(false))}
            className="rounded-md border border-stroke px-2.5 py-1 text-xs text-red-300 hover:bg-panel"
          >
            Remove from group
          </button>
        </div>
      )}
    </li>
  );
}

/** Two clicks, no browser confirm(): a native dialog would block the whole tab. */
function LeaveButton({ busy, onLeave }: { busy: boolean; onLeave: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="mt-5 border-t border-stroke pt-4">
      {confirming ? (
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm">Leave this group?</span>
          <div className="flex gap-2">
            <button onClick={() => setConfirming(false)} className="px-2 py-1 text-sm text-text-secondary">
              Cancel
            </button>
            <button
              disabled={busy}
              onClick={() => void onLeave()}
              className="rounded-md bg-red-500/80 px-3 py-1 text-sm font-medium text-white disabled:opacity-50"
            >
              Leave
            </button>
          </div>
        </div>
      ) : (
        <button onClick={() => setConfirming(true)} className="text-sm text-red-300 hover:underline">
          Exit group
        </button>
      )}
    </div>
  );
}
