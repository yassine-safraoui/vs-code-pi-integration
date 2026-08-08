import * as vscode from "vscode";
import { Effect } from "effect";

type SelectionSnapshot = Readonly<{
  path: string;
  start: { line: number; column: number };
  end: { line: number; column: number };
  text: string;
  languageId: string;
}>;

const captureActiveSelection = (): Effect.Effect<SelectionSnapshot, Error> =>
  Effect.try({
    try: () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        throw new Error("Select text in an editor before attaching it to Pi.");
      }

      const { document, selection } = editor;
      return {
        path: vscode.workspace.asRelativePath(document.uri, false),
        start: { line: selection.start.line + 1, column: selection.start.character + 1 },
        end: { line: selection.end.line + 1, column: selection.end.character + 1 },
        text: document.getText(selection),
        languageId: document.languageId
      };
    },
    catch: (cause) => cause instanceof Error ? cause : new Error("Could not capture the editor selection.")
  });

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("piContext.attachSelection", async () => {
      const result = Effect.runSync(Effect.either(captureActiveSelection()));
      if (result._tag === "Left") {
        await vscode.window.showWarningMessage(result.left.message);
        return;
      }

      // Architecture 1 transport is intentionally not implemented in this scaffold.
      // The Pi plugin will be the authority that receives and stores this snapshot.
      const selection = result.right;
      await vscode.window.showInformationMessage(
        `Captured ${selection.path}:${selection.start.line}-${selection.end.line}. Pi connection comes next.`
      );
    })
  );
}

export function deactivate(): void {
  // Future IPC client shutdown belongs here.
}
