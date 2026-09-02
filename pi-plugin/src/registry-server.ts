import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Schedule } from "effect";
import {
  DISCOVERY_HEARTBEAT_INTERVAL_MS,
  MAX_REQUEST_BYTES,
  PROTOCOL_VERSION,
  ProtocolFailure,
  canonicalizePath,
  classifyPath,
  decodeDiscoveryRecord,
  decodeLeaseRecord,
  decodeMutation,
  isDiscoveryRecordStale,
  registryPaths,
  type AttachmentSnapshot,
  type DiscoveryRecord,
  type ErrorResponse,
  type LeaseRecord,
  type Mutation,
  type RegistryPaths
} from "@pi-context/protocol";
import type { AttachmentStore } from "./attachment-store.js";
import { silentLogger, type PiContextLogger } from "./logging.js";

export interface RunningRegistryServer {
  readonly record: DiscoveryRecord;
  readonly close: Effect.Effect<void>;
}

interface StartOptions {
  readonly instanceId?: string;
  readonly userHome?: string;
  readonly pid?: number;
  readonly startedAt?: string;
  readonly heartbeatIntervalMs?: number;
  readonly logger?: PiContextLogger;
}

const json = (response: ServerResponse, status: number, value: unknown): void => {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(value));
};

const failureResponse = (failure: ProtocolFailure): ErrorResponse => ({
  error: { code: failure.code, message: failure.message }
});

const authorized = (request: IncomingMessage, token: string): boolean => {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
};

const readRequestBody = (request: IncomingMessage): Promise<string> => new Promise((resolve, reject) => {
  const chunks: Buffer[] = [];
  let size = 0;
  request.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) {
      reject(new ProtocolFailure({ code: "PAYLOAD_TOO_LARGE", message: "Request body is too large." }));
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });
  request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  request.on("error", reject);
});

const atomicWrite = async (path: string, value: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
};

const removeWithRetry = (path: string): Effect.Effect<void> =>
  Effect.tryPromise({
    try: () => rm(path, { force: true }),
    catch: (cause) => cause
  }).pipe(
    Effect.retry(Schedule.intersect(Schedule.recurs(3), Schedule.exponential("20 millis"))),
    Effect.catchAll(() => Effect.void)
  );

const healthCheck = async (record: DiscoveryRecord, logger: PiContextLogger): Promise<boolean> => {
  try {
    logger.info("registry.lease.health_check.start", {
      instanceId: record.instanceId,
      cwd: record.canonicalWorkingDirectory,
      host: record.host,
      port: record.port
    });
    const response = await fetch(`http://${record.host}:${record.port}/v1/health`, {
      headers: { authorization: `Bearer ${record.token}` },
      signal: AbortSignal.timeout(350)
    });
    if (!response.ok) {
      logger.warn("registry.lease.health_check.http_failure", { instanceId: record.instanceId, status: response.status });
      return false;
    }
    const body = await response.json() as Record<string, unknown>;
    const matches = body.instanceId === record.instanceId &&
      body.canonicalWorkingDirectory === record.canonicalWorkingDirectory &&
      body.protocolVersion === PROTOCOL_VERSION;
    logger.info("registry.lease.health_check.complete", { instanceId: record.instanceId, matches });
    return matches;
  } catch (cause) {
    logger.warn("registry.lease.health_check.unreachable", {
      instanceId: record.instanceId,
      reason: cause instanceof Error ? cause.message : String(cause)
    });
    return false;
  }
};

const runProtocolEffect = async <A>(effect: Effect.Effect<A, ProtocolFailure>): Promise<A> => {
  const result = await Effect.runPromise(Effect.either(effect));
  if (result._tag === "Left") throw result.left;
  return result.right;
};

const acquireLease = async (
  paths: RegistryPaths,
  leasePath: string,
  lease: LeaseRecord,
  logger: PiContextLogger
): Promise<void> => {
  logger.info("registry.lease.acquire.start", {
    leasePath,
    instancesDirectory: paths.instances,
    staleDirectory: paths.stale,
    instanceId: lease.instanceId,
    cwd: lease.canonicalWorkingDirectory
  });
  await mkdir(paths.leases, { recursive: true, mode: 0o700 });
  await mkdir(paths.instances, { recursive: true, mode: 0o700 });
  await mkdir(paths.stale, { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const handle = await open(leasePath, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(lease), "utf8");
      } finally {
        await handle.close();
      }
      logger.info("registry.lease.acquire.success", { leasePath, attempt: attempt + 1, instanceId: lease.instanceId });
      return;
    } catch (cause) {
      const code = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;
      if (code !== "EEXIST") throw cause;
      logger.warn("registry.lease.acquire.exists", { leasePath, attempt: attempt + 1 });
    }

    let active = false;
    try {
      const existingLease = await Effect.runPromise(decodeLeaseRecord(JSON.parse(await readFile(leasePath, "utf8"))));
      const recordPath = join(paths.instances, `${existingLease.instanceId}.json`);
      const record = await Effect.runPromise(decodeDiscoveryRecord(JSON.parse(await readFile(recordPath, "utf8"))));
      active = !isDiscoveryRecordStale(record) && await healthCheck(record, logger);
      logger.info("registry.lease.existing_inspected", {
        existingInstanceId: existingLease.instanceId,
        recordPath,
        stale: isDiscoveryRecordStale(record),
        active
      });
    } catch (cause) {
      active = false;
      logger.warn("registry.lease.existing_invalid", {
        leasePath,
        reason: "Existing lease or discovery record could not be validated.",
        errorType: cause instanceof Error ? cause.name : typeof cause
      });
    }
    if (active) {
      throw new ProtocolFailure({
        code: "WORKING_DIRECTORY_BUSY",
        message: `Another Pi Context plugin already owns ${lease.canonicalWorkingDirectory}.`
      });
    }

    const quarantined = join(paths.stale, `${lease.instanceId}-${randomUUID()}.lease.json`);
    try {
      await rename(leasePath, quarantined);
      logger.warn("registry.lease.quarantined", { leasePath, quarantined });
    } catch (cause) {
      const code = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;
      if (code !== "ENOENT") {
        logger.warn("registry.lease.quarantine_failed", {
          leasePath,
          reason: cause instanceof Error ? cause.message : String(cause)
        });
        await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
      }
    }
  }
  throw new ProtocolFailure({
    code: "REGISTRY_UNAVAILABLE",
    message: `Could not acquire the Pi Context registry lease for ${lease.canonicalWorkingDirectory}.`
  });
};

const normalizeMutationAttachments = (
  mutation: Mutation,
  canonicalWorkingDirectory: string
): Effect.Effect<Mutation, ProtocolFailure> => {
  if (mutation.type !== "attachSelections") return Effect.succeed(mutation);
  return Effect.forEach(mutation.attachments, (attachment) =>
    Effect.gen(function* () {
      let nativePath: string;
      try {
        nativePath = fileURLToPath(attachment.fileUri);
      } catch {
        return yield* new ProtocolFailure({ code: "INVALID_ATTACHMENT", message: "Attachment URI is not a local file." });
      }
      const canonicalPath = yield* canonicalizePath(nativePath);
      const classification = classifyPath(canonicalPath, canonicalWorkingDirectory);
      return {
        ...attachment,
        relationship: classification.relationship,
        displayPath: classification.displayPath
      } satisfies AttachmentSnapshot;
    }), { concurrency: 4 }).pipe(
      Effect.map((attachments) => ({ ...mutation, attachments }))
    );
};

export const startRegistryServer = (
  cwd: string,
  store: AttachmentStore,
  options: StartOptions = {}
): Effect.Effect<RunningRegistryServer, ProtocolFailure> =>
  Effect.tryPromise({
    try: async () => {
      const logger = options.logger ?? silentLogger;
      logger.info("registry.start.requested", {
        cwd,
        protocolVersion: PROTOCOL_VERSION,
        pid: options.pid ?? process.pid
      });
      const canonicalWorkingDirectory = await runProtocolEffect(canonicalizePath(cwd));
      const instanceId = options.instanceId ?? randomUUID();
      const token = randomBytes(32).toString("base64url");
      const paths = registryPaths(options.userHome);
      const leaseHash = createHash("sha256").update(canonicalWorkingDirectory).digest("hex");
      const leasePath = join(paths.leases, `${leaseHash}.json`);
      const recordPath = join(paths.instances, `${instanceId}.json`);
      logger.info("registry.start.paths_resolved", {
        instanceId,
        canonicalWorkingDirectory,
        registryRoot: paths.root,
        leasePath,
        recordPath
      });
      const lease: LeaseRecord = { protocolVersion: PROTOCOL_VERSION, instanceId, canonicalWorkingDirectory, token };
      await acquireLease(paths, leasePath, lease, logger);

      let record: DiscoveryRecord | undefined;
      const server = createServer((request, response) => {
        void (async () => {
          logger.info("registry.http.request", {
            instanceId,
            method: request.method,
            path: request.url,
            remoteAddress: request.socket.remoteAddress
          });
          if (!record) {
            logger.warn("registry.http.not_ready", { instanceId, method: request.method, path: request.url });
            json(response, 503, failureResponse(new ProtocolFailure({ code: "INSTANCE_GONE", message: "Pi Context is starting." })));
            return;
          }
          if (!authorized(request, token)) {
            logger.warn("registry.http.unauthorized", { instanceId, method: request.method, path: request.url });
            json(response, 401, failureResponse(new ProtocolFailure({ code: "UNAUTHORIZED", message: "Invalid Pi Context token." })));
            return;
          }
          if (request.method === "GET" && request.url === "/v1/health") {
            const state = await Effect.runPromise(store.snapshot);
            logger.info("registry.http.health", { instanceId, pendingCount: state.attachments.length });
            json(response, 200, {
              protocolVersion: PROTOCOL_VERSION,
              instanceId,
              canonicalWorkingDirectory,
              pendingCount: state.attachments.length
            });
            return;
          }
          if (request.method === "GET" && request.url === "/v1/state") {
            const state = await Effect.runPromise(store.snapshot);
            logger.info("registry.http.state", {
              instanceId,
              revision: state.revision,
              activeConversationKind: state.activeConversation.kind,
              pendingCount: state.attachments.length,
              historyCount: state.history.length,
              inactiveConversationCount: state.inactiveConversations.length
            });
            json(response, 200, state);
            return;
          }
          if (request.method !== "POST" || request.url !== "/v1/mutations") {
            json(response, 404, failureResponse(new ProtocolFailure({ code: "INVALID_REQUEST", message: "Endpoint not found." })));
            return;
          }
          if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
            json(response, 415, failureResponse(new ProtocolFailure({ code: "INVALID_REQUEST", message: "Expected application/json." })));
            return;
          }
          try {
            const raw = await readRequestBody(request);
            const unknownBody = JSON.parse(raw) as { protocolVersion?: unknown };
            if (unknownBody.protocolVersion !== PROTOCOL_VERSION) {
              throw new ProtocolFailure({
                code: "VERSION_MISMATCH",
                message: `Expected Pi Context protocol version ${PROTOCOL_VERSION}.`
              });
            }
            const decodedMutation = await runProtocolEffect(
              decodeMutation(unknownBody).pipe(
                Effect.mapError(() => new ProtocolFailure({
                  code: "INVALID_REQUEST",
                  message: "Request body does not match the Pi Context protocol."
                }))
              )
            );
            logger.info("registry.http.mutation", {
              instanceId,
              mutationType: decodedMutation.type,
              ...(decodedMutation.type === "attachSelections" ? { attachmentCount: decodedMutation.attachments.length } : {})
            });
            const state = await runProtocolEffect(
              normalizeMutationAttachments(decodedMutation, canonicalWorkingDirectory).pipe(
                Effect.flatMap(store.apply)
              )
            );
            logger.info("registry.http.mutation_success", {
              instanceId,
              mutationType: decodedMutation.type,
              revision: state.revision,
              pendingCount: state.attachments.length
            });
            json(response, 200, state);
          } catch (cause) {
            const failure = cause instanceof ProtocolFailure
              ? cause
              : new ProtocolFailure({ code: "INVALID_REQUEST", message: "Could not process the attachment request." });
            const status = failure.code === "PAYLOAD_TOO_LARGE" ? 413 : 400;
            logger.error("registry.http.mutation_failure", failure, {
              instanceId,
              code: failure.code,
              status
            });
            if (!response.headersSent) json(response, status, failureResponse(failure));
          }
        })();
      });

      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
          });
        });
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Loopback listener did not receive a TCP port.");
        const startedAt = options.startedAt ?? new Date().toISOString();
        record = {
          protocolVersion: PROTOCOL_VERSION,
          instanceId,
          canonicalWorkingDirectory,
          pid: options.pid ?? process.pid,
          startedAt,
          lastActiveAt: new Date().toISOString(),
          host: "127.0.0.1",
          port: address.port,
          token
        };
        logger.info("registry.listener.started", { instanceId, host: record.host, port: record.port });
        await atomicWrite(recordPath, record);
        logger.info("registry.record.published", {
          instanceId,
          recordPath,
          canonicalWorkingDirectory,
          protocolVersion: PROTOCOL_VERSION
        });
      } catch (cause) {
        logger.error("registry.start.failure", cause, { instanceId, recordPath, leasePath });
        server.closeAllConnections();
        server.close();
        await rm(leasePath, { force: true });
        throw cause;
      }

      let closed = false;
      let heartbeatWrite = Promise.resolve();
      const heartbeat = setInterval(() => {
        heartbeatWrite = heartbeatWrite.then(async () => {
          if (closed || !record) return;
          record = { ...record, lastActiveAt: new Date().toISOString() };
          await atomicWrite(recordPath, record);
          logger.info("registry.heartbeat.published", { instanceId, recordPath, lastActiveAt: record.lastActiveAt });
        }).catch((cause) => {
          // A missed write makes the record expire; the next interval retries it.
          logger.error("registry.heartbeat.failure", cause, { instanceId, recordPath });
        });
      }, options.heartbeatIntervalMs ?? DISCOVERY_HEARTBEAT_INTERVAL_MS);
      heartbeat.unref();
      const close = Effect.gen(function* () {
        if (closed) return;
        logger.info("registry.close.start", { instanceId, recordPath, leasePath });
        closed = true;
        clearInterval(heartbeat);
        yield* Effect.promise(() => heartbeatWrite);
        server.closeAllConnections();
        yield* Effect.async<void>((resume) => {
          server.close(() => resume(Effect.void));
        });
        const owns = async (path: string, expectedToken: string): Promise<boolean> => {
          try {
            const value = JSON.parse(await readFile(path, "utf8")) as { token?: unknown };
            return value.token === expectedToken;
          } catch {
            return false;
          }
        };
        if (yield* Effect.promise(() => owns(recordPath, token))) {
          yield* removeWithRetry(recordPath);
          logger.info("registry.close.record_removed", { instanceId, recordPath });
        } else logger.warn("registry.close.record_not_owned", { instanceId, recordPath });
        if (yield* Effect.promise(() => owns(leasePath, token))) {
          yield* removeWithRetry(leasePath);
          logger.info("registry.close.lease_removed", { instanceId, leasePath });
        } else logger.warn("registry.close.lease_not_owned", { instanceId, leasePath });
        logger.info("registry.close.complete", { instanceId });
      });
      return { record, close };
    },
    catch: (cause) => {
      (options.logger ?? silentLogger).error("registry.start.failed", cause, {
        cwd,
        protocolVersion: PROTOCOL_VERSION,
        pid: options.pid ?? process.pid
      });
      return cause instanceof ProtocolFailure
        ? cause
        : new ProtocolFailure({
          code: "REGISTRY_UNAVAILABLE",
          message: cause instanceof Error ? cause.message : "Could not start Pi Context discovery."
        });
    }
  });
