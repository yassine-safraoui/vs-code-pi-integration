import { basename } from "node:path";
import * as vscode from "vscode";
import type { AttachmentSnapshot, AttachmentState, DiscoveryRecord } from "@pi-context/protocol";

interface PiNode {
  readonly type: "pi";
  readonly record: DiscoveryRecord;
  readonly state: AttachmentState;
}

interface AttachmentNode {
  readonly type: "attachment";
  readonly attachment: AttachmentSnapshot;
}

export type AttachmentTreeNode = PiNode | AttachmentNode;

export interface PiAttachmentState {
  readonly record: DiscoveryRecord;
  readonly state: AttachmentState;
}

const rangeLabel = (attachment: AttachmentSnapshot): string => {
  const { start, end } = attachment.range;
  return start.line === end.line ? `line ${start.line}` : `lines ${start.line}–${end.line}`;
};

export class AttachmentTreeProvider implements vscode.TreeDataProvider<AttachmentTreeNode> {
  private readonly changed = new vscode.EventEmitter<AttachmentTreeNode | undefined>();
  private roots: ReadonlyArray<PiNode> = [];

  readonly onDidChangeTreeData = this.changed.event;

  dispose(): void {
    this.changed.dispose();
  }

  replaceStates(states: ReadonlyArray<PiAttachmentState>): void {
    const roots = states.map(({ record, state }): PiNode => ({
      type: "pi",
      record,
      state: (() => {
        const current = this.roots.find((root) => root.record.instanceId === record.instanceId);
        return current && current.state.revision > state.revision ? current.state : state;
      })()
    }));
    this.roots = roots.sort((left, right) =>
      left.record.canonicalWorkingDirectory.localeCompare(right.record.canonicalWorkingDirectory)
    );
    this.changed.fire(undefined);
  }

  acceptState(record: DiscoveryRecord, state: AttachmentState): void {
    const current = this.roots.find((root) => root.record.instanceId === record.instanceId);
    if (current && current.state.revision > state.revision) return;
    const next: PiNode = { type: "pi", record, state };
    const existing = this.roots.findIndex((root) => root.record.instanceId === record.instanceId);
    const roots = existing < 0
      ? [...this.roots, next]
      : this.roots.map((root, index) => index === existing ? next : root);
    this.roots = roots.sort((left, right) =>
      left.record.canonicalWorkingDirectory.localeCompare(right.record.canonicalWorkingDirectory)
    );
    this.changed.fire(undefined);
  }

  getTreeItem(node: AttachmentTreeNode): vscode.TreeItem {
    if (node.type === "pi") {
      const count = node.state.attachments.length;
      const item = new vscode.TreeItem(
        basename(node.record.canonicalWorkingDirectory) || node.record.canonicalWorkingDirectory,
        vscode.TreeItemCollapsibleState.Expanded
      );
      item.description = `${count} pending`;
      item.tooltip = node.record.canonicalWorkingDirectory;
      item.iconPath = new vscode.ThemeIcon("terminal");
      item.contextValue = "piContext.pi";
      return item;
    }

    const item = new vscode.TreeItem(node.attachment.displayPath, vscode.TreeItemCollapsibleState.None);
    item.description = rangeLabel(node.attachment);
    item.tooltip = `${node.attachment.displayPath} · ${rangeLabel(node.attachment)}`;
    item.iconPath = new vscode.ThemeIcon("symbol-text");
    item.contextValue = "piContext.attachment";
    item.command = {
      command: "piContext.openAttachment",
      title: "Open Attachment",
      arguments: [node.attachment]
    };
    return item;
  }

  getChildren(node?: AttachmentTreeNode): AttachmentTreeNode[] {
    if (!node) return [...this.roots];
    if (node.type === "attachment") return [];
    return node.state.attachments.map((attachment): AttachmentNode => ({ type: "attachment", attachment }));
  }
}
