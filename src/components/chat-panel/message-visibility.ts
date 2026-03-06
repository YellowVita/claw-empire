import type { Message } from "../../types";

function isDirectAgentReplyToCeo(msg: Message, agentId: string): boolean {
  if (msg.sender_type !== "agent" || msg.sender_id !== agentId) return false;
  if (msg.receiver_type !== "agent") return false;
  return !String(msg.receiver_id ?? "").trim();
}

function isCeoOrSystemBroadcast(msg: Message): boolean {
  return (msg.sender_type === "ceo" || msg.sender_type === "system") && msg.receiver_type === "all";
}

function isDirectMessageToSelectedAgent(msg: Message, agentId: string): boolean {
  return (
    (msg.sender_type === "ceo" || msg.sender_type === "system") &&
    msg.receiver_type === "agent" &&
    msg.receiver_id === agentId
  );
}

export function isMessageVisibleInAnnouncementView(msg: Message): boolean {
  return msg.receiver_type === "all" || msg.message_type === "announcement" || msg.message_type === "directive";
}

export function isMessageVisibleInDirectAgentChat(msg: Message, agentId: string): boolean {
  return isCeoOrSystemBroadcast(msg) || isDirectMessageToSelectedAgent(msg, agentId) || isDirectAgentReplyToCeo(msg, agentId);
}
