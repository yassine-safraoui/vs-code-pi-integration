import { Data, Effect, Schema } from "effect";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import * as nodePath from "node:path";

export const PROTOCOL_VERSION = 3 as const;
export const DISCOVERY_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
export const DISCOVERY_STALE_AFTER_MS = 6 * 60 * 1000;
export const VSCODE_EXTENSION_ID = "pi-context.pi-context-vscode";
export const VSCODE_OPEN_ATTACHMENT_PATH = "/open-attachment";
export const MAX_ATTACHMENTS = 20;
export const MAX_ATTACHMENT_BYTES = 64 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 256 * 1024;
export const MAX_HISTORY_ENTRIES = 50;
export const MAX_HISTORY_BYTES = 1024 * 1024;
export const MAX_REQUEST_BYTES = 320 * 1024;

const PositiveInteger = Schema.Int.pipe(Schema.greaterThanOrEqualTo(1));
const NonNegativeInteger = Schema.Int.pipe(Schema.greaterThanOrEqualTo(0));
const NonEmptyString = Schema.String.pipe(Schema.minLength(1));
const IsoTimestamp = Schema.String.pipe(
  Schema.filter((value) => !Number.isNaN(Date.parse(value)), {
    message: () => "Expected an ISO-8601 timestamp"
  })
);
const FileUri = Schema.String.pipe(
  Schema.filter((value) => {
    try {
      return new URL(value).protocol === "file:";
    } catch {
      return false;
    }
  }, { message: () => "Expected a file: URI" })
);

export const PositionSchema = Schema.Struct({
  line: PositiveInteger,
  column: PositiveInteger
});

export const SelectionRangeSchema = Schema.Struct({
  start: PositionSchema,
  end: PositionSchema
}).pipe(Schema.filter((range) =>
  range.end.line > range.start.line ||
  (range.end.line === range.start.line && range.end.column > range.start.column), {
  message: () => "Selection range must be non-empty and ordered"
}));

export const AttachmentSnapshotSchema = Schema.Struct({
  id: Schema.UUID,
  fileUri: FileUri,
  displayPath: NonEmptyString,
  relationship: Schema.Literal("inside", "outside"),
  range: SelectionRangeSchema,
  text: Schema.String,
  languageId: NonEmptyString,
  documentVersion: NonNegativeInteger,
  dirty: Schema.Boolean,
  capturedAt: IsoTimestamp
});

export type AttachmentSnapshot = typeof AttachmentSnapshotSchema.Type;

export const AttachmentHistoryEntrySchema = Schema.Struct({
  historyId: Schema.UUID,
  attachment: AttachmentSnapshotSchema,
  usedAt: IsoTimestamp
});
export type AttachmentHistoryEntry = typeof AttachmentHistoryEntrySchema.Type;

export const OpenAttachmentRequestSchema = Schema.Struct({
  protocolVersion: Schema.Literal(PROTOCOL_VERSION),
  fileUri: FileUri,
  range: SelectionRangeSchema
});
export type OpenAttachmentRequest = typeof OpenAttachmentRequestSchema.Type;

const MutationBase = {
  protocolVersion: Schema.Literal(PROTOCOL_VERSION),
  requestId: Schema.UUID
};

export const AttachSelectionsMutationSchema = Schema.Struct({
  ...MutationBase,
  type: Schema.Literal("attachSelections"),
  attachments: Schema.Array(AttachmentSnapshotSchema)
});
export const RemoveAttachmentMutationSchema = Schema.Struct({
  ...MutationBase,
  type: Schema.Literal("removeAttachment"),
  attachmentId: Schema.UUID
});
export const ClearAttachmentsMutationSchema = Schema.Struct({
  ...MutationBase,
  type: Schema.Literal("clearAttachments")
});
export const ReattachHistoryMutationSchema = Schema.Struct({
  ...MutationBase,
  type: Schema.Literal("reattachHistory"),
  historyId: Schema.UUID
});
export const MutationSchema = Schema.Union(
  AttachSelectionsMutationSchema,
  RemoveAttachmentMutationSchema,
  ClearAttachmentsMutationSchema,
  ReattachHistoryMutationSchema
);
export type Mutation = typeof MutationSchema.Type;

export const AttachmentStateSchema = Schema.Struct({
  protocolVersion: Schema.Literal(PROTOCOL_VERSION),
  revision: NonNegativeInteger,
  instanceId: Schema.UUID,
  attachments: Schema.Array(AttachmentSnapshotSchema),
  history: Schema.Array(AttachmentHistoryEntrySchema)
});
export type AttachmentState = typeof AttachmentStateSchema.Type;

export const DiscoveryRecordSchema = Schema.Struct({
  protocolVersion: Schema.Literal(PROTOCOL_VERSION),
  instanceId: Schema.UUID,
  canonicalWorkingDirectory: NonEmptyString,
  pid: PositiveInteger,
  startedAt: IsoTimestamp,
  lastActiveAt: IsoTimestamp,
  host: Schema.Literal("127.0.0.1"),
  port: Schema.Int.pipe(Schema.between(1, 65535)),
  token: NonEmptyString
});
export type DiscoveryRecord = typeof DiscoveryRecordSchema.Type;

export const isDiscoveryRecordStale = (
  record: Pick<DiscoveryRecord, "lastActiveAt">,
  now = Date.now()
): boolean => now - Date.parse(record.lastActiveAt) >= DISCOVERY_STALE_AFTER_MS;

export const LeaseRecordSchema = Schema.Struct({
  protocolVersion: Schema.Literal(PROTOCOL_VERSION),
  instanceId: Schema.UUID,
  canonicalWorkingDirectory: NonEmptyString,
  token: NonEmptyString
});
export type LeaseRecord = typeof LeaseRecordSchema.Type;

export const HealthResponseSchema = Schema.Struct({
  protocolVersion: Schema.Literal(PROTOCOL_VERSION),
  instanceId: Schema.UUID,
  canonicalWorkingDirectory: NonEmptyString,
  pendingCount: NonNegativeInteger
});
export type HealthResponse = typeof HealthResponseSchema.Type;

export const ProtocolErrorCodeSchema = Schema.Literal(
  "UNAUTHORIZED",
  "VERSION_MISMATCH",
  "INVALID_ATTACHMENT",
  "INVALID_REQUEST",
  "PAYLOAD_TOO_LARGE",
  "INSTANCE_GONE",
  "REGISTRY_UNAVAILABLE",
  "WORKING_DIRECTORY_BUSY"
);
export type ProtocolErrorCode = typeof ProtocolErrorCodeSchema.Type;

export const ErrorResponseSchema = Schema.Struct({
  error: Schema.Struct({
    code: ProtocolErrorCodeSchema,
    message: NonEmptyString
  })
});
export type ErrorResponse = typeof ErrorResponseSchema.Type;

export class ProtocolFailure extends Data.TaggedError("ProtocolFailure")<{
  readonly code: ProtocolErrorCode;
  readonly message: string;
}> {}

export const decodeDiscoveryRecord = Schema.decodeUnknown(DiscoveryRecordSchema);
export const decodeLeaseRecord = Schema.decodeUnknown(LeaseRecordSchema);
export const decodeHealthResponse = Schema.decodeUnknown(HealthResponseSchema);
export const decodeMutation = Schema.decodeUnknown(MutationSchema);
export const decodeAttachmentState = Schema.decodeUnknown(AttachmentStateSchema);
export const decodeErrorResponse = Schema.decodeUnknown(ErrorResponseSchema);

export const createVsCodeOpenAttachmentUri = (
  attachment: Pick<AttachmentSnapshot, "fileUri" | "range">
): string => {
  const uri = new URL(`vscode://${VSCODE_EXTENSION_ID}${VSCODE_OPEN_ATTACHMENT_PATH}`);
  uri.searchParams.set("fileUri", attachment.fileUri);
  uri.searchParams.set("startLine", String(attachment.range.start.line));
  uri.searchParams.set("startColumn", String(attachment.range.start.column));
  uri.searchParams.set("endLine", String(attachment.range.end.line));
  uri.searchParams.set("endColumn", String(attachment.range.end.column));
  return uri.toString();
};

export const decodeVsCodeOpenAttachmentUri = (
  value: string
): Effect.Effect<OpenAttachmentRequest, ProtocolFailure> =>
  Effect.gen(function* () {
    const uri = yield* Effect.try({
      try: () => new URL(value),
      catch: () => new ProtocolFailure({ code: "INVALID_REQUEST", message: "Invalid VS Code attachment URI." })
    });
    if (
      uri.protocol !== "vscode:" ||
      uri.hostname !== VSCODE_EXTENSION_ID ||
      uri.pathname !== VSCODE_OPEN_ATTACHMENT_PATH
    ) {
      return yield* new ProtocolFailure({
        code: "INVALID_REQUEST",
        message: "The VS Code attachment URI targets an unsupported handler."
      });
    }
    const numberParameter = (name: string): number => Number(uri.searchParams.get(name));
    return yield* Schema.decodeUnknown(OpenAttachmentRequestSchema)({
      protocolVersion: PROTOCOL_VERSION,
      fileUri: uri.searchParams.get("fileUri"),
      range: {
        start: {
          line: numberParameter("startLine"),
          column: numberParameter("startColumn")
        },
        end: {
          line: numberParameter("endLine"),
          column: numberParameter("endColumn")
        }
      }
    }).pipe(Effect.mapError(() => new ProtocolFailure({
      code: "INVALID_REQUEST",
      message: "The VS Code attachment URI contains an invalid file or selection range."
    })));
  });

export const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).byteLength;

export const validateAttachmentBatch = (
  attachments: ReadonlyArray<AttachmentSnapshot>
): Effect.Effect<ReadonlyArray<AttachmentSnapshot>, ProtocolFailure> =>
  Effect.gen(function* () {
    if (attachments.length === 0) {
      return yield* new ProtocolFailure({
        code: "INVALID_ATTACHMENT",
        message: "Select at least one non-empty editor range."
      });
    }
    if (attachments.length > MAX_ATTACHMENTS) {
      return yield* new ProtocolFailure({
        code: "PAYLOAD_TOO_LARGE",
        message: `At most ${MAX_ATTACHMENTS} selections can be attached at once.`
      });
    }
    let total = 0;
    for (const attachment of attachments) {
      if (attachment.text.length === 0) {
        return yield* new ProtocolFailure({
          code: "INVALID_ATTACHMENT",
          message: `${attachment.displayPath} has an empty selection.`
        });
      }
      const size = utf8ByteLength(attachment.text);
      if (size > MAX_ATTACHMENT_BYTES) {
        return yield* new ProtocolFailure({
          code: "PAYLOAD_TOO_LARGE",
          message: `${attachment.displayPath} exceeds the ${MAX_ATTACHMENT_BYTES}-byte selection limit.`
        });
      }
      total += size;
    }
    if (total > MAX_TOTAL_ATTACHMENT_BYTES) {
      return yield* new ProtocolFailure({
        code: "PAYLOAD_TOO_LARGE",
        message: `Selections exceed the ${MAX_TOTAL_ATTACHMENT_BYTES}-byte total limit.`
      });
    }
    return attachments;
  });

export type SupportedPlatform = "win32" | "darwin" | "linux";

const pathApi = (platform: SupportedPlatform): typeof nodePath.win32 =>
  platform === "win32" ? nodePath.win32 : nodePath.posix;

export const normalizeCanonicalPath = (
  value: string,
  platform: SupportedPlatform = process.platform as SupportedPlatform
): string => {
  const api = pathApi(platform);
  const normalized = api.normalize(value);
  if (platform !== "win32") return normalized;
  return normalized.replace(/^[a-z]:/, (drive) => drive.toUpperCase());
};

export const isPathInside = (
  candidate: string,
  directory: string,
  platform: SupportedPlatform = process.platform as SupportedPlatform
): boolean => {
  const api = pathApi(platform);
  const normalizeForComparison = (value: string) => {
    const normalized = normalizeCanonicalPath(value, platform);
    return platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
  };
  const relative = api.relative(normalizeForComparison(directory), normalizeForComparison(candidate));
  return relative === "" || (!api.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${api.sep}`));
};

export const classifyPath = (
  canonicalFilePath: string,
  canonicalWorkingDirectory: string,
  platform: SupportedPlatform = process.platform as SupportedPlatform
): { readonly relationship: "inside" | "outside"; readonly displayPath: string } => {
  const api = pathApi(platform);
  if (!isPathInside(canonicalFilePath, canonicalWorkingDirectory, platform)) {
    return { relationship: "outside", displayPath: normalizeCanonicalPath(canonicalFilePath, platform) };
  }
  const relative = api.relative(canonicalWorkingDirectory, canonicalFilePath);
  return { relationship: "inside", displayPath: relative.split(api.sep).join("/") || api.basename(canonicalFilePath) };
};

export const canonicalizePath = (value: string): Effect.Effect<string, ProtocolFailure> =>
  Effect.tryPromise({
    try: () => realpath(value),
    catch: () => new ProtocolFailure({
      code: "INVALID_ATTACHMENT",
      message: `Could not resolve file path: ${value}`
    })
  }).pipe(Effect.map((resolved) => normalizeCanonicalPath(resolved)));

export interface RegistryPaths {
  readonly root: string;
  readonly instances: string;
  readonly leases: string;
  readonly stale: string;
}

export const registryPaths = (userHome = homedir()): RegistryPaths => {
  const root = nodePath.join(userHome, ".pi-context", "run", `v${PROTOCOL_VERSION}`);
  return {
    root,
    instances: nodePath.join(root, "instances"),
    leases: nodePath.join(root, "leases"),
    stale: nodePath.join(root, "stale")
  };
};
