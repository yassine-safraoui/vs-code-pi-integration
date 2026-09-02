import { randomUUID } from "node:crypto";
import { Effect, Exit, Scope } from "effect";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  PROTOCOL_VERSION,
  type AttachmentSnapshot,
  type ConversationRef
} from "@pi-context/protocol";
import type { AttachmentStore } from "./attachment-store.js";
import { makeAttachmentStore } from "./attachment-store.js";
import { AttachmentManagerComponent } from "./attachment-manager.js";
import {
  injectAttachmentContextBeforePrompt,
  type PinnedAttachmentContext
} from "./agent-context.js";
import { attachmentWidgetLines, describeAttachments, renderAttachmentContext } from "./prompt.js";
import { startRegistryServer, type RunningRegistryServer } from "./registry-server.js";
import { openAttachmentInVsCode } from "./vscode-opener.js";
import {
  attachmentHistoryDeltaType,
  attachmentHistorySeedType,
  historyDelta,
  historySeed,
  reconstructAttachmentHistory
} from "./session-history.js";
import { getProcessConversationCache } from "./conversation-cache.js";
import {
  activeConversation,
  conversationTitle,
  isSessionResumable,
  promoteConversation,
  resolveConversation
} from "./conversation.js";
import { makeTerminalLogger } from "./logging.js";

const uiKey = "pi-context";

export default function piContextPlugin(pi: ExtensionAPI): void {
  const logger = makeTerminalLogger();
  const conversationCache = getProcessConversationCache();
  let activeContext: ExtensionContext | undefined;
  let activeConversationRef: ConversationRef = { kind: "new" };
  let startedAsFork = false;
  let store: AttachmentStore | undefined;
  let running: RunningRegistryServer | undefined;
  let sessionScope: Scope.CloseableScope | undefined;
  let stagedAttachmentIds: ReadonlyArray<string> | undefined;
  let pinnedAttachmentContext: PinnedAttachmentContext | undefined;

  logger.info("extension.loaded", { protocolVersion: PROTOCOL_VERSION, pid: process.pid });

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
    logger.info("session.start", {
      reason: event.reason,
      cwd: ctx.cwd,
      previousSessionFilePresent: event.previousSessionFile !== undefined
    });
    activeContext = ctx;
    ctx.ui.setStatus(uiKey, undefined);
    ctx.ui.setWidget(uiKey, undefined);
    stagedAttachmentIds = undefined;
    pinnedAttachmentContext = undefined;
    activeConversationRef = resolveConversation(event.reason, ctx.sessionManager);
    startedAsFork = event.reason === "fork";
    const checkpoint = startedAsFork ? undefined : conversationCache.peek(activeConversationRef);
    logger.info("session.identity_resolved", {
      reason: event.reason,
      conversationKind: activeConversationRef.kind,
      ...(activeConversationRef.kind === "session" ? { sessionId: activeConversationRef.sessionId } : {}),
      restoredPendingCount: checkpoint?.pending.length ?? 0,
      forkStartsEmpty: startedAsFork
    });
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
      {
        initialHistory: history,
        initialPending: checkpoint?.pending,
        conversationState: () => ({
          activeConversation: activeConversation(activeConversationRef, ctx.sessionManager),
          inactiveConversations: conversationCache.summaries(activeConversationRef)
        })
      }
    ));
    logger.info("session.store_ready", {
      instanceId,
      pendingCount: checkpoint?.pending.length ?? 0,
      historyCount: history.length
    });
    sessionScope = await Effect.runPromise(Scope.make());
    const acquired = startRegistryServer(ctx.cwd, store, { instanceId, logger }).pipe(
      Effect.acquireRelease((server) => server.close),
      Effect.provideService(Scope.Scope, sessionScope),
      Effect.either
    );
    const result = await Effect.runPromise(acquired);
    if (result._tag === "Left") {
      logger.error("session.registry_failed", result.left, {
        instanceId,
        cwd: ctx.cwd,
        code: result.left.code
      });
      ctx.ui.notify(`Pi Context could not start: ${result.left.message}`, "error");
      return;
    }
    running = result.right;
    logger.info("session.registry_ready", {
      instanceId,
      cwd: running.record.canonicalWorkingDirectory,
      host: running.record.host,
      port: running.record.port,
      protocolVersion: running.record.protocolVersion
    });
    if (startedAsFork) conversationCache.prune();
    else conversationCache.take(activeConversationRef);
    const evicted = conversationCache.drainEvictionNotices();
    if (evicted.length > 0) {
      logger.warn("session.cache_evicted", { conversationCount: evicted.length });
      ctx.ui.notify(
        `Pi Context discarded inactive pending attachments for ${evicted.join(", ")} to stay within its memory limit.`,
        "warning"
      );
    }
    updateWidget(checkpoint?.pending.map(({ attachment }) => attachment) ?? []);
  });

  pi.on("session_before_switch", async (event, ctx) => {
    logger.info("session.before_switch", {
      reason: event.reason,
      targetSessionFilePresent: event.targetSessionFile !== undefined
    });
    if (event.reason !== "new" || !store) return;
    const snapshot = await Effect.runPromise(store.snapshot);
    // Persist the active /tree leaf as the file's latest branch before Pi
    // replaces the session runtime. Reopening previousSessionFile during the
    // next session_start can then reconstruct the branch the user selected.
    pi.appendEntry(attachmentHistorySeedType, historySeed(snapshot.history));
  });

  pi.on("session_tree", async (_event, ctx) => {
    if (!store) return;
    const history = reconstructAttachmentHistory(ctx.sessionManager.getBranch());
    await Effect.runPromise(store.replaceHistory(history));
    logger.info("session.tree_changed", { historyCount: history.length });
  });

  pi.on("input", async (event) => {
    if (!store || event.source !== "interactive" || event.streamingBehavior !== undefined) {
      return { action: "continue" };
    }
    const snapshot = await Effect.runPromise(store.snapshot);
    pinnedAttachmentContext = undefined;
    stagedAttachmentIds = snapshot.attachments.length > 0
      ? snapshot.attachments.map((attachment) => attachment.id)
      : undefined;
    logger.info("prompt.attachments_staged", { pendingCount: stagedAttachmentIds?.length ?? 0 });
    return { action: "continue" };
  });

  pi.on("before_agent_start", async (event) => {
    if (!store || !stagedAttachmentIds?.length) return;
    const ids = stagedAttachmentIds;
    stagedAttachmentIds = undefined;
    const consumed = await Effect.runPromise(store.consumeForPrompt(ids));
    if (consumed.attachments.length === 0) return;
    logger.info("prompt.attachments_consumed", {
      requestedCount: ids.length,
      consumedCount: consumed.attachments.length,
      historyDeltaCount: consumed.historyEntries.length
    });
    pi.appendEntry(attachmentHistoryDeltaType, historyDelta(consumed.historyEntries));
    pinnedAttachmentContext = {
      prompt: event.prompt,
      content: renderAttachmentContext(consumed.attachments)
    };
  });

  pi.on("context", (event) => {
    if (!pinnedAttachmentContext) return;
    return {
      messages: injectAttachmentContextBeforePrompt(event.messages, pinnedAttachmentContext)
    };
  });

  pi.on("agent_settled", (_event, ctx) => {
    pinnedAttachmentContext = undefined;
    const previousKind = activeConversationRef.kind;
    activeConversationRef = promoteConversation(activeConversationRef, ctx.sessionManager);
    logger.info("session.agent_settled", {
      previousConversationKind: previousKind,
      conversationKind: activeConversationRef.kind,
      ...(activeConversationRef.kind === "session" ? { sessionId: activeConversationRef.sessionId } : {})
    });
  });

  pi.on("session_shutdown", async (event, ctx) => {
    logger.info("session.shutdown.start", { reason: event.reason, registryRunning: running !== undefined });
    if (store && event.reason !== "quit") {
      activeConversationRef = promoteConversation(activeConversationRef, ctx.sessionManager);
      const dropUnresumableFork = startedAsFork && !isSessionResumable(ctx.sessionManager);
      if (!dropUnresumableFork) {
        const pending = await Effect.runPromise(store.checkpointPending);
        conversationCache.save(
          activeConversationRef,
          conversationTitle(activeConversationRef, ctx.sessionManager),
          pending
        );
        logger.info("session.checkpoint_saved", {
          conversationKind: activeConversationRef.kind,
          ...(activeConversationRef.kind === "session" ? { sessionId: activeConversationRef.sessionId } : {}),
          pendingCount: pending.length
        });
      } else {
        logger.info("session.checkpoint_dropped", { reason: "unresumable_fork" });
      }
    }
    activeContext?.ui.setStatus(uiKey, undefined);
    activeContext?.ui.setWidget(uiKey, undefined);
    activeContext = undefined;
    stagedAttachmentIds = undefined;
    pinnedAttachmentContext = undefined;
    startedAsFork = false;
    running = undefined;
    store = undefined;
    if (sessionScope) {
      await Effect.runPromise(Scope.close(sessionScope, Exit.succeed(undefined)));
      sessionScope = undefined;
    }
    logger.info("session.shutdown.complete", { reason: event.reason });
  });
}
