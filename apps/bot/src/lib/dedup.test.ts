import type { BaseMessageOptions } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import {
  discardPlaceholder,
  editPlaceholder,
  editPlaceholderTransient,
  type LivePlaceholderMessage,
} from './dedup';

const payload: BaseMessageOptions = { content: 'x' };

function fakeMessage(fns: { edit?: () => Promise<unknown>; delete?: () => Promise<unknown> } = {}) {
  return {
    edit: vi.fn(fns.edit ?? (async () => undefined)),
    delete: vi.fn(fns.delete ?? (async () => undefined)),
  } satisfies LivePlaceholderMessage;
}

describe('editPlaceholder', () => {
  it('edits the message and reports success', async () => {
    const msg = fakeMessage();
    await expect(editPlaceholder(Promise.resolve(msg), payload)).resolves.toBe(true);
    expect(msg.edit).toHaveBeenCalledWith(payload);
  });

  it('reports failure when there is no placeholder', async () => {
    await expect(editPlaceholder(Promise.resolve(null), payload)).resolves.toBe(false);
  });

  it('reports failure when the edit rejects (message deleted by a mod)', async () => {
    const msg = fakeMessage({ edit: async () => Promise.reject(new Error('gone')) });
    await expect(editPlaceholder(Promise.resolve(msg), payload)).resolves.toBe(false);
  });

  it('reports failure (not a throw) when the placeholder promise itself rejects', async () => {
    await expect(editPlaceholder(Promise.reject(new Error('send failed')), payload)).resolves.toBe(false);
  });
});

describe('discardPlaceholder', () => {
  it('deletes the message', async () => {
    const msg = fakeMessage();
    await discardPlaceholder(Promise.resolve(msg));
    expect(msg.delete).toHaveBeenCalled();
  });

  it('swallows a rejected delete', async () => {
    const msg = fakeMessage({ delete: async () => Promise.reject(new Error('gone')) });
    await expect(discardPlaceholder(Promise.resolve(msg))).resolves.toBeUndefined();
  });

  it('is a no-op on null or a rejected placeholder', async () => {
    await expect(discardPlaceholder(Promise.resolve(null))).resolves.toBeUndefined();
    await expect(discardPlaceholder(Promise.reject(new Error('x')))).resolves.toBeUndefined();
  });
});

describe('editPlaceholderTransient', () => {
  it('edits, then deletes after the ttl', async () => {
    const msg = fakeMessage();
    await editPlaceholderTransient(Promise.resolve(msg), payload, 1);
    expect(msg.edit).toHaveBeenCalledWith(payload);
    expect(msg.delete).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 10));
    expect(msg.delete).toHaveBeenCalled();
  });

  it('never schedules a delete when the edit failed', async () => {
    const msg = fakeMessage({ edit: async () => Promise.reject(new Error('gone')) });
    await editPlaceholderTransient(Promise.resolve(msg), payload, 1);
    await new Promise((r) => setTimeout(r, 10));
    expect(msg.delete).not.toHaveBeenCalled();
  });

  it('stays silent when there is no placeholder', async () => {
    await expect(editPlaceholderTransient(Promise.resolve(null), payload, 1)).resolves.toBeUndefined();
  });
});
