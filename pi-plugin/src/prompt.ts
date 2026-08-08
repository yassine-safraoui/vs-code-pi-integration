import type { AttachmentSnapshot } from "@pi-context/protocol";

const compactRange = (attachment: AttachmentSnapshot): string => {
  const { start, end } = attachment.range;
  return `${attachment.displayPath}:${start.line}:${start.column}-${end.line}:${end.column}`;
};

export const compactAttachmentLabel = (attachment: AttachmentSnapshot): string =>
  `[${attachment.relationship}] ${compactRange(attachment)}`;

export const attachmentWidgetLines = (attachments: ReadonlyArray<AttachmentSnapshot>): ReadonlyArray<string> => [
  `Pi Context · ${attachments.length} pending attachment${attachments.length === 1 ? "" : "s"}`,
  ...attachments.map((attachment, index) => `  ${index + 1}. ${compactAttachmentLabel(attachment)}`)
];

export const describeAttachments = (attachments: ReadonlyArray<AttachmentSnapshot>): string => {
  if (attachments.length === 0) return "Pi Context: no attachments are pending.";
  return [
    `Pi Context: ${attachments.length} pending attachment${attachments.length === 1 ? "" : "s"}`,
    ...attachments.map((attachment) => `  • ${compactAttachmentLabel(attachment)}`)
  ].join("\n");
};

export const renderAttachmentContext = (attachments: ReadonlyArray<AttachmentSnapshot>): string => {
  const blocks = attachments.map((attachment) => {
    const metadata = JSON.stringify({
      id: attachment.id,
      fileUri: attachment.fileUri,
      path: attachment.displayPath,
      relationship: attachment.relationship,
      range: attachment.range,
      languageId: attachment.languageId,
      documentVersion: attachment.documentVersion,
      dirty: attachment.dirty,
      capturedAt: attachment.capturedAt
    });
    return [
      `<<<PI_CONTEXT_ATTACHMENT_BEGIN ${metadata}>>>`,
      attachment.text,
      `<<<PI_CONTEXT_ATTACHMENT_END ${attachment.id}>>>`
    ].join("\n");
  });
  return [
    "The user explicitly attached these verbatim editor snapshots as source context.",
    "Files marked outside are outside Pi's working directory and may require authorization for later file operations.",
    ...blocks,
    "<<<PI_CONTEXT_ATTACHMENTS_END>>>"
  ].join("\n");
};
