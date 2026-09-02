import { basename } from "node:path";
import * as vscode from "vscode";
import type {
  AttachmentHistoryEntry,
  AttachmentSnapshot,
  AttachmentState,
  DiscoveryRecord,
  InactiveConversationSummary
} from "@pi-context/protocol";

interface PiNode {
  readonly type: "pi";
  readonly record: DiscoveryRecord;
  readonly state: AttachmentState;
}

interface SectionNode {
  readonly type: "section";
  readonly kind: "pending" | "history";
  readonly record: DiscoveryRecord;
  readonly state: AttachmentState;
}

interface OtherSessionsSectionNode {
  readonly type: "otherSessionsSection";
  readonly state: AttachmentState;
}

interface InactiveConversationNode {
  readonly type: "inactiveConversation";
  readonly conversation: InactiveConversationSummary;
}

interface PendingAttachmentNode {
  readonly type: "pendingAttachment";
  readonly record: DiscoveryRecord;
  readonly attachment: AttachmentSnapshot;
}

export interface HistoryAttachmentNode {
  readonly type: "historyAttachment";
  readonly record: DiscoveryRecord;
  readonly entry: AttachmentHistoryEntry;
}

export type AttachmentTreeNode =
  | PiNode
  | SectionNode
  | OtherSessionsSectionNode
  | InactiveConversationNode
  | PendingAttachmentNode
  | HistoryAttachmentNode;

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
      const pendingCount = node.state.attachments.length;
      const historyCount = node.state.history.length;
      const item = new vscode.TreeItem(
        basename(node.record.canonicalWorkingDirectory) || node.record.canonicalWorkingDirectory,
        vscode.TreeItemCollapsibleState.Expanded
      );
      item.description = `Active: ${node.state.activeConversation.title} · ${pendingCount} pending · ${historyCount} used`;
      item.tooltip = `${node.record.canonicalWorkingDirectory}\nActive conversation: ${node.state.activeConversation.title}`;
      item.iconPath = new vscode.ThemeIcon("terminal");
      item.contextValue = "piContext.pi";
      return item;
    }

    if (node.type === "otherSessionsSection") {
      const item = new vscode.TreeItem("Other Sessions", vscode.TreeItemCollapsibleState.Collapsed);
      item.description = String(node.state.inactiveConversations.length);
      item.iconPath = new vscode.ThemeIcon("comment-discussion");
      item.contextValue = "piContext.otherSessionsSection";
      return item;
    }

    if (node.type === "inactiveConversation") {
      const item = new vscode.TreeItem(node.conversation.title, vscode.TreeItemCollapsibleState.None);
      item.description = `${node.conversation.pendingCount} pending`;
      item.tooltip = `${node.conversation.title} has ${node.conversation.pendingCount} pending attachment${node.conversation.pendingCount === 1 ? "" : "s"}. Switch to that conversation in Pi to manage them.`;
      item.iconPath = new vscode.ThemeIcon("comment");
      return item;
    }

    if (node.type === "section") {
      const count = node.kind === "pending" ? node.state.attachments.length : node.state.history.length;
      const item = new vscode.TreeItem(
        node.kind === "pending" ? "Pending" : "Previously Used",
        count > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None
      );
      item.description = String(count);
      item.iconPath = new vscode.ThemeIcon(node.kind === "pending" ? "inbox" : "history");
      item.contextValue = `piContext.${node.kind}Section`;
      return item;
    }

    const attachment = node.type === "historyAttachment" ? node.entry.attachment : node.attachment;
    const item = new vscode.TreeItem(attachment.displayPath, vscode.TreeItemCollapsibleState.None);
    item.description = node.type === "historyAttachment"
      ? `${rangeLabel(attachment)} · ${new Date(node.entry.usedAt).toLocaleString()}`
      : rangeLabel(attachment);
    item.tooltip = node.type === "historyAttachment"
      ? `${attachment.displayPath} · ${rangeLabel(attachment)} · used ${new Date(node.entry.usedAt).toLocaleString()}`
      : `${attachment.displayPath} · ${rangeLabel(attachment)}`;
    item.iconPath = new vscode.ThemeIcon("symbol-text");
    item.contextValue = node.type === "historyAttachment"
      ? "piContext.historyAttachment"
      : "piContext.pendingAttachment";
    item.command = {
      command: "piContext.openAttachment",
      title: "Open Attachment",
      arguments: [attachment]
    };
    return item;
  }

  getChildren(node?: AttachmentTreeNode): AttachmentTreeNode[] {
    if (!node) return [...this.roots];
    if (
      node.type === "pendingAttachment" ||
      node.type === "historyAttachment" ||
      node.type === "inactiveConversation"
    ) return [];
    if (node.type === "pi") {
      const children: AttachmentTreeNode[] = [
        { type: "section", kind: "pending", record: node.record, state: node.state },
        { type: "section", kind: "history", record: node.record, state: node.state }
      ];
      if (node.state.inactiveConversations.length > 0) {
        children.push({ type: "otherSessionsSection", state: node.state });
      }
      return children;
    }
    if (node.type === "otherSessionsSection") {
      return node.state.inactiveConversations.map((conversation): InactiveConversationNode => ({
        type: "inactiveConversation",
        conversation
      }));
    }
    if (node.kind === "pending") {
      return node.state.attachments.map((attachment): PendingAttachmentNode => ({
        type: "pendingAttachment",
        record: node.record,
        attachment
      }));
    }
    return node.state.history.map((entry): HistoryAttachmentNode => ({
      type: "historyAttachment",
      record: node.record,
      entry
    }));
  }
}
