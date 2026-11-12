import {
  CHAT_REQUEST_REPLY_EVENT, addChatContact, createOrGetSession, hydrateChatStorage,
  isChatStorageHydrated, loadChatContacts, loadChatMessages, pushChatMessage,
  upsertImportedChatMessage, reindexSessionMessageOrdersByTime, normalizeVisionImagePromptLimit, type ChatMessage, type ChatSession,
} from "@/lib/chat-storage";
import { chatDb } from "@/lib/chat-db";
import { cancelFollowUp, isBackgroundReplyGenerating, requestBackgroundChatReply } from "@/lib/follow-up-service";
import { hydrateKvDb, kvGet, kvSetAsync } from "@/lib/kv-db";
import { assertOnlineChatMode } from "@/lib/chat-mode";
import { throwIfAborted } from "@/lib/abort-utils";
import { loadApiConfigs, loadBindingConfig, resolveBinding } from "@/lib/settings-storage";
import { hasActiveGenerationRun } from "@/lib/chat/generation-runtime";
import type { ChatReplyRequestDetail } from "@/lib/chat/reply-request";
import type { StoredChatDocument } from "@/lib/chat-documents";

// Preserve the histories written by the earlier independent companion chat.
const LEGACY_PREFIXES = ["companion_chat_v1_", "companion_chat_v2_"];
const migrating = new Map<string, Promise<ChatSession>>();

export function isCompanionReplyRunning(sessionId: string): boolean {
  const lock = kvGet(`chat-generating:${sessionId}`);
  let activeLock = false;
  try {
    const startedAt = Number(lock && JSON.parse(lock).startedAt);
    activeLock = startedAt > 0 && Date.now() - startedAt < 5 * 60 * 1000;
  } catch { /* An invalid lock is not an active generation. */ }
  return activeLock || hasActiveGenerationRun(sessionId) || isBackgroundReplyGenerating(sessionId);
}

export function assertCompanionVisionConfigured(session: ChatSession): void {
  assertOnlineChatMode(session.id);
  if (normalizeVisionImagePromptLimit(session.visionImagePromptLimit) < 1) {
    throw new Error("请在该角色的聊天设置中，将识图图片数量设为至少 1。");
  }
  const binding = resolveBinding(loadBindingConfig(), session.contactId, "chat");
  const config = loadApiConfigs().find(item => item.id === binding.apiConfigId);
  if (!config) throw new Error("请先为该角色的聊天绑定有效的 API 配置。");
  if (config.enableImageRecognition !== true) {
    throw new Error("请在该角色实际绑定的 API 配置中开启图像识别，并选择支持识图的模型。");
  }
}

export async function openCompanionSession(characterId: string): Promise<ChatSession> {
  const existing = migrating.get(characterId);
  if (existing) return existing;
  const task = (async () => {
    await Promise.all([hydrateKvDb(), hydrateChatStorage()]);
    if (!isChatStorageHydrated()) throw new Error("聊天记录加载失败，请重新打开后重试。");
    if (!loadChatContacts().some(contact => contact.characterId === characterId)) addChatContact(characterId);
    const session = createOrGetSession(characterId);
    const migrationKey = `companion_chat_migrated_v1_${characterId}`;
    if (!kvGet(migrationKey)) for (const prefix of LEGACY_PREFIXES) {
      try {
        const messages: unknown = JSON.parse(kvGet(prefix + characterId) || "[]");
        if (!Array.isArray(messages)) continue;
        for (const item of messages as ChatMessage[]) {
          if (!item || typeof item.id !== "string" || typeof item.createdAt !== "string"
            || typeof item.content !== "string" || !["user", "assistant", "system"].includes(item.role)) continue;
          upsertImportedChatMessage({ ...item, sessionId: session.id, order: undefined });
        }
      } catch { throw new Error("旧伴宠记录读取失败，请重试；原记录仍保留。"); }
    }
    if (!kvGet(migrationKey)) {
      reindexSessionMessageOrdersByTime(session.id);
      await chatDb.sessions.put(session);
      await chatDb.messages.bulkPut(loadChatMessages(session.id));
      await kvSetAsync(migrationKey, "1");
    }
    window.dispatchEvent(new CustomEvent("chat-messages-updated", { detail: { sessionId: session.id } }));
    return session;
  })();
  migrating.set(characterId, task);
  try { return await task; } finally { migrating.delete(characterId); }
}

export function loadCompanionMessages(sessionId: string): ChatMessage[] {
  return loadChatMessages(sessionId);
}

export async function sendCompanionMessage(
  session: ChatSession, text: string, imageRef?: string,
  options?: { signal?: AbortSignal; requireVision?: boolean; document?: StoredChatDocument; onMessagePersisted?: (message: ChatMessage) => void },
): Promise<void> {
  throwIfAborted(options?.signal);
  const trimmed = text.trim();
  if (!trimmed && !options?.document) return;
  assertOnlineChatMode(session.id);
  if (options?.requireVision) {
    assertCompanionVisionConfigured(session);
    if (!imageRef) throw new Error("当前屏幕图片不存在，请重新截图。");
  }
  if (isCompanionReplyRunning(session.id)) throw new Error("对方正在回复，请稍后再发。");
  cancelFollowUp(session.id);
  const message = pushChatMessage({ sessionId: session.id, role: "user", content: trimmed,
    ...(options?.document
      ? { mediaType: "media_file" as const, mediaUrl: options.document.mediaUrl, mediaData: { fileType: "file" as const, ...options.document.metadata } }
      : imageRef ? { mediaType: "image" as const, mediaUrl: imageRef } : {}),
  });
  options?.onMessagePersisted?.(message);
  window.dispatchEvent(new CustomEvent("chat-messages-updated", { detail: { sessionId: session.id } }));
  const detail: ChatReplyRequestDetail = {
    sessionId: session.id, characterId: session.contactId, handled: false,
    signal: options?.signal,
    requiredVisionMessageId: options?.requireVision ? message.id : undefined,
  };
  window.dispatchEvent(new CustomEvent(CHAT_REQUEST_REPLY_EVENT, { detail }));
  if (detail.busy) throw new Error("对方正在回复，消息已发送，请稍后触发回复。");
  if (detail.handled) {
    await detail.completion;
  } else {
    detail.handled = true;
    await requestBackgroundChatReply(session.id, detail);
  }
  throwIfAborted(options?.signal);
}
