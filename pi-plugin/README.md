# Pi Context plugin

This Pi extension owns the authoritative pending and previously used attachment state and advertises itself through the per-user `~/.pi-context/run/v2` registry. It binds only to `127.0.0.1`, requires the ephemeral token published in its user-private discovery record, and releases its record and working-directory lease during every Pi shutdown or session replacement.

The authenticated `GET /v1/state` endpoint returns pending attachments and session-scoped history for VS Code refreshes. Mutation responses return the same authoritative state after the mutation is applied.

The `input` hook stages pending IDs without transforming the user's text. `before_agent_start` atomically records the exact merged snapshots as previously used, injects them as a hidden persistent custom message after Pi expands skills and templates, then removes them from pending state. Deleted or cleared pending attachments never enter history.

History is newest-first and limited to 50 entries and 1 MiB of attachment text. VS Code can replay an exact saved snapshot with a fresh pending ID and capture timestamp. Pi's own widget and `/pi-context` manager continue to show pending attachments only.

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
