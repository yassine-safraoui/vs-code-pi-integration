# Pi Context VS Code extension

The extension discovers plugin-enabled Pi processes, captures all non-empty selections from the active local-file editor, and sends one atomic attachment batch to the selected Pi.

It works with single-folder, multi-root, loose-file, and workspace-less VS Code windows because routing uses file containment against each live Pi's working directory—not the VS Code workspace model.

Commands:

- **Pi Context: Attach Editor Selection(s)**
- **Pi Context: Choose Target Pi**
- **Pi Context: Clear Pending Attachments**
- **Pi Context: Refresh Pending Attachments**

The Pi Context Activity Bar contains a **Pending Attachments** tree grouped by live Pi working directory. It refreshes when opened and from its refresh button. Attachment and clear mutations update it only from the state returned by Pi; clicking an attachment opens its file and selects the captured range.

Every line covered by a pending attachment has a blue gutter indicator. Indicators use the same pending state displayed by the extension, update immediately from successful attachment and clear responses, and reconcile Pi-side removals or prompt consumption when the Pending Attachments view is refreshed.

The remembered Pi is held only in memory for the current VS Code window. **Automatic routing** in the target picker clears it.

The extension also handles `vscode://pi-context.pi-context-vscode/open-attachment` links emitted by the local Pi plugin. It opens the file and restores the captured range as the active selection, clamping the range safely if the document changed after capture.
