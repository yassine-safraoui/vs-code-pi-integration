import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import { injectAttachmentContextBeforePrompt } from "../src/agent-context.js";

type AgentMessage = ContextEvent["messages"][number];
type UserMessage = Extract<AgentMessage, { role: "user" }>;

const user = (content: UserMessage["content"], timestamp: number): UserMessage => ({
  role: "user",
  content,
  timestamp
});

const userContent = (message: AgentMessage | undefined): UserMessage["content"] | undefined =>
  message?.role === "user" ? message.content : undefined;

describe("transient attachment context", () => {
  it("inserts context immediately before the current prompt without changing it", () => {
    const prompt = user([
      { type: "text", text: "Explain this" },
      { type: "image", data: "base64", mimeType: "image/png" }
    ], 3);
    const messages: AgentMessage[] = [
      user("Earlier prompt", 1),
      {
        role: "assistant",
        content: [{ type: "text", text: "Earlier answer" }],
        api: "test",
        provider: "test",
        model: "test",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        },
        stopReason: "stop",
        timestamp: 2
      },
      prompt
    ];

    const result = injectAttachmentContextBeforePrompt(messages, {
      prompt: "Explain this",
      content: "attachments[1]{path}:\n  src/value.ts"
    });

    assert.equal(result.length, messages.length + 1);
    assert.equal(result.at(-2)?.role, "user");
    assert.equal(userContent(result.at(-2)), "attachments[1]{path}:\n  src/value.ts");
    assert.strictEqual(result.at(-1), prompt);
  });

  it("anchors repeated prompt text to its latest occurrence", () => {
    const first = user("Repeat", 1);
    const latest = user("Repeat", 3);
    const result = injectAttachmentContextBeforePrompt([first, user("Other", 2), latest], {
      prompt: "Repeat",
      content: "context"
    });

    assert.deepEqual(result.map(userContent), ["Repeat", "Other", "context", "Repeat"]);
    assert.strictEqual(result.at(-1), latest);
  });

  it("leaves messages unchanged when the accepted prompt cannot be found", () => {
    const messages = [user("Actual", 1)];
    const result = injectAttachmentContextBeforePrompt(messages, {
      prompt: "Missing",
      content: "context"
    });

    assert.deepEqual(result, messages);
  });
});
