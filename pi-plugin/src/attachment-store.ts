import { Effect, Ref } from "effect";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  MAX_TOTAL_ATTACHMENT_BYTES,
  PROTOCOL_VERSION,
  ProtocolFailure,
  utf8ByteLength,
  validateAttachmentBatch,
  type AttachmentSnapshot,
  type AttachmentState,
  type Mutation
} from "@pi-context/protocol";

interface StoreData {
  readonly revision: number;
  readonly attachments: ReadonlyMap<string, AttachmentSnapshot>;
}

export interface AttachmentStore {
  readonly snapshot: Effect.Effect<AttachmentState>;
  readonly apply: (mutation: Mutation) => Effect.Effect<AttachmentState, ProtocolFailure>;
  readonly consume: (ids: ReadonlyArray<string>) => Effect.Effect<AttachmentState>;
  readonly select: (ids: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<AttachmentSnapshot>>;
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
  onChange: (state: AttachmentState) => void = () => undefined
): Effect.Effect<AttachmentStore> =>
  Effect.gen(function* () {
    const state = yield* Ref.make<StoreData>({ revision: 0, attachments: new Map() });
    const semaphore = yield* Effect.makeSemaphore(1);
    const toSnapshot = (data: StoreData): AttachmentState => ({
      protocolVersion: PROTOCOL_VERSION,
      revision: data.revision,
      instanceId,
      attachments: [...data.attachments.values()]
    });
    const snapshot = Ref.get(state).pipe(Effect.map(toSnapshot));

    const apply = (mutation: Mutation): Effect.Effect<AttachmentState, ProtocolFailure> =>
      semaphore.withPermits(1)(Effect.gen(function* () {
        const current = yield* Ref.get(state);
        const nextAttachments = new Map(current.attachments);
        let changed = false;

        if (mutation.type === "attachSelections") {
          yield* validateAttachmentBatch(mutation.attachments);
          for (const attachment of mutation.attachments) {
            const existingWithId = nextAttachments.get(attachment.id);
            if (existingWithId && !sameAttachment(existingWithId, attachment)) {
              return yield* new ProtocolFailure({
                code: "INVALID_ATTACHMENT",
                message: `Attachment ${attachment.id} was reused with different content.`
              });
            }
            if (existingWithId) continue;

            const overlapping = [...nextAttachments.values()].filter((candidate) =>
              rangesOverlap(candidate, attachment)
            );
            if (overlapping.length === 0) {
              nextAttachments.set(attachment.id, attachment);
              changed = true;
              continue;
            }

            const survivor = overlapping[0]!;
            let merged = yield* mergeOverlappingAttachments(survivor, attachment);
            for (const candidate of overlapping.slice(1)) {
              merged = yield* mergeOverlappingAttachments(merged, candidate);
              nextAttachments.delete(candidate.id);
            }
            if (!sameAttachment(survivor, merged)) {
              nextAttachments.set(survivor.id, merged);
            }
            changed = changed || overlapping.length > 1 || !sameAttachment(survivor, merged);
          }
          if (nextAttachments.size > MAX_ATTACHMENTS) {
            return yield* new ProtocolFailure({
              code: "PAYLOAD_TOO_LARGE",
              message: `At most ${MAX_ATTACHMENTS} attachments may be pending.`
            });
          }
          const oversized = [...nextAttachments.values()].find((item) =>
            utf8ByteLength(item.text) > MAX_ATTACHMENT_BYTES
          );
          if (oversized) {
            return yield* new ProtocolFailure({
              code: "PAYLOAD_TOO_LARGE",
              message: `${oversized.displayPath} exceeds the ${MAX_ATTACHMENT_BYTES}-byte attachment limit after merging.`
            });
          }
          const total = [...nextAttachments.values()].reduce((sum, item) => sum + utf8ByteLength(item.text), 0);
          if (total > MAX_TOTAL_ATTACHMENT_BYTES) {
            return yield* new ProtocolFailure({
              code: "PAYLOAD_TOO_LARGE",
              message: `Pending attachments exceed ${MAX_TOTAL_ATTACHMENT_BYTES} bytes.`
            });
          }
        } else if (mutation.type === "removeAttachment") {
          changed = nextAttachments.delete(mutation.attachmentId);
        } else if (nextAttachments.size > 0) {
          nextAttachments.clear();
          changed = true;
        }

        const next: StoreData = changed
          ? { revision: current.revision + 1, attachments: nextAttachments }
          : current;
        if (changed) yield* Ref.set(state, next);
        const result = toSnapshot(next);
        if (changed) onChange(result);
        return result;
      }));

    const consume = (ids: ReadonlyArray<string>): Effect.Effect<AttachmentState> =>
      semaphore.withPermits(1)(Effect.gen(function* () {
        const current = yield* Ref.get(state);
        const attachments = new Map(current.attachments);
        let changed = false;
        for (const id of ids) changed = attachments.delete(id) || changed;
        const next = changed
          ? { revision: current.revision + 1, attachments }
          : current;
        if (changed) yield* Ref.set(state, next);
        const result = toSnapshot(next);
        if (changed) onChange(result);
        return result;
      }));

    const select = (ids: ReadonlyArray<string>): Effect.Effect<ReadonlyArray<AttachmentSnapshot>> =>
      Ref.get(state).pipe(Effect.map((current) => ids.flatMap((id) => {
        const item = current.attachments.get(id);
        return item ? [item] : [];
      })));

    return { snapshot, apply, consume, select };
  });
