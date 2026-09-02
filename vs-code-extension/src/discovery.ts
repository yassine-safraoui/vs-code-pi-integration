import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Context, Data, Effect, Layer } from "effect";
import {
  PROTOCOL_VERSION,
  ProtocolFailure,
  decodeAttachmentState,
  decodeDiscoveryRecord,
  decodeErrorResponse,
  decodeHealthResponse,
  isDiscoveryRecordStale,
  registryPaths,
  type AttachmentState,
  type DiscoveryRecord,
  type HealthResponse,
  type Mutation,
  type RegistryPaths
} from "@pi-context/protocol";
import { logError, logInfo, logWarning } from "./logging.js";

export interface LivePi {
  readonly record: DiscoveryRecord;
  readonly health: HealthResponse;
}

export class DiscoveryFailure extends Data.TaggedError("DiscoveryFailure")<{
  readonly message: string;
}> {}

export interface DiscoveryServiceShape {
  readonly discover: Effect.Effect<ReadonlyArray<LivePi>, DiscoveryFailure>;
  readonly healthCheck: (record: DiscoveryRecord) => Effect.Effect<HealthResponse, DiscoveryFailure>;
}

export class DiscoveryService extends Context.Tag("@pi-context/DiscoveryService")<
  DiscoveryService,
  DiscoveryServiceShape
>() {}

export interface PiClientShape {
  readonly getState: (record: DiscoveryRecord) => Effect.Effect<AttachmentState, ProtocolFailure>;
  readonly mutate: (record: DiscoveryRecord, mutation: Mutation) => Effect.Effect<AttachmentState, ProtocolFailure>;
}

export class PiClient extends Context.Tag("@pi-context/PiClient")<PiClient, PiClientShape>() {}

const safeRecordRejectionReason = (cause: unknown): string => {
  if (cause instanceof SyntaxError) return "Discovery record contains invalid JSON.";
  if (cause instanceof DiscoveryFailure) return cause.message;
  if (cause instanceof Error && (
    cause.message === "Non-loopback discovery record." ||
    cause.message === "Stale discovery heartbeat."
  )) return cause.message;
  return "Discovery record did not match protocol schema.";
};

const fetchJson = async (url: string, token: string, init: RequestInit = {}): Promise<{ response: Response; body: unknown }> => {
  const response = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.headers ?? {})
    },
    signal: AbortSignal.timeout(500)
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  return { response, body };
};

export const makeDiscoveryService = (paths: RegistryPaths = registryPaths()): DiscoveryServiceShape => {
  const healthCheck = (record: DiscoveryRecord): Effect.Effect<HealthResponse, DiscoveryFailure> =>
    Effect.tryPromise({
      try: async () => {
        logInfo("discovery.health.start", {
          instanceId: record.instanceId,
          cwd: record.canonicalWorkingDirectory,
          host: record.host,
          port: record.port,
          protocolVersion: record.protocolVersion
        });
        const { response, body } = await fetchJson(`http://${record.host}:${record.port}/v1/health`, record.token);
        if (!response.ok) throw new Error(`Health check returned HTTP ${response.status}.`);
        const health = await Effect.runPromise(decodeHealthResponse(body));
        if (health.instanceId !== record.instanceId ||
            health.canonicalWorkingDirectory !== record.canonicalWorkingDirectory ||
            health.protocolVersion !== record.protocolVersion) {
          throw new Error("Discovery record did not match the Pi health response.");
        }
        logInfo("discovery.health.success", {
          instanceId: health.instanceId,
          cwd: health.canonicalWorkingDirectory,
          pendingCount: health.pendingCount,
          protocolVersion: health.protocolVersion
        });
        return health;
      },
      catch: (cause) => {
        logError("discovery.health.failure", cause, {
          instanceId: record.instanceId,
          cwd: record.canonicalWorkingDirectory,
          host: record.host,
          port: record.port
        });
        return new DiscoveryFailure({
          message: cause instanceof Error ? cause.message : "Pi health check failed."
        });
      }
    });

  const quarantine = async (recordPath: string): Promise<void> => {
    try {
      await mkdir(paths.stale, { recursive: true, mode: 0o700 });
      const destination = join(paths.stale, `${randomUUID()}.instance.json`);
      await rename(recordPath, destination);
      logWarning("discovery.record.quarantined", { recordPath, destination });
    } catch (cause) {
      // Another process may already have cleaned it up.
      logWarning("discovery.record.quarantine_skipped", {
        recordPath,
        reason: cause instanceof Error ? cause.message : String(cause)
      });
    }
  };

  const discover = Effect.tryPromise({
    try: async () => {
      logInfo("discovery.scan.start", {
        protocolVersion: PROTOCOL_VERSION,
        registryRoot: paths.root,
        instancesDirectory: paths.instances
      });
      try {
        const availableRegistryDirectories = (await readdir(dirname(paths.root)))
          .filter((name) => /^v\d+$/u.test(name))
          .sort();
        logInfo("discovery.scan.protocol_directories", {
          expected: `v${PROTOCOL_VERSION}`,
          available: availableRegistryDirectories
        });
      } catch (cause) {
        logWarning("discovery.scan.registry_parent_unavailable", {
          registryParent: dirname(paths.root),
          reason: cause instanceof Error ? cause.message : String(cause)
        });
      }
      let names: string[];
      try {
        names = await readdir(paths.instances);
      } catch (cause) {
        const code = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;
        if (code === "ENOENT") {
          logWarning("discovery.scan.instances_directory_missing", { instancesDirectory: paths.instances });
          logInfo("discovery.scan.complete", { liveInstances: 0, rejectedRecords: 0 });
          return [];
        }
        throw cause;
      }
      const jsonNames = names.filter((name) => name.endsWith(".json"));
      logInfo("discovery.scan.entries", { totalEntries: names.length, jsonRecords: jsonNames.length });
      const candidates = await Promise.all(jsonNames.map(async (name) => {
        const recordPath = join(paths.instances, name);
        try {
          const record = await Effect.runPromise(decodeDiscoveryRecord(JSON.parse(await readFile(recordPath, "utf8"))));
          logInfo("discovery.record.decoded", {
            recordPath,
            instanceId: record.instanceId,
            cwd: record.canonicalWorkingDirectory,
            pid: record.pid,
            host: record.host,
            port: record.port,
            protocolVersion: record.protocolVersion,
            startedAt: record.startedAt,
            lastActiveAt: record.lastActiveAt
          });
          if (record.host !== "127.0.0.1") throw new Error("Non-loopback discovery record.");
          if (isDiscoveryRecordStale(record)) throw new Error("Stale discovery heartbeat.");
          const result = await Effect.runPromise(Effect.either(healthCheck(record)));
          if (result._tag === "Left") {
            logWarning("discovery.record.health_rejected", {
              recordPath,
              instanceId: record.instanceId,
              reason: result.left.message
            });
            await quarantine(recordPath);
            return undefined;
          }
          logInfo("discovery.record.accepted", {
            recordPath,
            instanceId: record.instanceId,
            cwd: record.canonicalWorkingDirectory
          });
          return { record, health: result.right } satisfies LivePi;
        } catch (cause) {
          logWarning("discovery.record.rejected", {
            recordPath,
            reason: safeRecordRejectionReason(cause)
          });
          await quarantine(recordPath);
          return undefined;
        }
      }));
      const live = candidates.filter((candidate): candidate is LivePi => candidate !== undefined);
      logInfo("discovery.scan.complete", { liveInstances: live.length, rejectedRecords: candidates.length - live.length });
      return live;
    },
    catch: (cause) => {
      logError("discovery.scan.failure", cause, { registryRoot: paths.root });
      return new DiscoveryFailure({
        message: cause instanceof Error ? cause.message : "Could not read the Pi Context registry."
      });
    }
  });

  return { discover, healthCheck };
};

const requestState = (
  record: DiscoveryRecord,
  path: string,
  init?: RequestInit
): Effect.Effect<AttachmentState, ProtocolFailure> => Effect.tryPromise({
    try: async () => {
      logInfo("client.request.start", {
        instanceId: record.instanceId,
        cwd: record.canonicalWorkingDirectory,
        host: record.host,
        port: record.port,
        path,
        method: init?.method ?? "GET"
      });
      const { response, body } = await fetchJson(`http://${record.host}:${record.port}${path}`, record.token, init);
      if (!response.ok) {
        try {
          const decoded = await Effect.runPromise(decodeErrorResponse(body));
          throw new ProtocolFailure(decoded.error);
        } catch (cause) {
          if (cause instanceof ProtocolFailure) throw cause;
          throw new ProtocolFailure({ code: "INSTANCE_GONE", message: `Pi returned HTTP ${response.status}.` });
        }
      }
      const state = await Effect.runPromise(decodeAttachmentState(body));
      if (state.instanceId !== record.instanceId || state.protocolVersion !== record.protocolVersion) {
        throw new ProtocolFailure({ code: "INSTANCE_GONE", message: "Pi state did not match the discovery record." });
      }
      logInfo("client.request.success", {
        instanceId: state.instanceId,
        path,
        status: response.status,
        revision: state.revision,
        activeConversationKind: state.activeConversation.kind,
        pendingCount: state.attachments.length,
        historyCount: state.history.length,
        inactiveConversationCount: state.inactiveConversations.length
      });
      return state;
    },
    catch: (cause) => {
      logError("client.request.failure", cause, {
        instanceId: record.instanceId,
        cwd: record.canonicalWorkingDirectory,
        path,
        method: init?.method ?? "GET"
      });
      return cause instanceof ProtocolFailure
        ? cause
        : new ProtocolFailure({
          code: "INSTANCE_GONE",
          message: cause instanceof Error ? cause.message : "Could not reach the selected Pi."
        });
    }
  });

export const makePiClient = (): PiClientShape => ({
  getState: (record) => requestState(record, "/v1/state"),
  mutate: (record, mutation) => {
    logInfo("client.mutation.prepare", {
      instanceId: record.instanceId,
      cwd: record.canonicalWorkingDirectory,
      mutationType: mutation.type,
      ...(mutation.type === "attachSelections" ? { attachmentCount: mutation.attachments.length } : {})
    });
    return requestState(record, "/v1/mutations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(mutation)
    });
  }
});

export const DiscoveryLive = (paths?: RegistryPaths) => Layer.succeed(DiscoveryService, makeDiscoveryService(paths));
export const PiClientLive = Layer.succeed(PiClient, makePiClient());

export const discoverPis = DiscoveryService.pipe(Effect.flatMap((service) => service.discover));
export const healthCheckPi = (record: DiscoveryRecord) => DiscoveryService.pipe(
  Effect.flatMap((service) => service.healthCheck(record))
);
export const mutatePi = (record: DiscoveryRecord, mutation: Mutation) => PiClient.pipe(
  Effect.flatMap((client) => client.mutate(record, mutation))
);
export const getPiState = (record: DiscoveryRecord) => PiClient.pipe(
  Effect.flatMap((client) => client.getState(record))
);

export const clearMutation = (): Mutation => ({
  protocolVersion: PROTOCOL_VERSION,
  requestId: randomUUID(),
  type: "clearAttachments"
});
