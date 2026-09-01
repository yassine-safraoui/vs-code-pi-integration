# VS Code ↔ Pi Context Bridge — Implemented Architecture

## Status

Architecture 1 is implemented as a pnpm workspace with a shared Effect-schema protocol, an authenticated Pi loopback plugin, and a bundled VS Code extension. macOS and Windows are the primary platforms; development is currently performed on macOS and CI covers both operating systems.

## Runtime flow

1. A plugin-enabled Pi canonicalizes its working directory, claims its per-directory lease, binds `127.0.0.1` on an ephemeral port, and publishes a token-authenticated record under `~/.pi-context/run/v3/instances`. It refreshes the record heartbeat every five minutes.
2. A VS Code command rejects heartbeats that are at least six minutes old, then health-checks the remaining records. The selected files are compared against live Pi working directories independently of VS Code's workspace configuration.
3. The extension routes to the remembered containing Pi, the only/deepest containing Pi, or a user-selected Pi when routing is ambiguous. Outside files remain attachable and are clearly marked.
4. Pi keeps pending snapshots in memory and reconstructs previously used history from validated, non-context session metadata. Its `input` hook stages the current IDs; `before_agent_start` atomically records the merged snapshots in history, persists only the compact history delta, pins their TOON encoding, and removes them from pending state. The `context` hook injects that encoding transiently immediately before the user's prompt for every model call in the run, and `agent_settled` clears the pin. `/new` seeds the new thread with the previous thread's history, while `/resume` and `/tree` reconstruct the selected thread or branch.
5. Pi shutdown, reload, session replacement, and fork close the listener and remove only the current instance's registry record and lease.

## Supported scope

- Local macOS and Windows VS Code Node extension hosts.
- Single, multiple, nested, or unrelated Pi working directories.
- Folder, multi-root, loose-file, and workspace-less VS Code windows.
- Multiple selections from one active local-file editor, sent atomically.
- Command-palette target selection and per-window in-memory target remembrance.

Remote extension hosts, WSL, containers, browser VS Code, and cross-machine forwarding remain deferred. The VS Code attachment tree is a projection of Pi's authenticated state endpoint and mutation responses.

## Future persistence

Pending attachments remain runtime-only. Previously used history is stored in Pi's own session files, follows `/new`, and is reconstructed when a thread or branch is revisited; VS Code does not persist a second copy. A future project-level database could restore pending attachments and other state independently of Pi threads, but that requires explicit retention, privacy, migration, and stale-path policies.
