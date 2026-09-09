import { db } from "../core/firebase.js";
import {
  collection, getDocs, query, where, collectionGroup
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";

// ── Score helpers ────────────────────────────────────────────────────────────
function clamp(v,mn,mx){return Math.max(mn,Math.min(mx,v));}
function calcHooper(h){if(h==null)return null;return Math.round(clamp(100-((h-4)/24*100),0,100));}
function calcCMJ(cm){if(cm==null)return null;if(cm<30)return 25;if(cm<35)return 40;if(cm<40)return 52;if(cm<45)return 65;if(cm<50)return 78;return 90;}
function calcVFC(ln){if(ln==null)return null;let s;if(ln<2.5)s=5+(ln-1.5)*20;else if(ln<3.0)s=25+(ln-2.5)*20;else if(ln<3.5)s=35+(ln-3.0)*30;else if(ln<4.0)s=50+(ln-3.5)*36;else if(ln<4.5)s=68+(ln-4.0)*28;else if(ln<5.0)s=82+(ln-4.5)*20;else s=92+Math.min((ln-5.0)*6,5);return Math.round(Math.max(5,Math.min(s,97)));}
function mapNeuro(n){if(n==='estavel')return 70;if(n==='leve_atencao')return 60;if(n==='atencao')return 45;if(n==='instavel')return 25;return null;}
function calcGlobal(vals){const v=vals.filter(x=>x!=null);if(!v.length)return null;const a=v.reduce((s,b)=>s+b,0)/v.length;return Math.round((a*0.8+Math.max(Math.min(...v),30)*0.2)*10)/10;}
function calcProntidao(dm){const IH=calcHooper(dm?.pre?.hooper??null);const IA=calcVFC(dm?.hrv?.lnRR??null);const INM=calcCMJ(dm?.pre?.salto??null);const IC=dm?.neuro?.score!=null?Math.round(clamp(dm.neuro.score,0,100)):mapNeuro(dm?.neuro?.classificacao);return{IH,IA,INM,IC,global:calcGlobal([IH,IA,INM,IC])};}
function fatorQ(q){return q==null?1.0:0.85+(q-1)*0.0625;}

// ── Date helpers ─────────────────────────────────────────────────────────────
function getMondayStr(dateStr){const d=new Date(dateStr+'T00:00:00');const day=d.getDay();d.setDate(d.getDate()+(day===0?-6:1-day));return d.toISOString().slice(0,10);}
function fmtData(str){if(!str)return '—';const[y,m,d]=str.split('-');return`${d}/${m}/${y}`;}
function fmtDataCurta(str){if(!str)return '—';const[,m,d]=str.split('-');return`${d}/${m}`;}

// ── Math helpers ─────────────────────────────────────────────────────────────
function avg(arr){const v=arr.filter(x=>x!=null);return v.length?v.reduce((a,b)=>a+b,0)/v.length:null;}
function avgRound(arr){const a=avg(arr);return a!=null?Math.round(a):null;}
function fmtI(v){return v!=null?Math.round(v):'—';}
function fmtF(v,d=1){return v!=null?(+v).toFixed(d):'—';}
function pct(n,t){return t>0?Math.round(n/t*100):0;}

// ── Escapes ──────────────────────────────────────────────────────────────────
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

// ── SVG Charts ───────────────────────────────────────────────────────────────
function svgLineChart(values, labels, opts={}){
  const W=opts.w||700, H=opts.h||180;
  const pad={l:44,r:16,t:14,b:36};
  const cW=W-pad.l-pad.r, cH=H-pad.t-pad.b;
  const valid=values.filter(v=>v!=null);
  if(!valid.length) return `<svg width="${W}" height="${H}"><text x="${W/2}" y="${H/2}" text-anchor="middle" fill="#999" font-size="12">Sem dados</text></svg>`;
  const mn=opts.yMin!=null?opts.yMin:Math.min(...valid)*0.92;
  const mx=opts.yMax!=null?opts.yMax:Math.max(...valid,opts.refValue??0)*1.05;
  const range=mx-mn||1;
  const xOf=i=>pad.l+i/(values.length-1||1)*cW;
  const yOf=v=>pad.t+cH-(v-mn)/range*cH;
  let path='', dots='';
  let started=false, prev=null;
  values.forEach((v,i)=>{
    if(v==null){started=false;prev=null;return;}
    const x=xOf(i), y=yOf(v);
    if(!started){path+=`M${x},${y}`;started=true;}
    else path+=`L${x},${y}`;
    dots+=`<circle cx="${x}" cy="${y}" r="3" fill="${opts.color||'#1a56db'}"/>`;
    prev={x,y};
  });
  // y-axis ticks
  let yAxis='';
  const ticks=4;
  for(let i=0;i<=ticks;i++){
    const v=mn+(mx-mn)*i/ticks;
    const y=yOf(v);
    yAxis+=`<line x1="${pad.l}" x2="${W-pad.r}" y1="${y}" y2="${y}" stroke="#e5e7eb" stroke-width="1"/>`;
    yAxis+=`<text x="${pad.l-4}" y="${y+4}" text-anchor="end" fill="#6b7280" font-size="9">${Math.round(v)}</text>`;
  }
  // x labels
  let xLabels='';
  const step=Math.max(1,Math.ceil(labels.length/10));
  labels.forEach((l,i)=>{
    if(i%step!==0&&i!==labels.length-1)return;
    xLabels+=`<text x="${xOf(i)}" y="${H-4}" text-anchor="middle" fill="#6b7280" font-size="9">${esc(l)}</text>`;
  });
  // ref line
  let refLine='';
  if(opts.refValue!=null){
    const y=yOf(opts.refValue);
    if(y>=pad.t&&y<=H-pad.b){
      refLine=`<line x1="${pad.l}" x2="${W-pad.r}" y1="${y}" y2="${y}" stroke="#dc2626" stroke-width="1" stroke-dasharray="4,3"/>`;
      if(opts.refLabel) refLine+=`<text x="${W-pad.r-2}" y="${y-3}" text-anchor="end" fill="#dc2626" font-size="8">${esc(opts.refLabel)}</text>`;
    }
  }
  return `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${yAxis}${refLine}<path d="${path}" fill="none" stroke="${opts.color||'#1a56db'}" stroke-width="2"/>${dots}${xLabels}</svg>`;
}

function svgBarChart(values, labels, colors, opts={}){
  const W=opts.w||600, H=opts.h||180;
  const pad={l:44,r:10,t:14,b:36};
  const cW=W-pad.l-pad.r, cH=H-pad.t-pad.b;
  const valid=values.filter(v=>v!=null&&v>0);
  if(!valid.length) return `<svg width="${W}" height="${H}"><text x="${W/2}" y="${H/2}" text-anchor="middle" fill="#999" font-size="12">Sem dados</text></svg>`;
  const mx=opts.maxVal||Math.max(...valid)*1.1||1;
  const bW=cW/values.length*0.65, gap=cW/values.length;
  let bars='', xLab='';
  // y ticks
  let yAxis='';
  for(let i=0;i<=4;i++){
    const v=mx*i/4;
    const y=pad.t+cH-cH*i/4;
    yAxis+=`<line x1="${pad.l}" x2="${W-pad.r}" y1="${y}" y2="${y}" stroke="#e5e7eb" stroke-width="1"/>`;
    yAxis+=`<text x="${pad.l-4}" y="${y+4}" text-anchor="end" fill="#6b7280" font-size="9">${Math.round(v)}</text>`;
  }
  values.forEach((v,i)=>{
    const x=pad.l+i*gap+(gap-bW)/2;
    const h=v!=null&&v>0?cH*v/mx:0;
    const y=pad.t+cH-h;
    const col=(Array.isArray(colors)?colors[i]:colors)||'#1a56db';
    bars+=`<rect x="${x}" y="${y}" width="${bW}" height="${h}" fill="${col}" rx="2"/>`;
    if(v!=null) bars+=`<text x="${x+bW/2}" y="${y-3}" text-anchor="middle" fill="#374151" font-size="8">${Math.round(v)}</text>`;
    xLab+=`<text x="${x+bW/2}" y="${H-4}" text-anchor="middle" fill="#6b7280" font-size="9">${esc(labels[i]||'')}</text>`;
  });
  return `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${yAxis}${bars}${xLab}</svg>`;
}

// ── Vertical field helpers ───────────────────────────────────────────────────
function _seededRng(seed){
  let s=(((seed|0)*2654435761)>>>0)||1;
  return()=>{s=(s*1664525+1013904223)>>>0;return s/4294967296;};
}

function _vFieldBase(W,H){
  const mx=10,goalH=8,topLbl=14;
  const fw=W-mx*2,fh=H-topLbl-mx-goalH*2;
  const fx=mx,fy=topLbl+goalH;
  const cx=Math.round(fx+fw/2),cy=Math.round(fy+fh/2);
  const cr=Math.round(Math.min(fw,fh)*0.09);
  const paW=Math.round(fw*0.55),paH=Math.round(fh*0.21);
  const gaW=Math.round(fw*0.32),gaH=Math.round(fh*0.09);
  const goalW=Math.round(fw*0.22);
  const paX=Math.round(cx-paW/2),gaX=Math.round(cx-gaW/2),goalX=Math.round(cx-goalW/2);
  // Sector boundaries: ataque=top third, meio=middle third, defesa=bottom third
  const sY1=Math.round(fy+fh/3);
  const sY2=Math.round(fy+fh*2/3);
  let e='';
  e+=`<rect width="${W}" height="${H}" fill="#f0f4f8" rx="8"/>`;
  e+=`<rect x="${fx}" y="${fy}" width="${fw}" height="${fh}" fill="#d4edda" rx="2"/>`;
  for(let i=0;i<6;i++)e+=`<rect x="${fx+i*(fw/6)}" y="${fy}" width="${fw/12}" height="${fh}" fill="#c2e0ca" opacity="0.6"/>`;
  // Sector tints
  e+=`<rect x="${fx}" y="${fy}" width="${fw}" height="${Math.round(fh/3)}" fill="rgba(59,130,246,0.06)"/>`;
  e+=`<rect x="${fx}" y="${sY2}" width="${fw}" height="${Math.round(fh/3)}" fill="rgba(239,68,68,0.06)"/>`;
  e+=`<rect x="${fx}" y="${fy}" width="${fw}" height="${fh}" fill="none" stroke="rgba(0,0,0,0.45)" stroke-width="1.4" rx="2"/>`;
  e+=`<line x1="${fx}" y1="${cy}" x2="${fx+fw}" y2="${cy}" stroke="rgba(0,0,0,0.4)" stroke-width="1.1"/>`;
  e+=`<circle cx="${cx}" cy="${cy}" r="${cr}" fill="none" stroke="rgba(0,0,0,0.4)" stroke-width="1.1"/>`;
  e+=`<circle cx="${cx}" cy="${cy}" r="2.5" fill="rgba(0,0,0,0.4)"/>`;
  e+=`<rect x="${paX}" y="${fy}" width="${paW}" height="${paH}" fill="none" stroke="rgba(0,0,0,0.4)" stroke-width="1.1"/>`;
  e+=`<rect x="${gaX}" y="${fy}" width="${gaW}" height="${gaH}" fill="none" stroke="rgba(0,0,0,0.4)" stroke-width="1.1"/>`;
  e+=`<rect x="${goalX}" y="${fy-goalH}" width="${goalW}" height="${goalH}" fill="none" stroke="rgba(0,0,0,0.3)" stroke-width="1.1"/>`;
  e+=`<rect x="${paX}" y="${fy+fh-paH}" width="${paW}" height="${paH}" fill="none" stroke="rgba(0,0,0,0.4)" stroke-width="1.1"/>`;
  e+=`<rect x="${gaX}" y="${fy+fh-gaH}" width="${gaW}" height="${gaH}" fill="none" stroke="rgba(0,0,0,0.4)" stroke-width="1.1"/>`;
  e+=`<rect x="${goalX}" y="${fy+fh}" width="${goalW}" height="${goalH}" fill="none" stroke="rgba(0,0,0,0.3)" stroke-width="1.1"/>`;
  // Sector dividers (dashed)
  e+=`<line x1="${fx}" y1="${sY1}" x2="${fx+fw}" y2="${sY1}" stroke="rgba(0,0,0,0.25)" stroke-width="1" stroke-dasharray="5,3"/>`;
  e+=`<line x1="${fx}" y1="${sY2}" x2="${fx+fw}" y2="${sY2}" stroke="rgba(0,0,0,0.25)" stroke-width="1" stroke-dasharray="5,3"/>`;
  // Sector labels
  e+=`<text x="${fx+6}" y="${fy+13}" fill="rgba(0,0,0,0.45)" font-size="7.5" font-family="Inter" font-weight="700">ATAQUE</text>`;
  e+=`<text x="${fx+6}" y="${sY1+Math.round(fh/6)+4}" fill="rgba(0,0,0,0.45)" font-size="7.5" font-family="Inter" font-weight="700">MEIO</text>`;
  e+=`<text x="${fx+6}" y="${sY2+Math.round(fh/6)+4}" fill="rgba(0,0,0,0.45)" font-size="7.5" font-family="Inter" font-weight="700">DEFESA</text>`;
  return{e,fx,fy,fw,fh,cx,cy,cr,paH,gaH,goalX,goalW,topLbl,sY1,sY2};
}

function _dotsInSector(n,sector,fx,fy,fw,fh,cy,paH,seedBase,maxDots,sY1,sY2){
  const rng=_seededRng(seedBase);
  const cnt=n;
  const xMin=fx+fw*0.08,xMax=fx+fw*0.92;
  let yMin,yMax;
  // Use the same third-based boundaries as the visual sector lines
  const _sY1=sY1??(Math.round(fy+fh/3));
  const _sY2=sY2??(Math.round(fy+fh*2/3));
  if(sector==='ataque'){yMin=fy+6;yMax=_sY1-6;}
  else if(sector==='defesa'){yMin=_sY2+6;yMax=fy+fh-6;}
  else{yMin=_sY1+6;yMax=_sY2-6;}
  const pts=[];
  for(let i=0;i<cnt;i++)pts.push({x:Math.round(xMin+rng()*(xMax-xMin)),y:Math.round(yMin+rng()*(yMax-yMin))});
  return pts;
}

// Draws one vertical field with dots and returns SVG string (no outer <svg>)
function _vertCampoInner(W,H,setorData,colorFn,maxDots,seedOffset){
  const f=_vFieldBase(W,H);
  let d='';
  ['ataque','meio','defesa'].forEach((sec,si)=>{
    const n=setorData[sec]||0;
    _dotsInSector(n,sec,f.fx,f.fy,f.fw,f.fh,f.cy,f.paH,(seedOffset||0)+si*997+n*13,maxDots,f.sY1,f.sY2).forEach(p=>{
      const {fill,stroke}=colorFn(sec);
      d+=`<circle cx="${p.x}" cy="${p.y}" r="2" fill="${fill}" opacity="0.85" stroke="${stroke}" stroke-width="0.5"/>`;
    });
    // Count badge in top-right of each sector
    const secMidY=sec==='ataque'?Math.round((f.fy+f.sY1)/2):sec==='meio'?Math.round((f.sY1+f.sY2)/2):Math.round((f.sY2+f.fy+f.fh)/2);
    const {fill:fc}=colorFn(sec);
    d+=`<rect x="${f.fx+f.fw-26}" y="${secMidY-9}" width="24" height="16" rx="4" fill="rgba(255,255,255,0.75)" stroke="${fc}" stroke-width="1"/>`;
    d+=`<text x="${f.fx+f.fw-14}" y="${secMidY+4}" text-anchor="middle" fill="${fc}" font-size="10" font-weight="800" font-family="Inter">${n}</text>`;
  });
  return f.e+d;
}

function svgCampoDuelos(setorDuelTotals){
  const FW=460,FH=420,GAP=46;
  const totalW=FW*2+GAP,H=FH;
  const totDG=Object.values(setorDuelTotals).reduce((s,v)=>s+(v.dg||0),0);
  const totDP=Object.values(setorDuelTotals).reduce((s,v)=>s+(v.dp||0),0);
  const dgData={ataque:setorDuelTotals.ataque?.dg||0,meio:setorDuelTotals.meio?.dg||0,defesa:setorDuelTotals.defesa?.dg||0};
  const dpData={ataque:setorDuelTotals.ataque?.dp||0,meio:setorDuelTotals.meio?.dp||0,defesa:setorDuelTotals.defesa?.dp||0};
  const dgInner=_vertCampoInner(FW,FH,dgData,()=>({fill:'#3b82f6',stroke:'#1d4ed8'}),40,1001);
  const dpInner=_vertCampoInner(FW,FH,dpData,()=>({fill:'#f87171',stroke:'#dc2626'}),40,2002);
  return`<svg width="${totalW}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <g transform="translate(0,0)">${dgInner}</g>
    <text x="${FW/2}" y="11" text-anchor="middle" fill="rgba(255,255,255,0.9)" font-size="9.5" font-family="Archivo" font-weight="800">DUELOS GANHOS</text>
    <text x="${FW/2}" y="${H-4}" text-anchor="middle" fill="rgba(255,255,255,0.7)" font-size="8" font-family="Inter">${totDG} eventos</text>
    <g transform="translate(${FW+GAP},0)">${dpInner}</g>
    <text x="${FW+GAP+FW/2}" y="11" text-anchor="middle" fill="rgba(255,255,255,0.9)" font-size="9.5" font-family="Archivo" font-weight="800">DUELOS PERDIDOS</text>
    <text x="${FW+GAP+FW/2}" y="${H-4}" text-anchor="middle" fill="rgba(255,255,255,0.7)" font-size="8" font-family="Inter">${totDP} eventos</text>
  </svg>`;
}

function svgCampoDecisoes(setorDecTotals){
  const FW=310,FH=320,GAP=28;
  const totalW=FW*3+GAP*2,H=FH;
  const series=[
    {key:'bd',label:'BOAS DECISÕES',fill:'#22c55e',stroke:'#16a34a',seed:3003},
    {key:'erNF',label:'ERROS NF',fill:'#fb923c',stroke:'#ea580c',seed:4004},
    {key:'erP',label:'ERROS PRESSÃO',fill:'#f87171',stroke:'#dc2626',seed:5005},
  ];
  let svgInner='';
  series.forEach(({key,label,fill,stroke,seed},fi)=>{
    const data={ataque:setorDecTotals.ataque?.[key]||0,meio:setorDecTotals.meio?.[key]||0,defesa:setorDecTotals.defesa?.[key]||0};
    const total=Object.values(data).reduce((s,v)=>s+v,0);
    const inner=_vertCampoInner(FW,FH,data,()=>({fill,stroke}),35,seed);
    const dx=fi*(FW+GAP);
    svgInner+=`<g transform="translate(${dx},0)">${inner}</g>`;
    svgInner+=`<text x="${dx+FW/2}" y="11" text-anchor="middle" fill="rgba(255,255,255,0.9)" font-size="9" font-family="Archivo" font-weight="800">${label}</text>`;
    svgInner+=`<text x="${dx+FW/2}" y="${H-4}" text-anchor="middle" fill="rgba(255,255,255,0.7)" font-size="8" font-family="Inter">${total} eventos</text>`;
  });
  return`<svg width="${totalW}" height="${H}" xmlns="http://www.w3.org/2000/svg">${svgInner}</svg>`;
}

function svgCampoRoubadas(setorRoubadaTotals){
  const FW=310,FH=320,GAP=28;
  const totalW=FW*3+GAP*2,H=FH;
  const series=[
    {key:'po',label:'PRESSÃO OFENSIVA',fill:'#fb923c',stroke:'#ea580c',seed:9001},
    {key:'pp',label:'PÓS-PERDA',fill:'#60a5fa',stroke:'#2563eb',seed:9002},
    {key:'cb',label:'COMBATE',fill:'#a78bfa',stroke:'#7c3aed',seed:9003},
  ];
  let svgInner='';
  series.forEach(({key,label,fill,stroke,seed},fi)=>{
    const data={ataque:setorRoubadaTotals.ataque?.[key]||0,meio:setorRoubadaTotals.meio?.[key]||0,defesa:setorRoubadaTotals.defesa?.[key]||0};
    const total=Object.values(data).reduce((s,v)=>s+v,0);
    const inner=_vertCampoInner(FW,FH,data,()=>({fill,stroke}),35,seed);
    const dx=fi*(FW+GAP);
    svgInner+=`<g transform="translate(${dx},0)">${inner}</g>`;
    svgInner+=`<text x="${dx+FW/2}" y="11" text-anchor="middle" fill="rgba(255,255,255,0.9)" font-size="9" font-family="Archivo" font-weight="800">${label}</text>`;
    svgInner+=`<text x="${dx+FW/2}" y="${H-4}" text-anchor="middle" fill="rgba(255,255,255,0.7)" font-size="8" font-family="Inter">${total} eventos</text>`;
  });
  return`<svg width="${totalW}" height="${H}" xmlns="http://www.w3.org/2000/svg">${svgInner}</svg>`;
}

function svgCampoFinalizacoes(allEventsList,nJogos){
  const FW=460,FH=420,GAP=46;
  const totalW=FW*2+GAP,H=FH;
  // Classify shots by sector based on setor field or default to 'ataque'
  const shots=allEventsList.filter(e=>e.action==='Finalização');
  const shotsAdv=allEventsList.filter(e=>e.action==='Finalização adversária');
  function getSector(e){
    const s=(e.setor||e.sector||'ataque').toLowerCase();
    if(s.includes('def'))return'defesa';
    if(s.includes('mei'))return'meio';
    return'ataque';
  }
  const finData={ataque:0,meio:0,defesa:0};
  const advData={ataque:0,meio:0,defesa:0};
  shots.forEach(e=>{finData[getSector(e)]++;});
  shotsAdv.forEach(e=>{advData[getSector(e)]++;});
  // If no sector data, put all in ataque (shots usually happen in attack zone)
  if(!shots.length){finData.ataque=1;}
  if(!shotsAdv.length){advData.defesa=1;}
  const finInner=_vertCampoInner(FW,FH,finData,()=>({fill:'#3b82f6',stroke:'#1d4ed8'}),35,7007);
  const advInner=_vertCampoInner(FW,FH,advData,()=>({fill:'#f87171',stroke:'#dc2626'}),35,8008);
  const avgFin=nJogos>0?(shots.length/nJogos).toFixed(1):'—';
  const avgAdv=nJogos>0?(shotsAdv.length/nJogos).toFixed(1):'—';
  return`<svg width="${totalW}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <g transform="translate(0,0)">${finInner}</g>
    <text x="${FW/2}" y="11" text-anchor="middle" fill="rgba(255,255,255,0.9)" font-size="9.5" font-family="Archivo" font-weight="800">FINALIZAÇÕES</text>
    <text x="${FW/2}" y="${H-4}" text-anchor="middle" fill="rgba(255,255,255,0.7)" font-size="8" font-family="Inter">${shots.length} total · ${avgFin}/jogo</text>
    <g transform="translate(${FW+GAP},0)">${advInner}</g>
    <text x="${FW+GAP+FW/2}" y="11" text-anchor="middle" fill="rgba(255,255,255,0.9)" font-size="9.5" font-family="Archivo" font-weight="800">FINALIZAÇÕES ADVERSÁRIAS</text>
    <text x="${FW+GAP+FW/2}" y="${H-4}" text-anchor="middle" fill="rgba(255,255,255,0.7)" font-size="8" font-family="Inter">${shotsAdv.length} total · ${avgAdv}/jogo</text>
  </svg>`;
}

function svgMultiLineChart(series, labels, opts={}){
  const W=opts.w||700, H=opts.h||200;
  const legH=series.length*14+10;
  const pad={l:44,r:16,t:14,b:36+legH};
  const cW=W-pad.l-pad.r, cH=H-pad.t-pad.b;
  const allVals=series.flatMap(s=>s.data).filter(v=>v!=null);
  if(!allVals.length) return `<svg width="${W}" height="${H}"><text x="${W/2}" y="${H/2}" text-anchor="middle" fill="#999" font-size="12">Sem dados</text></svg>`;
  const refVals=(opts.refLines||[]).map(r=>r.v);
  const mn=Math.min(...allVals,...refVals)*0.9;
  const mx=Math.max(...allVals,...refVals)*1.05;
  const range=mx-mn||1;
  const xOf=i=>pad.l+i/(labels.length-1||1)*cW;
  const yOf=v=>pad.t+cH-(v-mn)/range*cH;
  let yAxis='';
  for(let i=0;i<=4;i++){
    const v=mn+(mx-mn)*i/4;
    const y=yOf(v);
    yAxis+=`<line x1="${pad.l}" x2="${W-pad.r}" y1="${y}" y2="${y}" stroke="#e5e7eb" stroke-width="1"/>`;
    yAxis+=`<text x="${pad.l-4}" y="${y+4}" text-anchor="end" fill="#6b7280" font-size="9">${Math.round(v)}</text>`;
  }
  let refLines='';
  (opts.refLines||[]).forEach(r=>{
    const y=yOf(r.v);
    if(y<pad.t||y>H-pad.b)return;
    refLines+=`<line x1="${pad.l}" x2="${W-pad.r}" y1="${y}" y2="${y}" stroke="${r.color||'#dc2626'}" stroke-width="1" stroke-dasharray="4,3"/>`;
    if(r.label) refLines+=`<text x="${W-pad.r-2}" y="${y-3}" text-anchor="end" fill="${r.color||'#dc2626'}" font-size="8">${esc(r.label)}</text>`;
  });
  let paths='',dots='';
  series.forEach(s=>{
    let d=''; let started=false;
    s.data.forEach((v,i)=>{
      if(v==null){started=false;return;}
      const x=xOf(i),y=yOf(v);
      if(!started){d+=`M${x},${y}`;started=true;}else d+=`L${x},${y}`;
      dots+=`<circle cx="${x}" cy="${y}" r="2.5" fill="${s.color}"/>`;
    });
    if(d) paths+=`<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2"/>`;
  });
  let xLab='';
  const step=Math.max(1,Math.ceil(labels.length/10));
  labels.forEach((l,i)=>{if(i%step!==0&&i!==labels.length-1)return;xLab+=`<text x="${xOf(i)}" y="${H-pad.b+14}" text-anchor="middle" fill="#6b7280" font-size="9">${esc(l)}</text>`;});
  let legend='';
  series.forEach((s,i)=>{
    legend+=`<rect x="${pad.l+i*120}" y="${H-legH+4}" width="12" height="6" fill="${s.color}" rx="2"/>`;
    legend+=`<text x="${pad.l+i*120+16}" y="${H-legH+11}" fill="#4b5563" font-size="10">${esc(s.name)}</text>`;
  });
  return `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${yAxis}${refLines}${paths}${dots}${xLab}${legend}</svg>`;
}

function svgPieChart(data, opts={}){
  const W=opts.w||160, H=opts.h||160;
  const cx=W/2, cy=H/2, r=Math.min(W,H)/2-8;
  const total=data.reduce((s,d)=>s+(d.value||0),0);
  if(!total) return `<svg width="${W}" height="${H}"><text x="${cx}" y="${cy+4}" text-anchor="middle" fill="#999" font-size="11">Sem dados</text></svg>`;
  let slices=''; let angle=-Math.PI/2;
  data.forEach(d=>{
    if(!d.value)return;
    const a=2*Math.PI*d.value/total;
    const x1=cx+r*Math.cos(angle), y1=cy+r*Math.sin(angle);
    const x2=cx+r*Math.cos(angle+a), y2=cy+r*Math.sin(angle+a);
    const lg=a>Math.PI?1:0;
    slices+=`<path d="M${cx},${cy}L${x1},${y1}A${r},${r},0,${lg},1,${x2},${y2}Z" fill="${d.color||'#999'}" stroke="#fff" stroke-width="1.5"/>`;
    angle+=a;
  });
  return `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${slices}</svg>`;
}

function svgMiniBarWDL(V,E,D){
  const tot=V+E+D||1, W=120, H=20;
  const wV=W*V/tot, wE=W*E/tot, wD=W*D/tot;
  return `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" style="border-radius:4px;overflow:hidden">
    <rect x="0" y="0" width="${wV}" height="${H}" fill="#16a34a"/>
    <rect x="${wV}" y="0" width="${wE}" height="${H}" fill="#ca8a04"/>
    <rect x="${wV+wE}" y="0" width="${wD}" height="${H}" fill="#dc2626"/>
    ${V>0?`<text x="${wV/2}" y="13" text-anchor="middle" fill="#fff" font-size="9" font-weight="700">${V}V</text>`:''}
    ${E>0?`<text x="${wV+wE/2}" y="13" text-anchor="middle" fill="#fff" font-size="9" font-weight="700">${E}E</text>`:''}
    ${D>0?`<text x="${wV+wE+wD/2}" y="13" text-anchor="middle" fill="#fff" font-size="9" font-weight="700">${D}D</text>`:''}
  </svg>`;
}

// ── % Ataque por bloco 15' ──────────────────────────────────────────────────
function svgSetorAtaqueBloco(pctValues, blkLabels, opts={}){
  const w=opts.w||480, h=opts.h||120;
  const pl=36, pr=12, pt=12, pb=28;
  const cw=w-pl-pr, ch=h-pt-pb;
  const n=pctValues.length;
  const barW=Math.floor(cw/n*0.6);
  const gap=cw/n;
  const maxV=100;
  let bars='', labels='', vals='';
  const fixedMax=50;
  pctValues.forEach((v,i)=>{
    const x=pl+i*gap+gap/2;
    if(v==null){
      labels+=`<text x="${x}" y="${h-pb+14}" text-anchor="middle" fill="#9ca3af" font-size="9" font-family="Inter,sans-serif">${blkLabels[i]||''}</text>`;
      return;
    }
    const bh=Math.round(ch*Math.min(v,fixedMax)/fixedMax);
    const by=pt+ch-bh;
    bars+=`<rect x="${Math.round(x-barW/2)}" y="${by}" width="${barW}" height="${bh}" rx="2" fill="#3b82f6" opacity="0.85"/>`;
    vals+=`<text x="${x}" y="${by-3}" text-anchor="middle" fill="#e2e8f0" font-size="8" font-weight="700" font-family="Inter,sans-serif">${v}%</text>`;
    labels+=`<text x="${x}" y="${h-pb+14}" text-anchor="middle" fill="#9ca3af" font-size="9" font-family="Inter,sans-serif">${blkLabels[i]||''}</text>`;
  });
  // y-axis lines at 0, 10, 20, 30, 40, 50
  let grid='';
  [0,10,20,30,40,50].forEach(pct=>{
    const y=pt+ch-Math.round(ch*pct/fixedMax);
    grid+=`<line x1="${pl}" y1="${y}" x2="${w-pr}" y2="${y}" stroke="#374151" stroke-width="0.5"/>`;
    grid+=`<text x="${pl-4}" y="${y+3}" text-anchor="end" fill="#6b7280" font-size="8" font-family="Inter,sans-serif">${pct}</text>`;
  });
  return `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">${grid}${bars}${vals}${labels}</svg>`;
}

// ── Smooth area line chart for possession % ────────────────────────────────────
function svgSetorAtaqueSmoothLine(pctValues, opts={}){
  const w=opts.w||1050, h=opts.h||130;
  const pl=36, pr=14, pt=16, pb=26;
  const cw=w-pl-pr, ch=h-pt-pb;
  const total=pctValues.length;
  const maxV=60;
  const valid=pctValues.filter(v=>v!=null);
  if(!valid.length)return`<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg"><text x="${w/2}" y="${h/2}" fill="#9ca3af" text-anchor="middle" font-size="11" font-family="Inter">Sem dados de troca de setor</text></svg>`;
  let grid='';
  [0,15,30,45,60].forEach(pct=>{
    const y=pt+ch-Math.round(ch*pct/maxV);
    grid+=`<line x1="${pl}" y1="${y}" x2="${w-pr}" y2="${y}" stroke="${pct===45?'#3b82f6':'#e5e7eb'}" stroke-width="${pct===45?1:0.7}" stroke-dasharray="${pct===45?'5,3':''}"/>`;
    grid+=`<text x="${pl-4}" y="${y+3}" text-anchor="end" fill="${pct===45?'#3b82f6':'#9ca3af'}" font-size="8" font-family="Inter">${pct}%</text>`;
  });
  if(pctValues.length>1){
    grid+=`<text x="${w-pr}" y="${pt+ch-Math.round(ch*45/maxV)-4}" text-anchor="end" fill="#3b82f6" font-size="7.5" opacity="0.7">45%</text>`;
  }
  const xOf=i=>pl+i/(total-1||1)*cw;
  const yOf=v=>pt+ch-Math.round(ch*Math.min(v,maxV)/maxV);
  const pts=pctValues.map((v,i)=>v!=null?{x:xOf(i),y:yOf(v)}:null);
  const vpts=pts.filter(p=>p);
  // Catmull-Rom → cubic bezier
  let pathD='';
  if(vpts.length>=2){
    const t=0.35;
    let d=`M${vpts[0].x.toFixed(1)},${vpts[0].y.toFixed(1)}`;
    for(let i=1;i<vpts.length;i++){
      const p0=vpts[i-2]||vpts[0];
      const p1=vpts[i-1];
      const p2=vpts[i];
      const p3=vpts[i+1]||vpts[vpts.length-1];
      const c1x=p1.x+(p2.x-p0.x)*t, c1y=p1.y+(p2.y-p0.y)*t;
      const c2x=p2.x-(p3.x-p1.x)*t, c2y=p2.y-(p3.y-p1.y)*t;
      d+=`C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
    }
    const botY=pt+ch;
    const areaD=d+`L${vpts[vpts.length-1].x},${botY}L${vpts[0].x},${botY}Z`;
    pathD=`<path d="${areaD}" fill="#3b82f6" opacity="0.12"/>
      <path d="${d}" fill="none" stroke="#3b82f6" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>`;
  }
  let dots='';
  pts.forEach((p,i)=>{if(!p)return; if(i%3===0)dots+=`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2" fill="#3b82f6" opacity="0.7"/>`;});
  let xLab='';
  pctValues.forEach((v,i)=>{if(i%(total<=18?3:6)===0){xLab+=`<text x="${xOf(i).toFixed(1)}" y="${h-pb+14}" text-anchor="middle" fill="#9ca3af" font-size="8" font-family="Inter">${i*(total<=18?5:15)}'</text>`;}});
  return`<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">${grid}${pathD}${dots}${xLab}</svg>`;
}

// ── Bloco 15' helper ─────────────────────────────────────────────────────────
function getBloco15(ev){
  const s=ev.secondsInHalf??ev.seconds??0;
  const etapa=ev.etapa||'1T';
  const base=etapa==='2T'?45:0;
  const min=base+Math.floor(s/60);
  const b=Math.floor(min/15);
  return Math.min(b,5);
}

// ── Planning week parser ─────────────────────────────────────────────────────
function weekStrToMonday(week){
  const match=week.match(/^S(\d+)-(\d{4})$/);
  if(!match)return null;
  const[,wNum,wYear]=match;
  const jan4=new Date(Date.UTC(+wYear,0,4));
  const dow=jan4.getUTCDay()||7;
  const monday=new Date(jan4.getTime()-(dow-1)*86400000+(+wNum-1)*7*86400000);
  return monday.toISOString().slice(0,10);
}

// ── Region normalizer ────────────────────────────────────────────────────────
function normRegiao(r){
  const s=(r||'').toLowerCase();
  if(s.includes('posterior de coxa'))return 'Posterior de Coxa';
  if(s.includes('anterior de coxa'))return 'Anterior de Coxa';
  if(s.includes('coxa')||s.includes('isqui'))return 'Posterior de Coxa';
  if(s.includes('pantu')||s.includes('sural'))return 'Panturrilha';
  if(s.includes('glút')||s.includes('glut'))return 'Glúteo';
  if(s.includes('virilha')||s.includes('púbis')||s.includes('pubis')||s.includes('virilh'))return 'Virilha / Púbis';
  if(s.includes('adu'))return 'Adutor';
  if(s.includes('tornoz'))return 'Tornozelo';
  if(s.includes('joelh'))return 'Joelho';
  if(s.includes('canel'))return 'Canela';
  if(s.includes('quadril'))return 'Quadril';
  if(s.includes('torácic')||s.includes('toracic'))return 'Torácica (Coluna)';
  if(s.includes('lombar'))return 'Lombar';
  if(s.includes('cervical'))return 'Cervical (Coluna)';
  if(s.includes('coluna'))return 'Torácica (Coluna)';
  if(s.includes('ombro'))return 'Ombro';
  if(s.includes('cotovelo'))return 'Cotovelo';
  if(s.includes('antebraço')||s.includes('antebrac'))return 'Antebraço';
  if(s.includes('braço')||s.includes('braco'))return 'Braço';
  if(s.includes('mão')||s.includes('mao'))return 'Mão';
  if(s.includes('pescoço')||s.includes('pescoco'))return 'Pescoço';
  if(s.includes('cabeça')||s.includes('cabeca'))return 'Cabeça';
  if(s.includes('abdô')||s.includes('abdo'))return 'Abdômen';
  if(s.includes('pé')||s==='pe')return 'Pé';
  return 'Outros';
}

// ════════════════════════════════════════════════════════════════════════════
export async function gerarRelatorioGeral(filtroPeriodo='competitivo', categoria='', escopo='completo', dataInicioParam='', dataFimParam='', dataFase2Inicio=''){
  const ctx=JSON.parse(localStorage.getItem('userContext')||'{}');
  const clubId=ctx.clubId;
  if(!clubId){alert('Clube não identificado.');return;}
  const nomeClube=ctx.clubName||ctx.clubId||'Clube';
  const esporte=(ctx.esporte||'futebol').toLowerCase();
  const isFutebol=esporte==='futebol'||esporte==='soccer';

  const win=window.open('','_blank');
  win.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Gerando…</title>
    <style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;background:#f1efe8;}
    .spin{animation:spin 1s linear infinite;display:inline-block;}@keyframes spin{to{transform:rotate(360deg);}}</style>
  </head><body><div style="text-align:center;color:#2c2c2a">
    <div class="spin" style="font-size:28px">⏳</div>
    <div style="margin-top:8px;font-size:14px">Buscando dados…</div>
  </div></body></html>`);

  try {
    const hojeStr=new Date().toLocaleDateString('en-CA');
    const dataInicio=dataInicioParam||'2024-01-01';
    const dataFim=dataFimParam||hojeStr;
    const totalDiasPeriodo=Math.round((new Date(dataFim+'T00:00:00')-new Date(dataInicio+'T00:00:00'))/86400000);

    // ── Fetch all data ─────────────────────────────────────────────────────
    const [atletasSnap, dailySnap, scoutSnap, medicoSnap, planSnap, rtpSnap, micrSnap] = await Promise.all([
      getDocs(query(collection(db,'athletes'),where('clubId','==',clubId))),
      getDocs(query(collection(db,'daily_metrics'),where('clubId','==',clubId))),
      getDocs(query(collection(db,'scout_partidas'),where('clubId','==',clubId))),
      getDocs(query(collection(db,'assessments_medical'),where('clubId','==',clubId))),
      getDocs(query(collection(db,'assessments_planning'),where('clubId','==',clubId))),
      getDocs(query(collection(db,'rtp_progress'),where('clubId','==',clubId))),
      getDocs(query(collection(db,'microciclo_dias'),where('clubId','==',clubId))),
    ]);

    // Fetch scout events subcollections
    const scoutDocs=scoutSnap.docs.map(d=>({id:d.id,...d.data()}));
    const eventsMap={};
    await Promise.all(scoutDocs.map(async p=>{
      const evSnap=await getDocs(collection(db,`scout_partidas/${p.id}/events`));
      eventsMap[p.id]=evSnap.docs.map(d=>({id:d.id,...d.data()}));
    }));

    // ── Planning: week → period map + jogo local (Casa/Fora) por data ────────
    const periodoPorSemana={};
    const planData=[];
    const jogoLocalPorData={}; // date string → 'casa'|'fora'|'neutro'
    planSnap.forEach(d=>{
      const raw=d.data();
      planData.push(raw);
      const mondayStr=weekStrToMonday(raw.week||'');
      if(mondayStr) periodoPorSemana[mondayStr]=raw.periodo||'Preparação';
      // Index game local by date
      (raw.jogos||[]).forEach(j=>{
        if(j.data) jogoLocalPorData[j.data]=(j.local||'').toLowerCase();
      });
    });
    const semanaAtualKey=getMondayStr(hojeStr);
    function incluirSemana(wKey){
      if(wKey>semanaAtualKey)return false;
      const p=periodoPorSemana[wKey];
      if(filtroPeriodo==='todos')return true;
      if(filtroPeriodo==='competitivo')return p==='Competição';
      return p==='Preparação'||p==='Transição'||!p;
    }

    // Period label
    const periodoLabel=filtroPeriodo==='competitivo'?'Fase Competitiva':
      filtroPeriodo==='preparatorio'?'Fase Preparatória':'Todos os Períodos';

    // ── Athletes ───────────────────────────────────────────────────────────
    const atletasMap={};
    atletasSnap.forEach(d=>{
      const a={id:d.id,...d.data()};
      if(a.ativo===false)return;
      if(categoria&&a.categoria!==categoria)return;
      atletasMap[d.id]=a;
    });
    const atletasAtivosArr=Object.values(atletasMap);

    // ── Daily metrics filtered by period ──────────────────────────────────
    const allDM=[];
    dailySnap.forEach(d=>{
      const dm={id:d.id,...d.data()};
      if(!atletasMap[dm.athleteId])return;
      if(dm.date<dataInicio||dm.date>dataFim)return;
      if(!incluirSemana(getMondayStr(dm.date)))return;
      allDM.push({...dm,_sc:calcProntidao(dm)});
    });
    allDM.sort((a,b)=>a.date.localeCompare(b.date));

    // Per-athlete grouping
    const porAtleta={};
    allDM.forEach(dm=>{
      if(!porAtleta[dm.athleteId])porAtleta[dm.athleteId]=[];
      porAtleta[dm.athleteId].push(dm);
    });

    // ── Weekly aggregation ────────────────────────────────────────────────
    const semanaStats={};
    allDM.forEach(dm=>{
      const wKey=getMondayStr(dm.date);
      if(!semanaStats[wKey])semanaStats[wKey]={globals:[],IHs:[],INMs:[],saltos:[],qualidades:[],pses:[],tempos:[]};
      const s=semanaStats[wKey];
      if(dm._sc.global!=null)s.globals.push(dm._sc.global);
      if(dm._sc.IH!=null)s.IHs.push(dm._sc.IH);
      if(dm._sc.INM!=null)s.INMs.push(dm._sc.INM);
      if(dm.pre?.salto!=null)s.saltos.push(+dm.pre.salto);
      if(dm.post?.qualidade!=null)s.qualidades.push(dm.post.qualidade);
      if(dm.post?.pse!=null)s.pses.push(dm.post.pse);
      if(dm.post?.tempo!=null)s.tempos.push(dm.post.tempo);
    });
    const semanasComDados=Object.keys(semanaStats).sort();
    const semLabels=semanasComDados.map((_,i)=>`S${i+1}`);
    const semIGP=semanasComDados.map(w=>avgRound(semanaStats[w].globals));
    const semISP=semanasComDados.map(w=>{
      const g=semanaStats[w].globals, q=semanaStats[w].qualidades;
      if(!g.length)return null;
      return Math.round(avg(g)*fatorQ(avg(q)));
    });
    const semIH=semanasComDados.map(w=>avgRound(semanaStats[w].IHs));
    const semINM=semanasComDados.map(w=>avgRound(semanaStats[w].INMs));
    const semCMJ=semanasComDados.map(w=>{
      const s=semanaStats[w].saltos;
      return s.length?+(s.reduce((a,b)=>a+b,0)/s.length).toFixed(1):null;
    });
    const semCarga=semanasComDados.map(w=>{
      const pses=semanaStats[w].pses, tps=semanaStats[w].tempos;
      if(!pses.length||!tps.length)return null;
      const pairs=pses.map((p,i)=>p*(tps[i]||0));
      return Math.round(avg(pairs)*5);
    });
    const cmjValidos=semCMJ.filter(v=>v!=null);
    const cmjMedioFase=cmjValidos.length?+(cmjValidos.reduce((a,b)=>a+b,0)/cmjValidos.length).toFixed(1):null;
    const cmjPrimeira=cmjValidos.slice(0,Math.ceil(cmjValidos.length/2));
    const cmjUltima=cmjValidos.slice(Math.floor(cmjValidos.length/2));
    const cmjEvol=(cmjPrimeira.length&&cmjUltima.length)?
      +((avg(cmjUltima)-avg(cmjPrimeira)).toFixed(1)):null;

    // ── Medical ───────────────────────────────────────────────────────────
    const allMedDocs=[];
    medicoSnap.forEach(d=>{
      const raw=d.data();
      const dr=raw.data||raw.date||(raw.createdAt?.toDate?raw.createdAt.toDate().toLocaleDateString('en-CA'):'');
      allMedDocs.push({...raw,_date:dr,_id:d.id});
    });
    // Filter to period + include all for "most recent" status
    const medDocsAll=allMedDocs.filter(d=>d._date&&d._date>=dataInicio&&d._date<=hojeStr);

    // Most recent LESÃO record per athlete (for tipoLesao lookup)
    const medMaisRecente={};
    medDocsAll.forEach(d=>{
      if(!d.athleteId)return;
      const isLesaoDoc=d.tipo==='lesao'||d.tipo==='lesão'||d.dados?.tipoRegistro==='lesao'||
        (!d.tipoAtendimento&&!d.dados?.tipoAtendimento&&(d.tipoLesao||d.dados?.tipoLesao));
      if(!isLesaoDoc)return;
      if(!medMaisRecente[d.athleteId]||d._date>medMaisRecente[d.athleteId]._date)
        medMaisRecente[d.athleteId]=d;
    });

    // Injuries in the filtered period — only tipo:'lesao', never atendimentos; only active athletes
    const atletasAtivosIds=new Set(atletasAtivosArr.map(a=>a.id));
    const docLesoesRaw=medDocsAll.filter(d=>
      (d.tipo==='lesao'||d.tipo==='lesão'||d.dados?.tipoRegistro==='lesao')
      &&atletasAtivosIds.has(d.athleteId)
    );
    // Helper: extrai diasAfastado de um registro (dados.diasAfastado ou top-level)
    const getDias=d=>{
      const v=d.dados?.diasAfastado??d.diasAfastado??d.dados?.data?.diasAfastado??null;
      if(v==null||v==='')return null;
      const n=+v;
      return isNaN(n)?null:n;
    };
    const getDataAlta=d=>{
      const alta=d.dataAlta||d.dados?.dataAlta||d.dados?.data?.dataAlta||null;
      if(!alta)return null;
      if(typeof alta==='string')return alta;
      if(alta?.toDate)return alta.toDate().toLocaleDateString('en-CA');
      return null;
    };
    // Verifica se registro tem status=liberado em qualquer dos campos possíveis
    const isStatusLiberado=d=>{
      const s=(d.dados?.status||d.dados?.statusAtual||d.statusAtual||d.status||'').toLowerCase();
      return s.includes('liber')||s.includes('apto');
    };
    // updatedAt como string de data (quando disponível)
    const getUpdatedAtStr=d=>{
      if(!d.updatedAt)return null;
      if(typeof d.updatedAt==='string')return d.updatedAt;
      if(d.updatedAt?.toDate)return d.updatedAt.toDate().toLocaleDateString('en-CA');
      return null;
    };
    // getDiasCalculado: para atletas liberados sem dataAlta, usa diasAfastado ou updatedAt-_date
    const getDiasCalculado=d=>{
      const dias=getDias(d);
      if(dias!=null&&dias>0)return dias;
      const alta=getDataAlta(d);
      if(alta&&d._date&&alta>d._date)return Math.round((new Date(alta+'T00:00:00')-new Date(d._date+'T00:00:00'))/86400000);
      // Se liberado sem dataAlta explícita, usa updatedAt como proxy de alta
      if(isStatusLiberado(d)){
        const upd=getUpdatedAtStr(d);
        if(upd&&d._date&&upd>d._date)return Math.round((new Date(upd+'T00:00:00')-new Date(d._date+'T00:00:00'))/86400000);
        return null; // liberado mas sem info de duração
      }
      // Fallback apenas para lesões ainda em aberto: conta dias até hoje
      if(d._date&&d._date<=hojeStr)return Math.round((new Date(hojeStr+'T00:00:00')-new Date(d._date+'T00:00:00'))/86400000);
      return null;
    };
    // Determina status textual de um registro de lesão para exibição
    const getLesaoStatusHtml=d=>{
      const alta=getDataAlta(d);
      if(alta&&alta<=hojeStr)return '<span style="color:#16a34a;font-weight:600;">Retornou '+alta+'</span>';
      if(alta)return '<span style="color:#ca8a04;font-weight:600;">Prev. '+alta+'</span>';
      if(isStatusLiberado(d)){
        const upd=getUpdatedAtStr(d);
        return '<span style="color:#16a34a;font-weight:600;">Liberado'+(upd?' '+upd:'')+'</span>';
      }
      // Sem liberação explícita: verifica se diasAfastado já expirou
      const diasExpl=getDias(d);
      if(diasExpl!=null&&diasExpl>0&&d._date){
        const retorno=new Date(d._date+'T00:00:00');
        retorno.setDate(retorno.getDate()+diasExpl);
        const retStr=retorno.toLocaleDateString('en-CA');
        if(retStr<=hojeStr)return '<span style="color:#ca8a04;font-weight:600;">Prev. retorno '+retStr+'</span>';
      }
      return '<span style="color:#dc2626;font-weight:600;">Em afastamento</span>';
    };
    // Cada episódio de lesão conta separadamente — um atleta pode ter múltiplas lesões no período.
    const docLesoes=docLesoesRaw.slice().sort((a,b)=>a._date.localeCompare(b._date));
    const totalLesoes=docLesoes.length;
    const diasPerdidosArr=docLesoes.map(d=>{
      // Preferência: diasAfastado preenchido
      const dias=getDias(d);
      if(dias!=null&&dias>0)return dias;
      // Fallback: diferença entre dataAlta e data de registro
      const alta=getDataAlta(d);
      if(alta&&d._date&&alta>d._date){
        const ms=new Date(alta+'T00:00:00')-new Date(d._date+'T00:00:00');
        return Math.round(ms/86400000);
      }
      return null;
    }).filter(v=>v!=null&&v>0);
    const totalDiasPerdidos=diasPerdidosArr.reduce((s,v)=>s+v,0);
    const mediaDiasPorLesao=diasPerdidosArr.length?Math.round(totalDiasPerdidos/diasPerdidosArr.length):null;

    // Gravity bins — usa diasPerdidos calculados (diasAfastado ou dataAlta-data)
    const lesLeve=docLesoes.filter(d=>{const v=getDiasCalculado(d);return v!=null&&v<=7;}).length;
    const lesMod=docLesoes.filter(d=>{const v=getDiasCalculado(d);return v!=null&&v>=8&&v<=28;}).length;
    const lesGrave=docLesoes.filter(d=>{const v=getDiasCalculado(d);return v!=null&&v>28;}).length;
    const lesSemInfo=totalLesoes-(lesLeve+lesMod+lesGrave);

    // Tipo de lesão distribution
    const tipoLesaoColors={'Muscular':'#ef4444','Ligamentar':'#3b82f6','Óssea':'#f97316','Articular':'#8b5cf6','Contusão':'#eab308','Outros':'#6b7280'};
    const tipoCount={};
    docLesoes.forEach(d=>{
      const tipo=d.dados?.tipoLesao||d.tipoLesao||'Outros';
      tipoCount[tipo]=(tipoCount[tipo]||0)+1;
    });
    const tipoPieData=Object.entries(tipoCount).map(([label,value])=>({label,value,color:tipoLesaoColors[label]||'#6b7280'}));
    // Quando ocorreu: Treino vs Jogo
    const ctxTreino=docLesoes.filter(d=>(d.dados?.quandoOcorreu||d.quandoOcorreu||'').toLowerCase().includes('treino')).length;
    const ctxJogo=docLesoes.filter(d=>(d.dados?.quandoOcorreu||d.quandoOcorreu||'').toLowerCase().includes('jogo')).length;
    const ctxSemInfo=totalLesoes-(ctxTreino+ctxJogo);
    // All injuries sorted: graves(>28d) → moderadas(8-28d) → leves(≤7d) → sem info
    const _gravidade=d=>{const v=getDiasCalculado(d);if(v==null)return 3;if(v>28)return 0;if(v>=8)return 1;return 2;};
    const docLesoesSorted=[...docLesoes].sort((a,b)=>_gravidade(a)-_gravidade(b));
    const lesGraveArr=docLesoes.filter(d=>{const v=getDiasCalculado(d);return v!=null&&v>28;});

    // ── Availability per game ─────────────────────────────────────────────
    // Atendimentos de rotina NÃO alteram disponibilidade — só registros de lesão.
    // Para cada lesão, o período de afastamento vai da data do registro até dataAlta
    // ou data_inicio + diasAfastado (estimado). Se o jogo cair nesse intervalo → afastado.
    function getMedStatusOnDate(athleteId, date){
      // Todas as lesões do atleta ordenadas por data (usadas para alta implícita)
      const todasLesoes=allMedDocs.filter(d=>
        d.athleteId===athleteId && d._date &&
        (d.tipo==='lesao'||d.tipo==='lesão'||d.dados?.tipoRegistro==='lesao')
      ).sort((a,b)=>a._date.localeCompare(b._date));
      // Apenas as registradas até a data do jogo
      const lesoes=todasLesoes.filter(d=>d._date<=date);
      for(const r of lesoes){
        const dados=r.dados||{};
        const dataAlta=getDataAlta(r);
        const dias=getDias(r);
        let retorno=null;
        if(dataAlta){
          retorno=dataAlta;
        } else if(dias>0){
          const d0=new Date(r._date+'T00:00:00');
          d0.setDate(d0.getDate()+dias);
          retorno=d0.toISOString().slice(0,10);
        } else {
          // Sem alta explícita: usa a data da próxima lesão como alta implícita
          const next=todasLesoes.find(l=>l._date>r._date);
          if(next) retorno=next._date;
        }
        if(retorno){
          // > em vez de >= : atleta disponível no próprio dia do retorno
          if(retorno>date)return 'afastado';
          // retorno antes ou no dia do jogo → lesão encerrada, verifica próxima
        } else {
          // Sem alta implícita: usa isStatusLiberado (cobre dados.status, dados.statusAtual, r.statusAtual, r.status)
          if(isStatusLiberado(r))continue;
          return 'afastado';
        }
      }
      return 'liberado';
    }

    // ── Scout / Games ─────────────────────────────────────────────────────
    const partidasFiltradas=scoutDocs.filter(p=>{
      if(!p.data||p.data<dataInicio||p.data>hojeStr)return false;
      if(!incluirSemana(getMondayStr(p.data)))return false;
      return true;
    });
    partidasFiltradas.sort((a,b)=>(a.data||'').localeCompare(b.data||''));

    // Helper: resolve mando from multiple sources
    // 1. Planning jogos (by date)  2. Scout mando field  3. Scout local (Teixeirão = casa)
    function resolveMando(p){
      if(jogoLocalPorData[p.data]) return jogoLocalPorData[p.data]; // 'casa'|'fora'|'neutro'
      if(p.mando) return p.mando.toLowerCase();
      const local=(p.local||'').toLowerCase();
      if(local.includes('teixeirão')||local.includes('teixeirao')) return 'casa';
      if(local) return 'fora'; // qualquer outro local = fora
      return '';
    }

    const jogosData=partidasFiltradas.map((p,idx)=>{
      const pro=p.placar?.pro??0, con=p.placar?.contra??0;
      const resultado=pro>con?'V':pro<con?'D':'E';
      const mando=resolveMando(p);
      // Availability on game date
      const disp=atletasAtivosArr.filter(a=>{
        return getMedStatusOnDate(a.id,p.data)!=='afastado';
      }).length;
      const dispPct=atletasAtivosArr.length>0?Math.round(disp/atletasAtivosArr.length*100):null;
      return{...p,idx,pro,con,resultado,mando,dispAtletas:disp,dispPct,label:`J${idx+1}`};
    });

    // Global game stats
    const totalJogos=jogosData.length;
    const totalV=jogosData.filter(g=>g.resultado==='V').length;
    const totalE=jogosData.filter(g=>g.resultado==='E').length;
    const totalD=jogosData.filter(g=>g.resultado==='D').length;
    const totalGolsPro=jogosData.reduce((s,g)=>s+g.pro,0);
    const totalGolsContra=jogosData.reduce((s,g)=>s+g.con,0);
    const saldoGols=totalGolsPro-totalGolsContra;
    const aproveitamento=totalJogos>0?Math.round((totalV*3+totalE)/(totalJogos*3)*100):null;
    const jogosDataCasa = jogosData.filter(g=>g.mando==='casa'||g.mando==='home');
    const jogosDataFora = jogosData.filter(g=>g.mando!=='casa'&&g.mando!=='home'&&g.mando!=null&&g.mando!=='');
    const totalJogosCasa = jogosDataCasa.length;
    const totalJogosFora = jogosDataFora.length;
    const totalVCasa = jogosDataCasa.filter(g=>g.resultado==='V').length;
    const totalECasa = jogosDataCasa.filter(g=>g.resultado==='E').length;
    const totalVFora = jogosDataFora.filter(g=>g.resultado==='V').length;
    const totalEFora = jogosDataFora.filter(g=>g.resultado==='E').length;
    const aprovCasa = totalJogosCasa>0?Math.round((totalVCasa*3+totalECasa)/(totalJogosCasa*3)*100):null;
    const aprovFora = totalJogosFora>0?Math.round((totalVFora*3+totalEFora)/(totalJogosFora*3)*100):null;
    const golsCasaPro = jogosDataCasa.reduce((s,g)=>s+g.pro,0);
    const golsCasaContra = jogosDataCasa.reduce((s,g)=>s+g.con,0);
    const golsForaPro = jogosDataFora.reduce((s,g)=>s+g.pro,0);
    const golsForaContra = jogosDataFora.reduce((s,g)=>s+g.con,0);
    const dispPerGame=jogosData.map(g=>g.dispPct).filter(v=>v!=null);
    const dispMedia=dispPerGame.length?Math.round(avg(dispPerGame)):null;
    const melhorJogo=jogosData.length?[...jogosData].filter(g=>g.dispPct!=null).sort((a,b)=>(b.dispPct??0)-(a.dispPct??0))[0]:null;
    const piorJogo=jogosData.length?[...jogosData].filter(g=>g.dispPct!=null).sort((a,b)=>(a.dispPct??0)-(b.dispPct??0))[0]:null;

    // ── Events aggregation ────────────────────────────────────────────────
    const allEvents=[];
    partidasFiltradas.forEach(p=>{(eventsMap[p.id]||[]).forEach(ev=>allEvents.push({...ev,_gameId:p.id,_gameDate:p.data}));});

    // ── Attack entries analysis ───────────────────────────────────────────
    const entradaAtaque=[];
    const _gameEvMap={};
    allEvents.forEach(ev=>{if(!_gameEvMap[ev._gameId])_gameEvMap[ev._gameId]=[];_gameEvMap[ev._gameId].push(ev);});
    Object.entries(_gameEvMap).forEach(([gid,evs])=>{
      evs.sort((a,b)=>(a.seconds||0)-(b.seconds||0));
      evs.forEach((ev,i)=>{
        if(ev.action!=='Troca de setor')return;
        if(ev.meta?.para!=='ataque')return;
        if(ev.meta?.posse!=='america')return;
        let nextIdx=-1;
        for(let j=i+1;j<evs.length;j++){if(evs[j].action==='Troca de setor'){nextIdx=j;break;}}
        const win=evs.slice(i+1,nextIdx===-1?evs.length:nextIdx);
        const hasF=win.some(e=>e.action==='Finalização'||(e.action==='Bola Parada'&&e.meta?.equipe==='america'&&e.meta?.finalizou===true));
        const hasBP=win.some(e=>e.action==='Bola Parada'&&e.meta?.equipe==='america');
        // Conta TODOS os escanteios e faltas do clube na janela, independente do desfecho
        const bpEscanteios=win.filter(e=>e.action==='Bola Parada'&&e.meta?.equipe==='america'&&e.meta?.tipo==='escanteio').length;
        const bpFaltas=win.filter(e=>e.action==='Bola Parada'&&e.meta?.equipe==='america'&&e.meta?.tipo==='falta').length;
        const outcome=hasF?'finalizou':hasBP?'bola_parada':'sem_finalizacao';
        entradaAtaque.push({gameId:gid,gameDate:ev._gameDate,segundos:ev.seconds||0,minuto:Math.floor((ev.seconds||0)/60),etapa:ev.etapa||'1T',outcome,bpEscanteios,bpFaltas});
      });
    });
    const _eaPorJogo={};
    partidasFiltradas.forEach(p=>{_eaPorJogo[p.id]={finalizou:0,bola_parada:0,bp_escanteio:0,bp_falta:0,sem_finalizacao:0,total:0,entries:[]};});
    entradaAtaque.forEach(e=>{
      const g=_eaPorJogo[e.gameId];if(!g)return;
      g[e.outcome]++;g.total++;g.entries.push(e);
    });
    // Conta finalizações, escanteios e faltas GLOBALMENTE por jogo
    allEvents.forEach(ev=>{
      const g=_eaPorJogo[ev._gameId];if(!g)return;
      const sec=(ev.sector||ev.setor||'').toLowerCase();
      if(sec!=='ataque')return; // só conta eventos no setor ofensivo
      if(ev.action==='Finalização')g.finalizacoes=(g.finalizacoes||0)+1;
      if(ev.action==='Chance clara criada')g.chancesC=(g.chancesC||0)+1;
      if(ev.action!=='Bola Parada'||ev.meta?.equipe!=='america')return;
      if(ev.meta?.tipo==='escanteio')g.bp_escanteio++;
      else if(ev.meta?.tipo==='falta')g.bp_falta++;
    });
    const _secAtaque=e=>(e.sector||e.setor||'').toLowerCase()==='ataque';
    const eaTotalEntradas=entradaAtaque.length;
    const eaTotalFin=allEvents.filter(e=>_secAtaque(e)&&e.action==='Finalização').length;
    const eaTotalCC=allEvents.filter(e=>_secAtaque(e)&&e.action==='Chance clara criada').length;
    const eaTotalBPEsc=allEvents.filter(e=>_secAtaque(e)&&e.action==='Bola Parada'&&e.meta?.equipe==='america'&&e.meta?.tipo==='escanteio').length;
    const eaTotalBPFal=allEvents.filter(e=>_secAtaque(e)&&e.action==='Bola Parada'&&e.meta?.equipe==='america'&&e.meta?.tipo==='falta').length;
    const eaTotalBP=eaTotalBPEsc+eaTotalBPFal;
    const eaTotalSem=entradaAtaque.filter(e=>e.outcome==='sem_finalizacao').length;
    const eaConvPct=eaTotalEntradas>0?Math.round(eaTotalFin/eaTotalEntradas*100):null;
    const eaMediaEntradas=totalJogos>0?+(eaTotalEntradas/totalJogos).toFixed(1):null;
    // Bolas paradas — volume total (sem filtro de setor, conta todos os jogos)
    const _bpAmEscTot=allEvents.filter(e=>e.action==='Bola Parada'&&e.meta?.equipe==='america'&&e.meta?.tipo==='escanteio').length;
    const _bpAmFalTot=allEvents.filter(e=>e.action==='Bola Parada'&&e.meta?.equipe==='america'&&e.meta?.tipo==='falta').length;
    const _bpAmTot=_bpAmEscTot+_bpAmFalTot;
    const _bpAmFin=allEvents.filter(e=>e.action==='Bola Parada'&&e.meta?.equipe==='america'&&e.meta?.finalizou).length;
    const _bpAmFinPct=_bpAmTot>0?Math.round(_bpAmFin/_bpAmTot*100):null;
    const _bpAdvEsc=allEvents.filter(e=>e.action==='Bola Parada'&&e.meta?.equipe==='adv'&&e.meta?.tipo==='escanteio').length;
    const _bpAdvFal=allEvents.filter(e=>e.action==='Bola Parada'&&e.meta?.equipe==='adv'&&e.meta?.tipo==='falta').length;
    const _bpAdvTot=_bpAdvEsc+_bpAdvFal;
    const _bpAdvFin=allEvents.filter(e=>e.action==='Bola Parada'&&e.meta?.equipe==='adv'&&e.meta?.finalizou).length;
    const _bpAdvFinPct=_bpAdvTot>0?Math.round(_bpAdvFin/_bpAdvTot*100):null;
    // Gols de bola parada e pênalti
    const _golsBPAm  =allEvents.filter(e=>e.action==='Gol Pró'&&e.meta?.origem==='parada').length;
    const _golsPenAm =allEvents.filter(e=>e.action==='Gol Pró'&&e.meta?.origem==='penalti').length;
    const _golsBPAdv =allEvents.filter(e=>e.action==='Gol Contra (adv)'&&e.meta?.origem==='parada').length;
    const _golsPenAdv=allEvents.filter(e=>e.action==='Gol Contra (adv)'&&e.meta?.origem==='penalti').length;

    // Time blocks (6 × 15')
    const blocos15=Array.from({length:6},()=>({gP:0,gC:0,fin:0,dgAr:0,dgCh:0,dpAr:0,dpCh:0,falta:0,cc:0,boaDecisao:0,erroNF:0,erroPressao:0,finAdv:0,ccAdv:0,roubadaPO:0,roubadaPP:0,roubadaCB:0}));
    allEvents.forEach(ev=>{
      const b=getBloco15(ev);
      const bl=blocos15[b];
      const a=ev.action||'';
      if(a==='Gol Pró')bl.gP++;
      else if(a==='Gol Contra (adv)')bl.gC++;
      else if(a==='Finalização')bl.fin++;
      else if(a==='Chance clara criada')bl.cc++;
      else if(a==='Duelo ganho (alto)')bl.dgAr++;
      else if(a==='Duelo ganho (chão)')bl.dgCh++;
      else if(a==='Duelo perdido (alto)')bl.dpAr++;
      else if(a==='Duelo perdido (chão)')bl.dpCh++;
      else if(a==='Falta')bl.falta++;
      else if(a==='Boa decisão')bl.boaDecisao++;
      else if(a==='Erro NF')bl.erroNF++;
      else if(a==='Erro pressão')bl.erroPressao++;
      else if(a==='Finalização adversária')bl.finAdv++;
      else if(a==='Chance clara adversário')bl.ccAdv++;
      else if(a==='Roubada (pressão ofensiva)')bl.roubadaPO++;
      else if(a==='Roubada (pós-perda)')bl.roubadaPP++;
      else if(a==='Roubada (combate)')bl.roubadaCB++;
    });
    const blLabels=['0-15\'','15-30\'','30-45\'','45-60\'','60-75\'','75-90\''];

    // Per-game averages
    const nJ=Math.max(totalJogos,1);
    const avgFin=(allEvents.filter(e=>e.action==='Finalização').length/nJ).toFixed(1);
    const avgCC=(allEvents.filter(e=>e.action==='Chance clara criada').length/nJ).toFixed(1);
    const avgDGCh=(allEvents.filter(e=>e.action==='Duelo ganho (chão)').length/nJ).toFixed(1);
    const avgDGAr=(allEvents.filter(e=>e.action==='Duelo ganho (alto)').length/nJ).toFixed(1);
    const avgDPCh=(allEvents.filter(e=>e.action==='Duelo perdido (chão)').length/nJ).toFixed(1);
    const avgDPAr=(allEvents.filter(e=>e.action==='Duelo perdido (alto)').length/nJ).toFixed(1);
    const avgFalta=(allEvents.filter(e=>e.action==='Falta').length/nJ).toFixed(1);
    const avgDefDif=(allEvents.filter(e=>e.action==='Defesa difícil').length/nJ).toFixed(1);
    const avgGolsPro=(totalGolsPro/nJ).toFixed(1);
    const avgGolsContra=(totalGolsContra/nJ).toFixed(1);
    const totalFinPro=allEvents.filter(e=>e.action==='Finalização').length;
    const totalFinAdv=allEvents.filter(e=>e.action==='Finalização adversária').length;
    const convPro=totalFinPro>0?Math.round(totalGolsPro/totalFinPro*100):null;
    const convAdv=totalFinAdv>0?Math.round(totalGolsContra/totalFinAdv*100):null;
    const finPorGolPro=totalGolsPro>0?(totalFinPro/totalGolsPro).toFixed(1):null;
    const finPorGolAdv=totalGolsContra>0?(totalFinAdv/totalGolsContra).toFixed(1):null;

    // Sector × block
    const setores=['defesa','meio','ataque'];
    const setorBlocoData={};
    setores.forEach(s=>{setorBlocoData[s]=Array.from({length:6},()=>({fin:0,cc:0,gols:0,dg:0,dp:0,falta:0,acoes:0,dgCh:0,dgAr:0,dpCh:0,dpAr:0,boaDecisao:0,erroNF:0,erroPressao:0,roubadaPO:0,roubadaPP:0,roubadaCB:0}));});
    allEvents.forEach(ev=>{
      const sec=(ev.sector||'').toLowerCase();
      if(!setores.includes(sec))return;
      const b=getBloco15(ev);
      const cell=setorBlocoData[sec][b];
      const a=ev.action||'';
      cell.acoes++;
      if(a==='Finalização')cell.fin++;
      if(a==='Chance clara criada')cell.cc++;
      if(a==='Gol Pró')cell.gols++;
      if(a==='Duelo ganho (chão)')cell.dgCh++;
      if(a==='Duelo ganho (alto)')cell.dgAr++;
      if(a==='Duelo perdido (chão)')cell.dpCh++;
      if(a==='Duelo perdido (alto)')cell.dpAr++;
      if(a.startsWith('Duelo ganho'))cell.dg++;
      if(a.startsWith('Duelo perdido'))cell.dp++;
      if(a==='Falta')cell.falta++;
      if(a==='Boa decisão')cell.boaDecisao++;
      if(a==='Erro NF')cell.erroNF++;
      if(a==='Erro pressão')cell.erroPressao++;
      if(a==='Roubada (pressão ofensiva)')cell.roubadaPO++;
      if(a==='Roubada (pós-perda)')cell.roubadaPP++;
      if(a==='Roubada (combate)')cell.roubadaCB++;
    });

    // Sector totals for field maps
    const setorDuelTotals={};
    const setorDecisaoTotals={};
    const setorRoubadaTotals={};
    setores.forEach(s=>{
      const cells=setorBlocoData[s];
      setorDuelTotals[s]={dg:cells.reduce((sum,c)=>sum+c.dg,0),dp:cells.reduce((sum,c)=>sum+c.dp,0)};
      setorDecisaoTotals[s]={bd:cells.reduce((sum,c)=>sum+c.boaDecisao,0),erNF:cells.reduce((sum,c)=>sum+c.erroNF,0),erP:cells.reduce((sum,c)=>sum+c.erroPressao,0)};
      setorRoubadaTotals[s]={po:cells.reduce((sum,c)=>sum+c.roubadaPO,0),pp:cells.reduce((sum,c)=>sum+c.roubadaPP,0),cb:cells.reduce((sum,c)=>sum+c.roubadaCB,0)};
    });

    // ── Microciclo data ───────────────────────────────────────────────────
    const micrMap={};
    micrSnap.forEach(d=>{
      const raw=d.data();
      if(raw.clubId!==clubId)return;
      micrMap[raw.data||d.id.split('_')[0]]=raw.label;
    });
    // Compute load per MD-x label
    const mdLoadMap={};
    const mdTempoMap={};
    const mdCountMap={};
    allDM.forEach(dm=>{
      if(dm.post?.pse==null||dm.post?.tempo==null)return;
      const label=micrMap[dm.date];
      if(!label)return;
      const carga=dm.post.pse*dm.post.tempo;
      mdLoadMap[label]=(mdLoadMap[label]||0)+carga;
      mdTempoMap[label]=(mdTempoMap[label]||0)+dm.post.tempo;
      mdCountMap[label]=(mdCountMap[label]||0)+1;
    });
    const mdLabels=['MD-3','MD-2','MD-1','MD','MD+1','MD+2','MD+3'];
    const mdColors={'MD+1':'#8b5cf6','MD+2':'#7c3aed','MD+3':'#6366f1','MD-3':'#ef4444','MD-2':'#f97316','MD-1':'#10b981','MD':'#1d4ed8'};
    const mdValues=mdLabels.map(l=>{
      if(l==='MD') return mdCountMap[l]?Math.round(mdLoadMap[l]/mdCountMap[l]):850; // 850 u.a. = carga padrão de jogo
      return mdCountMap[l]?Math.round(mdLoadMap[l]/mdCountMap[l]):null;
    });
    const mdColorsArr=mdLabels.map((l,i)=>{
      if(l==='MD'&&mdValues[i]===850&&!mdCountMap[l])return'#7f1d1d';
      return mdColors[l]||'#999';
    });
    const hasMicrData=mdValues.some(v=>v!=null);
    const mdTempoValues=mdLabels.map(l=>{if(l==='MD')return mdCountMap[l]?Math.round(mdTempoMap[l]/mdCountMap[l]):100;return mdCountMap[l]?Math.round(mdTempoMap[l]/mdCountMap[l]):null;});
    const mdTempoColorsArr=mdTempoValues.map(v=>v==null?'#374151':v>=90?'#16a34a':v>=70?'#ca8a04':v>=50?'#ea580c':'#dc2626');
    const semCargaMed=avg(semCarga.filter(v=>v!=null));
    const pctCargaVsJogo=semCargaMed!=null?Math.round(semCargaMed/850*100):null;

    // KPI: carga longe vs perto
    const cargaLonge=avg(['MD-3','MD-2','MD-1'].map(l=>mdCountMap[l]?mdLoadMap[l]/mdCountMap[l]:null).filter(v=>v!=null));
    const cargaPerto=avg(['MD-2','MD-1','MD'].map(l=>mdCountMap[l]?mdLoadMap[l]/mdCountMap[l]:null).filter(v=>v!=null));
    const cargaTotal=(cargaLonge||0)+(cargaPerto||0);
    const cargaLongeP=cargaTotal?Math.round((cargaLonge||0)/cargaTotal*100):null;
    const cargaPertoP=cargaTotal?Math.round((cargaPerto||0)/cargaTotal*100):null;
    // KPI: which MD label has highest average load
    let mdMaiorCargaLabel='—';
    {
      let maxVal=-Infinity, maxLabel=null;
      mdLabels.forEach((l,i)=>{if(mdValues[i]!=null&&mdValues[i]>maxVal){maxVal=mdValues[i];maxLabel=l;}});
      if(maxLabel!=null)mdMaiorCargaLabel=`${maxLabel}: ${fmtI(maxVal)}`;
    }

    // ── Internal load ─────────────────────────────────────────────────────
    const psesArr=allDM.map(dm=>dm.post?.pse).filter(v=>v!=null);
    const pseMed=psesArr.length?+(avg(psesArr)).toFixed(1):null;
    const qualsArr=allDM.map(dm=>dm.post?.qualidade).filter(v=>v!=null);
    const qualMedia=qualsArr.length?+(avg(qualsArr)).toFixed(1):null;
    // Evolução qualidade
    const halfQ=Math.floor(semanasComDados.length/2);
    const qualFirst=avg(semanasComDados.slice(0,halfQ).flatMap(w=>semanaStats[w].qualidades));
    const qualSecond=avg(semanasComDados.slice(halfQ).flatMap(w=>semanaStats[w].qualidades));
    const qualEvolucao=qualFirst!=null&&qualSecond!=null?+(qualSecond-qualFirst).toFixed(1):null;
    const maiorCargaIdx=semCarga.reduce((mi,v,i)=>v!=null&&(semCarga[mi]==null||v>semCarga[mi])?i:mi,0);
    const menorCargaIdx=semCarga.reduce((mi,v,i)=>v!=null&&(semCarga[mi]==null||v<semCarga[mi])?i:mi,0);
    const hasPostData=psesArr.length>0;

    // ── RTP ───────────────────────────────────────────────────────────────
    const rtpAtletas=[];
    rtpSnap.forEach(d=>{
      const raw=d.data();
      if(raw.clubId!==clubId)return;
      if(raw.fase>=4)return; // Fase 4 = retornou
      const status=(raw.status||raw.statusAtual||'').toLowerCase();
      if(status==='liberado'||status==='alta'||status==='retornou'||status==='liberada')return;
      // Source of truth: if medical records show no active injury today, athlete is cleared
      if(getMedStatusOnDate(raw.athleteId, hojeStr) !== 'afastado')return;
      const atl=atletasMap[raw.athleteId];
      if(atl)rtpAtletas.push({...raw,nome:atl.nome});
    });

    // Athletes who missed games due to injury/transition
    const atletasAusentesJogos=atletasAtivosArr.map(a=>{
      const jogosFora=jogosData.filter(g=>getMedStatusOnDate(a.id,g.data)==='afastado');
      const emRTP=rtpAtletas.some(r=>r.athleteId===a.id);
      const medRec=medMaisRecente[a.id];
      const tipoLesao=medRec?.dados?.tipoLesao||medRec?.dados?.data?.tipoLesao||medRec?.tipoLesao||null;
      return{...a,jogosFora,jogosPerdidos:jogosFora.length,motivo:emRTP?'Transição':'Afastado',tipoLesao};
    }).filter(a=>a.jogosPerdidos>0).sort((a,b)=>b.jogosPerdidos-a.jogosPerdidos);

    // ── Per-athlete star metrics (Page 5) ─────────────────────────────────
    const atlGols={}, atlAssist={}, atlFin={}, atlMins={}, atlDG={}, atlDP={}, atlRoubada={}, atlDefDif={};
    allEvents.forEach(ev=>{
      if(!ev.athleteId)return;
      const a=ev.action||'';
      if(a==='Gol Pró'){atlGols[ev.athleteId]=(atlGols[ev.athleteId]||0)+1;}
      if(a==='Assistência'){atlAssist[ev.athleteId]=(atlAssist[ev.athleteId]||0)+1;}
      if(a==='Finalização'){atlFin[ev.athleteId]=(atlFin[ev.athleteId]||0)+1;}
      if(a.startsWith('Duelo ganho')){atlDG[ev.athleteId]=(atlDG[ev.athleteId]||0)+1;}
      if(a.startsWith('Duelo perdido')){atlDP[ev.athleteId]=(atlDP[ev.athleteId]||0)+1;}
      if(a==='Roubada (pressão ofensiva)'||a==='Roubada (pós-perda)'||a==='Roubada (combate)'){atlRoubada[ev.athleteId]=(atlRoubada[ev.athleteId]||0)+1;}
      if(a==='Defesa difícil'){atlDefDif[ev.athleteId]=(atlDefDif[ev.athleteId]||0)+1;}
    });
    // Participação em Gols = gols + assistências
    const atlPartGols={};
    Object.keys({...atlGols,...atlAssist}).forEach(aid=>{atlPartGols[aid]=(atlGols[aid]||0)+(atlAssist[aid]||0);});
    // Minutes + jogos from perfSnapshot (use Set per athlete to avoid double-counting games)
    const atlJogosSet={};
    partidasFiltradas.forEach(p=>{
      const dur=Math.min(p.duracaoSegundos||5400,7200);
      const seenThisGame=new Set();
      if(p.playedSeconds){
        Object.entries(p.playedSeconds).forEach(([aid,val])=>{
          if(!atletasMap[aid])return;
          const raw=typeof val==='object'?(val.seconds??0):typeof val==='number'?val:0;
          const mins=Math.round(Math.min(raw,dur)/60);
          if(mins>0){
            atlMins[aid]=(atlMins[aid]||0)+mins;
            seenThisGame.add(aid);
            if(!atlJogosSet[aid])atlJogosSet[aid]=new Set();
            atlJogosSet[aid].add(p.id);
          }
        });
      }
      Object.values(p.perfSnapshot||{}).forEach(s=>{
        if(!s.athleteId)return;
        if(!seenThisGame.has(s.athleteId)){
          atlMins[s.athleteId]=(atlMins[s.athleteId]||0)+(s.minutos||0);
        }
        if(!atlJogosSet[s.athleteId])atlJogosSet[s.athleteId]=new Set();
        atlJogosSet[s.athleteId].add(p.id);
      });
    });
    const atlJogos={};
    Object.entries(atlJogosSet).forEach(([aid,s])=>{atlJogos[aid]=s.size;});
    // ISP & IGP per athlete
    const atlISP={}, atlIGP={};
    Object.entries(porAtleta).forEach(([aid,dms])=>{
      const g=dms.map(d=>d._sc.global).filter(v=>v!=null);
      const q=dms.map(d=>d.post?.qualidade).filter(v=>v!=null);
      if(g.length){atlIGP[aid]=Math.round(avg(g));atlISP[aid]=Math.round(avg(g)*fatorQ(avg(q)));}
    });
    // Availability % per athlete across games
    const atlAvail={};
    atletasAtivosArr.forEach(a=>{
      const avail=totalJogos?jogosData.filter(g=>getMedStatusOnDate(a.id,g.data)!=='afastado').length/totalJogos*100:null;
      atlAvail[a.id]=avail!=null?Math.round(avail):null;
    });

    function topAtleta(map,desc='maior'){
      const valid=Object.entries(map).filter(([aid,v])=>v!=null&&atletasMap[aid]);
      if(!valid.length)return null;
      valid.sort((a,b)=>desc==='maior'?b[1]-a[1]:a[1]-b[1]);
      return{aid:valid[0][0],val:valid[0][1],nome:atletasMap[valid[0][0]]?.nome||'—'};
    }
    function top3Atleta(map,desc='maior',fmt=v=>v){
      const valid=Object.entries(map).filter(([aid,v])=>v!=null&&v>0&&atletasMap[aid]);
      if(!valid.length)return[];
      valid.sort((a,b)=>desc==='maior'?b[1]-a[1]:a[1]-b[1]);
      return valid.slice(0,3).map(([aid,v],i)=>{
        const medal=['🥇','🥈','🥉'][i];
        const nome=atletasMap[aid]?.nome||'—';
        return `${medal} ${nome} (${fmt(v)})`;
      });
    }
    function top10Atleta(map,desc='maior',fmt=v=>v){
      const valid=Object.entries(map).filter(([aid,v])=>v!=null&&v>0&&atletasMap[aid]);
      if(!valid.length)return[];
      valid.sort((a,b)=>desc==='maior'?b[1]-a[1]:a[1]-b[1]);
      return valid.slice(0,10).map(([aid,v],i)=>{
        const prefix=i<3?['🥇','🥈','🥉'][i]:`${i+1}.`;
        const nome=atletasMap[aid]?.nome||'—';
        return `${prefix} ${nome} (${fmt(v)})`;
      });
    }
    const topGol=topAtleta(atlGols);
    const topFinAtl=topAtleta(atlFin);
    const topDGAtl=topAtleta(atlDG);
    const topMins=topAtleta(atlMins);
    const topISPAtl=topAtleta(atlISP);
    const topIGPAtl=topAtleta(atlIGP);
    const topAvail=topAtleta(atlAvail);
    // Defensive efficiency
    const defEff={};
    Object.keys({...atlDG,...atlDP}).forEach(aid=>{
      const dg=atlDG[aid]||0, dp=atlDP[aid]||0;
      if(dg+dp>0)defEff[aid]=Math.round(dg/(dg+dp)*100);
    });
    const topDefEff=topAtleta(defEff);
    // Most actions from perfSnapshot
    const atlAcoes={};
    partidasFiltradas.forEach(p=>{
      Object.values(p.perfSnapshot||{}).forEach(s=>{
        if(!s.athleteId)return;
        atlAcoes[s.athleteId]=(atlAcoes[s.athleteId]||0)+(s.acoes||0);
      });
    });
    const topAcoes=topAtleta(atlAcoes);

    // ── Reconciliation warnings ───────────────────────────────────────────
    const warnings=[];
    // 1. Gravity bins
    const somaGravidade=lesLeve+lesMod+lesGrave+lesSemInfo;
    if(totalLesoes>0&&somaGravidade!==totalLesoes){
      warnings.push(`[Reconciliação] Soma lesões por gravidade (${somaGravidade}) ≠ total (${totalLesoes})`);
    }
    // 2. Gols pró blocks sum
    if(isFutebol&&allEvents.length>0){
      const somaGolsBloco=blocos15.reduce((s,b)=>s+b.gP,0);
      if(somaGolsBloco!==totalGolsPro){
        warnings.push(`[Reconciliação] Soma de Gols Pró por bloco (${somaGolsBloco}) ≠ total de gols (${totalGolsPro}) — verificar eventos vs placar`);
      }
    }
    // 3. Disponibilidade consistency
    if(dispPerGame.length>0&&dispMedia!=null){
      const computedAvg=Math.round(avg(dispPerGame));
      if(Math.abs(computedAvg-dispMedia)>2){
        warnings.push(`[Reconciliação] Disponibilidade média calculada (${computedAvg}%) difere do valor exibido (${dispMedia}%)`);
      }
    }

    // ── Auto-derived insights ─────────────────────────────────────────────
    const forcas=[], desafios=[];
    if(aproveitamento!=null&&aproveitamento>=60)
      forcas.push(`Campanha sólida: ${aproveitamento}% aproveitamento (${totalV}V ${totalE}E ${totalD}D) → Seção 4B`);
    if(dispMedia!=null&&dispMedia>=80)
      forcas.push(`Alta disponibilidade média: ${dispMedia}% de atletas aptos por jogo → Seção 2A`);
    if(saldoGols>0)
      forcas.push(`Saldo de gols positivo: +${saldoGols} (${totalGolsPro} marcados, ${totalGolsContra} sofridos) → Seção 4B`);
    const golsProEarly=blocos15.slice(0,4).reduce((s,b)=>s+b.gP,0);
    const golsProLate=blocos15.slice(4).reduce((s,b)=>s+b.gP,0);
    const golsContraEarly=blocos15.slice(0,4).reduce((s,b)=>s+b.gC,0);
    const golsContraLate=blocos15.slice(4).reduce((s,b)=>s+b.gC,0);
    if(isFutebol&&allEvents.length>0&&golsProLate>golsProEarly)
      forcas.push(`Produção ofensiva no 2º tempo: ${golsProLate} gols marcados após os 60' vs ${golsProEarly} antes → Seção 4B`);
    if(isFutebol&&allEvents.length>0&&golsContraLate>golsContraEarly)
      desafios.push(`Gols sofridos no 2º tempo: ${golsContraLate} gols contra após os 60' vs ${golsContraEarly} antes → Seção 4B`);
    if(aproveitamento!=null&&aproveitamento<50)
      desafios.push(`Aproveitamento abaixo de 50%: ${aproveitamento}% → Seção 1`);
    if(dispMedia!=null&&dispMedia<75)
      desafios.push(`Disponibilidade limitada: ${dispMedia}% médio → Seção 2A`);
    // Scout-based insights
    if(isFutebol&&totalJogos>0&&allEvents.length>0){
      const totalDG=+avgDGCh + +avgDGAr;
      const totalDP=+avgDPCh + +avgDPAr;
      if(+avgFalta>15)
        desafios.push(`Alto número de faltas: ${avgFalta}/jogo — risco disciplinar → Seção 4A`);
      if(totalDP>totalDG)
        desafios.push(`Balanço de duelos negativo: ${totalDP.toFixed(1)} perdidos vs ${totalDG.toFixed(1)} ganhos/jogo → Seção 4B`);
      if(+avgGolsContra>1.5)
        desafios.push(`Média de gols sofridos elevada: ${avgGolsContra}/jogo → Seção 4B`);
      if(+avgFin<8)
        desafios.push(`Baixo volume de finalizações: ${avgFin}/jogo → Seção 4A`);
      // Forças
      if(totalDG>totalDP)
        forcas.push(`Domínio nos duelos: ${totalDG.toFixed(1)} ganhos vs ${totalDP.toFixed(1)} perdidos/jogo → Seção 4B`);
      if(+avgFin>=12)
        forcas.push(`Alto volume ofensivo: ${avgFin} finalizações/jogo → Seção 4A`);
    }
    while(forcas.length<3)forcas.push('');
    while(desafios.length<3)desafios.push('');

    // Fechamento: wins vs non-wins scout comparison
    const jogosVit=jogosData.filter(g=>g.resultado==='V');
    const jogosNVit=jogosData.filter(g=>g.resultado!=='V');
    function avgEvPerGame(jgs,action){
      if(!jgs.length)return null;
      const tot=jgs.reduce((s,g)=>{return s+(eventsMap[g.id]||[]).filter(e=>e.action===action).length;},0);
      return (tot/jgs.length).toFixed(1);
    }
    const cmpFin=[avgEvPerGame(jogosVit,'Finalização'),avgEvPerGame(jogosNVit,'Finalização')];
    const cmpCC=[avgEvPerGame(jogosVit,'Chance clara criada'),avgEvPerGame(jogosNVit,'Chance clara criada')];
    const cmpDG=[avgEvPerGame(jogosVit,'Duelo ganho (chão)'),avgEvPerGame(jogosNVit,'Duelo ganho (chão)')];
    const cmpFalta=[avgEvPerGame(jogosVit,'Falta'),avgEvPerGame(jogosNVit,'Falta')];
    const showComparacao=jogosVit.length>=2&&jogosNVit.length>=2;

    // ── V × E × D full comparison ─────────────────────────────────────────
    const jogosEmp=jogosData.filter(g=>g.resultado==='E');
    const jogosD=jogosData.filter(g=>g.resultado==='D');
    const vedFin=[avgEvPerGame(jogosVit,'Finalização'),avgEvPerGame(jogosEmp,'Finalização'),avgEvPerGame(jogosD,'Finalização')];
    const vedCC=[avgEvPerGame(jogosVit,'Chance clara criada'),avgEvPerGame(jogosEmp,'Chance clara criada'),avgEvPerGame(jogosD,'Chance clara criada')];
    const vedDGCh=[avgEvPerGame(jogosVit,'Duelo ganho (chão)'),avgEvPerGame(jogosEmp,'Duelo ganho (chão)'),avgEvPerGame(jogosD,'Duelo ganho (chão)')];
    const vedDGAr=[avgEvPerGame(jogosVit,'Duelo ganho (alto)'),avgEvPerGame(jogosEmp,'Duelo ganho (alto)'),avgEvPerGame(jogosD,'Duelo ganho (alto)')];
    const vedDPCh=[avgEvPerGame(jogosVit,'Duelo perdido (chão)'),avgEvPerGame(jogosEmp,'Duelo perdido (chão)'),avgEvPerGame(jogosD,'Duelo perdido (chão)')];
    const vedDPAr=[avgEvPerGame(jogosVit,'Duelo perdido (alto)'),avgEvPerGame(jogosEmp,'Duelo perdido (alto)'),avgEvPerGame(jogosD,'Duelo perdido (alto)')];
    const vedFalta=[avgEvPerGame(jogosVit,'Falta'),avgEvPerGame(jogosEmp,'Falta'),avgEvPerGame(jogosD,'Falta')];
    const vedBD=[avgEvPerGame(jogosVit,'Boa decisão'),avgEvPerGame(jogosEmp,'Boa decisão'),avgEvPerGame(jogosD,'Boa decisão')];
    // Erros totais (Erro NF + Erro pressão) per group
    function avgErroPerGame(jgs){
      if(!jgs.length)return null;
      const tot=jgs.reduce((s,g)=>{const evs=eventsMap[g.id]||[];return s+evs.filter(e=>e.action==='Erro NF'||e.action==='Erro pressão').length;},0);
      return (tot/jgs.length).toFixed(1);
    }
    const vedErros=[avgErroPerGame(jogosVit),avgErroPerGame(jogosEmp),avgErroPerGame(jogosD)];
    const vedGolsPro=[
      jogosVit.length?(jogosVit.reduce((s,g)=>s+g.pro,0)/jogosVit.length).toFixed(1):null,
      jogosEmp.length?(jogosEmp.reduce((s,g)=>s+g.pro,0)/jogosEmp.length).toFixed(1):null,
      jogosD.length?(jogosD.reduce((s,g)=>s+g.pro,0)/jogosD.length).toFixed(1):null,
    ];
    const vedGolsCon=[
      jogosVit.length?(jogosVit.reduce((s,g)=>s+g.con,0)/jogosVit.length).toFixed(1):null,
      jogosEmp.length?(jogosEmp.reduce((s,g)=>s+g.con,0)/jogosEmp.length).toFixed(1):null,
      jogosD.length?(jogosD.reduce((s,g)=>s+g.con,0)/jogosD.length).toFixed(1):null,
    ];
    const showVED=totalJogos>=3;

    // ── ISP pré-jogo: liga adaptação a resultado ──────────────────────────
    // Para cada jogo, calcula o ISP médio dos 7 dias anteriores
    jogosData.forEach(g=>{
      const gDate=new Date(g.data+'T00:00:00');
      const d7=new Date(gDate);d7.setDate(d7.getDate()-7);
      const d7str=d7.toLocaleDateString('en-CA');
      const dmsPre=allDM.filter(d=>d.date>=d7str&&d.date<g.data);
      const ispVals=dmsPre.map(d=>{const igp=d._sc.global,q=d.post?.qualidade;return igp!=null?igp*fatorQ(q):null;}).filter(v=>v!=null);
      g._ispPre=ispVals.length?Math.round(avg(ispVals)):null;
    });
    const ispFaixaDef=[
      {label:'> 80',fn:g=>g._ispPre!=null&&g._ispPre>80},
      {label:'70–80',fn:g=>g._ispPre!=null&&g._ispPre>=70&&g._ispPre<=80},
      {label:'< 70',fn:g=>g._ispPre!=null&&g._ispPre<70},
    ];
    const ispFaixasRows=ispFaixaDef.map(f=>{
      const jgs=jogosData.filter(f.fn);
      const v=jgs.filter(g=>g.resultado==='V').length;
      const e=jgs.filter(g=>g.resultado==='E').length;
      const d=jgs.filter(g=>g.resultado==='D').length;
      const aprov=jgs.length?Math.round((v*3+e)/(jgs.length*3)*100):null;
      return{label:f.label,total:jgs.length,v,e,d,aprov};
    });
    const hasIspFaixas=ispFaixasRows.some(r=>r.total>0);

    // ── Semana carga maior/menor ──────────────────────────────────────────
    const semCargaNonNull=semCarga.filter(v=>v!=null);
    const semMaiorCargaLabel=semCargaNonNull.length?semLabels[semCarga.indexOf(Math.max(...semCargaNonNull))]:'—';
    const semMenorCargaLabel=semCargaNonNull.length?semLabels[semCarga.indexOf(Math.min(...semCargaNonNull))]:'—';

    // ── Warnings HTML ─────────────────────────────────────────────────────
    const warningsHtml=warnings.length?`
      <div id="warningsConsole" style="position:fixed;bottom:0;left:0;right:0;background:#fef3c7;border-top:2px solid #d97706;padding:8px 16px;font-family:monospace;font-size:11px;color:#92400e;z-index:9999;max-height:120px;overflow-y:auto;">
        <strong>⚠ Avisos de Reconciliação (${warnings.length})</strong><br>
        ${warnings.map(w=>`• ${esc(w)}`).join('<br>')}
      </div>`:'';

    // ── Build HTML ────────────────────────────────────────────────────────
    const hoje=new Date();
    const dataRelatorio=hoje.toLocaleDateString('pt-BR',{day:'2-digit',month:'long',year:'numeric'});

    // Helper for KPI box
    const kpiBox=(title,value,sub='',color='#1a56db')=>`
      <div style="background:#f8faff;border:1px solid #dbeafe;border-radius:8px;padding:12px 16px;text-align:center;flex:1;min-width:120px;">
        <div style="font-size:10px;color:#6b7280;margin-bottom:4px;font-family:'Inter',sans-serif;">${title}</div>
        <div style="font-size:24px;font-weight:800;color:${color};font-family:'Archivo',sans-serif;line-height:1.1;">${value}</div>
        ${sub?`<div style="font-size:9px;color:#9ca3af;margin-top:2px;">${sub}</div>`:''}
      </div>`;

    const pageStyle='position:relative;background:#fff;overflow:hidden;box-sizing:border-box;';
    const headerStrip=`<div style="background:#1a56db;color:#fff;padding:10px 28px;display:flex;align-items:center;justify-content:between;gap:12px;">
      <div style="font-family:'Archivo',sans-serif;font-size:13px;font-weight:700;flex:1;">${esc(nomeClube)}</div>
      <div style="font-family:'Inter',sans-serif;font-size:10px;opacity:.8;">${periodoLabel} · Ciente IE</div>
    </div>`;

    // ════════ PAGE 0 – CAPA ══════════════════════════════════════════════
    const page0=`
    <section class="page" data-essencial="false" style="${pageStyle}width:1122px;height:793px;">
      <div style="background:#1a56db;height:8px;width:100%;"></div>
      <div style="padding:60px 80px;">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;">
          <div>
            <div style="font-family:'Inter',sans-serif;font-size:11px;font-weight:600;letter-spacing:2px;color:#6b7280;text-transform:uppercase;margin-bottom:8px;">Inteligência Esportiva</div>
            <h1 style="font-family:'Archivo',sans-serif;font-size:52px;font-weight:900;color:#111827;line-height:1;margin:0 0 12px;">Relatório Geral<br>Fase de Grupos</h1>
            <div style="font-family:'Inter',sans-serif;font-size:18px;color:#1a56db;font-weight:600;">${periodoLabel}</div>
            <div style="font-family:'Inter',sans-serif;font-size:13px;color:#6b7280;margin-top:6px;">${esc(nomeClube)} · ${dataRelatorio}${categoria?` · ${esc(categoria)}`:''}</div>
          </div>
          <div style="text-align:right;opacity:.07;font-size:160px;line-height:1;font-family:'Archivo',sans-serif;font-weight:900;color:#1a56db;">IE</div>
        </div>
        <div style="margin-top:48px;background:#f8faff;border-radius:12px;padding:24px 32px;border:1px solid #dbeafe;">
          <div style="font-family:'Archivo',sans-serif;font-size:13px;font-weight:700;color:#374151;margin-bottom:16px;letter-spacing:.5px;">ÍNDICE</div>
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px 32px;font-family:'Inter',sans-serif;font-size:11px;color:#4b5563;">
            <div>1 · Resumo Executivo</div>
            <div>2 · Disponibilidade, Lesões e Retorno</div>
            <div>3 · Distribuição de Carga e Carga Interna</div>
            <div>3C · Prontidão / Adaptação</div>
            ${isFutebol?`
            <div>4 · Análise Tática — Produção e Posse de Campo</div>
            <div>4C · Duelos por Setor e Tempo</div>
            <div>4D · Erros × Boas Decisões</div>
            <div>4F · Roubadas de Bola</div>
            <div>4E · Vitória × Empate × Derrota</div>
            <div>4G · Entradas no Setor de Ataque</div>
            `:''}
            <div>5 · Time da Primeira Fase</div>
            <div>5B · Minutos Jogados</div>
          </div>
        </div>
        <div style="margin-top:24px;display:flex;align-items:center;gap:8px;">
          <div style="width:32px;height:3px;background:#1a56db;border-radius:2px;"></div>
          <div style="font-family:'Inter',sans-serif;font-size:10px;color:#9ca3af;">Gerado automaticamente pela plataforma Ciente IE · Todos os dados são de responsabilidade do clube</div>
        </div>
      </div>
      <div style="position:absolute;bottom:0;left:0;right:0;height:6px;background:linear-gradient(90deg,#1a56db,#dc2626);"></div>
    </section>`;

    // ════════ PAGE 1 – RESUMO EXECUTIVO ══════════════════════════════════
    const scoutStatsRows=isFutebol&&allEvents.length>0&&totalJogos>0?[
      ['Finalizações / Jogo',avgFin],
      ['Chances Claras / Jogo',avgCC],
      ['Gols Pró / Jogo',avgGolsPro],
      ['Gols Contra / Jogo',avgGolsContra],
      ['Faltas / Jogo',avgFalta],
      ['Duelos Ganhos / Jogo',+(+avgDGCh + +avgDGAr).toFixed(1)],
      ['Duelos Perdidos / Jogo',+(+avgDPCh + +avgDPAr).toFixed(1)],
    ]:[];
    const statsTableRows=[
      ['Aproveitamento Geral', aproveitamento!=null?`${aproveitamento}%`:'—'],
      ['Aproveitamento em Casa', aprovCasa!=null?`${aprovCasa}%`:'—'],
      ['Aproveitamento Fora', aprovFora!=null?`${aprovFora}%`:'—'],
      ['Gols em Casa', golsCasaPro],
      ['Gols Fora', golsForaPro],
      ['Gols Sofridos em Casa', golsCasaContra],
      ['Gols Sofridos Fora', golsForaContra],
      ['Conversão (Fin. → Gol)', convPro!=null?`${convPro}%`:'—'],
      ['Conversão Adversário', convAdv!=null?`${convAdv}%`:'—'],
      ['Finalizações por Gol Marcado', finPorGolPro!=null?finPorGolPro:'—'],
      ['Finalizações por Gol Sofrido', finPorGolAdv!=null?finPorGolAdv:'—'],
    ].map(([k,v],i)=>`<tr style="background:${i%2===0?'#fff':'#f9fafb'};"><td style="padding:5px 10px;border-bottom:1px solid #f3f4f6;font-size:11px;color:#374151;font-family:'Inter',sans-serif;">${k}</td><td style="padding:5px 10px;border-bottom:1px solid #f3f4f6;font-weight:700;font-size:12px;font-family:'Archivo',sans-serif;color:#111827;text-align:right;">${v}</td></tr>`).join('');

    const page1=`
    <section class="page" data-essencial="true" style="${pageStyle}width:1122px;height:793px;">
      ${headerStrip}
      <div style="padding:18px 28px 0;">
        <div style="font-family:'Archivo',sans-serif;font-size:16px;font-weight:800;color:#111827;margin-bottom:14px;">1 · Resumo Executivo</div>
        <div style="display:grid;grid-template-columns:340px 1fr;gap:24px;align-items:start;">
          <div>
            <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;border:1px solid #e5e7eb;">
              <thead><tr style="background:#f9fafb;">
                <th style="padding:6px 10px;font-size:10px;font-family:'Inter',sans-serif;color:#6b7280;font-weight:600;text-align:left;">Indicador</th>
                <th style="padding:6px 10px;font-size:10px;font-family:'Inter',sans-serif;color:#6b7280;font-weight:600;text-align:right;">Valor</th>
              </tr></thead>
              <tbody>${statsTableRows}</tbody>
            </table>
            <div style="margin-top:12px;display:flex;align-items:center;gap:10px;">
              <div style="font-family:'Inter',sans-serif;font-size:10px;color:#6b7280;">Resultado:</div>
              ${svgMiniBarWDL(totalV,totalE,totalD)}
              ${aproveitamento!=null?`<div style="font-family:'Archivo',sans-serif;font-size:13px;font-weight:700;color:#111827;">${aproveitamento}%</div>`:''}
            </div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
            <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:14px 16px;">
              <div style="font-family:'Archivo',sans-serif;font-size:12px;font-weight:700;color:#166534;margin-bottom:10px;">✓ Pontos Fortes</div>
              ${forcas.map((f,i)=>`<div contenteditable="true" style="font-family:'Inter',sans-serif;font-size:11px;color:#15803d;padding:5px 8px;border-radius:5px;background:#dcfce7;margin-bottom:6px;cursor:text;min-height:18px;" data-placeholder="Clique para editar">${esc(f)||`<span style="color:#9ca3af;font-style:italic;">Clique para editar</span>`}</div>`).join('')}
            </div>
            <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:14px 16px;">
              <div style="font-family:'Archivo',sans-serif;font-size:12px;font-weight:700;color:#991b1b;margin-bottom:10px;">△ Principais Desafios</div>
              ${desafios.map((d,i)=>`<div contenteditable="true" style="font-family:'Inter',sans-serif;font-size:11px;color:#b91c1c;padding:5px 8px;border-radius:5px;background:#fee2e2;margin-bottom:6px;cursor:text;min-height:18px;">${esc(d)||`<span style="color:#9ca3af;font-style:italic;">Clique para editar</span>`}</div>`).join('')}
            </div>
            <div style="grid-column:1/-1;background:#f8faff;border:1px solid #dbeafe;border-radius:10px;padding:14px 16px;">
              <div style="font-family:'Archivo',sans-serif;font-size:11px;font-weight:700;color:#1a56db;margin-bottom:8px;">IGP / ISP Médios do Período</div>
              <div style="display:flex;gap:16px;">
                ${kpiBox('IGP Médio',avgRound(allDM.map(d=>d._sc.global).filter(v=>v!=null))??'—','Índice Global de Prontidão','#1a56db')}
                ${kpiBox('ISP Médio',avgRound(allDM.map(d=>{const g=d._sc.global,q=d.post?.qualidade;return g!=null?g*fatorQ(q):null}).filter(v=>v!=null))??'—','Índice Semanal de Adaptação','#7c3aed')}
                ${kpiBox('PSE Média',pseMed??'—','Percepção subjetiva de esforço','#059669')}
                ${kpiBox('Semanas Monitoradas',semanasComDados.length,'no período selecionado','#374151')}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>`;

    // ════════ PAGE 2 – DISPONIBILIDADE, LESÕES E RETORNO ═════════════════
    const dispValues=jogosData.map(g=>g.dispPct);
    // Build grave injuries table outside template to avoid backtick nesting
    let _lesAllRows='';
    const _gravLabel=d=>{const v=getDiasCalculado(d);if(v==null)return{l:'Sem info',c:'#9ca3af'};if(v>28)return{l:'Grave',c:'#dc2626'};if(v>=8)return{l:'Moderada',c:'#f97316'};return{l:'Leve',c:'#16a34a'};};
    docLesoesSorted.forEach((d,idx)=>{
      const atl=atletasMap[d.athleteId];
      const nome=atl?esc(atl.nome||'—'):'—';
      const tipo=esc(d.dados?.tipoLesao||d.tipoLesao||'—');
      const reg=esc(normRegiao(d.dados?.regiao||d.dados?.regiaoAnatomica||d.regiao||''));
      const dias=getDiasCalculado(d)??'—';
      const status=getLesaoStatusHtml(d);
      const {l:gravL,c:gravC}=_gravLabel(d);
      _lesAllRows+='<tr style="background:'+(idx%2===0?'#fff':'#fef9f9')+';">'
        +'<td style="padding:3px 5px;border:1px solid #fecaca;font-weight:600;color:#1f2937;">'+nome+'</td>'
        +'<td style="padding:3px 5px;border:1px solid #fecaca;"><span style="color:'+gravC+';font-weight:700;font-size:8px;">'+gravL+'</span></td>'
        +'<td style="padding:3px 5px;border:1px solid #fecaca;color:#7f1d1d;">'+tipo+'</td>'
        +'<td style="padding:3px 5px;border:1px solid #fecaca;color:#374151;">'+reg+'</td>'
        +'<td style="padding:3px 5px;border:1px solid #fecaca;text-align:center;color:#374151;">'+esc(d._date||'—')+'</td>'
        +'<td style="padding:3px 5px;border:1px solid #fecaca;text-align:center;font-weight:700;color:#dc2626;">'+dias+'</td>'
        +'<td style="padding:3px 5px;border:1px solid #fecaca;">'+status+'</td>'
        +'</tr>';
    });
        const _lesGraveHtml=docLesoesSorted.length===0?'':'<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:6px 10px;margin-top:8px;">'
      +'<div style="font-family:Archivo,sans-serif;font-size:10px;font-weight:700;color:#dc2626;margin-bottom:5px;">Lesões no Período</div>'
      +'<table style="width:100%;border-collapse:collapse;font-family:Inter,sans-serif;font-size:8px;">'
      +'<thead><tr style="background:#fee2e2;">'
      +'<th style="text-align:left;padding:3px 5px;border:1px solid #fecaca;color:#991b1b;font-weight:700;">Atleta</th>'
      +'<th style="text-align:left;padding:3px 5px;border:1px solid #fecaca;color:#991b1b;font-weight:700;">Gravidade</th>'
      +'<th style="text-align:left;padding:3px 5px;border:1px solid #fecaca;color:#991b1b;font-weight:700;">Tipo</th>'
      +'<th style="text-align:left;padding:3px 5px;border:1px solid #fecaca;color:#991b1b;font-weight:700;">Região</th>'
      +'<th style="text-align:center;padding:3px 5px;border:1px solid #fecaca;color:#991b1b;font-weight:700;">Data</th>'
      +'<th style="text-align:center;padding:3px 5px;border:1px solid #fecaca;color:#991b1b;font-weight:700;">Dias</th>'
      +'<th style="text-align:left;padding:3px 5px;border:1px solid #fecaca;color:#991b1b;font-weight:700;">Status</th>'
      +'</tr></thead><tbody>'+_lesAllRows+'</tbody></table></div>';
    // Pre-build ctx + RTP block (avoids backtick nesting in page2 template)
    const _tot=ctxTreino+ctxJogo||1;
    const _pctT=Math.round(ctxTreino/_tot*100),_pctJ=Math.round(ctxJogo/_tot*100);
    const _ctxW=200,_bH=22,_gap=8,_pl=52,_pr=8,_pt=4,_cw=_ctxW-_pl-_pr;
    const _ctxSvg='<svg width="'+_ctxW+'" height="'+(_bH*2+_gap+_pt*2)+'" xmlns="http://www.w3.org/2000/svg">'
      +'<text x="'+_pl+'" y="'+(_pt+_bH/2+1)+'" text-anchor="end" fill="#374151" font-size="9" font-family="Inter" dominant-baseline="middle">Treino</text>'
      +'<rect x="'+_pl+'" y="'+_pt+'" width="'+_cw+'" height="'+_bH+'" rx="4" fill="#fed7aa"/>'
      +(ctxTreino>0?'<rect x="'+_pl+'" y="'+_pt+'" width="'+Math.round(_cw*ctxTreino/_tot)+'" height="'+_bH+'" rx="4" fill="#f97316"/>':'')
      +'<text x="'+(_pl+Math.round(_cw*ctxTreino/_tot)+5)+'" y="'+(_pt+_bH/2+1)+'" fill="#c2410c" font-size="9" font-weight="700" font-family="Inter" dominant-baseline="middle">'+ctxTreino+' · '+_pctT+'%</text>'
      +'<text x="'+_pl+'" y="'+(_pt+_bH+_gap+_bH/2+1)+'" text-anchor="end" fill="#374151" font-size="9" font-family="Inter" dominant-baseline="middle">Jogo</text>'
      +'<rect x="'+_pl+'" y="'+(_pt+_bH+_gap)+'" width="'+_cw+'" height="'+_bH+'" rx="4" fill="#fecaca"/>'
      +(ctxJogo>0?'<rect x="'+_pl+'" y="'+(_pt+_bH+_gap)+'" width="'+Math.round(_cw*ctxJogo/_tot)+'" height="'+_bH+'" rx="4" fill="#dc2626"/>':'')
      +'<text x="'+(_pl+Math.round(_cw*ctxJogo/_tot)+5)+'" y="'+(_pt+_bH+_gap+_bH/2+1)+'" fill="#991b1b" font-size="9" font-weight="700" font-family="Inter" dominant-baseline="middle">'+ctxJogo+' · '+_pctJ+'%</text>'
      +'</svg>';
    let _rtpInner='';
    rtpAtletas.forEach(a=>{_rtpInner+='<div style="background:#fffbeb;border:1px solid #fcd34d;border-radius:4px;padding:2px 8px;font-family:Inter,sans-serif;font-size:9px;color:#78350f;">'+esc(a.nome)+' · F'+a.fase+'</div>';});
    const _rtpBlock=rtpAtletas.length===0?''
      :'<div style="background:#fef9ec;border:1px solid #fcd34d;border-radius:6px;padding:8px 10px;">'
      +'<div style="font-family:Archivo,sans-serif;font-size:10px;font-weight:700;color:#92400e;margin-bottom:4px;">Return-to-Play (F0–F3)</div>'
      +'<div style="display:flex;flex-direction:column;gap:3px;">'+_rtpInner+'</div></div>';
    const _ctxRtpHtml='<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px;">'
      +'<div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:6px;padding:8px 10px;">'
      +'<div style="font-family:Archivo,sans-serif;font-size:10px;font-weight:700;color:#c2410c;margin-bottom:6px;">Contexto das Lesões</div>'
      +_ctxSvg+'</div>'
      +(_rtpBlock||'<div></div>')
      +'</div>';
        const page2=`
<section class="page" data-essencial="true" style="${pageStyle}width:1122px;height:793px;">
  ${headerStrip}
  <div style="padding:14px 28px 0;">
    <div style="font-family:'Archivo',sans-serif;font-size:16px;font-weight:800;color:#111827;margin-bottom:10px;">2 · Disponibilidade, Lesões e Retorno</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
      <!-- LEFT: Availability -->
      <div>
        <div style="font-family:'Archivo',sans-serif;font-size:12px;font-weight:700;color:#1a56db;margin-bottom:6px;border-bottom:2px solid #1a56db;padding-bottom:3px;">Disponibilidade do Elenco</div>
        ${totalJogos===0?`<div style="font-family:'Inter',sans-serif;font-size:12px;color:#6b7280;padding:12px;text-align:center;">Nenhuma partida registrada</div>`:`
        <div style="display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
          ${kpiBox('Disp. Média',dispMedia!=null?dispMedia+'%':'—','atletas aptos/elenco')}
          ${kpiBox('Elenco Ativo',atletasAtivosArr.length,'atletas')}
        </div>
        <div style="background:#f8faff;border:1px solid #dbeafe;border-radius:8px;padding:8px;">
          <div style="font-family:'Inter',sans-serif;font-size:9px;color:#6b7280;margin-bottom:4px;">Disponibilidade por Jogo (%)</div>
          ${svgLineChart(dispValues,jogosData.map(g=>g.label),{w:480,h:120,refValue:dispMedia,color:'#1a56db',refLabel:`Média ${dispMedia}%`,yMin:0,yMax:100})}
        </div>
        ${atletasAusentesJogos.length>0?`
        <div style="margin-top:8px;background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:8px 10px;">
          <div style="font-family:'Archivo',sans-serif;font-size:10px;font-weight:700;color:#9a3412;margin-bottom:6px;">Atletas ausentes por afastamento/transição</div>
          <table style="width:100%;border-collapse:collapse;font-family:'Inter',sans-serif;font-size:8.5px;">
            <thead>
              <tr style="background:#fef3c7;">
                <th style="text-align:left;padding:3px 6px;border:1px solid #fed7aa;color:#92400e;font-weight:700;width:22%;">Atleta</th>
                <th style="text-align:left;padding:3px 6px;border:1px solid #fed7aa;color:#92400e;font-weight:700;width:15%;">Tipo de Lesão</th>
                <th style="text-align:left;padding:3px 6px;border:1px solid #fed7aa;color:#92400e;font-weight:700;width:10%;">Status</th>
                <th style="text-align:left;padding:3px 6px;border:1px solid #fed7aa;color:#92400e;font-weight:700;">Jogos ausente</th>
              </tr>
            </thead>
            <tbody>
              ${atletasAusentesJogos.map((a,idx)=>`
              <tr style="background:${idx%2===0?'#fff':'#fffbeb'};">
                <td style="padding:3px 6px;border:1px solid #fed7aa;color:#1f2937;font-weight:600;">${esc(a.nome)}</td>
                <td style="padding:3px 6px;border:1px solid #fed7aa;color:#92400e;">${esc(a.tipoLesao||'—')}</td>
                <td style="padding:3px 6px;border:1px solid #fed7aa;color:#92400e;">${esc(a.motivo)}</td>
                <td style="padding:3px 6px;border:1px solid #fed7aa;color:#374151;">${a.jogosFora.map(g=>esc(g.label)).join(', ')}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>`:''}`}
        ${_ctxRtpHtml}
      </div>
      <!-- RIGHT: Injuries -->
      <div>
        <div style="font-family:'Archivo',sans-serif;font-size:12px;font-weight:700;color:#dc2626;margin-bottom:6px;border-bottom:2px solid #dc2626;padding-bottom:3px;">Lesões e Retorno</div>
        ${totalLesoes===0?`<div style="font-family:'Inter',sans-serif;font-size:12px;color:#6b7280;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;padding:16px;text-align:center;">Nenhuma lesão no período</div>`:`
        <div style="display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
          ${kpiBox('Total Lesões',totalLesoes,'casos','#dc2626')}
          ${kpiBox('Média Dias',mediaDiasPorLesao??'—','por lesão','#f97316')}
        </div>
        <div style="display:grid;grid-template-columns:1fr auto;gap:12px;align-items:start;">
          <table style="width:100%;border-collapse:collapse;border-radius:6px;overflow:hidden;border:1px solid #e5e7eb;">
            <thead><tr style="background:#fef2f2;">
              <th style="padding:4px 8px;font-size:9px;font-family:'Inter',sans-serif;color:#991b1b;font-weight:600;text-align:left;">Gravidade</th>
              <th style="padding:4px 8px;font-size:9px;font-family:'Inter',sans-serif;color:#991b1b;font-weight:600;text-align:center;">Casos</th>
              <th style="padding:4px 8px;font-size:9px;font-family:'Inter',sans-serif;color:#991b1b;font-weight:600;text-align:center;">%</th>
            </tr></thead>
            <tbody>
              <tr><td style="padding:4px 8px;font-family:'Inter',sans-serif;font-size:10px;">Leve (1–7d)</td><td style="padding:4px 8px;text-align:center;font-weight:700;font-family:'Archivo',sans-serif;">${lesLeve}</td><td style="padding:4px 8px;text-align:center;font-size:9px;">${totalLesoes?Math.round(lesLeve/totalLesoes*100):0}%</td></tr>
              <tr style="background:#f9fafb;"><td style="padding:4px 8px;font-family:'Inter',sans-serif;font-size:10px;">Moderada (8–28d)</td><td style="padding:4px 8px;text-align:center;font-weight:700;font-family:'Archivo',sans-serif;">${lesMod}</td><td style="padding:4px 8px;text-align:center;font-size:9px;">${totalLesoes?Math.round(lesMod/totalLesoes*100):0}%</td></tr>
              <tr><td style="padding:4px 8px;font-family:'Inter',sans-serif;font-size:10px;">Grave (&gt;28d)</td><td style="padding:4px 8px;text-align:center;font-weight:700;font-family:'Archivo',sans-serif;">${lesGrave}</td><td style="padding:4px 8px;text-align:center;font-size:9px;">${totalLesoes?Math.round(lesGrave/totalLesoes*100):0}%</td></tr>
              ${lesSemInfo>0?`<tr style="background:#f9fafb;"><td style="padding:4px 8px;font-family:'Inter',sans-serif;font-size:10px;color:#9ca3af;">Sem info</td><td style="padding:4px 8px;text-align:center;font-weight:700;font-family:'Archivo',sans-serif;color:#9ca3af;">${lesSemInfo}</td><td style="padding:4px 8px;text-align:center;font-size:9px;color:#9ca3af;">—</td></tr>`:''}
            </tbody>
          </table>
          <div>
            <div style="font-family:'Inter',sans-serif;font-size:9px;color:#6b7280;margin-bottom:3px;">Tipos de Lesão</div>
            ${svgPieChart(tipoPieData,{w:130,h:130})}
            <div style="display:flex;flex-direction:column;gap:2px;margin-top:4px;">${tipoPieData.map(d=>`<div style="display:flex;align-items:center;gap:3px;font-family:'Inter',sans-serif;font-size:8px;color:#374151;"><div style="width:6px;height:6px;border-radius:50%;background:${d.color};"></div>${d.label} (${d.value})</div>`).join('')}</div>
          </div>
        </div>
        ${_lesGraveHtml}
        `}
      </div>
    </div>
  </div>
</section>`;

    // ════════ PAGE 3AB – CARGA MICROCICLO + CARGA INTERNA ════════════════
    const page3ab=`
<section class="page" data-essencial="true" style="${pageStyle}width:1122px;height:793px;">
  ${headerStrip}
  <div style="padding:14px 28px 0;">
    <div style="font-family:'Archivo',sans-serif;font-size:16px;font-weight:800;color:#111827;margin-bottom:10px;">3 · Distribuição de Carga e Carga Interna</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start;">
      <!-- LEFT: Microciclo -->
      <div>
        <div style="font-family:'Archivo',sans-serif;font-size:12px;font-weight:700;color:#1a56db;margin-bottom:6px;border-bottom:2px solid #1a56db;padding-bottom:3px;">Distribuição por Microciclo</div>
        ${!hasMicrData?`<div style="font-family:'Inter',sans-serif;font-size:12px;color:#6b7280;background:#f9fafb;border-radius:6px;padding:16px;text-align:center;">Dados de microciclo não registrados</div>`:`
        <div style="display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
          ${kpiBox('Longe (MD-5→MD-3)',cargaLongeP!=null?`${cargaLongeP}%`:'—','','#ef4444')}
          ${kpiBox('Perto (MD-2→MD)',cargaPertoP!=null?`${cargaPertoP}%`:'—','','#10b981')}
          ${kpiBox('% vs Jogo (850)',pctCargaVsJogo!=null?`${pctCargaVsJogo}%`:'—','carga sem. / 850 u.a.','#7c3aed')}
        </div>
        <div style="background:#f8faff;border:1px solid #dbeafe;border-radius:8px;padding:8px;margin-bottom:6px;">
          <div style="font-family:'Inter',sans-serif;font-size:9px;color:#6b7280;margin-bottom:4px;">Carga média por MD (PSE × tempo, u.a.) — referência jogo: 850</div>
          ${svgBarChart(mdValues,mdLabels,mdColorsArr,{w:480,h:105,maxVal:Math.max(...mdValues.filter(v=>v!=null),850)*1.05})}
        </div>
        <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:8px;">
          <div style="font-family:'Inter',sans-serif;font-size:9px;color:#166534;margin-bottom:4px;">Volume médio por MD (minutos)</div>
          ${svgBarChart(mdTempoValues,mdLabels,mdTempoColorsArr,{w:480,h:95})}
        </div>
        <div style="margin-top:5px;display:flex;gap:6px;flex-wrap:wrap;">
          ${mdLabels.map((l,i)=>`<div style="display:flex;align-items:center;gap:3px;font-family:'Inter',sans-serif;font-size:8px;color:#374151;"><div style="width:6px;height:6px;border-radius:2px;background:${mdColorsArr[i]};"></div>${l}</div>`).join('')}
        </div>`}
      </div>
      <!-- RIGHT: Carga Interna -->
      <div>
        <div style="font-family:'Archivo',sans-serif;font-size:12px;font-weight:700;color:#7c3aed;margin-bottom:6px;border-bottom:2px solid #7c3aed;padding-bottom:3px;">Carga Interna Semanal</div>
        ${!hasPostData?`<div style="font-family:'Inter',sans-serif;font-size:12px;color:#6b7280;background:#f9fafb;border-radius:6px;padding:16px;text-align:center;">Carga interna não monitorada</div>`:`
        <div style="display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
          ${kpiBox('PSE Média',pseMed??'—','percepção de esforço')}
          ${kpiBox('Qualidade Média',qualMedia??'—','1–5','#7c3aed')}
          ${kpiBox('Evolução Qualidade',qualEvolucao!=null?(qualEvolucao>=0?`+${qualEvolucao.toFixed(1)}`:qualEvolucao.toFixed(1)):'—','2ª vs 1ª metade',qualEvolucao!=null&&qualEvolucao>=0?'#059669':'#dc2626')}
        </div>
        <div style="background:#f8faff;border:1px solid #dbeafe;border-radius:8px;padding:8px;">
          <div style="font-family:'Inter',sans-serif;font-size:9px;color:#6b7280;margin-bottom:4px;">Carga semanal normalizada (u.a.) — PSE × tempo × 5</div>
          ${svgBarChart(semCarga,semLabels,semCarga.map(()=>'#1a56db'),{w:480,h:130})}
        </div>`}
      </div>
    </div>
  </div>
</section>`;

    // ════════ PAGE 3C – ADAPTAÇÃO × RESULTADO ════════════════════════════
    const hasCMJ=cmjValidos.length>0;
    const semINMValidos=semINM.filter(v=>v!=null);
    const inmMedioFase=semINMValidos.length?Math.round(semINMValidos.reduce((a,b)=>a+b,0)/semINMValidos.length):null;
    const hasProntData=allDM.some(d=>d._sc.global!=null);
    // Aproveitamento color helper
    function aprovColor(a){return a==null?'#6b7280':a>=67?'#16a34a':a>=34?'#d97706':'#dc2626';}
    // Generic faixas table builder
    function buildFaixasTable(rows,colLabel,borderColor,bgColor){
      const hasAnyData=rows.some(r=>r.total>0);
      if(!hasAnyData)return`<div style="font-family:'Inter',sans-serif;font-size:11px;color:#9ca3af;background:#f9fafb;border-radius:6px;padding:12px;text-align:center;">Sem dados para este período</div>`;
      return`<table style="width:100%;border-collapse:collapse;">
        <thead><tr style="background:${bgColor};">
          <th style="padding:5px 8px;font-size:9px;font-family:'Inter',sans-serif;color:#6b7280;font-weight:700;text-align:left;border-bottom:2px solid ${borderColor};">${colLabel}</th>
          <th style="padding:5px 8px;font-size:9px;font-family:'Inter',sans-serif;color:#6b7280;font-weight:700;text-align:center;border-bottom:2px solid ${borderColor};">J</th>
          <th style="padding:5px 8px;font-size:9px;font-family:'Inter',sans-serif;color:#16a34a;font-weight:700;text-align:center;border-bottom:2px solid ${borderColor};">V</th>
          <th style="padding:5px 8px;font-size:9px;font-family:'Inter',sans-serif;color:#6b7280;font-weight:700;text-align:center;border-bottom:2px solid ${borderColor};">E</th>
          <th style="padding:5px 8px;font-size:9px;font-family:'Inter',sans-serif;color:#dc2626;font-weight:700;text-align:center;border-bottom:2px solid ${borderColor};">D</th>
          <th style="padding:5px 8px;font-size:9px;font-family:'Inter',sans-serif;color:#6b7280;font-weight:700;text-align:center;border-bottom:2px solid ${borderColor};">Aprov.</th>
        </tr></thead>
        <tbody>${rows.map((r,i)=>{
          const empty=r.total===0;
          const bg=empty?'#fafafa':i%2?'#f9fafb':'#fff';
          const textColor=empty?'#d1d5db':'#374151';
          return`
          <tr style="background:${bg};">
            <td style="padding:6px 8px;font-family:'Archivo',sans-serif;font-size:11px;font-weight:700;color:${textColor};">${r.label}</td>
            <td style="padding:6px 8px;text-align:center;font-family:'Inter',sans-serif;font-size:10px;color:${empty?'#d1d5db':'#6b7280'};">${r.total}</td>
            <td style="padding:6px 8px;text-align:center;font-family:'Archivo',sans-serif;font-size:12px;font-weight:700;color:${empty?'#d1d5db':'#16a34a'};">${empty?'—':r.v}</td>
            <td style="padding:6px 8px;text-align:center;font-family:'Archivo',sans-serif;font-size:12px;font-weight:700;color:${empty?'#d1d5db':'#6b7280'};">${empty?'—':r.e}</td>
            <td style="padding:6px 8px;text-align:center;font-family:'Archivo',sans-serif;font-size:12px;font-weight:700;color:${empty?'#d1d5db':'#dc2626'};">${empty?'—':r.d}</td>
            <td style="padding:6px 8px;text-align:center;"><span style="font-family:'Archivo',sans-serif;font-size:13px;font-weight:800;color:${empty?'#d1d5db':aprovColor(r.aprov)};">${empty||r.aprov==null?'—':r.aprov+'%'}</span></td>
          </tr>`;}).join('')}
        </tbody>
      </table>`;
    }
    // IGP: valor do próprio dia do jogo; INM: média dos 7 dias anteriores
    jogosData.forEach(g=>{
      const dmsJogo=allDM.filter(d=>d.date===g.data);
      const igpVals=dmsJogo.map(d=>d._sc.global).filter(v=>v!=null);
      g._igpPre=igpVals.length?Math.round(avg(igpVals)):null;
      const gDate=new Date(g.data+'T00:00:00');
      const d7=new Date(gDate);d7.setDate(d7.getDate()-7);
      const d7str=d7.toLocaleDateString('en-CA');
      const dmsPre=allDM.filter(d=>d.date>=d7str&&d.date<g.data);
      const inmVals=dmsPre.map(d=>d._sc.INM).filter(v=>v!=null);
      g._inmPre=inmVals.length?Math.round(avg(inmVals)):null;
    });
    function buildFaixasRows(getVal,faixaDef){
      return faixaDef.map(f=>{
        const jgs=jogosData.filter(g=>{const v=getVal(g);return f.fn(v);});
        const v=jgs.filter(g=>g.resultado==='V').length;
        const e=jgs.filter(g=>g.resultado==='E').length;
        const d=jgs.filter(g=>g.resultado==='D').length;
        const aprov=jgs.length?Math.round((v*3+e)/(jgs.length*3)*100):null;
        return{label:f.label,total:jgs.length,v,e,d,aprov};
      });
    }
    const faixaDef70=[
      {label:'> 80',fn:v=>v!=null&&v>80},
      {label:'70–80',fn:v=>v!=null&&v>=70&&v<=80},
      {label:'< 70',fn:v=>v!=null&&v<70},
    ];
    const igpFaixasRows=buildFaixasRows(g=>g._igpPre,faixaDef70);
    const inmFaixaDef=[
      {label:'> 70',fn:v=>v!=null&&v>70},
      {label:'60–70',fn:v=>v!=null&&v>=60&&v<=70},
      {label:'< 60',fn:v=>v!=null&&v<60},
    ];
    const inmFaixasRows=buildFaixasRows(g=>g._inmPre,inmFaixaDef);
    const page3c=`
    <section class="page" data-essencial="false" style="${pageStyle}width:1122px;height:793px;">
      ${headerStrip}
      <div style="padding:14px 28px 0;">
        <div style="font-family:'Archivo',sans-serif;font-size:16px;font-weight:800;color:#111827;margin-bottom:10px;">3C · Adaptação × Resultado</div>
        <div style="background:#fef9ec;border:1px solid #fcd34d;border-radius:6px;padding:5px 12px;margin-bottom:10px;font-family:'Inter',sans-serif;font-size:9px;color:#78350f;">
          ISP e INM: média dos 7 dias anteriores ao jogo. IGP: média do elenco no próprio dia do jogo. Responde: a prontidão influenciou o resultado?
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px;align-items:start;">
          <div>
            <div style="font-family:'Archivo',sans-serif;font-size:11px;font-weight:700;color:#f97316;margin-bottom:6px;border-bottom:2px solid #fed7aa;padding-bottom:3px;">ISP pré-jogo</div>
            ${buildFaixasTable(ispFaixasRows,'Faixa ISP','#fed7aa','#fff7ed')}
          </div>
          <div>
            <div style="font-family:'Archivo',sans-serif;font-size:11px;font-weight:700;color:#1a56db;margin-bottom:6px;border-bottom:2px solid #bfdbfe;padding-bottom:3px;">IGP no dia do jogo</div>
            ${buildFaixasTable(igpFaixasRows,'Faixa IGP','#bfdbfe','#eff6ff')}
          </div>
          <div>
            <div style="font-family:'Archivo',sans-serif;font-size:11px;font-weight:700;color:#7c3aed;margin-bottom:6px;border-bottom:2px solid #ddd6fe;padding-bottom:3px;">INM pré-jogo</div>
            ${buildFaixasTable(inmFaixasRows,'Faixa INM','#ddd6fe','#f5f3ff')}
          </div>
        </div>
        <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">
          ${kpiBox('ISP Médio',avgRound(allDM.map(d=>{const g=d._sc.global,q=d.post?.qualidade;return g!=null?g*fatorQ(q):null}).filter(v=>v!=null))??'—','Adaptação da fase','#f97316')}
          ${kpiBox('IGP Médio',avgRound(allDM.map(d=>d._sc.global).filter(v=>v!=null))??'—','Prontidão global','#1a56db')}
          ${inmMedioFase!=null?kpiBox('INM Médio',inmMedioFase,'Neuromuscular (0–100)','#7c3aed'):''}
          ${hasCMJ?kpiBox('CMJ Médio',cmjMedioFase!=null?cmjMedioFase+' cm':'—','salto médio da fase','#6d28d9'):''}
        </div>
        <div style="margin-top:6px;font-family:'Inter',sans-serif;font-size:9px;color:#9ca3af;">ISP e INM: média dos 7 dias anteriores ao jogo. IGP: média do elenco no dia do jogo. Aproveitamento = (V×3 + E) ÷ (Jogos×3).</div>
      </div>
    </section>`;

    // ════════ PAGE 4AB – PRODUÇÃO + LINHA DO TEMPO ═══════════════════════
    const bloco15Rows=blocos15.map((b,i)=>{
      return `<tr style="background:${i%2?'#f9fafb':'#fff'};">
        <td style="padding:6px 10px;font-family:'Archivo',sans-serif;font-size:11px;font-weight:700;color:#374151;">${blLabels[i]}</td>
        <td style="padding:6px 10px;text-align:center;font-family:'Archivo',sans-serif;font-weight:700;font-size:13px;color:#16a34a;">${b.gP}</td>
        <td style="padding:6px 10px;text-align:center;font-family:'Archivo',sans-serif;font-weight:700;font-size:13px;color:#dc2626;">${b.gC}</td>
        <td style="padding:6px 10px;text-align:center;font-family:'Archivo',sans-serif;font-size:12px;">${b.fin}</td>
        <td style="padding:6px 10px;text-align:center;font-family:'Archivo',sans-serif;font-size:12px;">${b.dgAr+b.dgCh}</td>
        <td style="padding:6px 10px;text-align:center;font-family:'Archivo',sans-serif;font-size:12px;">${b.dpAr+b.dpCh}</td>
        <td style="padding:6px 10px;text-align:center;font-family:'Archivo',sans-serif;font-size:12px;">${b.falta}</td>
      </tr>`;
    }).join('');
    // Attack-sector action bars (Finalizações + Chances Claras + Gols per 15' block)
    const ataqueBarW=120, ataqueBarH=120, ataqueBarGap=8;
    const ataqueMetrics=[
      {k:'fin', label:'Fin.', color:'#1a56db'},
      {k:'cc',  label:'CC',  color:'#059669'},
      {k:'gols',label:'Gols',color:'#dc2626'},
    ];
    const maxAtaqueVal=Math.max(...blocos15.map(b=>setorBlocoData['ataque']
      ?setorBlocoData['ataque'][blocos15.indexOf(b)].fin+setorBlocoData['ataque'][blocos15.indexOf(b)].cc+setorBlocoData['ataque'][blocos15.indexOf(b)].gols
      :b.fin+b.gP),1);
    const ataqueActionBars=(()=>{
      const atd=setorBlocoData['ataque']||blocos15.map(b=>({fin:b.fin,cc:0,gols:b.gP}));
      const maxV=Math.max(...atd.map(c=>c.fin+c.cc+c.gols),1);
      const svgW=860, svgH=130;
      const barW=Math.floor((svgW-60)/(blocos15.length*ataqueMetrics.length+blocos15.length))-1;
      const groupW=(barW+2)*ataqueMetrics.length+6;
      const groups=blocos15.map((b,gi)=>{
        const cell=atd[gi]||{fin:0,cc:0,gols:0};
        const xBase=30+gi*(groupW+8);
        const bars=ataqueMetrics.map((m,mi)=>{
          const val=cell[m.k]||0;
          const barH=maxV>0?Math.round((val/maxV)*(svgH-40)):0;
          const x=xBase+mi*(barW+2);
          const y=svgH-20-barH;
          return `<rect x="${x}" y="${y}" width="${barW}" height="${Math.max(barH,0)}" fill="${m.color}" rx="2"/>
            ${val>0?`<text x="${x+barW/2}" y="${y-3}" text-anchor="middle" font-size="8" font-family="Archivo" fill="${m.color}" font-weight="700">${val}</text>`:''}`;
        }).join('');
        const labelX=xBase+groupW/2-8;
        return `${bars}
          <text x="${labelX}" y="${svgH-4}" text-anchor="middle" font-size="9" font-family="Inter" fill="#6b7280">${blLabels[gi].replace("'",'')}</text>`;
      }).join('');
      const legend=ataqueMetrics.map((m,i)=>`
        <rect x="${10+i*70}" y="4" width="10" height="10" fill="${m.color}" rx="2"/>
        <text x="${24+i*70}" y="13" font-size="9" font-family="Inter" fill="#374151">${m.label}</text>
      `).join('');
      return `<svg width="${svgW}" height="${svgH}" xmlns="http://www.w3.org/2000/svg">
        <g>${legend}</g>
        ${groups}
      </svg>`;
    })();
    // Defensive sector action bars (Finalizações sofridas + CC Cedidas + Gols sofridos per block)
    const defMetrics=[
      {k:'finAdv', label:'Fin. sofrida', color:'#f97316'},
      {k:'ccAdv',  label:'CC cedida',    color:'#eab308'},
      {k:'gC',     label:'Gol sofrido',  color:'#dc2626'},
    ];
    const defActionBars=(()=>{
      const svgW=860, svgH=130;
      const barW=Math.floor((svgW-60)/(blocos15.length*defMetrics.length+blocos15.length))-1;
      const groupW=(barW+2)*defMetrics.length+6;
      const maxV=Math.max(...blocos15.map(b=>b.finAdv+b.ccAdv+b.gC),1);
      const groups=blocos15.map((b,gi)=>{
        const xBase=30+gi*(groupW+8);
        const bars=defMetrics.map((m,mi)=>{
          const val=b[m.k]||0;
          const barH=maxV>0?Math.round((val/maxV)*(svgH-40)):0;
          const x=xBase+mi*(barW+2);
          const y=svgH-20-barH;
          return `<rect x="${x}" y="${y}" width="${barW}" height="${Math.max(barH,0)}" fill="${m.color}" rx="2"/>
            ${val>0?`<text x="${x+barW/2}" y="${y-3}" text-anchor="middle" font-size="8" font-family="Archivo" fill="${m.color}" font-weight="700">${val}</text>`:''}`;
        }).join('');
        const labelX=xBase+groupW/2-8;
        return `${bars}<text x="${labelX}" y="${svgH-4}" text-anchor="middle" font-size="9" font-family="Inter" fill="#6b7280">${blLabels[gi].replace("'",'')}</text>`;
      }).join('');
      const legend=defMetrics.map((m,i)=>`
        <rect x="${10+i*90}" y="4" width="10" height="10" fill="${m.color}" rx="2"/>
        <text x="${24+i*90}" y="13" font-size="9" font-family="Inter" fill="#374151">${m.label}</text>
      `).join('');
      return `<svg width="${svgW}" height="${svgH}" xmlns="http://www.w3.org/2000/svg"><g>${legend}</g>${groups}</svg>`;
    })();

    // ── % tempo no setor ataque por bloco de 15' (média entre jogos) ──────
    const setorAtkPct=(()=>{
      const nB=6, bSec=900;
      const atkSum=Array(nB).fill(0), totSum=Array(nB).fill(0);
      if(!allEvents.some(e=>e.action==='Troca de setor'))return null;
      partidasFiltradas.forEach(p=>{
        const evs=(eventsMap[p.id]||[]).filter(e=>e.action==='Troca de setor').sort((a,b)=>(a.seconds??0)-(b.seconds??0));
        if(!evs.length)return;
        const ivs=[];let cSec='meio',cStart=0;
        const dur=Math.max(...evs.map(e=>e.seconds??0),5400);
        evs.forEach(ev=>{
          const t=Math.min(ev.seconds??0,dur);
          if(t>cStart)ivs.push([cStart,t,cSec]);
          cSec=ev.meta?.para??cSec;cStart=t;
        });
        if(cStart<dur)ivs.push([cStart,dur,cSec]);
        for(let b=0;b<nB;b++){
          const bs=b*bSec,be=(b+1)*bSec;
          for(const[s,e,sec]of ivs){
            const ov=Math.min(e,be)-Math.max(s,bs);
            if(ov>0){totSum[b]+=ov;if(sec==='ataque')atkSum[b]+=ov;}
          }
        }
      });
      return atkSum.map((a,b)=>totSum[b]>0?Math.round(a/totSum[b]*100):null);
    })();

    const page4ab=isFutebol?`
<section class="page" data-essencial="true" style="${pageStyle}width:1122px;height:793px;">
  ${headerStrip}
  <div style="padding:14px 28px 0;">
    <div style="font-family:'Archivo',sans-serif;font-size:16px;font-weight:800;color:#111827;margin-bottom:10px;">4 · Análise Tática — Produção e Linha do Tempo</div>
    ${allEvents.length===0?`<div style="font-family:'Inter',sans-serif;font-size:13px;color:#6b7280;background:#f9fafb;border-radius:8px;padding:24px;text-align:center;">Dados de scout não disponíveis nesta fase</div>`:`
    <div style="display:grid;grid-template-columns:280px 1fr;gap:16px;align-items:start;">
      <!-- LEFT: Stats tables -->
      <div>
        <div style="font-family:'Archivo',sans-serif;font-size:11px;font-weight:700;color:#1a56db;margin-bottom:5px;border-bottom:2px solid #1a56db;padding-bottom:2px;">⚽ Ofensivo</div>
        <table style="width:100%;border-collapse:collapse;margin-bottom:8px;">
          ${[
            ['Gols Marcados',avgGolsPro],
            ['Finalizações',avgFin],
            ['Chances Claras',avgCC],
            ['Duelos G. Chão',avgDGCh],
            ['Duelos G. Alto',avgDGAr],
          ].map(([k,v],i)=>`<tr style="background:${i%2?'#f9fafb':'#fff'};"><td style="padding:5px 8px;font-family:'Inter',sans-serif;font-size:10px;color:#374151;">${k}</td><td style="padding:5px 8px;font-family:'Archivo',sans-serif;font-size:11px;font-weight:700;text-align:right;">${v}</td></tr>`).join('')}
        </table>
        <div style="font-family:'Archivo',sans-serif;font-size:11px;font-weight:700;color:#dc2626;margin-bottom:5px;border-bottom:2px solid #dc2626;padding-bottom:2px;">🛡 Defensivo</div>
        <table style="width:100%;border-collapse:collapse;">
          ${[
            ['Gols Sofridos',avgGolsContra],
            ['Duelos P. Chão',avgDPCh],
            ['Duelos P. Alto',avgDPAr],
            ['Faltas',avgFalta],
            ['Def. Difíceis / Jogo',avgDefDif],
          ].map(([k,v],i)=>`<tr style="background:${i%2?'#f9fafb':'#fff'};"><td style="padding:5px 8px;font-family:'Inter',sans-serif;font-size:10px;color:#374151;">${k}</td><td style="padding:5px 8px;font-family:'Archivo',sans-serif;font-size:11px;font-weight:700;text-align:right;">${v}</td></tr>`).join('')}
        </table>
        <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;">
          ${kpiBox('Aproveit.',aproveitamento!=null?`${aproveitamento}%`:'—','')}
          ${kpiBox('Saldo',saldoGols>=0?`+${saldoGols}`:String(saldoGols),'',saldoGols>=0?'#059669':'#dc2626')}
        </div>
      </div>
      <!-- RIGHT: Timeline table + chart -->
      <div>
        <div style="font-family:'Archivo',sans-serif;font-size:11px;font-weight:700;color:#1a56db;margin-bottom:5px;">% Tempo no Setor de Ataque (blocos de 15')</div>
        <div style="background:#f8faff;border:1px solid #dbeafe;border-radius:6px;padding:8px;margin-bottom:10px;">
          ${setorAtkPct?svgSetorAtaqueBloco(setorAtkPct,blLabels,{w:780,h:120}):`<div style="font-family:'Inter',sans-serif;font-size:11px;color:#9ca3af;padding:16px;text-align:center;">Sem eventos de troca de setor registrados</div>`}
        </div>
        <div style="background:#f8faff;border:1px solid #dbeafe;border-radius:6px;padding:8px;margin-bottom:8px;">
          <div style="font-family:'Inter',sans-serif;font-size:9px;color:#6b7280;margin-bottom:4px;">Ações no setor de ataque por bloco — Fin. · CC · Gols</div>
          ${ataqueActionBars}
        </div>
        <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:6px;padding:8px;">
          <div style="font-family:'Inter',sans-serif;font-size:9px;color:#9a3412;margin-bottom:4px;">Setor defensivo por bloco — Fin. sofrida · CC cedida · Gol sofrido</div>
          ${defActionBars}
        </div>
      </div>
    </div>`}
  </div>
</section>`:'';

    // ════════ PAGE 4C – MAPA SETOR × TEMPO ════════════════════════════════
    const setorHeaders=['0-15\'','15-30\'','30-45\'','45-60\'','60-75\'','75-90\''];
    const setorRowDef={
      'defesa':  {label:'Defesa 🛡',  metrics:[{k:'dgCh',l:'DG Chão'},{k:'dpCh',l:'DP Chão'},{k:'dgAr',l:'DG Alto'},{k:'dpAr',l:'DP Alto'}]},
      'meio':    {label:'Meio 🔗',    metrics:[{k:'dgCh',l:'DG Chão'},{k:'dpCh',l:'DP Chão'},{k:'dgAr',l:'DG Alto'},{k:'dpAr',l:'DP Alto'}]},
      'ataque':  {label:'Ataque ⚽',  metrics:[{k:'dgCh',l:'DG Chão'},{k:'dpCh',l:'DP Chão'},{k:'dgAr',l:'DG Alto'},{k:'dpAr',l:'DP Alto'}]},
    };
    const setorTable=setores.map(s=>{
      const def=setorRowDef[s];
      const rows=def.metrics.map(m=>`<tr>
        <td style="padding:4px 8px;font-size:9px;color:#6b7280;font-family:'Inter',sans-serif;white-space:nowrap;">${m.l}</td>
        ${setorBlocoData[s].map((cell,bi)=>`<td style="padding:4px 8px;text-align:center;font-size:10px;font-family:'Archivo',sans-serif;font-weight:600;">${cell[m.k]||0}</td>`).join('')}
      </tr>`).join('');
      return `<tr style="background:#f1f5ff;"><td colspan="7" style="padding:5px 8px;font-family:'Archivo',sans-serif;font-size:11px;font-weight:700;color:#1a56db;">${def.label}</td></tr>${rows}`;
    }).join('');
const totalDGGeral=setores.reduce((s,k)=>s+(setorDuelTotals[k]?.dg||0),0);
    const totalDPGeral=setores.reduce((s,k)=>s+(setorDuelTotals[k]?.dp||0),0);
    const balanceDuelos=totalDGGeral-totalDPGeral;
        const page4c=isFutebol?`
    <section class="page" data-essencial="false" style="${pageStyle}width:1122px;height:793px;">
      ${headerStrip}
      <div style="padding:18px 28px 0;">
        <div style="font-family:'Archivo',sans-serif;font-size:16px;font-weight:800;color:#111827;margin-bottom:14px;">4C · Duelos por Setor — Mapa de Campo</div>
        ${allEvents.length===0?`<div style="font-family:'Inter',sans-serif;font-size:13px;color:#6b7280;background:#f9fafb;border-radius:8px;padding:24px;text-align:center;">Dados de scout não disponíveis nesta fase</div>`:`
        <div style="display:flex;gap:10px;margin-bottom:10px;flex-wrap:wrap;">
          ${kpiBox('Duelos Ganhos',totalDGGeral,'total acumulado','#1d4ed8')}
          ${kpiBox('Duelos Perdidos',totalDPGeral,'total acumulado','#dc2626')}
          ${kpiBox('Saldo',balanceDuelos>=0?`+${balanceDuelos}`:String(balanceDuelos),'DG − DP',balanceDuelos>=0?'#16a34a':'#dc2626')}
        </div>
        <div style="display:flex;justify-content:center;margin-top:4px;">
          ${svgCampoDuelos(setorDuelTotals)}
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:2px;">
          <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:8px 12px;">
            <div style="font-family:'Inter',sans-serif;font-size:9px;color:#166534;margin-bottom:4px;font-weight:600;">Duelos Ganhos por bloco de 15'</div>
            ${svgBarChart(blocos15.map(b=>b.dgCh+b.dgAr),blLabels,blocos15.map(()=>'#16a34a'),{w:460,h:100})}
          </div>
          <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:8px 12px;">
            <div style="font-family:'Inter',sans-serif;font-size:9px;color:#991b1b;margin-bottom:4px;font-weight:600;">Duelos Perdidos por bloco de 15'</div>
            ${svgBarChart(blocos15.map(b=>b.dpCh+b.dpAr),blLabels,blocos15.map(()=>'#dc2626'),{w:460,h:100,maxVal:35})}
          </div>
        </div>
        <div style="margin-top:6px;font-family:'Inter',sans-serif;font-size:9px;color:#9ca3af;">DG = Duelos Ganhos · DP = Duelos Perdidos · Chão = disputas terrestres · Alto = disputas aéreas · Total acumulado de todos os jogos do período</div>
        `}
      </div>
    </section>`:'';

    // ════════ PAGE 4D – ERROS × BOAS DECISÕES ════════════════════════════
    const totalBoaDecisao=blocos15.reduce((s,b)=>s+b.boaDecisao,0);
    const totalErroNF=blocos15.reduce((s,b)=>s+b.erroNF,0);
    const totalErroPressao=blocos15.reduce((s,b)=>s+b.erroPressao,0);
    const totalErros=totalErroNF+totalErroPressao;
    // Grouped bar SVG: Boas Decisões (verde) + Erro NF (laranja) + Erro Pressão (vermelho) por bloco
    const decErroBars=(()=>{
      const svgW=900, svgH=125;
      const pad={l:36,r:12,t:16,b:26};
      const cW=svgW-pad.l-pad.r, cH=svgH-pad.t-pad.b;
      const nGroups=6, nBars=3;
      const gapG=8, barW=Math.floor((cW/nGroups-gapG)/nBars)-2;
      const groupW=nBars*(barW+2)+gapG;
      const allVals=blocos15.flatMap(b=>[b.boaDecisao,b.erroNF,b.erroPressao]);
      const maxV=Math.max(...allVals,1);
      const defs=[{k:'boaDecisao',color:'#16a34a',label:'Boa decisão'},{k:'erroNF',color:'#f97316',label:'Erro NF'},{k:'erroPressao',color:'#dc2626',label:'Erro Pressão'}];
      let yAxis='';
      for(let i=0;i<=4;i++){
        const v=Math.round(maxV*i/4);
        const y=pad.t+cH-cH*i/4;
        yAxis+=`<line x1="${pad.l}" x2="${svgW-pad.r}" y1="${y}" y2="${y}" stroke="#e5e7eb" stroke-width="1"/>`;
        yAxis+=`<text x="${pad.l-3}" y="${y+4}" text-anchor="end" fill="#6b7280" font-size="8">${v}</text>`;
      }
      let bars='', xLab='';
      blocos15.forEach((b,gi)=>{
        const xBase=pad.l+gi*(cW/nGroups);
        defs.forEach((d,di)=>{
          const val=b[d.k]||0;
          const h=maxV>0?Math.round((val/maxV)*cH):0;
          const x=xBase+(gapG/2)+di*(barW+2);
          const y=pad.t+cH-h;
          bars+=`<rect x="${x}" y="${y}" width="${barW}" height="${Math.max(h,0)}" fill="${d.color}" rx="2"/>`;
          if(val>0) bars+=`<text x="${x+barW/2}" y="${y-2}" text-anchor="middle" font-size="7" font-family="Archivo" fill="${d.color}" font-weight="700">${val}</text>`;
        });
        xLab+=`<text x="${xBase+cW/nGroups/2}" y="${svgH-4}" text-anchor="middle" font-size="9" font-family="Inter" fill="#6b7280">${blLabels[gi].replace("'",'')}</text>`;
      });
      const legend=defs.map((d,i)=>`<rect x="${pad.l+i*110}" y="4" width="10" height="8" fill="${d.color}" rx="2"/><text x="${pad.l+i*110+14}" y="12" font-size="9" font-family="Inter" fill="#374151">${d.label}</text>`).join('');
      return `<svg width="${svgW}" height="${svgH}" xmlns="http://www.w3.org/2000/svg">${yAxis}<g>${legend}</g>${bars}${xLab}</svg>`;
    })();
    // Ratio line: boas decisões / (boas decisões + erros totais) per block
    const ratioLine=(()=>{
      const vals=blocos15.map(b=>{
        const tot=b.boaDecisao+b.erroNF+b.erroPressao;
        return tot>0?Math.round(b.boaDecisao/tot*100):null;
      });
      return svgLineChart(vals,blLabels,{w:900,h:80,color:'#1a56db',yMin:0,yMax:100,refValue:50,refLabel:'Equilíbrio (50%)'});
    })();
    const page4d=isFutebol?`
    <section class="page" data-essencial="false" style="${pageStyle}width:1122px;height:793px;">
      ${headerStrip}
      <div style="padding:10px 28px 0;">
        <div style="font-family:'Archivo',sans-serif;font-size:16px;font-weight:800;color:#111827;margin-bottom:6px;">4D · Erros × Boas Decisões — Linha do Tempo</div>
        ${allEvents.length===0?`<div style="font-family:'Inter',sans-serif;font-size:13px;color:#6b7280;background:#f9fafb;border-radius:8px;padding:24px;text-align:center;">Dados de scout não disponíveis nesta fase</div>`:`
        <div style="display:flex;gap:10px;margin-bottom:6px;flex-wrap:wrap;">
          ${kpiBox('Boas Decisões',totalBoaDecisao,'total no período','#16a34a')}
          ${kpiBox('Erros NF',totalErroNF,'sem pressão','#f97316')}
          ${kpiBox('Erros sob Pressão',totalErroPressao,'sob pressão','#dc2626')}
          ${kpiBox('Taxa de Acerto',totalErros+totalBoaDecisao>0?Math.round(totalBoaDecisao/(totalBoaDecisao+totalErros)*100)+'%':'—','boas / (boas + erros)','#1a56db')}
        </div>
        <div style="background:#f8faff;border:1px solid #dbeafe;border-radius:10px;padding:6px 12px;margin-bottom:6px;">
          <div style="font-family:'Inter',sans-serif;font-size:9px;color:#6b7280;margin-bottom:4px;">Distribuição por bloco de 15' — Boa decisão · Erro NF · Erro sob Pressão</div>
          ${decErroBars}
        </div>
        <div style="display:flex;justify-content:center;margin-bottom:6px;">
          ${svgCampoDecisoes(setorDecisaoTotals)}
        </div>
        <div style="background:#f8faff;border:1px solid #dbeafe;border-radius:8px;padding:8px 12px;">
          <div style="font-family:'Inter',sans-serif;font-size:9px;color:#6b7280;margin-bottom:3px;font-weight:600;">Taxa de Acerto por bloco (%) — Boas Decisões ÷ (Boas + Erros)</div>
          ${ratioLine}
        </div>
        `}
      </div>
    </section>`:'';

    // ════════ PAGE 4E – VITÓRIA × EMPATE × DERROTA ═══════════════════════
    // Helper: color for best value in a row (used for highlighting)
    function vedRowHtml(label, vals, higherIsBetter=true, isGoals=false){
      const nums=vals.map(v=>v!=null?+v:null);
      const valid=nums.filter(v=>v!=null);
      if(!valid.length) return `<tr><td style="padding:7px 10px;font-family:'Inter',sans-serif;font-size:11px;color:#374151;">${label}</td>${vals.map(()=>`<td style="padding:7px 10px;text-align:center;font-family:'Archivo',sans-serif;font-size:11px;color:#9ca3af;">—</td>`).join('')}</tr>`;
      const best=higherIsBetter?Math.max(...valid):Math.min(...valid);
      const worst=higherIsBetter?Math.min(...valid):Math.max(...valid);
      return `<tr>
        <td style="padding:7px 10px;font-family:'Inter',sans-serif;font-size:11px;color:#374151;border-bottom:1px solid #f3f4f6;">${label}</td>
        ${nums.map((v,i)=>{
          const isBest=v!=null&&v===best;
          const isWorst=v!=null&&v===worst&&best!==worst;
          const color=isBest?['#16a34a','#6b7280','#dc2626'][i]:isWorst?'#9ca3af':'#374151';
          const bg=isBest?['#f0fdf4','#f9fafb','#fef2f2'][i]:i%2===0?'#fff':'#f9fafb';
          const fw=isBest?'800':'600';
          return `<td style="padding:7px 10px;text-align:center;background:${bg};border-bottom:1px solid #f3f4f6;"><span style="font-family:'Archivo',sans-serif;font-size:13px;font-weight:${fw};color:${color};">${v!=null?v:'—'}</span></td>`;
        }).join('')}
      </tr>`;
    }
    const nV=jogosVit.length, nE=jogosEmp.length, nD=jogosD.length;
    const apVit=nV>0?Math.round((nV*3)/(nV*3)*100):null;
    const apEmp=nE>0?Math.round(nE/(nE*3)*100):null;
    const apDer=0;
    const page4e=isFutebol&&showVED?`
    <section class="page" data-essencial="true" style="${pageStyle}width:1122px;height:793px;">
      ${headerStrip}
      <div style="padding:14px 28px 0;">
        <div style="font-family:'Archivo',sans-serif;font-size:16px;font-weight:800;color:#111827;margin-bottom:12px;">4E · Padrão de Jogo por Resultado</div>
        <div style="display:grid;grid-template-columns:1fr 340px;gap:20px;align-items:start;">
          <div>
            <div style="font-family:'Archivo',sans-serif;font-size:11px;font-weight:700;color:#374151;margin-bottom:6px;">O que muda quando ganhamos, empatamos ou perdemos? Médias por jogo.</div>
            <table style="width:100%;border-collapse:collapse;">
              <thead>
                <tr style="background:#f8f9fa;">
                  <th style="padding:8px 10px;font-size:10px;font-family:'Inter',sans-serif;color:#6b7280;font-weight:700;text-align:left;border-bottom:2px solid #e5e7eb;">Indicador</th>
                  <th style="padding:8px 10px;font-size:11px;font-family:'Archivo',sans-serif;color:#16a34a;font-weight:800;text-align:center;border-bottom:2px solid #e5e7eb;">Vitórias (${nV}J)</th>
                  <th style="padding:8px 10px;font-size:11px;font-family:'Archivo',sans-serif;color:#6b7280;font-weight:800;text-align:center;border-bottom:2px solid #e5e7eb;">Empates (${nE}J)</th>
                  <th style="padding:8px 10px;font-size:11px;font-family:'Archivo',sans-serif;color:#dc2626;font-weight:800;text-align:center;border-bottom:2px solid #e5e7eb;">Derrotas (${nD}J)</th>
                </tr>
              </thead>
              <tbody>
                ${vedRowHtml('Gols marcados',vedGolsPro,true)}
                ${vedRowHtml('Gols sofridos',vedGolsCon,false)}
                ${vedRowHtml('Finalizações',vedFin,true)}
                ${vedRowHtml('Chances claras criadas',vedCC,true)}
                ${vedRowHtml('Duelos ganhos (chão)',vedDGCh,true)}
                ${vedRowHtml('Duelos ganhos (alto)',vedDGAr,true)}
                ${vedRowHtml('Duelos perdidos (chão)',vedDPCh,false)}
                ${vedRowHtml('Duelos perdidos (alto)',vedDPAr,false)}
                ${vedRowHtml('Faltas cometidas',vedFalta,false)}
                ${vedRowHtml('Erros totais (NF + pressão)',vedErros,false)}
              </tbody>
            </table>
            <div style="margin-top:6px;font-family:'Inter',sans-serif;font-size:9px;color:#9ca3af;">Verde = melhor valor da linha · Cinza = pior valor · Todas as médias são por jogo</div>
          </div>
          <div>
            <div style="font-family:'Archivo',sans-serif;font-size:11px;font-weight:700;color:#374151;margin-bottom:8px;border-bottom:2px solid #e5e7eb;padding-bottom:4px;">Aproveitamento por resultado</div>
            <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:16px;">
              <div style="background:#f0fdf4;border:1.5px solid #bbf7d0;border-radius:10px;padding:12px 16px;display:flex;align-items:center;justify-content:space-between;">
                <div>
                  <div style="font-family:'Archivo',sans-serif;font-size:11px;font-weight:700;color:#16a34a;">Vitórias</div>
                  <div style="font-family:'Inter',sans-serif;font-size:10px;color:#4b7c59;">${nV} jogo${nV!==1?'s':''}</div>
                </div>
                <div style="font-family:'Archivo',sans-serif;font-size:28px;font-weight:800;color:#16a34a;">${nV}</div>
              </div>
              <div style="background:#f9fafb;border:1.5px solid #e5e7eb;border-radius:10px;padding:12px 16px;display:flex;align-items:center;justify-content:space-between;">
                <div>
                  <div style="font-family:'Archivo',sans-serif;font-size:11px;font-weight:700;color:#6b7280;">Empates</div>
                  <div style="font-family:'Inter',sans-serif;font-size:10px;color:#9ca3af;">${nE} jogo${nE!==1?'s':''}</div>
                </div>
                <div style="font-family:'Archivo',sans-serif;font-size:28px;font-weight:800;color:#6b7280;">${nE}</div>
              </div>
              <div style="background:#fef2f2;border:1.5px solid #fecaca;border-radius:10px;padding:12px 16px;display:flex;align-items:center;justify-content:space-between;">
                <div>
                  <div style="font-family:'Archivo',sans-serif;font-size:11px;font-weight:700;color:#dc2626;">Derrotas</div>
                  <div style="font-family:'Inter',sans-serif;font-size:10px;color:#b45959;">${nD} jogo${nD!==1?'s':''}</div>
                </div>
                <div style="font-family:'Archivo',sans-serif;font-size:28px;font-weight:800;color:#dc2626;">${nD}</div>
              </div>
            </div>
            <div style="background:#f8faff;border:1px solid #dbeafe;border-radius:8px;padding:10px 14px;">
              <div style="font-family:'Archivo',sans-serif;font-size:10px;font-weight:700;color:#1a56db;margin-bottom:6px;">Aproveitamento geral</div>
              <div style="font-family:'Archivo',sans-serif;font-size:32px;font-weight:800;color:#1a56db;">${aproveitamento!=null?aproveitamento+'%':'—'}</div>
              <div style="font-family:'Inter',sans-serif;font-size:9px;color:#9ca3af;margin-top:2px;">${totalJogos} jogos · (V×3 + E) ÷ (total×3)</div>
            </div>
          </div>
        </div>
      </div>
    </section>`:'';

    // ════════ PAGE 4F – ROUBADAS DE BOLA ═════════════════════════════════
    const totalRoubadaPO=blocos15.reduce((s,b)=>s+b.roubadaPO,0);
    const totalRoubadaPP=blocos15.reduce((s,b)=>s+b.roubadaPP,0);
    const totalRoubadaCB=blocos15.reduce((s,b)=>s+b.roubadaCB,0);
    const totalRoubadas=totalRoubadaPO+totalRoubadaPP+totalRoubadaCB;
    const roubadaBarsHtml=(()=>{
      const svgW=900, svgH=125;
      const pad={l:36,r:12,t:16,b:26};
      const cW=svgW-pad.l-pad.r, cH=svgH-pad.t-pad.b;
      const nGroups=6, nBars=3;
      const gapG=8, barW=Math.floor((cW/nGroups-gapG)/nBars)-2;
      const allVals=blocos15.flatMap(b=>[b.roubadaPO,b.roubadaPP,b.roubadaCB]);
      const maxV=Math.max(...allVals,1);
      const defs=[
        {k:'roubadaPO',color:'#fb923c',label:'Pressão Ofensiva'},
        {k:'roubadaPP',color:'#60a5fa',label:'Pós-Perda'},
        {k:'roubadaCB',color:'#a78bfa',label:'Combate'},
      ];
      let yAxis='';
      for(let i=0;i<=4;i++){
        const v=Math.round(maxV*i/4);
        const y=pad.t+cH-cH*i/4;
        yAxis+=`<line x1="${pad.l}" x2="${svgW-pad.r}" y1="${y}" y2="${y}" stroke="#e5e7eb" stroke-width="1"/>`;
        yAxis+=`<text x="${pad.l-3}" y="${y+4}" text-anchor="end" fill="#6b7280" font-size="8">${v}</text>`;
      }
      let bars='', xLab='';
      blocos15.forEach((b,gi)=>{
        const xBase=pad.l+gi*(cW/nGroups);
        defs.forEach((d,di)=>{
          const val=b[d.k]||0;
          const h=maxV>0?Math.round((val/maxV)*cH):0;
          const x=xBase+(gapG/2)+di*(barW+2);
          const y=pad.t+cH-h;
          bars+=`<rect x="${x}" y="${y}" width="${barW}" height="${Math.max(h,0)}" fill="${d.color}" rx="2"/>`;
          if(val>0) bars+=`<text x="${x+barW/2}" y="${y-2}" text-anchor="middle" font-size="7" font-family="Archivo" fill="${d.color}" font-weight="700">${val}</text>`;
        });
        xLab+=`<text x="${xBase+cW/nGroups/2}" y="${svgH-4}" text-anchor="middle" font-size="9" font-family="Inter" fill="#6b7280">${blLabels[gi].replace("'",'')}</text>`;
      });
      const legend=defs.map((d,i)=>`<rect x="${pad.l+i*150}" y="4" width="10" height="8" fill="${d.color}" rx="2"/><text x="${pad.l+i*150+14}" y="12" font-size="9" font-family="Inter" fill="#374151">${d.label}</text>`).join('');
      return `<svg width="${svgW}" height="${svgH}" xmlns="http://www.w3.org/2000/svg">${yAxis}<g>${legend}</g>${bars}${xLab}</svg>`;
    })();
    const roubadaLineHtml=svgLineChart(blocos15.map(b=>b.roubadaPO+b.roubadaPP+b.roubadaCB),blLabels,{w:900,h:80,color:'#374151',yMin:0,refValue:totalRoubadas>0?+(totalRoubadas/6).toFixed(1):null,refLabel:'Média/bloco'});
    const page4f=isFutebol?`
    <section class="page" data-essencial="false" style="${pageStyle}width:1122px;height:793px;">
      ${headerStrip}
      <div style="padding:10px 28px 0;">
        <div style="font-family:'Archivo',sans-serif;font-size:16px;font-weight:800;color:#111827;margin-bottom:6px;">4F · Roubadas de Bola — Mapa de Campo e Linha do Tempo</div>
        ${allEvents.length===0?`<div style="font-family:'Inter',sans-serif;font-size:13px;color:#6b7280;background:#f9fafb;border-radius:8px;padding:24px;text-align:center;">Dados de scout não disponíveis nesta fase</div>`:`
        <div style="display:flex;gap:10px;margin-bottom:6px;flex-wrap:wrap;">
          ${kpiBox('Total Roubadas',totalRoubadas,'acumulado no período','#374151')}
          ${kpiBox('Pressão Ofensiva',totalRoubadaPO,'roubadas','#ea580c')}
          ${kpiBox('Pós-Perda',totalRoubadaPP,'roubadas','#2563eb')}
          ${kpiBox('Combate',totalRoubadaCB,'roubadas','#7c3aed')}
        </div>
        <div style="display:flex;justify-content:center;margin-bottom:6px;">
          ${svgCampoRoubadas(setorRoubadaTotals)}
        </div>
        <div style="background:#f8faff;border:1px solid #dbeafe;border-radius:10px;padding:6px 12px;margin-bottom:4px;">
          <div style="font-family:'Inter',sans-serif;font-size:9px;color:#6b7280;margin-bottom:4px;">Distribuição por bloco de 15' — Pressão Ofensiva · Pós-Perda · Combate</div>
          ${roubadaBarsHtml}
        </div>
        <div style="background:#f8faff;border:1px solid #dbeafe;border-radius:8px;padding:8px 12px;">
          <div style="font-family:'Inter',sans-serif;font-size:9px;color:#6b7280;margin-bottom:3px;font-weight:600;">Total de Roubadas por bloco de 15' (todas as categorias)</div>
          ${roubadaLineHtml}
        </div>
        `}
      </div>
    </section>`:'';

    // ════════ PAGE 4G – ENTRADAS NO SETOR DE ATAQUE ══════════════════════
    const page4g=(isFutebol&&allEvents.length>0)?`
    <section class="page" data-essencial="false" style="${pageStyle}width:1122px;height:793px;">
      ${headerStrip}
      <div style="padding:10px 28px 0;">
        <div style="font-family:'Archivo',sans-serif;font-size:16px;font-weight:800;color:#111827;margin-bottom:6px;">4G · Entradas no Setor de Ataque</div>
        ${eaTotalEntradas===0?`<div style="font-family:'Inter',sans-serif;font-size:13px;color:#6b7280;background:#f9fafb;border-radius:8px;padding:24px;text-align:center;">Dados de scout não disponíveis nesta fase</div>`:`
        <div style="display:flex;gap:10px;margin-bottom:8px;flex-wrap:wrap;">
          ${kpiBox('Total Entradas',eaTotalEntradas,`${eaMediaEntradas??'—'}/jogo`)}
          ${kpiBox('Finalizações',eaTotalFin,'total no período','#16a34a')}
          ${kpiBox('Chances Claras',eaTotalCC,'total no período','#0ea5e9')}
          ${kpiBox('Escanteios',eaTotalBPEsc,'total no período','#7c3aed')}
          ${kpiBox('Faltas',eaTotalBPFal,'total no período','#d97706')}
          ${kpiBox('Sem Finalização',eaTotalSem,'encerrou sem ação','#dc2626')}
        </div>
        <div style="background:#f8faff;border:1px solid #dbeafe;border-radius:8px;padding:8px 12px;margin-bottom:8px;overflow:auto;">
          <table style="width:100%;border-collapse:collapse;font-family:'Inter',sans-serif;font-size:10px;">
            <thead><tr style="background:#eff6ff;">
              <th style="padding:4px 8px;text-align:left;color:#374151;font-weight:700;">Jogo</th>
              <th style="padding:4px 8px;text-align:left;color:#374151;font-weight:700;">Data</th>
              <th style="padding:4px 8px;text-align:center;color:#374151;font-weight:700;">Placar</th>
              <th style="padding:4px 8px;text-align:center;color:#374151;font-weight:700;">Entradas</th>
              <th style="padding:4px 8px;text-align:center;color:#374151;font-weight:700;">Finalizou</th>
              <th style="padding:4px 8px;text-align:center;color:#0ea5e9;font-weight:700;">Ch. Clara</th>
              <th style="padding:4px 8px;text-align:center;color:#7c3aed;font-weight:700;">Escanteio</th>
              <th style="padding:4px 8px;text-align:center;color:#d97706;font-weight:700;">Falta</th>
              <th style="padding:4px 8px;text-align:center;color:#374151;font-weight:700;">Sem Fin.</th>
              <th style="padding:4px 8px;text-align:center;color:#374151;font-weight:700;">Conv.%</th>
            </tr></thead>
            <tbody>${jogosData.map((p,idx)=>{
              const g=_eaPorJogo[p.id]||{finalizacoes:0,chancesC:0,bp_escanteio:0,bp_falta:0,sem_finalizacao:0,total:0};
              const fin=g.finalizacoes||0,cc=g.chancesC||0,esc=g.bp_escanteio||0,fal=g.bp_falta||0,sem=g.sem_finalizacao||0,tot=g.total||0;
              const conv=tot>0?Math.round((g.finalizou||0)/tot*100)+'%':'—';
              const fmtD=(str)=>{if(!str)return'—';const[y,m,d]=str.split('-');return d+'/'+m+'/'+y;};
              const isSemHigh=sem>0&&sem>=fin&&sem>=(esc+fal);
              return `<tr style="border-bottom:1px solid #e5e7eb;">
                <td style="padding:4px 8px;color:#374151;font-weight:600;">J${idx+1}</td>
                <td style="padding:4px 8px;color:#374151;">${fmtD(p.data)}</td>
                <td style="padding:4px 8px;text-align:center;color:#374151;">${p.pro}-${p.con}</td>
                <td style="padding:4px 8px;text-align:center;color:#374151;font-weight:700;">${tot}</td>
                <td style="padding:4px 8px;text-align:center;background:${fin>0?'#f0fdf4':'transparent'};color:${fin>0?'#16a34a':'#374151'};font-weight:${fin>0?'700':'400'};">${fin}</td>
                <td style="padding:4px 8px;text-align:center;background:${cc>0?'#f0f9ff':'transparent'};color:${cc>0?'#0ea5e9':'#374151'};font-weight:${cc>0?'700':'400'};">${cc}</td>
                <td style="padding:4px 8px;text-align:center;background:${esc>0?'#f5f3ff':'transparent'};color:${esc>0?'#7c3aed':'#374151'};">${esc}</td>
                <td style="padding:4px 8px;text-align:center;background:${fal>0?'#fffbeb':'transparent'};color:${fal>0?'#d97706':'#374151'};">${fal}</td>
                <td style="padding:4px 8px;text-align:center;background:${isSemHigh?'#fef2f2':'transparent'};color:${isSemHigh?'#dc2626':'#374151'};font-weight:${isSemHigh?'700':'400'};">${sem}</td>
                <td style="padding:4px 8px;text-align:center;color:#374151;">${conv}</td>
              </tr>`;
            }).join('')}</tbody>
          </table>
        </div>
        <div style="background:#f8faff;border:1px solid #dbeafe;border-radius:8px;padding:8px 12px;">
          ${(()=>{
            // Blocos 15': finalizações, escanteios e faltas GLOBAIS + entradas sem finalização
            const bl=Array.from({length:6},()=>({fin:0,cc:0,esc:0,fal:0,sem:0}));
            entradaAtaque.forEach(e=>{
              const b=Math.min(Math.floor(e.minuto/15),5);
              if(e.outcome==='sem_finalizacao')bl[b].sem++;
            });
            allEvents.forEach(ev=>{
              if((ev.sector||ev.setor||'').toLowerCase()!=='ataque')return;
              const b=Math.min(getBloco15(ev),5);
              if(ev.action==='Finalização')bl[b].fin++;
              if(ev.action==='Chance clara criada')bl[b].cc++;
              if(ev.action!=='Bola Parada'||ev.meta?.equipe!=='america')return;
              if(ev.meta?.tipo==='escanteio')bl[b].esc++;
              else if(ev.meta?.tipo==='falta')bl[b].fal++;
            });
            const svgW=900,svgH=140,pad={l:36,r:12,t:16,b:28};
            const cW=svgW-pad.l-pad.r,cH=svgH-pad.t-pad.b;
            const nGroups=6,nBars=5,gapG=20;
            const barW=Math.floor((cW/nGroups-gapG)/nBars)-2;
            const allVals=bl.flatMap(b=>[b.fin,b.cc,b.esc,b.fal,b.sem]);
            const maxV=Math.max(...allVals,1);
            const defs=[
              {k:'fin',color:'#16a34a',label:'Finalizações'},
              {k:'cc', color:'#0ea5e9',label:'Ch. Claras'},
              {k:'esc',color:'#7c3aed',label:'Escanteio'},
              {k:'fal',color:'#d97706',label:'Falta'},
              {k:'sem',color:'#dc2626',label:'Sem Finalização'},
            ];
            let yAxis='';
            for(let i=0;i<=4;i++){
              const v=Math.round(maxV*i/4);
              const y=pad.t+cH-cH*i/4;
              yAxis+=`<line x1="${pad.l}" x2="${svgW-pad.r}" y1="${y}" y2="${y}" stroke="#e5e7eb" stroke-width="1"/>`;
              yAxis+=`<text x="${pad.l-3}" y="${y+4}" text-anchor="end" fill="#6b7280" font-size="8">${v}</text>`;
            }
            let bars='',xLab='',dividers='';
            bl.forEach((b,gi)=>{
              const xBase=pad.l+gi*(cW/nGroups);
              // Linha divisória entre grupos (exceto antes do primeiro)
              if(gi>0)dividers+=`<line x1="${xBase+gapG/4}" x2="${xBase+gapG/4}" y1="${pad.t}" y2="${pad.t+cH}" stroke="#d1d5db" stroke-width="1" stroke-dasharray="3,2"/>`;
              defs.forEach((d,di)=>{
                const val=b[d.k]||0;
                const h=maxV>0?Math.round((val/maxV)*cH):0;
                const x=xBase+(gapG/2)+di*(barW+3);
                const y=pad.t+cH-h;
                bars+=`<rect x="${x}" y="${y}" width="${barW}" height="${Math.max(h,0)}" fill="${d.color}" rx="2"/>`;
                if(val>0)bars+=`<text x="${x+barW/2}" y="${y-2}" text-anchor="middle" font-size="7" font-family="Archivo" fill="${d.color}" font-weight="700">${val}</text>`;
              });
              xLab+=`<text x="${xBase+cW/nGroups/2}" y="${svgH-4}" text-anchor="middle" font-size="9" font-family="Inter" fill="#6b7280">${blLabels[gi].replace("'",'')}</text>`;
            });
            const legend=defs.map((d,i)=>`<rect x="${pad.l+i*140}" y="4" width="10" height="8" fill="${d.color}" rx="2"/><text x="${pad.l+i*140+14}" y="12" font-size="9" font-family="Inter" fill="#374151">${d.label}</text>`).join('');
            return `<div style="font-family:'Inter',sans-serif;font-size:9px;color:#6b7280;margin-bottom:4px;font-weight:600;">Distribuição por bloco de 15' — Entradas, Escanteios, Faltas e Sem Finalização</div><svg width="${svgW}" height="${svgH}" xmlns="http://www.w3.org/2000/svg">${yAxis}${dividers}<g>${legend}</g>${bars}${xLab}</svg>`;
          })()}
        </div>
        `}
      </div>
    </section>`:'';

    // ════════ PAGE 5 – TIME DA PRIMEIRA FASE ═════════════════════════════
    function starCard(icon,title,lines){
      return `<div style="background:#f8faff;border:1px solid #dbeafe;border-radius:10px;padding:14px 16px;">
        <div style="font-family:'Archivo',sans-serif;font-size:11px;font-weight:700;color:#1a56db;margin-bottom:8px;">${icon} ${title}</div>
        ${lines.map(l=>l?`<div style="font-family:'Inter',sans-serif;font-size:10px;color:#374151;padding:3px 0;border-bottom:1px solid #e5e7eb;">${esc(l)}</div>`:`<div style="font-family:'Inter',sans-serif;font-size:10px;color:#9ca3af;font-style:italic;">Dados insuficientes</div>`).join('')}
      </div>`;
    }
    const page5=`
    <section class="page" data-essencial="false" style="${pageStyle}width:1122px;height:793px;">
      ${headerStrip}
      <div style="padding:18px 28px 0;">
        <div style="font-family:'Archivo',sans-serif;font-size:16px;font-weight:800;color:#111827;margin-bottom:14px;">5 · Time da Primeira Fase</div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:14px;">
          ${starCard('⚽','Top 10 Artilheiros',top10Atleta(atlGols,'maior',v=>`${v} gols`))}
          ${starCard('🎯','Top 10 Finalizadores',top10Atleta(atlFin,'maior',v=>`${v} fin.`))}
          ${starCard('🛡','Top 10 Duelos Ganhos',top10Atleta(atlDG,'maior',v=>`${v} DG`))}
          ${starCard('⏱','Top 10 Minutos Jogados',top10Atleta(atlMins,'maior',v=>`${v}min`))}
          ${starCard('🫳','Top 10 Roubadas de Bola',top10Atleta(atlRoubada,'maior',v=>`${v} rob.`))}
          ${starCard('🔗','Top 10 Participação em Gols',top10Atleta(atlPartGols,'maior',v=>`${v} G+A`))}
        </div>
        <div style="margin-top:12px;font-family:'Inter',sans-serif;font-size:10px;color:#9ca3af;">Baseado em dados do período selecionado. Atletas sem dados suficientes não são listados.</div>
      </div>
    </section>`;

    // ════════ PAGE 5B – MINUTOS JOGADOS ══════════════════════════════════
    const allAtlIds=new Set([
      ...Object.keys(atlMins),
      ...Object.keys(atlJogos),
      ...Object.keys(atlGols),
      ...Object.keys(atlFin),
      ...Object.keys(atlDG),
      ...Object.keys(atlDP),
    ]);
    const minsRows=[...allAtlIds]
      .filter(aid=>atletasMap[aid])
      .map(aid=>({
        aid,
        nome:atletasMap[aid]?.nome||aid,
        posicao:atletasMap[aid]?.posicao||'—',
        jogos:atlJogos[aid]||0,
        mins:atlMins[aid]||0,
        gols:atlGols[aid]||0,
        assist:atlAssist[aid]||0,
        defDif:atlDefDif[aid]||0,
        fin:atlFin[aid]||0,
        dg:atlDG[aid]||0,
        dp:atlDP[aid]||0,
        igp:atlIGP[aid]??null,
        avail:atlAvail[aid]??null,
      }))
      .sort((a,b)=>b.mins-a.mins);

    const minsTableRows=minsRows.map((r,i)=>`
      <tr style="background:${i%2?'#f9fafb':'#fff'};">
        <td style="padding:5px 8px;font-size:10px;font-family:'Inter',sans-serif;color:#111827;font-weight:600;white-space:nowrap;">${esc(r.nome)}</td>
        <td style="padding:5px 8px;font-size:9px;font-family:'Inter',sans-serif;color:#6b7280;white-space:nowrap;">${esc(r.posicao)}</td>
        <td style="padding:5px 8px;font-size:11px;font-family:'Archivo',sans-serif;font-weight:700;text-align:center;">${r.jogos||'—'}</td>
        <td style="padding:5px 8px;font-size:11px;font-family:'Archivo',sans-serif;font-weight:700;text-align:center;color:#1a56db;">${r.mins||'—'}</td>
        <td style="padding:5px 8px;font-size:11px;font-family:'Archivo',sans-serif;font-weight:700;text-align:center;color:${r.gols>0?'#16a34a':'#374151'};">${r.gols||0}</td>
        <td style="padding:5px 8px;font-size:11px;font-family:'Archivo',sans-serif;font-weight:700;text-align:center;color:${r.assist>0?'#16a34a':'#374151'};">${r.assist||0}</td>
        <td style="padding:5px 8px;font-size:11px;font-family:'Archivo',sans-serif;font-weight:700;text-align:center;color:${r.defDif>0?'#1a56db':'#374151'};">${r.defDif||0}</td>
        <td style="padding:5px 8px;font-size:11px;font-family:'Archivo',sans-serif;font-weight:700;text-align:center;">${r.fin}</td>
        <td style="padding:5px 8px;font-size:11px;font-family:'Archivo',sans-serif;font-weight:700;text-align:center;color:#16a34a;">${r.dg}</td>
        <td style="padding:5px 8px;font-size:11px;font-family:'Archivo',sans-serif;font-weight:700;text-align:center;color:#dc2626;">${r.dp}</td>
        <td style="padding:5px 8px;font-size:11px;font-family:'Archivo',sans-serif;font-weight:700;text-align:center;">${r.igp??'—'}</td>
      </tr>`).join('');

    const page5b=`
    <section class="page" data-essencial="false" style="${pageStyle}width:1122px;height:793px;">
      ${headerStrip}
      <div style="padding:14px 28px 0;">
        <div style="font-family:'Archivo',sans-serif;font-size:16px;font-weight:800;color:#111827;margin-bottom:10px;">5B · Minutos Jogados — Todos os Atletas</div>
        ${minsRows.length===0
          ?`<div style="font-family:'Inter',sans-serif;font-size:13px;color:#6b7280;background:#f9fafb;border-radius:8px;padding:24px;text-align:center;">Sem dados de partidas no período</div>`
          :`<div style="overflow:auto;max-height:700px;">
          <table style="width:100%;border-collapse:collapse;border-radius:8px;overflow:hidden;border:1px solid #e5e7eb;font-size:10px;">
            <thead><tr style="background:#1a56db;color:#fff;position:sticky;top:0;">
              <th style="padding:7px 10px;text-align:left;font-family:'Inter',sans-serif;font-weight:600;font-size:10px;">Atleta</th>
              <th style="padding:7px 10px;text-align:left;font-family:'Inter',sans-serif;font-weight:600;font-size:10px;">Posição</th>
              <th style="padding:7px 10px;text-align:center;font-family:'Inter',sans-serif;font-weight:600;font-size:10px;">Jogos</th>
              <th style="padding:7px 10px;text-align:center;font-family:'Inter',sans-serif;font-weight:600;font-size:10px;">Minutos</th>
              <th style="padding:7px 10px;text-align:center;font-family:'Inter',sans-serif;font-weight:600;font-size:10px;">Gols</th>
              <th style="padding:7px 10px;text-align:center;font-family:'Inter',sans-serif;font-weight:600;font-size:10px;">Assist.</th>
              <th style="padding:7px 10px;text-align:center;font-family:'Inter',sans-serif;font-weight:600;font-size:10px;">Def. Difíceis</th>
              <th style="padding:7px 10px;text-align:center;font-family:'Inter',sans-serif;font-weight:600;font-size:10px;">Finalizações</th>
              <th style="padding:7px 10px;text-align:center;font-family:'Inter',sans-serif;font-weight:600;font-size:10px;">DG</th>
              <th style="padding:7px 10px;text-align:center;font-family:'Inter',sans-serif;font-weight:600;font-size:10px;">DP</th>
              <th style="padding:7px 10px;text-align:center;font-family:'Inter',sans-serif;font-weight:600;font-size:10px;">IP</th>
            </tr></thead>
            <tbody>${minsTableRows}</tbody>
          </table></div>`}
      </div>
    </section>`;

    // ════════ PAGE 6 – FECHAMENTO ═════════════════════════════════════════
    const tituloFechamento=filtroPeriodo==='competitivo'?'O que nos trouxe até as oitavas':'O que definiu esta fase';
    const prioridades=desafios.slice(0,3).map((d,i)=>d||`Prioridade ${i+1}`);
    const comparacaoHtml=showComparacao?`
      <table style="width:100%;border-collapse:collapse;margin-top:8px;">
        <thead><tr>
          <th style="padding:6px 10px;font-size:10px;font-family:'Inter',sans-serif;color:#6b7280;font-weight:600;text-align:left;">Métrica</th>
          <th style="padding:6px 10px;font-size:10px;font-family:'Inter',sans-serif;color:#16a34a;font-weight:600;text-align:center;">Quando Vencemos (${jogosVit.length}J)</th>
          <th style="padding:6px 10px;font-size:10px;font-family:'Inter',sans-serif;color:#dc2626;font-weight:600;text-align:center;">Quando não vencemos (${jogosNVit.length}J)</th>
        </tr></thead>
        <tbody>
          ${[
            ['Finalizações médias',cmpFin[0],cmpFin[1]],
            ['Chances Claras médias',cmpCC[0],cmpCC[1]],
            ['Duelos Ganhos médios',cmpDG[0],cmpDG[1]],
            ['Faltas cometidas médias',cmpFalta[0],cmpFalta[1]],
          ].map(([k,v,d],i)=>`<tr style="background:${i%2?'#f9fafb':'#fff'};"><td style="padding:6px 10px;font-family:'Inter',sans-serif;font-size:11px;">${k}</td><td style="padding:6px 10px;text-align:center;font-family:'Archivo',sans-serif;font-size:12px;font-weight:700;color:#16a34a;">${v??'—'}</td><td style="padding:6px 10px;text-align:center;font-family:'Archivo',sans-serif;font-size:12px;font-weight:700;color:#dc2626;">${d??'—'}</td></tr>`).join('')}
        </tbody>
      </table>`:`<div style="font-family:'Inter',sans-serif;font-size:11px;color:#9ca3af;padding:12px;text-align:center;background:#f9fafb;border-radius:6px;">Amostra insuficiente para comparação (mínimo 2 jogos em cada grupo)</div>`;
    const page6=`
    <section class="page" data-essencial="true" style="${pageStyle}width:1122px;height:793px;">
      ${headerStrip}
      <div style="padding:18px 28px 0;">
        <div style="font-family:'Archivo',sans-serif;font-size:16px;font-weight:800;color:#111827;margin-bottom:14px;">6 · ${tituloFechamento}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;align-items:start;">
          <div>
            <div style="font-family:'Archivo',sans-serif;font-size:12px;font-weight:700;color:#1a56db;margin-bottom:6px;border-bottom:2px solid #1a56db;padding-bottom:4px;">Assinatura da Campanha</div>
            <div style="background:#fef9ec;border:1px solid #fcd34d;border-radius:6px;padding:6px 10px;margin-bottom:8px;font-family:'Inter',sans-serif;font-size:9px;color:#78350f;">
              <strong>Amostra: ${totalJogos} jogos</strong> — leitura descritiva da nossa campanha, não fórmula de vitória.
            </div>
            ${comparacaoHtml}
          </div>
          <div>
            <div style="font-family:'Archivo',sans-serif;font-size:12px;font-weight:700;color:#111827;margin-bottom:8px;border-bottom:2px solid #d1d5db;padding-bottom:4px;">3 Prioridades para a fase eliminatória</div>
            ${prioridades.map((p,i)=>`
              <div contenteditable="true" style="padding:10px 14px;margin-bottom:8px;background:#f8faff;border-left:3px solid #1a56db;border-radius:0 6px 6px 0;cursor:text;">
                <div style="font-family:'Archivo',sans-serif;font-size:10px;font-weight:700;color:#1a56db;margin-bottom:2px;">Prioridade ${i+1}</div>
                <div style="font-family:'Inter',sans-serif;font-size:11px;color:#374151;">${esc(p)||'Clique para editar'}</div>
              </div>`).join('')}
            <div style="font-family:'Inter',sans-serif;font-size:9px;color:#9ca3af;margin-top:4px;">Clique nos bullets para editar antes de exportar</div>
          </div>
        </div>
        <div style="margin-top:14px;background:#f1f5ff;border-radius:8px;padding:10px 16px;display:flex;gap:16px;align-items:center;">
          ${kpiBox('Total Jogos',totalJogos,'')}
          ${kpiBox('Aproveitamento',aproveitamento!=null?`${aproveitamento}%`:'—','')}
          ${kpiBox('Saldo Gols',saldoGols>=0?`+${saldoGols}`:String(saldoGols),'',saldoGols>=0?'#059669':'#dc2626')}
          ${kpiBox('IGP Final',avgRound(allDM.slice(-14).map(d=>d._sc.global).filter(v=>v!=null))??'—','últimas 2 semanas','#1a56db')}
        </div>
      </div>
    </section>`;

    // ════════ Assemble all pages ══════════════════════════════════════════
    const allPages=[page0,page1,page2,page3ab,page3c,
      ...(isFutebol?[page4ab,page4c,page4d,page4f,page4g,page4e]:[]),
      page5,page5b].filter(Boolean).join('\n');

    // ════════ RELATÓRIO DE ELENCO — Montagem de Plantel ══════════════════
    if(escopo==='elenco'){
      // Lesões por atleta
      const lesoesPerAtleta={};
      docLesoes.forEach(d=>{if(!d.athleteId)return;lesoesPerAtleta[d.athleteId]=(lesoesPerAtleta[d.athleteId]||0)+1;});
      // Médias MIHBD por atleta
      const atlSist={};
      Object.entries(porAtleta).forEach(([aid,dms])=>{
        const ih=dms.map(d=>d._sc.IH).filter(v=>v!=null);
        const ia=dms.map(d=>d._sc.IA).filter(v=>v!=null);
        const inm=dms.map(d=>d._sc.INM).filter(v=>v!=null);
        const ic=dms.map(d=>d._sc.IC).filter(v=>v!=null);
        atlSist[aid]={IH:ih.length?Math.round(avg(ih)):null,IA:ia.length?Math.round(avg(ia)):null,INM:inm.length?Math.round(avg(inm)):null,IC:ic.length?Math.round(avg(ic)):null,n:dms.length};
      });
      // Atletas por posição
      const posByCount={};
      atletasAtivosArr.forEach(a=>{const p=(a.posicao||'Não informado').trim();posByCount[p]=(posByCount[p]||0)+1;});
      // Lista enriquecida ordenada por IGP desc
      const atletasElenco=atletasAtivosArr.map(a=>({
        ...a,igp:atlIGP[a.id]??null,avail:atlAvail[a.id]??null,
        mins:atlMins[a.id]||0,jogos:atlJogos[a.id]||0,
        gols:atlGols[a.id]||0,assist:atlAssist[a.id]||0,
        lesoes:lesoesPerAtleta[a.id]||0,...(atlSist[a.id]||{}),
      })).sort((a,b)=>(b.igp??-1)-(a.igp??-1));

      // Helpers de cor/label
      const sColor=v=>{if(v==null)return'#9ca3af';if(v>=70)return'#16a34a';if(v>=60)return'#ca8a04';if(v>=50)return'#f97316';return'#dc2626';};
      const sBg=v=>{if(v==null)return'#f3f4f6';if(v>=70)return'#f0fdf4';if(v>=60)return'#fefce8';if(v>=50)return'#fff7ed';return'#fef2f2';};
      const sLabel=v=>{if(v==null)return'—';if(v>=70)return'Estável';if(v>=60)return'At. Leve';if(v>=50)return'Atenção';return'Crítico';};
      const aColor=v=>{if(v==null)return'#9ca3af';if(v>=85)return'#16a34a';if(v>=70)return'#ca8a04';return'#dc2626';};
      const HS=`<div style="background:#0f172a;color:#fff;padding:10px 28px;display:flex;align-items:center;gap:12px;"><div style="font-family:'Archivo',sans-serif;font-size:13px;font-weight:700;flex:1;">${esc(nomeClube)}</div><div style="font-family:'Inter',sans-serif;font-size:10px;opacity:.8;">Relatório de Elenco · ${periodoLabel} · Ciente IE</div></div>`;
      const PS='position:relative;background:#fff;overflow:hidden;box-sizing:border-box;';
      const KPI=(t,v,s='',c='#0f172a')=>`<div style="background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:12px 14px;text-align:center;flex:1;min-width:100px;"><div style="font-size:9px;color:#6b7280;margin-bottom:4px;font-family:'Inter',sans-serif;">${t}</div><div style="font-size:22px;font-weight:800;color:${c};font-family:'Archivo',sans-serif;line-height:1.1;">${v}</div>${s?`<div style="font-size:9px;color:#9ca3af;margin-top:2px;">${s}</div>`:''}</div>`;

      // ─── PAGE E0: CAPA ────────────────────────────────────────────────────
      const pageE0=`<section class="page" style="${PS}width:1122px;height:793px;">
        <div style="background:#0f172a;height:8px;width:100%;"></div>
        <div style="padding:56px 80px;">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;">
            <div>
              <div style="font-family:'Inter',sans-serif;font-size:11px;font-weight:600;letter-spacing:2px;color:#6b7280;text-transform:uppercase;margin-bottom:8px;">Inteligência Esportiva</div>
              <h1 style="font-family:'Archivo',sans-serif;font-size:50px;font-weight:900;color:#111827;line-height:1.05;margin:0 0 12px;">Relatório de<br>Montagem de Elenco</h1>
              <div style="font-family:'Inter',sans-serif;font-size:18px;color:#0f172a;font-weight:600;">${periodoLabel}</div>
              <div style="font-family:'Inter',sans-serif;font-size:13px;color:#6b7280;margin-top:6px;">${esc(nomeClube)} · ${dataRelatorio}${categoria?` · ${esc(categoria)}`:''}</div>
            </div>
            <div style="opacity:.06;font-size:160px;line-height:1;font-family:'Archivo',sans-serif;font-weight:900;color:#0f172a;">IE</div>
          </div>
          <div style="margin-top:44px;background:#f8faff;border-radius:12px;padding:22px 30px;border:1px solid #dbeafe;">
            <div style="font-family:'Archivo',sans-serif;font-size:12px;font-weight:700;color:#374151;margin-bottom:14px;letter-spacing:.5px;">ÍNDICE</div>
            <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px 32px;font-family:'Inter',sans-serif;font-size:11px;color:#4b5563;">
              <div>1 · Resumo da Temporada</div>
              <div>2 · Saúde e Disponibilidade por Atleta</div>
              <div>3 · Utilização por Posição</div>
              <div>4 · Perfil Físico Individual (MIHBD-TE)</div>
              <div>5 · Destaques e Alertas para o Próximo Ciclo</div>
            </div>
          </div>
          <div style="margin-top:22px;display:flex;align-items:center;gap:8px;">
            <div style="width:32px;height:3px;background:#0f172a;border-radius:2px;"></div>
            <div style="font-family:'Inter',sans-serif;font-size:10px;color:#9ca3af;">Gerado pela plataforma Ciente IE · Uso interno — Diretoria e Comissão Técnica</div>
          </div>
        </div>
        <div style="position:absolute;bottom:0;left:0;right:0;height:6px;background:linear-gradient(90deg,#0f172a,#1a56db);"></div>
      </section>`;

      // ─── PAGE E1: RESUMO DA TEMPORADA ─────────────────────────────────────
      const igpMedioGeral=avgRound(atletasElenco.map(a=>a.igp).filter(v=>v!=null));
      const availMedioGeral=avgRound(atletasElenco.map(a=>a.avail).filter(v=>v!=null));
      const totalAtletasEl=atletasAtivosArr.length;
      const totalComDadosEl=Object.keys(porAtleta).filter(aid=>atletasMap[aid]).length;
      const posByCountRows=Object.entries(posByCount).sort((a,b)=>b[1]-a[1]).map(([p,c])=>`<div style="display:flex;align-items:center;justify-content:space-between;padding:5px 0;border-bottom:1px solid #f3f4f6;"><span style="font-family:'Inter',sans-serif;font-size:11px;color:#374151;">${esc(p)}</span><span style="font-family:'Archivo',sans-serif;font-size:13px;font-weight:700;color:#0f172a;">${c}</span></div>`).join('');
      const pageE1=`<section class="page" style="${PS}width:1122px;height:793px;">
        ${HS}
        <div style="padding:16px 28px 0;">
          <div style="font-family:'Archivo',sans-serif;font-size:16px;font-weight:800;color:#111827;margin-bottom:12px;">1 · Resumo da Temporada</div>
          <div style="display:flex;gap:8px;margin-bottom:16px;">
            ${KPI('Total de Jogos',totalJogos||'—')}
            ${KPI('V / E / D',totalJogos?`${totalV}/${totalE}/${totalD}`:'—','resultado da fase')}
            ${KPI('Aproveitamento',aproveitamento!=null?`${aproveitamento}%`:'—','pts/possível',aproveitamento>=60?'#16a34a':aproveitamento>=45?'#ca8a04':'#dc2626')}
            ${KPI('Gols Pró',totalGolsPro??0,'marcados',(totalGolsPro??0)>=(totalGolsContra??0)?'#16a34a':'#dc2626')}
            ${KPI('Gols Contra',totalGolsContra??0,'sofridos',(totalGolsContra??0)>(totalGolsPro??0)?'#dc2626':'#374151')}
            ${KPI('Disponibilidade',availMedioGeral!=null?`${availMedioGeral}%`:'—','média por jogo',availMedioGeral>=80?'#16a34a':availMedioGeral>=65?'#ca8a04':'#dc2626')}
            ${KPI('IGP Médio do Elenco',igpMedioGeral??'—','prontidão física',igpMedioGeral>=70?'#16a34a':igpMedioGeral>=60?'#ca8a04':igpMedioGeral>=50?'#f97316':'#dc2626')}
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;align-items:start;">
            <div>
              <div style="font-family:'Archivo',sans-serif;font-size:12px;font-weight:700;color:#0f172a;margin-bottom:8px;border-bottom:2px solid #0f172a;padding-bottom:4px;">Composição do Elenco</div>
              <div style="display:flex;gap:8px;margin-bottom:10px;">
                ${KPI('Total de Atletas',totalAtletasEl,'cadastrados e ativos')}
                ${KPI('Monitorados',totalComDadosEl,'com coletas no período')}
                ${KPI('Lesões',totalLesoes||0,'episódios registrados',totalLesoes>5?'#dc2626':'#374151')}
              </div>
              <div style="background:#f8faff;border-radius:8px;padding:10px 14px;">
                <div style="font-family:'Archivo',sans-serif;font-size:10px;font-weight:700;color:#6b7280;margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px;">Atletas por Posição</div>
                ${posByCountRows}
              </div>
            </div>
            <div>
              <div style="font-family:'Archivo',sans-serif;font-size:12px;font-weight:700;color:#0f172a;margin-bottom:8px;border-bottom:2px solid #0f172a;padding-bottom:4px;">Saúde do Elenco</div>
              <div style="display:flex;gap:8px;margin-bottom:10px;">
                ${KPI('Dias Perdidos',totalDiasPerdidos||0,'por lesões',(totalDiasPerdidos||0)>50?'#dc2626':'#374151')}
                ${KPI('Média por Lesão',mediaDiasPorLesao??'—','dias afastado')}
                ${KPI('Graves',lesGrave||0,'lesões >28 dias',lesGrave>2?'#dc2626':'#374151')}
              </div>
              ${totalLesoes>0?`<div style="background:#f8faff;border-radius:8px;padding:10px 14px;">
                <div style="font-family:'Archivo',sans-serif;font-size:10px;font-weight:700;color:#6b7280;margin-bottom:8px;text-transform:uppercase;letter-spacing:.5px;">Gravidade das Lesões</div>
                <div style="display:flex;gap:8px;">
                  <div style="flex:1;background:#fef2f2;border-radius:6px;padding:8px;text-align:center;"><div style="font-size:22px;font-weight:800;color:#dc2626;font-family:'Archivo',sans-serif;">${lesGrave}</div><div style="font-size:9px;color:#6b7280;">Grave (&gt;28d)</div></div>
                  <div style="flex:1;background:#fff7ed;border-radius:6px;padding:8px;text-align:center;"><div style="font-size:22px;font-weight:800;color:#f97316;font-family:'Archivo',sans-serif;">${lesMod}</div><div style="font-size:9px;color:#6b7280;">Moderada (8-28d)</div></div>
                  <div style="flex:1;background:#f0fdf4;border-radius:6px;padding:8px;text-align:center;"><div style="font-size:22px;font-weight:800;color:#16a34a;font-family:'Archivo',sans-serif;">${lesLeve}</div><div style="font-size:9px;color:#6b7280;">Leve (≤7d)</div></div>
                  ${lesSemInfo>0?`<div style="flex:1;background:#f9fafb;border-radius:6px;padding:8px;text-align:center;"><div style="font-size:22px;font-weight:800;color:#9ca3af;font-family:'Archivo',sans-serif;">${lesSemInfo}</div><div style="font-size:9px;color:#6b7280;">Sem info</div></div>`:''}
                </div>
              </div>`:`<div style="background:#f0fdf4;border-radius:8px;padding:16px;text-align:center;font-family:'Inter',sans-serif;font-size:12px;color:#16a34a;font-weight:600;">Nenhuma lesão registrada no período</div>`}
            </div>
          </div>
        </div>
      </section>`;

      // ─── PAGE E2: SAÚDE E DISPONIBILIDADE POR ATLETA ──────────────────────
      const dispRows2=atletasAtivosArr
        .map(a=>({...a,avail:atlAvail[a.id]??null,lesoes:lesoesPerAtleta[a.id]||0,mins:atlMins[a.id]||0,jogos:atlJogos[a.id]||0,igp:atlIGP[a.id]??null}))
        .sort((a,b)=>(b.avail??-1)-(a.avail??-1)||a.lesoes-b.lesoes)
        .map((r,i)=>`<tr style="background:${i%2?'#f9fafb':'#fff'};"><td style="padding:5px 8px;font-size:10px;font-family:'Inter',sans-serif;color:#111827;font-weight:600;">${esc(r.nome)}</td><td style="padding:5px 8px;font-size:9px;font-family:'Inter',sans-serif;color:#6b7280;">${esc(r.posicao||'—')}</td><td style="padding:5px 8px;font-size:9px;font-family:'Inter',sans-serif;color:#6b7280;">${esc(r.categoria||'—')}</td><td style="padding:5px 8px;font-size:11px;font-weight:700;text-align:center;font-family:'Archivo',sans-serif;color:${aColor(r.avail)};">${r.avail!=null?`${r.avail}%`:'—'}</td><td style="padding:5px 8px;font-size:11px;font-weight:700;text-align:center;font-family:'Archivo',sans-serif;color:${r.lesoes>2?'#dc2626':r.lesoes>0?'#f97316':'#16a34a'};">${r.lesoes}</td><td style="padding:5px 8px;font-size:11px;font-weight:700;text-align:center;font-family:'Archivo',sans-serif;">${r.jogos||'—'}</td><td style="padding:5px 8px;font-size:11px;font-weight:700;text-align:center;font-family:'Archivo',sans-serif;color:#1a56db;">${r.mins||'—'}</td><td style="padding:5px 8px;font-size:11px;font-weight:700;text-align:center;font-family:'Archivo',sans-serif;color:${sColor(r.igp)};">${r.igp??'—'}</td></tr>`).join('');
      const pageE2=`<section class="page" style="${PS}width:1122px;height:793px;">
        ${HS}
        <div style="padding:14px 28px 0;">
          <div style="font-family:'Archivo',sans-serif;font-size:16px;font-weight:800;color:#111827;margin-bottom:10px;">2 · Saúde e Disponibilidade por Atleta</div>
          ${dispRows2===''?`<div style="text-align:center;padding:40px;color:#9ca3af;font-family:'Inter',sans-serif;">Sem dados no período</div>`:`<div style="overflow:auto;max-height:692px;"><table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;"><thead><tr style="background:#0f172a;color:#fff;"><th style="padding:7px 10px;text-align:left;font-family:'Inter',sans-serif;font-weight:600;font-size:10px;">Atleta</th><th style="padding:7px 10px;text-align:left;font-family:'Inter',sans-serif;font-weight:600;font-size:10px;">Posição</th><th style="padding:7px 10px;text-align:left;font-family:'Inter',sans-serif;font-weight:600;font-size:10px;">Categoria</th><th style="padding:7px 10px;text-align:center;font-family:'Inter',sans-serif;font-weight:600;font-size:10px;">Disponibilidade</th><th style="padding:7px 10px;text-align:center;font-family:'Inter',sans-serif;font-weight:600;font-size:10px;">Lesões</th><th style="padding:7px 10px;text-align:center;font-family:'Inter',sans-serif;font-weight:600;font-size:10px;">Jogos</th><th style="padding:7px 10px;text-align:center;font-family:'Inter',sans-serif;font-weight:600;font-size:10px;">Minutos</th><th style="padding:7px 10px;text-align:center;font-family:'Inter',sans-serif;font-weight:600;font-size:10px;">IGP Médio</th></tr></thead><tbody>${dispRows2}</tbody></table></div>`}
        </div>
      </section>`;

      // ─── PAGE E3: UTILIZAÇÃO POR POSIÇÃO ──────────────────────────────────
      const porPosicaoEl={};
      atletasAtivosArr.forEach(a=>{const pos=(a.posicao||'Não informado').trim();if(!porPosicaoEl[pos])porPosicaoEl[pos]=[];porPosicaoEl[pos].push(a);});
      const posOrderEl=['Goleiro','Lateral Direito','Lateral Esquerdo','Zagueiro','Volante','Meia','Atacante','Centro-avante'];
      const posKeysEl=[...posOrderEl.filter(p=>porPosicaoEl[p]),...Object.keys(porPosicaoEl).filter(p=>!posOrderEl.includes(p))];
      const posRowsEl=posKeysEl.map((pos,pi)=>{
        const atls=porPosicaoEl[pos].map(a=>({...a,mins:atlMins[a.id]||0,jogos:atlJogos[a.id]||0,gols:atlGols[a.id]||0,assist:atlAssist[a.id]||0,igp:atlIGP[a.id]??null})).sort((a,b)=>b.mins-a.mins);
        return atls.map((a,i)=>`<tr style="background:${pi%2===0?(i%2?'#f8faff':'#eff6ff'):(i%2?'#f9fafb':'#fff')};">${i===0?`<td rowspan="${atls.length}" style="padding:6px 10px;font-family:'Archivo',sans-serif;font-size:11px;font-weight:800;color:#0f172a;border-right:2px solid #e5e7eb;vertical-align:middle;white-space:nowrap;">${esc(pos)}<br><span style="font-size:9px;font-weight:500;color:#6b7280;">${atls.length} atleta${atls.length>1?'s':''}</span></td>`:''}<td style="padding:5px 8px;font-size:10px;font-family:'Inter',sans-serif;color:#111827;font-weight:600;">${esc(a.nome)}</td><td style="padding:5px 8px;font-size:10px;font-family:'Inter',sans-serif;color:#6b7280;">${esc(a.categoria||'—')}</td><td style="padding:5px 8px;font-size:11px;font-weight:700;text-align:center;font-family:'Archivo',sans-serif;">${a.jogos||'—'}</td><td style="padding:5px 8px;font-size:11px;font-weight:700;text-align:center;font-family:'Archivo',sans-serif;color:#1a56db;">${a.mins||'—'}</td><td style="padding:5px 8px;font-size:11px;font-weight:700;text-align:center;font-family:'Archivo',sans-serif;color:#16a34a;">${a.gols||0}</td><td style="padding:5px 8px;font-size:11px;font-weight:700;text-align:center;font-family:'Archivo',sans-serif;color:#16a34a;">${a.assist||0}</td><td style="padding:5px 8px;font-size:11px;font-weight:700;text-align:center;font-family:'Archivo',sans-serif;color:${sColor(a.igp)};">${a.igp??'—'}</td></tr>`).join('');
      }).join('');
      const pageE3=`<section class="page" style="${PS}width:1122px;height:793px;">
        ${HS}
        <div style="padding:14px 28px 0;">
          <div style="font-family:'Archivo',sans-serif;font-size:16px;font-weight:800;color:#111827;margin-bottom:10px;">3 · Utilização por Posição</div>
          ${posKeysEl.length===0?`<div style="text-align:center;padding:40px;color:#9ca3af;font-family:'Inter',sans-serif;">Sem dados de partidas no período</div>`:`<div style="overflow:auto;max-height:692px;"><table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;"><thead><tr style="background:#0f172a;color:#fff;"><th style="padding:7px 10px;text-align:left;font-family:'Inter',sans-serif;font-weight:600;font-size:10px;min-width:110px;">Posição</th><th style="padding:7px 10px;text-align:left;font-family:'Inter',sans-serif;font-weight:600;font-size:10px;">Atleta</th><th style="padding:7px 10px;text-align:left;font-family:'Inter',sans-serif;font-weight:600;font-size:10px;">Categoria</th><th style="padding:7px 10px;text-align:center;font-family:'Inter',sans-serif;font-weight:600;font-size:10px;">Jogos</th><th style="padding:7px 10px;text-align:center;font-family:'Inter',sans-serif;font-weight:600;font-size:10px;">Minutos</th><th style="padding:7px 10px;text-align:center;font-family:'Inter',sans-serif;font-weight:600;font-size:10px;">Gols</th><th style="padding:7px 10px;text-align:center;font-family:'Inter',sans-serif;font-weight:600;font-size:10px;">Assist.</th><th style="padding:7px 10px;text-align:center;font-family:'Inter',sans-serif;font-weight:600;font-size:10px;">IGP</th></tr></thead><tbody>${posRowsEl}</tbody></table></div>`}
        </div>
      </section>`;

      // ─── PAGE E4: PERFIL FÍSICO INDIVIDUAL (MIHBD-TE) ─────────────────────
      const mihbdRowsEl=atletasElenco.filter(a=>(atlSist[a.id]?.n||0)>0||a.igp!=null).map(a=>{
        const s=atlSist[a.id]||{};
        const cV=v=>`<td style="padding:5px 8px;text-align:center;font-family:'Archivo',sans-serif;font-size:11px;font-weight:700;background:${sBg(v)};color:${sColor(v)};">${v??'—'}</td>`;
        return`<tr style="border-bottom:1px solid #f3f4f6;"><td style="padding:5px 8px;font-size:10px;font-family:'Inter',sans-serif;color:#111827;font-weight:600;">${esc(a.nome)}</td><td style="padding:5px 8px;font-size:9px;font-family:'Inter',sans-serif;color:#6b7280;">${esc(a.posicao||'—')}</td><td style="padding:5px 8px;font-size:9px;font-family:'Inter',sans-serif;color:#6b7280;text-align:center;">${s.n||'—'}</td>${cV(s.IH)}${cV(s.IA)}${cV(s.INM)}${cV(s.IC)}<td style="padding:5px 8px;text-align:center;font-family:'Archivo',sans-serif;font-size:12px;font-weight:800;background:${sBg(a.igp)};color:${sColor(a.igp)};">${a.igp??'—'}</td><td style="padding:5px 8px;text-align:center;font-family:'Inter',sans-serif;font-size:9px;font-weight:600;color:${sColor(a.igp)};">${sLabel(a.igp)}</td></tr>`;
      }).join('');
      const pageE4=`<section class="page" style="${PS}width:1122px;height:793px;">
        ${HS}
        <div style="padding:14px 28px 0;">
          <div style="font-family:'Archivo',sans-serif;font-size:16px;font-weight:800;color:#111827;margin-bottom:6px;">4 · Perfil Físico Individual — MIHBD-TE</div>
          <div style="display:flex;gap:12px;margin-bottom:8px;align-items:center;flex-wrap:wrap;">
            <span style="font-family:'Inter',sans-serif;font-size:10px;color:#6b7280;">Médias do período · IH=Hooper · IA=HRV · INM=CMJ · IC=NeuroScore · IGP=Índice Global</span>
            <span style="display:inline-flex;align-items:center;gap:4px;font-size:9px;font-family:'Inter',sans-serif;"><span style="width:10px;height:10px;background:#f0fdf4;border:1px solid #d1fae5;border-radius:2px;display:inline-block;"></span>Estável ≥70</span>
            <span style="display:inline-flex;align-items:center;gap:4px;font-size:9px;font-family:'Inter',sans-serif;"><span style="width:10px;height:10px;background:#fefce8;border:1px solid #fde68a;border-radius:2px;display:inline-block;"></span>At. Leve 60-69</span>
            <span style="display:inline-flex;align-items:center;gap:4px;font-size:9px;font-family:'Inter',sans-serif;"><span style="width:10px;height:10px;background:#fff7ed;border:1px solid #fed7aa;border-radius:2px;display:inline-block;"></span>Atenção 50-59</span>
            <span style="display:inline-flex;align-items:center;gap:4px;font-size:9px;font-family:'Inter',sans-serif;"><span style="width:10px;height:10px;background:#fef2f2;border:1px solid #fecaca;border-radius:2px;display:inline-block;"></span>Crítico &lt;50</span>
          </div>
          ${mihbdRowsEl===''?`<div style="text-align:center;padding:40px;color:#9ca3af;font-family:'Inter',sans-serif;">Sem dados de monitoramento no período</div>`:`<div style="overflow:auto;max-height:658px;"><table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;"><thead><tr style="background:#0f172a;color:#fff;"><th style="padding:7px 10px;text-align:left;font-family:'Inter',sans-serif;font-weight:600;font-size:10px;">Atleta</th><th style="padding:7px 10px;text-align:left;font-family:'Inter',sans-serif;font-weight:600;font-size:10px;">Posição</th><th style="padding:7px 10px;text-align:center;font-family:'Inter',sans-serif;font-weight:600;font-size:10px;">Coletas</th><th style="padding:7px 10px;text-align:center;font-family:'Inter',sans-serif;font-weight:600;font-size:10px;">IH</th><th style="padding:7px 10px;text-align:center;font-family:'Inter',sans-serif;font-weight:600;font-size:10px;">IA</th><th style="padding:7px 10px;text-align:center;font-family:'Inter',sans-serif;font-weight:600;font-size:10px;">INM</th><th style="padding:7px 10px;text-align:center;font-family:'Inter',sans-serif;font-weight:600;font-size:10px;">IC</th><th style="padding:7px 10px;text-align:center;font-family:'Inter',sans-serif;font-weight:600;font-size:10px;">IGP</th><th style="padding:7px 10px;text-align:center;font-family:'Inter',sans-serif;font-weight:600;font-size:10px;">Status</th></tr></thead><tbody>${mihbdRowsEl}</tbody></table></div>`}
        </div>
      </section>`;

      // ─── PAGE E5: DESTAQUES E ALERTAS ─────────────────────────────────────
      const medals=['🥇','🥈','🥉','4.','5.'];
      const top5IGP=atletasElenco.filter(a=>a.igp!=null).slice(0,5);
      const top5Avail=[...atletasElenco].filter(a=>a.avail!=null).sort((a,b)=>(b.avail??0)-(a.avail??0)).slice(0,5);
      const atletasRisco=atletasElenco.filter(a=>a.lesoes>=2||(a.avail!=null&&a.avail<70)||(a.igp!=null&&a.igp<50)).slice(0,8);
      const posSolitario=Object.entries(posByCount).filter(([,c])=>c===1).map(([p])=>p);
      const t5IGPHtml=top5IGP.length?top5IGP.map((a,i)=>`<div style="display:flex;align-items:center;justify-content:space-between;padding:5px 0;border-bottom:1px solid #f3f4f6;"><span style="font-family:'Inter',sans-serif;font-size:10px;color:#374151;">${medals[i]} ${esc(a.nome)} <span style="color:#9ca3af;font-size:9px;">${esc(a.posicao||'')}</span></span><span style="font-family:'Archivo',sans-serif;font-size:12px;font-weight:700;color:${sColor(a.igp)};">${a.igp}</span></div>`).join(''):`<div style="text-align:center;padding:10px;color:#9ca3af;font-size:10px;">Sem dados</div>`;
      const t5AvailHtml=top5Avail.length?top5Avail.map((a,i)=>`<div style="display:flex;align-items:center;justify-content:space-between;padding:5px 0;border-bottom:1px solid #f3f4f6;"><span style="font-family:'Inter',sans-serif;font-size:10px;color:#374151;">${medals[i]} ${esc(a.nome)} <span style="color:#9ca3af;font-size:9px;">${esc(a.posicao||'')}</span></span><span style="font-family:'Archivo',sans-serif;font-size:12px;font-weight:700;color:${aColor(a.avail)};">${a.avail}%</span></div>`).join(''):`<div style="text-align:center;padding:10px;color:#9ca3af;font-size:10px;">Sem dados</div>`;
      const riscoHtml=atletasRisco.length?atletasRisco.map(a=>{const m=[];if(a.lesoes>=2)m.push(`${a.lesoes} lesões`);if(a.avail!=null&&a.avail<70)m.push(`${a.avail}% disp.`);if(a.igp!=null&&a.igp<50)m.push(`IGP ${a.igp}`);return`<div style="display:flex;align-items:center;justify-content:space-between;padding:5px 0;border-bottom:1px solid #fef2f2;"><span style="font-family:'Inter',sans-serif;font-size:10px;color:#374151;font-weight:600;">${esc(a.nome)} <span style="color:#9ca3af;font-size:9px;">${esc(a.posicao||'')}</span></span><span style="font-family:'Inter',sans-serif;font-size:9px;color:#dc2626;">${m.join(' · ')}</span></div>`;}).join(''):`<div style="text-align:center;padding:10px;color:#16a34a;font-size:10px;font-weight:600;">Nenhum atleta em situação de risco</div>`;
      const lacunasHtml=posSolitario.length?posSolitario.map(p=>`<span style="display:inline-block;margin:3px;padding:4px 10px;background:#fef9ec;border:1px solid #fcd34d;border-radius:20px;font-family:'Inter',sans-serif;font-size:10px;color:#78350f;font-weight:600;">${esc(p)}</span>`).join(''):`<div style="font-size:10px;color:#16a34a;font-family:'Inter',sans-serif;padding:6px;font-weight:600;">Nenhuma posição com apenas 1 atleta</div>`;
      const DC=(title,rows,color)=>`<div style="background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:12px 14px;"><div style="font-family:'Archivo',sans-serif;font-size:11px;font-weight:800;color:${color};margin-bottom:8px;border-bottom:2px solid ${color};padding-bottom:4px;">${title}</div>${rows}</div>`;
      const pageE5=`<section class="page" style="${PS}width:1122px;height:793px;">
        ${HS}
        <div style="padding:14px 28px 0;">
          <div style="font-family:'Archivo',sans-serif;font-size:16px;font-weight:800;color:#111827;margin-bottom:14px;">5 · Destaques e Alertas para o Próximo Ciclo</div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px;margin-bottom:14px;">
            ${DC('Top 5 — IGP Médio (Prontidão Física)',t5IGPHtml,'#0f172a')}
            ${DC('Top 5 — Disponibilidade (Saúde)',t5AvailHtml,'#16a34a')}
            ${DC('Alertas de Risco — Atenção Especial',riscoHtml,'#dc2626')}
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">
            <div style="background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:12px 14px;">
              <div style="font-family:'Archivo',sans-serif;font-size:11px;font-weight:800;color:#ca8a04;margin-bottom:8px;border-bottom:2px solid #fcd34d;padding-bottom:4px;">Posições com 1 Atleta — Reforço Recomendado</div>
              <div style="margin-top:4px;">${lacunasHtml}</div>
            </div>
            <div style="background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:12px 14px;">
              <div style="font-family:'Archivo',sans-serif;font-size:11px;font-weight:800;color:#0f172a;margin-bottom:8px;border-bottom:2px solid #e5e7eb;padding-bottom:4px;">Observações da Comissão Técnica</div>
              ${[0,1,2].map(i=>`<div contenteditable="true" style="padding:8px 12px;margin-bottom:6px;background:#f8faff;border-left:3px solid #0f172a;border-radius:0 6px 6px 0;cursor:text;min-height:30px;"><span style="font-family:'Inter',sans-serif;font-size:10px;color:#9ca3af;">Clique para editar observação ${i+1}…</span></div>`).join('')}
            </div>
          </div>
          <div style="margin-top:12px;background:#f8faff;border-radius:8px;padding:8px 14px;font-family:'Inter',sans-serif;font-size:9px;color:#9ca3af;text-align:center;">Relatório de Elenco — Uso interno · Diretoria e Comissão Técnica · ${dataRelatorio}</div>
        </div>
      </section>`;

      // Monta e escreve HTML do Relatório de Elenco
      const elencoPagesHtml=[pageE0,pageE1,pageE2,pageE3,pageE4,pageE5].filter(Boolean).join('\n');
      const elencoFullHtml=`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <base href="/">
  <title>Relatório de Elenco — ${esc(nomeClube)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;600;700;800;900&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js"></script>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{background:#e8e8e8;font-family:'Inter',sans-serif;}
    .toolbar{position:sticky;top:0;z-index:1000;background:#0f172a;color:#fff;display:flex;align-items:center;gap:12px;padding:8px 20px;print-color-adjust:exact;}
    .toolbar button{background:#fff;color:#0f172a;border:none;border-radius:6px;padding:6px 14px;font-size:12px;font-weight:700;cursor:pointer;font-family:'Inter',sans-serif;}
    .toolbar button:hover{opacity:.9;}
    .toolbar .spacer{flex:1;}
    .page{display:block;margin:16px auto;box-shadow:0 4px 24px rgba(0,0,0,.18);}
    [contenteditable]:focus{outline:2px solid #0f172a;border-radius:3px;}
    @media print{.toolbar{display:none!important;}.page{margin:0!important;box-shadow:none!important;page-break-after:always;}.page:last-child{page-break-after:avoid;}body{background:#fff;}}
  </style>
</head>
<body>
<div class="toolbar">
  <div style="font-weight:700;font-size:13px;">${esc(nomeClube)} · Relatório de Elenco</div>
  <div style="font-size:11px;opacity:.8;">${periodoLabel}</div>
  <div class="spacer"></div>
  <button onclick="exportarPDF()" id="btnExport">Exportar PDF</button>
</div>
${elencoPagesHtml}
<script>
  async function exportarPDF(){
    const btn=document.getElementById('btnExport');
    btn.disabled=true;btn.textContent='Gerando PDF…';
    try{
      const pages=[...document.querySelectorAll('.page')];
      const{jsPDF}=window.jspdf;
      const pdf=new jsPDF({orientation:'landscape',unit:'mm',format:'a4'});
      for(let i=0;i<pages.length;i++){
        btn.textContent=\`Página \${i+1}/\${pages.length}…\`;
        const canvas=await html2canvas(pages[i],{scale:2,useCORS:true,backgroundColor:'#fff',width:1122,height:793,windowWidth:1200,logging:false});
        if(i>0)pdf.addPage([297,210],'landscape');
        pdf.addImage(canvas.toDataURL('image/jpeg',0.92),'JPEG',0,0,297,210);
      }
      pdf.save('relatorio_elenco_'+new Date().toLocaleDateString('en-CA')+'.pdf');
    }catch(e){alert('Erro ao exportar PDF: '+e.message);console.error(e);}
    finally{btn.disabled=false;btn.textContent='Exportar PDF';}
  }
<\/script>
</body>
</html>`;
      win.document.open();
      win.document.write(elencoFullHtml);
      win.document.close();
      return;
    }

    // ════════ RELATÓRIO DE TEMPORADA COMPLETA ════════════════════════════════
    if(escopo==='temporada'){
      const splitDate=dataFase2Inicio||'';
      const jogosFase1=splitDate?jogosData.filter(g=>g.data<splitDate):jogosData;
      const jogosFase2=splitDate?jogosData.filter(g=>g.data>=splitDate):[];

      // Phase stats helper
      function phaseStats(jgs){
        const n=jgs.length;
        if(!n)return{jogos:0,v:0,e:0,d:0,aprov:null,golsPro:0,golsCon:0,saldo:0,fin:null,cc:null,dg:null,dp:null,falta:null,roubada:null};
        const v=jgs.filter(g=>g.resultado==='V').length;
        const e=jgs.filter(g=>g.resultado==='E').length;
        const d=jgs.filter(g=>g.resultado==='D').length;
        const aprov=Math.round((v*3+e)/(n*3)*100);
        const golsPro=jgs.reduce((s,g)=>s+g.pro,0);
        const golsCon=jgs.reduce((s,g)=>s+g.con,0);
        const ids=new Set(jgs.map(g=>g.id));
        const evs=allEvents.filter(ev=>ids.has(ev._gameId));
        const finN=evs.filter(ev=>ev.action==='Finalização').length;
        const ccN=evs.filter(ev=>ev.action==='Chance clara criada').length;
        const dgN=evs.filter(ev=>ev.action==='Duelo ganho (chão)'||ev.action==='Duelo ganho (alto)').length;
        const dpN=evs.filter(ev=>ev.action==='Duelo perdido (chão)'||ev.action==='Duelo perdido (alto)').length;
        const faltaN=evs.filter(ev=>ev.action==='Falta').length;
        const roubadaN=evs.filter(ev=>ev.action==='Roubada (pressão ofensiva)'||ev.action==='Roubada (pós-perda)'||ev.action==='Roubada (combate)').length;
        return{jogos:n,v,e,d,aprov,golsPro,golsCon,saldo:golsPro-golsCon,
          fin:+(finN/n).toFixed(1),cc:+(ccN/n).toFixed(1),dg:+(dgN/n).toFixed(1),dp:+(dpN/n).toFixed(1),falta:+(faltaN/n).toFixed(1),roubada:+(roubadaN/n).toFixed(1)};
      }
      const f1=phaseStats(jogosFase1);
      const f2=phaseStats(jogosFase2);

      // Fix totalDiasPerdidos using getDiasCalculado
      const totalDiasPerdidosFixed=docLesoes.reduce((s,d)=>{const v=getDiasCalculado(d);return v!=null&&v>0?s+v:s;},0);

      const TC=ctx.clubColor||'#065f46';
      const TS2=`<div style="background:${TC};color:#fff;padding:10px 28px;display:flex;align-items:center;gap:12px;"><div style="font-family:'Archivo',sans-serif;font-size:13px;font-weight:700;flex:1;">${esc(nomeClube)}</div><div style="font-family:'Inter',sans-serif;font-size:10px;opacity:.8;">Relatório de Temporada · ${periodoLabel} · Ciente IE</div></div>`;
      const PST='position:relative;background:#fff;overflow:hidden;box-sizing:border-box;';
      const KPIT=(t,v,s='',c=TC)=>`<div style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:10px 12px;text-align:center;flex:1;min-width:80px;"><div style="font-size:9px;color:#6b7280;margin-bottom:3px;font-family:'Inter',sans-serif;">${t}</div><div style="font-size:20px;font-weight:800;color:${c};font-family:'Archivo',sans-serif;line-height:1.1;">${v}</div>${s?`<div style="font-size:8px;color:#9ca3af;margin-top:2px;">${s}</div>`:''}</div>`;

      // ─── Helper: games table ──────────────────────────────────────────────
      const buildGamesTable=jgs=>{
        if(!jgs.length)return`<div style="font-family:'Inter',sans-serif;font-size:12px;color:#6b7280;background:#f9fafb;border-radius:8px;padding:24px;text-align:center;">Nenhuma partida registrada nesta fase</div>`;
        const nV=jgs.filter(g=>g.resultado==='V').length;
        const nE=jgs.filter(g=>g.resultado==='E').length;
        const nD=jgs.filter(g=>g.resultado==='D').length;
        const apG=jgs.length?Math.round((nV*3+nE)/(jgs.length*3)*100):null;
        const rows=jgs.map((g,i)=>{
          const res=g.resultado==='V'?'#16a34a':g.resultado==='E'?'#ca8a04':'#dc2626';
          const mandoLabel=g.mando==='casa'||g.mando==='home'?'Casa':g.mando==='fora'?'Fora':g.mando||'—';
          return`<tr style="background:${i%2?'#f9fafb':'#fff'};">
            <td style="padding:5px 8px;font-family:'Archivo',sans-serif;font-size:11px;font-weight:700;color:#374151;">${g.label}</td>
            <td style="padding:5px 8px;font-family:'Inter',sans-serif;font-size:10px;color:#374151;">${fmtData(g.data)}</td>
            <td style="padding:5px 8px;font-family:'Inter',sans-serif;font-size:10px;color:#374151;">${esc(g.adversario||g.placar?.adversario||'—')}</td>
            <td style="padding:5px 8px;text-align:center;font-family:'Inter',sans-serif;font-size:10px;color:#374151;">${mandoLabel}</td>
            <td style="padding:5px 8px;text-align:center;font-family:'Archivo',sans-serif;font-size:13px;font-weight:800;">${g.pro}-${g.con}</td>
            <td style="padding:5px 8px;text-align:center;"><span style="display:inline-block;padding:2px 8px;border-radius:12px;background:${res}20;color:${res};font-weight:700;font-size:11px;font-family:'Archivo',sans-serif;">${g.resultado}</span></td>
            <td style="padding:5px 8px;text-align:center;font-family:'Inter',sans-serif;font-size:10px;color:#374151;">${g.dispPct!=null?g.dispPct+'%':'—'}</td>
          </tr>`;
        }).join('');
        return`<div style="display:flex;gap:6px;margin-bottom:8px;">
          ${KPIT('Jogos',jgs.length)}
          ${KPIT('V / E / D',`${nV}/${nE}/${nD}`,'resultado','#374151')}
          ${KPIT('Aproveitamento',apG!=null?`${apG}%`:'—','pts/possível',apG>=60?'#16a34a':apG>=45?'#ca8a04':'#dc2626')}
          ${KPIT('Gols Pró',jgs.reduce((s,g)=>s+g.pro,0),'marcados','#16a34a')}
          ${KPIT('Gols Contra',jgs.reduce((s,g)=>s+g.con,0),'sofridos','#dc2626')}
        </div>
        <table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;font-family:'Inter',sans-serif;">
          <thead><tr style="background:${TC};color:#fff;">
            <th style="padding:6px 8px;text-align:left;font-weight:600;font-size:10px;">Rodada</th>
            <th style="padding:6px 8px;text-align:left;font-weight:600;font-size:10px;">Data</th>
            <th style="padding:6px 8px;text-align:left;font-weight:600;font-size:10px;">Adversário</th>
            <th style="padding:6px 8px;text-align:center;font-weight:600;font-size:10px;">Mando</th>
            <th style="padding:6px 8px;text-align:center;font-weight:600;font-size:10px;">Placar</th>
            <th style="padding:6px 8px;text-align:center;font-weight:600;font-size:10px;">Resultado</th>
            <th style="padding:6px 8px;text-align:center;font-weight:600;font-size:10px;">Disp.%</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
      };

      // ─── PAGE T0: CAPA ────────────────────────────────────────────────────
      const pageT0=`<section class="page" style="${PST}width:1122px;height:793px;">
        <div style="background:${TC};height:8px;width:100%;"></div>
        <div style="padding:56px 80px;">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;">
            <div>
              <div style="font-family:'Inter',sans-serif;font-size:11px;font-weight:600;letter-spacing:2px;color:#6b7280;text-transform:uppercase;margin-bottom:8px;">Inteligência Esportiva</div>
              <h1 style="font-family:'Archivo',sans-serif;font-size:50px;font-weight:900;color:#111827;line-height:1.05;margin:0 0 12px;">Relatório de<br>Temporada</h1>
              <div style="font-family:'Inter',sans-serif;font-size:18px;color:${TC};font-weight:600;">${periodoLabel}</div>
              <div style="font-family:'Inter',sans-serif;font-size:13px;color:#6b7280;margin-top:6px;">${esc(nomeClube)} · ${dataRelatorio}${categoria?` · ${esc(categoria)}`:''}</div>
            </div>
            <div style="opacity:.07;font-size:160px;line-height:1;font-family:'Archivo',sans-serif;font-weight:900;color:${TC};">IE</div>
          </div>
          <div style="margin-top:44px;background:#f9fafb;border-radius:12px;padding:22px 30px;border:1px solid #e5e7eb;">
            <div style="font-family:'Archivo',sans-serif;font-size:12px;font-weight:700;color:#374151;margin-bottom:14px;letter-spacing:.5px;">ÍNDICE</div>
            <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px 32px;font-family:'Inter',sans-serif;font-size:11px;color:#4b5563;">
              <div>1 · Primeira Fase — Fase de Grupos</div>
              <div>2 · Segunda Fase — Mata-mata</div>
              <div>3 · Números Primeira × Segunda Fase</div>
              <div>4 · Prontidão e Carga por Fase</div>
              <div>5 · Medicina Esportiva e Performance</div>
              <div>6A · Elenco — Minutagem e Participação</div>
              <div>6B · Rankings — Top 10 por Métrica</div>
              <div>7A · Posse de Bola por Setor</div>
              <div>7B · Duelos por Setor</div>
              <div>7C · Roubadas de Bola por Setor</div>
              <div>7D · Faltas por Setor</div>
              <div>7E · Origem das Finalizações</div>
              <div>7F · Bolas Paradas e Volume Ofensivo</div>
              <div>8 · Escalações — Melhor XI</div>
            </div>
          </div>
          <div style="margin-top:22px;display:flex;align-items:center;gap:8px;">
            <div style="width:32px;height:3px;background:${TC};border-radius:2px;"></div>
            <div style="font-family:'Inter',sans-serif;font-size:10px;color:#9ca3af;">Gerado pela plataforma Ciente IE · ${dataRelatorio}</div>
          </div>
        </div>
        <div style="position:absolute;bottom:0;left:0;right:0;height:6px;background:linear-gradient(90deg,${TC},#1a56db);"></div>
      </section>`;

      // ─── Helper: curva de pontos colorida por resultado ──────────────────
      function buildCurvaPontos(jgs, yMax, color){
        if(!jgs.length) return `<div style="font-family:'Inter',sans-serif;font-size:11px;color:#9ca3af;padding:20px;text-align:center;">Sem jogos registrados</div>`;
        const sorted=[...jgs].sort((a,b)=>a.data.localeCompare(b.data));
        let cumPts=0;
        const vals=[], labels=[], results=[];
        sorted.forEach((g,i)=>{
          cumPts+=(g.resultado==='V'?3:g.resultado==='E'?1:0);
          vals.push(cumPts);
          labels.push(g.label||(i+1)+'ª');
          results.push(g.resultado);
        });
        // Custom SVG (like svgLineChart but with per-point colors)
        const W=1040, H=160;
        const pad={l:44,r:16,t:14,b:36};
        const cW=W-pad.l-pad.r, cH=H-pad.t-pad.b;
        const mn=0, mx=yMax, range=mx-mn||1;
        const xOf=i=>pad.l+i/(vals.length-1||1)*cW;
        const yOf=v=>pad.t+cH-(v-mn)/range*cH;
        let path='', dots='', yAxis='', xLabels='';
        // y-axis ticks
        for(let i=0;i<=4;i++){
          const v=mn+(mx-mn)*i/4;
          const y=yOf(v);
          yAxis+=`<line x1="${pad.l}" x2="${W-pad.r}" y1="${y}" y2="${y}" stroke="#e5e7eb" stroke-width="1"/>`;
          yAxis+=`<text x="${pad.l-4}" y="${y+4}" text-anchor="end" fill="#6b7280" font-size="9">${Math.round(v)}</text>`;
        }
        // 60% ref line
        const refY=yOf(Math.round(yMax*0.6));
        const refLine=`<line x1="${pad.l}" x2="${W-pad.r}" y1="${refY}" y2="${refY}" stroke="#dc2626" stroke-width="1" stroke-dasharray="4,3"/>
          <text x="${W-pad.r-2}" y="${refY-3}" text-anchor="end" fill="#dc2626" font-size="8">60% aprov.</text>`;
        // line path
        vals.forEach((v,i)=>{
          const x=xOf(i), y=yOf(v);
          path+=(i===0?`M${x},${y}`:`L${x},${y}`);
        });
        // colored dots
        vals.forEach((v,i)=>{
          const x=xOf(i), y=yOf(v);
          const res=results[i];
          const dotColor=res==='V'?'#16a34a':res==='E'?'#ca8a04':'#dc2626';
          dots+=`<circle cx="${x}" cy="${y}" r="5" fill="${dotColor}" stroke="#fff" stroke-width="1.5"/>`;
          dots+=`<text x="${x}" y="${y-8}" text-anchor="middle" fill="${dotColor}" font-size="8" font-weight="700">${v}</text>`;
        });
        // x labels (every 2nd if crowded)
        const step=Math.max(1,Math.ceil(labels.length/14));
        labels.forEach((l,i)=>{
          if(i%step!==0&&i!==labels.length-1)return;
          xLabels+=`<text x="${xOf(i)}" y="${H-4}" text-anchor="middle" fill="#6b7280" font-size="9">${esc(l)}</text>`;
        });
        // legend
        const legX=pad.l;
        const legend=`<circle cx="${legX+5}" cy="${H-2}" r="4" fill="#16a34a"/>
          <text x="${legX+12}" y="${H-0}" fill="#374151" font-size="8">Vitória</text>
          <circle cx="${legX+50}" cy="${H-2}" r="4" fill="#ca8a04"/>
          <text x="${legX+57}" y="${H-0}" fill="#374151" font-size="8">Empate</text>
          <circle cx="${legX+100}" cy="${H-2}" r="4" fill="#dc2626"/>
          <text x="${legX+107}" y="${H-0}" fill="#374151" font-size="8">Derrota</text>`;
        return`<svg width="${W}" height="${H+12}" xmlns="http://www.w3.org/2000/svg">
          ${yAxis}${refLine}
          <path d="${path}" fill="none" stroke="${color}" stroke-width="2" opacity="0.35"/>
          ${dots}${xLabels}${legend}
        </svg>`;
      }

      // ─── PAGE T1: PRIMEIRA FASE ───────────────────────────────────────────
      const _curvF1=buildCurvaPontos(jogosFase1,30,TC);
      const pageT1=`<section class="page" style="${PST}width:1122px;height:793px;">
        ${TS2}
        <div style="padding:14px 28px 0;">
          <div style="font-family:'Archivo',sans-serif;font-size:16px;font-weight:800;color:#111827;margin-bottom:8px;">1 · Primeira Fase — Fase de Grupos</div>
          <div style="margin-bottom:10px;">
            <div style="font-family:'Archivo',sans-serif;font-size:10px;font-weight:700;color:${TC};margin-bottom:4px;">CURVA DE PONTOS · máx. 30 pts</div>
            ${_curvF1}
          </div>
          <div style="overflow:auto;max-height:490px;">${buildGamesTable(jogosFase1)}</div>
        </div>
      </section>`;

      // ─── PAGE T2: SEGUNDA FASE ────────────────────────────────────────────
      const _curvF2=buildCurvaPontos(jogosFase2,24,'#1a56db');
      const pageT2=`<section class="page" style="${PST}width:1122px;height:793px;">
        ${TS2}
        <div style="padding:14px 28px 0;">
          <div style="font-family:'Archivo',sans-serif;font-size:16px;font-weight:800;color:#111827;margin-bottom:8px;">2 · Segunda Fase — Mata-mata</div>
          <div style="margin-bottom:10px;">
            <div style="font-family:'Archivo',sans-serif;font-size:10px;font-weight:700;color:#1a56db;margin-bottom:4px;">CURVA DE PONTOS · máx. 24 pts</div>
            ${_curvF2}
          </div>
          <div style="overflow:auto;max-height:490px;">${buildGamesTable(jogosFase2)}</div>
        </div>
      </section>`;

      // ─── PAGE T3: COMPARATIVO FASE 1 × FASE 2 ────────────────────────────
      const _worstKeys=new Set(['d','dp','golsCon','falta']);
      // Phase card builder
      const _phaseCard=(f,label,sublabel,color,borderColor)=>{
        const aprC=f.aprov>=60?'#16a34a':f.aprov>=45?'#ca8a04':'#dc2626';
        const nW=f.v+f.e+f.d||1;
        const vPct=Math.round(f.v/nW*100);
        const ePct=Math.round(f.e/nW*100);
        const dPct=100-vPct-ePct;
        const barW=320;
        const vW=Math.round(barW*f.v/nW),eW=Math.round(barW*f.e/nW),dW=barW-vW-eW;
        return`<div style="background:#fff;border:2px solid ${borderColor};border-radius:14px;padding:20px 24px;flex:1;">
          <div style="font-family:'Archivo',sans-serif;font-size:10px;font-weight:700;color:${color};letter-spacing:1.5px;text-transform:uppercase;margin-bottom:4px;">${sublabel}</div>
          <div style="font-family:'Archivo',sans-serif;font-size:22px;font-weight:900;color:#111827;margin-bottom:2px;">${label}</div>
          <div style="display:flex;gap:4px;align-items:center;margin-bottom:16px;">
            <span style="font-family:'Archivo',sans-serif;font-size:36px;font-weight:900;color:${aprC};line-height:1;">${f.aprov!=null?f.aprov+'%':'—'}</span>
            <span style="font-family:'Inter',sans-serif;font-size:11px;color:#6b7280;line-height:1.3;">aproveit.<br>${f.jogos} jogos</span>
          </div>
          <div style="display:flex;border-radius:6px;overflow:hidden;height:20px;margin-bottom:6px;">
            ${f.v>0?`<div style="width:${vW}px;background:#16a34a;display:flex;align-items:center;justify-content:center;font-family:'Archivo',sans-serif;font-size:10px;font-weight:700;color:#fff;">${f.v}V</div>`:''}
            ${f.e>0?`<div style="width:${eW}px;background:#ca8a04;display:flex;align-items:center;justify-content:center;font-family:'Archivo',sans-serif;font-size:10px;font-weight:700;color:#fff;">${f.e}E</div>`:''}
            ${f.d>0?`<div style="width:${dW}px;background:#dc2626;display:flex;align-items:center;justify-content:center;font-family:'Archivo',sans-serif;font-size:10px;font-weight:700;color:#fff;">${f.d}D</div>`:''}
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px;">
            <div style="background:#f0fdf4;border-radius:8px;padding:8px 10px;text-align:center;">
              <div style="font-family:'Archivo',sans-serif;font-size:20px;font-weight:800;color:#16a34a;">${f.golsPro}</div>
              <div style="font-family:'Inter',sans-serif;font-size:9px;color:#6b7280;">gols marcados</div>
            </div>
            <div style="background:#fef2f2;border-radius:8px;padding:8px 10px;text-align:center;">
              <div style="font-family:'Archivo',sans-serif;font-size:20px;font-weight:800;color:#dc2626;">${f.golsCon}</div>
              <div style="font-family:'Inter',sans-serif;font-size:9px;color:#6b7280;">gols sofridos</div>
            </div>
          </div>
          <div style="margin-top:10px;background:#f9fafb;border-radius:8px;padding:8px 12px;">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 8px;">
              ${[['Fin./jogo','fin'],['CC/jogo','cc'],['DG/jogo','dg'],['DP/jogo','dp'],['Faltas/jogo','falta'],['Rob./jogo','roubada']].map(([lbl,k])=>`<div style="display:flex;justify-content:space-between;align-items:center;padding:2px 0;border-bottom:1px solid #f3f4f6;"><span style="font-family:'Inter',sans-serif;font-size:9px;color:#6b7280;">${lbl}</span><span style="font-family:'Archivo',sans-serif;font-size:10px;font-weight:700;color:#374151;">${f[k]??'—'}</span></div>`).join('')}
            </div>
          </div>
        </div>`;
      };
      // Comparison bar rows
      const _compBarItems=[
        {label:'Aproveitamento',key:'aprov',unit:'%',max:100,worst:false,color:TC},
        {label:'Gols Marcados',key:'golsPro',unit:'',max:null,worst:false,color:'#16a34a'},
        {label:'Gols Sofridos',key:'golsCon',unit:'',max:null,worst:true,color:'#dc2626'},
        {label:'Saldo de Gols',key:'saldo',unit:'',max:null,worst:false,color:'#374151'},
        {label:'Finalizações / Jogo',key:'fin',unit:'',max:null,worst:false,color:'#1a56db'},
        {label:'Chances Claras / Jogo',key:'cc',unit:'',max:null,worst:false,color:'#0ea5e9'},
        {label:'Duelos Ganhos / Jogo',key:'dg',unit:'',max:null,worst:false,color:'#16a34a'},
        {label:'Duelos Perdidos / Jogo',key:'dp',unit:'',max:null,worst:true,color:'#dc2626'},
        {label:'Faltas / Jogo',key:'falta',unit:'',max:null,worst:true,color:'#f97316'},
        {label:'Roubadas / Jogo',key:'roubada',unit:'',max:null,worst:false,color:'#7c3aed'},
      ];
      const _compBarHeader=`<div style="display:grid;grid-template-columns:160px 1fr 60px 60px 1fr;gap:4px;align-items:center;padding:4px 0 6px;border-bottom:2px solid #e5e7eb;margin-bottom:2px;">
        <div></div>
        <div style="text-align:right;padding-right:4px;"><span style="display:inline-flex;align-items:center;gap:3px;font-family:'Archivo',sans-serif;font-size:9px;font-weight:700;color:${TC};"><span style="display:inline-block;width:8px;height:8px;background:${TC};border-radius:2px;"></span>1ª Fase</span></div>
        <div style="text-align:center;font-family:'Archivo',sans-serif;font-size:9px;font-weight:700;color:${TC};">F1</div>
        <div style="text-align:center;font-family:'Archivo',sans-serif;font-size:9px;font-weight:700;color:#1a56db;">F2</div>
        <div style="padding-left:4px;"><span style="display:inline-flex;align-items:center;gap:3px;font-family:'Archivo',sans-serif;font-size:9px;font-weight:700;color:#1a56db;"><span style="display:inline-block;width:8px;height:8px;background:#1a56db;border-radius:2px;"></span>2ª Fase</span></div>
      </div>`;
      const _compBarRows=_compBarItems.map(({label,key,unit,worst,color},i)=>{
        const v1=f1[key]??null, v2=f2[key]??null;
        const maxV=Math.max(+v1||0,+v2||0)||1;
        const pct1=v1!=null?Math.round(+v1/maxV*100):0;
        const pct2=v2!=null?Math.round(+v2/maxV*100):0;
        const better1=v1!=null&&v2!=null&&(worst?+v1<+v2:+v1>+v2);
        const better2=v1!=null&&v2!=null&&(worst?+v2<+v1:+v2>+v1);
        const tie=v1!=null&&v2!=null&&+v1===+v2;
        return`<div style="display:grid;grid-template-columns:160px 1fr 60px 60px 1fr;gap:4px;align-items:center;padding:5px 0;border-bottom:1px solid #f3f4f6;">
          <div style="font-family:'Inter',sans-serif;font-size:10px;color:#374151;text-align:right;padding-right:8px;">${label}</div>
          <div style="display:flex;justify-content:flex-end;"><div style="background:${better1?TC:'#e5e7eb'};height:14px;width:${pct1}%;border-radius:3px 0 0 3px;min-width:${v1!=null&&+v1>0?3:0}px;"></div></div>
          <div style="text-align:center;font-family:'Archivo',sans-serif;font-size:11px;font-weight:800;color:${better1?TC:tie?'#374151':'#9ca3af'};">${v1!=null?v1+unit:'—'}</div>
          <div style="text-align:center;font-family:'Archivo',sans-serif;font-size:11px;font-weight:800;color:${better2?'#1a56db':tie?'#374151':'#9ca3af'};">${v2!=null?v2+unit:'—'}</div>
          <div><div style="background:${better2?'#1a56db':'#e5e7eb'};height:14px;width:${pct2}%;border-radius:0 3px 3px 0;min-width:${v2!=null&&+v2>0?3:0}px;"></div></div>
        </div>`;
      }).join('');
      // Legends for indicators
      const _indicLegend=`<div style="margin-top:6px;padding:6px 10px;background:#f8fafc;border-radius:6px;border:1px solid #e2e8f0;font-family:'Inter',sans-serif;font-size:8px;color:#6b7280;display:flex;flex-wrap:wrap;gap:4px 14px;">
        <span><b style="color:#374151;">Fin.</b> = Finalizações</span>
        <span><b style="color:#374151;">CC</b> = Chances Claras criadas</span>
        <span><b style="color:#374151;">DG</b> = Duelos Ganhos</span>
        <span><b style="color:#374151;">DP</b> = Duelos Perdidos</span>
        <span><b style="color:#374151;">Rob.</b> = Roubadas de bola</span>
        <span>Todos expressos por jogo</span>
        <span><b style="color:#374151;">Aproveitamento</b> = (V×3 + E) ÷ (Jogos×3) × 100</span>
      </div>`;

      const pageT3=`<section class="page" style="${PST}width:1122px;height:793px;">
        ${TS2}
        <div style="padding:10px 28px 0;">
          <div style="font-family:'Archivo',sans-serif;font-size:16px;font-weight:800;color:#111827;margin-bottom:10px;">3 · Números Primeira × Segunda Fase</div>
          ${jogosFase2.length===0?`<div style="font-family:'Inter',sans-serif;font-size:12px;color:#9ca3af;background:#f9fafb;border-radius:8px;padding:24px;text-align:center;">Defina a data de início da Fase 2 para ver o comparativo</div>`:`
          <div style="display:flex;gap:12px;margin-bottom:10px;">
            ${_phaseCard(f1,'Fase de Grupos','1ª Fase — Grupos',TC,TC)}
            ${_phaseCard(f2,'Mata-mata','2ª Fase — Eliminatórias','#1a56db','#1a56db')}
          </div>
          <div>
            <div style="font-family:'Archivo',sans-serif;font-size:11px;font-weight:700;color:#374151;margin-bottom:4px;">Comparativo de Métricas</div>
            <div style="font-family:'Inter',sans-serif;font-size:8px;color:#6b7280;margin-bottom:4px;">Barra colorida = fase com melhor resultado · valor em destaque = vencedor da métrica · vermelho = pior resultado</div>
            ${_compBarHeader}
            ${_compBarRows}
            ${_indicLegend}
          </div>`}
        </div>
      </section>`;

      // ─── PAGE T4: MEDICINA E PERFORMANCE ─────────────────────────────────
      // Availability per athlete across all games
      const _dispRows=atletasAtivosArr.map(a=>({
        nome:a.nome,pos:a.posicao||'—',
        disp:atlAvail[a.id]??null,
        lesoes:docLesoes.filter(d=>d.athleteId===a.id).length,
        jogos:atlJogos[a.id]||0,
      })).sort((a,b)=>(b.disp??-1)-(a.disp??-1));
      let _dispRowsHtml='';
      _dispRows.forEach((r,i)=>{
        const dc=r.disp>=85?'#16a34a':r.disp>=70?'#ca8a04':'#dc2626';
        const lc=r.lesoes>2?'#dc2626':r.lesoes>0?'#f97316':'#16a34a';
        _dispRowsHtml+=`<tr style="background:${i%2?'#fafafa':'#fff'};">
          <td style="padding:4px 7px;font-family:'Inter',sans-serif;font-size:9px;font-weight:600;color:#111827;">${esc(r.nome)}</td>
          <td style="padding:4px 7px;font-family:'Inter',sans-serif;font-size:9px;color:#6b7280;">${esc(r.pos)}</td>
          <td style="padding:4px 7px;text-align:center;font-family:'Archivo',sans-serif;font-size:10px;font-weight:800;color:${dc};">${r.disp!=null?r.disp+'%':'—'}</td>
          <td style="padding:4px 7px;text-align:center;font-family:'Archivo',sans-serif;font-size:10px;font-weight:800;color:${lc};">${r.lesoes}</td>
          <td style="padding:4px 7px;text-align:center;font-family:'Archivo',sans-serif;font-size:10px;font-weight:700;color:#374151;">${r.jogos||'—'}</td>
        </tr>`;
      });
      const pageT4=`<section class="page" style="${PST}width:1122px;height:793px;">
        ${TS2}
        <div style="padding:12px 28px 0;">
          <div style="font-family:'Archivo',sans-serif;font-size:16px;font-weight:800;color:#111827;margin-bottom:10px;">5 · Departamento de Medicina Esportiva e Performance</div>
          <div style="display:grid;grid-template-columns:320px 1fr 1fr;gap:14px;align-items:start;">

            <!-- COL 1: Resumo + Contexto + Tipos -->
            <div>
              <div style="font-family:'Archivo',sans-serif;font-size:11px;font-weight:700;color:#dc2626;margin-bottom:8px;border-bottom:2px solid #dc2626;padding-bottom:3px;">Resumo de Lesões</div>
              ${totalLesoes===0?`<div style="background:#f0fdf4;border-radius:8px;padding:14px;text-align:center;font-family:'Inter',sans-serif;font-size:11px;color:#16a34a;font-weight:600;">Nenhuma lesão registrada</div>`:`
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:10px;">
                ${KPIT('Total',totalLesoes,'casos','#dc2626')}
                ${KPIT('Média/Lesão',mediaDiasPorLesao??'—','dias afastado','#f97316')}
              </div>
              <div style="display:grid;grid-template-columns:1fr 1fr 1fr${lesSemInfo>0?' 1fr':''};gap:5px;margin-bottom:10px;">
                <div style="background:#fef2f2;border-radius:6px;padding:8px;text-align:center;"><div style="font-size:22px;font-weight:800;color:#dc2626;font-family:'Archivo',sans-serif;">${lesGrave}</div><div style="font-size:8px;color:#6b7280;margin-top:2px;">Grave<br>&gt;28d</div></div>
                <div style="background:#fff7ed;border-radius:6px;padding:8px;text-align:center;"><div style="font-size:22px;font-weight:800;color:#f97316;font-family:'Archivo',sans-serif;">${lesMod}</div><div style="font-size:8px;color:#6b7280;margin-top:2px;">Moderada<br>8-28d</div></div>
                <div style="background:#f0fdf4;border-radius:6px;padding:8px;text-align:center;"><div style="font-size:22px;font-weight:800;color:#16a34a;font-family:'Archivo',sans-serif;">${lesLeve}</div><div style="font-size:8px;color:#6b7280;margin-top:2px;">Leve<br>≤7d</div></div>
                ${lesSemInfo>0?`<div style="background:#f9fafb;border-radius:6px;padding:8px;text-align:center;"><div style="font-size:22px;font-weight:800;color:#9ca3af;font-family:'Archivo',sans-serif;">${lesSemInfo}</div><div style="font-size:8px;color:#6b7280;margin-top:2px;">Sem<br>info</div></div>`:''}
              </div>
              <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:10px 12px;margin-bottom:10px;">
                <div style="font-family:'Archivo',sans-serif;font-size:10px;font-weight:700;color:#c2410c;margin-bottom:8px;">Contexto das Lesões</div>
                <div style="display:flex;gap:6px;margin-bottom:4px;">
                  <div style="flex:1;text-align:center;background:#fff;border-radius:5px;padding:6px;"><div style="font-family:'Archivo',sans-serif;font-size:16px;font-weight:800;color:#f97316;">${ctxTreino}</div><div style="font-size:8px;color:#6b7280;">Em Treino</div></div>
                  <div style="flex:1;text-align:center;background:#fff;border-radius:5px;padding:6px;"><div style="font-family:'Archivo',sans-serif;font-size:16px;font-weight:800;color:#dc2626;">${ctxJogo}</div><div style="font-size:8px;color:#6b7280;">Em Jogo</div></div>
                  <div style="flex:1;text-align:center;background:#fff;border-radius:5px;padding:6px;"><div style="font-family:'Archivo',sans-serif;font-size:16px;font-weight:800;color:#9ca3af;">${ctxSemInfo}</div><div style="font-size:8px;color:#6b7280;">Sem info</div></div>
                </div>
              </div>
              ${tipoPieData.length>0?`<div style="font-family:'Archivo',sans-serif;font-size:10px;font-weight:700;color:#c2410c;margin-bottom:8px;">Tipos de Lesão</div>
              ${tipoPieData.map(d=>{const pct=Math.round(d.value/totalLesoes*100);return`<div style="margin-bottom:7px;"><div style="display:flex;justify-content:space-between;margin-bottom:2px;"><span style="font-family:'Inter',sans-serif;font-size:8.5px;color:#374151;">${d.label}</span><span style="font-family:'Inter',sans-serif;font-size:9px;font-weight:700;color:${d.color};">${d.value} (${pct}%)</span></div><div style="background:#f3f4f6;border-radius:3px;height:9px;overflow:hidden;"><div style="background:${d.color};height:100%;width:${pct}%;"></div></div></div>`;}).join('')}`:''}
              `}
            </div>

            <!-- COL 2: Registros de lesão -->
            <div>
              <div style="font-family:'Archivo',sans-serif;font-size:11px;font-weight:700;color:#dc2626;margin-bottom:8px;border-bottom:2px solid #dc2626;padding-bottom:3px;">Registros de Lesão</div>
              ${totalLesoes===0?`<div style="font-family:'Inter',sans-serif;font-size:11px;color:#16a34a;padding:16px;text-align:center;background:#f0fdf4;border-radius:8px;">Nenhuma lesão registrada</div>`:
              `<table style="width:100%;border-collapse:collapse;font-family:'Inter',sans-serif;font-size:8px;">
                <thead><tr style="background:#fee2e2;">
                  <th style="padding:4px 5px;border:1px solid #fecaca;color:#991b1b;font-weight:700;text-align:left;">Atleta</th>
                  <th style="padding:4px 5px;border:1px solid #fecaca;color:#991b1b;font-weight:700;">Grav.</th>
                  <th style="padding:4px 5px;border:1px solid #fecaca;color:#991b1b;font-weight:700;">Tipo</th>
                  <th style="padding:4px 5px;border:1px solid #fecaca;color:#991b1b;font-weight:700;">Região</th>
                  <th style="padding:4px 5px;border:1px solid #fecaca;color:#991b1b;font-weight:700;text-align:center;">Data</th>
                  <th style="padding:4px 5px;border:1px solid #fecaca;color:#991b1b;font-weight:700;text-align:center;">Dias</th>
                  <th style="padding:4px 5px;border:1px solid #fecaca;color:#991b1b;font-weight:700;">Status</th>
                </tr></thead>
                <tbody>${_lesAllRows}</tbody>
              </table>`}
            </div>

            <!-- COL 3: Disponibilidade por atleta -->
            <div>
              <div style="font-family:'Archivo',sans-serif;font-size:11px;font-weight:700;color:${TC};margin-bottom:8px;border-bottom:2px solid ${TC};padding-bottom:3px;">Disponibilidade por Atleta</div>
              <table style="width:100%;border-collapse:collapse;font-family:'Inter',sans-serif;font-size:9px;">
                <thead><tr style="background:#f9fafb;">
                  <th style="padding:5px 7px;text-align:left;color:${TC};font-weight:700;">Atleta</th>
                  <th style="padding:5px 7px;text-align:left;color:${TC};font-weight:700;">Posição</th>
                  <th style="padding:5px 7px;text-align:center;color:${TC};font-weight:700;">Disp.%</th>
                  <th style="padding:5px 7px;text-align:center;color:${TC};font-weight:700;">Lesões</th>
                  <th style="padding:5px 7px;text-align:center;color:${TC};font-weight:700;">Jogos</th>
                </tr></thead>
                <tbody>${_dispRowsHtml}</tbody>
              </table>
            </div>

          </div>
        </div>
      </section>`;

      // ─── PAGE T5A: ELENCO — MINUTAGEM ────────────────────────────────────
      const pageT5a=`<section class="page" style="${PST}width:1122px;height:793px;">
        ${TS2}
        <div style="padding:14px 28px 0;">
          <div style="font-family:'Archivo',sans-serif;font-size:16px;font-weight:800;color:#111827;margin-bottom:10px;">6A · Elenco — Minutagem e Participação</div>
          ${minsRows.length===0?`<div style="font-family:'Inter',sans-serif;font-size:13px;color:#6b7280;background:#f9fafb;border-radius:8px;padding:24px;text-align:center;">Sem dados de partidas</div>`:`
          <div style="overflow:auto;max-height:700px;">
            <table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;">
              <thead><tr style="background:${TC};color:#fff;position:sticky;top:0;">
                <th style="padding:7px 10px;text-align:left;font-family:'Inter',sans-serif;font-weight:600;font-size:10px;">Atleta</th>
                <th style="padding:7px 10px;text-align:left;font-family:'Inter',sans-serif;font-weight:600;font-size:10px;">Posição</th>
                <th style="padding:7px 10px;text-align:center;font-family:'Inter',sans-serif;font-weight:600;font-size:10px;">Jogos</th>
                <th style="padding:7px 10px;text-align:center;font-family:'Inter',sans-serif;font-weight:600;font-size:10px;">Minutos</th>
                <th style="padding:7px 10px;text-align:center;font-family:'Inter',sans-serif;font-weight:600;font-size:10px;">Gols</th>
                <th style="padding:7px 10px;text-align:center;font-family:'Inter',sans-serif;font-weight:600;font-size:10px;">Assist.</th>
                <th style="padding:7px 10px;text-align:center;font-family:'Inter',sans-serif;font-weight:600;font-size:10px;">Def. Dif.</th>
                <th style="padding:7px 10px;text-align:center;font-family:'Inter',sans-serif;font-weight:600;font-size:10px;">Fin.</th>
                <th style="padding:7px 10px;text-align:center;font-family:'Inter',sans-serif;font-weight:600;font-size:10px;">DG</th>
                <th style="padding:7px 10px;text-align:center;font-family:'Inter',sans-serif;font-weight:600;font-size:10px;">DP</th>
                <th style="padding:7px 10px;text-align:center;font-family:'Inter',sans-serif;font-weight:600;font-size:10px;">IGP</th>
              </tr></thead>
              <tbody>${minsTableRows}</tbody>
            </table>
          </div>`}
        </div>
      </section>`;

      // ─── PAGE T5B: RANKINGS TOP 10 ────────────────────────────────────────
      const _rankCard=(icon,title,items)=>{
        const rows=items.length?items.map(l=>`<div style="font-family:'Inter',sans-serif;font-size:10px;color:#374151;padding:3px 0;border-bottom:1px solid #f3f4f6;">${esc(l)}</div>`).join(''):`<div style="font-family:'Inter',sans-serif;font-size:10px;color:#9ca3af;font-style:italic;padding:4px 0;">Sem dados suficientes</div>`;
        return`<div style="background:#f8faff;border:1px solid #dbeafe;border-radius:10px;padding:14px 16px;">
          <div style="font-family:'Archivo',sans-serif;font-size:11px;font-weight:700;color:${TC};margin-bottom:8px;">${icon} ${title}</div>
          ${rows}
        </div>`;
      };
      const pageT5b=`<section class="page" style="${PST}width:1122px;height:793px;">
        ${TS2}
        <div style="padding:14px 28px 0;">
          <div style="font-family:'Archivo',sans-serif;font-size:16px;font-weight:800;color:#111827;margin-bottom:14px;">6B · Rankings — Top 10 por Métrica</div>
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:14px;">
            ${_rankCard('⚽','Top 10 Artilheiros',top10Atleta(atlGols,'maior',v=>v+' gols'))}
            ${_rankCard('🅰️','Top 10 Assistências',top10Atleta(atlAssist,'maior',v=>v+' assist.'))}
            ${_rankCard('🔗','Top 10 Participações em Gol (G+A)',top10Atleta(atlPartGols,'maior',v=>v+' G+A'))}
            ${_rankCard('🥅','Top 10 Finalizações',top10Atleta(atlFin,'maior',v=>v+' fin.'))}
            ${_rankCard('🫳','Top 10 Roubadas de Bola',top10Atleta(atlRoubada,'maior',v=>v+' rob.'))}
            ${_rankCard('🛡','Top 10 Duelos Ganhos',top10Atleta(atlDG,'maior',v=>v+' DG'))}
          </div>
        </div>
      </section>`;

      // ─── SHARED: helpers e dados seção 6 ─────────────────────────────────
      const _totAcoesSetor={};
      setores.forEach(s=>{_totAcoesSetor[s]=setorBlocoData[s].reduce((sum,c)=>sum+c.acoes,0);});
      const _totAcoesAll=Object.values(_totAcoesSetor).reduce((s,v)=>s+v,0)||1;
      const _pctAtk=Math.round((_totAcoesSetor['ataque']||0)/_totAcoesAll*100);
      const _pctMeio=Math.round((_totAcoesSetor['meio']||0)/_totAcoesAll*100);
      const _pctDef=Math.round((_totAcoesSetor['defesa']||0)/_totAcoesAll*100);
      const _faltaSetor={};
      setores.forEach(s=>{_faltaSetor[s]=setorBlocoData[s].reduce((sum,c)=>sum+c.falta,0);});
      const _faltaTot=Object.values(_faltaSetor).reduce((s,v)=>s+v,0)||1;
      const _roubTot=setores.reduce((s,sec)=>{const r=setorRoubadaTotals[sec]||{};return s+(r.po||0)+(r.pp||0)+(r.cb||0);},0)||1;
      const _noScout=`<div style="font-family:'Inter',sans-serif;font-size:13px;color:#6b7280;background:#f9fafb;border-radius:8px;padding:40px;text-align:center;">Dados de scout não disponíveis</div>`;

      // ─── Posse 5 min (smooth line) ────────────────────────────────────────
      const setorAtkPct5min=(()=>{
        const nB=18,bSec=300;
        const atkSum=Array(nB).fill(0),totSum=Array(nB).fill(0);
        if(!allEvents.some(e=>e.action==='Troca de setor'))return null;
        partidasFiltradas.forEach(p=>{
          const evs=(eventsMap[p.id]||[]).filter(e=>e.action==='Troca de setor').sort((a,b)=>(a.seconds??0)-(b.seconds??0));
          if(!evs.length)return;
          const ivs=[];let cSec='meio',cStart=0;
          const dur=Math.max(...evs.map(e=>e.seconds??0),5400);
          evs.forEach(ev=>{const t=Math.min(ev.seconds??0,dur);if(t>cStart)ivs.push([cStart,t,cSec]);cSec=ev.meta?.para??cSec;cStart=t;});
          if(cStart<dur)ivs.push([cStart,dur,cSec]);
          for(let b=0;b<nB;b++){const bs=b*bSec,be=(b+1)*bSec;for(const[s,e,sec]of ivs){const ov=Math.min(e,be)-Math.max(s,bs);if(ov>0){totSum[b]+=ov;if(sec==='ataque')atkSum[b]+=ov;}}}
        });
        return atkSum.map((a,b)=>totSum[b]>0?Math.round(a/totSum[b]*100):null);
      })();

      // ─── Per-phase scout aggregates ───────────────────────────────────────
      const _computeSetorStats=(events)=>{
        const _s=['defesa','meio','ataque'];
        const _bd={};
        _s.forEach(s=>{_bd[s]=Array.from({length:6},()=>({fin:0,cc:0,dg:0,dp:0,falta:0,acoes:0,roubadaPO:0,roubadaPP:0,roubadaCB:0}));});
        events.forEach(ev=>{
          const sec=(ev.sector||'').toLowerCase();
          if(!_s.includes(sec))return;
          const b=getBloco15(ev);
          const cell=_bd[sec][b];
          const a=ev.action||'';
          cell.acoes++;
          if(a==='Finalização')cell.fin++;
          if(a==='Chance clara criada')cell.cc++;
          if(a.startsWith('Duelo ganho'))cell.dg++;
          if(a.startsWith('Duelo perdido'))cell.dp++;
          if(a==='Falta')cell.falta++;
          if(a==='Roubada (pressão ofensiva)')cell.roubadaPO++;
          if(a==='Roubada (pós-perda)')cell.roubadaPP++;
          if(a==='Roubada (combate)')cell.roubadaCB++;
        });
        const _dt={},_rt={},_ta={};
        _s.forEach(s=>{
          const cells=_bd[s];
          _dt[s]={dg:cells.reduce((a,c)=>a+c.dg,0),dp:cells.reduce((a,c)=>a+c.dp,0)};
          _rt[s]={po:cells.reduce((a,c)=>a+c.roubadaPO,0),pp:cells.reduce((a,c)=>a+c.roubadaPP,0),cb:cells.reduce((a,c)=>a+c.roubadaCB,0)};
          _ta[s]=cells.reduce((a,c)=>a+c.acoes,0);
        });
        return{bd:_bd,dt:_dt,rt:_rt,ta:_ta};
      };
      const _f1Ids=new Set(jogosFase1.map(g=>g.id));
      const _f2Ids=new Set(jogosFase2.map(g=>g.id));
      const _evF1=allEvents.filter(ev=>_f1Ids.has(ev._gameId));
      const _evF2=allEvents.filter(ev=>_f2Ids.has(ev._gameId));
      const _ss1=_computeSetorStats(_evF1);
      const _ss2=_computeSetorStats(_evF2);
      const _totAllF1=Object.values(_ss1.ta).reduce((s,v)=>s+v,0)||1;
      const _totAllF2=Object.values(_ss2.ta).reduce((s,v)=>s+v,0)||1;
      const _roubTotF1=setores.reduce((s,sec)=>{const r=_ss1.rt[sec]||{};return s+(r.po||0)+(r.pp||0)+(r.cb||0);},0)||1;
      const _roubTotF2=setores.reduce((s,sec)=>{const r=_ss2.rt[sec]||{};return s+(r.po||0)+(r.pp||0)+(r.cb||0);},0)||1;
      const _faltaF1={},_faltaF2={};
      setores.forEach(s=>{_faltaF1[s]=_ss1.bd[s].reduce((sum,c)=>sum+c.falta,0);_faltaF2[s]=_ss2.bd[s].reduce((sum,c)=>sum+c.falta,0);});
      const _faltaTotF1=Object.values(_faltaF1).reduce((s,v)=>s+v,0)||1;
      const _faltaTotF2=Object.values(_faltaF2).reduce((s,v)=>s+v,0)||1;
      const _finF1=_evF1.filter(e=>e.action==='Finalização').length;
      const _finF2=_evF2.filter(e=>e.action==='Finalização').length;
      const _finAdvF1=_evF1.filter(e=>e.action==='Finalização adversária').length;
      const _finAdvF2=_evF2.filter(e=>e.action==='Finalização adversária').length;
      const _golsF1=_evF1.filter(e=>e.action==='Gol Pró').length;
      const _golsF2=_evF2.filter(e=>e.action==='Gol Pró').length;
      const _convF1=_finF1>0?Math.round(_golsF1/_finF1*100):null;
      const _convF2=_finF2>0?Math.round(_golsF2/_finF2*100):null;
      const _nF1=jogosFase1.length||1, _nF2=jogosFase2.length||1;
      // Entradas no ataque por fase (derivadas de Troca de setor, não de allEvents)
      const _eaF1=entradaAtaque.filter(e=>_f1Ids.has(e.gameId));
      const _eaF2=entradaAtaque.filter(e=>_f2Ids.has(e.gameId));
      // Divisor: apenas jogos com dados de scout (tem pelo menos 1 evento)
      const _nF1Sc=new Set(_evF1.map(e=>e._gameId)).size||1;
      const _nF2Sc=new Set(_evF2.map(e=>e._gameId)).size||1;

      // ─── Shared phase-split header helper ─────────────────────────────────
      const _phaseBar=(label,v1,v2,c1=TC,c2='#1a56db')=>{
        const _pn=v=>{const n=parseFloat(v);return isNaN(n)?0:n;};
        const m=Math.max(_pn(v1),_pn(v2))||1;
        const p1=Math.round(_pn(v1)/m*100), p2=Math.round(_pn(v2)/m*100);
        return`<div style="margin-bottom:8px;">
          <div style="font-family:'Inter',sans-serif;font-size:9px;color:#6b7280;margin-bottom:3px;">${label}</div>
          <div style="display:flex;align-items:center;gap:6px;">
            <span style="font-family:'Archivo',sans-serif;font-size:11px;font-weight:800;color:${c1};min-width:32px;text-align:right;">${v1}</span>
            <div style="flex:1;background:#f3f4f6;border-radius:4px;height:10px;overflow:hidden;display:flex;">
              <div style="background:${c1};width:${p1}%;opacity:0.85;"></div>
            </div>
            <div style="flex:1;background:#f3f4f6;border-radius:4px;height:10px;overflow:hidden;display:flex;flex-direction:row-reverse;">
              <div style="background:${c2};width:${p2}%;opacity:0.85;"></div>
            </div>
            <span style="font-family:'Archivo',sans-serif;font-size:11px;font-weight:800;color:${c2};min-width:32px;">${v2}</span>
          </div>
        </div>`;
      };
      const _phaseSep=(title)=>`<div style="border-top:2px solid #f3f4f6;margin-top:12px;padding-top:10px;display:flex;align-items:center;gap:10px;margin-bottom:8px;">
        <div style="font-family:'Archivo',sans-serif;font-size:11px;font-weight:700;color:#374151;">${title}</div>
        <div style="display:flex;gap:8px;align-items:center;">
          <span style="display:inline-flex;align-items:center;gap:3px;font-size:9px;color:${TC};font-family:'Inter',sans-serif;font-weight:600;"><span style="width:8px;height:8px;background:${TC};border-radius:2px;display:inline-block;"></span>Grupos (${jogosFase1.length}J)</span>
          <span style="display:inline-flex;align-items:center;gap:3px;font-size:9px;color:#1a56db;font-family:'Inter',sans-serif;font-weight:600;"><span style="width:8px;height:8px;background:#1a56db;border-radius:2px;display:inline-block;"></span>Eliminatória (${jogosFase2.length}J)</span>
        </div>
      </div>`;
      const _scaledCampoDuelos=svgCampoDuelos(setorDuelTotals).replace(/width="966"\s*height="420"/,'viewBox="0 0 966 420" width="800" height="348"');
      const _scaledCampoRoubadas=svgCampoRoubadas(setorRoubadaTotals).replace(/width="966"\s*height="420"/,'viewBox="0 0 966 420" width="800" height="348"');
      const _scaledCampoFin=svgCampoFinalizacoes(allEvents,nJ).replace(/width="966"\s*height="420"/,'viewBox="0 0 966 420" width="800" height="348"');

      // ─── PAGE T6A: POSSE DE BOLA POR SETOR ────────────────────────────────
      const pageT6a=`<section class="page" style="${PST}width:1122px;height:793px;">
        ${TS2}
        <div style="padding:12px 28px 0;">
          <div style="font-family:'Archivo',sans-serif;font-size:16px;font-weight:800;color:#111827;margin-bottom:10px;">7A · Posse de Bola por Setor</div>
          ${allEvents.length===0?_noScout:`
          <!-- Total: 3 cards grandes -->
          <div style="display:flex;gap:14px;margin-bottom:12px;">
            <div style="flex:1;background:#eff6ff;border-radius:12px;padding:16px;text-align:center;">
              <div style="font-size:48px;font-weight:900;color:#1a56db;font-family:'Archivo',sans-serif;line-height:1;">${_pctAtk}%</div>
              <div style="font-size:12px;color:#374151;margin-top:6px;font-weight:700;">Setor de Ataque</div>
              <div style="font-size:10px;color:#6b7280;margin-top:2px;">${_totAcoesSetor['ataque']||0} ações</div>
            </div>
            <div style="flex:1;background:#f3f4f6;border-radius:12px;padding:16px;text-align:center;">
              <div style="font-size:48px;font-weight:900;color:#374151;font-family:'Archivo',sans-serif;line-height:1;">${_pctMeio}%</div>
              <div style="font-size:12px;color:#374151;margin-top:6px;font-weight:700;">Setor de Meio-Campo</div>
              <div style="font-size:10px;color:#6b7280;margin-top:2px;">${_totAcoesSetor['meio']||0} ações</div>
            </div>
            <div style="flex:1;background:#fef2f2;border-radius:12px;padding:16px;text-align:center;">
              <div style="font-size:48px;font-weight:900;color:#dc2626;font-family:'Archivo',sans-serif;line-height:1;">${_pctDef}%</div>
              <div style="font-size:12px;color:#374151;margin-top:6px;font-weight:700;">Setor de Defesa</div>
              <div style="font-size:10px;color:#6b7280;margin-top:2px;">${_totAcoesSetor['defesa']||0} ações</div>
            </div>
          </div>
          <!-- Timeline total - linha suave a cada 5 min -->
          <div style="background:#f8faff;border:1px solid #dbeafe;border-radius:8px;padding:10px 14px;margin-bottom:8px;">
            <div style="font-family:'Archivo',sans-serif;font-size:11px;font-weight:700;color:#1a56db;margin-bottom:4px;">% Tempo no Setor de Ataque — por bloco de 5 minutos (média da temporada)</div>
            <div style="font-family:'Inter',sans-serif;font-size:9px;color:#6b7280;margin-bottom:6px;">Linha tracejada = 45% (equilíbrio). Acima = maior posse no setor de ataque.</div>
            ${setorAtkPct5min?svgSetorAtaqueSmoothLine(setorAtkPct5min,{w:1050,h:130}):`<div style="font-family:'Inter',sans-serif;font-size:10px;color:#9ca3af;padding:16px;text-align:center;">Sem eventos de troca de setor registrados</div>`}
          </div>
          <!-- Split Fase -->
          ${_phaseSep('Por Fase — Posse de Bola')}
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">
            <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:10px 14px;">
              <div style="font-family:'Archivo',sans-serif;font-size:10px;font-weight:700;color:${TC};margin-bottom:8px;">■ Fase de Grupos (${jogosFase1.length} jogos)</div>
              <div style="display:flex;gap:6px;">
                ${setores.map(s=>{const t=_ss1.ta[s]||0,a=_totAllF1,p=Math.round(t/a*100);return`<div style="flex:1;background:#fff;border-radius:6px;padding:8px;text-align:center;border:1px solid #d1fae5;"><div style="font-size:22px;font-weight:800;color:${s==='ataque'?'#1a56db':s==='defesa'?'#dc2626':'#374151'};font-family:'Archivo',sans-serif;">${p}%</div><div style="font-size:8px;color:#6b7280;margin-top:2px;">${s.charAt(0).toUpperCase()+s.slice(1)}</div><div style="font-size:8px;color:#9ca3af;">${t} ações</div></div>`;}).join('')}
              </div>
            </div>
            <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:10px 14px;">
              <div style="font-family:'Archivo',sans-serif;font-size:10px;font-weight:700;color:#1a56db;margin-bottom:8px;">■ Fase Eliminatória (${jogosFase2.length} jogos)</div>
              <div style="display:flex;gap:6px;">
                ${setores.map(s=>{const t=_ss2.ta[s]||0,a=_totAllF2,p=Math.round(t/a*100);return`<div style="flex:1;background:#fff;border-radius:6px;padding:8px;text-align:center;border:1px solid #bfdbfe;"><div style="font-size:22px;font-weight:800;color:${s==='ataque'?'#1a56db':s==='defesa'?'#dc2626':'#374151'};font-family:'Archivo',sans-serif;">${p}%</div><div style="font-size:8px;color:#6b7280;margin-top:2px;">${s.charAt(0).toUpperCase()+s.slice(1)}</div><div style="font-size:8px;color:#9ca3af;">${t} ações</div></div>`;}).join('')}
              </div>
            </div>
          </div>`}
        </div>
      </section>`;

      // ─── PAGE T6B: DUELOS POR SETOR ────────────────────────────────────────
      const pageT6b=`<section class="page" style="${PST}width:1122px;height:793px;">
        ${TS2}
        <div style="padding:12px 28px 0;">
          <div style="font-family:'Archivo',sans-serif;font-size:16px;font-weight:800;color:#111827;margin-bottom:10px;">7B · Duelos por Setor</div>
          ${allEvents.length===0?_noScout:`
          <!-- Total: cards + campo -->
          <div style="display:flex;gap:14px;margin-bottom:10px;">
            ${setores.map(s=>{const dg=setorDuelTotals[s]?.dg||0,dp=setorDuelTotals[s]?.dp||0,tot=dg+dp||1,pct=Math.round(dg/tot*100);return`<div style="flex:1;background:#f9fafb;border:2px solid ${pct>=50?'#bbf7d0':'#fecaca'};border-radius:12px;padding:14px;text-align:center;"><div style="font-family:'Archivo',sans-serif;font-size:12px;font-weight:700;color:#374151;margin-bottom:6px;">${s.charAt(0).toUpperCase()+s.slice(1)}</div><div style="font-size:40px;font-weight:900;color:${pct>=50?'#16a34a':'#dc2626'};font-family:'Archivo',sans-serif;line-height:1;">${pct}%</div><div style="font-size:9px;color:#6b7280;margin-top:4px;">duelos ganhos</div><div style="display:flex;gap:6px;margin-top:8px;justify-content:center;"><span style="font-size:11px;color:#16a34a;font-weight:700;">${dg}DG</span><span style="font-size:11px;color:#6b7280;">·</span><span style="font-size:11px;color:#dc2626;font-weight:700;">${dp}DP</span></div></div>`;}).join('')}
          </div>
          <div style="margin-bottom:6px;">
            <div style="font-family:'Inter',sans-serif;font-size:9px;color:#6b7280;margin-bottom:4px;text-align:center;"><span style="display:inline-flex;align-items:center;gap:6px;"><span style="width:10px;height:10px;background:#3b82f6;border-radius:50%;display:inline-block;"></span>Duelos Ganhos &nbsp;<span style="width:10px;height:10px;background:#f87171;border-radius:50%;display:inline-block;"></span>Duelos Perdidos &nbsp;— tamanho proporcional à quantidade por setor</span></div>
            <div style="text-align:center;">${_scaledCampoDuelos}</div>
          </div>
          <!-- Split Fase -->
          ${_phaseSep('Por Fase — Duelos')}
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">
            <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:10px 14px;">
              <div style="font-family:'Archivo',sans-serif;font-size:10px;font-weight:700;color:${TC};margin-bottom:8px;">■ Fase de Grupos</div>
              <div style="display:flex;gap:6px;">${setores.map(s=>{const dg=_ss1.dt[s]?.dg||0,dp=_ss1.dt[s]?.dp||0,tot=dg+dp||1,pct=Math.round(dg/tot*100);return`<div style="flex:1;background:#fff;border-radius:6px;padding:8px;text-align:center;border:1px solid #d1fae5;"><div style="font-size:9px;font-weight:700;color:#374151;margin-bottom:3px;">${s.charAt(0).toUpperCase()+s.slice(1)}</div><div style="font-size:20px;font-weight:900;color:${pct>=50?'#16a34a':'#dc2626'};font-family:'Archivo',sans-serif;">${pct}%</div><div style="font-size:8px;color:#6b7280;">${dg}DG · ${dp}DP</div></div>`;}).join('')}</div>
            </div>
            <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:10px 14px;">
              <div style="font-family:'Archivo',sans-serif;font-size:10px;font-weight:700;color:#1a56db;margin-bottom:8px;">■ Fase Eliminatória</div>
              <div style="display:flex;gap:6px;">${setores.map(s=>{const dg=_ss2.dt[s]?.dg||0,dp=_ss2.dt[s]?.dp||0,tot=dg+dp||1,pct=Math.round(dg/tot*100);return`<div style="flex:1;background:#fff;border-radius:6px;padding:8px;text-align:center;border:1px solid #bfdbfe;"><div style="font-size:9px;font-weight:700;color:#374151;margin-bottom:3px;">${s.charAt(0).toUpperCase()+s.slice(1)}</div><div style="font-size:20px;font-weight:900;color:${pct>=50?'#16a34a':'#dc2626'};font-family:'Archivo',sans-serif;">${pct}%</div><div style="font-size:8px;color:#6b7280;">${dg}DG · ${dp}DP</div></div>`;}).join('')}</div>
            </div>
          </div>`}
        </div>
      </section>`;

      // ─── PAGE T6C: ROUBADAS DE BOLA POR SETOR ─────────────────────────────
      const pageT6c=`<section class="page" style="${PST}width:1122px;height:793px;">
        ${TS2}
        <div style="padding:12px 28px 0;">
          <div style="font-family:'Archivo',sans-serif;font-size:16px;font-weight:800;color:#111827;margin-bottom:10px;">7C · Roubadas de Bola por Setor</div>
          ${allEvents.length===0?_noScout:`
          <!-- Total cards + campo -->
          <div style="display:flex;gap:14px;margin-bottom:10px;">
            ${setores.map(s=>{const r=setorRoubadaTotals[s]||{};const tot=(r.po||0)+(r.pp||0)+(r.cb||0);return`<div style="flex:1;background:#f5f3ff;border:2px solid #ddd6fe;border-radius:12px;padding:14px;text-align:center;"><div style="font-family:'Archivo',sans-serif;font-size:12px;font-weight:700;color:#7c3aed;margin-bottom:6px;">${s.charAt(0).toUpperCase()+s.slice(1)}</div><div style="font-size:40px;font-weight:900;color:#7c3aed;font-family:'Archivo',sans-serif;line-height:1;">${tot}</div><div style="font-size:9px;color:#6b7280;margin-top:4px;">${Math.round(tot/_roubTot*100)}% do total</div><div style="margin-top:6px;font-family:'Inter',sans-serif;font-size:9px;color:#6b7280;">PO:${r.po||0} · PP:${r.pp||0} · CB:${r.cb||0}</div></div>`;}).join('')}
          </div>
          <div style="margin-bottom:6px;">
            <div style="font-family:'Inter',sans-serif;font-size:9px;color:#6b7280;margin-bottom:4px;text-align:center;"><span style="display:inline-flex;align-items:center;gap:6px;"><span style="width:10px;height:10px;background:#fb923c;border-radius:50%;display:inline-block;"></span>PO = Pressão Ofensiva &nbsp;<span style="width:10px;height:10px;background:#60a5fa;border-radius:50%;display:inline-block;"></span>PP = Pós-Perda &nbsp;<span style="width:10px;height:10px;background:#a78bfa;border-radius:50%;display:inline-block;"></span>CB = Combate — por setor</span></div>
            <div style="text-align:center;">${_scaledCampoRoubadas}</div>
          </div>
          <!-- Split Fase -->
          ${_phaseSep('Por Fase — Roubadas')}
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">
            <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:10px 14px;">
              <div style="font-family:'Archivo',sans-serif;font-size:10px;font-weight:700;color:${TC};margin-bottom:8px;">■ Fase de Grupos</div>
              <div style="display:flex;gap:6px;">${setores.map(s=>{const r=_ss1.rt[s]||{};const tot=(r.po||0)+(r.pp||0)+(r.cb||0);return`<div style="flex:1;background:#fff;border-radius:6px;padding:8px;text-align:center;border:1px solid #d1fae5;"><div style="font-size:9px;font-weight:700;color:#7c3aed;margin-bottom:3px;">${s.charAt(0).toUpperCase()+s.slice(1)}</div><div style="font-size:20px;font-weight:900;color:#7c3aed;font-family:'Archivo',sans-serif;">${tot}</div><div style="font-size:8px;color:#6b7280;">(${Math.round(tot/_roubTotF1*100)}%)</div></div>`;}).join('')}</div>
            </div>
            <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:10px 14px;">
              <div style="font-family:'Archivo',sans-serif;font-size:10px;font-weight:700;color:#1a56db;margin-bottom:8px;">■ Fase Eliminatória</div>
              <div style="display:flex;gap:6px;">${setores.map(s=>{const r=_ss2.rt[s]||{};const tot=(r.po||0)+(r.pp||0)+(r.cb||0);return`<div style="flex:1;background:#fff;border-radius:6px;padding:8px;text-align:center;border:1px solid #bfdbfe;"><div style="font-size:9px;font-weight:700;color:#7c3aed;margin-bottom:3px;">${s.charAt(0).toUpperCase()+s.slice(1)}</div><div style="font-size:20px;font-weight:900;color:#7c3aed;font-family:'Archivo',sans-serif;">${tot}</div><div style="font-size:8px;color:#6b7280;">(${Math.round(tot/_roubTotF2*100)}%)</div></div>`;}).join('')}</div>
            </div>
          </div>`}
        </div>
      </section>`;

      // ─── PAGE T6D: FALTAS POR SETOR ────────────────────────────────────────
      const _faltaTotal=Object.values(_faltaSetor).reduce((s,v)=>s+v,0);
      const pageT6d=`<section class="page" style="${PST}width:1122px;height:793px;">
        ${TS2}
        <div style="padding:12px 28px 0;">
          <div style="font-family:'Archivo',sans-serif;font-size:16px;font-weight:800;color:#111827;margin-bottom:10px;">7D · Faltas por Setor</div>
          ${allEvents.length===0?_noScout:`
          <!-- Total cards -->
          <div style="display:flex;gap:14px;margin-bottom:12px;">
            ${setores.map(s=>{const f=_faltaSetor[s]||0;return`<div style="flex:1;background:#fff7ed;border:2px solid #fed7aa;border-radius:12px;padding:16px;text-align:center;"><div style="font-family:'Archivo',sans-serif;font-size:12px;font-weight:700;color:#f97316;margin-bottom:6px;">${s.charAt(0).toUpperCase()+s.slice(1)}</div><div style="font-size:48px;font-weight:900;color:#f97316;font-family:'Archivo',sans-serif;line-height:1;">${f}</div><div style="font-size:9px;color:#6b7280;margin-top:4px;">${Math.round(f/_faltaTot*100)}% do total</div></div>`;}).join('')}
            <div style="flex:1;background:#fef2f2;border:2px solid #fecaca;border-radius:12px;padding:16px;text-align:center;">
              <div style="font-family:'Archivo',sans-serif;font-size:12px;font-weight:700;color:#dc2626;margin-bottom:6px;">Total</div>
              <div style="font-size:48px;font-weight:900;color:#dc2626;font-family:'Archivo',sans-serif;line-height:1;">${_faltaTotal}</div>
              <div style="font-size:9px;color:#6b7280;margin-top:4px;">${totalJogos>0?(_faltaTotal/totalJogos).toFixed(1):0}/jogo</div>
            </div>
          </div>
          <!-- Bar chart -->
          <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:10px 14px;margin-bottom:8px;">
            <div style="font-family:'Archivo',sans-serif;font-size:11px;font-weight:700;color:#374151;margin-bottom:8px;">Faltas por Bloco de 15 Minutos</div>
            ${svgBarChart(blLabels.map((_,bi)=>blocos15[bi].falta),blLabels,blLabels.map(()=>'#f97316'),{w:1050,h:200})}
          </div>
          <!-- Split Fase -->
          ${_phaseSep('Por Fase — Faltas')}
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">
            <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:10px 14px;">
              <div style="font-family:'Archivo',sans-serif;font-size:10px;font-weight:700;color:${TC};margin-bottom:8px;">■ Fase de Grupos — ${Object.values(_faltaF1).reduce((s,v)=>s+v,0)} faltas (${jogosFase1.length>0?(Object.values(_faltaF1).reduce((s,v)=>s+v,0)/jogosFase1.length).toFixed(1):0}/jogo)</div>
              <div style="display:flex;gap:6px;">${setores.map(s=>{const f=_faltaF1[s]||0;return`<div style="flex:1;background:#fff;border-radius:6px;padding:8px;text-align:center;border:1px solid #d1fae5;"><div style="font-size:9px;font-weight:700;color:#f97316;margin-bottom:3px;">${s.charAt(0).toUpperCase()+s.slice(1)}</div><div style="font-size:20px;font-weight:900;color:#f97316;font-family:'Archivo',sans-serif;">${f}</div><div style="font-size:8px;color:#6b7280;">(${Math.round(f/_faltaTotF1*100)}%)</div></div>`;}).join('')}</div>
            </div>
            <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:10px 14px;">
              <div style="font-family:'Archivo',sans-serif;font-size:10px;font-weight:700;color:#1a56db;margin-bottom:8px;">■ Fase Eliminatória — ${Object.values(_faltaF2).reduce((s,v)=>s+v,0)} faltas (${jogosFase2.length>0?(Object.values(_faltaF2).reduce((s,v)=>s+v,0)/jogosFase2.length).toFixed(1):0}/jogo)</div>
              <div style="display:flex;gap:6px;">${setores.map(s=>{const f=_faltaF2[s]||0;return`<div style="flex:1;background:#fff;border-radius:6px;padding:8px;text-align:center;border:1px solid #bfdbfe;"><div style="font-size:9px;font-weight:700;color:#f97316;margin-bottom:3px;">${s.charAt(0).toUpperCase()+s.slice(1)}</div><div style="font-size:20px;font-weight:900;color:#f97316;font-family:'Archivo',sans-serif;">${f}</div><div style="font-size:8px;color:#6b7280;">(${Math.round(f/_faltaTotF2*100)}%)</div></div>`;}).join('')}</div>
            </div>
          </div>`}
        </div>
      </section>`;

      // ─── PAGE T6E: FINALIZAÇÕES ────────────────────────────────────────────
      const pageT6e=`<section class="page" style="${PST}width:1122px;height:793px;">
        ${TS2}
        <div style="padding:12px 28px 0;">
          <div style="font-family:'Archivo',sans-serif;font-size:16px;font-weight:800;color:#111827;margin-bottom:10px;">7E · Origem das Finalizações</div>
          ${allEvents.length===0?_noScout:`
          <!-- Total KPIs -->
          <div style="display:flex;gap:12px;margin-bottom:10px;">
            ${KPIT('Finalizações Totais',totalFinPro,'da equipe','#1a56db')}
            ${KPIT('Fin. Adversário',totalFinAdv,'sofridas','#dc2626')}
            ${KPIT('Conv. Gol (equipe)',convPro!=null?convPro+'%':'—','fin. → gol','#16a34a')}
            ${KPIT('Conv. Adversário',convAdv!=null?convAdv+'%':'—','fin. adv. → gol','#f97316')}
          </div>
          <!-- Campo título + breakdown L/C/R -->
          ${(()=>{
            const _shots=allEvents.filter(e=>e.action==='Finalização');
            const _shotsAdv=allEvents.filter(e=>e.action==='Finalização adversária');
            const _classLCR=(evs)=>{
              let l=0,c=0,r=0,sem=0;
              evs.forEach(e=>{
                const s=e.meta?.setorOrigem;
                if(!s){sem++;return;}
                if(s==='esquerdo')l++;else if(s==='direito')r++;else c++;
              });
              return{l,c,r,sem,tot:evs.length};
            };
            const _lcrFin=_classLCR(_shots);
            const _lcrAdv=_classLCR(_shotsAdv);
            const _lcrBar=(lc,color)=>{
              const t=(lc.l+lc.c+lc.r)||1;
              const pL=Math.round(lc.l/t*100),pC=Math.round(lc.c/t*100),pR=Math.round(lc.r/t*100);
              return`<div style="margin-top:6px;">
                <div style="display:flex;height:22px;border-radius:5px;overflow:hidden;">
                  <div style="flex:${lc.l||0.01};background:${color};opacity:0.7;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;color:#fff;">${pL}%</div>
                  <div style="flex:${lc.c||0.01};background:${color};opacity:0.9;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;color:#fff;">${pC}%</div>
                  <div style="flex:${lc.r||0.01};background:${color};opacity:0.7;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;color:#fff;">${pR}%</div>
                </div>
                <div style="display:flex;justify-content:space-between;margin-top:2px;">
                  <span style="font-size:8px;color:#6b7280;">← Esq. (${lc.l})</span>
                  <span style="font-size:8px;color:#6b7280;">Centro (${lc.c})</span>
                  <span style="font-size:8px;color:#6b7280;">Dir. (${lc.r}) →</span>
                </div>
              </div>`;
            };
            return`<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:8px;">
              <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:10px 14px;">
                <div style="font-family:'Archivo',sans-serif;font-size:10px;font-weight:700;color:#1a56db;margin-bottom:2px;">Finalizações da Equipe — Origem (Esq / Centro / Dir)</div>
                <div style="font-family:'Inter',sans-serif;font-size:9px;color:#6b7280;margin-bottom:4px;">${_shots.length} finalizações · ${_lcrFin.sem} sem dados de posição</div>
                ${_lcrBar(_lcrFin,'#1a56db')}
              </div>
              <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:10px 14px;">
                <div style="font-family:'Archivo',sans-serif;font-size:10px;font-weight:700;color:#dc2626;margin-bottom:2px;">Finalizações Adversárias — Origem (Esq / Centro / Dir)</div>
                <div style="font-family:'Inter',sans-serif;font-size:9px;color:#6b7280;margin-bottom:4px;">${_shotsAdv.length} finalizações · ${_lcrAdv.sem} sem dados de posição</div>
                ${_lcrBar(_lcrAdv,'#dc2626')}
              </div>
            </div>`;
          })()}
          ${(()=>{
            // 3-arrow campo: L/C/R → goal, espessura proporcional ao %
            // Apenas finalizações com meta.y disponível
            const _FWA=440, _FHA=370, _GAP=40;
            const _mkCampo3Setas=(evs,isAdv,titleColor,title)=>{
              const f=_vFieldBase(_FWA,_FHA);
              const {fx,fy,fw,fh,e:fieldSvg}=f;
              const withY=evs.filter(e=>e.meta?.setorOrigem!=null);
              const semY=evs.length-withY.length;
              // goal mouth at top center
              const goalCX=fx+fw/2, goalCY=fy+2;
              // zone colors
              const zoneColor={esquerdo:'#16a34a',central:'#0ea5e9',direito:'#f97316'};
              // zone X ranges [min%, max%] of fw
              const zoneX={esquerdo:[0.12,0.32],central:[0.38,0.62],direito:[0.68,0.88]};
              // draw one arrow per shot
              const rng=_seededRng(title.length*31+evs.length*7);
              let arrows='';
              withY.forEach((e,i)=>{
                let s=e.meta?.setorOrigem;
                if(!s)return;
                // para adversário, inverter lateralidade
                if(isAdv){ if(s==='esquerdo')s='direito'; else if(s==='direito')s='esquerdo'; }
                const color=zoneColor[s]||'#94a3b8';
                const [xMin,xMax]=zoneX[s]||[0.4,0.6];
                const sx=fx+fw*(xMin+rng()*(xMax-xMin));
                const sy=fy+fh*(0.10+rng()*0.22);
                // control point for curved arrow
                const cpx=(sx+goalCX)/2+(rng()-0.5)*fw*0.12;
                const cpy=sy-(sy-goalCY)*0.45;
                arrows+=`<path d="M${sx.toFixed(1)},${sy.toFixed(1)} Q${cpx.toFixed(1)},${cpy.toFixed(1)} ${goalCX},${goalCY}" fill="none" stroke="${color}" stroke-width="1.5" stroke-opacity="0.55" stroke-linecap="round"/>`;
              });
              // small arrowhead dot at goal
              if(withY.length>0) arrows+=`<circle cx="${goalCX}" cy="${goalCY}" r="3" fill="#374151" fill-opacity="0.5"/>`;
              const noData=withY.length===0?`<text x="${fx+fw/2}" y="${fy+fh/2}" text-anchor="middle" fill="#9ca3af" font-size="10" font-family="Inter">Sem dados de posição</text>`:'';
              // legend + counts
              const legY=fy+fh+20;
              const zones=[
                {key:'esquerdo',label:'Esq.',color:'#16a34a'},
                {key:'central', label:'Centro',color:'#0ea5e9'},
                {key:'direito', label:'Dir.',color:'#f97316'},
              ];
              let lN=0,cN=0,rN=0;
              withY.forEach(e=>{
                let s=e.meta?.setorOrigem;
                if(!s)return;
                if(isAdv){ if(s==='esquerdo')s='direito';else if(s==='direito')s='esquerdo'; }
                if(s==='esquerdo')lN++;else if(s==='direito')rN++;else cN++;
              });
              const counts={esquerdo:lN,central:cN,direito:rN};
              let leg='';
              zones.forEach(({key,label,color},i)=>{
                const lx=fx+i*(fw/3)+fw/6;
                const n=counts[key]||0;
                leg+=`<circle cx="${lx-22}" cy="${legY-3}" r="4" fill="${color}"/>`;
                leg+=`<text x="${lx-16}" y="${legY+1}" fill="#374151" font-size="8" font-family="Inter">${label} (${n})</text>`;
              });
              return`<g transform="translate(${isAdv?_FWA+_GAP:0},0)">
                ${fieldSvg}${arrows}${noData}
                <text x="${fx+fw/2}" y="${fy-8}" text-anchor="middle" fill="${titleColor}" font-size="8.5" font-family="Archivo" font-weight="700">${title}</text>
                <text x="${fx+fw/2}" y="${fy+fh+11}" text-anchor="middle" fill="#9ca3af" font-size="7" font-family="Inter">${withY.length} fin. com dados · ${semY} sem posição (excluídas)</text>
                ${leg}
              </g>`;
            };
            const _shotsTeam=allEvents.filter(e=>e.action==='Finalização');
            const _shotsAdv2=allEvents.filter(e=>e.action==='Finalização adversária');
            const _totalW=_FWA*2+_GAP;
            const _totalH=_FHA+34;
            return`<div style="text-align:center;margin-top:4px;">
              <svg width="${_totalW}" height="${_totalH}" viewBox="0 0 ${_totalW} ${_totalH}" xmlns="http://www.w3.org/2000/svg">
                ${_mkCampo3Setas(_shotsTeam,false,'#1a56db','FINALIZAÇÕES DA EQUIPE')}
                ${_mkCampo3Setas(_shotsAdv2,true,'#dc2626','FINALIZAÇÕES ADVERSÁRIAS')}
              </svg>
            </div>`;
          })()}
          <!-- Split Fase -->
          ${_phaseSep('Por Fase — Finalizações')}
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">
            <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:10px 14px;">
              <div style="font-family:'Archivo',sans-serif;font-size:10px;font-weight:700;color:${TC};margin-bottom:8px;">■ Fase de Grupos</div>
              <div style="display:flex;gap:8px;">
                <div style="flex:1;background:#fff;border-radius:6px;padding:8px;text-align:center;border:1px solid #d1fae5;"><div style="font-size:9px;color:#6b7280;">Finalizações</div><div style="font-size:22px;font-weight:800;color:#1a56db;font-family:'Archivo',sans-serif;">${_finF1}</div><div style="font-size:8px;color:#6b7280;">${(_finF1/_nF1).toFixed(1)}/jogo</div></div>
                <div style="flex:1;background:#fff;border-radius:6px;padding:8px;text-align:center;border:1px solid #d1fae5;"><div style="font-size:9px;color:#6b7280;">Conv. Gol</div><div style="font-size:22px;font-weight:800;color:#16a34a;font-family:'Archivo',sans-serif;">${_convF1!=null?_convF1+'%':'—'}</div><div style="font-size:8px;color:#6b7280;">${_golsF1} gols</div></div>
                <div style="flex:1;background:#fff;border-radius:6px;padding:8px;text-align:center;border:1px solid #d1fae5;"><div style="font-size:9px;color:#6b7280;">Fin. Adv.</div><div style="font-size:22px;font-weight:800;color:#dc2626;font-family:'Archivo',sans-serif;">${_finAdvF1}</div><div style="font-size:8px;color:#6b7280;">${(_finAdvF1/_nF1).toFixed(1)}/jogo</div></div>
              </div>
            </div>
            <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:10px 14px;">
              <div style="font-family:'Archivo',sans-serif;font-size:10px;font-weight:700;color:#1a56db;margin-bottom:8px;">■ Fase Eliminatória</div>
              <div style="display:flex;gap:8px;">
                <div style="flex:1;background:#fff;border-radius:6px;padding:8px;text-align:center;border:1px solid #bfdbfe;"><div style="font-size:9px;color:#6b7280;">Finalizações</div><div style="font-size:22px;font-weight:800;color:#1a56db;font-family:'Archivo',sans-serif;">${_finF2}</div><div style="font-size:8px;color:#6b7280;">${(_finF2/_nF2).toFixed(1)}/jogo</div></div>
                <div style="flex:1;background:#fff;border-radius:6px;padding:8px;text-align:center;border:1px solid #bfdbfe;"><div style="font-size:9px;color:#6b7280;">Conv. Gol</div><div style="font-size:22px;font-weight:800;color:#16a34a;font-family:'Archivo',sans-serif;">${_convF2!=null?_convF2+'%':'—'}</div><div style="font-size:8px;color:#6b7280;">${_golsF2} gols</div></div>
                <div style="flex:1;background:#fff;border-radius:6px;padding:8px;text-align:center;border:1px solid #bfdbfe;"><div style="font-size:9px;color:#6b7280;">Fin. Adv.</div><div style="font-size:22px;font-weight:800;color:#dc2626;font-family:'Archivo',sans-serif;">${_finAdvF2}</div><div style="font-size:8px;color:#6b7280;">${(_finAdvF2/_nF2).toFixed(1)}/jogo</div></div>
              </div>
            </div>
          </div>`}
        </div>
      </section>`;

      // ─── PAGE T6F: BOLAS PARADAS + VOLUME OFENSIVO ────────────────────────
      const pageT6f=`<section class="page" style="${PST}width:1122px;height:793px;">
        ${TS2}
        <div style="padding:12px 28px 0;">
          <div style="font-family:'Archivo',sans-serif;font-size:16px;font-weight:800;color:#111827;margin-bottom:10px;">7F · Bolas Paradas e Entradas no Último Terço</div>
          ${allEvents.length===0?_noScout:`
          <!-- GOLS DE BOLA PARADA -->
          <div style="font-family:'Archivo',sans-serif;font-size:12px;font-weight:700;color:#111827;margin-bottom:6px;border-bottom:2px solid #e5e7eb;padding-bottom:3px;">Gols de Bola Parada</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">
            <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:10px 14px;">
              <div style="font-family:'Archivo',sans-serif;font-size:10px;font-weight:700;color:#16a34a;margin-bottom:6px;">MARCADOS</div>
              <div style="display:flex;gap:10px;">
                ${KPIT('Bola Parada',_golsBPAm,'gols marcados','#16a34a')}
                ${KPIT('Pênalti',_golsPenAm,'gols de pênalti','#16a34a')}
                ${KPIT('Total BP+Pen',_golsBPAm+_golsPenAm,(totalGolsPro>0?Math.round((_golsBPAm+_golsPenAm)/totalGolsPro*100):0)+'% dos gols',TC)}
              </div>
            </div>
            <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:10px 14px;">
              <div style="font-family:'Archivo',sans-serif;font-size:10px;font-weight:700;color:#dc2626;margin-bottom:6px;">SOFRIDOS</div>
              <div style="display:flex;gap:10px;">
                ${KPIT('Bola Parada',_golsBPAdv,'gols sofridos','#dc2626')}
                ${KPIT('Pênalti',_golsPenAdv,'gols de pênalti','#dc2626')}
                ${KPIT('Total BP+Pen',_golsBPAdv+_golsPenAdv,(totalGolsContra>0?Math.round((_golsBPAdv+_golsPenAdv)/totalGolsContra*100):0)+'% dos gols','#991b1b')}
              </div>
            </div>
          </div>
          <!-- VOLUME DE BOLAS PARADAS -->
          <div style="font-family:'Archivo',sans-serif;font-size:12px;font-weight:700;color:#111827;margin-bottom:6px;border-bottom:2px solid #e5e7eb;padding-bottom:3px;">Volume de Bolas Paradas</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">
            <div style="background:#faf5ff;border:1px solid #e9d5ff;border-radius:8px;padding:10px 14px;">
              <div style="font-family:'Archivo',sans-serif;font-size:10px;font-weight:700;color:#7c3aed;margin-bottom:6px;">EQUIPE — OFENSIVAS</div>
              <div style="display:flex;gap:10px;">
                ${KPIT('Escanteios',_bpAmEscTot,'cobrados','#7c3aed')}
                ${KPIT('Faltas BP',_bpAmFalTot,'cobradas','#d97706')}
                ${KPIT('Finalizadas',_bpAmFin,(_bpAmFinPct!=null?_bpAmFinPct+'%':'—')+' das BP','#16a34a')}
              </div>
            </div>
            <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:10px 14px;">
              <div style="font-family:'Archivo',sans-serif;font-size:10px;font-weight:700;color:#ea580c;margin-bottom:6px;">ADVERSÁRIO — DEFENSIVAS</div>
              <div style="display:flex;gap:10px;">
                ${KPIT('Escanteios',_bpAdvEsc,'adversários','#ea580c')}
                ${KPIT('Faltas BP',_bpAdvFal,'adversárias','#ea580c')}
                ${KPIT('Finalizadas',_bpAdvFin,(_bpAdvFinPct!=null?_bpAdvFinPct+'%':'—')+' das BP','#dc2626')}
              </div>
            </div>
          </div>
          <!-- ENTRADAS NO ÚLTIMO TERÇO -->
          <div style="font-family:'Archivo',sans-serif;font-size:12px;font-weight:700;color:#111827;margin-bottom:6px;border-bottom:2px solid #e5e7eb;padding-bottom:3px;">Entradas no Último Terço</div>
          <div style="display:flex;gap:10px;margin-bottom:8px;">
            ${KPIT('Total Entradas',eaTotalEntradas,eaMediaEntradas+'/jogo',TC)}
            ${KPIT('Finalizou',eaTotalFin,'após entrada','#16a34a')}
            ${KPIT('Conversão',eaConvPct!=null?eaConvPct+'%':'—','entrada→fin.','#16a34a')}
            ${KPIT('Sem Desfecho',eaTotalSem||0,'entradas perdidas','#dc2626')}
            ${KPIT('Escanteios (EA)',eaTotalBPEsc,'no último terço','#7c3aed')}
            ${KPIT('Faltas BP (EA)',eaTotalBPFal,'no último terço','#d97706')}
          </div>
          <!-- Bar chart entradas -->
          <div style="background:#f8faff;border:1px solid #dbeafe;border-radius:8px;padding:8px 14px;margin-bottom:8px;">
            <div style="font-family:'Archivo',sans-serif;font-size:10px;font-weight:700;color:#374151;margin-bottom:6px;">Aproveitamento das Entradas no Ataque</div>
            <div style="display:flex;height:24px;border-radius:6px;overflow:hidden;">
              <div style="flex:${eaTotalFin||1};background:#16a34a;display:flex;align-items:center;justify-content:center;font-family:'Archivo',sans-serif;font-size:10px;font-weight:700;color:#fff;">${eaTotalFin} fin.</div>
              <div style="flex:${(eaTotalBP||1)};background:#7c3aed;display:flex;align-items:center;justify-content:center;font-family:'Archivo',sans-serif;font-size:10px;font-weight:700;color:#fff;">${eaTotalBP} BP</div>
              <div style="flex:${eaTotalSem||1};background:#dc2626;display:flex;align-items:center;justify-content:center;font-family:'Archivo',sans-serif;font-size:10px;font-weight:700;color:#fff;">${eaTotalSem||0} sem</div>
            </div>
          </div>
          <!-- Split por Fase -->
          ${_phaseSep('Por Fase — Bolas Paradas')}
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">
            <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:10px 14px;">
              ${_phaseBar('Escanteios/jogo',(_evF1.filter(e=>e.action==='Bola Parada'&&e.meta?.equipe==='america'&&e.meta?.tipo==='escanteio').length/_nF1Sc).toFixed(1),(_evF2.filter(e=>e.action==='Bola Parada'&&e.meta?.equipe==='america'&&e.meta?.tipo==='escanteio').length/_nF2Sc).toFixed(1))}
              ${_phaseBar('Gols BP marcados',_evF1.filter(e=>e.action==='Gol Pró'&&e.meta?.origem==='parada').length,_evF2.filter(e=>e.action==='Gol Pró'&&e.meta?.origem==='parada').length)}
              ${_phaseBar('Gols BP sofridos',_evF1.filter(e=>e.action==='Gol Contra (adv)'&&e.meta?.origem==='parada').length,_evF2.filter(e=>e.action==='Gol Contra (adv)'&&e.meta?.origem==='parada').length)}
              ${_phaseBar('Entradas no ataque/jogo',(_eaF1.length/_nF1Sc).toFixed(1),(_eaF2.length/_nF2Sc).toFixed(1))}
            </div>
            <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:10px 14px;">
              ${_phaseBar('Faltas BP/jogo',(_evF1.filter(e=>e.action==='Bola Parada'&&e.meta?.equipe==='america'&&e.meta?.tipo==='falta').length/_nF1Sc).toFixed(1),(_evF2.filter(e=>e.action==='Bola Parada'&&e.meta?.equipe==='america'&&e.meta?.tipo==='falta').length/_nF2Sc).toFixed(1))}
              ${_phaseBar('Gols Pênalti marcados',_evF1.filter(e=>e.action==='Gol Pró'&&e.meta?.origem==='penalti').length,_evF2.filter(e=>e.action==='Gol Pró'&&e.meta?.origem==='penalti').length)}
              ${_phaseBar('Gols Pênalti sofridos',_evF1.filter(e=>e.action==='Gol Contra (adv)'&&e.meta?.origem==='penalti').length,_evF2.filter(e=>e.action==='Gol Contra (adv)'&&e.meta?.origem==='penalti').length)}
              ${_phaseBar('Conv. entrada→fin.',_convF1!=null?_convF1+'%':'—',_convF2!=null?_convF2+'%':'—')}
            </div>
          </div>`}
        </div>
      </section>`;

      // ─── PAGE T7: ESCALAÇÃO — FORMAÇÕES MAIS USADAS ───────────────────────
      const _FM_ABBR={
        '4-3-3':  ['GK','LE','ZE','ZD','LD','Vol','MD','ME','PE','CA','PD'],
        '4-4-2':  ['GK','LE','ZE','ZD','LD','ME','MC','MC','MD','CA','CA'],
        '4-2-3-1':['GK','LE','ZE','ZD','LD','VL','VR','ML','MC','MR','CA'],
        '3-5-2':  ['GK','ZE','ZC','ZD','AE','VL','VC','VR','AD','CAE','CAD'],
        '3-4-3':  ['GK','ZE','ZC','ZD','AE','ML','MR','AD','PE','CA','PD'],
        '4-3-1-2':['GK','LE','ZE','ZD','LD','VL','VC','VR','MA','CAE','CAD'],
      };
      // Grupos por linha para exibição no estilo TV
      // Ordem: GK · LD · Zagueiros · LE · Volantes/Meias · Pontas/CA
      const _FM_GROUPS={
        '4-3-3':  [{l:'GOLEIRO',s:[0]},{l:'LATERAL DIREITO',s:[4]},{l:'ZAGUEIROS',s:[2,3]},{l:'LATERAL ESQUERDO',s:[1]},{l:'VOLANTES E MEIAS',s:[5,6,7]},{l:'PONTAS / CENTRO-AVANTE',s:[8,9,10]}],
        '4-4-2':  [{l:'GOLEIRO',s:[0]},{l:'LATERAL DIREITO',s:[4]},{l:'ZAGUEIROS',s:[2,3]},{l:'LATERAL ESQUERDO',s:[1]},{l:'MEIO-CAMPO',s:[5,6,7,8]},{l:'ATACANTES',s:[9,10]}],
        '4-2-3-1':[{l:'GOLEIRO',s:[0]},{l:'LATERAL DIREITO',s:[4]},{l:'ZAGUEIROS',s:[2,3]},{l:'LATERAL ESQUERDO',s:[1]},{l:'VOLANTES',s:[5,6]},{l:'MEIAS',s:[7,8,9]},{l:'CENTROAVANTE',s:[10]}],
        '3-5-2':  [{l:'GOLEIRO',s:[0]},{l:'ZAGUEIROS',s:[1,2,3]},{l:'ALAS',s:[4,8]},{l:'VOLANTES',s:[5,6,7]},{l:'ATACANTES',s:[9,10]}],
        '3-4-3':  [{l:'GOLEIRO',s:[0]},{l:'ZAGUEIROS',s:[1,2,3]},{l:'ALAS',s:[4,7]},{l:'MEIAS',s:[5,6]},{l:'PONTAS / CENTRO-AVANTE',s:[8,9,10]}],
        '4-3-1-2':[{l:'GOLEIRO',s:[0]},{l:'LATERAL DIREITO',s:[4]},{l:'ZAGUEIROS',s:[2,3]},{l:'LATERAL ESQUERDO',s:[1]},{l:'VOLANTES',s:[5,6,7]},{l:'MEIA',s:[8]},{l:'ATACANTES',s:[9,10]}],
      };
      const _mostUsedFM=(jogos)=>{
        const c={};
        jogos.forEach(g=>{const e=g.esquema||'';if(e)c[e]=(c[e]||0)+1;});
        return Object.entries(c).sort((a,b)=>b[1]-a[1])[0]?.[0]||null;
      };
      const _bestXI=(jogos,esquema)=>{
        const minsPerSlot=Array(11).fill(null).map(()=>({}));
        const _getMin=(g,aid)=>{
          if(!aid)return 0;
          if(g.playedSeconds&&g.playedSeconds[aid]!=null){
            const raw=typeof g.playedSeconds[aid]==='object'?(g.playedSeconds[aid].seconds??0):typeof g.playedSeconds[aid]==='number'?g.playedSeconds[aid]:0;
            return Math.round(Math.min(raw,g.duracaoSegundos||5400)/60)||1;
          }
          const snap=Object.values(g.perfSnapshot||{}).find(s=>s.athleteId===aid);
          return snap?.minutos||1;
        };
        jogos.forEach(g=>{
          if(g.esquema!==esquema)return;
          const slots=g.formationSlots;
          const hasSlotsData=slots&&slots.some(Boolean);
          if(hasSlotsData){
            slots.forEach((id,i)=>{if(id)minsPerSlot[i][id]=(minsPerSlot[i][id]||0)+_getMin(g,id);});
          } else if(g.titulares&&g.titulares.length){
            g.titulares.slice(0,11).forEach((id,i)=>{if(id)minsPerSlot[i][id]=(minsPerSlot[i][id]||0)+_getMin(g,id);});
          }
        });
        // Deduplicar: cada atleta aparece apenas 1 vez (no slot com mais minutos)
        const used=new Set();
        return minsPerSlot.map(m=>{
          const sorted=Object.entries(m).sort((a,b)=>b[1]-a[1]);
          for(const [id] of sorted){if(!used.has(id)){used.add(id);return id;}}
          return null;
        });
      };
      const _fmF1=_mostUsedFM(jogosFase1);
      const _fmF2=_mostUsedFM(jogosFase2);
      const _xi1=_fmF1?_bestXI(jogosFase1,_fmF1):Array(11).fill(null);
      const _xi2=_fmF2?_bestXI(jogosFase2,_fmF2):Array(11).fill(null);

      // Formação mais usada no período geral (todos os jogos)
      const _fmGeral=_mostUsedFM(jogosData);

      // Monta XI por posição do cadastro (campo `posicao`) + minutagem
      const _bestXIByPos=(esquema)=>{
        const groups=_FM_GROUPS[esquema]||_FM_GROUPS['4-3-3'];
        // Mapeamento: label do grupo → palavras-chave da posição no cadastro (case-insensitive)
        const grpKeys={
          'GOLEIRO':               ['goleiro'],
          'LATERAL DIREITO':       ['lateral'],
          'ZAGUEIROS':             ['zagueiro'],
          'LATERAL ESQUERDO':      ['lateral'],
          'VOLANTES E MEIAS':      ['volante','meia'],
          'MEIO-CAMPO':            ['volante','meia'],
          'VOLANTES':              ['volante'],
          'MEIAS':                 ['meia'],
          'MEIA':                  ['meia'],
          'PONTAS / CENTRO-AVANTE':['ponta','centro-avante','centro avante','atacante'],
          'ATACANTES':             ['ponta','centro-avante','centro avante','atacante'],
          'CENTROAVANTE':          ['centro-avante','centro avante','atacante'],
          'ALAS':                  ['lateral','ponta'],
        };
        // Atletas ordenados por minutos decrescente
        const byMins=Object.entries(atlMins)
          .filter(([aid])=>atletasMap[aid])
          .map(([aid,m])=>({aid,m,pos:(atletasMap[aid].posicao||'').toLowerCase().trim()}))
          .sort((a,b)=>b.m-a.m);
        const used=new Set();
        const result=Array(11).fill(null);
        groups.forEach(g=>{
          const kw=grpKeys[g.l]||[];
          g.s.forEach(slotIdx=>{
            const match=byMins.find(a=>!used.has(a.aid)&&kw.some(k=>a.pos.includes(k)));
            if(match){used.add(match.aid);result[slotIdx]=match.aid;}
          });
        });
        return result;
      };

      const _esquemaFixo='4-3-3';
      // Fixed XI: find athlete IDs by name fragment (accent-insensitive)
      const _norm=s=>(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
      const _findAtl=(frag)=>{
        const f=_norm(frag);
        return Object.entries(atletasMap).find(([,a])=>_norm(a.nome).includes(f))?.[0]||null;
      };
      const _xiFixo=Array(11).fill(null);
      _xiFixo[0]=_findAtl('kayque');          // GK
      _xiFixo[1]=_findAtl('masson');          // LE – Rafael Masson
      _xiFixo[2]=_findAtl('jose luiz')||_findAtl('castanheiro'); // ZE – José Luiz
      _xiFixo[3]=_findAtl('weide');           // ZD – Pedro Weide
      _xiFixo[4]=_findAtl('ataides');         // LD – João Ataídes
      _xiFixo[5]=_findAtl('francisco');       // Vol – Francisco
      _xiFixo[6]=_findAtl('gregorio');        // MD – João Gregório
      _xiFixo[7]=_findAtl('queiroga');        // ME – Lucas Queiroga
      _xiFixo[8]=_findAtl('aislan');          // PE – Aislan
      _xiFixo[9]=_findAtl('edipo');           // CA – Edipo
      _xiFixo[10]=_findAtl('gabriel vitor');  // PD – Gabriel Vitor
      const _xiGeral=_xiFixo;

      // ── TV-style lineup card (largura total) ─────────────────────────────
      const _tvLineup=(esquema,slots)=>{
        const abbr=_FM_ABBR[esquema]||_FM_ABBR['4-3-3'];
        const groups=_FM_GROUPS[esquema]||_FM_GROUPS['4-3-3'];
        const R=17;
        const playerCard=(aid,i)=>{
          const atl=aid?atletasMap[aid]:null;
          const nome=atl?atl.nome:'—';
          const pos=abbr[i]||'';
          const mins=aid?atlMins[aid]:null;
          const foto=atl?.fotoUrl;
          const avatar=foto
            ?`<div style="width:${R*2}px;height:${R*2}px;border-radius:50%;overflow:hidden;flex-shrink:0;border:2px solid ${TC};"><img src="${esc(foto)}" style="width:100%;height:100%;object-fit:cover;"/></div>`
            :`<div style="width:${R*2}px;height:${R*2}px;border-radius:50%;background:${TC};display:flex;align-items:center;justify-content:center;flex-shrink:0;"><span style="font-family:'Archivo',sans-serif;font-size:9px;font-weight:800;color:#fff;">${esc(nome.split(' ').slice(0,2).map(w=>w[0]||'').join(''))}</span></div>`;
          return`<div style="display:flex;align-items:center;gap:10px;padding:5px 0;border-bottom:1px solid #f9fafb;">
            ${avatar}
            <div style="flex:1;min-width:0;">
              <div style="font-family:'Archivo',sans-serif;font-size:13px;font-weight:800;color:#111827;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(nome)}</div>
              ${mins!=null?`<div style="font-family:'Inter',sans-serif;font-size:8px;color:#9ca3af;">${mins} min</div>`:''}
            </div>
            <span style="font-family:'Inter',sans-serif;font-size:8px;font-weight:700;color:${TC};background:${TC}18;padding:2px 7px;border-radius:4px;flex-shrink:0;">${pos}</span>
          </div>`;
        };
        return groups.map(g=>{
          const players=g.s.map(i=>playerCard(slots[i],i)).join('');
          return`<div>
            <div style="font-family:'Inter',sans-serif;font-size:7.5px;font-weight:700;color:#9ca3af;letter-spacing:2px;padding:5px 0 3px;border-bottom:1px solid #e5e7eb;margin-bottom:1px;">${g.l}</div>
            ${players}
          </div>`;
        }).join('');
      };

      const pageT7=`<section class="page" style="${PST}width:1122px;height:793px;">
        ${TS2}
        <div style="padding:14px 32px 0;">
          <div style="display:flex;align-items:baseline;gap:14px;margin-bottom:12px;border-bottom:2px solid #f3f4f6;padding-bottom:10px;">
            <div style="font-family:'Archivo',sans-serif;font-size:16px;font-weight:800;color:#111827;">8 · 11 Mais Usados</div>
            <span style="font-family:'Archivo',sans-serif;font-size:24px;font-weight:900;color:${TC};">${_esquemaFixo}</span>
          </div>
          ${_tvLineup(_esquemaFixo,_xiGeral)}
        </div>
      </section>`;

      // ─── PAGE TProntCarga: PRONTIDÃO E CARGA ─────────────────────────────
      function weeklyProntCarga(dms){
        const byWeek={};
        dms.forEach(dm=>{
          if(!dm.date)return;
          const wk=getMondayStr(dm.date);
          if(!byWeek[wk])byWeek[wk]={cargaVals:[],igpVals:[],pseVals:[],tempoVals:[]};
          const carga=(dm.post?.pse!=null&&dm.post?.tempo!=null)?dm.post.pse*dm.post.tempo:null;
          if(carga!=null)byWeek[wk].cargaVals.push(carga);
          if(dm.post?.pse!=null)byWeek[wk].pseVals.push(dm.post.pse);
          if(dm.post?.tempo!=null)byWeek[wk].tempoVals.push(dm.post.tempo);
          const igp=dm._sc?.global;
          if(igp!=null)byWeek[wk].igpVals.push(igp);
        });
        const weeks=Object.keys(byWeek).sort();
        return{
          weeks,
          cargaVals:weeks.map(w=>byWeek[w].cargaVals.length?Math.round(avg(byWeek[w].cargaVals)):null),
          igpVals:weeks.map(w=>byWeek[w].igpVals.length?Math.round(avg(byWeek[w].igpVals)):null),
          pseVals:weeks.map(w=>byWeek[w].pseVals.length?+(avg(byWeek[w].pseVals)).toFixed(1):null),
          tempoVals:weeks.map(w=>byWeek[w].tempoVals.length?Math.round(avg(byWeek[w].tempoVals)):null),
          labels:weeks.map(w=>{const[,m,d]=w.split('-');return`${d}/${m}`;})
        };
      }

      const _dmsFase1=splitDate?allDM.filter(d=>d.date<splitDate):allDM;
      const _dmsFase2=splitDate?allDM.filter(d=>d.date>=splitDate):[];
      const _wf1=weeklyProntCarga(_dmsFase1);
      const _wf2=weeklyProntCarga(_dmsFase2);
      const _wAll=weeklyProntCarga(allDM);

      // Dual chart: bars for carga (fixed 0-1000), line overlay for IGP
      function buildCargaIGPChart(weeks, cargaVals, igpVals, labels, color, W=480, H=170){
        if(!weeks.length) return `<div style="font-family:'Inter',sans-serif;font-size:11px;color:#9ca3af;padding:20px;text-align:center;">Sem dados no período</div>`;
        const pad={l:48,r:42,t:14,b:28};
        const cW=W-pad.l-pad.r, cH=H-pad.t-pad.b;
        const maxCarga=1000, maxIGP=100;
        const n=labels.length;
        const bW=Math.max(4,cW/n*0.55), gap=cW/n;
        let bars='', lineP='', dots='', xLab='', yAxisL='', yAxisR='';
        // Left y-axis (carga 0-1000)
        for(let i=0;i<=4;i++){
          const v=250*i;
          const y=pad.t+cH-cH*i/4;
          yAxisL+=`<line x1="${pad.l}" x2="${W-pad.r}" y1="${y}" y2="${y}" stroke="#e5e7eb" stroke-width="1"/>`;
          yAxisL+=`<text x="${pad.l-4}" y="${y+4}" text-anchor="end" fill="#6b7280" font-size="8">${v}</text>`;
        }
        // Right y-axis (IGP 0-100)
        for(let i=0;i<=4;i++){
          const v=25*i;
          const y=pad.t+cH-cH*v/maxIGP;
          yAxisR+=`<text x="${W-pad.r+3}" y="${y+4}" text-anchor="start" fill="#1a56db" font-size="8">${v}</text>`;
        }
        let lineStarted=false;
        labels.forEach((lbl,i)=>{
          const xCenter=pad.l+i*gap+gap/2;
          const x=xCenter-bW/2;
          const cv=cargaVals[i];
          if(cv!=null&&cv>0){
            const bH=cH*Math.min(cv,maxCarga)/maxCarga;
            const by=pad.t+cH-bH;
            bars+=`<rect x="${x}" y="${by}" width="${bW}" height="${bH}" fill="${color}" rx="2" opacity="0.75"/>`;
            if(bW>18)bars+=`<text x="${xCenter}" y="${by-3}" text-anchor="middle" fill="${color}" font-size="7" font-weight="700">${cv}</text>`;
          }
          const iv=igpVals[i];
          if(iv!=null){
            const iy=pad.t+cH-cH*iv/maxIGP;
            if(!lineStarted){lineP+=`M${xCenter},${iy}`;lineStarted=true;}
            else lineP+=`L${xCenter},${iy}`;
            dots+=`<circle cx="${xCenter}" cy="${iy}" r="3" fill="#1a56db"/>`;
            if(n<=16)dots+=`<text x="${xCenter}" y="${iy-5}" text-anchor="middle" fill="#1a56db" font-size="7" font-weight="700">${iv}</text>`;
          }
          const step=Math.max(1,Math.ceil(n/12));
          if(i%step===0||i===n-1)xLab+=`<text x="${xCenter}" y="${H-2}" text-anchor="middle" fill="#6b7280" font-size="8">${esc(lbl)}</text>`;
        });
        return`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
          ${yAxisL}${yAxisR}${bars}
          ${lineP?`<path d="${lineP}" fill="none" stroke="#1a56db" stroke-width="1.5" stroke-dasharray="4,2"/>`:''}
          ${dots}${xLab}
        </svg>`;
      }

      // Full-period Volume (tempo) × PSE chart
      function buildVolumePSEChart(weeks, tempoVals, pseVals, labels){
        if(!weeks.length) return `<div style="font-family:'Inter',sans-serif;font-size:11px;color:#9ca3af;padding:20px;text-align:center;">Sem dados</div>`;
        const W=1040, H=140;
        const pad={l:48,r:48,t:14,b:28};
        const cW=W-pad.l-pad.r, cH=H-pad.t-pad.b;
        const maxTempo=Math.max(...tempoVals.filter(v=>v!=null),1)*1.1;
        const maxPSE=10;
        const n=labels.length;
        const bW=Math.max(4,cW/n*0.5), gap=cW/n;
        let bars='', lineP='', dots='', xLab='', yAxisL='', yAxisR='';
        for(let i=0;i<=4;i++){
          const v=Math.round(maxTempo*i/4);
          const y=pad.t+cH-cH*i/4;
          yAxisL+=`<line x1="${pad.l}" x2="${W-pad.r}" y1="${y}" y2="${y}" stroke="#e5e7eb" stroke-width="1"/>`;
          yAxisL+=`<text x="${pad.l-4}" y="${y+4}" text-anchor="end" fill="#6b7280" font-size="8">${v}</text>`;
        }
        for(let i=0;i<=5;i++){
          const v=2*i;
          const y=pad.t+cH-cH*v/maxPSE;
          yAxisR+=`<text x="${W-pad.r+3}" y="${y+4}" text-anchor="start" fill="#f97316" font-size="8">${v}</text>`;
        }
        let lineStarted=false;
        labels.forEach((lbl,i)=>{
          const xCenter=pad.l+i*gap+gap/2;
          const x=xCenter-bW/2;
          const tv=tempoVals[i];
          if(tv!=null&&tv>0){
            const bH=cH*tv/maxTempo;
            const by=pad.t+cH-bH;
            bars+=`<rect x="${x}" y="${by}" width="${bW}" height="${bH}" fill="#64748b" rx="2" opacity="0.65"/>`;
          }
          const pv=pseVals[i];
          if(pv!=null){
            const py=pad.t+cH-cH*Math.min(pv,maxPSE)/maxPSE;
            if(!lineStarted){lineP+=`M${xCenter},${py}`;lineStarted=true;}
            else lineP+=`L${xCenter},${py}`;
            dots+=`<circle cx="${xCenter}" cy="${py}" r="3" fill="#f97316"/>`;
          }
          const step=Math.max(1,Math.ceil(n/16));
          if(i%step===0||i===n-1)xLab+=`<text x="${xCenter}" y="${H-2}" text-anchor="middle" fill="#6b7280" font-size="8">${esc(lbl)}</text>`;
        });
        return`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
          ${yAxisL}${yAxisR}${bars}
          ${lineP?`<path d="${lineP}" fill="none" stroke="#f97316" stroke-width="1.5" stroke-dasharray="4,2"/>`:''}
          ${dots}${xLab}
        </svg>`;
      }

      const _chartF1=buildCargaIGPChart(_wf1.weeks,_wf1.cargaVals,_wf1.igpVals,_wf1.labels,TC);
      const _chartF2=buildCargaIGPChart(_wf2.weeks,_wf2.cargaVals,_wf2.igpVals,_wf2.labels,'#1a56db');
      const _chartVolPSE=buildVolumePSEChart(_wAll.weeks,_wAll.tempoVals,_wAll.pseVals,_wAll.labels);

      const _prontLegend=(cColor)=>`<div style="display:flex;gap:14px;margin-top:4px;margin-bottom:2px;">
        <span style="display:flex;align-items:center;gap:4px;font-family:'Inter',sans-serif;font-size:8px;color:#6b7280;">
          <span style="width:12px;height:10px;background:${cColor};border-radius:2px;opacity:0.75;display:inline-block;"></span>Carga UA (PSE×min) · eixo esq. 0–1000
        </span>
        <span style="display:flex;align-items:center;gap:4px;font-family:'Inter',sans-serif;font-size:8px;color:#6b7280;">
          <span style="width:16px;height:2px;background:#1a56db;display:inline-block;vertical-align:middle;"></span>IGP médio (0–100) · eixo dir.
        </span>
      </div>`;

      const pageTProntCarga=`<section class="page" style="${PST}width:1122px;height:793px;">
        ${TS2}
        <div style="padding:10px 28px 0;">
          <div style="font-family:'Archivo',sans-serif;font-size:16px;font-weight:800;color:#111827;margin-bottom:8px;">4 · Prontidão e Carga por Fase</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:10px;">
            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:12px 14px;">
              <div style="font-family:'Archivo',sans-serif;font-size:10px;font-weight:700;color:${TC};margin-bottom:1px;">■ Primeira Fase — Fase de Grupos · ${_wf1.weeks.length} semanas</div>
              ${_prontLegend(TC)}
              ${_chartF1}
              <div style="display:flex;gap:6px;margin-top:6px;">
                ${KPIT('Carga Média',_wf1.cargaVals.filter(v=>v!=null).length?Math.round(avg(_wf1.cargaVals.filter(v=>v!=null)))+'&nbsp;UA':'—','PSE×min',TC)}
                ${KPIT('IGP Médio',_wf1.igpVals.filter(v=>v!=null).length?Math.round(avg(_wf1.igpVals.filter(v=>v!=null))):'—','Prontidão global','#1a56db')}
                ${KPIT('PSE Média',_wf1.pseVals.filter(v=>v!=null).length?(avg(_wf1.pseVals.filter(v=>v!=null))).toFixed(1):'—','1–10','#64748b')}
              </div>
            </div>
            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:12px 14px;">
              <div style="font-family:'Archivo',sans-serif;font-size:10px;font-weight:700;color:#1a56db;margin-bottom:1px;">■ Segunda Fase — Mata-mata · ${_wf2.weeks.length} semanas</div>
              ${_prontLegend('#1a56db')}
              ${_chartF2}
              <div style="display:flex;gap:6px;margin-top:6px;">
                ${KPIT('Carga Média',_wf2.cargaVals.filter(v=>v!=null).length?Math.round(avg(_wf2.cargaVals.filter(v=>v!=null)))+'&nbsp;UA':'—','PSE×min','#1a56db')}
                ${KPIT('IGP Médio',_wf2.igpVals.filter(v=>v!=null).length?Math.round(avg(_wf2.igpVals.filter(v=>v!=null))):'—','Prontidão global','#1a56db')}
                ${KPIT('PSE Média',_wf2.pseVals.filter(v=>v!=null).length?(avg(_wf2.pseVals.filter(v=>v!=null))).toFixed(1):'—','1–10','#64748b')}
              </div>
            </div>
          </div>
          <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:12px 14px;">
            <div style="font-family:'Archivo',sans-serif;font-size:10px;font-weight:700;color:#374151;margin-bottom:2px;">Volume × PSE — Período Completo · ${_wAll.weeks.length} semanas</div>
            <div style="display:flex;gap:14px;margin-bottom:4px;">
              <span style="display:flex;align-items:center;gap:4px;font-family:'Inter',sans-serif;font-size:8px;color:#6b7280;">
                <span style="width:12px;height:10px;background:#64748b;border-radius:2px;opacity:0.65;display:inline-block;"></span>Volume (min) · eixo esq.
              </span>
              <span style="display:flex;align-items:center;gap:4px;font-family:'Inter',sans-serif;font-size:8px;color:#6b7280;">
                <span style="width:16px;height:2px;background:#f97316;display:inline-block;vertical-align:middle;"></span>PSE média (1–10) · eixo dir.
              </span>
            </div>
            ${_chartVolPSE}
          </div>
          <div style="margin-top:6px;font-family:'Inter',sans-serif;font-size:8px;color:#9ca3af;">UA = Unidade Arbitrária (PSE × minutos) · IGP = Índice Global de Prontidão · PSE = Percepção Subjetiva de Esforço (escala 1–10) · Volume = duração da sessão em minutos</div>
        </div>
      </section>`;

      // ─── Assemble and write ───────────────────────────────────────────────
      const tempPagesHtml=[pageT0,pageT1,pageT2,pageT3,pageTProntCarga,pageT4,pageT5a,pageT5b,pageT6a,pageT6b,pageT6c,pageT6d,pageT6e,pageT6f,pageT7].filter(Boolean).join('\n');
      const tempFullHtml=`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <base href="/">
  <title>Relatório de Temporada — ${esc(nomeClube)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;600;700;800;900&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js"></script>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{background:#e8e8e8;font-family:'Inter',sans-serif;}
    .toolbar{position:sticky;top:0;z-index:1000;background:${TC};color:#fff;display:flex;align-items:center;gap:12px;padding:8px 20px;}
    .toolbar button{background:#fff;color:${TC};border:none;border-radius:6px;padding:6px 14px;font-size:12px;font-weight:700;cursor:pointer;font-family:'Inter',sans-serif;}
    .toolbar button:hover{opacity:.9;}
    .toolbar .spacer{flex:1;}
    .page{display:block;margin:16px auto;box-shadow:0 4px 24px rgba(0,0,0,.18);}
    [contenteditable]:focus{outline:2px solid ${TC};border-radius:3px;}
    @media print{.toolbar{display:none!important;}.page{margin:0!important;box-shadow:none!important;page-break-after:always;}.page:last-child{page-break-after:avoid;}body{background:#fff;}}
  </style>
</head>
<body>
<div class="toolbar">
  <div style="font-weight:700;font-size:13px;">${esc(nomeClube)} · Relatório de Temporada</div>
  <div style="font-size:11px;opacity:.8;">${periodoLabel}</div>
  <div class="spacer"></div>
  <button onclick="exportarPDF()" id="btnExport">Exportar PDF</button>
</div>
${tempPagesHtml}
<script>
  async function exportarPDF(){
    const btn=document.getElementById('btnExport');
    btn.disabled=true;btn.textContent='Gerando PDF\u2026';
    try{
      const pages=[...document.querySelectorAll('.page')];
      const{jsPDF}=window.jspdf;
      const pdf=new jsPDF({orientation:'landscape',unit:'mm',format:'a4'});
      for(let i=0;i<pages.length;i++){
        btn.textContent='P\u00e1gina '+(i+1)+'/'+pages.length+'\u2026';
        const canvas=await html2canvas(pages[i],{scale:2,useCORS:true,backgroundColor:'#fff',width:1122,height:793,windowWidth:1200,logging:false});
        if(i>0)pdf.addPage([297,210],'landscape');
        pdf.addImage(canvas.toDataURL('image/jpeg',0.92),'JPEG',0,0,297,210);
      }
      pdf.save('relatorio_temporada_'+new Date().toLocaleDateString('en-CA')+'.pdf');
    }catch(e){alert('Erro ao exportar PDF: '+e.message);console.error(e);}
    finally{btn.disabled=false;btn.textContent='Exportar PDF';}
  }
<\/script>
</body>
</html>`;
      win.document.open();
      win.document.write(tempFullHtml);
      win.document.close();
      return;
    }

    const warningsConsoleJs=warnings.length?`
      document.getElementById('toggleWarnings')?.addEventListener('click',()=>{
        const c=document.getElementById('warningsConsole');
        if(c)c.style.display=c.style.display==='none'?'block':'none';
      });`:'';

    const fullHtml=`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <base href="/">
  <title>Relatório Geral — Fase de Grupos — ${esc(nomeClube)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;600;700;800;900&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js"></script>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{background:#e8e8e8;font-family:'Inter',sans-serif;}
    .toolbar{position:sticky;top:0;z-index:1000;background:#1a56db;color:#fff;display:flex;align-items:center;gap:12px;padding:8px 20px;print-color-adjust:exact;}
    .toolbar button{background:#fff;color:#1a56db;border:none;border-radius:6px;padding:6px 14px;font-size:12px;font-weight:700;cursor:pointer;font-family:'Inter',sans-serif;}
    .toolbar button:hover{background:#dbeafe;}
    .toolbar select{border-radius:6px;padding:5px 10px;font-size:12px;border:none;font-family:'Inter',sans-serif;cursor:pointer;}
    .toolbar .label{font-size:11px;opacity:.85;}
    .toolbar .spacer{flex:1;}
    .page{display:block;margin:16px auto;box-shadow:0 4px 24px rgba(0,0,0,.18);}
    .page-hidden{display:none!important;}
    [contenteditable]:focus{outline:2px solid #1a56db;border-radius:3px;}
    #warningsConsole{display:block;}
    @media print{
      .toolbar{display:none!important;}
      #warningsConsole{display:none!important;}
      .page{margin:0!important;box-shadow:none!important;page-break-after:always;}
      .page:last-child{page-break-after:avoid;}
      body{background:#fff;}
    }
  </style>
</head>
<body>
<div class="toolbar">
  <div style="font-weight:700;font-size:13px;">${esc(nomeClube)} · Relatório Geral — Fase de Grupos</div>
  <div class="label">${periodoLabel}</div>
  <div class="spacer"></div>
  <label style="font-size:11px;display:flex;align-items:center;gap:6px;">
    Escopo
    <select id="toolbarEscopo">
      <option value="completo"${escopo==='completo'?' selected':''}>Completo</option>
      <option value="essencial"${escopo==='essencial'?' selected':''}>Essencial (5 páginas-chave)</option>
    </select>
  </label>
  ${warnings.length?`<button id="toggleWarnings" title="Ver avisos de reconciliação" style="background:#fef3c7;color:#92400e;">⚠ ${warnings.length} Aviso${warnings.length>1?'s':''}</button>`:'' }
  <button onclick="exportarPDF()" id="btnExport">Exportar PDF</button>
</div>

${allPages}

${warnings.length?`<div id="warningsConsole" style="position:fixed;bottom:0;left:0;right:0;background:#fef3c7;border-top:2px solid #d97706;padding:8px 20px;font-family:monospace;font-size:11px;color:#92400e;z-index:9999;max-height:140px;overflow-y:auto;">
  <strong>⚠ Avisos de Reconciliação (${warnings.length})</strong><br>
  ${warnings.map(w=>`• ${esc(w)}`).join('<br>')}
</div>`:''}

<script>
  // Escopo filter
  function aplicarEscopo(val){
    document.querySelectorAll('.page').forEach(p=>{
      if(val==='essencial'&&p.dataset.essencial==='false'){
        p.classList.add('page-hidden');
      } else {
        p.classList.remove('page-hidden');
      }
    });
  }
  document.getElementById('toolbarEscopo')?.addEventListener('change',function(){aplicarEscopo(this.value);});
  aplicarEscopo('${escopo}');
  ${warningsConsoleJs}

  // PDF export
  async function exportarPDF(){
    const btn=document.getElementById('btnExport');
    btn.disabled=true;
    btn.textContent='Gerando PDF…';
    try{
      const pages=[...document.querySelectorAll('.page')].filter(p=>getComputedStyle(p).display!=='none');
      const {jsPDF}=window.jspdf;
      const pdf=new jsPDF({orientation:'landscape',unit:'mm',format:'a4'});
      for(let i=0;i<pages.length;i++){
        btn.textContent=\`Página \${i+1}/\${pages.length}…\`;
        const canvas=await html2canvas(pages[i],{scale:2,useCORS:true,backgroundColor:'#fff',width:1122,height:793,windowWidth:1200,logging:false});
        if(i>0)pdf.addPage([297,210],'landscape');
        pdf.addImage(canvas.toDataURL('image/jpeg',0.92),'JPEG',0,0,297,210);
      }
      pdf.save('relatorio_fase_'+new Date().toLocaleDateString('en-CA')+'.pdf');
    }catch(e){alert('Erro ao exportar PDF: '+e.message);console.error(e);}
    finally{btn.disabled=false;btn.textContent='Exportar PDF';}
  }
<\/script>
</body>
</html>`;

    win.document.open();
    win.document.write(fullHtml);
    win.document.close();

  } catch(err) {
    console.error('[relatorio_geral] Erro:', err);
    win.document.open();
    win.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Erro</title></head><body style="font-family:sans-serif;padding:40px;color:#dc2626;"><h2>Erro ao gerar relatório</h2><pre style="background:#f9fafb;padding:16px;border-radius:8px;font-size:12px;white-space:pre-wrap;">${esc(err?.message||String(err))}</pre><button onclick="window.close()">Fechar</button></body></html>`);
    win.document.close();
  }
}
