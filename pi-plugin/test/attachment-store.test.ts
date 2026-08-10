import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { Effect } from "effect";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_HISTORY_ENTRIES,
  PROTOCOL_VERSION,
  type AttachmentSnapshot,
  type Mutation
} from "@pi-context/protocol";
import { makeAttachmentStore } from "../src/attachment-store.js";

const item = (
  id = randomUUID(),
  text = "const value = 1;",
  startColumn = 1,
  documentVersion = 1,
  fileUri = "file:///repo/src/value.ts"
): AttachmentSnapshot => ({
  id,
  fileUri,
  displayPath: "src/value.ts",
  relationship: "inside",
  range: { start: { line: 1, column: startColumn }, end: { line: 1, column: startColumn + text.length } },
  text,
  languageId: "typescript",
  documentVersion,
  dirty: false,
  capturedAt: new Date().toISOString()
});

const attach = (attachments: ReadonlyArray<AttachmentSnapshot>): Mutation => ({
  protocolVersion: PROTOCOL_VERSION,
  requestId: randomUUID(),
  type: "attachSelections",
  attachments
});

describe("AttachmentStore", () => {
  it("is idempotent and advances revisions only for changes", async () => {
    const store = await Effect.runPromise(makeAttachmentStore(randomUUID()));
    const attachment = item();
    const mutation = { protocolVersion: PROTOCOL_VERSION, requestId: randomUUID(), type: "attachSelections", attachments: [attachment] } as const;
    assert.equal((await Effect.runPromise(store.apply(mutation))).revision, 1);
    assert.equal((await Effect.runPromise(store.apply({ ...mutation, requestId: randomUUID() }))).revision, 1);
    assert.deepEqual((await Effect.runPromise(store.consumeForPrompt([attachment.id]))).attachments, [attachment]);
    assert.equal((await Effect.runPromise(store.snapshot)).revision, 2);
  });

  it("rejects attachment id reuse with different content atomically", async () => {
    const store = await Effect.runPromise(makeAttachmentStore(randomUUID()));
    const id = randomUUID();
    await Effect.runPromise(store.apply({ protocolVersion: PROTOCOL_VERSION, requestId: randomUUID(), type: "attachSelections", attachments: [item(id)] }));
    const result = await Effect.runPromise(Effect.either(store.apply({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      type: "attachSelections",
      attachments: [item(id, "changed")]
    })));
    assert.equal(result._tag, "Left");
    assert.equal((await Effect.runPromise(store.snapshot)).attachments[0]?.text, "const value = 1;");
  });

  it("treats reattaching the same selection with a fresh id as a no-op", async () => {
    const store = await Effect.runPromise(makeAttachmentStore(randomUUID()));
    const first = item(randomUUID(), "value", 7);
    await Effect.runPromise(store.apply({ protocolVersion: PROTOCOL_VERSION, requestId: randomUUID(), type: "attachSelections", attachments: [first] }));
    const state = await Effect.runPromise(store.apply({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      type: "attachSelections",
      attachments: [item(randomUUID(), "value", 7)]
    }));
    assert.equal(state.revision, 1);
    assert.deepEqual(state.attachments, [first]);
  });

  it("expands an existing attachment when a new selection partially overlaps it", async () => {
    const store = await Effect.runPromise(makeAttachmentStore(randomUUID()));
    const first = item(randomUUID(), "abcdef", 1);
    await Effect.runPromise(store.apply({ protocolVersion: PROTOCOL_VERSION, requestId: randomUUID(), type: "attachSelections", attachments: [first] }));
    const state = await Effect.runPromise(store.apply({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      type: "attachSelections",
      attachments: [item(randomUUID(), "defghi", 4)]
    }));
    assert.equal(state.revision, 2);
    assert.equal(state.attachments.length, 1);
    assert.equal(state.attachments[0]?.id, first.id);
    assert.deepEqual(state.attachments[0]?.range, {
      start: { line: 1, column: 1 },
      end: { line: 1, column: 10 }
    });
    assert.equal(state.attachments[0]?.text, "abcdefghi");
  });

  it("merges a multiline selection that expands before the existing range", async () => {
    const store = await Effect.runPromise(makeAttachmentStore(randomUUID()));
    const existing: AttachmentSnapshot = {
      ...item(),
      range: { start: { line: 2, column: 3 }, end: { line: 3, column: 5 } },
      text: "cde\nfghi"
    };
    const incoming: AttachmentSnapshot = {
      ...item(),
      range: { start: { line: 1, column: 2 }, end: { line: 2, column: 6 } },
      text: "ab\nxxcde"
    };
    await Effect.runPromise(store.apply({ protocolVersion: PROTOCOL_VERSION, requestId: randomUUID(), type: "attachSelections", attachments: [existing] }));
    const state = await Effect.runPromise(store.apply({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      type: "attachSelections",
      attachments: [incoming]
    }));
    assert.equal(state.attachments[0]?.id, existing.id);
    assert.deepEqual(state.attachments[0]?.range, {
      start: { line: 1, column: 2 },
      end: { line: 3, column: 5 }
    });
    assert.equal(state.attachments[0]?.text, "ab\nxxcde\nfghi");
  });

  it("merges a batch transitively while keeping touching ranges separate", async () => {
    const store = await Effect.runPromise(makeAttachmentStore(randomUUID()));
    const state = await Effect.runPromise(store.apply({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      type: "attachSelections",
      attachments: [
        item(randomUUID(), "abcd", 1),
        item(randomUUID(), "ghij", 7),
        item(randomUUID(), "defg", 4),
        item(randomUUID(), "klm", 11)
      ]
    }));
    assert.equal(state.attachments.length, 2);
    assert.equal(state.attachments[0]?.text, "abcdefghij");
    assert.equal(state.attachments[1]?.text, "klm");
  });

  it("keeps selections from different files separate", async () => {
    const store = await Effect.runPromise(makeAttachmentStore(randomUUID()));
    const state = await Effect.runPromise(store.apply({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      type: "attachSelections",
      attachments: [item(), item(randomUUID(), "const value = 1;", 1, 1, "file:///repo/src/other.ts")]
    }));
    assert.equal(state.attachments.length, 2);
  });

  it("rejects cross-version overlaps atomically", async () => {
    const store = await Effect.runPromise(makeAttachmentStore(randomUUID()));
    const first = item(randomUUID(), "abcdef", 1, 1);
    await Effect.runPromise(store.apply({ protocolVersion: PROTOCOL_VERSION, requestId: randomUUID(), type: "attachSelections", attachments: [first] }));
    const result = await Effect.runPromise(Effect.either(store.apply({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      type: "attachSelections",
      attachments: [item(randomUUID(), "defghi", 4, 2)]
    })));
    assert.equal(result._tag, "Left");
    assert.deepEqual((await Effect.runPromise(store.snapshot)).attachments, [first]);
  });

  it("records only the merged snapshots consumed by a prompt", async () => {
    const store = await Effect.runPromise(makeAttachmentStore(randomUUID()));
    await Effect.runPromise(store.apply(attach([
      item(randomUUID(), "abcdef", 1),
      item(randomUUID(), "defghi", 4)
    ])));
    const pending = (await Effect.runPromise(store.snapshot)).attachments[0]!;
    assert.equal(pending.text, "abcdefghi");

    assert.deepEqual((await Effect.runPromise(store.consumeForPrompt([pending.id]))).attachments, [pending]);
    const state = await Effect.runPromise(store.snapshot);
    assert.deepEqual(state.attachments, []);
    assert.equal(state.history.length, 1);
    assert.deepEqual(state.history[0]?.attachment, pending);
  });

  it("starts with reconstructed Pi session history", async () => {
    const previous = item();
    const history = [{
      historyId: randomUUID(),
      attachment: previous,
      usedAt: "2026-08-10T12:00:00.000Z"
    }];
    const store = await Effect.runPromise(makeAttachmentStore(randomUUID(), undefined, {
      initialHistory: history
    }));
    assert.deepEqual((await Effect.runPromise(store.snapshot)).history, history);
  });

  it("does not record pending attachments that were removed or cleared", async () => {
    const store = await Effect.runPromise(makeAttachmentStore(randomUUID()));
    const removed = item();
    await Effect.runPromise(store.apply(attach([removed])));
    await Effect.runPromise(store.apply({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      type: "removeAttachment",
      attachmentId: removed.id
    }));
    assert.deepEqual(await Effect.runPromise(store.consumeForPrompt([removed.id])), {
      attachments: [],
      historyEntries: []
    });

    const cleared = item();
    await Effect.runPromise(store.apply(attach([cleared])));
    await Effect.runPromise(store.apply({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      type: "clearAttachments"
    }));
    assert.deepEqual((await Effect.runPromise(store.snapshot)).history, []);
  });

  it("keeps overlapping snapshots from different prompts as separate history entries", async () => {
    const store = await Effect.runPromise(makeAttachmentStore(randomUUID()));
    const first = item(randomUUID(), "abcdef", 1);
    await Effect.runPromise(store.apply(attach([first])));
    await Effect.runPromise(store.consumeForPrompt([first.id]));

    const second = item(randomUUID(), "defghi", 4);
    await Effect.runPromise(store.apply(attach([second])));
    await Effect.runPromise(store.consumeForPrompt([second.id]));
    const state = await Effect.runPromise(store.snapshot);
    assert.deepEqual(state.history.map(({ attachment }) => attachment.text), ["defghi", "abcdef"]);
  });

  it("updates and moves an explicitly replayed history entry without duplicating it", async () => {
    let tick = 0;
    const store = await Effect.runPromise(makeAttachmentStore(randomUUID(), undefined, {
      now: () => `2026-08-10T12:00:0${tick++}.000Z`
    }));
    const first = item(randomUUID(), "first", 1, 1, "file:///repo/first.ts");
    const second = item(randomUUID(), "second", 1, 1, "file:///repo/second.ts");
    await Effect.runPromise(store.apply(attach([first])));
    await Effect.runPromise(store.consumeForPrompt([first.id]));
    await Effect.runPromise(store.apply(attach([second])));
    await Effect.runPromise(store.consumeForPrompt([second.id]));
    const original = (await Effect.runPromise(store.snapshot)).history[1]!;

    const replayed = await Effect.runPromise(store.apply({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      type: "reattachHistory",
      historyId: original.historyId
    }));
    const replay = replayed.attachments[0]!;
    assert.notEqual(replay.id, original.attachment.id);
    assert.notEqual(replay.capturedAt, original.attachment.capturedAt);
    assert.equal(replay.text, original.attachment.text);
    await Effect.runPromise(store.consumeForPrompt([replay.id]));

    const state = await Effect.runPromise(store.snapshot);
    assert.equal(state.history.length, 2);
    assert.equal(state.history[0]?.historyId, original.historyId);
    assert.equal(state.history[0]?.attachment.id, replay.id);
  });

  it("breaks replay lineage when the pending replay merges with an independent capture", async () => {
    const store = await Effect.runPromise(makeAttachmentStore(randomUUID()));
    const original = item(randomUUID(), "abcdef", 1);
    await Effect.runPromise(store.apply(attach([original])));
    await Effect.runPromise(store.consumeForPrompt([original.id]));
    const oldHistory = (await Effect.runPromise(store.snapshot)).history[0]!;
    const replayState = await Effect.runPromise(store.apply({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      type: "reattachHistory",
      historyId: oldHistory.historyId
    }));
    await Effect.runPromise(store.apply(attach([item(randomUUID(), "defghi", 4)])));
    const merged = (await Effect.runPromise(store.snapshot)).attachments[0]!;
    assert.equal(merged.text, "abcdefghi");
    await Effect.runPromise(store.consumeForPrompt([replayState.attachments[0]!.id]));

    const history = (await Effect.runPromise(store.snapshot)).history;
    assert.equal(history.length, 2);
    assert.notEqual(history[0]?.historyId, oldHistory.historyId);
    assert.equal(history[1]?.historyId, oldHistory.historyId);
  });

  it("evicts the oldest history entries at the count and byte limits", async () => {
    const countStore = await Effect.runPromise(makeAttachmentStore(randomUUID()));
    for (let index = 0; index < MAX_HISTORY_ENTRIES + 1; index += 1) {
      const attachment = item(randomUUID(), `item-${index}`, 1, 1, `file:///repo/${index}.ts`);
      await Effect.runPromise(countStore.apply(attach([attachment])));
      await Effect.runPromise(countStore.consumeForPrompt([attachment.id]));
    }
    const countHistory = (await Effect.runPromise(countStore.snapshot)).history;
    assert.equal(countHistory.length, MAX_HISTORY_ENTRIES);
    assert.equal(countHistory.at(-1)?.attachment.text, "item-1");

    const byteStore = await Effect.runPromise(makeAttachmentStore(randomUUID()));
    for (let index = 0; index < 17; index += 1) {
      const attachment = item(
        randomUUID(),
        String(index % 10).repeat(MAX_ATTACHMENT_BYTES),
        1,
        1,
        `file:///repo/large-${index}.ts`
      );
      await Effect.runPromise(byteStore.apply(attach([attachment])));
      await Effect.runPromise(byteStore.consumeForPrompt([attachment.id]));
    }
    assert.equal((await Effect.runPromise(byteStore.snapshot)).history.length, 16);
  });
});
