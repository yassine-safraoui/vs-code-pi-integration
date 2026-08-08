# VS Code ↔ Pi Context Attachments — Architecture 1

## Goal

Let a developer explicitly attach one or more editor selections to Pi's **next** prompt. This gives Pi the relevant source directly, avoiding exploratory file reads and their token cost. Pi's existing terminal UI remains the primary conversation UI; this project only augments it.

The compact UI representation is independent of selection size, for example `src/server.ts:18:1-64:2`. Pi expands the attachment to its captured source text only when it builds the eventual request.

## Scope of the first architecture

Two TypeScript components run locally:

```text
VS Code extension                         Pi plugin
─────────────────                         ─────────
read selection and metadata               owns pending attachments
  │                                       registers Pi commands/UI hooks
  └── loopback IPC ─────────────────────► expands attachments at prompt time
                                            emits authoritative state changes
```

- The VS Code extension provides `piContext.attachSelection` (with a default keybinding to be chosen during implementation). It captures a stable snapshot: workspace-relative path, start/end line and column, selected text, language ID, and a generated attachment ID.
- The Pi plugin is the sole authority for the pending-attachment set. It exposes a loopback-only IPC endpoint, authenticates each extension connection with an ephemeral token, accepts idempotent attachment mutations, and publishes state changes.
- The initial inspection variant is **1A**: Pi provides a command/overlay to list the authoritative attachments grouped by file. A richer VS Code attachment view (1B) is deliberately deferred until bidirectional state synchronization is implemented.
- Normal text entered in Pi must remain unchanged. The plugin will represent attachments as structured state/markers rather than trying to parse arbitrary user prose.
- On send, the plugin serializes the selected text into a clear, delimited context block followed by the user's normal prompt. It then clears or retains attachments only according to an explicit, observable lifecycle rule (initial proposal: clear after a successfully accepted user turn).

## Technology choices

- TypeScript with ESM package configuration.
- [`Effect`](https://effect.website/) is the application-effect and error-modeling library in **both** packages. Boundary operations—VS Code command handling, HTTP/IPC, attachment validation, state transitions, and Pi lifecycle hooks—will be represented as typed `Effect` programs rather than unstructured promises.
- The transport stays local. The implementation will bind only to loopback, avoid persisting source text outside Pi's memory/session data unless the user explicitly opts in, and never expose a remotely reachable service.

## Protocol contract (to implement before UI work)

Requests and events are versioned envelopes. Every mutation carries an attachment ID so retries are safe.

```text
Extension → Plugin: attachSelection { protocolVersion, attachment }
Plugin → Extension: attachmentState { revision, attachments }
Extension → Plugin: removeAttachment { attachmentId }
Extension → Plugin: clearAttachments {}
```

The plugin returns the complete authoritative state plus a monotonically increasing revision after every mutation. Future extension views must render only this acknowledged state—not optimistic local state that can drift after a Pi-side remove, clear, send, reload, or session change.

## Delivery sequence

1. Define shared protocol types and validation, then add focused tests for IDs, paths, ranges, payload limits, idempotency, and revision ordering.
2. Implement the loopback server in the Pi plugin with ephemeral-auth bootstrap/discovery and graceful shutdown/reload behavior.
3. Implement the VS Code command: reject empty selections, create a snapshot attachment, submit it, and display actionable connection/error messages.
4. Add Pi-side pending state, compact prompt markers, a `/pi-context` inspection command, and prompt-time expansion. Verify clear/send/retry lifecycle behavior.
5. Add a VS Code tree/webview attachment inspector only after protocol synchronization is complete; clicking a row opens, reveals, and selects its recorded range.
6. Consider Architecture 2 only after Architecture 1 validates that extension hooks can safely inject the required prompt context without fighting Pi's native editor model.

## Open questions / explicit validation gates

- Confirm Pi's current extension API provides a supported input interception/transform hook that can expand attachments immediately before the model request. Do not rely on private TUI/editor state.
- Confirm a Pi extension can safely host the selected local IPC transport for the life of an interactive session and can clean it up on reload/exit.
- Decide whether attachments are session-persistent, prompt-draft-persistent, or strictly in-memory. Source snapshots are more truthful than later rereads but may consume session storage and can contain sensitive code.
- Decide the lifecycle on a failed/cancelled model turn before clearing attachments.
- Determine the smallest payload/token limits and the UX for oversized or binary selections.
- Evaluate whether Pi's TUI supports clickable markers. This is an enhancement, not a dependency; `/pi-context` remains the reliable inspection surface.

## Non-goals for this phase

- A VS Code-native Pi chat client, model picker, streamed agent-event renderer, cancellation UI, or custom diff viewer (Architecture 2).
- Remote networking, cross-machine pairing, or unauthenticated listeners.
- Editing files or modifying Pi's core runtime.

