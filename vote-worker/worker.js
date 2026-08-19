// squishy vote worker — a minimal 👍 counter backed by Workers KV.
//
// Routes (CORS restricted to ALLOWED_ORIGIN):
//   POST /vote   { "videoId": "<id>" }               -> increment 👍, returns { videoId, count }
//   GET  /votes                                       -> { "<videoId>": <count>, ... }
//   POST /report { "videoId": "<id>", "title": "…" }  -> flag a video, returns { videoId, count }
//   GET  /reports                                     -> { "<videoId>": { count, title }, ... }
//
// Bindings (see wrangler.toml):
//   VOTES          KV namespace (holds both votes and reports, different key prefixes)
//   ALLOWED_ORIGIN the site origin allowed to call this (e.g. https://bookchiq.github.io)
//
// Note: counts use read-modify-write, so simultaneous writes to the SAME key can
// rarely lose one. That's fine for a small, friendly audience; precision isn't the point.

const VOTES_PREFIX = 'votes:';
const REPORTS_PREFIX = 'reports:';
const ID_RE = /^[A-Za-z0-9_-]{6,20}$/; // YouTube video IDs

function corsHeaders(allowed) {
  return {
    'Access-Control-Allow-Origin': allowed || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Content-Type': 'application/json',
  };
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers });
}

async function readVideoId(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return { error: 'invalid JSON' };
  }
  const id = String(body && body.videoId ? body.videoId : '').trim();
  if (!ID_RE.test(id)) return { error: 'invalid videoId' };
  return { id, body };
}

async function bump(env, key) {
  const existing = await env.VOTES.getWithMetadata(key);
  const count = ((existing.metadata && existing.metadata.count) || 0) + 1;
  await env.VOTES.put(key, String(count), { metadata: { count } });
  return count;
}

async function listCounts(env, prefix) {
  const out = {};
  let cursor;
  do {
    const page = await env.VOTES.list({ prefix, cursor });
    for (const k of page.keys) out[k.name.slice(prefix.length)] = (k.metadata && k.metadata.count) || 0;
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

async function listReports(env) {
  const out = {};
  let cursor;
  do {
    const page = await env.VOTES.list({ prefix: REPORTS_PREFIX, cursor });
    for (const k of page.keys) {
      const m = k.metadata || {};
      out[k.name.slice(REPORTS_PREFIX.length)] = { count: m.count || 0, title: m.title || '' };
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

export default {
  async fetch(request, env) {
    const allowed = env.ALLOWED_ORIGIN || '*';
    const headers = corsHeaders(allowed);
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { headers });

    // --- votes ---
    if (request.method === 'GET' && url.pathname === '/votes') {
      const out = await listCounts(env, VOTES_PREFIX);
      return json(out, 200, headers);
    }

    if (request.method === 'POST' && url.pathname === '/vote') {
      const parsed = await readVideoId(request);
      if (parsed.error) return json({ error: parsed.error }, 400, headers);
      const count = await bump(env, VOTES_PREFIX + parsed.id);
      return json({ videoId: parsed.id, count }, 200, headers);
    }

    // --- reports (flag a video for the maintainer to review) ---
    if (request.method === 'GET' && url.pathname === '/reports') {
      const out = await listReports(env);
      return json(out, 200, headers);
    }

    if (request.method === 'POST' && url.pathname === '/report') {
      const parsed = await readVideoId(request);
      if (parsed.error) return json({ error: parsed.error }, 400, headers);
      const title = String((parsed.body && parsed.body.title) || '').slice(0, 200);
      const key = REPORTS_PREFIX + parsed.id;
      const existing = await env.VOTES.getWithMetadata(key, 'json');
      const count = ((existing.metadata && existing.metadata.count) || 0) + 1;
      const meta = { count, title: title || (existing.metadata && existing.metadata.title) || '' };
      await env.VOTES.put(key, JSON.stringify(meta), { metadata: meta });
      return json({ videoId: parsed.id, count }, 200, headers);
    }

    return json({ error: 'not found' }, 404, headers);
  },
};
