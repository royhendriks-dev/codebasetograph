import type { Graph } from "./model.js";

/** Compact payload for the viewer: only what the page needs. */
export function viewData(g: Graph) {
  return {
    root: g.root,
    files: Object.values(g.files).map((f) => ({
      path: f.path,
      parseError: f.parseError,
      symbols: f.symbols.map((s) => ({ name: s.name, detail: s.detail, lines: s.lines, exported: !!s.exported })),
    })),
    edges: g.edges.filter((e) => e.kind !== "declares").map((e) => ({
      from: e.from.replace(/^file:/, ""), to: e.to.replace(/^(file|pkg):/, ""), pkg: e.to.startsWith("pkg:"),
      kind: e.kind, evidence: e.evidence, line: e.line, specifier: e.specifier,
    })),
  };
}

/**
 * Self-contained HTML page (no server, no network). All repository-derived text is inserted with
 * textContent, never innerHTML, because file and symbol names are untrusted input.
 */
export function renderHtml(g: Graph): string {
  const json = JSON.stringify(viewData(g)).replace(/</g, "\\u003c").replace(/[\u2028\u2029]/g, " ");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>codebasetograph</title>
<style>
:root{--bg:#fff;--fg:#1d2330;--mut:#667;--line:#dde1ea;--acc:#2456d6;--ok:#1a7f4b;--warn:#b26a00;--bad:#c0342b}
@media (prefers-color-scheme:dark){:root{--bg:#14171f;--fg:#e6e9f0;--mut:#9aa3b5;--line:#2b3140;--acc:#7aa2ff;--ok:#4cc38a;--warn:#e0a040;--bad:#ff7b72}}
*{box-sizing:border-box}body{margin:0;font:14px/1.45 system-ui,sans-serif;background:var(--bg);color:var(--fg);display:grid;grid-template-columns:minmax(220px,340px) 1fr;height:100vh}
aside{border-right:1px solid var(--line);display:flex;flex-direction:column;min-height:0}
aside input{margin:12px;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}
#list{overflow:auto;flex:1}#list div{padding:5px 12px;cursor:pointer;overflow-wrap:anywhere}#list div:hover,#list .sel{background:color-mix(in srgb,var(--acc) 15%,transparent)}
main{overflow:auto;padding:16px 24px}h1{font-size:18px;margin:0 0 4px;overflow-wrap:anywhere}h2{font-size:13px;text-transform:uppercase;letter-spacing:.05em;color:var(--mut);margin:20px 0 6px}
.row{padding:3px 0;overflow-wrap:anywhere}a{color:var(--acc);cursor:pointer;text-decoration:underline}
.badge{font-size:11px;border:1px solid currentColor;border-radius:9px;padding:0 7px;margin-left:6px;white-space:nowrap}
.extracted,.resolved{color:var(--ok)}.inferred{color:var(--warn)}.unresolved{color:var(--bad)}.mut{color:var(--mut)}
@media (max-width:640px){body{grid-template-columns:1fr;height:auto}aside{max-height:40vh}}
</style></head><body>
<aside><input id="q" placeholder="Search files and symbols" aria-label="Search"><div id="list"></div></aside>
<main id="main"><p class="mut">Select a file. Green = extracted/resolved (fact). Amber = inferred (verify). Red = unresolved (graph may miss links).</p></main>
<script id="data" type="application/json">${json}</script>
<script>
const D=JSON.parse(document.getElementById('data').textContent);
const byPath=new Map(D.files.map(f=>[f.path,f]));
const $=(t,c,x)=>{const e=document.createElement(t);if(c)e.className=c;if(x!==undefined)e.textContent=x;return e};
const list=document.getElementById('list'),main=document.getElementById('main'),q=document.getElementById('q');
let current=null;
function renderList(){
  const t=q.value.trim().toLowerCase();list.replaceChildren();
  const hits=D.files.filter(f=>!t||f.path.toLowerCase().includes(t)||f.symbols.some(s=>s.name.toLowerCase().includes(t))).slice(0,500);
  for(const f of hits){const d=$('div',f.path===current?'sel':'',f.path);d.onclick=()=>show(f.path);list.append(d)}
  if(!hits.length)list.append($('div','mut','No matches'));
}
function badge(ev){return $('span','badge '+ev,ev)}
function edgeRow(label,e,target,line){
  const r=$('div','row');
  if(target&&byPath.has(target)){const a=$('a','',label);a.onclick=()=>show(target);r.append(a)}else r.append($('span','',label));
  if(line)r.append($('span','mut',':'+line));
  r.append(badge(e.evidence));if(e.evidence==='unresolved')r.append($('span','mut',' ('+e.specifier+')'));
  return r;
}
function show(p){
  current=p;const f=byPath.get(p);renderList();main.replaceChildren();
  main.append($('h1','',p));
  if(f.parseError)main.append($('div','row unresolved','Syntax errors found; symbols and imports may be incomplete.'));
  main.append($('h2','','Declares ('+f.symbols.length+')'));
  for(const s of f.symbols){const r=$('div','row');r.append($('span','',s.name));r.append($('span','mut',' '+(s.detail||'')+(s.exported?' · exported':'')+(s.lines?' · L'+s.lines[0]+'-'+s.lines[1]:'')));main.append(r)}
  const out=D.edges.filter(e=>e.from===p),inn=D.edges.filter(e=>e.to===p&&!e.pkg);
  main.append($('h2','','Imports ('+out.length+')'));
  for(const e of out)main.append(edgeRow(e.pkg?e.to:e.to,e,e.pkg?null:e.to,e.line));
  main.append($('h2','','Imported by ('+inn.length+')'));
  for(const e of inn)main.append(edgeRow(e.from,e,e.from,e.line));
}
q.oninput=renderList;renderList();
</script></body></html>`;
}
