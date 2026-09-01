import type { ContextEvent } from "@earendil-works/pi-coding-agent";

type AgentMessage = ContextEvent["messages"][number];

export interface PinnedAttachmentContext {
  readonly prompt: string;
  readonly content: string;
}

const userMessageText = (message: AgentMessage): string | undefined => {
  if (message.role !== "user") return undefined;
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part): part is Extract<(typeof message.content)[number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
};

export const injectAttachmentContextBeforePrompt = (
  messages: ReadonlyArray<AgentMessage>,
  pinned: PinnedAttachmentContext
): Array<AgentMessage> => {
  let promptIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (userMessageText(message) === pinned.prompt) {
      promptIndex = index;
      break;
    }
  }
  if (promptIndex < 0) return [...messages];

  const promptMessage = messages[promptIndex]!;
  const contextMessage: AgentMessage = {
    role: "user",
    content: pinned.content,
    timestamp: promptMessage.timestamp
  };
  return [
    ...messages.slice(0, promptIndex),
    contextMessage,
    ...messages.slice(promptIndex)
  ];
};
