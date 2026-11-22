// Chatgram server. Ishga tushirish: node server.js  ->  http://localhost:3000
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const PORT=process.env.PORT||3000;
const DIR=process.env.DATA_DIR||__dirname;
const DB_FILE=path.join(DIR,'data.json');
const UP=path.join(DIR,'uploads');
fs.mkdirSync(UP,{recursive:true});

let db={users:{},sessions:{},messages:[],stories:[],seq:0};
try{db=Object.assign(db,JSON.parse(fs.readFileSync(DB_FILE,'utf8')))}catch(e){}
let dirty=false;const touch=()=>{dirty=true};
function flush(){if(!dirty)return;dirty=false;try{fs.writeFileSync(DB_FILE+'.tmp',JSON.stringify(db));fs.renameSync(DB_FILE+'.tmp',DB_FILE)}catch(e){console.error(e)}}
setInterval(flush,1000);
process.on('SIGINT',()=>{flush();process.exit()});
process.on('SIGTERM',()=>{flush();process.exit()});

const DAY=864e5,LIMIT=40e6,NICK=/^[a-z0-9_]{3,20}$/;
const BAD=new Set(['__proto__','constructor','prototype']);
const has=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
const getUser=n=>has(db.users,n)?db.users[n]:null;
const MIME={jpg:'image/jpeg',png:'image/png',webp:'image/webp',gif:'image/gif',mp4:'video/mp4',webm:'video/webm',mov:'video/quicktime',weba:'audio/webm',ogg:'audio/ogg',m4a:'audio/mp4',mp3:'audio/mpeg',wav:'audio/wav'};
const UPTYPES={'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif','video/mp4':'mp4','video/webm':'webm','video/quicktime':'mov','audio/webm':'weba','audio/ogg':'ogg','audio/mp4':'m4a','audio/x-m4a':'m4a','audio/mpeg':'mp3','audio/wav':'wav'};

const J=(res,code,obj)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(obj))};
const pub=u=>u?{nick:u.nick,name:u.name||u.nick,avatar:u.avatar||''}:null;
const hp=(p,salt)=>crypto.scryptSync(p,salt,32);
const checkPass=(u,p)=>{try{return crypto.timingSafeEqual(hp(p,u.salt),Buffer.from(u.hash,'hex'))}catch(e){return false}};
const setPass=(u,p)=>{u.salt=crypto.randomBytes(16).toString('hex');u.hash=hp(p,u.salt).toString('hex')};
const ip=req=>(req.headers['x-forwarded-for']||'').split(',')[0].trim()||req.socket.remoteAddress||'';
const fails={};
const tooMany=k=>{const f=fails[k];return f&&f.n>=8&&Date.now()-f.t<6e5};
const failed=k=>{const f=fails[k]=fails[k]||{n:0,t:0};if(Date.now()-f.t>6e5)f.n=0;f.n++;f.t=Date.now()};
const auth=req=>{const t=String(req.headers['x-token']||'');if(!has(db.sessions,t))return null;const n=db.sessions[t];return getUser(n)?n:null};
const validMedia=c=>/^\/uploads\/[a-f0-9]{24}\.[a-z0-9]{2,5}$/.test(c)&&fs.existsSync(path.join(UP,path.basename(c)));
function newSession(user){const token=crypto.randomBytes(24).toString('hex');db.sessions[token]=user.nick;touch();return{token,user:pub(user)}}
function readBody(req,limit){return new Promise((ok,no)=>{const c=[];let n=0,over=false;req.on('data',d=>{n+=d.length;if(n>limit){over=true;return}c.push(d)});req.on('end',()=>over?no(new Error('Fayl juda katta')):ok(Buffer.concat(c)));req.on('error',no)})}

async function api(req,res,u){
 const p=u.pathname.slice(5);
 const jb=async()=>{const r=await readBody(req,1e6);try{return JSON.parse(r.toString()||'{}')}catch(e){throw new Error("Noto'g'ri so'rov")}};
 if(p==='register'||p==='login'){
  const b=await jb(),nick=String(b.nick||'').trim().toLowerCase().replace(/^@/,''),pass=String(b.pass||'');
  if(p==='register'){
   if(!NICK.test(nick)||BAD.has(nick))return J(res,400,{error:"Nik 3-20 ta lotin harf, raqam yoki _ bo'lsin"});
   if(pass.length<4||pass.length>100)return J(res,400,{error:"Parol kamida 4 belgi bo'lsin"});
   if(has(db.users,nick))return J(res,400,{error:'Bu nik band! Boshqa nik tanlang'});
   const user={nick,name:nick,avatar:'',created:Date.now()};setPass(user,pass);db.users[nick]=user;
   return J(res,200,newSession(user));
  }
  const key=ip(req)+nick;
  if(tooMany(key))return J(res,429,{error:"Juda ko'p urinish. Keyinroq urinib ko'ring"});
  const user=getUser(nick);
  if(!user||!checkPass(user,pass)){failed(key);return J(res,400,{error:"Nik yoki parol noto'g'ri"})}
  return J(res,200,newSession(user));
 }
 const me=auth(req);
 if(!me)return J(res,401,{error:'Qayta kiring'});
 const U=db.users[me];
 switch(p){
  case 'me':return J(res,200,{user:pub(U)});
  case 'logout':delete db.sessions[req.headers['x-token']];touch();return J(res,200,{ok:1});
  case 'search':{
   const q=(u.searchParams.get('q')||'').trim().toLowerCase().replace(/^@/,'');
   if(!q)return J(res,200,{users:[]});
   const r=Object.values(db.users).filter(x=>x.nick!==me&&(x.nick.includes(q)||(x.name||'').toLowerCase().includes(q))).slice(0,30).map(pub);
   return J(res,200,{users:r});
  }
  case 'user':{const x=getUser(String(u.searchParams.get('nick')||''));return x?J(res,200,{user:pub(x)}):J(res,404,{error:'Topilmadi'})}
  case 'chats':{
   const seen={},out=[];
   for(let i=db.messages.length-1;i>=0;i--){
    const m=db.messages[i];if(m.from!==me&&m.to!==me)continue;
    const o=m.from===me?m.to:m.from;if(seen[o])continue;seen[o]=1;
    const x=getUser(o);if(x)out.push({user:pub(x),last:m});
   }
   return J(res,200,{chats:out});
  }
  case 'messages':{
   const w=String(u.searchParams.get('with')||''),after=+u.searchParams.get('after')||0;
   let r=db.messages.filter(m=>m.id>after&&((m.from===me&&m.to===w)||(m.from===w&&m.to===me)));
   if(!after)r=r.slice(-300);
   return J(res,200,{messages:r});
  }
  case 'send':{
   const b=await jb(),to=getUser(String(b.to||'')),type=b.type,c=String(b.content||'');
   if(!to||to.nick===me)return J(res,400,{error:'Qabul qiluvchi topilmadi'});
   if(!['text','sticker','voice','image','video'].includes(type))return J(res,400,{error:"Noto'g'ri tur"});
   const bad=(type==='text'||type==='sticker')?(!c.trim()||c.length>2000):!validMedia(c);
   if(bad)return J(res,400,{error:"Noto'g'ri xabar"});
   const m={id:++db.seq,from:me,to:to.nick,type,content:type==='text'?c.trim():c,ts:Date.now()};
   db.messages.push(m);touch();return J(res,200,{message:m});
  }
  case 'upload':{
   if(+req.headers['content-length']>LIMIT)return J(res,413,{error:'Fayl juda katta (40 MB gacha)'});
   const ct=String(req.headers['content-type']||'').split(';')[0].trim().toLowerCase(),ext=UPTYPES[ct];
   if(!ext)return J(res,400,{error:"Bu fayl turi qo'llab-quvvatlanmaydi"});
   const buf=await readBody(req,LIMIT);
   if(!buf.length)return J(res,400,{error:"Bo'sh fayl"});
   const name=crypto.randomBytes(12).toString('hex')+'.'+ext;
   await fs.promises.writeFile(path.join(UP,name),buf);
   return J(res,200,{url:'/uploads/'+name});
  }
  case 'profile':{
   const b=await jb();
   if(b.name!==undefined){const n=String(b.name).trim();if(!n||n.length>30)return J(res,400,{error:"Ism 1-30 belgi bo'lsin"});U.name=n}
   if(b.avatar!==undefined){if(!/^\/uploads\/[a-f0-9]{24}\.(jpg|png|webp)$/.test(String(b.avatar)))return J(res,400,{error:"Rasm noto'g'ri"});U.avatar=b.avatar}
   touch();return J(res,200,{user:pub(U)});
  }
  case 'nick':{
   const b=await jb(),n=String(b.nick||'').trim().toLowerCase().replace(/^@/,'');
   if(n===me)return J(res,200,{user:pub(U)});
   if(!NICK.test(n)||BAD.has(n))return J(res,400,{error:"Nik 3-20 ta lotin harf, raqam yoki _ bo'lsin"});
   if(has(db.users,n))return J(res,400,{error:'Bu nik band!'});
   U.nick=n;if(U.name===me)U.name=n;db.users[n]=U;delete db.users[me];
   for(const t in db.sessions)if(db.sessions[t]===me)db.sessions[t]=n;
   db.messages.forEach(m=>{if(m.from===me)m.from=n;if(m.to===me)m.to=n});
   db.stories.forEach(s=>{if(s.nick===me)s.nick=n});
   touch();return J(res,200,{user:pub(U)});
  }
  case 'password':{
   const b=await jb();
   if(!checkPass(U,String(b.old||'')))return J(res,400,{error:"Eski parol noto'g'ri"});
   const np=String(b.new||'');
   if(np.length<4||np.length>100)return J(res,400,{error:"Yangi parol kamida 4 belgi bo'lsin"});
   setPass(U,np);touch();return J(res,200,{ok:1});
  }
  case 'stories':{
   const now=Date.now(),l=db.stories.filter(s=>now-s.ts<DAY),users={};
   l.forEach(s=>{const x=getUser(s.nick);if(x)users[s.nick]=pub(x)});
   return J(res,200,{stories:l,users});
  }
  case 'story':{
   const b=await jb(),type=b.type;let c=String(b.content||'');const cap=String(b.caption||'').slice(0,200);
   const err=()=>J(res,400,{error:"Hikoya noto'g'ri"});
   if(type==='text'){c=c.trim();if(!c||c.length>300)return err()}
   else if(type==='image'||type==='video'){if(!validMedia(c))return err()}
   else return err();
   const bg=/^#[0-9a-f]{6}$/i.test(String(b.bg))?b.bg:'#3390ec';
   const s={id:++db.seq,nick:me,type,content:c,caption:type==='text'?'':cap,bg,ts:Date.now()};
   db.stories.push(s);touch();return J(res,200,{story:s});
  }
  case 'storydel':{
   const b=await jb(),i=db.stories.findIndex(s=>s.id===b.id&&s.nick===me);
   if(i>=0){db.stories.splice(i,1);touch()}
   return J(res,200,{ok:1});
  }
  default:return J(res,404,{error:'Topilmadi'});
 }
}

setInterval(()=>{
 const now=Date.now(),keep=[];
 db.stories.forEach(s=>{if(now-s.ts<DAY)keep.push(s);else if(s.type!=='text')fs.unlink(path.join(UP,path.basename(s.content)),()=>{})});
 if(keep.length!==db.stories.length){db.stories=keep;touch()}
},36e5);

function serveFile(req,res,name){
 const f=path.join(UP,path.basename(name));
 fs.stat(f,(e,st)=>{
  if(e||!st.isFile()){res.writeHead(404);return res.end()}
  const h={'Content-Type':MIME[path.extname(f).slice(1)]||'application/octet-stream','Accept-Ranges':'bytes','Cache-Control':'public, max-age=31536000, immutable','X-Content-Type-Options':'nosniff'};
  const r=/bytes=(\d*)-(\d*)/.exec(req.headers.range||'');
  if(r){
   let s=parseInt(r[1]),en=r[2]?parseInt(r[2]):st.size-1;
   if(isNaN(s)){s=st.size-en;en=st.size-1}
   en=Math.min(en,st.size-1);
   if(isNaN(s)||s<0||s>=st.size||en<s){res.writeHead(416,{'Content-Range':'bytes */'+st.size});return res.end()}
   res.writeHead(206,{...h,'Content-Range':'bytes '+s+'-'+en+'/'+st.size,'Content-Length':en-s+1});
   return fs.createReadStream(f,{start:s,end:en}).pipe(res);
  }
  res.writeHead(200,{...h,'Content-Length':st.size});
  fs.createReadStream(f).pipe(res);
 });
}

const server=http.createServer(async(req,res)=>{
 try{
  const u=new URL(req.url,'http://localhost');
  if(req.method==='GET'&&(u.pathname==='/'||u.pathname==='/index.html')){
   res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});return res.end(PAGE);
  }
  if(req.method==='GET'&&u.pathname.startsWith('/uploads/'))return serveFile(req,res,u.pathname.slice(9));
  if(u.pathname.startsWith('/api/'))return await api(req,res,u);
  res.writeHead(404);res.end('404');
 }catch(e){if(!res.headersSent)J(res,400,{error:e.message||'Xatolik'});else res.end()}
});

// ====================== BRAUZER QISMI ======================
// Diqqat: quyidagi qism ichida hech qayerda yulduzcha-slesh izoh belgisi ishlatilmaydi.
var PAGE=(function(){/*
<!DOCTYPE html>
<html lang="uz" data-theme="light">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>Chatgram</title>
<style>
:root{--bg:#fff;--side:#fff;--text:#111;--sub:#707579;--acc:#3390ec;--me:#eeffde;--other:#fff;--chatbg:#dfe6ea;--line:#e4e4e4;--input:#f1f3f4}
[data-theme=dark]{--bg:#0e1621;--side:#17212b;--text:#f5f5f5;--sub:#8b98a5;--acc:#5288c1;--me:#2b5278;--other:#182533;--chatbg:#0e1621;--line:#0b121a;--input:#242f3d}
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
body{font-family:system-ui,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--text);height:100vh;height:100dvh;overflow:hidden}
button{font:inherit;cursor:pointer;border:0;background:none;color:inherit}
input,textarea{font:inherit;color:var(--text);outline:none}
.hidden{display:none!important}
.av{border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:600;object-fit:cover;flex-shrink:0;overflow:hidden}
.pw{position:relative;width:100%;margin-bottom:10px}
.box .pw{margin-bottom:8px}
.pw input{margin-bottom:0!important;padding-right:46px!important}
.eye{position:absolute;right:4px;top:0;bottom:0;width:40px;font-size:18px;opacity:.75;display:flex;align-items:center;justify-content:center}
.eye:hover{opacity:1}
.center{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:var(--bg);z-index:50;padding:16px;overflow-y:auto}
.card{width:100%;max-width:360px;text-align:center}
.card h1{font-size:26px;margin:10px 0 4px}
.card p.s{color:var(--sub);font-size:14px;margin-bottom:18px}
.card input{width:100%;padding:13px 14px;margin-bottom:10px;border:1px solid var(--line);border-radius:12px;background:var(--input)}
.btn{width:100%;padding:13px;border-radius:12px;background:var(--acc);color:#fff;font-weight:600;margin-top:4px}
.btn:disabled{opacity:.6}
.link{color:var(--acc);font-size:14px;margin-top:12px;display:block;width:100%}
.err{color:#e53935;font-size:13px;min-height:18px;margin-bottom:4px}
.logo{font-size:54px}
#saved{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-bottom:14px}
#saved .chip{display:flex;flex-direction:column;align-items:center;gap:4px;font-size:12px;width:70px;cursor:pointer}
#saved .chip span{max-width:70px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dots{display:flex;gap:14px;justify-content:center;margin:18px 0}
.dots i{width:14px;height:14px;border-radius:50%;border:2px solid var(--acc)}
.dots i.on{background:var(--acc)}
.pad{display:grid;grid-template-columns:repeat(3,72px);gap:12px;justify-content:center}
.pad button{height:72px;border-radius:50%;background:var(--input);font-size:24px}
#app{display:grid;grid-template-columns:340px 1fr;height:100vh;height:100dvh}
aside{background:var(--side);border-right:1px solid var(--line);display:flex;flex-direction:column;min-height:0}
.top{display:flex;gap:8px;padding:10px;align-items:center}
.top input{flex:1;padding:10px 14px;border-radius:20px;border:0;background:var(--input)}
.ib{width:40px;height:40px;border-radius:50%;font-size:20px;flex-shrink:0}
.ib:hover{background:var(--input)}
#stories{display:flex;gap:12px;padding:4px 12px 10px;overflow-x:auto;border-bottom:1px solid var(--line);flex-shrink:0}
.sb{display:flex;flex-direction:column;align-items:center;gap:4px;font-size:11px;width:60px;flex-shrink:0;cursor:pointer;color:var(--sub)}
.sb span{max-width:60px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ring{padding:2.5px;border-radius:50%;background:linear-gradient(45deg,#3390ec,#9b5de5,#f15bb5)}
.ring>div{padding:2px;border-radius:50%;background:var(--side)}
.add{width:52px;height:52px;border-radius:50%;background:var(--input);display:flex;align-items:center;justify-content:center;font-size:26px;color:var(--acc)}
#list{overflow-y:auto;flex:1}
.item{display:flex;gap:12px;padding:10px 14px;align-items:center;cursor:pointer}
.item:hover,.item.act{background:var(--input)}
.item .t{flex:1;min-width:0}
.item b{display:block;font-size:15px}
.item span{display:block;color:var(--sub);font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lbl{padding:8px 14px;color:var(--acc);font-size:13px;font-weight:600}
.empty{padding:30px;text-align:center;color:var(--sub);font-size:14px}
main{display:flex;flex-direction:column;background:var(--chatbg);min-height:0;min-width:0}
.head{display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--side);border-bottom:1px solid var(--line)}
.head .who{flex:1;cursor:pointer;display:flex;gap:10px;align-items:center}
.back{display:none}
#msgs{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:6px}
.m{max-width:75%;padding:8px 12px;border-radius:14px;background:var(--other);word-break:break-word;white-space:pre-wrap;font-size:15px;box-shadow:0 1px 1px rgba(0,0,0,.12)}
.m.me{align-self:flex-end;background:var(--me);border-bottom-right-radius:4px}
.m:not(.me){border-bottom-left-radius:4px}
.m small{display:block;text-align:right;font-size:11px;color:var(--sub);margin-top:2px;white-space:normal}
.m.stk{background:none;box-shadow:none;font-size:68px;line-height:1.1;padding:0}
.m audio{height:36px;max-width:230px}
.m.media{padding:4px;max-width:min(75%,300px)}
.m.media img,.m.media video{display:block;width:100%;max-height:360px;object-fit:cover;border-radius:10px;background:#000}
.m.media img{cursor:zoom-in}
.ph{margin:auto;background:rgba(0,0,0,.25);color:#fff;padding:6px 14px;border-radius:14px;font-size:14px}
#stk{display:grid;grid-template-columns:repeat(auto-fill,minmax(52px,1fr));gap:4px;max-height:200px;overflow-y:auto;padding:8px;background:var(--side);border-top:1px solid var(--line)}
#stk button{font-size:34px;padding:4px;border-radius:10px}
#stk button:hover{background:var(--input)}
#upst{padding:6px 12px;font-size:13px;color:var(--acc);background:var(--side)}
.comp{display:flex;gap:6px;padding:8px;background:var(--side);align-items:center}
.comp input{flex:1;min-width:0;padding:11px 14px;border-radius:22px;border:0;background:var(--input)}
.rec{color:#e53935;animation:bl 1s infinite}
@keyframes bl{50%{opacity:.4}}
.ov{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:40;display:flex;align-items:center;justify-content:center;padding:12px}
.box{background:var(--side);width:100%;max-width:420px;max-height:92vh;overflow-y:auto;border-radius:16px;padding:18px}
.box h3{margin:14px 0 8px;font-size:15px;color:var(--acc)}
.box input,.box textarea{width:100%;padding:11px 12px;margin-bottom:8px;border:1px solid var(--line);border-radius:10px;background:var(--input)}
.box textarea{resize:none;height:90px}
.row{display:flex;justify-content:space-between;align-items:center;padding:8px 0}
.sm{padding:10px;border-radius:10px;background:var(--acc);color:#fff;font-weight:600;width:100%}
.sm:disabled{opacity:.6}
.sm.red{background:#e53935}
.sm.gray{background:var(--input);color:var(--text)}
.pcenter{text-align:center}
.pcenter .av{margin:0 auto 8px}
hr{border:0;border-top:1px solid var(--line);margin:14px 0}
.swatches{display:flex;gap:8px;margin:6px 0 10px}
.swatches i{width:32px;height:32px;border-radius:50%;cursor:pointer;border:3px solid transparent}
.swatches i.on{border-color:var(--text)}
#sprevbox img,#sprevbox video{width:100%;max-height:220px;object-fit:cover;border-radius:12px;margin-bottom:8px;background:#000}
#sview{position:fixed;inset:0;background:#000;z-index:60;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#fff}
#sinner{position:relative;width:100%;max-width:440px;height:100%;max-height:100dvh;display:flex;flex-direction:column;background:#111}
#sbars{display:flex;gap:4px;padding:10px 10px 6px;position:absolute;top:0;left:0;right:0;z-index:3}
#sbars i{flex:1;height:3px;background:rgba(255,255,255,.35);border-radius:2px;overflow:hidden}
#sbars i.full{background:#fff}
#sbars b{display:block;height:100%;width:0;background:#fff}
@keyframes fill{from{width:0}to{width:100%}}
#shead{position:absolute;top:20px;left:0;right:0;padding:8px 12px;display:flex;align-items:center;gap:10px;z-index:3;text-shadow:0 1px 3px #000}
#shead .nm{flex:1}
#shead button{font-size:22px;color:#fff}
#sbody{flex:1;display:flex;align-items:center;justify-content:center;overflow:hidden}
#sbody img,#sbody video{max-width:100%;max-height:100%;object-fit:contain}
#sbody .txt{padding:30px;font-size:26px;font-weight:600;text-align:center;width:100%;height:100%;display:flex;align-items:center;justify-content:center;word-break:break-word}
#scap{position:absolute;bottom:30px;left:0;right:0;text-align:center;padding:10px 20px;background:linear-gradient(transparent,rgba(0,0,0,.6));z-index:3}
#iv{position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:70;display:flex;align-items:center;justify-content:center;cursor:zoom-out}
#iv img{max-width:100%;max-height:100%;object-fit:contain}
@media(max-width:760px){
 #app{grid-template-columns:1fr}
 main{position:fixed;inset:0;z-index:20;transform:translateX(100%);transition:.2s}
 #app.open main{transform:none}
 .back{display:block}
}
</style>
</head>
<body>

<div id="auth" class="center hidden">
 <div class="card">
  <div class="logo">✈️</div><h1>Chatgram</h1>
  <div id="login">
   <p class="s">Akkauntingizga kiring</p>
   <div id="saved"></div>
   <input id="ln" placeholder="Nik (masalan: islom_01)" autocapitalize="off" autocomplete="username">
   <input id="lp" type="password" placeholder="Parol" autocomplete="current-password">
   <div class="err" id="le"></div>
   <button class="btn" id="lb">Kirish</button>
   <button class="link" id="toReg">Yangi akkaunt ochish</button>
   <button class="link" id="toForgot">Parol esdan chiqdi?</button>
  </div>
  <div id="reg" class="hidden">
   <p class="s">Yangi akkaunt yaratish</p>
   <input id="rn" placeholder="Nik (lotin harf, raqam, _ )" autocapitalize="off">
   <input id="rp" type="password" placeholder="Parol (kamida 4 belgi)">
   <div class="err" id="re"></div>
   <button class="btn" id="rb">Akkaunt yaratish</button>
   <button class="link" id="toLogin1">← Kirishga qaytish</button>
  </div>
  <div id="forgot" class="hidden">
   <p class="s">Parol esdan chiqdimi? Eski akkauntga kirib bo'lmaydi, lekin yangi akkaunt ochishingiz mumkin. Bitta nikda faqat bitta akkaunt bo'ladi.</p>
   <input id="fn" placeholder="Yangi nik" autocapitalize="off">
   <input id="fp" type="password" placeholder="Yangi parol">
   <div class="err" id="fe"></div>
   <button class="btn" id="fb">Yangi akkaunt ochish</button>
   <button class="link" id="toLogin2">← Kirishga qaytish</button>
  </div>
 </div>
</div>

<div id="lock" class="center hidden">
 <div class="card">
  <div class="logo">🔒</div><h1>PIN kodni kiriting</h1>
  <div class="dots" id="ldots"></div>
  <div class="err" id="lerr"></div>
  <div class="pad" id="lpad"></div>
  <button class="link" id="lout">Akkauntdan chiqish</button>
 </div>
</div>

<div id="app" class="hidden">
 <aside>
  <div class="top">
   <button class="ib" id="openSet" title="Sozlamalar">⚙️</button>
   <input id="q" placeholder="Nik bo'yicha qidirish..." autocapitalize="off">
  </div>
  <div id="stories"></div>
  <div id="list"></div>
 </aside>
 <main>
  <div id="nochat" class="ph">Chatni tanlang</div>
  <div id="chatv" class="hidden" style="display:flex;flex-direction:column;flex:1;min-height:0">
   <div class="head">
    <button class="ib back" id="back">←</button>
    <div class="who" id="who"></div>
   </div>
   <div id="msgs"></div>
   <div id="stk" class="hidden"></div>
   <div id="upst" class="hidden"></div>
   <div class="comp">
    <button class="ib" id="stkb">😊</button>
    <button class="ib" id="att" title="Rasm yoki video">📎</button>
    <input type="file" id="af" accept="image/*,video/*" class="hidden">
    <input id="mi" placeholder="Xabar yozing..." autocomplete="off">
    <button class="ib" id="mic">🎤</button>
    <button class="ib" id="send">➤</button>
   </div>
  </div>
 </main>
</div>

<div id="set" class="ov hidden"><div class="box">
 <div class="row"><b style="font-size:18px">Sozlamalar</b><button class="ib" id="closeSet">✕</button></div>
 <div class="pcenter">
  <div id="sav"></div>
  <button class="sm gray" id="chPhoto" style="max-width:220px">📷 Profil rasmini o'zgartirish</button>
  <input type="file" id="file" accept="image/*" class="hidden">
 </div>
 <h3>Profil</h3>
 <input id="sname" placeholder="Ism">
 <button class="sm" id="saveName">Ismni saqlash</button>
 <input id="snick" placeholder="Nik" style="margin-top:8px" autocapitalize="off">
 <button class="sm" id="saveNick">Nikni saqlash</button>
 <div class="err" id="pe"></div>
 <hr>
 <h3>Ko'rinish</h3>
 <div class="row"><span>🌙 Tungi rejim</span><button class="sm gray" id="themeBtn" style="width:auto;padding:8px 16px"></button></div>
 <hr>
 <h3>Xavfsizlik</h3>
 <div class="row"><span>PIN kod (shu qurilmada)</span><button class="sm gray" id="pinBtn" style="width:auto;padding:8px 16px"></button></div>
 <div id="pinBox" class="hidden">
  <input id="pin1" type="password" inputmode="numeric" maxlength="4" placeholder="4 xonali PIN">
  <button class="sm" id="pinSave">PIN ni saqlash</button>
 </div>
 <hr>
 <h3>Parolni o'zgartirish</h3>
 <input id="op" type="password" placeholder="Eski parol">
 <input id="np" type="password" placeholder="Yangi parol">
 <button class="sm" id="chPass">Parolni o'zgartirish</button>
 <button class="link" id="forgotIn" style="color:#e53935">Parol esdan chiqdi — yangi akkaunt ochish</button>
 <div class="err" id="pwe"></div>
 <hr>
 <button class="sm red" id="logout">Chiqish</button>
</div></div>

<div id="prof" class="ov hidden"><div class="box pcenter" id="profbox"></div></div>

<div id="sadd" class="ov hidden"><div class="box">
 <div class="row"><b style="font-size:18px">Yangi hikoya</b><button class="ib" id="saClose">✕</button></div>
 <div id="sprevbox"></div>
 <textarea id="stext" placeholder="Matn yozing yoki rasm yoki video tanlang..."></textarea>
 <div class="swatches" id="swat"></div>
 <button class="sm gray" id="saPhoto">🖼 Rasm yoki video tanlash</button>
 <input type="file" id="sfile" accept="image/*,video/*" class="hidden">
 <button class="sm" id="saPub" style="margin-top:8px">Joylash (24 soat)</button>
 <div class="err" id="sae" style="margin-top:6px"></div>
</div></div>

<div id="sview" class="hidden">
 <div id="sinner">
  <div id="sbars"></div>
  <div id="shead"></div>
  <div id="sbody"></div>
  <div id="scap" class="hidden"></div>
 </div>
</div>

<div id="iv" class="hidden"><img id="ivimg"></div>

<script>
const $=id=>document.getElementById(id);
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=t=>new Date(t).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
function fh(s){let h1=0xdeadbeef,h2=0x41c6ce57;for(let i=0;i<s.length;i++){const c=s.charCodeAt(i);h1=Math.imul(h1^c,2654435761);h2=Math.imul(h2^c,1597334677)}h1=Math.imul(h1^(h1>>>16),2246822507)^Math.imul(h2^(h2>>>13),3266489909);h2=Math.imul(h2^(h2>>>16),2246822507)^Math.imul(h1^(h1>>>13),3266489909);return 'c'+(4294967296*(2097151&h2)+(h1>>>0)).toString(16)}
const lget=(k,d)=>{try{const v=JSON.parse(localStorage.getItem(k));return v==null?d:v}catch(e){return d}};
const lset=(k,v)=>{try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}};

let token=localStorage.getItem('cg_token')||'',me=null,cur=null,peers={},chats=[],sres=null,seen=new Set(),lastId=0,busy=false,lastChatSig='',pinBuf='';
let stories=[],storyUsers={};

document.querySelectorAll('input[type=password]').forEach(inp=>{
 const w=document.createElement('div');w.className='pw';
 inp.parentNode.insertBefore(w,inp);w.appendChild(inp);
 const b=document.createElement('button');
 b.type='button';b.className='eye';b.tabIndex=-1;b.textContent='👁';
 b.onmousedown=e=>e.preventDefault();
 b.onclick=()=>{const show=inp.type==='password';inp.type=show?'text':'password';b.textContent=show?'🙈':'👁'};
 w.appendChild(b);
});
function resetEyes(){document.querySelectorAll('.pw input').forEach(i=>{i.type='password';const b=i.parentNode.querySelector('.eye');if(b)b.textContent='👁'})}

async function call(path,body){
 let r;
 try{r=await fetch('/api/'+path,{method:body===undefined?'GET':'POST',headers:{'x-token':token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)})}
 catch(e){throw new Error("Server bilan aloqa yo'q")}
 let d={};try{d=await r.json()}catch(e){}
 if(r.status===401&&me){toAuth();throw new Error(d.error||'Qayta kiring')}
 if(!r.ok)throw new Error(d.error||'Xatolik');
 return d;
}
function upload(blob,type,el){
 return new Promise((ok,no)=>{
  const x=new XMLHttpRequest();x.open('POST','/api/upload');
  x.setRequestHeader('x-token',token);x.setRequestHeader('Content-Type',type||blob.type);
  const out=el||$('upst');
  x.upload.onprogress=e=>{if(e.lengthComputable)out.textContent='Yuklanmoqda '+Math.round(e.loaded/e.total*100)+'%'};
  x.onload=()=>{let d={};try{d=JSON.parse(x.responseText)}catch(e){}if(x.status===200&&d.url)ok(d.url);else no(new Error(d.error||"Yuklab bo'lmadi"))};
  x.onerror=()=>no(new Error("Server bilan aloqa yo'q"));
  x.send(blob);
 });
}
function shrink(file,max,q,sq){
 return new Promise((ok,no)=>{
  const img=new Image(),url=URL.createObjectURL(file);
  img.onload=()=>{
   const c=document.createElement('canvas'),x=c.getContext('2d');
   if(sq){const r=Math.min(img.width,img.height);c.width=c.height=max;x.drawImage(img,(img.width-r)/2,(img.height-r)/2,r,r,0,0,max,max)}
   else{const r=Math.min(1,max/Math.max(img.width,img.height));c.width=Math.round(img.width*r);c.height=Math.round(img.height*r);x.drawImage(img,0,0,c.width,c.height)}
   URL.revokeObjectURL(url);
   c.toBlob(b=>b?ok(b):no(new Error('Rasm xatosi')),'image/jpeg',q);
  };
  img.onerror=()=>no(new Error("Rasmni o'qib bo'lmadi"));
  img.src=url;
 });
}

const color=n=>{let h=0;for(const c of n)h=(h*31+c.charCodeAt(0))%360;return 'hsl('+h+',55%,50%)'};
function av(u,size=44){
 u=u||{nick:'?'};
 if(u.avatar)return `<img class="av" style="width:${size}px;height:${size}px" src="${u.avatar}">`;
 return `<div class="av" style="width:${size}px;height:${size}px;background:${color(u.nick)};font-size:${size/2.3}px">${esc((u.name||u.nick||'?')[0].toUpperCase())}</div>`;
}
function setTheme(t){document.documentElement.dataset.theme=t;localStorage.setItem('cg_theme',t);$('themeBtn').textContent=t==='dark'?'Yoqilgan ✓':"O'chiq"}
setTheme(localStorage.getItem('cg_theme')||'light');
$('themeBtn').onclick=()=>setTheme(document.documentElement.dataset.theme==='dark'?'light':'dark');

function rememberAcc(u){const l=lget('cg_dev',[]).filter(x=>x.nick!==u.nick);l.unshift({nick:u.nick,name:u.name,avatar:u.avatar});lset('cg_dev',l.slice(0,8))}
function renderSaved(){
 const l=lget('cg_dev',[]);
 $('saved').innerHTML=l.map(u=>`<div class="chip" data-n="${esc(u.nick)}">${av(u,52)}<span>@${esc(u.nick)}</span></div>`).join('');
 $('saved').querySelectorAll('.chip').forEach(c=>c.onclick=()=>{$('ln').value=c.dataset.n;$('lp').focus()});
}

function showAuth(w){
 ['login','reg','forgot'].forEach(x=>$(x).classList.toggle('hidden',x!==w));
 ['le','re','fe'].forEach(x=>$(x).textContent='');
 resetEyes();if(w==='login')renderSaved();
}
$('toReg').onclick=()=>showAuth('reg');
$('toForgot').onclick=()=>showAuth('forgot');
$('toLogin1').onclick=$('toLogin2').onclick=()=>showAuth('login');
async function doAuth(kind,nEl,pEl,eEl,btn){
 eEl.textContent='';btn.disabled=true;
 try{
  const d=await call(kind,{nick:nEl.value,pass:pEl.value});
  token=d.token;localStorage.setItem('cg_token',token);
  nEl.value=pEl.value='';enter(d.user);
 }catch(e){eEl.textContent=e.message}
 btn.disabled=false;
}
$('lb').onclick=()=>doAuth('login',$('ln'),$('lp'),$('le'),$('lb'));
$('rb').onclick=()=>doAuth('register',$('rn'),$('rp'),$('re'),$('rb'));
$('fb').onclick=()=>doAuth('register',$('fn'),$('fp'),$('fe'),$('fb'));
[['ln','lp','lb'],['rn','rp','rb'],['fn','fp','fb']].forEach(a=>{$(a[0]).onkeydown=$(a[1]).onkeydown=e=>{if(e.key==='Enter')$(a[2]).click()}});

function enter(u){
 me=u;peers[u.nick]=u;rememberAcc(u);
 $('auth').classList.add('hidden');$('lock').classList.add('hidden');$('app').classList.remove('hidden');$('app').classList.remove('open');
 cur=null;$('chatv').classList.add('hidden');$('nochat').classList.remove('hidden');
 chats=[];lastChatSig='';sres=null;$('q').value='';
 renderList();loadChats().catch(()=>{});loadStories();
}
function toAuth(){
 me=null;cur=null;token='';localStorage.removeItem('cg_token');
 $('app').classList.add('hidden');$('set').classList.add('hidden');$('lock').classList.add('hidden');$('app').classList.remove('open');
 showAuth('login');$('auth').classList.remove('hidden');
}
async function logout(){try{await call('logout',{})}catch(e){}toAuth()}
$('logout').onclick=logout;
$('lout').onclick=logout;
$('forgotIn').onclick=async()=>{if(confirm("Akkauntdan chiqib, yangi akkaunt ochasizmi? Eski akkauntga parolsiz kirib bo'lmaydi.")){await logout();showAuth('forgot')}};

function buildPad(){
 const p=$('lpad');p.innerHTML='';
 [1,2,3,4,5,6,7,8,9,'',0,'⌫'].forEach(k=>{const b=document.createElement('button');b.textContent=k;if(k==='')b.style.visibility='hidden';b.onclick=()=>pinKey(k);p.appendChild(b)});
}
function drawDots(){$('ldots').innerHTML=[0,1,2,3].map(i=>`<i class="${i<pinBuf.length?'on':''}"></i>`).join('')}
function pinKey(k){
 if(k==='⌫')pinBuf=pinBuf.slice(0,-1);else if(pinBuf.length<4)pinBuf+=k;
 drawDots();
 if(pinBuf.length===4){
  if(localStorage.getItem('cg_pin_'+me.nick)===fh('pin'+me.nick+pinBuf)){pinBuf='';enter(me)}
  else{$('lerr').textContent="PIN noto'g'ri";pinBuf='';setTimeout(()=>{drawDots();$('lerr').textContent=''},600)}
 }
}
function showLock(){buildPad();pinBuf='';drawDots();$('auth').classList.add('hidden');$('lock').classList.remove('hidden')}

const prev=m=>m.type==='text'?m.content:m.type==='sticker'?m.content+' Stiker':m.type==='voice'?'🎤 Ovozli xabar':m.type==='image'?'📷 Rasm':'🎬 Video';
function renderList(){
 const L=$('list'),q=$('q').value.trim().replace(/^@/,'');
 let h='';
 if(q&&sres!==null){
  h='<div class="lbl">Qidiruv natijalari</div>';
  h+=sres.length?sres.map(u=>`<div class="item" data-n="${esc(u.nick)}">${av(u)}<div class="t"><b>${esc(u.name)}</b><span>@${esc(u.nick)}</span></div></div>`).join(''):'<div class="empty">Bunday nik topilmadi</div>';
 }else{
  h=chats.length?chats.map(c=>`<div class="item ${c.user.nick===cur?'act':''}" data-n="${esc(c.user.nick)}">${av(c.user)}<div class="t"><b>${esc(c.user.name)}</b><span>${c.last.from===me.nick?'Siz: ':''}${esc(prev(c.last))}</span></div><span style="flex:none">${fmt(c.last.ts)}</span></div>`).join(''):'<div class="empty">Hozircha chat yo\'q.<br>Yuqoridagi qidiruvga nik yozib odam toping.</div>';
 }
 L.innerHTML=h;
 L.querySelectorAll('.item').forEach(e=>e.onclick=()=>openChat(e.dataset.n));
}
let st=null;
$('q').oninput=()=>{
 clearTimeout(st);const q=$('q').value.trim().replace(/^@/,'');
 if(!q){sres=null;renderList();return}
 st=setTimeout(async()=>{
  try{
   const d=await call('search?q='+encodeURIComponent(q));
   if($('q').value.trim().replace(/^@/,'')!==q)return;
   sres=d.users;d.users.forEach(u=>peers[u.nick]=u);renderList();
  }catch(e){}
 },250);
};
async function loadChats(){
 const d=await call('chats');
 chats=d.chats;chats.forEach(c=>peers[c.user.nick]=c.user);
 const sig=JSON.stringify(chats);
 if(sig!==lastChatSig){lastChatSig=sig;if(!($('q').value.trim()&&sres!==null))renderList()}
}

async function openChat(n){
 if(!peers[n]){try{peers[n]=(await call('user?nick='+encodeURIComponent(n))).user}catch(e){return}}
 cur=n;lastId=0;seen=new Set();
 const u=peers[n];
 $('q').value='';sres=null;
 $('nochat').classList.add('hidden');$('chatv').classList.remove('hidden');$('app').classList.add('open');
 $('msgs').innerHTML='<div class="ph" id="ph">Xabar yozing 👋</div>';
 $('who').innerHTML=`${av(u,40)}<div><b>${esc(u.name)}</b><div style="font-size:12px;color:var(--sub)">@${esc(u.nick)}</div></div>`;
 $('who').onclick=()=>showProfile(u.nick);
 $('stk').classList.add('hidden');
 renderList();
 try{await loadMsgs()}catch(e){}
}
$('back').onclick=()=>{$('app').classList.remove('open');cur=null;renderList()};
async function loadMsgs(){
 const n=cur;if(!n)return;
 const d=await call('messages?with='+encodeURIComponent(n)+'&after='+lastId);
 if(cur!==n)return;
 addMsgs(d.messages,true);
}
function msgEl(m,after){
 const d=document.createElement('div'),mine=m.from===me.nick,t=fmt(m.ts);
 d.className='m'+(mine?' me':'')+(m.type==='sticker'?' stk':'');
 if(m.type==='sticker')d.textContent=m.content;
 else if(m.type==='voice')d.innerHTML=`<audio controls preload="metadata" src="${m.content}"></audio><small>${t}</small>`;
 else if(m.type==='image'){d.classList.add('media');d.innerHTML=`<img src="${m.content}" loading="lazy"><small>${t}</small>`;const i=d.querySelector('img');i.onload=after;i.onclick=()=>{$('ivimg').src=m.content;$('iv').classList.remove('hidden')}}
 else if(m.type==='video'){d.classList.add('media');d.innerHTML=`<video controls playsinline preload="metadata" src="${m.content}"></video><small>${t}</small>`;d.querySelector('video').onloadedmetadata=after}
 else d.innerHTML=esc(m.content)+`<small>${t}</small>`;
 return d;
}
function addMsgs(list,poll){
 const box=$('msgs');
 let stick=box.scrollHeight-box.scrollTop-box.clientHeight<150;
 for(const m of list){
  if(poll&&m.id>lastId)lastId=m.id;
  if(seen.has(m.id))continue;
  seen.add(m.id);
  const ph=$('ph');if(ph)ph.remove();
  box.appendChild(msgEl(m,()=>{if(stick)box.scrollTop=box.scrollHeight}));
  if(m.from===me.nick)stick=true;
 }
 if(stick)box.scrollTop=box.scrollHeight;
}
async function sendMsg(type,content,to){
 to=to||cur;if(!to||!content)return;
 try{
  const d=await call('send',{to,type,content});
  if(cur===to)addMsgs([d.message],false);
  loadChats().catch(()=>{});
 }catch(e){alert(e.message)}
}
$('send').onclick=()=>{const v=$('mi').value.trim();if(v){sendMsg('text',v);$('mi').value=''}};
$('mi').onkeydown=e=>{if(e.key==='Enter')$('send').click()};
$('iv').onclick=()=>$('iv').classList.add('hidden');

const STK='😀 😂 🤣 😍 🥰 😘 😎 🤩 🥳 😭 😡 🤯 😱 🥶 🤔 🙄 😴 🤤 🤮 😇 😈 👻 💀 🤖 👽 🎃 🙈 🙉 🙊 💩 🐶 🐱 🐭 🐰 🦊 🐻 🐼 🐯 🦁 🐸 🐵 🐔 🐧 🦄 🐢 🐙 🦋 🌹 🔥 💯 ❤️ 💔 💕 🎉 🎁 🏆 ⚽ 🏀 🎮 🎧 🚗 🏎️ ✈️ 🚀 🌍 🌙 ⭐ ☀️ 🌈 🍕 🍔 🍟 🍣 🍩 🍦 ☕ 🍺 👍 👎 👏 🙏 💪 🤝 ✌️ 🤞 👋 🫶'.split(' ');
$('stk').innerHTML=STK.map(s=>`<button>${s}</button>`).join('');
$('stk').querySelectorAll('button').forEach(b=>b.onclick=()=>{sendMsg('sticker',b.textContent);$('stk').classList.add('hidden')});
$('stkb').onclick=()=>$('stk').classList.toggle('hidden');

$('att').onclick=()=>$('af').click();
$('af').onchange=async e=>{
 const f=e.target.files[0];e.target.value='';if(!f||!cur)return;
 const to=cur,box=$('upst');
 box.classList.remove('hidden');box.textContent='Yuklanmoqda...';
 try{
  if(f.type.startsWith('image/')){const b=await shrink(f,1280,.82);sendMsg('image',await upload(b,'image/jpeg'),to)}
  else if(f.type.startsWith('video/')){if(f.size>35e6)throw new Error('Video 35 MB dan oshmasin');sendMsg('video',await upload(f,f.type),to)}
  else throw new Error('Faqat rasm yoki video yuboring');
 }catch(err){alert(err.message)}
 box.classList.add('hidden');
};

let rec=null,chunks=[],stopT=null;
$('mic').onclick=async()=>{
 if(rec){rec.stop();return}
 if(!window.MediaRecorder||!navigator.mediaDevices){alert("Bu brauzerda ovoz yozib bo'lmaydi (HTTPS kerak)");return}
 try{
  const stream=await navigator.mediaDevices.getUserMedia({audio:true}),to=cur;
  rec=new MediaRecorder(stream);chunks=[];
  rec.ondataavailable=e=>chunks.push(e.data);
  rec.onstop=async()=>{
   clearTimeout(stopT);stream.getTracks().forEach(t=>t.stop());
   const blob=new Blob(chunks,{type:rec.mimeType||'audio/webm'});rec=null;
   $('mic').classList.remove('rec');$('mic').textContent='🎤';
   if(blob.size<500)return;
   const box=$('upst');box.classList.remove('hidden');box.textContent='Yuborilmoqda...';
   try{sendMsg('voice',await upload(blob,blob.type),to)}catch(err){alert(err.message)}
   box.classList.add('hidden');
  };
  rec.start();$('mic').classList.add('rec');$('mic').textContent='⏹';
  stopT=setTimeout(()=>rec&&rec.stop(),60000);
 }catch(e){alert("Mikrofonga ruxsat berilmadi")}
};

const BG=['#3390ec','#e91e63','#9c27b0','#ff9800','#2e7d32','#212121'];
let sbg=BG[0],sfileObj=null;
async function loadStories(){
 try{const d=await call('stories');stories=d.stories;storyUsers=d.users;renderStories()}catch(e){}
}
function renderStories(){
 const by={};
 stories.forEach(s=>{(by[s.nick]=by[s.nick]||[]).push(s)});
 const order=Object.keys(by).sort((a,b)=>a===me.nick?-1:b===me.nick?1:by[b][by[b].length-1].ts-by[a][by[a].length-1].ts);
 let h=`<div class="sb" id="addStory"><div class="add">+</div><span>Hikoya</span></div>`;
 h+=order.map(n=>`<div class="sb" data-n="${esc(n)}"><div class="ring"><div>${av(storyUsers[n]||{nick:n},46)}</div></div><span>${n===me.nick?'Siz':esc((storyUsers[n]||{}).name||n)}</span></div>`).join('');
 $('stories').innerHTML=h;
 $('addStory').onclick=openAddStory;
 $('stories').querySelectorAll('.sb[data-n]').forEach(e=>e.onclick=()=>openStories(e.dataset.n));
}
function openAddStory(){
 sfileObj=null;sbg=BG[0];$('stext').value='';$('sprevbox').innerHTML='';$('sae').textContent='';$('saPub').disabled=false;
 $('swat').innerHTML=BG.map((c,i)=>`<i data-c="${c}" style="background:${c}" class="${i?'':'on'}"></i>`).join('');
 $('swat').querySelectorAll('i').forEach(i=>i.onclick=()=>{sbg=i.dataset.c;$('swat').querySelectorAll('i').forEach(x=>x.classList.toggle('on',x===i))});
 $('sadd').classList.remove('hidden');
}
$('saClose').onclick=()=>$('sadd').classList.add('hidden');
$('saPhoto').onclick=()=>$('sfile').click();
$('sfile').onchange=e=>{
 const f=e.target.files[0];e.target.value='';if(!f)return;
 if(!f.type.startsWith('image/')&&!f.type.startsWith('video/')){$('sae').textContent='Faqat rasm yoki video';return}
 if(f.type.startsWith('video/')&&f.size>35e6){$('sae').textContent='Video 35 MB dan oshmasin';return}
 sfileObj=f;$('sae').textContent='';
 const url=URL.createObjectURL(f);
 $('sprevbox').innerHTML=f.type.startsWith('video/')?`<video src="${url}" muted playsinline controls></video>`:`<img src="${url}">`;
};
$('saPub').onclick=async()=>{
 const t=$('stext').value.trim();
 if(!sfileObj&&!t){$('sae').textContent="Matn yozing yoki rasm yoki video tanlang";return}
 $('saPub').disabled=true;$('sae').textContent='Yuklanmoqda...';
 try{
  let body;
  if(sfileObj){
   const isV=sfileObj.type.startsWith('video/');
   const url=isV?await upload(sfileObj,sfileObj.type,$('sae')):await upload(await shrink(sfileObj,1080,.8),'image/jpeg',$('sae'));
   body={type:isV?'video':'image',content:url,caption:t,bg:sbg};
  }else body={type:'text',content:t,bg:sbg};
  await call('story',body);
  $('sadd').classList.add('hidden');loadStories();
 }catch(e){$('sae').textContent=e.message}
 $('saPub').disabled=false;
};
let sv={list:[],i:0,t:null};
function openStories(n){
 const l=stories.filter(s=>s.nick===n);if(!l.length)return;
 sv={list:l,i:0,t:null};$('sview').classList.remove('hidden');showStory();
}
function nextStory(){sv.i++;showStory()}
function showStory(){
 clearTimeout(sv.t);
 const s=sv.list[sv.i];if(!s){closeStories();return}
 const u=storyUsers[s.nick]||{nick:s.nick,name:s.nick};
 $('sbars').innerHTML=sv.list.map((_,i)=>`<i class="${i<sv.i?'full':''}">${i===sv.i?'<b></b>':''}</i>`).join('');
 $('shead').innerHTML=`${av(u,36)}<div class="nm"><b>${esc(u.name||u.nick)}</b><div style="font-size:12px;opacity:.8">${fmt(s.ts)}</div></div>${s.nick===me.nick?'<button id="sdel">🗑</button>':''}<button id="sx">✕</button>`;
 $('sx').onclick=e=>{e.stopPropagation();closeStories()};
 if($('sdel'))$('sdel').onclick=async e=>{
  e.stopPropagation();clearTimeout(sv.t);
  if(!confirm("Hikoyani o'chirasizmi?")){showStory();return}
  try{await call('storydel',{id:s.id})}catch(err){}
  closeStories();loadStories();
 };
 $('sbody').innerHTML=s.type==='image'?`<img src="${s.content}">`:s.type==='video'?`<video autoplay playsinline src="${s.content}"></video>`:`<div class="txt" style="background:${esc(s.bg)}">${esc(s.content)}</div>`;
 const cap=$('scap');
 if(s.caption){cap.textContent=s.caption;cap.classList.remove('hidden')}else cap.classList.add('hidden');
 const bar=$('sbars').querySelector('b');
 const go=sec=>{clearTimeout(sv.t);bar.style.animation='fill '+sec+'s linear forwards';sv.t=setTimeout(nextStory,sec*1000)};
 if(s.type==='video'){
  const v=$('sbody').querySelector('video');
  v.onloadedmetadata=()=>go(Math.min(v.duration||10,60));
  v.play().catch(()=>{v.muted=true;v.play().catch(()=>{})});
  sv.t=setTimeout(nextStory,70000);
 }else go(5);
}
function closeStories(){clearTimeout(sv.t);$('sbody').innerHTML='';$('sview').classList.add('hidden')}
$('sview').onclick=e=>{
 const r=$('sinner').getBoundingClientRect();
 if(e.clientX<r.left+r.width/3)sv.i=Math.max(0,sv.i-1);else sv.i++;
 showStory();
};

function showProfile(n){
 const u=peers[n];if(!u)return;
 const has=stories.some(s=>s.nick===n);
 $('profbox').innerHTML=`${av(u,110)}<h2>${esc(u.name)}</h2><p style="color:var(--sub);margin-bottom:14px">@${esc(u.nick)}</p>${has?`<button class="sm gray" id="pstory" style="margin-bottom:8px">📖 Hikoyasini ko'rish</button>`:''}${n!==me.nick?`<button class="sm" id="pmsg">💬 Xabar yozish</button>`:''}<button class="sm gray" id="pclose" style="margin-top:8px">Yopish</button>`;
 $('prof').classList.remove('hidden');
 $('pclose').onclick=()=>$('prof').classList.add('hidden');
 if($('pmsg'))$('pmsg').onclick=()=>{$('prof').classList.add('hidden');openChat(n)};
 if($('pstory'))$('pstory').onclick=()=>{$('prof').classList.add('hidden');openStories(n)};
}
$('prof').onclick=e=>{if(e.target===$('prof'))$('prof').classList.add('hidden')};

function drawSet(){
 $('sav').innerHTML=av(me,96);$('sav').style.marginBottom='10px';
 $('sname').value=me.name||'';$('snick').value=me.nick;
 $('pinBtn').textContent=localStorage.getItem('cg_pin_'+me.nick)?'Yoqilgan ✓':"O'chiq";
 $('pinBox').classList.add('hidden');['pe','pwe'].forEach(x=>$(x).textContent='');resetEyes();
}
function updateMe(u){me=u;peers[u.nick]=u;rememberAcc(u);drawSet();lastChatSig='';loadChats().catch(()=>{});loadStories()}
$('openSet').onclick=()=>{drawSet();$('set').classList.remove('hidden')};
$('closeSet').onclick=()=>$('set').classList.add('hidden');
$('chPhoto').onclick=()=>$('file').click();
$('file').onchange=async e=>{
 const f=e.target.files[0];e.target.value='';if(!f)return;
 try{
  $('pe').textContent='Yuklanmoqda...';
  const url=await upload(await shrink(f,256,.85,true),'image/jpeg',$('pe'));
  const d=await call('profile',{avatar:url});updateMe(d.user);$('pe').textContent='';
 }catch(err){$('pe').textContent=err.message}
};
$('saveName').onclick=async()=>{
 try{const d=await call('profile',{name:$('sname').value});updateMe(d.user);$('pe').textContent=''}catch(e){$('pe').textContent=e.message}
};
$('saveNick').onclick=async()=>{
 const old=me.nick;
 try{
  const d=await call('nick',{nick:$('snick').value});
  if(d.user.nick!==old){
   localStorage.removeItem('cg_pin_'+old);
   lset('cg_dev',lget('cg_dev',[]).filter(x=>x.nick!==old));
   cur=null;$('chatv').classList.add('hidden');$('nochat').classList.remove('hidden');
  }
  updateMe(d.user);$('pe').textContent='';
 }catch(e){$('pe').textContent=e.message}
};
$('pinBtn').onclick=()=>{
 const k='cg_pin_'+me.nick;
 if(localStorage.getItem(k)){localStorage.removeItem(k);drawSet()}
 else{$('pinBox').classList.remove('hidden');$('pin1').value='';$('pin1').focus()}
};
$('pinSave').onclick=()=>{
 const p=$('pin1').value;
 if(!/^\d{4}$/.test(p)){$('pwe').style.color='';$('pwe').textContent="PIN 4 ta raqamdan iborat bo'lsin";return}
 localStorage.setItem('cg_pin_'+me.nick,fh('pin'+me.nick+p));$('pwe').textContent='';drawSet();
};
$('chPass').onclick=async()=>{
 try{
  await call('password',{old:$('op').value,new:$('np').value});
  $('op').value=$('np').value='';resetEyes();
  $('pwe').style.color='#2e7d32';$('pwe').textContent="Parol o'zgartirildi ✓";
  setTimeout(()=>{$('pwe').textContent='';$('pwe').style.color=''},2500);
 }catch(e){$('pwe').style.color='';$('pwe').textContent=e.message}
};

async function tick(){
 if(!me||busy||document.hidden||$('app').classList.contains('hidden'))return;
 busy=true;
 try{await loadChats();if(cur)await loadMsgs()}catch(e){}
 busy=false;
}
setInterval(tick,2000);
setInterval(()=>{if(me&&!document.hidden&&!$('app').classList.contains('hidden'))loadStories()},10000);

(async function init(){
 if(token){
  try{
   const d=await call('me');me=d.user;peers[me.nick]=me;
   if(localStorage.getItem('cg_pin_'+me.nick))showLock();else enter(me);
   return;
  }catch(e){
   if(e.message.indexOf('aloqa')>=0){me=null;showAuth('login');$('auth').classList.remove('hidden');$('le').textContent=e.message;return}
   me=null;token='';localStorage.removeItem('cg_token');
  }
 }
 showAuth('login');$('auth').classList.remove('hidden');
})();
</script>
</body>
</html>
*/}).toString();
PAGE=PAGE.slice(PAGE.indexOf('/*')+2,PAGE.lastIndexOf('*/'));

server.listen(PORT,()=>console.log('Chatgram ishga tushdi: http://localhost:'+PORT));