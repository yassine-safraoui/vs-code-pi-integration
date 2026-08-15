import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
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
        const { response, body } = await fetchJson(`http://${record.host}:${record.port}/v1/health`, record.token);
        if (!response.ok) throw new Error(`Health check returned HTTP ${response.status}.`);
        const health = await Effect.runPromise(decodeHealthResponse(body));
        if (health.instanceId !== record.instanceId ||
            health.canonicalWorkingDirectory !== record.canonicalWorkingDirectory ||
            health.protocolVersion !== record.protocolVersion) {
          throw new Error("Discovery record did not match the Pi health response.");
        }
        return health;
      },
      catch: (cause) => new DiscoveryFailure({
        message: cause instanceof Error ? cause.message : "Pi health check failed."
      })
    });

  const quarantine = async (recordPath: string): Promise<void> => {
    try {
      await mkdir(paths.stale, { recursive: true, mode: 0o700 });
      await rename(recordPath, join(paths.stale, `${randomUUID()}.instance.json`));
    } catch {
      // Another process may already have cleaned it up.
    }
  };

  const discover = Effect.tryPromise({
    try: async () => {
      let names: string[];
      try {
        names = await readdir(paths.instances);
      } catch (cause) {
        const code = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;
        if (code === "ENOENT") return [];
        throw cause;
      }
      const candidates = await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => {
        const recordPath = join(paths.instances, name);
        try {
          const record = await Effect.runPromise(decodeDiscoveryRecord(JSON.parse(await readFile(recordPath, "utf8"))));
          if (record.host !== "127.0.0.1") throw new Error("Non-loopback discovery record.");
          if (isDiscoveryRecordStale(record)) throw new Error("Stale discovery heartbeat.");
          const result = await Effect.runPromise(Effect.either(healthCheck(record)));
          if (result._tag === "Left") {
            await quarantine(recordPath);
            return undefined;
          }
          return { record, health: result.right } satisfies LivePi;
        } catch {
          await quarantine(recordPath);
          return undefined;
        }
      }));
      return candidates.filter((candidate): candidate is LivePi => candidate !== undefined);
    },
    catch: (cause) => new DiscoveryFailure({
      message: cause instanceof Error ? cause.message : "Could not read the Pi Context registry."
    })
  });

  return { discover, healthCheck };
};

const requestState = (
  record: DiscoveryRecord,
  path: string,
  init?: RequestInit
): Effect.Effect<AttachmentState, ProtocolFailure> => Effect.tryPromise({
    try: async () => {
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
      return state;
    },
    catch: (cause) => cause instanceof ProtocolFailure
      ? cause
      : new ProtocolFailure({
          code: "INSTANCE_GONE",
          message: cause instanceof Error ? cause.message : "Could not reach the selected Pi."
        })
  });

export const makePiClient = (): PiClientShape => ({
  getState: (record) => requestState(record, "/v1/state"),
  mutate: (record, mutation) => requestState(record, "/v1/mutations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(mutation)
  })
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
