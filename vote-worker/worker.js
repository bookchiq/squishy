// squishy vote worker — a minimal 👍 counter backed by Workers KV.
//
// Routes (CORS restricted to ALLOWED_ORIGIN):
//   POST /vote   { "videoId": "<id>" }  -> increment that video's 👍, returns { videoId, count }
//   GET  /votes                          -> { "<videoId>": <count>, ... } for every voted video
//
// Bindings (see wrangler.toml):
//   VOTES          KV namespace
//   ALLOWED_ORIGIN the site origin allowed to call this (e.g. https://bookchiq.github.io)
//
// Note: counts use read-modify-write, so simultaneous votes on the SAME video can
// rarely lose one. That's fine for a small, friendly audience; precision isn't the point.

const PREFIX = 'votes:';
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

export default {
  async fetch(request, env) {
    const allowed = env.ALLOWED_ORIGIN || '*';
    const headers = corsHeaders(allowed);
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { headers });

    if (request.method === 'GET' && url.pathname === '/votes') {
      const out = {};
      let cursor;
      do {
        const page = await env.VOTES.list({ prefix: PREFIX, cursor });
        for (const k of page.keys) {
          out[k.name.slice(PREFIX.length)] = (k.metadata && k.metadata.count) || 0;
        }
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
      return json(out, 200, headers);
    }

    if (request.method === 'POST' && url.pathname === '/vote') {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'invalid JSON' }, 400, headers);
      }
      const id = String(body && body.videoId ? body.videoId : '').trim();
      if (!ID_RE.test(id)) return json({ error: 'invalid videoId' }, 400, headers);

      const key = PREFIX + id;
      const existing = await env.VOTES.getWithMetadata(key);
      const count = ((existing.metadata && existing.metadata.count) || 0) + 1;
      await env.VOTES.put(key, String(count), { metadata: { count } });
      return json({ videoId: id, count }, 200, headers);
    }

    return json({ error: 'not found' }, 404, headers);
  },
};
