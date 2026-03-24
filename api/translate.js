// /api/translate — translate ONE title, cache it in Redis
// Called by frontend one-by-one for each untranslated article
const XAI_KEY = process.env.XAI_API_KEY || '';
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || '';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';

async function redisGet(key){
  try{const r=await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`,{headers:{Authorization:`Bearer ${UPSTASH_TOKEN}`}});const d=await r.json();return d.result||null;}catch{return null;}
}
async function redisSet(key,value,ex=86400){
  try{await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}?ex=${ex}`,{headers:{Authorization:`Bearer ${UPSTASH_TOKEN}`}});}catch{}
}

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST,GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS')return res.status(200).end();

  const {text, slug, type} = req.body||{};
  if(!text)return res.status(400).json({error:'missing text'});

  // Check cache first
  const cacheKey = slug ? `kh:t:${slug}` : null;
  if(cacheKey){
    const cached=await redisGet(cacheKey);
    if(cached)return res.json({translated:cached,cached:true});
  }

  // Translate with xAI — single title is fast (<3s)
  const prompt = type==='body'
    ? `Fordítsd le magyarra ezt a kripto cikket természetes stílusban. Max 300 szó. Csak a fordítást:\n\n${text.slice(0,2000)}`
    : `Fordítsd le magyarra ezt a kripto hír CÍMET. Csak a fordítást:\n"${text}"`;

  try{
    const r=await fetch('https://api.x.ai/v1/chat/completions',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':`Bearer ${XAI_KEY}`},
      body:JSON.stringify({model:'grok-3-mini',max_tokens:type==='body'?800:120,messages:[{role:'user',content:prompt}]})
    });
    const d=await r.json();
    const translated=d.choices?.[0]?.message?.content?.trim()||text;
    // Cache it
    if(cacheKey && type!=='body') await redisSet(cacheKey, translated, 86400);
    return res.json({translated});
  }catch(e){
    return res.json({translated:text,error:e.message});
  }
}
