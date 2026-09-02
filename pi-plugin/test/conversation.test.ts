import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  conversationTitle,
  normalizeConversationTitle,
  promoteConversation,
  resolveConversation,
  type SessionIdentitySource
} from "../src/conversation.js";

const source = (
  file: string | undefined,
  name: string | undefined = undefined,
  branch: ReadonlyArray<unknown> = []
): SessionIdentitySource => ({
  getSessionId: () => "01234567-89ab-cdef",
  getSessionFile: () => file,
  getSessionName: () => name,
  getBranch: () => branch
});

describe("conversation identity", () => {
  it("uses the singleton new-chat identity until the session file exists", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-context-conversation-"));
    const file = join(directory, "session.jsonl");
    try {
      const session = source(file);
      assert.deepEqual(resolveConversation("startup", session), { kind: "new" });
      assert.deepEqual(resolveConversation("fork", session), {
        kind: "session",
        sessionId: "01234567-89ab-cdef"
      });
      await writeFile(file, "session", "utf8");
      assert.deepEqual(promoteConversation({ kind: "new" }, session), {
        kind: "session",
        sessionId: "01234567-89ab-cdef"
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("prefers an explicit name, then the first user prompt, then identity fallback", () => {
    assert.equal(conversationTitle({ kind: "new" }, source(undefined, "  Named   chat  ")), "Named chat");
    assert.equal(conversationTitle({ kind: "new" }, source(undefined, undefined, [{
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "  First\n prompt " }] }
    }])), "First prompt");
    assert.equal(conversationTitle({ kind: "new" }, source(undefined)), "New chat");
    assert.equal(
      conversationTitle({ kind: "session", sessionId: "01234567-89ab-cdef" }, source(undefined)),
      "Session 01234567"
    );
  });

  it("truncates normalized titles to 80 Unicode characters", () => {
    const title = normalizeConversationTitle("😀".repeat(100));
    assert.equal([...title].length, 80);
    assert.ok(title.endsWith("…"));
  });
});
