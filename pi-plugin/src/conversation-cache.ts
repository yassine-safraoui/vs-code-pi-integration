import {
  utf8ByteLength,
  type ConversationRef,
  type InactiveConversationSummary
} from "@pi-context/protocol";
import type { PendingAttachmentCheckpoint } from "./attachment-store.js";
import { conversationKey, sameConversation } from "./conversation.js";

export const MAX_INACTIVE_CONVERSATIONS = 20;
export const MAX_INACTIVE_ATTACHMENT_BYTES = 5 * 1024 * 1024;

export interface ConversationCheckpoint {
  readonly ref: ConversationRef;
  readonly title: string;
  readonly pending: ReadonlyArray<PendingAttachmentCheckpoint>;
  readonly attachmentBytes: number;
}

export interface ConversationCache {
  readonly save: (
    ref: ConversationRef,
    title: string,
    pending: ReadonlyArray<PendingAttachmentCheckpoint>
  ) => void;
  readonly peek: (ref: ConversationRef) => ConversationCheckpoint | undefined;
  readonly take: (ref: ConversationRef) => ConversationCheckpoint | undefined;
  readonly prune: () => void;
  readonly summaries: (active: ConversationRef) => ReadonlyArray<InactiveConversationSummary>;
  readonly drainEvictionNotices: () => ReadonlyArray<string>;
}

const checkpointBytes = (pending: ReadonlyArray<PendingAttachmentCheckpoint>): number =>
  pending.reduce((total, item) => total + utf8ByteLength(item.attachment.text), 0);

export const makeConversationCache = (
  maxConversations = MAX_INACTIVE_CONVERSATIONS,
  maxBytes = MAX_INACTIVE_ATTACHMENT_BYTES
): ConversationCache => {
  const entries = new Map<string, ConversationCheckpoint>();
  const evictionNotices: string[] = [];

  const prune = (): void => {
    let bytes = [...entries.values()].reduce((total, entry) => total + entry.attachmentBytes, 0);
    while (entries.size > maxConversations || bytes > maxBytes) {
      const oldest = entries.entries().next().value as [string, ConversationCheckpoint] | undefined;
      if (!oldest) break;
      entries.delete(oldest[0]);
      bytes -= oldest[1].attachmentBytes;
      evictionNotices.push(oldest[1].title);
    }
  };

  return {
    save: (ref, title, pending) => {
      const key = conversationKey(ref);
      entries.delete(key);
      if (pending.length === 0) return;
      entries.set(key, {
        ref,
        title,
        pending: pending.map((item) => ({ ...item })),
        attachmentBytes: checkpointBytes(pending)
      });
    },
    peek: (ref) => entries.get(conversationKey(ref)),
    take: (ref) => {
      const key = conversationKey(ref);
      const checkpoint = entries.get(key);
      entries.delete(key);
      prune();
      return checkpoint;
    },
    prune,
    summaries: (active) => [...entries.values()]
      .reverse()
      .filter((entry) => !sameConversation(entry.ref, active))
      .map((entry) => ({
        ...entry.ref,
        title: entry.title,
        pendingCount: entry.pending.length
      })),
    drainEvictionNotices: () => evictionNotices.splice(0)
  };
};

const cacheSymbol = Symbol.for("pi-context.conversation-cache.v1");

export const getProcessConversationCache = (): ConversationCache => {
  const processGlobal = globalThis as typeof globalThis & { [cacheSymbol]?: ConversationCache };
  return processGlobal[cacheSymbol] ??= makeConversationCache();
};
