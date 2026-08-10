import { Effect, Ref } from "effect";
import { randomUUID } from "node:crypto";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  MAX_HISTORY_BYTES,
  MAX_HISTORY_ENTRIES,
  MAX_TOTAL_ATTACHMENT_BYTES,
  PROTOCOL_VERSION,
  ProtocolFailure,
  utf8ByteLength,
  validateAttachmentBatch,
  type AttachmentHistoryEntry,
  type AttachmentSnapshot,
  type AttachmentState,
  type Mutation
} from "@pi-context/protocol";

interface StoreData {
  readonly revision: number;
  readonly attachments: ReadonlyMap<string, PendingAttachment>;
  readonly history: ReadonlyArray<AttachmentHistoryEntry>;
}

interface PendingAttachment {
  readonly attachment: AttachmentSnapshot;
  readonly historyId?: string;
}

export interface AttachmentStore {
  readonly snapshot: Effect.Effect<AttachmentState>;
  readonly apply: (mutation: Mutation) => Effect.Effect<AttachmentState, ProtocolFailure>;
  readonly consumeForPrompt: (ids: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<AttachmentSnapshot>>;
}

export interface AttachmentStoreOptions {
  readonly now?: () => string;
  readonly makeId?: () => string;
}

const sameAttachment = (left: AttachmentSnapshot, right: AttachmentSnapshot): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

type Position = AttachmentSnapshot["range"]["start"];

const comparePositions = (left: Position, right: Position): number =>
  left.line === right.line ? left.column - right.column : left.line - right.line;

const rangesOverlap = (left: AttachmentSnapshot, right: AttachmentSnapshot): boolean =>
  left.fileUri === right.fileUri &&
  comparePositions(left.range.start, right.range.end) < 0 &&
  comparePositions(right.range.start, left.range.end) < 0;

const offsetAtPosition = (
  text: string,
  start: Position,
  target: Position
): number | undefined => {
  let line = start.line;
  let column = start.column;
  let offset = 0;
  while (offset < text.length) {
    if (line === target.line && column === target.column) return offset;
    if (text[offset] === "\r" && text[offset + 1] === "\n") {
      offset += 2;
      line += 1;
      column = 1;
    } else if (text[offset] === "\n" || text[offset] === "\r") {
      offset += 1;
      line += 1;
      column = 1;
    } else {
      offset += 1;
      column += 1;
    }
  }
  return line === target.line && column === target.column ? offset : undefined;
};

const textBetween = (
  attachment: AttachmentSnapshot,
  start: Position,
  end: Position
): string | undefined => {
  const startOffset = offsetAtPosition(attachment.text, attachment.range.start, start);
  const endOffset = offsetAtPosition(attachment.text, attachment.range.start, end);
  return startOffset === undefined || endOffset === undefined
    ? undefined
    : attachment.text.slice(startOffset, endOffset);
};

const mergeOverlappingAttachments = (
  survivor: AttachmentSnapshot,
  incoming: AttachmentSnapshot
): Effect.Effect<AttachmentSnapshot, ProtocolFailure> =>
  Effect.gen(function* () {
    if (survivor.documentVersion !== incoming.documentVersion) {
      return yield* new ProtocolFailure({
        code: "INVALID_ATTACHMENT",
        message: `Overlapping selections in ${survivor.displayPath} came from different document versions. Reattach their combined range.`
      });
    }
    if (survivor.languageId !== incoming.languageId) {
      return yield* new ProtocolFailure({
        code: "INVALID_ATTACHMENT",
        message: `Overlapping selections in ${survivor.displayPath} have incompatible language snapshots.`
      });
    }

    const overlapStart = comparePositions(survivor.range.start, incoming.range.start) >= 0
      ? survivor.range.start
      : incoming.range.start;
    const overlapEnd = comparePositions(survivor.range.end, incoming.range.end) <= 0
      ? survivor.range.end
      : incoming.range.end;
    const survivorOverlap = textBetween(survivor, overlapStart, overlapEnd);
    const incomingOverlap = textBetween(incoming, overlapStart, overlapEnd);
    if (survivorOverlap === undefined || incomingOverlap === undefined || survivorOverlap !== incomingOverlap) {
      return yield* new ProtocolFailure({
        code: "INVALID_ATTACHMENT",
        message: `Overlapping selections in ${survivor.displayPath} contain inconsistent text. Reattach their combined range.`
      });
    }

    if (
      comparePositions(survivor.range.start, incoming.range.start) <= 0 &&
      comparePositions(survivor.range.end, incoming.range.end) >= 0
    ) return survivor;

    if (
      comparePositions(incoming.range.start, survivor.range.start) <= 0 &&
      comparePositions(incoming.range.end, survivor.range.end) >= 0
    ) {
      return {
        ...incoming,
        id: survivor.id,
        capturedAt: survivor.capturedAt
      };
    }

    if (comparePositions(survivor.range.start, incoming.range.start) < 0) {
      const suffixOffset = offsetAtPosition(incoming.text, incoming.range.start, survivor.range.end);
      if (suffixOffset === undefined) {
        return yield* new ProtocolFailure({
          code: "INVALID_ATTACHMENT",
          message: `Could not merge overlapping selections in ${survivor.displayPath}.`
        });
      }
      return {
        ...survivor,
        range: { start: survivor.range.start, end: incoming.range.end },
        text: survivor.text + incoming.text.slice(suffixOffset)
      };
    }

    const suffixOffset = offsetAtPosition(survivor.text, survivor.range.start, incoming.range.end);
    if (suffixOffset === undefined) {
      return yield* new ProtocolFailure({
        code: "INVALID_ATTACHMENT",
        message: `Could not merge overlapping selections in ${survivor.displayPath}.`
      });
    }
    return {
      ...survivor,
      range: { start: incoming.range.start, end: survivor.range.end },
      text: incoming.text + survivor.text.slice(suffixOffset)
    };
  });

export const makeAttachmentStore = (
  instanceId: string,
  onChange: (state: AttachmentState) => void = () => undefined,
  options: AttachmentStoreOptions = {}
): Effect.Effect<AttachmentStore> =>
  Effect.gen(function* () {
    const now = options.now ?? (() => new Date().toISOString());
    const makeId = options.makeId ?? randomUUID;
    const state = yield* Ref.make<StoreData>({ revision: 0, attachments: new Map(), history: [] });
    const semaphore = yield* Effect.makeSemaphore(1);
    const toSnapshot = (data: StoreData): AttachmentState => ({
      protocolVersion: PROTOCOL_VERSION,
      revision: data.revision,
      instanceId,
      attachments: [...data.attachments.values()].map(({ attachment }) => attachment),
      history: data.history
    });
    const snapshot = Ref.get(state).pipe(Effect.map(toSnapshot));

    const validatePending = (
      attachments: ReadonlyMap<string, PendingAttachment>
    ): Effect.Effect<void, ProtocolFailure> => Effect.gen(function* () {
      const values = [...attachments.values()].map(({ attachment }) => attachment);
      if (values.length > MAX_ATTACHMENTS) {
        return yield* new ProtocolFailure({
          code: "PAYLOAD_TOO_LARGE",
          message: `At most ${MAX_ATTACHMENTS} attachments may be pending.`
        });
      }
      const oversized = values.find((item) => utf8ByteLength(item.text) > MAX_ATTACHMENT_BYTES);
      if (oversized) {
        return yield* new ProtocolFailure({
          code: "PAYLOAD_TOO_LARGE",
          message: `${oversized.displayPath} exceeds the ${MAX_ATTACHMENT_BYTES}-byte attachment limit after merging.`
        });
      }
      const total = values.reduce((sum, item) => sum + utf8ByteLength(item.text), 0);
      if (total > MAX_TOTAL_ATTACHMENT_BYTES) {
        return yield* new ProtocolFailure({
          code: "PAYLOAD_TOO_LARGE",
          message: `Pending attachments exceed ${MAX_TOTAL_ATTACHMENT_BYTES} bytes.`
        });
      }
    });

    const addAttachments = (
      current: ReadonlyMap<string, PendingAttachment>,
      incomingAttachments: ReadonlyArray<PendingAttachment>
    ): Effect.Effect<{ readonly attachments: ReadonlyMap<string, PendingAttachment>; readonly changed: boolean }, ProtocolFailure> =>
      Effect.gen(function* () {
        const nextAttachments = new Map(current);
        let changed = false;

        yield* validateAttachmentBatch(incomingAttachments.map(({ attachment }) => attachment));
        for (const incomingRecord of incomingAttachments) {
          const attachment = incomingRecord.attachment;
          const existingWithId = nextAttachments.get(attachment.id);
          if (existingWithId && !sameAttachment(existingWithId.attachment, attachment)) {
            return yield* new ProtocolFailure({
              code: "INVALID_ATTACHMENT",
              message: `Attachment ${attachment.id} was reused with different content.`
            });
          }
          if (existingWithId) continue;

          const overlapping = [...nextAttachments.values()].filter((candidate) =>
            rangesOverlap(candidate.attachment, attachment)
          );
          if (overlapping.length === 0) {
            nextAttachments.set(attachment.id, incomingRecord);
            changed = true;
            continue;
          }

          const survivor = overlapping[0]!;
          let merged = yield* mergeOverlappingAttachments(survivor.attachment, attachment);
          for (const candidate of overlapping.slice(1)) {
            merged = yield* mergeOverlappingAttachments(merged, candidate.attachment);
            nextAttachments.delete(candidate.attachment.id);
          }
          const sharedHistoryId = incomingRecord.historyId !== undefined &&
            overlapping.every((candidate) => candidate.historyId === incomingRecord.historyId)
            ? incomingRecord.historyId
            : undefined;
          const nextRecord: PendingAttachment = sharedHistoryId
            ? { attachment: merged, historyId: sharedHistoryId }
            : { attachment: merged };
          const attachmentChanged = !sameAttachment(survivor.attachment, merged);
          const lineageChanged = survivor.historyId !== sharedHistoryId;
          if (attachmentChanged || lineageChanged) {
            nextAttachments.set(survivor.attachment.id, nextRecord);
          }
          changed = changed || overlapping.length > 1 || attachmentChanged || lineageChanged;
        }
        yield* validatePending(nextAttachments);
        return { attachments: nextAttachments, changed };
      });

    const apply = (mutation: Mutation): Effect.Effect<AttachmentState, ProtocolFailure> =>
      semaphore.withPermits(1)(Effect.gen(function* () {
        const current = yield* Ref.get(state);
        let nextAttachments = new Map(current.attachments);
        let changed = false;

        if (mutation.type === "attachSelections") {
          const result = yield* addAttachments(
            current.attachments,
            mutation.attachments.map((attachment) => ({ attachment }))
          );
          nextAttachments = new Map(result.attachments);
          changed = result.changed;
        } else if (mutation.type === "reattachHistory") {
          const entry = current.history.find(({ historyId }) => historyId === mutation.historyId);
          if (!entry) {
            return yield* new ProtocolFailure({
              code: "INVALID_ATTACHMENT",
              message: "The previously used attachment is no longer available. Refresh the attachment view."
            });
          }
          const replay: AttachmentSnapshot = {
            ...entry.attachment,
            id: makeId(),
            capturedAt: now()
          };
          const result = yield* addAttachments(current.attachments, [{
            attachment: replay,
            historyId: entry.historyId
          }]);
          nextAttachments = new Map(result.attachments);
          changed = result.changed;
        } else if (mutation.type === "removeAttachment") {
          changed = nextAttachments.delete(mutation.attachmentId);
        } else if (nextAttachments.size > 0) {
          nextAttachments.clear();
          changed = true;
        }

        const next: StoreData = changed
          ? { ...current, revision: current.revision + 1, attachments: nextAttachments }
          : current;
        if (changed) yield* Ref.set(state, next);
        const result = toSnapshot(next);
        if (changed) onChange(result);
        return result;
      }));

    const consumeForPrompt = (
      ids: ReadonlyArray<string>
    ): Effect.Effect<ReadonlyArray<AttachmentSnapshot>> =>
      semaphore.withPermits(1)(Effect.gen(function* () {
        const current = yield* Ref.get(state);
        const attachments = new Map(current.attachments);
        const consumed = ids.flatMap((id) => {
          const item = attachments.get(id);
          return item ? [item] : [];
        });
        if (consumed.length === 0) return [];
        for (const item of consumed) attachments.delete(item.attachment.id);

        const usedAt = now();
        const updatedHistoryIds = new Set(consumed.flatMap(({ historyId }) => historyId ? [historyId] : []));
        const newEntries = consumed.map(({ attachment, historyId }): AttachmentHistoryEntry => ({
          historyId: historyId ?? makeId(),
          attachment,
          usedAt
        }));
        const history = [
          ...newEntries,
          ...current.history.filter(({ historyId }) => !updatedHistoryIds.has(historyId))
        ];
        let retainedBytes = 0;
        const retainedHistory: AttachmentHistoryEntry[] = [];
        for (const entry of history) {
          const size = utf8ByteLength(entry.attachment.text);
          if (retainedHistory.length >= MAX_HISTORY_ENTRIES || retainedBytes + size > MAX_HISTORY_BYTES) break;
          retainedHistory.push(entry);
          retainedBytes += size;
        }

        const next: StoreData = {
          revision: current.revision + 1,
          attachments,
          history: retainedHistory
        };
        yield* Ref.set(state, next);
        onChange(toSnapshot(next));
        return consumed.map(({ attachment }) => attachment);
      }));

    return { snapshot, apply, consumeForPrompt };
  });
