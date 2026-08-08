import { Effect } from "effect";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const pluginName = "pi-context";

/**
 * Architecture 1 entrypoint. Pi loads TypeScript extension modules directly.
 * Transport, authoritative attachment state, and prompt-time expansion are
 * deliberately deferred to the implementation stages in ../PLAN.md.
 */
export default function piContextPlugin(pi: ExtensionAPI): void {
  pi.registerCommand("pi-context", {
    description: "Show the status of the VS Code context-attachment integration.",
    handler: async (_args, ctx) => {
      const message = Effect.runSync(
        Effect.succeed("Pi Context is scaffolded; attachment IPC has not been implemented yet.")
      );
      ctx.ui.notify(message, "info");
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus(pluginName, "Pi Context: scaffolded");
  });
}
