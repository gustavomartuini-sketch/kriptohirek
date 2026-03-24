// /api/article?slug=... — full article body, scraped + translated, cached per-article
const XAI_KEY = process.env.XAI_API_KEY || '';
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || '';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';

async function redisGet(key) {
  try {
    const r = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
    });
    const d = await r.json();
    return d.result ? JSON.parse(d.result) : null;
  } catch { return null; }
}

async function redisSet(key, value, ex = 86400) {
  try {
    const encoded = encodeURIComponent(JSON.stringify(value));
    await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(key)}/${encoded}?ex=${ex}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
    });
  } catch {}
}

async function scrapeBody(url) {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(8000),
    });
    const html = await r.text();
    // Try article tags
    const patterns = [
      /<article[^>]*>([\s\S]*?)<\/article>/i,
      /<div[^>]+class="[^"]*article[^"]*body[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
      /<div[^>]+class="[^"]*post[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    ];
    for (const p of patterns) {
      const m = html.match(p);
      if (m) {
        const text = m[1].replace(/<script[\s\S]*?<\/script>/gi,'')
          .replace(/<style[\s\S]*?<\/style>/gi,'')
          .replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
        if (text.length > 300) return text.slice(0, 5000);
      }
    }
    // Fallback: all paragraphs
    const paras = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
      .map(m => m[1].replace(/<[^>]*>/g,'').trim())
      .filter(t => t.length > 50)
      .slice(0, 20)
      .join('\n\n');
    return paras.slice(0, 5000);
  } catch { return ''; }
}

async function translateBody(text) {
  try {
    const r = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${XAI_KEY}` },
      body: JSON.stringify({
        model: 'grok-3-mini',
        max_tokens: 2000,
        messages: [{ role: 'user', content: `Fordítsd le magyarra ezt a kripto cikket természetes stílusban. Tartsd meg a bekezdéseket. Csak a fordítást:\n\n${text.slice(0, 3000)}` }]
      })
    });
    const d = await r.json();
    return d.choices?.[0]?.message?.content?.trim() || '';
  } catch { return ''; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { slug, url } = req.query || {};
  if (!slug || !url) return res.status(400).json({ ok: false, error: 'slug and url required' });

  const cacheKey = `kh:article:${slug}`;

  // Cache hit
  const cached = await redisGet(cacheKey);
  if (cached) {
    res.setHeader('X-Cache', 'HIT');
    return res.json({ ok: true, ...cached, cached: true });
  }

  // Scrape + translate
  const body = await scrapeBody(decodeURIComponent(url));
  const bodyHU = body.length > 100 ? await translateBody(body) : '';

  const result = { bodyHU: bodyHU || null };
  await redisSet(cacheKey, result, 86400);

  res.setHeader('X-Cache', 'MISS');
  return res.json({ ok: true, ...result });
}
