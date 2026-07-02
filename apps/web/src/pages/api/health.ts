import { getSql } from '@dejavue/db';
import type { APIRoute } from 'astro';

/** Liveness endpoint for deploy orchestration: 200 when the DB is reachable. */
export const GET: APIRoute = async () => {
  try {
    await getSql()`select 1`;
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'content-type': 'application/json' },
    });
  } catch {
    return new Response(JSON.stringify({ ok: false }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  }
};
