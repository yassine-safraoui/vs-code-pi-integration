import * as vscode from "vscode";
import type { AttachmentState } from "@pi-context/protocol";
import { AttachmentIndicatorState } from "./attachment-indicator-state.js";

const hoverMessage = "This line is attached to the pending Pi context.";

export class AttachmentGutter implements vscode.Disposable {
  private readonly state = new AttachmentIndicatorState();
  private readonly decoration: vscode.TextEditorDecorationType;
  private readonly visibleEditorsChanged: vscode.Disposable;

  constructor(iconPath: vscode.Uri) {
    this.decoration = vscode.window.createTextEditorDecorationType({
      gutterIconPath: iconPath,
      gutterIconSize: "contain"
    });
    this.visibleEditorsChanged = vscode.window.onDidChangeVisibleTextEditors(() => this.render());
  }

  replaceStates(states: ReadonlyArray<AttachmentState>): void {
    this.state.replaceStates(states);
    this.render();
  }

  acceptState(state: AttachmentState): void {
    this.state.acceptState(state);
    this.render();
  }

  dispose(): void {
    this.visibleEditorsChanged.dispose();
    for (const editor of vscode.window.visibleTextEditors) editor.setDecorations(this.decoration, []);
    this.decoration.dispose();
  }

  private render(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      const decorations = this.state
        .linesFor(editor.document.uri.toString(true))
        .filter((line) => line < editor.document.lineCount)
        .map((line): vscode.DecorationOptions => ({
          range: new vscode.Range(line, 0, line, 0),
          hoverMessage
        }));
      editor.setDecorations(this.decoration, decorations);
    }
  }
}
