import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import { PROTOCOL_VERSION, createVsCodeOpenAttachmentUri, type AttachmentState, type DiscoveryRecord } from "@pi-context/protocol";
import { handleExtensionUri } from "../src/extension.js";
import { AttachmentTreeProvider } from "../src/attachments-tree.js";

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
  assert.ok(commands.includes("piContext.reattachHistory"));

  const instanceId = randomUUID();
  const record: DiscoveryRecord = {
    protocolVersion: PROTOCOL_VERSION,
    instanceId,
    canonicalWorkingDirectory: "/workspace/project",
    pid: 123,
    startedAt: "2026-08-10T12:00:00.000Z",
    lastActiveAt: new Date().toISOString(),
    host: "127.0.0.1",
    port: 43210,
    token: "test-token"
  };
  const historyAttachment = {
    id: randomUUID(),
    fileUri: "file:///workspace/project/src/history.ts",
    displayPath: "src/history.ts",
    relationship: "inside" as const,
    range: { start: { line: 1, column: 1 }, end: { line: 1, column: 8 } },
    text: "history",
    languageId: "typescript",
    documentVersion: 1,
    dirty: false,
    capturedAt: "2026-08-10T11:00:00.000Z"
  };
  const state: AttachmentState = {
    protocolVersion: PROTOCOL_VERSION,
    revision: 2,
    instanceId,
    activeConversation: { kind: "session", sessionId: "session-active", title: "Active work" },
    inactiveConversations: [{
      kind: "session",
      sessionId: "session-inactive",
      title: "Dormant work",
      pendingCount: 3
    }],
    attachments: [],
    history: [{
      historyId: randomUUID(),
      attachment: historyAttachment,
      usedAt: "2026-08-10T12:00:00.000Z"
    }]
  };
  const provider = new AttachmentTreeProvider();
  provider.replaceStates([{ record, state }]);
  const root = provider.getChildren()[0]!;
  const sections = provider.getChildren(root);
  assert.deepEqual(
    sections.map((section) => section.type === "section" ? section.kind : section.type),
    ["pending", "history", "otherSessionsSection"]
  );
  assert.match(String(provider.getTreeItem(root).description), /Active: Active work/);
  const historyNode = provider.getChildren(sections[1]!)[0]!;
  assert.equal(historyNode.type, "historyAttachment");
  assert.equal(provider.getTreeItem(historyNode).contextValue, "piContext.historyAttachment");
  const otherSession = provider.getChildren(sections[2]!)[0]!;
  assert.equal(otherSession.type, "inactiveConversation");
  assert.equal(provider.getTreeItem(otherSession).description, "3 pending");
  assert.equal(provider.getTreeItem(otherSession).command, undefined);
  provider.dispose();

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
