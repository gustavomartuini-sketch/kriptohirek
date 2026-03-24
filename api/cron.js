// /api/cron — runs every 6 hours via Vercel Cron
// Fetches 10 fresh articles, translates fully, saves to Upstash

const XAI_KEY = process.env.XAI_API_KEY || '';
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || '';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';

const FEEDS = [
  'https://cointelegraph.com/rss',
  'https://www.coindesk.com/arc/outboundfeeds/rss/',
  'https://www.theblock.co/rss.xml',
  'https://decrypt.co/feed',
  'https://bitcoinmagazine.com/feed',
];

function slugify(s) {
  return (s||'').toLowerCase().replace(/[^a-z0-9\s-]/g,'').replace(/\s+/g,'-').replace(/-+/g,'-').slice(0,70).replace(/-$/,'');
}

// Upstash helpers
async function rGet(key) {
  try {
    const r = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
    });
    const d = await r.json();
    return d.result ? JSON.parse(d.result) : null;
  } catch { return null; }
}
async function rSet(key, value, ex) {
  try {
    const url = ex
      ? `${UPSTASH_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}?ex=${ex}`
      : `${UPSTASH_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}`;
    await fetch(url, { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } });
  } catch(e) { console.error('rSet error:', e.message); }
}
async function rLPush(key, value) {
  try {
    await fetch(`${UPSTASH_URL}/lpush/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
    });
  } catch(e) { console.error('rLPush error:', e.message); }
}
async function rLRange(key, start, end) {
  try {
    const r = await fetch(`${UPSTASH_URL}/lrange/${encodeURIComponent(key)}/${start}/${end}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
    });
    const d = await r.json();
    return (d.result||[]).map(item => {
      try { return JSON.parse(item); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

// Fetch RSS feed
async function fetchFeed(url) {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' },
      signal: AbortSignal.timeout(6000),
    });
    const text = await r.text();
    const items = [];
    const rx = /<item[\s>]([\s\S]*?)<\/item>/gi;
    let m;
    while ((m = rx.exec(text)) !== null && items.length < 5) {
      const c = m[1];
      const get = tag => {
        const r2 = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([^<]*)<\\/${tag}>`, 'i');
        const r3 = c.match(r2);
        return r3 ? (r3[1]||r3[2]||'').trim() : '';
      };
      const title = get('title');
      const link  = get('link') || '';
      const desc  = get('description').replace(/<[^>]*>/g,'').replace(/\s+/g,' ').trim().slice(0,400);
      const date  = get('pubDate') || new Date().toISOString();
      let img = null;
      const enc = c.match(/<enclosure[^>]+url=["']([^"']+\.(?:jpg|jpeg|png|webp))[^"']*["']/i);
      const med = c.match(/<media:(?:content|thumbnail)[^>]+url=["']([^"']+)[^"']*["']/i);
      img = enc?.[1] || med?.[1] || null;
      if (title && link) items.push({ title, link, desc, date, img, slug: slugify(title) });
    }
    return items;
  } catch(e) {
    console.error('Feed error:', url, e.message);
    return [];
  }
}

// Scrape full article body
async function scrapeBody(url) {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(8000),
    });
    const html = await r.text();
    // Extract paragraphs
    const paras = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
      .map(m => m[1].replace(/<[^>]*>/g,'').replace(/\s+/g,' ').trim())
      .filter(t => t.length > 60 && !t.includes('cookie') && !t.includes('subscribe') && !t.includes('newsletter'))
      .slice(0, 20)
      .join('\n\n');
    return paras.slice(0, 4000) || '';
  } catch { return ''; }
}

// xAI translation — one call per article (title + body together)
async function translateArticle(title, body) {
  try {
    const prompt = `Fordítsd le magyarra az alábbi kripto cikket. Adj vissza JSON-t PONTOSAN így:
{"cim": "lefordított cím", "tartalom": "lefordított szöveg bekezdésekben"}

CIKK CÍEM: ${title}
CIKK SZÖVEGE: ${(body||'').slice(0, 2500)}`;

    const r = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${XAI_KEY}` },
      body: JSON.stringify({
        model: 'grok-3-mini',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const d = await r.json();
    const content = d.choices?.[0]?.message?.content?.trim() || '';
    // Parse JSON response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return { titleHU: parsed.cim || title, bodyHU: parsed.tartalom || body };
    }
    return { titleHU: title, bodyHU: body };
  } catch(e) {
    console.error('xAI error:', e.message);
    return { titleHU: title, bodyHU: body };
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Optional secret protection
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const provided = req.headers['x-cron-secret'] || req.query?.secret;
    if (provided !== secret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  console.log('Cron started at', new Date().toISOString());

  try {
    // 1. Fetch all feeds
    const results = await Promise.allSettled(FEEDS.map(fetchFeed));
    const seen = new Set();
    let candidates = [];
    results.forEach(r => { if (r.status === 'fulfilled') candidates.push(...r.value); });
    candidates = candidates
      .filter(a => { if (!a.title || seen.has(a.title)) return false; seen.add(a.title); return true; })
      .sort((a,b) => new Date(b.date) - new Date(a.date))
      .slice(0, 15); // top 15 candidates

    // 2. Check which are already in our DB
    const existingSlugs = new Set();
    const existing = await rLRange('kh:posts', 0, 99);
    existing.forEach(p => existingSlugs.add(p.slug));

    const newArticles = candidates.filter(a => !existingSlugs.has(a.slug));
    console.log(`New articles to process: ${newArticles.length}`);

    if (newArticles.length === 0) {
      return res.json({ ok: true, message: 'No new articles', processed: 0 });
    }

    // 3. Process top 5 new articles (to stay within time limit)
    const toProcess = newArticles.slice(0, 10);
    const processed = [];

    for (const article of toProcess) {
      console.log('Processing:', article.title.slice(0, 50));

      // Scrape full body
      const body = await scrapeBody(article.link);

      // Translate title + body together in one xAI call
      const { titleHU, bodyHU } = await translateArticle(article.title, body || article.desc);

      const post = {
        slug: article.slug,
        title: article.title,
        titleHU,
        bodyHU: bodyHU || article.desc,
        desc: article.desc,
        img: article.img,
        link: article.link,
        date: article.date,
        publishedAt: new Date().toISOString(),
      };

      // Save individual post
      await rSet(`kh:post:${article.slug}`, post, 7 * 86400); // 7 day TTL

      // Add to list
      await rLPush('kh:posts', post);

      processed.push(article.slug);
      console.log('Saved:', article.slug);
    }

    // 4. Trim list to 100 items max
    // (Upstash: LTRIM)
    await fetch(`${UPSTASH_URL}/ltrim/${encodeURIComponent('kh:posts')}/0/99`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
    });

    return res.json({
      ok: true,
      processed: processed.length,
      slugs: processed,
      total: existing.length + processed.length
    });

  } catch(e) {
    console.error('Cron error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
