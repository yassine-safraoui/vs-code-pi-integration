import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Schedule } from "effect";
import {
  MAX_REQUEST_BYTES,
  PROTOCOL_VERSION,
  ProtocolFailure,
  canonicalizePath,
  classifyPath,
  decodeDiscoveryRecord,
  decodeLeaseRecord,
  decodeMutation,
  registryPaths,
  type AttachmentSnapshot,
  type DiscoveryRecord,
  type ErrorResponse,
  type LeaseRecord,
  type Mutation,
  type RegistryPaths
} from "@pi-context/protocol";
import type { AttachmentStore } from "./attachment-store.js";

export interface RunningRegistryServer {
  readonly record: DiscoveryRecord;
  readonly close: Effect.Effect<void>;
}

interface StartOptions {
  readonly instanceId?: string;
  readonly userHome?: string;
  readonly pid?: number;
  readonly startedAt?: string;
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

const healthCheck = async (record: DiscoveryRecord): Promise<boolean> => {
  try {
    const response = await fetch(`http://${record.host}:${record.port}/v1/health`, {
      headers: { authorization: `Bearer ${record.token}` },
      signal: AbortSignal.timeout(350)
    });
    if (!response.ok) return false;
    const body = await response.json() as Record<string, unknown>;
    return body.instanceId === record.instanceId &&
      body.canonicalWorkingDirectory === record.canonicalWorkingDirectory &&
      body.protocolVersion === PROTOCOL_VERSION;
  } catch {
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
  lease: LeaseRecord
): Promise<void> => {
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
      return;
    } catch (cause) {
      const code = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;
      if (code !== "EEXIST") throw cause;
    }

    let active = false;
    try {
      const existingLease = await Effect.runPromise(decodeLeaseRecord(JSON.parse(await readFile(leasePath, "utf8"))));
      const recordPath = join(paths.instances, `${existingLease.instanceId}.json`);
      const record = await Effect.runPromise(decodeDiscoveryRecord(JSON.parse(await readFile(recordPath, "utf8"))));
      active = await healthCheck(record);
    } catch {
      active = false;
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
    } catch (cause) {
      const code = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;
      if (code !== "ENOENT") await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
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
      const canonicalWorkingDirectory = await runProtocolEffect(canonicalizePath(cwd));
      const instanceId = options.instanceId ?? randomUUID();
      const token = randomBytes(32).toString("base64url");
      const paths = registryPaths(options.userHome);
      const leaseHash = createHash("sha256").update(canonicalWorkingDirectory).digest("hex");
      const leasePath = join(paths.leases, `${leaseHash}.json`);
      const recordPath = join(paths.instances, `${instanceId}.json`);
      const lease: LeaseRecord = { protocolVersion: PROTOCOL_VERSION, instanceId, canonicalWorkingDirectory, token };
      await acquireLease(paths, leasePath, lease);

      let record: DiscoveryRecord | undefined;
      const server = createServer((request, response) => {
        void (async () => {
          if (!record) {
            json(response, 503, failureResponse(new ProtocolFailure({ code: "INSTANCE_GONE", message: "Pi Context is starting." })));
            return;
          }
          if (!authorized(request, token)) {
            json(response, 401, failureResponse(new ProtocolFailure({ code: "UNAUTHORIZED", message: "Invalid Pi Context token." })));
            return;
          }
          if (request.method === "GET" && request.url === "/v1/health") {
            const state = await Effect.runPromise(store.snapshot);
            json(response, 200, {
              protocolVersion: PROTOCOL_VERSION,
              instanceId,
              canonicalWorkingDirectory,
              pendingCount: state.attachments.length
            });
            return;
          }
          if (request.method === "GET" && request.url === "/v1/state") {
            json(response, 200, await Effect.runPromise(store.snapshot));
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
            const state = await runProtocolEffect(
              decodeMutation(unknownBody).pipe(
                Effect.mapError(() => new ProtocolFailure({
                  code: "INVALID_REQUEST",
                  message: "Request body does not match the Pi Context protocol."
                })),
                Effect.flatMap((decoded) => normalizeMutationAttachments(decoded, canonicalWorkingDirectory)),
                Effect.flatMap(store.apply)
              )
            );
            json(response, 200, state);
          } catch (cause) {
            const failure = cause instanceof ProtocolFailure
              ? cause
              : new ProtocolFailure({ code: "INVALID_REQUEST", message: "Could not process the attachment request." });
            const status = failure.code === "PAYLOAD_TOO_LARGE" ? 413 : 400;
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
        record = {
          protocolVersion: PROTOCOL_VERSION,
          instanceId,
          canonicalWorkingDirectory,
          pid: options.pid ?? process.pid,
          startedAt: options.startedAt ?? new Date().toISOString(),
          host: "127.0.0.1",
          port: address.port,
          token
        };
        await atomicWrite(recordPath, record);
      } catch (cause) {
        server.closeAllConnections();
        server.close();
        await rm(leasePath, { force: true });
        throw cause;
      }

      let closed = false;
      const close = Effect.gen(function* () {
        if (closed) return;
        closed = true;
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
        if (yield* Effect.promise(() => owns(recordPath, token))) yield* removeWithRetry(recordPath);
        if (yield* Effect.promise(() => owns(leasePath, token))) yield* removeWithRetry(leasePath);
      });
      return { record, close };
    },
    catch: (cause) => cause instanceof ProtocolFailure
      ? cause
      : new ProtocolFailure({
          code: "REGISTRY_UNAVAILABLE",
          message: cause instanceof Error ? cause.message : "Could not start Pi Context discovery."
        })
  });
