import { describe, expect, it } from "vitest";

import type { Message } from "../../types";
import { isMessageVisibleInAnnouncementView, isMessageVisibleInDirectAgentChat } from "./message-visibility";

function buildMessage(overrides: Partial<Message>): Message {
  return {
    id: overrides.id ?? "msg-1",
    sender_type: overrides.sender_type ?? "ceo",
    sender_id: overrides.sender_id ?? null,
    receiver_type: overrides.receiver_type ?? "agent",
    receiver_id: Object.prototype.hasOwnProperty.call(overrides, "receiver_id")
      ? (overrides.receiver_id ?? null)
      : "planning-lead",
    content: overrides.content ?? "hello",
    message_type: overrides.message_type ?? "chat",
    task_id: overrides.task_id ?? null,
    created_at: overrides.created_at ?? 1,
  };
}

describe("message visibility", () => {
  it("keeps direct chat scoped to CEO/system messages and the selected agent's direct replies", () => {
    const agentId = "planning-lead";

    expect(
      isMessageVisibleInDirectAgentChat(
        buildMessage({
          id: "ceo-direct",
          sender_type: "ceo",
          receiver_type: "agent",
          receiver_id: agentId,
        }),
        agentId,
      ),
    ).toBe(true);

    expect(
      isMessageVisibleInDirectAgentChat(
        buildMessage({
          id: "ceo-directive",
          sender_type: "ceo",
          receiver_type: "all",
          receiver_id: null,
          message_type: "directive",
        }),
        agentId,
      ),
    ).toBe(true);

    expect(
      isMessageVisibleInDirectAgentChat(
        buildMessage({
          id: "agent-direct",
          sender_type: "agent",
          sender_id: agentId,
          receiver_type: "agent",
          receiver_id: null,
        }),
        agentId,
      ),
    ).toBe(true);

    expect(
      isMessageVisibleInDirectAgentChat(
        buildMessage({
          id: "foreign-broadcast",
          sender_type: "agent",
          sender_id: "novel-lead",
          receiver_type: "all",
          receiver_id: null,
        }),
        agentId,
      ),
    ).toBe(false);

    expect(
      isMessageVisibleInDirectAgentChat(
        buildMessage({
          id: "foreign-same-task",
          sender_type: "agent",
          sender_id: "novel-lead",
          receiver_type: "agent",
          receiver_id: null,
          task_id: "shared-task",
        }),
        agentId,
      ),
    ).toBe(false);

    expect(
      isMessageVisibleInDirectAgentChat(
        buildMessage({
          id: "selected-agent-delegation",
          sender_type: "agent",
          sender_id: agentId,
          receiver_type: "agent",
          receiver_id: "planning-member",
        }),
        agentId,
      ),
    ).toBe(false);
  });

  it("keeps the announcement view focused on broadcasts", () => {
    expect(
      isMessageVisibleInAnnouncementView(
        buildMessage({
          receiver_type: "all",
          receiver_id: null,
        }),
      ),
    ).toBe(true);

    expect(
      isMessageVisibleInAnnouncementView(
        buildMessage({
          sender_type: "ceo",
          receiver_type: "agent",
          receiver_id: "planning-lead",
        }),
      ),
    ).toBe(false);
  });
});
