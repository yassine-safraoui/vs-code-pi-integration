import { randomUUID } from "node:crypto";
import { Effect, Exit, Scope } from "effect";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PROTOCOL_VERSION, type AttachmentSnapshot } from "@pi-context/protocol";
import type { AttachmentStore } from "./attachment-store.js";
import { makeAttachmentStore } from "./attachment-store.js";
import { AttachmentManagerComponent } from "./attachment-manager.js";
import { attachmentWidgetLines, describeAttachments, renderAttachmentContext } from "./prompt.js";
import { startRegistryServer, type RunningRegistryServer } from "./registry-server.js";
import { openAttachmentInVsCode } from "./vscode-opener.js";
import {
  attachmentContextType,
  attachmentHistorySeedType,
  historySeed,
  reconstructAttachmentHistory
} from "./session-history.js";

const uiKey = "pi-context";

export default function piContextPlugin(pi: ExtensionAPI): void {
  let activeContext: ExtensionContext | undefined;
  let store: AttachmentStore | undefined;
  let running: RunningRegistryServer | undefined;
  let sessionScope: Scope.CloseableScope | undefined;
  let stagedAttachmentIds: ReadonlyArray<string> | undefined;

  const updateWidget = (attachments: ReadonlyArray<AttachmentSnapshot>): void => {
    activeContext?.ui.setWidget(
      uiKey,
      attachments.length > 0 ? [...attachmentWidgetLines(attachments)] : undefined,
      { placement: "aboveEditor" }
    );
  };

  pi.registerCommand("pi-context", {
    description: "Inspect or remove VS Code context attachments.",
    handler: async (args, ctx) => {
      if (!store) {
        ctx.ui.notify("Pi Context is unavailable in this session.", "warning");
        return;
      }
      const commandStore = store;
      const snapshot = await Effect.runPromise(commandStore.snapshot);
      if (args.trim() === "clear") {
        await Effect.runPromise(commandStore.apply({
          protocolVersion: PROTOCOL_VERSION,
          requestId: randomUUID(),
          type: "clearAttachments"
        }));
        ctx.ui.notify("Cleared pending Pi Context attachments.", "info");
        return;
      }
      if (snapshot.attachments.length === 0 || !ctx.hasUI) {
        ctx.ui.notify(describeAttachments(snapshot.attachments), "info");
        return;
      }
      await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new AttachmentManagerComponent(
        snapshot.attachments,
        theme,
        {
          remove: (attachmentId) => Effect.runPromise(commandStore.apply({
            protocolVersion: PROTOCOL_VERSION,
            requestId: randomUUID(),
            type: "removeAttachment",
            attachmentId
          })),
          open: (attachment) => Effect.runPromise(openAttachmentInVsCode(attachment)),
          close: () => done(undefined),
          requestRender: () => tui.requestRender()
        }
      ));
    }
  });

  pi.on("session_start", async (event, ctx) => {
    activeContext = ctx;
    ctx.ui.setStatus(uiKey, undefined);
    ctx.ui.setWidget(uiKey, undefined);
    stagedAttachmentIds = undefined;
    const instanceId = randomUUID();
    let history = reconstructAttachmentHistory(ctx.sessionManager.getBranch());
    if (event.reason === "new" && event.previousSessionFile) {
      try {
        history = reconstructAttachmentHistory(SessionManager.open(event.previousSessionFile).getBranch());
      } catch {
        history = [];
      }
      if (history.length > 0) pi.appendEntry(attachmentHistorySeedType, historySeed(history));
    }
    store = await Effect.runPromise(makeAttachmentStore(
      instanceId,
      (state) => updateWidget(state.attachments),
      { initialHistory: history }
    ));
    sessionScope = await Effect.runPromise(Scope.make());
    const acquired = startRegistryServer(ctx.cwd, store, { instanceId }).pipe(
      Effect.acquireRelease((server) => server.close),
      Effect.provideService(Scope.Scope, sessionScope),
      Effect.either
    );
    const result = await Effect.runPromise(acquired);
    if (result._tag === "Left") {
      ctx.ui.notify(`Pi Context could not start: ${result.left.message}`, "error");
      return;
    }
    running = result.right;
    updateWidget([]);
  });

  pi.on("session_before_switch", async (event, ctx) => {
    if (event.reason !== "new" || !store) return;
    const snapshot = await Effect.runPromise(store.snapshot);
    // Persist the active /tree leaf as the file's latest branch before Pi
    // replaces the session runtime. Reopening previousSessionFile during the
    // next session_start can then reconstruct the branch the user selected.
    pi.appendEntry(attachmentHistorySeedType, historySeed(snapshot.history));
  });

  pi.on("session_tree", async (_event, ctx) => {
    if (!store) return;
    await Effect.runPromise(store.replaceHistory(reconstructAttachmentHistory(ctx.sessionManager.getBranch())));
  });

  pi.on("input", async (event) => {
    if (!store || event.source !== "interactive" || event.streamingBehavior !== undefined) {
      return { action: "continue" };
    }
    const snapshot = await Effect.runPromise(store.snapshot);
    stagedAttachmentIds = snapshot.attachments.length > 0
      ? snapshot.attachments.map((attachment) => attachment.id)
      : undefined;
    return { action: "continue" };
  });

  pi.on("before_agent_start", async () => {
    if (!store || !stagedAttachmentIds?.length) return;
    const ids = stagedAttachmentIds;
    stagedAttachmentIds = undefined;
    const consumed = await Effect.runPromise(store.consumeForPrompt(ids));
    if (consumed.attachments.length === 0) return;
    return {
      message: {
        customType: attachmentContextType,
        content: renderAttachmentContext(consumed.attachments),
        display: false,
        details: { attachmentIds: ids, historyEntries: consumed.historyEntries }
      }
    };
  });

  pi.on("session_shutdown", async () => {
    activeContext?.ui.setStatus(uiKey, undefined);
    activeContext?.ui.setWidget(uiKey, undefined);
    activeContext = undefined;
    stagedAttachmentIds = undefined;
    running = undefined;
    store = undefined;
    if (sessionScope) {
      await Effect.runPromise(Scope.close(sessionScope, Exit.succeed(undefined)));
      sessionScope = undefined;
    }
  });
}
