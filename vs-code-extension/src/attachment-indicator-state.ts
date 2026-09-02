import type { AttachmentSnapshot, AttachmentState } from "@pi-context/protocol";

const lastCoveredLine = (attachment: AttachmentSnapshot): number => {
  const { start, end } = attachment.range;
  return end.line > start.line && end.column === 1 ? end.line - 1 : end.line;
};

export const coveredEditorLines = (attachment: AttachmentSnapshot): ReadonlyArray<number> => {
  const firstLine = attachment.range.start.line;
  const lastLine = lastCoveredLine(attachment);
  return Array.from({ length: lastLine - firstLine + 1 }, (_, index) => firstLine + index - 1);
};

export class AttachmentIndicatorState {
  private states = new Map<string, AttachmentState>();

  replaceStates(states: ReadonlyArray<AttachmentState>): void {
    const next = new Map<string, AttachmentState>();
    for (const state of states) {
      const current = this.states.get(state.instanceId);
      next.set(state.instanceId, current && current.revision > state.revision ? current : state);
    }
    this.states = next;
  }

  acceptState(state: AttachmentState): void {
    const current = this.states.get(state.instanceId);
    if (current && current.revision > state.revision) return;
    this.states.set(state.instanceId, state);
  }

  linesFor(fileUri: string): ReadonlyArray<number> {
    const lines = new Set<number>();
    for (const state of this.states.values()) {
      for (const attachment of state.attachments) {
        if (attachment.fileUri !== fileUri) continue;
        for (const line of coveredEditorLines(attachment)) lines.add(line);
      }
    }
    return [...lines].sort((left, right) => left - right);
  }
}
