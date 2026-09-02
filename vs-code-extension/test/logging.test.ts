import assert from "node:assert/strict";
import test from "node:test";
import {
  configurePiContextOutput,
  logError,
  logInfo,
  showPiContextOutput
} from "../src/logging.js";

test("Pi Context output logs diagnostics while redacting sensitive fields", () => {
  const lines: string[] = [];
  let shown = false;
  configurePiContextOutput({
    appendLine: (line) => lines.push(line),
    show: (preserveFocus) => { shown = preserveFocus === true; }
  });

  logInfo("discovery.test", {
    cwd: "C:\\repo",
    token: "registry-secret",
    authorization: "Bearer secret",
    attachmentText: "selected source"
  });
  logError("discovery.failure", new Error("connection refused"));
  showPiContextOutput();

  assert.equal(shown, true);
  assert.match(lines[0] ?? "", /discovery\.test/);
  assert.match(lines[0] ?? "", /C:\\\\repo/);
  assert.doesNotMatch(lines.join("\n"), /registry-secret|Bearer secret|selected source/);
  assert.equal((lines[0]?.match(/\[redacted\]/g) ?? []).length, 3);
  assert.match(lines[1] ?? "", /connection refused/);
});
