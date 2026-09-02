# Pi Context plugin

This Pi extension owns the authoritative pending and previously used attachment state and advertises itself through the per-user `~/.pi-context/run/v4` registry. It atomically refreshes its discovery heartbeat every five minutes. It binds only to `127.0.0.1`, requires the ephemeral token published in its user-private discovery record, and releases its record and working-directory lease during every Pi shutdown or session replacement.

The authenticated `GET /v1/state` endpoint returns pending attachments and Pi-owned history for VS Code refreshes. Mutation responses return the same authoritative state after the mutation is applied. History deltas are validated and reconstructed from Pi custom session entries that do not enter model context; `/new` carries history forward, and `/resume` or `/tree` restores the selected thread or branch.

The `input` hook stages pending IDs without transforming the user's text. After Pi expands skills and templates, `before_agent_start` atomically records the exact merged snapshots as previously used, persists only their compact history delta as non-context session metadata, pins their TOON encoding, and removes them from pending state. The `context` hook inserts that encoding transiently immediately before the user's prompt for every model call in the run. `agent_settled` clears the pin, so attachment text does not persist into later turns. Deleted or cleared pending attachments never enter history.

History is newest-first and limited to 50 entries and 1 MiB of attachment text. VS Code can replay an exact saved snapshot with a fresh pending ID and capture timestamp. Pi's own widget and `/pi-context` manager continue to show pending attachments only.

Pending attachments are scoped to the Pi conversation being viewed. A fresh session that has not produced a resumable session file uses one process-local **New chat** slot; after the first completed response it is promoted to Pi's real session ID. `/new`, `/resume`, and `/reload` restore the corresponding checkpoint, `/tree` retains the same session checkpoint, and `/fork` starts empty. Inactive checkpoints use an LRU cap of 20 conversations and 5 MiB of attachment text. They survive plugin reloads but are intentionally discarded when Pi exits.

Pending attachments are shown in a passive widget above Pi's prompt editor. Every row includes the inside/outside relationship, display path, and complete start/end coordinates. The footer is left untouched.

Run `/pi-context` to open the attachment manager:

- Use Up and Down to highlight an attachment.
- Press Enter to open its captured range in VS Code.
- Press `D` to delete it.
- Press Escape to close the manager.

`/pi-context clear` remains available to clear everything directly.

During development:

```sh
pnpm build
pi --extension /absolute/path/to/pi-plugin/src/index.ts
```
