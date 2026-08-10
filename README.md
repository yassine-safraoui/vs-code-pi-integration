# Pi Context for VS Code

Pi Context lets a VS Code user attach one or more editor selections to the next prompt accepted by a running [Pi](https://github.com/earendil-works/pi) coding-agent session. Pi's terminal remains the conversation UI; the VS Code extension only captures explicit source snapshots and routes them to a plugin-enabled Pi.

macOS and Windows are the primary targets. Development currently happens on macOS, while the shared path and registry tests run on both platforms in CI.

## Architecture

- `packages/protocol` contains the Effect schemas, limits, registry paths, and cross-platform containment rules.
- `pi-plugin` owns pending and previously used attachment state, the authenticated loopback server, working-directory lease, and prompt-time context injection.
- `vs-code-extension` discovers live Pi records, routes selections, and presents Pi's authoritative attachment state in an Activity Bar view.

Plugin-enabled Pis register under `~/.pi-context/run/v2`. Records contain an ephemeral loopback endpoint and token, never selected source. Pending and previously used source snapshots remain in Pi memory for the current session only.

While attachments are pending, Pi shows their paths and ranges in a widget above the prompt. `/pi-context` opens a keyboard-driven manager: Enter opens the captured selection in VS Code and `D` removes it.

The **Attachments** view in VS Code shows separate **Pending** and **Previously Used** sections for each live Pi. It fetches state using the authenticated `GET /v1/state` endpoint, and successful mutation responses replace that Pi's displayed state so the view never changes optimistically. Selecting an item opens its file and restores the captured range. Previously used items have an inline reattach action that restores the exact saved snapshot to pending state.

Only merged snapshots consumed by an accepted prompt enter history; deleting or clearing pending items does not. Explicitly replaying and sending a history item updates that entry and moves it to the top, while independent captures remain separate across prompts. Pi retains the newest 50 entries up to 1 MiB of attachment text per session.

Pi coalesces overlapping selections from the same file and document version. Reattaching an already pending range is a no-op; a partial overlap expands the existing attachment, including transitively across a batch. Ranges that only touch remain separate. If overlapping snapshots came from different document versions or disagree in their shared text, Pi rejects the batch so it never creates a misleading mixed snapshot.

## Development

```sh
pnpm install
pnpm check
pnpm test
pnpm build
```

`pnpm test` binds temporary loopback ports for registry/server tests. Use the **Run Pi Context Extension** launch configuration to open a VS Code Extension Development Host.

To load the Pi plugin while developing, build the workspace and start Pi in the directory it should own, passing the absolute plugin entrypoint:

```sh
pi --extension /absolute/path/to/vs-code-pi-integration/pi-plugin/src/index.ts
```

## Commands

- **Pi Context: Attach Editor Selection(s)** captures all non-empty selections in the active local-file editor.
- **Pi Context: Choose Target Pi** selects a live Pi to remember for this VS Code window or restores automatic routing.
- **Pi Context: Clear Pending Attachments** clears the remembered Pi, the sole live Pi, or a Pi selected from the picker.
- **Pi Context: Refresh Pending Attachments** re-discovers live Pis and fetches their authoritative attachment state.
- **Pi Context: Reattach Previously Used Attachment** is exposed as an inline and context-menu action on history items.

Files inside the chosen Pi working directory receive compact relative labels. Outside files are still attached using canonical absolute paths, followed by a non-blocking warning that later reads or edits may require authorization.

## Platform scope

The extension requires a local Node extension host and local `file:` documents. Remote SSH, WSL, containers, browser-hosted VS Code, and cross-machine forwarding are not part of v1.
