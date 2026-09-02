import { randomUUID } from "node:crypto";
import { Effect, Layer, ManagedRuntime } from "effect";
import * as vscode from "vscode";
import {
  PROTOCOL_VERSION,
  ProtocolFailure,
  decodeVsCodeOpenAttachmentUri,
  type AttachmentSnapshot,
  type Mutation,
  type OpenAttachmentRequest
} from "@pi-context/protocol";
import {
  DiscoveryLive,
  PiClientLive,
  clearMutation,
  discoverPis,
  healthCheckPi,
  getPiState,
  mutatePi,
  type LivePi
} from "./discovery.js";
import { routeToPi } from "./routing.js";
import { captureSelections, snapshotsForTarget } from "./selection.js";
import { AttachmentTreeProvider, type HistoryAttachmentNode } from "./attachments-tree.js";
import { AttachmentGutter } from "./attachment-gutter.js";
import {
  configurePiContextOutput,
  logError,
  logInfo,
  logWarning,
  showPiContextOutput
} from "./logging.js";

interface PiPickItem extends vscode.QuickPickItem {
  readonly pi?: LivePi;
  readonly automatic?: true;
}

const AppLive = Layer.merge(DiscoveryLive(), PiClientLive);
const runtime = ManagedRuntime.make(AppLive);
let rememberedInstanceId: string | undefined;
let attachmentTree: AttachmentTreeProvider | undefined;
let attachmentGutter: AttachmentGutter | undefined;

const showFailure = async (cause: unknown): Promise<void> => {
  const message = cause instanceof ProtocolFailure || cause instanceof Error
    ? cause.message
    : "Pi Context failed unexpectedly.";
  logError("ui.operation.failure", cause);
  await vscode.window.showWarningMessage(message);
};

const piItems = (instances: ReadonlyArray<LivePi>): PiPickItem[] => instances.map((pi) => ({
  label: pi.record.canonicalWorkingDirectory,
  description: `${pi.record.instanceId === rememberedInstanceId ? "$(check) remembered · " : ""}${pi.health.pendingCount} pending`,
  detail: `PID ${pi.record.pid} · started ${new Date(pi.record.startedAt).toLocaleString()}`,
  pi
}));

const choosePi = async (
  instances: ReadonlyArray<LivePi>,
  options: { readonly allowAutomatic: boolean; readonly placeHolder: string }
): Promise<LivePi | undefined> => {
  const items: PiPickItem[] = options.allowAutomatic
    ? [{ label: "$(sync) Automatic routing", detail: "Clear the remembered Pi target.", automatic: true }, ...piItems(instances)]
    : piItems(instances);
  const selected = await vscode.window.showQuickPick(items, { placeHolder: options.placeHolder });
  if (!selected) return undefined;
  if (selected.automatic) {
    rememberedInstanceId = undefined;
    await vscode.window.showInformationMessage("Pi Context will choose targets automatically.");
    return undefined;
  }
  if (!selected.pi) return undefined;
  await runtime.runPromise(healthCheckPi(selected.pi.record));
  return selected.pi;
};

const discoverHealthyPis = Effect.gen(function* () {
  yield* Effect.sync(() => logInfo("extension.discovery.requested", { rememberedInstanceId }));
  const instances = yield* discoverPis;
  yield* Effect.sync(() => {
    if (rememberedInstanceId && !instances.some((pi) => pi.record.instanceId === rememberedInstanceId)) {
      logWarning("extension.routing.remembered_instance_gone", { rememberedInstanceId });
      rememberedInstanceId = undefined;
    }
    logInfo("extension.discovery.completed", {
      liveInstances: instances.length,
      instances: instances.map(({ record }) => ({
        instanceId: record.instanceId,
        cwd: record.canonicalWorkingDirectory,
        pid: record.pid,
        port: record.port
      }))
    });
  });
  return instances;
});

const healthyInstances = (): Promise<ReadonlyArray<LivePi>> => runtime.runPromise(discoverHealthyPis);

const refreshAttachmentState = Effect.gen(function* () {
  yield* Effect.sync(() => logInfo("extension.refresh.start"));
  const instances = yield* discoverHealthyPis;
  const states = yield* Effect.all(
    instances.map((pi) => getPiState(pi.record).pipe(
      Effect.map((state) => ({ record: pi.record, state }))
    )),
    { concurrency: "unbounded" }
  );
  yield* Effect.sync(() => {
    attachmentTree?.replaceStates(states);
    attachmentGutter?.replaceStates(states.map(({ state }) => state));
    logInfo("extension.refresh.complete", {
      instances: states.length,
      pendingAttachments: states.reduce((sum, { state }) => sum + state.attachments.length, 0)
    });
  });
});

const chooseTargetCommand = async (): Promise<void> => {
  logInfo("command.choose_target.start");
  try {
    const instances = await healthyInstances();
    if (instances.length === 0) {
      await vscode.window.showWarningMessage("No running Pi with the Pi Context plugin was discovered.");
      return;
    }
    const selected = await choosePi(instances, {
      allowAutomatic: true,
      placeHolder: "Choose the Pi that should receive future context attachments"
    });
    if (selected) {
      rememberedInstanceId = selected.record.instanceId;
      logInfo("command.choose_target.selected", {
        instanceId: selected.record.instanceId,
        cwd: selected.record.canonicalWorkingDirectory
      });
      await vscode.window.showInformationMessage(`Pi Context target: ${selected.record.canonicalWorkingDirectory}`);
    }
  } catch (cause) {
    await showFailure(cause);
  }
};

const attachSelectionsCommand = async (): Promise<void> => {
  logInfo("command.attach.start");
  try {
    const selections = await runtime.runPromise(captureSelections());
    logInfo("command.attach.selections_captured", {
      selectionCount: selections.length,
      fileCount: new Set(selections.map(({ canonicalFilePath }) => canonicalFilePath)).size
    });
    const instances = await healthyInstances();
    const decision = routeToPi(instances, selections.map((selection) => selection.canonicalFilePath), rememberedInstanceId);
    logInfo("command.attach.route_decision", {
      decision: decision._tag,
      ...(decision._tag === "target" ? {
        instanceId: decision.target.record.instanceId,
        cwd: decision.target.record.canonicalWorkingDirectory
      } : {}),
      ...(decision._tag === "pick" ? {
        candidates: decision.candidates.length,
        mixedRoots: decision.mixedRoots
      } : {})
    });
    if (decision._tag === "none") {
      await vscode.window.showWarningMessage("No running Pi with the Pi Context plugin was discovered.");
      return;
    }
    const target = decision._tag === "target"
      ? decision.target
      : await choosePi(decision.candidates, {
          allowAutomatic: false,
          placeHolder: decision.mixedRoots
            ? "Selections span Pi working folders; choose one destination"
            : "Choose the Pi that should receive these selections"
        });
    if (!target) return;
    logInfo("command.attach.target", {
      instanceId: target.record.instanceId,
      cwd: target.record.canonicalWorkingDirectory
    });
    const attachments = snapshotsForTarget(selections, target.record.canonicalWorkingDirectory);
    const mutation: Mutation = {
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      type: "attachSelections",
      attachments
    };
    const state = await runtime.runPromise(mutatePi(target.record, mutation));
    attachmentTree?.acceptState(target.record, state);
    attachmentGutter?.acceptState(state);
    rememberedInstanceId = target.record.instanceId;
    logInfo("command.attach.success", {
      instanceId: state.instanceId,
      attachedCount: attachments.length,
      pendingCount: state.attachments.length,
      revision: state.revision
    });
    await vscode.window.showInformationMessage(
      `Attached ${attachments.length} selection${attachments.length === 1 ? "" : "s"} to Pi in ${target.record.canonicalWorkingDirectory} (${state.attachments.length} pending).`
    );
    if (attachments.some((attachment) => attachment.relationship === "outside")) {
      await vscode.window.showWarningMessage(
        `Some attached files are outside ${target.record.canonicalWorkingDirectory}; later reads or edits may require authorization.`
      );
    }
  } catch (cause) {
    await showFailure(cause);
  }
};

const clearAttachmentsCommand = async (): Promise<void> => {
  logInfo("command.clear.start");
  try {
    const instances = await healthyInstances();
    if (instances.length === 0) {
      await vscode.window.showWarningMessage("No running Pi with the Pi Context plugin was discovered.");
      return;
    }
    const remembered = instances.find((pi) => pi.record.instanceId === rememberedInstanceId);
    const target = remembered ?? (instances.length === 1
      ? instances[0]
      : await choosePi(instances, { allowAutomatic: false, placeHolder: "Choose the Pi whose attachments should be cleared" }));
    if (!target) return;
    const state = await runtime.runPromise(mutatePi(target.record, clearMutation()));
    attachmentTree?.acceptState(target.record, state);
    attachmentGutter?.acceptState(state);
    logInfo("command.clear.success", {
      instanceId: state.instanceId,
      cwd: target.record.canonicalWorkingDirectory,
      revision: state.revision
    });
    await vscode.window.showInformationMessage(`Cleared Pi Context attachments in ${target.record.canonicalWorkingDirectory}.`);
  } catch (cause) {
    await showFailure(cause);
  }
};

export const openAttachmentRequest = async (request: OpenAttachmentRequest): Promise<void> => {
  const fileUri = vscode.Uri.parse(request.fileUri, true);
  if (fileUri.scheme !== "file") {
    throw new ProtocolFailure({ code: "INVALID_ATTACHMENT", message: "Only local file attachments can be opened." });
  }
  const document = await vscode.workspace.openTextDocument(fileUri);
  const capturedRange = new vscode.Range(
    request.range.start.line - 1,
    request.range.start.column - 1,
    request.range.end.line - 1,
    request.range.end.column - 1
  );
  const selectionRange = document.validateRange(capturedRange);
  try {
    const editor = await vscode.window.showTextDocument(document, {
      preview: false,
      selection: selectionRange
    });
    editor.selection = new vscode.Selection(selectionRange.start, selectionRange.end);
    editor.revealRange(selectionRange, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  } catch {
    const firstPosition = selectionRange.start;
    await vscode.window.showTextDocument(document, {
      preview: false,
      selection: new vscode.Range(firstPosition, firstPosition)
    });
  }
};

export const handleExtensionUri = async (uri: vscode.Uri): Promise<void> => {
  try {
    // Preserve the already-percent-encoded query. Calling toString() without
    // skipEncoding turns `%3A` in the nested file URI into `%253A`.
    const request = await Effect.runPromise(decodeVsCodeOpenAttachmentUri(uri.toString(true)));
    await openAttachmentRequest(request);
  } catch (cause) {
    await showFailure(cause);
  }
};

const openAttachmentCommand = async (attachment: AttachmentSnapshot): Promise<void> => {
  try {
    await openAttachmentRequest({
      protocolVersion: PROTOCOL_VERSION,
      fileUri: attachment.fileUri,
      range: attachment.range
    });
  } catch (cause) {
    await showFailure(cause);
  }
};

const reattachHistoryCommand = async (node: HistoryAttachmentNode): Promise<void> => {
  logInfo("command.reattach.start", {
    instanceId: node.record.instanceId,
    cwd: node.record.canonicalWorkingDirectory
  });
  try {
    const state = await runtime.runPromise(mutatePi(node.record, {
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      type: "reattachHistory",
      historyId: node.entry.historyId
    }));
    attachmentTree?.acceptState(node.record, state);
    attachmentGutter?.acceptState(state);
    rememberedInstanceId = node.record.instanceId;
    logInfo("command.reattach.success", {
      instanceId: state.instanceId,
      pendingCount: state.attachments.length,
      revision: state.revision
    });
    await vscode.window.showInformationMessage(
      `Reattached ${node.entry.attachment.displayPath} to Pi in ${node.record.canonicalWorkingDirectory} (${state.attachments.length} pending).`
    );
  } catch (cause) {
    await showFailure(cause);
  }
};

const refreshAttachmentsCommand = async (): Promise<void> => {
  logInfo("command.refresh.start");
  try {
    await runtime.runPromise(refreshAttachmentState);
  } catch (cause) {
    await showFailure(cause);
  }
};

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Pi Context");
  configurePiContextOutput(output);
  logInfo("extension.activate", {
    extensionVersion: context.extension.packageJSON.version,
    extensionPath: context.extensionUri.fsPath,
    protocolVersion: PROTOCOL_VERSION,
    platform: process.platform,
    architecture: process.arch
  });
  attachmentTree = new AttachmentTreeProvider();
  attachmentGutter = new AttachmentGutter(vscode.Uri.joinPath(context.extensionUri, "media", "attached-range.svg"));
  const treeView = vscode.window.createTreeView("piContext.attachments", {
    treeDataProvider: attachmentTree,
    showCollapseAll: true
  });
  context.subscriptions.push(
    vscode.commands.registerCommand("piContext.attachSelections", attachSelectionsCommand),
    vscode.commands.registerCommand("piContext.chooseTarget", chooseTargetCommand),
    vscode.commands.registerCommand("piContext.clearAttachments", clearAttachmentsCommand),
    vscode.commands.registerCommand("piContext.refreshAttachments", refreshAttachmentsCommand),
    vscode.commands.registerCommand("piContext.showLogs", () => {
      logInfo("command.show_logs");
      showPiContextOutput();
    }),
    vscode.commands.registerCommand("piContext.openAttachment", openAttachmentCommand),
    vscode.commands.registerCommand("piContext.reattachHistory", reattachHistoryCommand),
    vscode.window.registerUriHandler({ handleUri: handleExtensionUri }),
    treeView,
    treeView.onDidChangeVisibility(({ visible }) => {
      if (visible) void refreshAttachmentsCommand();
    }),
    attachmentTree,
    attachmentGutter,
    output,
    { dispose: () => { void runtime.dispose(); } }
  );
  if (treeView.visible) void refreshAttachmentsCommand();
}

export function deactivate(): Thenable<void> {
  logInfo("extension.deactivate");
  return runtime.dispose();
}
