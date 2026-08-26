import '@dejavue/core/env-preload';
import { createServer, type Server } from 'node:http';
import { installCrashHandlers, logger, notify, requireEnv } from '@dejavue/core';
import { getSql } from '@dejavue/db';
import type { Client } from 'discord.js';
import { createClient } from './client';
import { registerEvents } from './events';

const log = logger();
installCrashHandlers('bot');

/**
 * Liveness endpoint for deploy orchestration: 200 once the gateway is connected
 * and the DB is reachable. The gateway half is the part a container runtime
 * can't see for itself — a bot that lost its websocket still looks like a
 * healthy process. Defaults to a different port than the worker's so both can
 * run side by side outside Docker (`pnpm dev`).
 *
 * Best effort — a taken port (e.g. a second local bot next to the Docker one)
 * must not stop the bot from serving Discord, so listen errors only warn.
 */
function startHealthServer(client: Client): Server {
  const port = Number(process.env.HEALTH_PORT ?? 8091);
  const server = createServer((req, res) => {
    if (req.url !== '/health') {
      res.writeHead(404).end();
      return;
    }
    const json = { 'content-type': 'application/json' };
    if (!client.isReady()) {
      res.writeHead(503, json).end('{"ok":false,"gateway":"disconnected"}');
      return;
    }
    getSql()`select 1`
      .then(() => res.writeHead(200, json).end('{"ok":true}'))
      .catch(() => res.writeHead(503, json).end('{"ok":false,"db":"unreachable"}'));
  });
  server.on('error', (err) => log.warn({ err, port }, 'health endpoint unavailable (continuing without it)'));
  server.listen(port, () => log.info({ port }, 'health endpoint listening'));
  return server;
}

async function main(): Promise<void> {
  const token = requireEnv('DISCORD_TOKEN');
  const client = createClient();
  registerEvents(client);
  // Listen before login so the endpoint answers 503 (rather than refusing the
  // connection) while the gateway handshake is still in flight.
  startHealthServer(client);
  await client.login(token);
}

main().catch((err) => {
  log.error({ err }, 'bot failed to start');
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  // Await the alert so it flushes before we exit.
  void notify({ level: 'error', title: '🔴 Bot failed to start', description: detail.slice(0, 4000) }).finally(
    () => process.exit(1),
  );
});
