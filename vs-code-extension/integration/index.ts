import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import { createVsCodeOpenAttachmentUri } from "@pi-context/protocol";
import { handleExtensionUri } from "../src/extension.js";

export async function run(): Promise<void> {
  const extension = vscode.extensions.all.find((candidate) => candidate.packageJSON.name === "pi-context-vscode");
  assert.ok(extension, "Pi Context development extension was not discovered");
  await extension.activate();
  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes("piContext.attachSelections"));
  assert.ok(commands.includes("piContext.chooseTarget"));
  assert.ok(commands.includes("piContext.clearAttachments"));
  assert.ok(commands.includes("piContext.refreshAttachments"));
  assert.ok(commands.includes("piContext.openAttachment"));

  const testFile = vscode.Uri.file(join(tmpdir(), `pi context open ${randomUUID()}.ts`));
  await vscode.workspace.fs.writeFile(testFile, new TextEncoder().encode("first\nselected text\nlast\n"));
  try {
    const openUri = createVsCodeOpenAttachmentUri({
      fileUri: testFile.toString(true),
      range: {
        start: { line: 2, column: 1 },
        end: { line: 2, column: 9 }
      }
    });
    await handleExtensionUri(vscode.Uri.parse(openUri));
    const editor = vscode.window.activeTextEditor;
    assert.equal(editor?.document.uri.fsPath, testFile.fsPath);
    assert.deepEqual(
      [editor?.selection.start.line, editor?.selection.start.character, editor?.selection.end.line, editor?.selection.end.character],
      [1, 0, 1, 8]
    );

    await vscode.commands.executeCommand("piContext.openAttachment", {
      fileUri: testFile.toString(true),
      range: {
        start: { line: 1, column: 1 },
        end: { line: 1, column: 6 }
      }
    });
    const commandEditor = vscode.window.activeTextEditor;
    assert.deepEqual(
      [
        commandEditor?.selection.start.line,
        commandEditor?.selection.start.character,
        commandEditor?.selection.end.line,
        commandEditor?.selection.end.character
      ],
      [0, 0, 0, 5]
    );
  } finally {
    await vscode.workspace.fs.delete(testFile);
  }
}
