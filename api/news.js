// /api/news — reads from Upstash database, instant response
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || '';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=300');

  try {
    const r = await fetch(`${UPSTASH_URL}/lrange/${encodeURIComponent('kh:posts')}/0/49`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
    });
    const d = await r.json();
    const articles = (d.result||[]).map(item => {
      try { return JSON.parse(item); } catch { return null; }
    }).filter(Boolean);

    return res.json({ ok: true, count: articles.length, articles });
  } catch(e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
