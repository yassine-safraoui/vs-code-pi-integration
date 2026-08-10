# Pi Context VS Code extension

The extension discovers plugin-enabled Pi processes, captures all non-empty selections from the active local-file editor, and sends one atomic attachment batch to the selected Pi.

It works with single-folder, multi-root, loose-file, and workspace-less VS Code windows because routing uses file containment against each live Pi's working directory—not the VS Code workspace model.

Commands:

- **Pi Context: Attach Editor Selection(s)**
- **Pi Context: Choose Target Pi**
- **Pi Context: Clear Pending Attachments**
- **Pi Context: Refresh Pending Attachments**

The Pi Context Activity Bar contains an **Attachments** tree grouped by live Pi working directory, with separate **Pending** and **Previously Used** sections. It refreshes when opened and from its refresh button. Mutations update it only from the state returned by Pi; activating an attachment opens its file and selects the captured range.

Previously used entries are the exact merged snapshots consumed by sent prompts. Use the inline add action or the item context menu to reattach one to its owning Pi. The saved history item stays visible; after its replay is sent, it moves to the top. History remains inside the Pi session and is not persisted by VS Code.

The remembered Pi is held only in memory for the current VS Code window. **Automatic routing** in the target picker clears it.

The extension also handles `vscode://pi-context.pi-context-vscode/open-attachment` links emitted by the local Pi plugin. It opens the file and restores the captured range as the active selection, clamping the range safely if the document changed after capture.
