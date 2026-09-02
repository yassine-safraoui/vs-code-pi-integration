import { existsSync } from "node:fs";
import type {
  ConversationRef,
  ActiveConversation
} from "@pi-context/protocol";

export interface SessionIdentitySource {
  readonly getSessionId: () => string;
  readonly getSessionFile: () => string | undefined;
  readonly getSessionName: () => string | undefined;
  readonly getBranch: () => ReadonlyArray<unknown>;
}

export type SessionStartReason = "startup" | "reload" | "new" | "resume" | "fork";

export const conversationKey = (ref: ConversationRef): string =>
  ref.kind === "new" ? "new" : `session:${ref.sessionId}`;

export const sameConversation = (left: ConversationRef, right: ConversationRef): boolean =>
  conversationKey(left) === conversationKey(right);

export const isSessionResumable = (session: SessionIdentitySource): boolean => {
  const file = session.getSessionFile();
  return file !== undefined && existsSync(file);
};

export const resolveConversation = (
  reason: SessionStartReason,
  session: SessionIdentitySource
): ConversationRef => reason === "fork" || isSessionResumable(session)
  ? { kind: "session", sessionId: session.getSessionId() }
  : { kind: "new" };

export const promoteConversation = (
  ref: ConversationRef,
  session: SessionIdentitySource
): ConversationRef => ref.kind === "new" && isSessionResumable(session)
  ? { kind: "session", sessionId: session.getSessionId() }
  : ref;

const messageText = (message: unknown): string | undefined => {
  if (typeof message !== "object" || message === null) return undefined;
  const candidate = message as { readonly role?: unknown; readonly content?: unknown };
  if (candidate.role !== "user") return undefined;
  if (typeof candidate.content === "string") return candidate.content;
  if (!Array.isArray(candidate.content)) return undefined;
  const text = candidate.content.flatMap((part) => {
    if (typeof part !== "object" || part === null) return [];
    const value = (part as { readonly type?: unknown; readonly text?: unknown });
    return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
  }).join(" ");
  return text || undefined;
};

const firstUserPrompt = (branch: ReadonlyArray<unknown>): string | undefined => {
  for (const entry of branch) {
    if (typeof entry !== "object" || entry === null) continue;
    const candidate = entry as { readonly type?: unknown; readonly message?: unknown };
    if (candidate.type !== "message") continue;
    const text = messageText(candidate.message);
    if (text) return text;
  }
  return undefined;
};

export const normalizeConversationTitle = (value: string): string => {
  const normalized = value.replace(/\s+/gu, " ").trim();
  const characters = [...normalized];
  return characters.length <= 80 ? normalized : `${characters.slice(0, 79).join("")}…`;
};

export const conversationTitle = (
  ref: ConversationRef,
  session: SessionIdentitySource
): string => {
  const source = session.getSessionName() ?? firstUserPrompt(session.getBranch());
  const normalized = source ? normalizeConversationTitle(source) : "";
  if (normalized) return normalized;
  return ref.kind === "new" ? "New chat" : `Session ${ref.sessionId.slice(0, 8)}`;
};

export const activeConversation = (
  ref: ConversationRef,
  session: SessionIdentitySource
): ActiveConversation => ({ ...ref, title: conversationTitle(ref, session) });
