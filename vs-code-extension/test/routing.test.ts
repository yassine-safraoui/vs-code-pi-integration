import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PROTOCOL_VERSION, type DiscoveryRecord } from "@pi-context/protocol";
import { routeToPi } from "../src/routing.js";
import type { LivePi } from "../src/discovery.js";

const pi = (id: string, cwd: string): LivePi => {
  const record: DiscoveryRecord = {
    protocolVersion: PROTOCOL_VERSION,
    instanceId: id,
    canonicalWorkingDirectory: cwd,
    pid: 100,
    startedAt: "2026-08-08T12:00:00.000Z",
    lastActiveAt: new Date().toISOString(),
    host: "127.0.0.1",
    port: 12345,
    token: "secret"
  };
  return { record, health: { protocolVersion: PROTOCOL_VERSION, instanceId: id, canonicalWorkingDirectory: cwd, pendingCount: 0 } };
};

describe("routeToPi", () => {
  it("chooses the deepest containing Pi", () => {
    const decision = routeToPi([pi("00000000-0000-4000-8000-000000000001", "/repo"), pi("00000000-0000-4000-8000-000000000002", "/repo/pkg")], ["/repo/pkg/src/a.ts"]);
    assert.equal(decision._tag, "target");
    if (decision._tag === "target") assert.equal(decision.target.record.canonicalWorkingDirectory, "/repo/pkg");
  });

  it("prefers a remembered containing Pi", () => {
    const root = pi("00000000-0000-4000-8000-000000000001", "/repo");
    const nested = pi("00000000-0000-4000-8000-000000000002", "/repo/pkg");
    const decision = routeToPi([root, nested], ["/repo/pkg/src/a.ts"], root.record.instanceId);
    assert.equal(decision._tag, "target");
    if (decision._tag === "target") assert.equal(decision.target.record.instanceId, root.record.instanceId);
  });

  it("requires a picker for selections owned by different Pi roots", () => {
    const decision = routeToPi(
      [pi("00000000-0000-4000-8000-000000000001", "/a"), pi("00000000-0000-4000-8000-000000000002", "/b")],
      ["/a/one.ts", "/b/two.ts"]
    );
    assert.deepEqual({ tag: decision._tag, mixed: decision._tag === "pick" && decision.mixedRoots }, { tag: "pick", mixed: true });
  });
});
