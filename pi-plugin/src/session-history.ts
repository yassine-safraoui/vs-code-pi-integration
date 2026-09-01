import { Schema } from "effect";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  AttachmentHistoryEntrySchema,
  MAX_HISTORY_BYTES,
  MAX_HISTORY_ENTRIES,
  utf8ByteLength,
  type AttachmentHistoryEntry
} from "@pi-context/protocol";

export const attachmentContextType = "pi-context.attachments";
export const attachmentHistorySeedType = "pi-context.history";

const HistoryDeltaSchema = Schema.Struct({
  historyEntries: Schema.Array(AttachmentHistoryEntrySchema)
});

const HistorySeedSchema = Schema.Struct({
  version: Schema.Literal(1),
  history: Schema.Array(AttachmentHistoryEntrySchema)
});

const decode = <A>(schema: Schema.Schema<A>, value: unknown): A | undefined => {
  try {
    return Schema.decodeUnknownSync(schema)(value);
  } catch {
    return undefined;
  }
};

const retain = (
  history: ReadonlyArray<AttachmentHistoryEntry>
): ReadonlyArray<AttachmentHistoryEntry> => {
  let bytes = 0;
  const seen = new Set<string>();
  const retained: AttachmentHistoryEntry[] = [];
  for (const entry of history) {
    if (seen.has(entry.historyId)) continue;
    const size = utf8ByteLength(entry.attachment.text);
    if (retained.length >= MAX_HISTORY_ENTRIES || bytes + size > MAX_HISTORY_BYTES) break;
    retained.push(entry);
    seen.add(entry.historyId);
    bytes += size;
  }
  return retained;
};

export const reconstructAttachmentHistory = (
  entries: ReadonlyArray<SessionEntry>
): ReadonlyArray<AttachmentHistoryEntry> => {
  let history: ReadonlyArray<AttachmentHistoryEntry> = [];
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === attachmentHistorySeedType) {
      const seed = decode(HistorySeedSchema, entry.data);
      if (seed) history = retain(seed.history);
      continue;
    }
    if (entry.type !== "custom_message" || entry.customType !== attachmentContextType) continue;
    const delta = decode(HistoryDeltaSchema, entry.details);
    if (!delta) continue;
    const changed = new Set(delta.historyEntries.map(({ historyId }) => historyId));
    history = retain([
      ...delta.historyEntries,
      ...history.filter(({ historyId }) => !changed.has(historyId))
    ]);
  }
  return history;
};

export const historySeed = (history: ReadonlyArray<AttachmentHistoryEntry>) => ({
  version: 1 as const,
  history: retain(history)
});
