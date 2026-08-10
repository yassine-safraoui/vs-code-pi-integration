import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Effect, Schema } from "effect";
import { join } from "node:path";
import {
  AttachmentSnapshotSchema,
  AttachmentStateSchema,
  DISCOVERY_STALE_AFTER_MS,
  MAX_ATTACHMENT_BYTES,
  MAX_HISTORY_BYTES,
  MAX_HISTORY_ENTRIES,
  PROTOCOL_VERSION,
  classifyPath,
  createVsCodeOpenAttachmentUri,
  decodeVsCodeOpenAttachmentUri,
  isPathInside,
  isDiscoveryRecordStale,
  registryPaths,
  validateAttachmentBatch
} from "../src/index.js";

const attachment = (text = "const answer = 42;") => Schema.decodeUnknownSync(AttachmentSnapshotSchema)({
  id: "5ee16f5e-40f9-4d78-a2c2-9f79045cb1c4",
  fileUri: "file:///work/src/value.ts",
  displayPath: "src/value.ts",
  relationship: "inside",
  range: { start: { line: 1, column: 1 }, end: { line: 1, column: 19 } },
  text,
  languageId: "typescript",
  documentVersion: 3,
  dirty: true,
  capturedAt: "2026-08-08T12:00:00.000Z"
});

describe("protocol", () => {
  it("decodes a valid attachment and validates limits", async () => {
    const value = attachment();
    assert.equal((await Effect.runPromise(validateAttachmentBatch([value])))[0]?.text, value.text);
    assert.equal(PROTOCOL_VERSION, 3);
    assert.equal(MAX_HISTORY_ENTRIES, 50);
    assert.equal(MAX_HISTORY_BYTES, 1024 * 1024);
  });

  it("rejects oversized UTF-8 selections", async () => {
    const result = await Effect.runPromise(Effect.either(validateAttachmentBatch([attachment("é".repeat(MAX_ATTACHMENT_BYTES))])));
    assert.equal(result._tag, "Left");
  });

  it("handles Windows containment, drive boundaries, and separators", () => {
    assert.equal(isPathInside("C:\\Repo\\src\\A.ts", "c:\\repo", "win32"), true);
    assert.equal(isPathInside("D:\\Repo\\A.ts", "C:\\Repo", "win32"), false);
    assert.deepEqual(classifyPath("C:\\Repo\\src\\A.ts", "C:\\Repo", "win32"), {
      relationship: "inside",
      displayPath: "src/A.ts"
    });
  });

  it("handles POSIX containment without prefix confusion", () => {
    assert.equal(isPathInside("/repo/src/a.ts", "/repo", "darwin"), true);
    assert.equal(isPathInside("/repository/a.ts", "/repo", "darwin"), false);
  });

  it("uses the dedicated per-user registry", () => {
    assert.equal(registryPaths(join("Users", "test")).root, join("Users", "test", ".pi-context", "run", "v3"));
  });

  it("expires a discovery record when its heartbeat reaches the stale threshold", () => {
    const now = Date.parse("2026-08-10T12:06:00.000Z");
    assert.equal(isDiscoveryRecordStale({ lastActiveAt: new Date(now - DISCOVERY_STALE_AFTER_MS + 1).toISOString() }, now), false);
    assert.equal(isDiscoveryRecordStale({ lastActiveAt: new Date(now - DISCOVERY_STALE_AFTER_MS).toISOString() }, now), true);
  });

  it("decodes authoritative pending and previously used attachment state", () => {
    const value = attachment();
    const state = Schema.decodeUnknownSync(AttachmentStateSchema)({
      protocolVersion: PROTOCOL_VERSION,
      revision: 2,
      instanceId: "5ee16f5e-40f9-4d78-a2c2-9f79045cb1c4",
      attachments: [],
      history: [{
        historyId: "8b82058e-dde1-44ab-8f19-f4c39f16cf38",
        attachment: value,
        usedAt: "2026-08-10T12:00:00.000Z"
      }]
    });
    assert.equal(state.history[0]?.attachment.text, value.text);
  });

  it("round-trips a VS Code attachment URI with its complete selection", async () => {
    const original = attachment();
    const request = await Effect.runPromise(decodeVsCodeOpenAttachmentUri(createVsCodeOpenAttachmentUri(original)));
    assert.equal(request.fileUri, original.fileUri);
    assert.deepEqual(request.range, original.range);
  });

  it("rejects attachment URIs for another VS Code extension", async () => {
    const result = await Effect.runPromise(Effect.either(
      decodeVsCodeOpenAttachmentUri("vscode://other.extension/open-attachment?fileUri=file%3A%2F%2F%2Ftmp%2Fa.ts")
    ));
    assert.equal(result._tag, "Left");
  });
});
