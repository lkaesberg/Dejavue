import type { Attachment, Message } from 'discord.js';
import { attachmentKind } from '@dejavue/core';
import type { TranscriptAttachment } from '@dejavue/db';
import { enqueueIngestAttachment, type IngestAttachmentItem } from '@dejavue/queue';

/**
 * Map a message's attachments to KB transcript metadata, splitting out the images
 * that should be downloaded + compressed (re-hosted) from the videos/files that just
 * link back to Discord. Works on a raw discord.js Attachment collection so both the
 * forum transcript and the tracked-channel capture can reuse it.
 */
export function mapAttachments(atts: Iterable<Attachment>): {
  attachments: TranscriptAttachment[];
  images: IngestAttachmentItem[];
} {
  const attachments: TranscriptAttachment[] = [];
  const images: IngestAttachmentItem[] = [];
  for (const att of atts) {
    const kind = attachmentKind(att.contentType);
    const meta: TranscriptAttachment = {
      id: att.id,
      name: att.name,
      kind,
      contentType: att.contentType ?? undefined,
      size: att.size ?? undefined,
      width: att.width ?? undefined,
      height: att.height ?? undefined,
    };
    // Keep the Discord url on every attachment: for video/file it's the link-out
    // target; for images it's a last-resort fallback if the re-host (below) failed
    // and /a/<id> 404s, so a fresh-but-unhosted image still renders.
    meta.url = att.url;
    if (kind === 'image') {
      images.push({
        id: att.id,
        url: att.url,
        name: att.name,
        contentType: att.contentType,
        size: att.size,
      });
    }
    attachments.push(meta);
  }
  return { attachments, images };
}

export function attachmentsOf(message: Message): ReturnType<typeof mapAttachments> {
  return mapAttachments(message.attachments.values());
}

/** Queue the re-host (download + compress) of a batch of images, best-effort. */
export async function queueImageRehost(guildId: string, images: IngestAttachmentItem[]): Promise<void> {
  if (images.length === 0) return;
  await enqueueIngestAttachment({ guildId, items: images }).catch(() => undefined);
}
