'use strict';
const http=require('http'),crypto=require('crypto'),fs=require('fs'),path=require('path');
const {WebSocketServer,WebSocket}=require('ws');
const PORT=Number(process.env.PORT||3000),rooms=new Map(),SIZE=13,ROUND=180000;
const root=path.join(__dirname,'public');
const server=http.createServer((req,res)=>{
  const u=new URL(req.url,'http://localhost');
  if(u.pathname==='/healthz'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({status:'ok'}));}
  const f={'/':'index.html','/index.html':'index.html','/style.css':'style.css','/app.js':'app.js','/favicon.svg':'favicon.svg'}[u.pathname];
  if(!f){res.writeHead(404);return res.end('Not found');}
  fs.readFile(path.join(root,f),(err,data)=>{if(err){res.writeHead(404);return res.end('Not found');}res.writeHead(200,{'Content-Type':({html:'text/html; charset=utf-8',css:'text/css',js:'text/javascript',svg:'image/svg+xml'})[f.split('.').at(-1)],'Cache-Control':'no-store'});res.end(data)});
});
const wss=new WebSocketServer({server,path:'/ws'});
const id=()=>crypto.randomBytes(8).toString('hex');
const randomCode=()=>Array.from(crypto.randomBytes(4),v=>'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[v%32]).join('');
const online=r=>r.players.filter(p=>p.ws&&p.ws.readyState===WebSocket.OPEN);
const send=(p,o)=>{if(p?.ws?.readyState===WebSocket.OPEN)p.ws.send(JSON.stringify(o))};
const note=(r,msg)=>{r.messages.push({name:'SYSTEM',text:msg});r.messages=r.messages.slice(-30)};
function maze(){
 let a=Array.from({length:SIZE},()=>Array(SIZE).fill(1));
 const stack=[[1,1]];a[1][1]=0;
 while(stack.length){
  const [x,y]=stack.at(-1);
  const options=[[2,0],[-2,0],[0,2],[0,-2]].map(([dx,dy])=>[x+dx,y+dy,dx,dy]).filter(([nx,ny])=>nx>0&&ny>0&&nx<SIZE-1&&ny<SIZE-1&&a[ny][nx]);
  if(!options.length){stack.pop();continue}
  const [nx,ny,dx,dy]=options[Math.floor(Math.random()*options.length)];
  a[y+dy/2][x+dx/2]=0;a[ny][nx]=0;stack.push([nx,ny]);
 }
 const open=[];a.forEach((row,y)=>row.forEach((v,x)=>{if(!v&&!(x===1&&y===1))open.push([x,y])}));
 open.sort(()=>Math.random()-.5);
 return {grid:a,exit:[SIZE-2,SIZE-2],fragments:open.filter(([x,y])=>!(x===SIZE-2&&y===SIZE-2)).slice(0,3)};
}
function publish(r){
 for(const p of r.players){
 if(!p.ws||p.ws.readyState!==WebSocket.OPEN)continue;
 const runner=p.id===r.runnerId;
 const sector=p.id===r.runnerId?-1:r.players.filter(q=>q.id!==r.runnerId).findIndex(q=>q.id===p.id);
 const view=r.grid?.map((row,y)=>row.map((v,x)=>{
 if(r.phase!=='playing')return v;
 if(runner)return Math.abs(x-r.position[0])+Math.abs(y-r.position[1])<=2?v:-1;
 return ((x+y+sector*4)%9<6)?v:-1;
 }));
 send(p,{type:'state',code:r.code,me:p.id,hostId:r.hostId,runnerId:r.runnerId,players:r.players.map(({id,name,score,ws})=>({id,name,score,online:!!ws&&ws.readyState===WebSocket.OPEN})),
 phase:r.phase,grid:view,position:r.position,exit:r.exit,fragments:r.fragments,found:r.found,beacons:r.beacons,messages:r.messages,endsAt:r.endsAt,result:r.result,round:r.round,role:runner?'RUNNER':'SCOUT',score:p.score});
 }
}
function finish(r,won,reason){if(r.phase!=='playing')return;r.phase='result';r.result={won,reason};if(won){const pts=Math.max(100,Math.floor((r.endsAt-Date.now())/1000)*10);for(const p of r.players)p.score+=pts;note(r,'Mission completed. +' + pts + ' points for the crew!')}else note(r,'Mission failed: '+reason);publish(r)}
function start(r){
 if(online(r).length<2)return false;
 const m=maze();r.grid=m.grid;r.exit=m.exit;r.fragments=m.fragments;r.found=[];r.position=[1,1];r.beacons=[];r.phase='playing';r.endsAt=Date.now()+ROUND;r.result=null;r.round++;r.runnerId=online(r)[(r.round-1)%online(r).length].id;note(r,'Mission launched! Collect the signals and reach the exit.');publish(r);return true;
}
function join(ws,m){
 const code=String(m.code||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,4);
 const name=String(m.name||'Player').replace(/[<>]/g,'').trim().slice(0,18)||'Player';
 const r=rooms.get(code);if(!r)return ws.send(JSON.stringify({type:'error',message:'Room not found'}));
 let p=r.players.find(p=>p.id===m.id);if(!p){if(online(r).length>=6)return ws.send(JSON.stringify({type:'error',message:'Room is full'}));p={id:id(),name,score:0,ws:null};r.players.push(p);}
 if(p.ws&&p.ws!==ws)try{p.ws.close()}catch{}
 p.ws=ws;p.name=name;ws.room=code;ws.pid=p.id;if(!r.hostId||!r.players.find(t=>t.id===r.hostId&&t.ws))r.hostId=p.id;
 ws.send(JSON.stringify({type:'joined',code,id:p.id,name}));note(r,name+' joined the crew');publish(r);
}
wss.on('connection',ws=>{
 ws.on('message',raw=>{
 let m;try{if(raw.length>8192)return;m=JSON.parse(raw.toString())}catch{return}
 if(m.type==='create'){
 let code=randomCode();while(rooms.has(code))code=randomCode();
 rooms.set(code,{code,hostId:null,runnerId:null,players:[],phase:'lobby',grid:null,round:0,found:[],fragments:[],beacons:[],messages:[],endsAt:0,result:null});join(ws,{...m,code});return;
 }
 if(m.type==='join'){join(ws,m);return}
 const r=rooms.get(ws.room);if(!r)return;
 const p=r.players.find(q=>q.id===ws.pid);if(!p||p.ws!==ws)return;
 if(m.type==='leave'){p.ws=null;ws.room=null;ws.pid=null;publish(r);return}
 if(m.type==='chat'){const text=String(m.text||'').trim().slice(0,180);if(text){r.messages.push({name:p.name,text});r.messages=r.messages.slice(-30);publish(r)}}
 else if(m.type==='start'&&p.id===r.hostId&&r.phase!=='playing')start(r);
 else if(m.type==='move'&&r.phase==='playing'&&p.id===r.runnerId){
  const d={up:[0,-1],down:[0,1],left:[-1,0],right:[1,0]}[m.dir];if(!d)return;
  const x=r.position[0]+d[0],y=r.position[1]+d[1];if(r.grid[y]?.[x]!==0){send(p,{type:'bump'});return}
  r.position=[x,y];const ix=r.fragments.findIndex(q=>q[0]===x&&q[1]===y);
  if(ix!==-1&&!r.found.includes(ix)){r.found.push(ix);note(r,'Signal fragment secured ('+r.found.length+'/3)')}
  if(x===r.exit[0]&&y===r.exit[1]&&r.found.length===3)finish(r,true,'Escaped!');
  else publish(r);
 }
 else if(m.type==='beacon'&&r.phase==='playing'&&p.id!==r.runnerId){
  const x=Number(m.x),y=Number(m.y);
  if(Number.isInteger(x)&&Number.isInteger(y)&&x>=0&&y>=0&&x<SIZE&&y<SIZE){r.beacons.push({x,y,name:p.name,until:Date.now()+9000});r.beacons=r.beacons.slice(-20);publish(r)}
 }
 });
 ws.on('close',()=>{
  const r=rooms.get(ws.room);if(!r)return;const p=r.players.find(t=>t.id===ws.pid);
  if(p&&p.ws===ws)p.ws=null;
  if(r.hostId===ws.pid)r.hostId=online(r)[0]?.id||null;
  if(r.phase==='playing'&&r.runnerId===ws.pid){const other=online(r)[0];if(other){r.runnerId=other.id;note(r,other.name+' is now Runner')}else finish(r,false,'Crew disconnected')}
  publish(r);
 });
});
setInterval(()=>{for(const [code,r] of rooms){
 if(r.phase==='playing'&&Date.now()>=r.endsAt)finish(r,false,'Time expired');
 if(r.beacons.length)r.beacons=r.beacons.filter(b=>b.until>Date.now());
 if(!online(r).length&&r.phase!=='playing')rooms.delete(code);
 else if(r.phase==='playing')publish(r);
}},1000).unref();
server.listen(PORT,'0.0.0.0',()=>console.log('BLINDSPOT online port '+PORT));
