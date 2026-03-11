import {
  MESSENGER_CHANNELS,
  type MessengerChannelConfig,
  type MessengerChannelType,
  type MessengerChannelsConfig,
  type MessengerSessionConfig,
  type WorkflowPackKey,
} from "../../../types";
import type { ChannelSettingsTabProps } from "../types";
import { CHANNEL_META, isWorkflowPackKey } from "./constants";

export type ChatRow = {
  key: string;
  channel: MessengerChannelType;
  tokenConfigured: boolean;
  tokenMasked: string | null;
  receiveEnabled: boolean;
  session: MessengerSessionConfig;
};

export type ChatEditorRef = { channel: MessengerChannelType; sessionId: string } | null;

export type ChatEditorState = {
  open: boolean;
  mode: "create" | "edit";
  ref: ChatEditorRef;
  channel: MessengerChannelType;
  token: string;
  tokenConfigured: boolean;
  tokenMasked: string | null;
  clearToken: boolean;
  tokenDirty: boolean;
  name: string;
  targetId: string;
  enabled: boolean;
  agentId: string;
  workflowPackKey: WorkflowPackKey;
  receiveEnabled: boolean;
};

export function createSessionId(channel: MessengerChannelType): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${channel}-${crypto.randomUUID()}`;
  }
  return `${channel}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function emptyChannelConfig(channel: MessengerChannelType): MessengerChannelConfig {
  return {
    token: "",
    tokenConfigured: false,
    tokenMasked: null,
    sessions: [],
    receiveEnabled: channel === "telegram",
  };
}

export function defaultChannelsConfig(): MessengerChannelsConfig {
  return MESSENGER_CHANNELS.reduce((acc, channel) => {
    acc[channel] = emptyChannelConfig(channel);
    return acc;
  }, {} as MessengerChannelsConfig);
}

function normalizeSession(
  session: MessengerSessionConfig,
  channel: MessengerChannelType,
  index: number,
): MessengerSessionConfig {
  const id = (session.id || "").trim() || `${channel}-${index + 1}`;
  const agentId = session.agentId?.trim() || "";
  const token = session.token?.trim() || "";
  const workflowPackKey = isWorkflowPackKey(session.workflowPackKey) ? session.workflowPackKey : "development";
  return {
    id,
    name: session.name?.trim() || `${CHANNEL_META[channel].label} Session ${index + 1}`,
    targetId: session.targetId?.trim() || "",
    enabled: session.enabled !== false,
    token: token || undefined,
    tokenConfigured: session.clearToken === true ? false : session.tokenConfigured === true || !!token,
    tokenMasked: session.clearToken === true ? null : (session.tokenMasked ?? null),
    clearToken: session.clearToken === true ? true : undefined,
    agentId: agentId || undefined,
    workflowPackKey,
  };
}

export function normalizeChannelsConfig(config: MessengerChannelsConfig): MessengerChannelsConfig {
  return MESSENGER_CHANNELS.reduce((acc, channel) => {
    const channelConfig = config[channel] ?? emptyChannelConfig(channel);
    const normalizedToken = channelConfig.token?.trim?.() ?? "";
    acc[channel] = {
      token: normalizedToken || undefined,
      tokenConfigured: channelConfig.clearToken === true ? false : channelConfig.tokenConfigured === true || !!normalizedToken,
      tokenMasked: channelConfig.clearToken === true ? null : (channelConfig.tokenMasked ?? null),
      clearToken: channelConfig.clearToken === true ? true : undefined,
      receiveEnabled:
        channel === "telegram" ? channelConfig.receiveEnabled !== false : channelConfig.receiveEnabled === true,
      sessions: (channelConfig.sessions ?? []).map((session, idx) => normalizeSession(session, channel, idx)),
    };
    return acc;
  }, {} as MessengerChannelsConfig);
}

export function resolveChannelsConfig(
  raw: ChannelSettingsTabProps["form"]["messengerChannels"],
): MessengerChannelsConfig {
  const defaults = defaultChannelsConfig();
  return MESSENGER_CHANNELS.reduce((acc, channel) => {
    acc[channel] = {
      ...defaults[channel],
      ...(raw?.[channel] ?? {}),
      sessions: raw?.[channel]?.sessions ?? defaults[channel].sessions,
    };
    return acc;
  }, {} as MessengerChannelsConfig);
}

export function createEditorState(channelsConfig: MessengerChannelsConfig): ChatEditorState {
  return {
    open: false,
    mode: "create",
    ref: null,
    channel: "telegram",
    token: "",
    tokenConfigured: false,
    tokenMasked: null,
    clearToken: false,
    tokenDirty: false,
    name: "",
    targetId: "",
    enabled: true,
    agentId: "",
    workflowPackKey: "development",
    receiveEnabled: channelsConfig.telegram.receiveEnabled !== false,
  };
}

function maskSecretForClient(token: string): string {
  return `****${token.slice(-4)}`;
}

function scrubSessionSecret(session: MessengerSessionConfig): MessengerSessionConfig {
  const next: MessengerSessionConfig = { ...session };
  const typedToken = typeof next.token === "string" ? next.token.trim() : "";
  const configured = next.clearToken === true ? false : typedToken ? true : next.tokenConfigured === true;
  const masked =
    next.clearToken === true ? null : typedToken ? maskSecretForClient(typedToken) : (next.tokenMasked ?? null);
  delete next.token;
  delete next.clearToken;
  next.tokenConfigured = configured;
  next.tokenMasked = configured ? masked : null;
  return next;
}

export function scrubChannelsConfigSecrets(config: MessengerChannelsConfig): MessengerChannelsConfig {
  return MESSENGER_CHANNELS.reduce((acc, channel) => {
    const channelConfig = config[channel] ?? emptyChannelConfig(channel);
    const nextChannel: MessengerChannelConfig = { ...channelConfig };
    const typedToken = typeof nextChannel.token === "string" ? nextChannel.token.trim() : "";
    const configured = nextChannel.clearToken === true ? false : typedToken ? true : nextChannel.tokenConfigured === true;
    const masked =
      nextChannel.clearToken === true
        ? null
        : typedToken
          ? maskSecretForClient(typedToken)
          : (nextChannel.tokenMasked ?? null);
    delete nextChannel.token;
    delete nextChannel.clearToken;
    nextChannel.tokenConfigured = configured;
    nextChannel.tokenMasked = configured ? masked : null;
    nextChannel.sessions = (nextChannel.sessions ?? []).map((session) => scrubSessionSecret(session));
    acc[channel] = nextChannel;
    return acc;
  }, {} as MessengerChannelsConfig);
}

export function defaultWorkflowPackLabel(t: ChannelSettingsTabProps["t"], key: WorkflowPackKey): string {
  switch (key) {
    case "development":
      return t({ ko: "개발", en: "Development", ja: "開発", zh: "开发" });
    case "novel":
      return t({ ko: "소설", en: "Novel", ja: "小説", zh: "小说" });
    case "report":
      return t({ ko: "보고서", en: "Report", ja: "レポート", zh: "报告" });
    case "video_preprod":
      return t({ ko: "영상기획", en: "Video Preprod", ja: "映像企画", zh: "视频策划" });
    case "web_research_report":
      return t({ ko: "웹서치+리포트", en: "Web Research", ja: "Web調査", zh: "网页调研" });
    case "roleplay":
      return t({ ko: "롤플레이", en: "Roleplay", ja: "ロールプレイ", zh: "角色扮演" });
    default:
      return key;
  }
}
