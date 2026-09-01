import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { Effect } from "effect";
import { PROTOCOL_VERSION, canonicalizePath, registryPaths } from "@pi-context/protocol";
import { makeAttachmentStore } from "../src/attachment-store.js";
import { startRegistryServer } from "../src/registry-server.js";

describe("registry server", () => {
  it("publishes an authenticated health endpoint and cleans up", async () => {
    const userHome = await mkdtemp(join(tmpdir(), "pi-context-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "pi-context-cwd-"));
    const instanceId = randomUUID();
    const store = await Effect.runPromise(makeAttachmentStore(instanceId));
    const running = await Effect.runPromise(startRegistryServer(cwd, store, {
      userHome,
      instanceId,
      heartbeatIntervalMs: 10
    }));
    const instancePath = join(registryPaths(userHome).instances, `${instanceId}.json`);
    const initialRecord = JSON.parse(await readFile(instancePath, "utf8")) as { instanceId: string; lastActiveAt: string };
    assert.equal(initialRecord.instanceId, instanceId);
    const heartbeatDeadline = Date.now() + 1_000;
    let refreshedRecord = initialRecord;
    while (refreshedRecord.lastActiveAt === initialRecord.lastActiveAt && Date.now() < heartbeatDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      refreshedRecord = JSON.parse(await readFile(instancePath, "utf8")) as typeof initialRecord;
    }
    assert.notEqual(refreshedRecord.lastActiveAt, initialRecord.lastActiveAt);
    const unauthorized = await fetch(`http://127.0.0.1:${running.record.port}/v1/health`);
    assert.equal(unauthorized.status, 401);
    const response = await fetch(`http://127.0.0.1:${running.record.port}/v1/health`, {
      headers: { authorization: `Bearer ${running.record.token}` }
    });
    assert.equal(response.status, 200);

    const sourcePath = join(cwd, "source.ts");
    await writeFile(sourcePath, "const value = 1;", "utf8");
    const sourceAttachmentId = randomUUID();
    const mutation = await fetch(`http://127.0.0.1:${running.record.port}/v1/mutations`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${running.record.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        requestId: randomUUID(),
        type: "attachSelections",
        attachments: [{
          id: sourceAttachmentId,
          fileUri: pathToFileURL(sourcePath).toString(),
          displayPath: "client-value-is-reclassified",
          relationship: "outside",
          range: { start: { line: 1, column: 1 }, end: { line: 1, column: 17 } },
          text: "const value = 1;",
          languageId: "typescript",
          documentVersion: 1,
          dirty: false,
          capturedAt: new Date().toISOString()
        }]
      })
    });
    assert.equal(mutation.status, 200);
    const state = await mutation.json() as { attachments: Array<{ relationship: string; displayPath: string }> };
    assert.deepEqual(state.attachments.map(({ relationship, displayPath }) => ({ relationship, displayPath })), [
      { relationship: "inside", displayPath: "source.ts" }
    ]);

    const stateResponse = await fetch(`http://127.0.0.1:${running.record.port}/v1/state`, {
      headers: { authorization: `Bearer ${running.record.token}` }
    });
    assert.equal(stateResponse.status, 200);
    assert.deepEqual(
      (await stateResponse.json() as { attachments: Array<{ displayPath: string }> }).attachments.map(({ displayPath }) => displayPath),
      ["source.ts"]
    );

    await Effect.runPromise(store.consumeForPrompt([sourceAttachmentId]));
    const historyResponse = await fetch(`http://127.0.0.1:${running.record.port}/v1/state`, {
      headers: { authorization: `Bearer ${running.record.token}` }
    });
    const historyState = await historyResponse.json() as {
      attachments: unknown[];
      history: Array<{ historyId: string; attachment: { id: string; text: string } }>;
    };
    assert.equal(historyState.attachments.length, 0);
    assert.equal(historyState.history[0]?.attachment.id, sourceAttachmentId);

    const replay = await fetch(`http://127.0.0.1:${running.record.port}/v1/mutations`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${running.record.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        requestId: randomUUID(),
        type: "reattachHistory",
        historyId: historyState.history[0]?.historyId
      })
    });
    assert.equal(replay.status, 200);
    const replayState = await replay.json() as { attachments: Array<{ id: string; text: string }>; history: unknown[] };
    assert.equal(replayState.attachments[0]?.text, "const value = 1;");
    assert.notEqual(replayState.attachments[0]?.id, sourceAttachmentId);
    assert.equal(replayState.history.length, 1);

    const unauthorizedState = await fetch(`http://127.0.0.1:${running.record.port}/v1/state`);
    assert.equal(unauthorizedState.status, 401);

    const wrongVersion = await fetch(`http://127.0.0.1:${running.record.port}/v1/mutations`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${running.record.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ protocolVersion: 999, requestId: randomUUID(), type: "clearAttachments" })
    });
    assert.equal(wrongVersion.status, 400);
    assert.equal((await wrongVersion.json() as { error: { code: string } }).error.code, "VERSION_MISMATCH");
    await Effect.runPromise(running.close);
    await assert.rejects(readFile(instancePath, "utf8"), { code: "ENOENT" });
  });

  it("rejects a second live Pi for the same canonical directory", async () => {
    const userHome = await mkdtemp(join(tmpdir(), "pi-context-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "pi-context-cwd-"));
    const firstId = randomUUID();
    const first = await Effect.runPromise(startRegistryServer(cwd, await Effect.runPromise(makeAttachmentStore(firstId)), { userHome, instanceId: firstId }));
    try {
      const secondId = randomUUID();
      const result = await Effect.runPromise(Effect.either(startRegistryServer(cwd, await Effect.runPromise(makeAttachmentStore(secondId)), { userHome, instanceId: secondId })));
      assert.equal(result._tag, "Left");
      if (result._tag === "Left") assert.equal(result.left.code, "WORKING_DIRECTORY_BUSY");
    } finally {
      await Effect.runPromise(first.close);
    }
  });

  it("recovers a stale lease with no live instance", async () => {
    const userHome = await mkdtemp(join(tmpdir(), "pi-context-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "pi-context-cwd-"));
    const paths = registryPaths(userHome);
    await mkdir(paths.leases, { recursive: true });
    const canonical = await Effect.runPromise(canonicalizePath(cwd));
    const leasePath = join(paths.leases, `${createHash("sha256").update(canonical).digest("hex")}.json`);
    await writeFile(leasePath, JSON.stringify({
      protocolVersion: PROTOCOL_VERSION,
      instanceId: randomUUID(),
      canonicalWorkingDirectory: canonical,
      token: "stale"
    }), "utf8");
    const id = randomUUID();
    const running = await Effect.runPromise(startRegistryServer(cwd, await Effect.runPromise(makeAttachmentStore(id)), {
      userHome,
      instanceId: id
    }));
    assert.equal(running.record.instanceId, id);
    await Effect.runPromise(running.close);
  });
});
