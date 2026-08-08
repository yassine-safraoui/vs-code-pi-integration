import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Effect } from "effect";
import { decodeVsCodeOpenAttachmentUri, type AttachmentSnapshot } from "@pi-context/protocol";
import { launchCommandForPlatform, openAttachmentInVsCode, type LaunchCommand } from "../src/vscode-opener.js";

const attachment: Pick<AttachmentSnapshot, "fileUri" | "range"> = {
  fileUri: "file:///Users/test/Project%20Name/src/value.ts",
  range: {
    start: { line: 7, column: 3 },
    end: { line: 11, column: 8 }
  }
};

describe("VS Code attachment opener", () => {
  it("uses the native URL launcher on macOS and Windows", () => {
    assert.equal(launchCommandForPlatform("vscode://test", "darwin").command, "/usr/bin/open");
    assert.equal(launchCommandForPlatform("vscode://test", "win32").command, "explorer.exe");
  });

  it("launches a URI containing the complete captured range", async () => {
    let launched: LaunchCommand | undefined;
    await Effect.runPromise(openAttachmentInVsCode(attachment, {
      platform: "darwin",
      launcher: async (command) => { launched = command; }
    }));
    assert.ok(launched);
    const request = await Effect.runPromise(decodeVsCodeOpenAttachmentUri(launched.args[0]!));
    assert.equal(request.fileUri, attachment.fileUri);
    assert.deepEqual(request.range, attachment.range);
  });
});
