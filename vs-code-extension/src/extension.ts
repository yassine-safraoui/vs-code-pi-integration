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
import { AttachmentTreeProvider } from "./attachments-tree.js";
import { AttachmentGutter } from "./attachment-gutter.js";

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
  const instances = yield* discoverPis;
  yield* Effect.sync(() => {
    if (rememberedInstanceId && !instances.some((pi) => pi.record.instanceId === rememberedInstanceId)) {
      rememberedInstanceId = undefined;
    }
  });
  return instances;
});

const healthyInstances = (): Promise<ReadonlyArray<LivePi>> => runtime.runPromise(discoverHealthyPis);

const refreshAttachmentState = Effect.gen(function* () {
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
  });
});

const chooseTargetCommand = async (): Promise<void> => {
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
      await vscode.window.showInformationMessage(`Pi Context target: ${selected.record.canonicalWorkingDirectory}`);
    }
  } catch (cause) {
    await showFailure(cause);
  }
};

const attachSelectionsCommand = async (): Promise<void> => {
  try {
    const selections = await runtime.runPromise(captureSelections());
    const instances = await healthyInstances();
    const decision = routeToPi(instances, selections.map((selection) => selection.canonicalFilePath), rememberedInstanceId);
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

const refreshAttachmentsCommand = async (): Promise<void> => {
  try {
    await runtime.runPromise(refreshAttachmentState);
  } catch (cause) {
    await showFailure(cause);
  }
};

export function activate(context: vscode.ExtensionContext): void {
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
    vscode.commands.registerCommand("piContext.openAttachment", openAttachmentCommand),
    vscode.window.registerUriHandler({ handleUri: handleExtensionUri }),
    treeView,
    treeView.onDidChangeVisibility(({ visible }) => {
      if (visible) void refreshAttachmentsCommand();
    }),
    attachmentTree,
    attachmentGutter,
    { dispose: () => { void runtime.dispose(); } }
  );
  if (treeView.visible) void refreshAttachmentsCommand();
}

export function deactivate(): Thenable<void> {
  return runtime.dispose();
}
