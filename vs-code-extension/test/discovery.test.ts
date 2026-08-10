import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Effect } from "effect";
import { PROTOCOL_VERSION, registryPaths, type AttachmentState, type DiscoveryRecord } from "@pi-context/protocol";
import { makeDiscoveryService, makePiClient } from "../src/discovery.js";

describe("Pi discovery", () => {
  it("enumerates only records whose authenticated health identity matches", async () => {
    const userHome = await mkdtemp(join(tmpdir(), "pi-context-discovery-"));
    const paths = registryPaths(userHome);
    await mkdir(paths.instances, { recursive: true });
    const instanceId = randomUUID();
    const token = randomBytes(32).toString("base64url");
    const cwd = join(userHome, "repo");
    const server = createServer((request, response) => {
      if (request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(401).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        instanceId,
        canonicalWorkingDirectory: cwd,
        pendingCount: 2
      }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    try {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const record: DiscoveryRecord = {
        protocolVersion: PROTOCOL_VERSION,
        instanceId,
        canonicalWorkingDirectory: cwd,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        host: "127.0.0.1",
        port: address.port,
        token
      };
      await writeFile(join(paths.instances, `${instanceId}.json`), JSON.stringify(record), "utf8");
      await writeFile(join(paths.instances, "malformed.json"), "not-json", "utf8");
      const live = await Effect.runPromise(makeDiscoveryService(paths).discover);
      assert.equal(live.length, 1);
      assert.equal(live[0]?.record.instanceId, instanceId);
      assert.equal(live[0]?.health.pendingCount, 2);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("Pi client", () => {
  it("fetches authenticated state and verifies the instance identity", async () => {
    const instanceId = randomUUID();
    const token = randomBytes(32).toString("base64url");
    const state: AttachmentState = { protocolVersion: PROTOCOL_VERSION, instanceId, revision: 3, attachments: [], history: [] };
    const server = createServer((request, response) => {
      assert.equal(request.url, "/v1/state");
      assert.equal(request.headers.authorization, `Bearer ${token}`);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(state));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    try {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const record: DiscoveryRecord = {
        protocolVersion: PROTOCOL_VERSION,
        instanceId,
        canonicalWorkingDirectory: "/repo",
        pid: process.pid,
        startedAt: new Date().toISOString(),
        host: "127.0.0.1",
        port: address.port,
        token
      };
      assert.deepEqual(await Effect.runPromise(makePiClient().getState(record)), state);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
