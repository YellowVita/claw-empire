import { decryptSecret, encryptSecret } from "../oauth/helpers.ts";
import { MESSENGER_CHANNELS, type MessengerChannel } from "./channels.ts";

const MESSENGER_TOKEN_ENCRYPTION_PREFIX = "__ce_enc_v1__:";
const TOKEN_MASK_PREFIX = "****";

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? { ...value } : {};
}

function encryptMessengerToken(rawToken: unknown): string {
  const token = normalizeText(rawToken);
  if (!token) return "";
  if (token.startsWith(MESSENGER_TOKEN_ENCRYPTION_PREFIX)) return token;
  return `${MESSENGER_TOKEN_ENCRYPTION_PREFIX}${encryptSecret(token)}`;
}

function decryptMessengerToken(rawToken: unknown, onDecryptError: "raw" | "empty"): string {
  const token = normalizeText(rawToken);
  if (!token) return "";
  if (!token.startsWith(MESSENGER_TOKEN_ENCRYPTION_PREFIX)) return token;
  const payload = token.slice(MESSENGER_TOKEN_ENCRYPTION_PREFIX.length).trim();
  if (!payload) return onDecryptError === "raw" ? token : "";
  try {
    return decryptSecret(payload);
  } catch {
    return onDecryptError === "raw" ? token : "";
  }
}

function projectTokenForClient(rawToken: unknown): { tokenConfigured: boolean; tokenMasked: string | null } {
  const token = decryptMessengerToken(rawToken, "empty");
  if (!token) {
    return { tokenConfigured: false, tokenMasked: null };
  }
  return {
    tokenConfigured: true,
    tokenMasked: `${TOKEN_MASK_PREFIX}${token.slice(-4)}`,
  };
}

function sanitizeStoredSecretMeta(rawValue: Record<string, unknown>): Record<string, unknown> {
  const next = { ...rawValue };
  delete next.clearToken;
  delete next.tokenConfigured;
  delete next.tokenMasked;
  return next;
}

function resolveStoredTokenUpdate(existingToken: unknown, incoming: Record<string, unknown>): string {
  const hasToken = hasOwn(incoming, "token");
  const clearRequested = incoming.clearToken === true;

  if (clearRequested && hasToken) {
    throw new Error("invalid_token_update");
  }
  if (clearRequested) {
    return "";
  }
  if (!hasToken) {
    return normalizeText(existingToken);
  }
  if (typeof incoming.token !== "string") {
    throw new Error("invalid_token_update");
  }

  const nextToken = incoming.token.trim();
  if (!nextToken) {
    return normalizeText(existingToken);
  }
  return encryptMessengerToken(nextToken);
}

function mergeSessionForStorage(existingSession: unknown, incomingSession: unknown): unknown {
  if (!isRecord(incomingSession)) {
    return incomingSession;
  }

  const nextSession = sanitizeStoredSecretMeta(cloneRecord(existingSession));
  for (const [key, value] of Object.entries(incomingSession)) {
    if (key === "token" || key === "clearToken" || key === "tokenConfigured" || key === "tokenMasked") continue;
    nextSession[key] = value;
  }

  const nextToken = resolveStoredTokenUpdate(isRecord(existingSession) ? existingSession.token : undefined, incomingSession);
  if (nextToken) {
    nextSession.token = nextToken;
  } else {
    delete nextSession.token;
  }

  return nextSession;
}

function mergeChannelForStorage(existingChannel: unknown, incomingChannel: unknown): unknown {
  if (!isRecord(incomingChannel)) {
    return incomingChannel;
  }

  const nextChannel = sanitizeStoredSecretMeta(cloneRecord(existingChannel));
  for (const [key, value] of Object.entries(incomingChannel)) {
    if (key === "token" || key === "clearToken" || key === "tokenConfigured" || key === "tokenMasked") continue;
    if (key === "sessions") continue;
    nextChannel[key] = value;
  }

  const nextToken = resolveStoredTokenUpdate(isRecord(existingChannel) ? existingChannel.token : undefined, incomingChannel);
  if (nextToken) {
    nextChannel.token = nextToken;
  } else {
    delete nextChannel.token;
  }

  if (hasOwn(incomingChannel, "sessions") && Array.isArray(incomingChannel.sessions)) {
    const existingSessions = isRecord(existingChannel) && Array.isArray(existingChannel.sessions) ? existingChannel.sessions : [];
    const existingById = new Map<string, unknown>();
    for (const rawSession of existingSessions) {
      if (!isRecord(rawSession)) continue;
      const sessionId = normalizeText(rawSession.id);
      if (!sessionId) continue;
      existingById.set(sessionId, rawSession);
    }

    nextChannel.sessions = incomingChannel.sessions.map((rawSession) => {
      if (!isRecord(rawSession)) {
        return rawSession;
      }
      const sessionId = normalizeText(rawSession.id);
      return mergeSessionForStorage(sessionId ? existingById.get(sessionId) : undefined, rawSession);
    });
  }

  return nextChannel;
}

function mapMessengerChannelsTokens(
  rawChannels: unknown,
  mode: "encrypt" | "decrypt",
  onDecryptError: "raw" | "empty" = "raw",
): unknown {
  if (!isRecord(rawChannels)) return rawChannels;

  const nextChannels: Record<string, unknown> = { ...rawChannels };
  for (const channel of MESSENGER_CHANNELS) {
    const channelConfig = nextChannels[channel];
    if (!isRecord(channelConfig)) continue;

    const nextChannelConfig: Record<string, unknown> = { ...channelConfig };
    if (hasOwn(nextChannelConfig, "token")) {
      nextChannelConfig.token =
        mode === "encrypt"
          ? encryptMessengerToken(nextChannelConfig.token)
          : decryptMessengerToken(nextChannelConfig.token, onDecryptError);
    }
    if (hasOwn(nextChannelConfig, "sessions") && Array.isArray(nextChannelConfig.sessions)) {
      nextChannelConfig.sessions = nextChannelConfig.sessions.map((rawSession) => {
        if (!isRecord(rawSession)) return rawSession;
        if (!hasOwn(rawSession, "token")) return rawSession;
        const nextSession: Record<string, unknown> = { ...rawSession };
        nextSession.token =
          mode === "encrypt"
            ? encryptMessengerToken(nextSession.token)
            : decryptMessengerToken(nextSession.token, onDecryptError);
        return nextSession;
      });
    }
    nextChannels[channel] = nextChannelConfig;
  }

  return nextChannels;
}

export function encryptMessengerChannelsForStorage(rawChannels: unknown): unknown {
  return mapMessengerChannelsTokens(rawChannels, "encrypt");
}

export function mergeMessengerChannelsForStorage(existingChannels: unknown, incomingChannels: unknown): unknown {
  if (!isRecord(incomingChannels)) {
    return incomingChannels;
  }

  const nextChannels = cloneRecord(existingChannels);
  for (const channel of MESSENGER_CHANNELS) {
    if (!hasOwn(incomingChannels, channel)) continue;
    nextChannels[channel] = mergeChannelForStorage(nextChannels[channel], incomingChannels[channel]);
  }

  return nextChannels;
}

export function projectMessengerChannelsForClient(rawChannels: unknown): unknown {
  if (!isRecord(rawChannels)) return rawChannels;

  const nextChannels: Record<string, unknown> = { ...rawChannels };
  for (const channel of MESSENGER_CHANNELS) {
    const channelConfig = nextChannels[channel];
    if (!isRecord(channelConfig)) continue;

    const nextChannelConfig = sanitizeStoredSecretMeta(channelConfig);
    const channelProjection = projectTokenForClient(channelConfig.token);
    nextChannelConfig.tokenConfigured = channelProjection.tokenConfigured;
    nextChannelConfig.tokenMasked = channelProjection.tokenMasked;
    delete nextChannelConfig.token;

    if (Array.isArray(channelConfig.sessions)) {
      nextChannelConfig.sessions = channelConfig.sessions.map((rawSession) => {
        if (!isRecord(rawSession)) return rawSession;
        const nextSession = sanitizeStoredSecretMeta(rawSession);
        const sessionProjection = projectTokenForClient(rawSession.token);
        nextSession.tokenConfigured = sessionProjection.tokenConfigured;
        nextSession.tokenMasked = sessionProjection.tokenMasked;
        delete nextSession.token;
        return nextSession;
      });
    }

    nextChannels[channel] = nextChannelConfig;
  }

  return nextChannels;
}

export function decryptMessengerChannelsForRuntime(rawChannels: unknown): unknown {
  return mapMessengerChannelsTokens(rawChannels, "decrypt", "empty");
}

export function decryptMessengerTokenForRuntime(channel: MessengerChannel, rawToken: unknown): string {
  void channel;
  return decryptMessengerToken(rawToken, "empty");
}
