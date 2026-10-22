'use strict';
const http=require('node:http'), fs=require('node:fs'), path=require('node:path'), crypto=require('node:crypto');
const {WebSocket,WebSocketServer}=require('ws');
const PORT=Number(process.env.PORT||3000), W=900,H=540, LIMIT=90000, TICK=100, rooms=new Map();
const names=['VEX','NOVA','BYTE','FURY','ZAP','KIRA'], colors=['#48f6d3','#fd6db5','#6ec9ff','#ffcd57','#a895ff','#ff8768'];
const uid=()=>crypto.randomBytes(7).toString('hex');
const code=()=>Array.from(crypto.randomBytes(4),b=>'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b%32]).join('');
const online=r=>r.players.filter(p=>p.bot||p.ws?.readyState===WebSocket.OPEN);
const human=p=>!p.bot&&p.ws?.readyState===WebSocket.OPEN;
const send=(ws,msg)=>{if(ws?.readyState===WebSocket.OPEN)ws.send(JSON.stringify(msg))};
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const random=(a,b)=>a+Math.random()*(b-a);
const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
const addFeed=(r,text)=>{r.feed.push({text,id:uid()});r.feed=r.feed.slice(-7)};
const say=(r,payload)=>{for(const p of r.players)if(human(p))send(p.ws,payload)};
function coin(r){let x,y;let tries=0;do{x=random(38,W-38);y=random(38,H-38);tries++}while(tries<30&&r.players.some(p=>Math.hypot(p.x-x,p.y-y)<70));return {id:uid(),x,y,gold:Math.random()<.19}}
function createRoom(owner,name,solo){
 let c=code();while(rooms.has(c))c=code();
 const r={code:c,phase:'lobby',players:[],coins:[],feed:[],round:0,endsAt:0,startsAt:0,winner:null,solo,createdAt:Date.now()};
 rooms.set(c,r);addPlayer(r,owner,name,false);
 if(solo)for(let i=0;i<3;i++)addPlayer(r,null,names[i],true);
 return r;
}
function addPlayer(r,ws,name,bot){
 const n=r.players.length,p={id:uid(),name:String(name||'Player').replace(/[<>]/g,'').slice(0,18),bot,
 color:colors[n%colors.length],x:70,y:70,vx:0,vy:0,input:{x:0,y:0},score:0,kos:0,combo:0,lastCoin:0,dashUntil:0,dashReady:0,dashHits:[],stunUntil:0,invulnUntil:0,ws};
 r.players.push(p);if(ws){ws.room=r.code;ws.pid=p.id}return p;
}
function detail(r){return {type:'state',code:r.code,phase:r.phase,round:r.round,solo:r.solo,
 players:r.players.map(p=>({id:p.id,name:p.name,bot:p.bot,color:p.color,score:p.score,kos:p.kos,online:p.bot||human(p)})),
 readyCount:online(r).length,endsAt:r.endsAt,feed:r.feed,winner:r.winner,host:r.players.find(p=>!p.bot)?.id};}
function snapshot(r){
 const basic=detail(r);
 const state={...basic,type:'frame',players:r.players.map(p=>({id:p.id,name:p.name,bot:p.bot,color:p.color,x:Math.round(p.x),y:Math.round(p.y),score:p.score,kos:p.kos,combo:p.combo,dashing:p.dashUntil>Date.now(),stunned:p.stunUntil>Date.now(),cooldown:Math.max(0,p.dashReady-Date.now())})),coins:r.coins,remaining:Math.max(0,r.endsAt-Date.now())};
 say(r,state);
}
function announce(r){say(r,detail(r))}
function spawn(p){p.x=random(70,W-70);p.y=random(70,H-70);p.input={x:0,y:0};p.vx=0;p.vy=0;p.stunUntil=0;p.dashUntil=0;p.dashReady=0;p.dashHits=[];p.score=0;p.combo=0;p.kos=0;p.lastCoin=0;}
function start(r){
 if(online(r).length<2)return false;
 r.round++;r.phase='playing';r.winner=null;r.startsAt=Date.now();r.endsAt=r.startsAt+LIMIT;
 r.coins=Array.from({length:20},()=>coin(r));r.feed=[];
 for(const p of r.players)spawn(p);
 addFeed(r,'ROUND '+r.round+' — GRAB. DASH. STEAL. WIN.');
 snapshot(r);return true;
}
function finish(r){
 if(r.phase!=='playing')return;
 r.phase='results';const ranks=[...r.players].sort((a,b)=>b.score-a.score||b.kos-a.kos);
 r.winner=ranks[0]?{id:ranks[0].id,name:ranks[0].name,score:ranks[0].score}:null;
 addFeed(r,(r.winner?.name||'Nobody')+' wins the arena!');snapshot(r);
}
function dash(p,r,now){
 if(r.phase!=='playing'||now<p.dashReady||now<p.stunUntil)return;
 let x=clamp(p.input.x,-1,1),y=clamp(p.input.y,-1,1),len=Math.hypot(x,y);
 if(len<.15){x=1;y=0;len=1}
 p.vx=x/len;p.vy=y/len;p.dashUntil=now+270;p.dashReady=now+3700;p.dashHits=[];
}
function botThink(r,p,now){
 const rival=r.players.filter(a=>a!==p&&a.score>p.score+20).sort((a,b)=>dist(p,a)-dist(p,b))[0];
 let target=null;
 if(rival&&dist(p,rival)<125&&now>=p.dashReady){target=rival}
 if(!target)target=[...r.coins].sort((a,b)=>(dist(p,a)-(a.gold?65:0))-(dist(p,b)-(b.gold?65:0)))[0];
 if(!target)return;
 const dx=target.x-p.x,dy=target.y-p.y,n=Math.hypot(dx,dy)||1;
 p.input={x:dx/n,y:dy/n};
 if(rival&&target===rival&&dist(p,rival)<105&&now>=p.dashReady)dash(p,r,now);
 else if(dist(p,target)>160&&now>=p.dashReady&&Math.random()<.045)dash(p,r,now);
}
function simulation(r,now){
 if(r.phase!=='playing')return;
 if(now>=r.endsAt){finish(r);return}
 for(const p of r.players){
  if(p.bot)botThink(r,p,now);
  if(now<p.stunUntil)continue;
  const d=now<p.dashUntil,n=Math.hypot(p.input.x,p.input.y)||1,spd=d?630:185;
  const vx=d?p.vx:p.input.x/n,vy=d?p.vy:p.input.y/n;
  p.x=clamp(p.x+vx*spd*TICK/1000,18,W-18);
  p.y=clamp(p.y+vy*spd*TICK/1000,18,H-18);
  for(let i=r.coins.length-1;i>=0;i--){
   const c=r.coins[i];if(Math.hypot(p.x-c.x,p.y-c.y)>21)continue;
   const combo=now-p.lastCoin<2300?Math.min(p.combo+1,5):1;
   p.combo=combo;p.lastCoin=now;p.score+=(c.gold?25:10)+(combo>=3?5:0);
   if(c.gold)addFeed(r,p.name+' snatched a GOLD +25!');
   else if(combo===4)addFeed(r,p.name+' is on a 4x streak!');
   r.coins.splice(i,1);r.coins.push(coin(r));
  }
  if(!d)continue;
  for(const target of r.players){
   if(target===p||p.dashHits.includes(target.id)||now<target.invulnUntil||dist(p,target)>33)continue;
   p.dashHits.push(target.id);
   const stolen=Math.min(30,target.score);
   const bonus=target.score>=p.score?20:10;
   target.score-=stolen;p.score+=stolen+bonus;p.kos++;
   target.stunUntil=now+350;target.invulnUntil=now+1100;
   const dx=target.x-p.x,dy=target.y-p.y,len=Math.hypot(dx,dy)||1;
   target.x=clamp(target.x+dx/len*35,18,W-18);
   target.y=clamp(target.y+dy/len*35,18,H-18);
   addFeed(r,p.name+' tagged '+target.name+'! +'+(stolen+bonus));
  }
 }
 snapshot(r);
}
const root=path.join(__dirname,'public');
const files={'/':'index.html','/index.html':'index.html'};
const server=http.createServer((req,res)=>{
 const pathname=new URL(req.url,'http://localhost').pathname;
 if(pathname==='/healthz'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({ok:true,game:'NEON HEIST',rooms:rooms.size}))}
 const file=files[pathname];if(!file){res.writeHead(404);return res.end('Not found')}
 fs.readFile(path.join(root,file),(err,data)=>{if(err){res.writeHead(500);return res.end('Missing game client')}res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache'});res.end(data)})
});
const wss=new WebSocketServer({server,path:'/ws'});
wss.on('connection',ws=>{
 ws.isAlive=true;ws.on('pong',()=>{ws.isAlive=true});
 ws.on('message',buffer=>{
  if(buffer.length>2048)return;
  let m;try{m=JSON.parse(buffer.toString())}catch{return}
  if(!m||typeof m!=='object')return;
  if(m.type==='create'){
   if(ws.room)return;
   const r=createRoom(ws,String(m.name||'Player'),!!m.solo);
   const p=r.players[0];send(ws,{type:'joined',code:r.code,id:p.id});
   if(r.solo)start(r);else announce(r);return;
  }
  if(m.type==='join'){
   if(ws.room)return;
   const c=String(m.code||'').toUpperCase(),r=rooms.get(c);
   if(!r)return send(ws,{type:'error',message:'Room not found'});
   let p=r.players.find(v=>v.id===m.id&&!v.bot);
   if(p){if(p.ws&&p.ws!==ws){try{p.ws.close()}catch{}}p.ws=ws;ws.room=c;ws.pid=p.id}
   else{if(r.phase!=='lobby')return send(ws,{type:'error',message:'Round already running'});
    if(r.players.length>=6)return send(ws,{type:'error',message:'Room is full'});
    p=addPlayer(r,ws,String(m.name||'Player'),false)}
   send(ws,{type:'joined',code:c,id:p.id});if(r.phase==='playing'||r.phase==='results')snapshot(r);else announce(r);return;
  }
  const r=rooms.get(ws.room),p=r?.players.find(v=>v.id===ws.pid);
  if(!r||!p||p.ws!==ws)return;
  if(m.type==='start'&&r.phase!=='playing'&&r.players.find(v=>!v.bot)?.id===p.id){start(r);return}
  if(m.type==='input'){p.input={x:clamp(Number(m.x)||0,-1,1),y:clamp(Number(m.y)||0,-1,1)};return}
  if(m.type==='dash'){dash(p,r,Date.now());return}
  if(m.type==='leave'){p.ws=null;ws.room=null;ws.pid=null;announce(r)}
 });
 ws.on('close',()=>{
  const r=rooms.get(ws.room),p=r?.players.find(v=>v.id===ws.pid);
  if(p&&p.ws===ws){p.ws=null;p.input={x:0,y:0};if(r.phase==='lobby')r.players=r.players.filter(x=>x.bot||human(x));announce(r)}
 });
});
setInterval(()=>{const now=Date.now();for(const [key,r] of rooms){
 if(r.phase==='playing')simulation(r,now);
 if(!r.players.some(human)&&now-r.createdAt>180000)rooms.delete(key);
}},TICK).unref();
setInterval(()=>{for(const ws of wss.clients){if(ws.isAlive===false){ws.terminate();continue}ws.isAlive=false;ws.ping()}},25000).unref();
server.listen(PORT,'0.0.0.0',()=>console.log('NEON HEIST ready on '+PORT));