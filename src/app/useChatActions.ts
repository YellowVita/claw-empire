import { useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";

import * as api from "../api";
import type { Agent, Message } from "../types";
import type { ProjectMetaPayload } from "./types";

interface UseChatActionsParams {
  setMessages: Dispatch<SetStateAction<Message[]>>;
  setChatAgent: Dispatch<SetStateAction<Agent | null>>;
  setShowChat: Dispatch<SetStateAction<boolean>>;
  setUnreadAgentIds: Dispatch<SetStateAction<Set<string>>>;
}

export function useChatActions({
  setMessages,
  setChatAgent,
  setShowChat,
  setUnreadAgentIds,
}: UseChatActionsParams) {
  const handleSendMessage = useCallback(
    async (
      content: string,
      receiverType: "agent" | "department" | "all",
      receiverId?: string,
      messageType?: string,
      projectMeta?: ProjectMetaPayload,
    ) => {
      try {
        await api.sendMessage({
          receiver_type: receiverType,
          receiver_id: receiverId,
          content,
          message_type: (messageType as "chat" | "task_assign" | "report") || "chat",
          project_id: projectMeta?.project_id,
          project_path: projectMeta?.project_path,
          project_context: projectMeta?.project_context,
        });
        const messages = await api.getMessages({ receiver_type: receiverType, receiver_id: receiverId, limit: 50 });
        setMessages(messages);
      } catch (error) {
        console.error("Send message failed:", error);
      }
    },
    [setMessages],
  );

  const handleSendAnnouncement = useCallback(async (content: string) => {
    try {
      await api.sendAnnouncement(content);
    } catch (error) {
      console.error("Announcement failed:", error);
    }
  }, []);

  const handleSendDirective = useCallback(async (content: string, projectMeta?: ProjectMetaPayload) => {
    try {
      if (projectMeta?.project_id || projectMeta?.project_path || projectMeta?.project_context) {
        await api.sendDirectiveWithProject({
          content,
          project_id: projectMeta.project_id,
          project_path: projectMeta.project_path,
          project_context: projectMeta.project_context,
        });
      } else {
        await api.sendDirective(content);
      }
    } catch (error) {
      console.error("Directive failed:", error);
    }
  }, []);

  const handleOpenChat = useCallback(
    (agent: Agent) => {
      setChatAgent(agent);
      setShowChat(true);
      setUnreadAgentIds((prev) => {
        if (!prev.has(agent.id)) return prev;
        const next = new Set(prev);
        next.delete(agent.id);
        return next;
      });
      api
        .getMessages({ receiver_type: "agent", receiver_id: agent.id, limit: 50 })
        .then(setMessages)
        .catch(console.error);
    },
    [setChatAgent, setShowChat, setUnreadAgentIds, setMessages],
  );

  const handleOpenAnnouncement = useCallback(() => {
    setChatAgent(null);
    setShowChat(true);
    api.getMessages({ receiver_type: "all", limit: 50 }).then(setMessages).catch(console.error);
  }, [setChatAgent, setShowChat, setMessages]);

  const handleClearMessages = useCallback(
    async (agentId?: string) => {
      try {
        await api.clearMessages(agentId);
        setMessages([]);
      } catch (error) {
        console.error("Clear messages failed:", error);
      }
    },
    [setMessages],
  );

  return {
    handleSendMessage,
    handleSendAnnouncement,
    handleSendDirective,
    handleOpenChat,
    handleOpenAnnouncement,
    handleClearMessages,
  };
}
