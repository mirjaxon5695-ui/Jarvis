const express=require('express'),crypto=require('crypto'),{Pool}=require('pg');
const {JARVIS_PASSWORD,ANTHROPIC_API_KEY,DATABASE_URL,MODEL='claude-sonnet-5-5',PORT=3000}=process.env;
const local=!DATABASE_URL||DATABASE_URL.includes('railway.internal')||DATABASE_URL.includes('localhost');
const db=new Pool({connectionString:DATABASE_URL,ssl:local?false:{rejectUnauthorized:false}});
const sign=()=>crypto.createHmac('sha256',JARVIS_PASSWORD||'x').update('jarvis-v1').digest('hex');
const same=(a,b)=>a.length===b.length&&crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b));
db.query(`create table if not exists messages(id serial primary key,role text not null,content text not null,device text,ts timestamptz default now());create table if not exists facts(id serial primary key,text text not null,ts timestamptz default now())`).catch(e=>console.error('db',e.message));
const app=express();app.use(express.json({limit:'100kb'}));app.use(express.static('public'));
let fails=0,lock=0;
app.post('/api/login',(req,res)=>{if(Date.now()<lock)return res.status(429).json({error:'Biroz kuting'});const p=String(req.body.password||'');if(JARVIS_PASSWORD&&same(p,JARVIS_PASSWORD)){fails=0;return res.json({token:sign()})}if(++fails>=5){lock=Date.now()+60000;fails=0}res.status(401).json({error:'Parol xato'})});
const auth=(req,res,next)=>{const t=(req.headers.authorization||'').slice(7);JARVIS_PASSWORD&&same(t,sign())?next():res.status(401).json({error:'Kirish kerak'})};
app.get('/api/history',auth,async(req,res)=>{try{const m=await db.query('select role,content from messages order by id desc limit 60');res.json(m.rows.reverse())}catch(e){res.status(500).json({error:e.message})}});
const TOOLS=[{name:'eslab_qol',description:`Foydalanuvchi haqida yoki uning ishlari haqida muhim narsani doimiy xotiraga yozadi. Telefon va kompyuterda umumiy.`,input_schema:{type:'object',properties:{text:{type:'string'}},required:['text']}}];
async function claude(messages,system){if(!ANTHROPIC_API_KEY||!ANTHROPIC_API_KEY.trim()){const n=Object.keys(process.env).filter(k=>/ANTH|API|KEY|CLAUDE/i.test(k));throw new Error(`ANTHROPIC_API_KEY topilmadi. Oxshash nomlar: ${n.join(', ')||'yoq'}`)}const r=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'content-type':'application/json','x-api-key':ANTHROPIC_API_KEY.trim(),'anthropic-version':'2023-06-01'},body:JSON.stringify({model:MODEL,max_tokens:800,system,tools:TOOLS,messages})});const j=await r.json();if(!r.ok)throw new Error((j.error&&j.error.message)||'Claude API xato');return j}
const {GEMINI_API_KEY,GEMINI_MODEL='gemini-3.8-flash',BRAIN}=process.env;
const USE_GEMINI=BRAIN==='gemini'||(BRAIN!=='claude'&&!!GEMINI_API_KEY);
async function askGemini(msgs,sys){
if(!GEMINI_API_KEY||!GEMINI_API_KEY.trim())throw new Error('GEMINI_API_KEY topilmadi');
const nl=String.fromCharCode(10),contents=[];
for(const m of msgs){const role=m.role==='assistant'?'model':'user',l=contents[contents.length-1];if(l&&l.role===role)l.parts[0].text+=nl+m.content;else contents.push({role,parts:[{text:m.content}]})}
const tools=[{functionDeclarations:[{name:'eslab_qol',description:TOOLS[0].description,parameters:{type:'OBJECT',properties:{text:{type:'STRING'}},required:['text']}}]}];
let out='';
for(let i=0;i<4;i++){
const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,{method:'POST',headers:{'content-type':'application/json','x-goog-api-key':GEMINI_API_KEY.trim()},body:JSON.stringify({systemInstruction:{parts:[{text:sys}]},contents,tools})});
const j=await r.json();if(!r.ok)throw new Error((j.error&&j.error.message)||'Gemini API xato');
const c=j.candidates&&j.candidates[0]&&j.candidates[0].content,parts=(c&&c.parts)||[];
out=parts.map(p=>p.text||'').join('').trim();
const fc=parts.filter(p=>p.functionCall);if(!fc.length)break;
contents.push({role:'model',parts});const rs=[];
for(const p of fc){await db.query('insert into facts(text) values($1)',[String((p.functionCall.args&&p.functionCall.args.text)||'').slice(0,500)]);rs.push({functionResponse:{name:p.functionCall.name,response:{result:'saqlandi'}}})}
contents.push({role:'user',parts:rs})}
return out}
app.post('/api/chat',auth,async(req,res)=>{try{const text=String(req.body.text||'').trim().slice(0,2000);if(!text)return res.status(400).json({error:`Bo'sh xabar`});
await db.query('insert into messages(role,content,device) values($1,$2,$3)',['user',text,String(req.body.device||'').slice(0,20)]);
const [h,f]=await Promise.all([db.query('select role,content from messages order by id desc limit 30'),db.query('select text from facts order by id')]);
const msgs=h.rows.reverse().map(r=>({role:r.role,content:r.content}));while(msgs.length&&msgs[0].role!=='user')msgs.shift();
const nl=String.fromCharCode(10);
const sys=`Sen Jarvis, foydalanuvchining shaxsiy AI yordamchisisan. O'zbek tilida (lotin yozuvi) qisqa va aniq javob ber: 1-4 gap, emoji va markdown ishlatma. Foydalanuvchi telefon va kompyuterdan yozadi, suhbat va xotira ikkalasida umumiy, shuning uchun bir qurilmada boshlangan ishni ikkinchisida davom ettira olasan. Muhim narsalarni eslab_qol vositasi bilan saqla. Hozir: ${new Date().toLocaleString('uz-UZ',{timeZone:'Asia/Tashkent'})} (Toshkent).${nl}Doimiy xotira:${nl}${f.rows.map(x=>'- '+x.text).join(nl)||`(hali bo'sh)`}`;
let out='';if(USE_GEMINI)out=await askGemini(msgs,sys);else for(let i=0;i<4;i++){const j=await claude(msgs,sys);const tu=j.content.filter(b=>b.type==='tool_use');out=j.content.filter(b=>b.type==='text').map(b=>b.text).join('').trim();if(!tu.length)break;msgs.push({role:'assistant',content:j.content});const rs=[];for(const t of tu){await db.query('insert into facts(text) values($1)',[String((t.input&&t.input.text)||'').slice(0,500)]);rs.push({type:'tool_result',tool_use_id:t.id,content:'saqlandi'})}msgs.push({role:'user',content:rs})}
out=out||'Tushundim.';await db.query('insert into messages(role,content) values($1,$2)',['assistant',out]);res.json({reply:out})}catch(e){console.error(e);res.status(500).json({error:e.message})}});
const {VOICELAB_API_KEY,VOICELAB_VOICE_ID}=process.env;
app.post('/api/tts',auth,async(req,res)=>{try{
if(!VOICELAB_API_KEY||!VOICELAB_VOICE_ID)return res.status(503).json({error:'VOICELAB_API_KEY yoki VOICELAB_VOICE_ID kiritilmagan'});
const text=String(req.body.text||'').trim().slice(0,1500);if(!text)return res.status(400).json({error:`Bo'sh matn`});
const H={Authorization:'Bearer '+VOICELAB_API_KEY.trim()};
const msg=j=>typeof j.error==='string'?j.error:(j.error&&(j.error.message||j.error.code));
const r=await fetch('https://api.voicelab.uz/v1/tts',{method:'POST',headers:{...H,'content-type':'application/json','Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({text,language:'uz',voice_id:VOICELAB_VOICE_ID.trim(),speed:1})});
if(r.status===200){res.set('content-type','audio/wav');return res.send(Buffer.from(await r.arrayBuffer()))}
const j=await r.json().catch(()=>({}));
if(r.status!==202)return res.status(502).json({error:msg(j)||('VoiceLab xato '+r.status)});
for(let i=0;i<25;i++){await new Promise(z=>setTimeout(z,800));const g=await(await fetch('https://api.voicelab.uz'+j.status_url,{headers:H})).json();
if(g.status==='completed'){const a=await fetch(g.audio_url);res.set('content-type','audio/wav');return res.send(Buffer.from(await a.arrayBuffer()))}
if(g.status==='failed')return res.status(502).json({error:'Ovoz yaratilmadi'})}
res.status(504).json({error:'Ovoz kechikdi'})}catch(e){res.status(500).json({error:e.message})}});
app.listen(PORT,()=>console.log('Jarvis ishga tushdi',PORT));
