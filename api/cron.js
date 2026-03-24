const XAI_KEY = process.env.XAI_API_KEY;
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const FEEDS = [
  'https://cointelegraph.com/rss',
  'https://www.coindesk.com/arc/outboundfeeds/rss/',
  'https://www.theblock.co/rss.xml',
  'https://decrypt.co/feed',
  'https://bitcoinmagazine.com/feed',
];

function slugify(s){return(s||'').toLowerCase().replace(/[^a-z0-9\s-]/g,'').replace(/\s+/g,'-').replace(/-+/g,'-').slice(0,70).replace(/-$/,'');}

async function rGet(k){
  try{const r=await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(k)}`,{headers:{Authorization:`Bearer ${UPSTASH_TOKEN}`}});const d=await r.json();return d.result?JSON.parse(d.result):null;}catch{return null;}
}
async function rSet(k,v,ex){
  try{const u=ex?`${UPSTASH_URL}/set/${encodeURIComponent(k)}/${encodeURIComponent(JSON.stringify(v))}?ex=${ex}`:`${UPSTASH_URL}/set/${encodeURIComponent(k)}/${encodeURIComponent(JSON.stringify(v))}`;await fetch(u,{headers:{Authorization:`Bearer ${UPSTASH_TOKEN}`}});}catch{}
}
async function rLPush(k,v){
  try{await fetch(`${UPSTASH_URL}/lpush/${encodeURIComponent(k)}/${encodeURIComponent(JSON.stringify(v))}`,{headers:{Authorization:`Bearer ${UPSTASH_TOKEN}`}});}catch{}
}
async function rLRange(k,s,e){
  try{const r=await fetch(`${UPSTASH_URL}/lrange/${encodeURIComponent(k)}/${s}/${e}`,{headers:{Authorization:`Bearer ${UPSTASH_TOKEN}`}});const d=await r.json();return(d.result||[]).map(i=>{try{return JSON.parse(i);}catch{return null;}}).filter(Boolean);}catch{return[];}
}

async function fetchFeed(url){
  try{
    const r=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0 (compatible; Googlebot/2.1)'},signal:AbortSignal.timeout(5000)});
    const text=await r.text();const items=[];const rx=/<item[\s>]([\s\S]*?)<\/item>/gi;let m;
    while((m=rx.exec(text))!==null&&items.length<5){
      const c=m[1];
      const get=tag=>{const r2=new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([^<]*)<\\/${tag}>`,'i');const r3=c.match(r2);return r3?(r3[1]||r3[2]||'').trim():'';};
      const title=get('title'),link=get('link')||'',desc=get('description').replace(/<[^>]*>/g,'').replace(/\s+/g,' ').trim().slice(0,500),date=get('pubDate')||new Date().toISOString();
      let img=null;const enc=c.match(/<enclosure[^>]+url=["']([^"']+\.(?:jpg|jpeg|png|webp))[^"']*["']/i);const med=c.match(/<media:(?:content|thumbnail)[^>]+url=["']([^"']+)[^"']*["']/i);img=enc?.[1]||med?.[1]||null;
      if(title&&link)items.push({title,link,desc,date,img,slug:slugify(title)});
    }
    return items;
  }catch{return[];}
}

// Translate ALL new articles in ONE xAI call — fast and cheap
async function translateAll(articles){
  // Build one big request: titles + descs together
  const payload = articles.map((a,i)=>`=== ${i+1} ===\nCÍM: ${a.title}\nLEÍRÁS: ${a.desc}`).join('\n\n');
  try{
    const r=await fetch('https://api.x.ai/v1/chat/completions',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':`Bearer ${XAI_KEY}`},
      body:JSON.stringify({
        model:'grok-3-mini',
        max_tokens:3000,
        messages:[{role:'user',content:`Fordítsd le magyarra az alábbi kripto híreket. Minden hírhez add vissza PONTOSAN ebben a JSON formátumban és semmi mást:
[{"cim":"fordított cím","leiras":"fordított leírás"},...]

${payload}`}]
      })
    });
    const d=await r.json();
    const content=d.choices?.[0]?.message?.content?.trim()||'';
    const jsonMatch=content.match(/\[[\s\S]*\]/);
    if(jsonMatch){
      const parsed=JSON.parse(jsonMatch[0]);
      articles.forEach((a,i)=>{
        if(parsed[i]){a.titleHU=parsed[i].cim||a.title;a.bodyHU=parsed[i].leiras||a.desc;}
        else{a.titleHU=a.title;a.bodyHU=a.desc;}
      });
    }else{articles.forEach(a=>{a.titleHU=a.title;a.bodyHU=a.desc;});}
  }catch{articles.forEach(a=>{a.titleHU=a.title;a.bodyHU=a.desc;});}
  return articles;
}

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  const secret=process.env.CRON_SECRET;
  if(secret){const p=req.headers['x-cron-secret']||req.query?.secret;if(p!==secret)return res.status(401).json({error:'Unauthorized'});}

  try{
    // Fetch feeds
    const results=await Promise.allSettled(FEEDS.map(fetchFeed));
    const seen=new Set();let candidates=[];
    results.forEach(r=>{if(r.status==='fulfilled')candidates.push(...r.value);});
    candidates=candidates.filter(a=>{if(!a.title||seen.has(a.title))return false;seen.add(a.title);return true;})
      .sort((a,b)=>new Date(b.date)-new Date(a.date)).slice(0,20);

    // Check existing slugs
    const existing=await rLRange('kh:posts',0,99);
    const existingSlugs=new Set(existing.map(p=>p.slug));
    const newOnes=candidates.filter(a=>!existingSlugs.has(a.slug)).slice(0,5);

    if(!newOnes.length)return res.json({ok:true,message:'No new articles',processed:0,total:existing.length});

    // Translate ALL at once in one xAI call
    await translateAll(newOnes);

    // Save each to Redis
    const now=new Date().toISOString();
    for(const a of newOnes){
      const post={slug:a.slug,title:a.title,titleHU:a.titleHU,bodyHU:a.bodyHU,desc:a.desc,img:a.img,link:a.link,date:a.date,publishedAt:now};
      await rSet(`kh:post:${a.slug}`,post,7*86400);
      await rLPush('kh:posts',post);
    }

    // Trim to 100
    await fetch(`${UPSTASH_URL}/ltrim/${encodeURIComponent('kh:posts')}/0/99`,{headers:{Authorization:`Bearer ${UPSTASH_TOKEN}`}});

    return res.json({ok:true,processed:newOnes.length,titles:newOnes.map(a=>a.titleHU),total:existing.length+newOnes.length});
  }catch(e){
    return res.status(500).json({ok:false,error:e.message});
  }
}
