import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import type { AttachmentSnapshot, ConversationRef } from "@pi-context/protocol";
import { makeConversationCache } from "../src/conversation-cache.js";

const attachment = (text: string): AttachmentSnapshot => ({
  id: randomUUID(),
  fileUri: `file:///repo/${randomUUID()}.ts`,
  displayPath: "src/value.ts",
  relationship: "inside",
  range: { start: { line: 1, column: 1 }, end: { line: 1, column: text.length + 1 } },
  text,
  languageId: "typescript",
  documentVersion: 1,
  dirty: false,
  capturedAt: "2026-09-02T00:00:00.000Z"
});

const session = (sessionId: string): ConversationRef => ({ kind: "session", sessionId });

describe("ConversationCache", () => {
  it("stores only non-empty inactive conversations and returns summaries most-recent first", () => {
    const cache = makeConversationCache();
    cache.save(session("one"), "One", [{ attachment: attachment("one") }]);
    cache.save({ kind: "new" }, "New chat", []);
    cache.save(session("two"), "Two", [{ attachment: attachment("two") }]);

    assert.deepEqual(cache.summaries({ kind: "new" }).map(({ title, pendingCount }) => ({ title, pendingCount })), [
      { title: "Two", pendingCount: 1 },
      { title: "One", pendingCount: 1 }
    ]);
  });

  it("takes the destination before enforcing the LRU count limit", () => {
    const cache = makeConversationCache(2, 1024);
    cache.save(session("destination"), "Destination", [{ attachment: attachment("a") }]);
    cache.save(session("second"), "Second", [{ attachment: attachment("b") }]);
    cache.save(session("third"), "Third", [{ attachment: attachment("c") }]);

    assert.equal(cache.take(session("destination"))?.title, "Destination");
    assert.deepEqual(cache.summaries({ kind: "new" }).map(({ title }) => title), ["Third", "Second"]);
    assert.deepEqual(cache.drainEvictionNotices(), []);
  });

  it("evicts least-recent entries by count and attachment bytes", () => {
    const countCache = makeConversationCache(2, 1024);
    countCache.save(session("one"), "One", [{ attachment: attachment("a") }]);
    countCache.save(session("two"), "Two", [{ attachment: attachment("b") }]);
    countCache.save(session("three"), "Three", [{ attachment: attachment("c") }]);
    countCache.prune();
    assert.deepEqual(countCache.drainEvictionNotices(), ["One"]);

    const byteCache = makeConversationCache(20, 5);
    byteCache.save(session("one"), "One", [{ attachment: attachment("abc") }]);
    byteCache.save(session("two"), "Two", [{ attachment: attachment("def") }]);
    byteCache.prune();
    assert.deepEqual(byteCache.summaries({ kind: "new" }).map(({ title }) => title), ["Two"]);
    assert.deepEqual(byteCache.drainEvictionNotices(), ["One"]);
  });
});
