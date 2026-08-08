import type { AttachmentSnapshot, AttachmentState } from "@pi-context/protocol";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, SelectList, truncateToWidth, type SelectItem } from "@earendil-works/pi-tui";
import { compactAttachmentLabel } from "./prompt.js";

export interface AttachmentManagerActions {
  readonly remove: (attachmentId: string) => Promise<AttachmentState>;
  readonly open: (attachment: AttachmentSnapshot) => Promise<void>;
  readonly close: () => void;
  readonly requestRender: () => void;
}

export class AttachmentManagerComponent {
  private attachments: ReadonlyArray<AttachmentSnapshot>;
  private list: SelectList;
  private selectedId: string | undefined;
  private busy = false;
  private message: { readonly text: string; readonly error: boolean } | undefined;

  constructor(
    attachments: ReadonlyArray<AttachmentSnapshot>,
    private readonly theme: Theme,
    private readonly actions: AttachmentManagerActions
  ) {
    this.attachments = attachments;
    this.list = this.makeList(0);
  }

  private makeList(selectedIndex: number): SelectList {
    const items: SelectItem[] = this.attachments.map((attachment) => ({
      value: attachment.id,
      label: compactAttachmentLabel(attachment),
      description: `${attachment.languageId}${attachment.dirty ? " · unsaved snapshot" : ""}`
    }));
    const list = new SelectList(items, Math.min(Math.max(items.length, 1), 12), {
      selectedPrefix: (text) => this.theme.fg("accent", text),
      selectedText: (text) => this.theme.fg("accent", text),
      description: (text) => this.theme.fg("dim", text),
      scrollInfo: (text) => this.theme.fg("muted", text),
      noMatch: (text) => this.theme.fg("dim", text)
    }, { minPrimaryColumnWidth: 36, maxPrimaryColumnWidth: 72 });
    list.setSelectedIndex(selectedIndex);
    this.selectedId = list.getSelectedItem()?.value;
    list.onSelectionChange = (item) => {
      this.selectedId = item.value;
    };
    list.onSelect = (item) => {
      const attachment = this.attachments.find((candidate) => candidate.id === item.value);
      if (attachment) void this.open(attachment);
    };
    list.onCancel = this.actions.close;
    return list;
  }

  private async removeSelected(): Promise<void> {
    if (this.busy || !this.selectedId) return;
    this.busy = true;
    this.message = { text: "Removing attachment…", error: false };
    this.actions.requestRender();
    const previousIndex = Math.max(0, this.attachments.findIndex((item) => item.id === this.selectedId));
    try {
      const state = await this.actions.remove(this.selectedId);
      this.attachments = state.attachments;
      this.list = this.makeList(Math.min(previousIndex, Math.max(0, this.attachments.length - 1)));
      this.message = this.attachments.length === 0
        ? { text: "No pending attachments.", error: false }
        : undefined;
    } catch (cause) {
      this.message = {
        text: cause instanceof Error ? cause.message : "Could not remove the attachment.",
        error: true
      };
    } finally {
      this.busy = false;
      this.actions.requestRender();
    }
  }

  private async open(attachment: AttachmentSnapshot): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.message = { text: "Opening in VS Code…", error: false };
    this.actions.requestRender();
    try {
      await this.actions.open(attachment);
      this.message = { text: `Opened ${attachment.displayPath}.`, error: false };
    } catch (cause) {
      this.message = {
        text: cause instanceof Error ? cause.message : "Could not open the attachment in VS Code.",
        error: true
      };
    } finally {
      this.busy = false;
      this.actions.requestRender();
    }
  }

  handleInput(data: string): void {
    if (matchesKey(data, "d") || matchesKey(data, "shift+d") || data === "d" || data === "D") {
      void this.removeSelected();
      return;
    }
    this.list.handleInput(data);
  }

  render(width: number): string[] {
    const lines = [
      truncateToWidth(this.theme.fg("accent", " Pi Context attachments "), width),
      truncateToWidth(this.theme.fg("dim", " ↑/↓ select · Enter open in VS Code · D delete · Esc close"), width),
      ""
    ];
    if (this.attachments.length === 0) {
      lines.push(truncateToWidth(this.theme.fg("dim", "  No pending attachments."), width));
    } else {
      lines.push(...this.list.render(width));
    }
    if (this.message) {
      lines.push("", truncateToWidth(this.theme.fg(this.message.error ? "error" : "muted", `  ${this.message.text}`), width));
    }
    return [...lines, ""];
  }

  invalidate(): void {
    this.list.invalidate();
  }
}
