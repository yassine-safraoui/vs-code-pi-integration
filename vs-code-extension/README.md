# Pi Context VS Code extension

The extension discovers plugin-enabled Pi processes, captures all non-empty selections from the active local-file editor, and sends one atomic attachment batch to the selected Pi.

It works with single-folder, multi-root, loose-file, and workspace-less VS Code windows because routing uses file containment against each live Pi's working directory—not the VS Code workspace model.

Commands:

- **Pi Context: Attach Editor Selection(s)**
- **Pi Context: Choose Target Pi**
- **Pi Context: Clear Pending Attachments**
- **Pi Context: Refresh Pending Attachments**
- **Pi Context: Show Logs**

The Pi Context Activity Bar contains an **Attachments** tree grouped by live Pi working directory. Each root names the active Pi conversation and exposes its **Pending** and **Previously Used** sections. When inactive conversations retain pending attachments, a collapsed **Other Sessions** section shows each conversation title and pending count without exposing actions or routing attachments to it. Switch conversations in Pi to view or manage those attachments.

The tree refreshes when opened and from its refresh button. Mutations update it only from the state returned by Pi; there is no polling or optimistic state. Activating an active-conversation attachment opens its file and selects the captured range.

Previously used entries are the exact merged snapshots consumed by sent prompts. Use the inline add action or the item context menu to reattach one to its owning Pi. The saved history item stays visible; after its replay is sent, it moves to the top. History follows Pi's `/new`, `/resume`, and tree navigation through Pi-owned session metadata and is not persisted by VS Code.

Every line covered by a pending attachment has a blue gutter indicator. Indicators use the same pending state displayed by the extension, update immediately from successful attachment and clear responses, and reconcile Pi-side removals or prompt consumption when the Pending Attachments view is refreshed.

The remembered Pi is held only in memory for the current VS Code window. **Automatic routing** in the target picker clears it.

Use **Pi Context: Show Logs** when discovery fails. The command opens the **Pi Context** channel in VS Code's Output panel. Logs include the protocol registry directory, every candidate record's validation outcome, staleness and quarantine decisions, authenticated health-check results, canonical working directories, refreshes, routing decisions, and state-request results. Tokens, authorization headers, and attachment text are intentionally omitted.

The extension also handles `vscode://pi-context.pi-context-vscode/open-attachment` links emitted by the local Pi plugin. It opens the file and restores the captured range as the active selection, clamping the range safely if the document changed after capture.
