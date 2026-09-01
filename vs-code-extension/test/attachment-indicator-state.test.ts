import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PROTOCOL_VERSION, type AttachmentSnapshot, type AttachmentState } from "@pi-context/protocol";
import { AttachmentIndicatorState, coveredEditorLines } from "../src/attachment-indicator-state.js";

const fileUri = "file:///repo/src/example.ts";

const attachment = (
  startLine: number,
  endLine: number,
  endColumn = 5,
  uri = fileUri
): AttachmentSnapshot => ({
  id: randomUUID(),
  fileUri: uri,
  displayPath: "src/example.ts",
  relationship: "inside",
  range: {
    start: { line: startLine, column: 2 },
    end: { line: endLine, column: endColumn }
  },
  text: "selected",
  languageId: "typescript",
  documentVersion: 1,
  dirty: false,
  capturedAt: "2026-09-01T00:00:00.000Z"
});

const state = (
  instanceId: string,
  revision: number,
  attachments: ReadonlyArray<AttachmentSnapshot>
): AttachmentState => ({
  protocolVersion: PROTOCOL_VERSION,
  instanceId,
  revision,
  attachments
});

test("coveredEditorLines returns every zero-based line containing selected text", () => {
  assert.deepEqual(coveredEditorLines(attachment(3, 5)), [2, 3, 4]);
  assert.deepEqual(coveredEditorLines(attachment(3, 5, 1)), [2, 3]);
  assert.deepEqual(coveredEditorLines(attachment(3, 3)), [2]);
});

test("authoritative state updates add, merge, and remove gutter lines", () => {
  const instanceId = randomUUID();
  const indicators = new AttachmentIndicatorState();

  indicators.acceptState(state(instanceId, 1, [attachment(2, 3), attachment(7, 8)]));
  assert.deepEqual(indicators.linesFor(fileUri), [1, 2, 6, 7]);

  indicators.acceptState(state(instanceId, 2, [attachment(2, 8)]));
  assert.deepEqual(indicators.linesFor(fileUri), [1, 2, 3, 4, 5, 6, 7]);

  indicators.acceptState(state(instanceId, 3, []));
  assert.deepEqual(indicators.linesFor(fileUri), []);
});

test("lines from multiple Pi instances are combined and deduplicated per file", () => {
  const indicators = new AttachmentIndicatorState();
  indicators.replaceStates([
    state(randomUUID(), 1, [attachment(2, 4)]),
    state(randomUUID(), 1, [attachment(4, 6), attachment(1, 2, 5, "file:///repo/other.ts")])
  ]);

  assert.deepEqual(indicators.linesFor(fileUri), [1, 2, 3, 4, 5]);
  assert.deepEqual(indicators.linesFor("file:///repo/other.ts"), [0, 1]);
});

test("replacement removes vanished instances and stale responses cannot roll state back", () => {
  const firstId = randomUUID();
  const secondId = randomUUID();
  const indicators = new AttachmentIndicatorState();
  indicators.replaceStates([
    state(firstId, 4, [attachment(4, 4)]),
    state(secondId, 1, [attachment(8, 8)])
  ]);

  indicators.acceptState(state(firstId, 3, [attachment(1, 1)]));
  assert.deepEqual(indicators.linesFor(fileUri), [3, 7]);

  indicators.replaceStates([state(firstId, 3, [attachment(1, 1)])]);
  assert.deepEqual(indicators.linesFor(fileUri), [3]);
});
