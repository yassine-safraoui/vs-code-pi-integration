# VS Code ↔ Pi Context Bridge — Implemented Architecture

## Status

Architecture 1 is implemented as a pnpm workspace with a shared Effect-schema protocol, an authenticated Pi loopback plugin, and a bundled VS Code extension. macOS and Windows are the primary platforms; development is currently performed on macOS and CI covers both operating systems.

## Runtime flow

1. A plugin-enabled Pi canonicalizes its working directory, claims its per-directory lease, binds `127.0.0.1` on an ephemeral port, and publishes a token-authenticated record under `~/.pi-context/run/v1/instances`.
2. A VS Code command enumerates and health-checks those records. The selected files are compared against live Pi working directories independently of VS Code's workspace configuration.
3. The extension routes to the remembered containing Pi, the only/deepest containing Pi, or a user-selected Pi when routing is ambiguous. Outside files remain attachable and are clearly marked.
4. Pi keeps snapshots in memory. Its `input` hook stages the current IDs; `before_agent_start` pins and consumes their exact snapshots, and the `context` hook injects their TOON encoding transiently immediately before the user's prompt for every model call in that run. `agent_settled` clears the pin so attachment text is not persisted into later turns.
5. Pi shutdown, reload, session replacement, and fork close the listener and remove only the current instance's registry record and lease.

## Supported scope

- Local macOS and Windows VS Code Node extension hosts.
- Single, multiple, nested, or unrelated Pi working directories.
- Folder, multi-root, loose-file, and workspace-less VS Code windows.
- Multiple selections from one active local-file editor, sent atomically.
- Command-palette target selection and per-window in-memory target remembrance.

Remote extension hosts, WSL, containers, browser VS Code, cross-machine forwarding, and persistent pending attachments remain deferred. The VS Code attachment tree is now implemented as a projection of Pi's authenticated state endpoint and mutation responses.
