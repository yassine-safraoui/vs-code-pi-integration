import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import type { AttachmentSnapshot } from "@pi-context/protocol";
import { decode } from "@toon-format/toon";
import { attachmentWidgetLines, renderAttachmentContext } from "../src/prompt.js";

const attachment = (relationship: "inside" | "outside"): AttachmentSnapshot => ({
  id: randomUUID(),
  fileUri: "file:///repo/src/value.ts",
  displayPath: relationship === "inside" ? "src/value.ts" : "/other/value.ts",
  relationship,
  range: { start: { line: 7, column: 3 }, end: { line: 11, column: 8 } },
  text: "selected",
  languageId: "typescript",
  documentVersion: 1,
  dirty: false,
  capturedAt: new Date().toISOString()
});

describe("attachment widget", () => {
  it("shows every attachment with relationship and complete coordinates", () => {
    const lines = attachmentWidgetLines([attachment("inside"), attachment("outside")]);
    assert.equal(lines[0], "Pi Context · 2 pending attachments");
    assert.match(lines[1]!, /\[inside\] src\/value\.ts:7:3-11:8/);
    assert.match(lines[2]!, /\[outside\] \/other\/value\.ts:7:3-11:8/);
  });
});

describe("attachment context", () => {
  it("encodes complete attachment snapshots as lossless TOON", () => {
    const inside = {
      ...attachment("inside"),
      text: "const value = { json: true };\n```ts\nconsole.log(value);\n```"
    };
    const outside = {
      ...attachment("outside"),
      text: "line one\nline two"
    };
    const rendered = renderAttachmentContext([inside, outside]);
    const toon = /```toon\n([\s\S]+)\n```/.exec(rendered)?.[1];

    assert.ok(toon);
    assert.deepEqual(decode(toon), {
      attachments: [inside, outside].map((item) => ({
        id: item.id,
        fileUri: item.fileUri,
        path: item.displayPath,
        relationship: item.relationship,
        range: item.range,
        languageId: item.languageId,
        documentVersion: item.documentVersion,
        dirty: item.dirty,
        capturedAt: item.capturedAt,
        text: item.text
      }))
    });
    assert.doesNotMatch(rendered, /PI_CONTEXT_ATTACHMENT_BEGIN \{/);
  });
});
