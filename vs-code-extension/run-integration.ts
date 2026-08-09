import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";

const here = dirname(fileURLToPath(import.meta.url));
const userDataDir = await mkdtemp(join(tmpdir(), "pi-ctx-vscode-"));
const extensionsDir = await mkdtemp(join(tmpdir(), "pi-ctx-exts-"));

try {
  await runTests({
    extensionDevelopmentPath: resolve(here, ".."),
    extensionTestsPath: resolve(here, "integration/index.js"),
    launchArgs: [
      "--disable-extensions",
      `--user-data-dir=${userDataDir}`,
      `--extensions-dir=${extensionsDir}`
    ]
  });
} finally {
  await rm(userDataDir, { recursive: true, force: true });
  await rm(extensionsDir, { recursive: true, force: true });
}
