import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AttachmentHistoryEntry, AttachmentSnapshot } from "@pi-context/protocol";
import {
  attachmentContextType,
  attachmentHistorySeedType,
  historySeed,
  reconstructAttachmentHistory
} from "../src/session-history.js";

const attachment = (text: string): AttachmentSnapshot => ({
  id: randomUUID(),
  fileUri: `file:///repo/${text}.ts`,
  displayPath: `${text}.ts`,
  relationship: "inside",
  range: { start: { line: 1, column: 1 }, end: { line: 1, column: text.length + 1 } },
  text,
  languageId: "typescript",
  documentVersion: 1,
  dirty: false,
  capturedAt: "2026-08-10T12:00:00.000Z"
});

const historyEntry = (
  text: string,
  historyId: AttachmentHistoryEntry["historyId"] = randomUUID()
): AttachmentHistoryEntry => ({
  historyId,
  attachment: attachment(text),
  usedAt: "2026-08-10T12:00:00.000Z"
});

const base = () => ({
  id: randomUUID(),
  parentId: null,
  timestamp: "2026-08-10T12:00:00.000Z"
});

describe("session attachment history", () => {
  it("reconstructs a seeded /new history and later prompt deltas", () => {
    const older = historyEntry("older");
    const newer = historyEntry("newer");
    const entries = [{
      ...base(),
      type: "custom",
      customType: attachmentHistorySeedType,
      data: historySeed([older])
    }, {
      ...base(),
      type: "custom_message",
      customType: attachmentContextType,
      content: "hidden context",
      display: false,
      details: { historyEntries: [newer] }
    }] as SessionEntry[];

    assert.deepEqual(reconstructAttachmentHistory(entries), [newer, older]);
  });

  it("moves a replayed history id to the front without duplicating it", () => {
    const original = historyEntry("original");
    const other = historyEntry("other");
    const replay = historyEntry("replay", original.historyId);
    const entries = [{
      ...base(),
      type: "custom",
      customType: attachmentHistorySeedType,
      data: historySeed([other, original])
    }, {
      ...base(),
      type: "custom_message",
      customType: attachmentContextType,
      content: "hidden context",
      display: false,
      details: { historyEntries: [replay] }
    }] as SessionEntry[];

    assert.deepEqual(reconstructAttachmentHistory(entries), [replay, other]);
  });

  it("ignores malformed extension state", () => {
    const entry = {
      ...base(),
      type: "custom",
      customType: attachmentHistorySeedType,
      data: { version: 1, history: [{ unsafe: true }] }
    } as SessionEntry;
    assert.deepEqual(reconstructAttachmentHistory([entry]), []);
  });

  it("restores history after reopening a persisted Pi thread", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-context-history-cwd-"));
    const sessionDir = await mkdtemp(join(tmpdir(), "pi-context-history-sessions-"));
    const expected = historyEntry("persisted");
    const session = SessionManager.create(cwd, sessionDir);
    session.appendCustomMessageEntry(
      attachmentContextType,
      "hidden context",
      false,
      { historyEntries: [expected] }
    );
    session.appendMessage({
      role: "assistant",
      content: [],
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
      timestamp: Date.now()
    });
    const sessionFile = session.getSessionFile();
    assert.ok(sessionFile);

    const reopened = SessionManager.open(sessionFile);
    assert.deepEqual(reconstructAttachmentHistory(reopened.getBranch()), [expected]);
  });

  it("seeds /new from the selected branch instead of the file's latest branch", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-context-tree-cwd-"));
    const sessionDir = await mkdtemp(join(tmpdir(), "pi-context-tree-sessions-"));
    const selected = historyEntry("selected-branch");
    const latest = historyEntry("latest-branch");
    const session = SessionManager.create(cwd, sessionDir);
    session.appendCustomMessageEntry(
      attachmentContextType,
      "selected context",
      false,
      { historyEntries: [selected] }
    );
    session.appendMessage({
      role: "assistant",
      content: [],
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
      timestamp: Date.now()
    });
    const selectedLeaf = session.getLeafId();
    assert.ok(selectedLeaf);
    session.appendCustomMessageEntry(
      attachmentContextType,
      "latest context",
      false,
      { historyEntries: [latest] }
    );
    const sessionFile = session.getSessionFile();
    assert.ok(sessionFile);

    session.branch(selectedLeaf);
    const selectedHistory = reconstructAttachmentHistory(session.getBranch());
    session.appendCustomEntry(attachmentHistorySeedType, historySeed(selectedHistory));

    const reopened = SessionManager.open(sessionFile);
    assert.deepEqual(reconstructAttachmentHistory(reopened.getBranch()), [selected]);
    assert.notDeepEqual(reconstructAttachmentHistory(reopened.getBranch()), [latest, selected]);
  });
});
