import type { Graph } from "./model.js";

export const DEFAULT_MAX_NODES = 400;
const MAX_SYMBOLS = 40;

/** File-to-file edges only (package nodes are left out), limited to the `max` best connected files. */
export function graphData(g: Graph, max = DEFAULT_MAX_NODES) {
  const degree = new Map<string, number>();
  const links = g.edges.filter((e) => e.kind !== "declares" && e.from.startsWith("file:") && e.to.startsWith("file:") && e.from !== e.to);
  for (const e of links) for (const id of [e.from, e.to]) degree.set(id, (degree.get(id) ?? 0) + 1);
  const connected = [...degree.keys()].sort((a, b) => degree.get(b)! - degree.get(a)! || a.localeCompare(b));
  const keep = new Set(connected.slice(0, Math.max(1, max)));
  const unique = new Map<string, (typeof links)[number]>();
  for (const e of links) if (keep.has(e.from) && keep.has(e.to)) unique.set(`${e.from}>${e.to}>${e.evidence}`, e);
  const edges = [...unique.values()];
  const syms = new Map<string, Array<[string, string, number]>>();
  for (const n of g.nodes) {
    if (n.kind !== "symbol" || !n.path || !keep.has(`file:${n.path}`)) continue;
    const list = syms.get(n.path) ?? [];
    if (list.length < MAX_SYMBOLS) list.push([n.name, n.detail ?? "", n.lines?.[0] ?? 0]);
    syms.set(n.path, list);
  }
  return {
    root: g.root,
    total: Object.keys(g.files).length,
    shown: keep.size,
    connected: connected.length,
    nodes: [...keep].sort((a, b) => a.localeCompare(b)).map((id) => ({ id: id.slice(5), degree: degree.get(id)!, missing: !g.files[id.slice(5)], syms: (syms.get(id.slice(5)) ?? []).sort((a, b) => a[2] - b[2] || a[0].localeCompare(b[0])) })),
    edges: edges.map((e) => ({ from: e.from.slice(5), to: e.to.slice(5), kind: e.kind, evidence: e.evidence })),
  };
}

/**
 * Self-contained force-directed graph page (no server, no network, no libraries). File names are drawn with
 * canvas fillText or inserted with textContent, never innerHTML, because they are untrusted input.
 */
export function renderGraphHtml(g: Graph, max = DEFAULT_MAX_NODES): string {
  const json = JSON.stringify(graphData(g, max)).replace(/</g, "\\u003c").replace(/[\u2028\u2029]/g, " ");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>codebasetograph graph</title>
<style>
:root{--bg:#fff;--fg:#1d2330;--mut:#667;--line:#dde1ea;--ok:#1a7f4b;--warn:#b26a00;--bad:#c0342b}
@media (prefers-color-scheme:dark){:root{--bg:#14171f;--fg:#e6e9f0;--mut:#9aa3b5;--line:#2b3140;--ok:#4cc38a;--warn:#e0a040;--bad:#ff7b72}}
*{box-sizing:border-box}body{margin:0;font:14px/1.45 system-ui,sans-serif;background:var(--bg);color:var(--fg);height:100vh;display:flex;flex-direction:column}
header{display:flex;gap:12px;align-items:center;padding:8px 12px;border-bottom:1px solid var(--line);flex-wrap:wrap}
header input{padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);min-width:200px}
.mut{color:var(--mut)}.k{display:inline-block;width:18px;height:3px;vertical-align:middle;margin:0 4px 0 10px}
#wrap{flex:1;position:relative;min-height:0}canvas{width:100%;height:100%;display:block;cursor:grab}
#info{position:absolute;right:12px;top:12px;max-width:320px;max-height:70%;overflow:auto;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px 12px;display:none;overflow-wrap:anywhere}
#info h3{margin:0 0 6px;font-size:14px}#info div{padding:2px 0}
</style></head><body>
<header><input id="q" placeholder="Search files" aria-label="Search"><span id="stat" class="mut"></span>
<span><i class="k" style="background:var(--ok)"></i>resolved<i class="k" style="background:var(--warn)"></i>inferred<i class="k" style="background:var(--bad)"></i>unresolved</span>
<span class="mut">colour = folder · click a file for links and symbols · drag · scroll to zoom</span></header>
<div id="wrap"><canvas id="c"></canvas><div id="info"></div></div>
<script id="data" type="application/json">${json}</script>
<script>
const D=JSON.parse(document.getElementById('data').textContent);
const cv=document.getElementById('c'),ctx=cv.getContext('2d'),info=document.getElementById('info'),q=document.getElementById('q');
const css=n=>getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const idx=new Map(D.nodes.map((n,i)=>[n.id,i]));
// cluster = project folder + innermost folder, generic path parts skipped (frontend/src/app/apps/snake/x.ts -> frontend/snake)
const GENERIC=new Set(['src','main','test','tests','java','kotlin','app','apps','lib','dev','com','org','io','net','resources','dist','packages']);
const folder=p=>{const d=p.split('/').slice(0,-1),k=d.filter(x=>!GENERIC.has(x));return k.length?(k.length>1?k[0]+'/'+k[k.length-1]:k[0]):(d.pop()||'.')};
const hue=s=>{let h=0;for(const c of s)h=(h*31+c.charCodeAt(0))%360;return h};
const N=D.nodes.map((n,i)=>({...n,i,x:Math.cos(i*2.4)*Math.sqrt(i+1)*30,y:Math.sin(i*2.4)*Math.sqrt(i+1)*30,vx:0,vy:0,r:4+Math.min(10,Math.sqrt(n.degree)*1.6),hue:hue(folder(n.id)),f:folder(n.id)}));
const E=D.edges.map(e=>({a:idx.get(e.from),b:idx.get(e.to),ev:e.evidence,kind:e.kind}));
const nb=N.map(()=>new Set());for(const e of E){nb[e.a].add(e.b);nb[e.b].add(e.a)}
// force layout: repulsion between near pairs (grid cells), springs along edges, pull to the folder centre and the middle.
// Runs a few iterations per animation frame so the page stays responsive and draws while it settles.
function step(cool){
  const grid=new Map(),cen=new Map();
  for(const n of N){const k=Math.floor(n.x/500)+','+Math.floor(n.y/500);let a=grid.get(k);if(!a)grid.set(k,a=[]);a.push(n);
    let c=cen.get(n.f);if(!c)cen.set(n.f,c={x:0,y:0,n:0});c.x+=n.x;c.y+=n.y;c.n++}
  for(const n of N){
    const cx=Math.floor(n.x/500),cy=Math.floor(n.y/500);
    for(let gx=cx-1;gx<=cx+1;gx++)for(let gy=cy-1;gy<=cy+1;gy++){const a=grid.get(gx+','+gy);if(!a)continue;
      for(const m of a){if(m.i<=n.i)continue;
        let dx=n.x-m.x,dy=n.y-m.y,d2=dx*dx+dy*dy+0.01;if(d2>250000)continue;
        const f=1800/d2,d=Math.sqrt(d2);dx=dx/d*f;dy=dy/d*f;n.vx+=dx;n.vy+=dy;m.vx-=dx;m.vy-=dy}}}
  for(const e of E){const a=N[e.a],b=N[e.b],dx=b.x-a.x,dy=b.y-a.y,d=Math.sqrt(dx*dx+dy*dy)+0.01,f=(d-70)*0.02;
    a.vx+=dx/d*f;a.vy+=dy/d*f;b.vx-=dx/d*f;b.vy-=dy/d*f}
  for(const n of N){const c=cen.get(n.f);n.vx+=(c.x/c.n-n.x)*0.006-n.x*0.003;n.vy+=(c.y/c.n-n.y)*0.006-n.y*0.003;
    const m=Math.hypot(n.vx,n.vy),cap=12*cool+1;if(m>cap){n.vx*=cap/m;n.vy*=cap/m}
    n.x+=n.vx;n.y+=n.vy;n.vx*=0.6;n.vy*=0.6}
}
let it=0,touched=false;const TOTAL=N.length>600?160:N.length>250?220:300;
function tick(){
  for(let k=0;k<6&&it<TOTAL;k++,it++)step(1-it/TOTAL);
  if(!touched)fit();draw();
  if(it<TOTAL)requestAnimationFrame(tick);
}
let W=0,H=0,dpr=1,scale=1,ox=0,oy=0,sel=-1,hover=-1,term='',drag=null;
function fit(){
  if(!N.length)return;
  let x0=1e9,x1=-1e9,y0=1e9,y1=-1e9;for(const n of N){x0=Math.min(x0,n.x);x1=Math.max(x1,n.x);y0=Math.min(y0,n.y);y1=Math.max(y1,n.y)}
  scale=Math.min(W/(x1-x0+80),H/(y1-y0+80),2);ox=W/2-(x0+x1)/2*scale;oy=H/2-(y0+y1)/2*scale;
}
function resize(){dpr=window.devicePixelRatio||1;W=cv.clientWidth;H=cv.clientHeight;cv.width=W*dpr;cv.height=H*dpr;fit();draw()}
const evCol=ev=>ev==='unresolved'?css('--bad'):ev==='inferred'?css('--warn'):css('--ok');
function draw(){
  ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,W,H);
  const focus=sel>=0?sel:hover,dim=focus>=0||term;
  const match=n=>!term||n.id.toLowerCase().includes(term);
  const lit=i=>focus>=0?(i===focus||nb[focus].has(i)):match(N[i]);
  for(const e of E){
    const on=focus>=0?(e.a===focus||e.b===focus):(!term||(match(N[e.a])&&match(N[e.b])));
    ctx.globalAlpha=on?0.85:(dim?0.06:0.35);ctx.strokeStyle=evCol(e.ev);ctx.lineWidth=on&&focus>=0?1.8:1;
    ctx.beginPath();ctx.moveTo(N[e.a].x*scale+ox,N[e.a].y*scale+oy);ctx.lineTo(N[e.b].x*scale+ox,N[e.b].y*scale+oy);ctx.stroke()}
  const dark=matchMedia('(prefers-color-scheme:dark)').matches;
  for(const n of N){
    const on=lit(n.i);ctx.globalAlpha=on?1:0.15;
    ctx.fillStyle='hsl('+n.hue+','+(dark?'60%,62%':'65%,45%')+')';
    ctx.beginPath();ctx.arc(n.x*scale+ox,n.y*scale+oy,n.r*Math.min(scale,1.6)+1,0,6.2832);ctx.fill();
    if(n.i===sel){ctx.strokeStyle=css('--fg');ctx.lineWidth=2;ctx.stroke()}
  }
  ctx.globalAlpha=1;ctx.fillStyle=css('--fg');ctx.font='11px system-ui,sans-serif';
  for(const n of N){
    const show=n.i===focus||(focus>=0&&nb[focus].has(n.i))||(term&&match(n))||(focus<0&&!term&&(scale>1.4||n.degree>=Math.max(10,N.length/12)));
    if(show)ctx.fillText(n.id.split('/').pop(),n.x*scale+ox+n.r*Math.min(scale,1.6)+3,n.y*scale+oy+4);
  }
  if(focus<0&&!term){
    const cen=new Map();for(const n of N){let c=cen.get(n.f);if(!c)cen.set(n.f,c={x:0,y:0,n:0,h:n.hue});c.x+=n.x;c.y+=n.y;c.n++}
    ctx.font='bold 13px system-ui,sans-serif';ctx.globalAlpha=0.45;
    for(const[f,c]of cen)if(c.n>=3){const nm=f.split('/').pop();ctx.fillStyle='hsl('+c.h+','+(dark?'60%,70%':'65%,35%')+')';ctx.fillText(nm,c.x/c.n*scale+ox-ctx.measureText(nm).width/2,c.y/c.n*scale+oy)}
    ctx.globalAlpha=1;ctx.font='11px system-ui,sans-serif';
  }
  document.getElementById('stat').textContent=D.shown+' of '+D.connected+' linked files'+(D.shown<D.connected?' (truncated, most connected shown)':'')+' · '+D.total+' files indexed';
}
function pick(px,py){let best=-1,bd=1e9;for(const n of N){const d=Math.hypot(n.x*scale+ox-px,n.y*scale+oy-py);if(d<n.r*Math.min(scale,1.6)+5&&d<bd){bd=d;best=n.i}}return best}
function showInfo(){
  info.replaceChildren();if(sel<0){info.style.display='none';return}
  const n=N[sel];info.style.display='block';const h=document.createElement('h3');h.textContent=n.id;info.append(h);
  const add=(label,e,other)=>{const d=document.createElement('div');d.textContent=label+' '+N[other].id+' · '+e.kind+' · '+e.ev;d.style.color=evCol(e.ev);info.append(d)};
  for(const e of E)if(e.a===sel)add('→',e,e.b);
  for(const e of E)if(e.b===sel)add('←',e,e.a);
  if(n.syms.length){const t=document.createElement('h3');t.textContent='Symbols';t.style.marginTop='10px';info.append(t);
    for(const[name,detail,line]of n.syms){const d=document.createElement('div');d.className='mut';d.textContent=(detail?detail+' ':'')+name+(line?' :'+line:'');info.append(d)}}
}
const pos=ev=>{const r=cv.getBoundingClientRect();return[ev.clientX-r.left,ev.clientY-r.top]};
cv.onmousedown=ev=>{touched=true;const[x,y]=pos(ev),i=pick(x,y);drag={x,y,ox,oy,node:i,moved:false};cv.style.cursor='grabbing'};
window.onmousemove=ev=>{
  const[x,y]=pos(ev);
  if(drag){const dx=x-drag.x,dy=y-drag.y;if(Math.abs(dx)+Math.abs(dy)>3)drag.moved=true;
    if(drag.node>=0){N[drag.node].x=(x-ox)/scale;N[drag.node].y=(y-oy)/scale}else{ox=drag.ox+dx;oy=drag.oy+dy}draw();return}
  const h=pick(x,y);if(h!==hover){hover=h;draw()}
};
window.onmouseup=()=>{if(drag&&!drag.moved){sel=drag.node===sel?-1:drag.node;showInfo()}drag=null;cv.style.cursor='grab';draw()};
cv.onwheel=ev=>{touched=true;ev.preventDefault();const[x,y]=pos(ev),f=ev.deltaY<0?1.15:1/1.15;ox=x-(x-ox)*f;oy=y-(y-oy)*f;scale*=f;draw()};
q.oninput=()=>{term=q.value.trim().toLowerCase();draw()};
window.onresize=()=>{touched=false;resize()};resize();requestAnimationFrame(tick);
</script></body></html>`;
}
