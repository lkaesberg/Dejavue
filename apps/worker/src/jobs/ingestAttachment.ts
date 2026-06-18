import sharp from 'sharp';
import { ATTACHMENT_DOWNLOAD_MAX_BYTES, childLogger, isDiscordCdnUrl } from '@dejavue/core';
import { existingAttachmentIds, getDb, insertAttachment } from '@dejavue/db';
import type { IngestAttachmentJob } from '@dejavue/queue';

const log = childLogger({ mod: 'job:ingest-attachment' });

const DOWNLOAD_TIMEOUT_MS = 20_000;
const MAX_DIMENSION = 1600; // longest side; plenty for a KB, keeps bytes tiny
const WEBP_QUALITY = 72;

/**
 * Re-host *images* only: download from Discord's CDN while the signed url is still
 * valid, compress to a small webp, and store the bytes in Postgres. Videos and other
 * files are never downloaded (the bot keeps their Discord url for a link-out chip).
 * Idempotent per attachment id; source download is size-capped; only Discord CDN
 * hosts are fetched (no SSRF).
 */
export async function handleIngestAttachment(job: IngestAttachmentJob): Promise<void> {
  const db = getDb();
  const items = job.items.filter((i) => i.id && isDiscordCdnUrl(i.url));
  if (items.length === 0) return;

  const present = await existingAttachmentIds(db, items.map((i) => i.id));

  for (const item of items) {
    if (present.has(item.id)) continue;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(item.url, { signal: controller.signal, redirect: 'error' });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) {
        log.warn({ id: item.id, status: res.status }, 'image download failed');
        continue;
      }
      const declared = Number(res.headers.get('content-length') ?? '0');
      if (declared > ATTACHMENT_DOWNLOAD_MAX_BYTES) continue;
      const input = Buffer.from(await res.arrayBuffer());
      if (input.byteLength === 0 || input.byteLength > ATTACHMENT_DOWNLOAD_MAX_BYTES) continue;

      // Compress to a small webp (auto-orient, downscale, never upscale).
      const data = await sharp(input, { failOn: 'none' })
        .rotate()
        .resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: WEBP_QUALITY })
        .toBuffer();

      await insertAttachment(db, {
        id: item.id,
        guildId: job.guildId,
        name: item.name.slice(0, 256),
        contentType: 'image/webp',
        size: data.byteLength,
        data,
      });
      log.info(
        { id: item.id, guildId: job.guildId, from: input.byteLength, to: data.byteLength },
        'compressed + re-hosted image',
      );
    } catch (err) {
      log.warn({ err, id: item.id }, 'image ingest failed');
    }
  }
}
