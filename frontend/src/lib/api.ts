import type { DeviceBundle } from '@/lib/crypto/CryptoProvider';

export interface ApiErrorBody {
  code: string;
  message: string;
  retryable: boolean;
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface UserDto {
  id: string;
  phoneE164: string;
  displayName: string;
  about?: string;
  avatarMediaId?: string;
  avatar?: string;
}

export type Audience = 'everyone' | 'contacts' | 'nobody';

export interface PrivacySettings {
  lastSeen: Audience;
  profilePhoto: Audience;
  about: Audience;
  readReceipts: boolean;
  quietStart: number | null;
  quietEnd: number | null;
  timeZone: string | null;
}

export interface ConversationDto {
  id: string;
  type: 'DIRECT' | 'GROUP';
  subject?: string;
  description?: string;
  avatarMediaId?: string;
  participantIds: string[];
  members: Array<{ userId: string; role: 'OWNER' | 'ADMIN' | 'MEMBER' }>;
  onlyAdminsCanPost: boolean;
  onlyAdminsCanEditInfo: boolean;
  disappearingSeconds: number;
  lastSeq: number;
  lastMessageAt?: string;
  lastReadSeq: number;
  unreadCount: number;
  pinned: boolean;
  archived: boolean;
  mutedUntil?: string;
  markedUnread: boolean;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
}

export interface DeviceDto {
  id: string;
  userId: string;
  name?: string;
  hasKeys: boolean;
  identityKey?: string;
  registrationId?: number;
  lastActiveAt?: string;
  createdAt?: string;
}

export interface SignedInSession {
  user: UserDto;
  deviceId: string;
  tokens: AuthTokens;
}

export interface UploadTicket {
  mediaId: string;
  sizeBytes: number;
  partSize: number;
  parts: Array<{ partNumber: number; url: string }>;
  alreadyUploaded: Array<{ partNumber: number; etag: string }>;
}

type TokenSupplier = () => string | null;
type TokenRefresher = () => Promise<string | null>;

let getAccessToken: TokenSupplier = () => null;
let refreshAccessToken: TokenRefresher = async () => null;

export function configureApi(supplier: TokenSupplier, refresher: TokenRefresher): void {
  getAccessToken = supplier;
  refreshAccessToken = refresher;
}

/**
 * @param retryOn401 must be false for the auth endpoints themselves. The refresh call goes
 *   through this same function, so leaving the retry on means a 401 from /auth/refresh calls
 *   the refresher, which returns the in-flight refresh promise -- the one this very call is
 *   inside. That awaits itself and the app hangs on the loading screen forever.
 */
async function request<T>(path: string, init: RequestInit = {}, retryOn401 = true): Promise<T> {
  const token = getAccessToken();
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const response = await fetch(path, { ...init, headers });

  // One transparent retry after a refresh. Beyond that we surface the failure rather than
  // looping, because a second 401 means the refresh itself is not working.
  if (response.status === 401 && retryOn401) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      return request<T>(path, init, false);
    }
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
    throw new ApiError(
      body?.code ?? 'INTERNAL',
      body?.message ?? `Request failed with ${response.status}`,
      body?.retryable ?? false,
      response.status,
    );
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  startRegistration: (phone: string) =>
    request<{ otpToken: string; expiresInSeconds: number }>('/api/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({ phone }),
    }, false),

  verify: (payload: {
    otpToken: string;
    code: string;
    displayName?: string;
    deviceName?: string;
    platform?: string;
  }) =>
    request<{ user: UserDto; deviceId: string; tokens: AuthTokens }>('/api/v1/auth/verify', {
      method: 'POST',
      body: JSON.stringify(payload),
    }, false),

  refresh: (refreshToken: string) =>
    request<AuthTokens>('/api/v1/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refreshToken }),
    }, false),

  logout: (refreshToken: string) =>
    request<void>('/api/v1/auth/logout', {
      method: 'POST',
      body: JSON.stringify({ refreshToken }),
    }, false),

  me: () => request<UserDto>('/api/v1/me'),

  updateMe: (patch: { displayName?: string; about?: string; avatar?: string; removeAvatar?: boolean }) =>
    request<UserDto>('/api/v1/me', { method: 'PATCH', body: JSON.stringify(patch) }),

  privacy: () => request<PrivacySettings>('/api/v1/me/privacy'),

  updatePrivacy: (settings: PrivacySettings) =>
    request<PrivacySettings>('/api/v1/me/privacy', { method: 'PUT', body: JSON.stringify(settings) }),

  blocks: () => request<string[]>('/api/v1/blocks'),

  block: (userId: string) => request<void>(`/api/v1/blocks/${userId}`, { method: 'POST' }),

  unblock: (userId: string) => request<void>(`/api/v1/blocks/${userId}`, { method: 'DELETE' }),

  setChatState: (id: string, state: { pinned?: boolean; archived?: boolean; markedUnread?: boolean }) =>
    request<ConversationDto>(`/api/v1/conversations/${id}/state`, { method: 'PUT', body: JSON.stringify(state) }),

  messageInfo: (conversationId: string, messageId: string) =>
    request<Array<{ userId: string; deliveredAt?: string; readAt?: string }>>(
      `/api/v1/conversations/${conversationId}/messages/${messageId}/info`,
    ),

  deleteAccount: () => request<void>('/api/v1/me', { method: 'DELETE' }),

  userById: (id: string) => request<UserDto>(`/api/v1/users/${id}`),

  syncContacts: (phones: string[]) =>
    request<UserDto[]>('/api/v1/contacts/sync', {
      method: 'POST',
      body: JSON.stringify({ phones }),
    }),

  conversations: () => request<ConversationDto[]>('/api/v1/conversations'),

  conversationById: (id: string) => request<ConversationDto>(`/api/v1/conversations/${id}`),

  createDirect: (otherUserId: string) =>
    request<ConversationDto>('/api/v1/conversations', {
      method: 'POST',
      body: JSON.stringify({ type: 'DIRECT', participantIds: [otherUserId] }),
    }),

  createGroup: (subject: string, participantIds: string[]) =>
    request<ConversationDto>('/api/v1/conversations', {
      method: 'POST',
      body: JSON.stringify({ type: 'GROUP', subject, participantIds }),
    }),

  updateGroup: (
    id: string,
    patch: {
      subject?: string;
      description?: string;
      onlyAdminsCanPost?: boolean;
      onlyAdminsCanEditInfo?: boolean;
    },
  ) =>
    request<ConversationDto>(`/api/v1/conversations/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  addMembers: (id: string, userIds: string[]) =>
    request<ConversationDto>(`/api/v1/conversations/${id}/members`, {
      method: 'POST',
      body: JSON.stringify({ userIds }),
    }),

  removeMember: (id: string, userId: string) =>
    request<void>(`/api/v1/conversations/${id}/members/${userId}`, { method: 'DELETE' }),

  setRole: (id: string, userId: string, role: 'ADMIN' | 'MEMBER') =>
    request<ConversationDto>(`/api/v1/conversations/${id}/members/${userId}/role`, {
      method: 'PUT',
      body: JSON.stringify({ role }),
    }),

  setDisappearing: (id: string, seconds: number) =>
    request<ConversationDto>(`/api/v1/conversations/${id}/disappearing`, {
      method: 'PUT',
      body: JSON.stringify({ seconds }),
    }),

  leaveGroup: (id: string) =>
    request<void>(`/api/v1/conversations/${id}/leave`, { method: 'POST' }),

  groupInvite: (id: string) =>
    request<{ code: string; expiresAt?: string }>(`/api/v1/conversations/${id}/invite`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  revokeGroupInvite: (id: string) =>
    request<void>(`/api/v1/conversations/${id}/invite`, { method: 'DELETE' }),

  invitePreview: (code: string) =>
    request<{
      conversationId: string;
      subject?: string;
      description?: string;
      memberCount: number;
      alreadyMember: boolean;
    }>(`/api/v1/invites/${encodeURIComponent(code)}`),

  joinViaInvite: (code: string) =>
    request<ConversationDto>(`/api/v1/invites/${encodeURIComponent(code)}/join`, {
      method: 'POST',
    }),

  startUpload: (sizeBytes: number) =>
    request<UploadTicket>('/api/v1/media/uploads', {
      method: 'POST',
      body: JSON.stringify({ sizeBytes }),
    }),

  resumeUpload: (mediaId: string) => request<UploadTicket>(`/api/v1/media/${mediaId}/upload`),

  completeUpload: (mediaId: string, parts: Array<{ partNumber: number; etag: string }>) =>
    request<void>(`/api/v1/media/${mediaId}/complete`, {
      method: 'POST',
      body: JSON.stringify({ parts }),
    }),

  discardMedia: (mediaId: string) =>
    request<void>(`/api/v1/media/${mediaId}`, { method: 'DELETE' }),

  shareMedia: (mediaId: string, conversationId: string) =>
    request<void>(`/api/v1/media/${mediaId}/share`, {
      method: 'POST',
      body: JSON.stringify({ conversationId }),
    }),

  mediaUrl: (mediaId: string) =>
    request<{ url: string; expiresAt: string }>(`/api/v1/media/${mediaId}/url`),

  iceServers: () => request<RTCIceServer[]>('/api/v1/calls/ice-servers'),

  vapidPublicKey: () => request<{ publicKey: string }>('/api/v1/push/vapid-public-key'),

  subscribePush: (subscription: { endpoint: string; keys: { p256dh: string; auth: string } }) =>
    request<void>('/api/v1/push/subscriptions', {
      method: 'POST',
      body: JSON.stringify(subscription),
    }),

  unsubscribePush: (endpoint: string) =>
    request<void>('/api/v1/push/subscriptions', {
      method: 'DELETE',
      body: JSON.stringify({ endpoint }),
    }),

  mute: (id: string, duration: '8h' | '1w' | 'always' | 'off') =>
    request<ConversationDto>(`/api/v1/conversations/${id}/mute`, {
      method: 'POST',
      body: JSON.stringify({ duration }),
    }),

  registerKeys: (payload: {
    identityKey: string;
    registrationId: number;
    signedPreKey: { keyId: number; publicKey: string; signature: string };
    oneTimePreKeys: Array<{ keyId: number; publicKey: string }>;
  }) => request<void>('/api/v1/keys', { method: 'POST', body: JSON.stringify(payload) }),

  topUpKeys: (oneTimePreKeys: Array<{ keyId: number; publicKey: string }>) =>
    request<void>('/api/v1/keys/top-up', {
      method: 'POST',
      body: JSON.stringify({ oneTimePreKeys }),
    }),

  preKeyCount: () =>
    request<{ available: number; highestKeyId: number }>('/api/v1/keys/count'),

  /** Cheap: no prekey is consumed. Use this to find out which devices to address. */
  devicesOf: (userId: string) => request<DeviceDto[]>(`/api/v1/users/${userId}/devices`),

  /** Consumes a one-time prekey per returned device, so never call it speculatively. */
  bundlesFor: (userId: string, deviceId?: string) =>
    request<{ userId: string; devices: DeviceBundle[] }>(
      `/api/v1/keys/${userId}/bundle${deviceId ? `?deviceId=${deviceId}` : ''}`,
    ),

  myDevices: () => request<DeviceDto[]>('/api/v1/auth/devices'),

  revokeDevice: (id: string) => request<void>(`/api/v1/auth/devices/${id}`, { method: 'DELETE' }),

  /** Unauthenticated: the new browser has no session yet. */
  startLink: (deviceName: string) =>
    request<{ linkId: string; pollSecret: string; expiresInSeconds: number }>(
      '/api/v1/auth/link/start',
      { method: 'POST', body: JSON.stringify({ deviceName, platform: 'web' }) },
      false,
    ),

  claimLink: (linkId: string, pollSecret: string) =>
    request<{ status: 'PENDING' | 'LINKED'; session: SignedInSession | null }>(
      '/api/v1/auth/link/claim',
      { method: 'POST', body: JSON.stringify({ linkId, pollSecret }) },
      false,
    ),

  previewLink: (linkId: string) =>
    request<{ deviceName: string; platform: string }>(`/api/v1/auth/link/${encodeURIComponent(linkId)}`),

  approveLink: (linkId: string) =>
    request<void>(`/api/v1/auth/link/${encodeURIComponent(linkId)}/approve`, { method: 'POST' }),
};
