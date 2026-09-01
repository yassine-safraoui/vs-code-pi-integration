import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { PROTOCOL_VERSION, type AttachmentSnapshot, type AttachmentState } from "@pi-context/protocol";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { AttachmentManagerComponent } from "../src/attachment-manager.js";

const attachment = (): AttachmentSnapshot => ({
  id: randomUUID(),
  fileUri: "file:///repo/src/value.ts",
  displayPath: "src/value.ts",
  relationship: "inside",
  range: { start: { line: 3, column: 2 }, end: { line: 4, column: 6 } },
  text: "selected",
  languageId: "typescript",
  documentVersion: 1,
  dirty: false,
  capturedAt: new Date().toISOString()
});

const theme = {
  fg: (_color: string, text: string) => text
} as Theme;

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("AttachmentManagerComponent", () => {
  it("deletes the highlighted attachment when D is pressed", async () => {
    const selected = attachment();
    let removedId: string | undefined;
    const component = new AttachmentManagerComponent([selected], theme, {
      remove: async (attachmentId): Promise<AttachmentState> => {
        removedId = attachmentId;
        return { protocolVersion: PROTOCOL_VERSION, revision: 2, instanceId: randomUUID(), attachments: [], history: [] };
      },
      open: async () => undefined,
      close: () => undefined,
      requestRender: () => undefined
    });
    component.handleInput("D");
    await flush();
    assert.equal(removedId, selected.id);
    assert.match(component.render(100).join("\n"), /No pending attachments/);
  });

  it("opens the highlighted attachment when Enter is pressed", async () => {
    const selected = attachment();
    let openedId: string | undefined;
    const component = new AttachmentManagerComponent([selected], theme, {
      remove: async () => { throw new Error("not expected"); },
      open: async (item) => { openedId = item.id; },
      close: () => undefined,
      requestRender: () => undefined
    });
    component.handleInput("\r");
    await flush();
    assert.equal(openedId, selected.id);
  });
});
