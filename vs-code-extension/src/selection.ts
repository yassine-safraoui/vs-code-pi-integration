import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import * as vscode from "vscode";
import {
  ProtocolFailure,
  canonicalizePath,
  classifyPath,
  type AttachmentSnapshot
} from "@pi-context/protocol";

export interface CapturedSelection {
  readonly id: string;
  readonly fileUri: string;
  readonly canonicalFilePath: string;
  readonly range: AttachmentSnapshot["range"];
  readonly text: string;
  readonly languageId: string;
  readonly documentVersion: number;
  readonly dirty: boolean;
  readonly capturedAt: string;
}

export const captureSelections = (): Effect.Effect<ReadonlyArray<CapturedSelection>, ProtocolFailure> =>
  Effect.gen(function* () {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return yield* new ProtocolFailure({ code: "INVALID_ATTACHMENT", message: "Open a file and select text before attaching it." });
    }
    const { document } = editor;
    if (document.uri.scheme !== "file") {
      return yield* new ProtocolFailure({ code: "INVALID_ATTACHMENT", message: "Pi Context currently supports local file editors only." });
    }
    const selections = editor.selections.filter((selection) => !selection.isEmpty);
    if (selections.length === 0) {
      return yield* new ProtocolFailure({ code: "INVALID_ATTACHMENT", message: "Select text before attaching it to Pi." });
    }
    const canonicalFilePath = yield* canonicalizePath(document.uri.fsPath);
    const capturedAt = new Date().toISOString();
    return selections.map((selection) => ({
      id: randomUUID(),
      fileUri: document.uri.toString(true),
      canonicalFilePath,
      range: {
        start: { line: selection.start.line + 1, column: selection.start.character + 1 },
        end: { line: selection.end.line + 1, column: selection.end.character + 1 }
      },
      text: document.getText(selection),
      languageId: document.languageId,
      documentVersion: document.version,
      dirty: document.isDirty,
      capturedAt
    }));
  });

export const snapshotsForTarget = (
  selections: ReadonlyArray<CapturedSelection>,
  canonicalWorkingDirectory: string
): ReadonlyArray<AttachmentSnapshot> => selections.map((selection) => {
  const classification = classifyPath(selection.canonicalFilePath, canonicalWorkingDirectory);
  return {
    id: selection.id,
    fileUri: selection.fileUri,
    displayPath: classification.displayPath,
    relationship: classification.relationship,
    range: selection.range,
    text: selection.text,
    languageId: selection.languageId,
    documentVersion: selection.documentVersion,
    dirty: selection.dirty,
    capturedAt: selection.capturedAt
  };
});
