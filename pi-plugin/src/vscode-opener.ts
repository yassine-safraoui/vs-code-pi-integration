import { spawn } from "node:child_process";
import { Data, Effect } from "effect";
import { createVsCodeOpenAttachmentUri, type AttachmentSnapshot, type SupportedPlatform } from "@pi-context/protocol";

export class VsCodeOpenFailure extends Data.TaggedError("VsCodeOpenFailure")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface LaunchCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

export const launchCommandForPlatform = (
  uri: string,
  platform: SupportedPlatform = process.platform as SupportedPlatform
): LaunchCommand => {
  if (platform === "darwin") return { command: "/usr/bin/open", args: [uri] };
  if (platform === "win32") return { command: "explorer.exe", args: [uri] };
  return { command: "xdg-open", args: [uri] };
};

export type DetachedLauncher = (command: LaunchCommand) => Promise<void>;

const launchDetached: DetachedLauncher = ({ command, args }) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.once("spawn", () => {
    child.unref();
    resolve();
  });
  child.once("error", reject);
});

export const openAttachmentInVsCode = (
  attachment: Pick<AttachmentSnapshot, "fileUri" | "range">,
  options: {
    readonly platform?: SupportedPlatform;
    readonly launcher?: DetachedLauncher;
  } = {}
): Effect.Effect<void, VsCodeOpenFailure> => {
  const uri = createVsCodeOpenAttachmentUri(attachment);
  const command = launchCommandForPlatform(uri, options.platform);
  return Effect.tryPromise({
    try: () => (options.launcher ?? launchDetached)(command),
    catch: (cause) => new VsCodeOpenFailure({
      message: "Could not ask VS Code to open this attachment.",
      cause
    })
  });
};
