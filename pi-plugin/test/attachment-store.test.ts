import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { Effect } from "effect";
import { PROTOCOL_VERSION, type AttachmentSnapshot } from "@pi-context/protocol";
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

describe("AttachmentStore", () => {
  it("is idempotent and advances revisions only for changes", async () => {
    const store = await Effect.runPromise(makeAttachmentStore(randomUUID()));
    const attachment = item();
    const mutation = { protocolVersion: PROTOCOL_VERSION, requestId: randomUUID(), type: "attachSelections", attachments: [attachment] } as const;
    assert.equal((await Effect.runPromise(store.apply(mutation))).revision, 1);
    assert.equal((await Effect.runPromise(store.apply({ ...mutation, requestId: randomUUID() }))).revision, 1);
    assert.equal((await Effect.runPromise(store.consume([attachment.id]))).revision, 2);
  });

  it("rejects attachment id reuse with different content atomically", async () => {
    const store = await Effect.runPromise(makeAttachmentStore(randomUUID()));
    const id = randomUUID();
    await Effect.runPromise(store.apply({ protocolVersion: 1, requestId: randomUUID(), type: "attachSelections", attachments: [item(id)] }));
    const result = await Effect.runPromise(Effect.either(store.apply({
      protocolVersion: 1,
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
    await Effect.runPromise(store.apply({ protocolVersion: 1, requestId: randomUUID(), type: "attachSelections", attachments: [first] }));
    const state = await Effect.runPromise(store.apply({
      protocolVersion: 1,
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
    await Effect.runPromise(store.apply({ protocolVersion: 1, requestId: randomUUID(), type: "attachSelections", attachments: [first] }));
    const state = await Effect.runPromise(store.apply({
      protocolVersion: 1,
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
    await Effect.runPromise(store.apply({ protocolVersion: 1, requestId: randomUUID(), type: "attachSelections", attachments: [existing] }));
    const state = await Effect.runPromise(store.apply({
      protocolVersion: 1,
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
      protocolVersion: 1,
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
      protocolVersion: 1,
      requestId: randomUUID(),
      type: "attachSelections",
      attachments: [item(), item(randomUUID(), "const value = 1;", 1, 1, "file:///repo/src/other.ts")]
    }));
    assert.equal(state.attachments.length, 2);
  });

  it("rejects cross-version overlaps atomically", async () => {
    const store = await Effect.runPromise(makeAttachmentStore(randomUUID()));
    const first = item(randomUUID(), "abcdef", 1, 1);
    await Effect.runPromise(store.apply({ protocolVersion: 1, requestId: randomUUID(), type: "attachSelections", attachments: [first] }));
    const result = await Effect.runPromise(Effect.either(store.apply({
      protocolVersion: 1,
      requestId: randomUUID(),
      type: "attachSelections",
      attachments: [item(randomUUID(), "defghi", 4, 2)]
    })));
    assert.equal(result._tag, "Left");
    assert.deepEqual((await Effect.runPromise(store.snapshot)).attachments, [first]);
  });
});
