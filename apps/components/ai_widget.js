/**
 * ai_widget.js — Mini widget do Analista IA
 * Usado em dashboard.html e prontidao.html
 * Auto-inicializa ao ser importado como módulo.
 */
import { db } from '../core/firebase.js';
import {
  collection, getDocs, query, where
} from 'https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js';
import {
  getFunctions, httpsCallable
} from 'https://www.gstatic.com/firebasejs/11.0.1/firebase-functions.js';

/* ── Config ─────────────────────────────────────── */
const askAi = httpsCallable(getFunctions(), 'askAi', { timeout: 120000 });

const SYSTEM_SHORT = `Você é o Analista IA da Ciente IE. Responda em português, de forma direta e objetiva em no máximo 5 linhas. Use apenas os dados fornecidos. Nunca prescreva treinos nem faça diagnósticos médicos.`;

/* ── Quick questions por contexto de página ─────── */
const QUICK_BY_PAGE = {
  dashboard: [
    { label: 'Como está o grupo hoje?',       q: 'Como está o grupo hoje?',             intent: 'resumo_dia'   },
    { label: 'Quem está em atenção?',          q: 'Quem está em atenção hoje?',          intent: 'atencao'      },
    { label: 'Como foi o dia de treino?',      q: 'Como foi o dia de treino hoje?',      intent: 'dia_treino'   },
  ],
  prontidao: [
    { label: 'Como está o grupo hoje?',        q: 'Como está o grupo hoje?',             intent: 'resumo_dia'   },
    { label: 'Como foi o dia de treino?',      q: 'Como foi o dia de treino hoje?',      intent: 'dia_treino'   },
    { label: 'Quem está se adaptando pior?',   q: 'Quem está se adaptando pior à carga?', intent: 'adaptacao'  },
  ],
};

/* ── Helpers ─────────────────────────────────────── */
const pad2    = n  => String(n).padStart(2, '0');
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`; };
const daysAgoISO = n => { const d = new Date(); d.setDate(d.getDate()-n); return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`; };

function getClubId()  { return JSON.parse(localStorage.getItem('userContext') || '{}').clubId || ''; }

function pageContext() {
  const p = window.location.pathname;
  if (p.includes('prontidao')) return 'prontidao';
  return 'dashboard';
}

/* ── IGP simplificado ────────────────────────────── */
function calcIH(h)    { return h == null ? null : Math.max(0, Math.min(100, Math.round(100 - ((h-4)/24)*100))); }
function calcIA(ln)   {
  if (ln == null) return null;
  const pts = [[1.5,5],[2.5,35],[3.0,50],[3.5,65],[4.0,80],[4.5,92],[5.5,98]];
  if (ln <= pts[0][0]) return pts[0][1];
  if (ln >= pts[pts.length-1][0]) return pts[pts.length-1][1];
  for (let i=1;i<pts.length;i++) if (ln<=pts[i][0]) { const t=(ln-pts[i-1][0])/(pts[i][0]-pts[i-1][0]); return Math.round(pts[i-1][1]+t*(pts[i][1]-pts[i-1][1])); }
  return 65;
}
function calcINM(s)   {
  if (s == null) return null;
  const pts = [[10,10],[20,30],[30,50],[35,60],[40,70],[45,80],[50,88],[60,97]];
  if (s <= pts[0][0]) return pts[0][1];
  if (s >= pts[pts.length-1][0]) return pts[pts.length-1][1];
  for (let i=1;i<pts.length;i++) if (s<=pts[i][0]) { const t=(s-pts[i-1][0])/(pts[i][0]-pts[i-1][0]); return Math.round(pts[i-1][1]+t*(pts[i][1]-pts[i-1][1])); }
  return 50;
}
function calcIGP(pre, hrv, neuro) {
  const IA = hrv?.score != null ? Math.round(Math.max(0, Math.min(100, hrv.score))) : calcIA(hrv?.lnRR ?? null);
  const scores = [calcIH(pre?.hooper), IA, calcINM(pre?.salto), neuro?.score != null ? Math.round(Math.max(0, Math.min(100, neuro.score))) : null].filter(s=>s!=null);
  if (!scores.length) return null;
  const media = scores.reduce((a,b)=>a+b,0)/scores.length;
  const pior  = Math.max(Math.min(...scores), 30);
  return Math.max(0, Math.min(100, Math.round(media*0.8+pior*0.2)));
}
function classifyIGP(v) {
  if (v==null) return 'Sem coleta';
  if (v>=70) return 'Estável'; if (v>=60) return 'Atenção Leve'; if (v>=50) return 'Atenção'; return 'Crítico';
}

/* ── Contextos de dados ──────────────────────────── */
async function buildCtx(intent, clubId) {
  const today = todayISO();

  // Carrega atletas e métricas do dia
  const [athSnap, metSnap] = await Promise.all([
    getDocs(query(collection(db,'athletes'), where('clubId','==',clubId), where('ativo','==',true))),
    getDocs(query(collection(db,'daily_metrics'), where('clubId','==',clubId), where('date','==',today)))
  ]);
  const athletes = athSnap.docs.map(d=>({id:d.id,...d.data()}));
  const metrics  = metSnap.docs.map(d=>d.data());
  const athMap   = {};
  athletes.forEach(a=>{ athMap[a.id]={nome:a.nome, posicao:a.posicao}; });

  if (intent === 'dia_treino') {
    const comPost = metrics.filter(m => m.post?.carga || m.post?.pse);
    if (!comPost.length) return 'Nenhum dado de pós-treino registrado hoje ainda.';

    const avgPSE  = comPost.reduce((s,m)=>s+(m.post?.pse??0),0)/comPost.length;
    const cargaTot= comPost.reduce((s,m)=>s+(m.post?.carga??0),0);
    const avgQual = comPost.reduce((s,m)=>s+(m.post?.qualidade??0),0)/comPost.length;
    const avgTempo= comPost.reduce((s,m)=>s+(m.post?.tempo??0),0)/comPost.length;

    let ctx = `DADOS PÓS-TREINO (${today}):\n`;
    ctx += `Atletas com registro: ${comPost.length}/${athletes.length}\n`;
    ctx += `PSE médio: ${avgPSE.toFixed(1)} | Carga total do grupo: ${cargaTot.toFixed(0)} UA | Qualidade média: ${avgQual.toFixed(1)}/5 | Duração média: ${avgTempo.toFixed(0)} min\n\n`;
    ctx += 'INDIVIDUAL:\n';
    comPost.forEach(m => {
      const a = athMap[m.athleteId];
      if (!a) return;
      const alerta = (m.post?.pse??0) >= 8 ? ' ⚠ PSE alto' : (m.post?.qualidade??5) <= 2 ? ' ⚠ Qualidade baixa' : '';
      ctx += `• ${a.nome} (${a.posicao}) | PSE ${m.post?.pse??'—'} | Carga ${m.post?.carga??'—'} UA | Qualidade ${m.post?.qualidade??'—'}/5 | ${m.post?.tempo??'—'} min${alerta}\n`;
    });
    return ctx;
  }

  if (intent === 'atencao' || intent === 'resumo_dia') {
    const list = athletes.map(a => {
      const dm = metrics.find(m=>m.athleteId===a.id);
      const igp = dm ? calcIGP(dm.pre, dm.hrv, dm.neuro) : null;
      return { nome: a.nome, posicao: a.posicao, igp, status: classifyIGP(igp) };
    });
    const w = list.filter(r=>r.igp!=null);
    let ctx = `RESUMO DO DIA (${today}):\n`;
    ctx += `Com coleta: ${w.length}/${athletes.length} | Estável: ${w.filter(r=>r.igp>=70).length} | Atenção Leve: ${w.filter(r=>r.igp>=60&&r.igp<70).length} | Atenção: ${w.filter(r=>r.igp>=50&&r.igp<60).length} | Crítico: ${w.filter(r=>r.igp<50).length}\n`;
    if (intent === 'atencao') {
      ctx += '\nATLETAS EM ATENÇÃO:\n';
      list.filter(r=>r.igp!=null&&r.igp<70).forEach(r=>{ ctx += `• ${r.nome} (${r.posicao}) | IGP ${r.igp} — ${r.status}\n`; });
    } else {
      ctx += '\nTODOS:\n';
      list.forEach(r=>{ ctx += `• ${r.nome} (${r.posicao}) | IGP ${r.igp??'—'} — ${r.status}\n`; });
    }
    return ctx;
  }

  if (intent === 'adaptacao') {
    const start = daysAgoISO(7);
    const snap7 = await getDocs(query(collection(db,'daily_metrics'), where('clubId','==',clubId), where('date','>=',start), where('date','<=',today)));
    const hist   = snap7.docs.map(d=>d.data());
    let ctx = `ADAPTAÇÃO À CARGA — 7 DIAS:\n`;
    athletes.forEach(a => {
      const dias = hist.filter(m=>m.athleteId===a.id).sort((x,y)=>x.date.localeCompare(y.date));
      if (!dias.length) return;
      const igps   = dias.map(d=>calcIGP(d.pre,d.hrv,d.neuro)).filter(v=>v!=null);
      const carga  = dias.reduce((s,d)=>s+(d.post?.carga??0),0);
      const aguda  = dias.slice(-7).reduce((s,d)=>s+(d.post?.carga??0),0);
      const cronica= dias.length>=4 ? dias.reduce((s,d)=>s+(d.post?.carga??0),0)/Math.ceil(dias.length/7) : null;
      const acwr   = cronica&&cronica>0 ? (aguda/cronica).toFixed(2) : null;
      const igpMed = igps.length ? Math.round(igps.reduce((a,b)=>a+b,0)/igps.length) : null;
      if ((acwr&&acwr>1.3) || (igpMed&&igpMed<60)) ctx += `• ${a.nome} | IGP médio ${igpMed??'—'} | Carga 7d: ${carga} UA | ACWR: ${acwr??'—'}\n`;
    });
    return ctx || 'Nenhum atleta com sinal de má adaptação identificado.';
  }

  return `Dados do dia ${today} para ${athletes.length} atletas carregados.`;
}

/* ── Gemini call ─────────────────────────────────── */
async function askGemini(contextStr, question) {
  const result = await askAi({
    provider: 'gemini', context: contextStr, question,
    systemPrompt: SYSTEM_SHORT, maxTokens: 400
  });
  return result.data?.text || 'Sem resposta.';
}

/* ── Injeção de estilos ──────────────────────────── */
function injectStyles() {
  if (document.getElementById('ai-widget-style')) return;
  const s = document.createElement('style');
  s.id = 'ai-widget-style';
  s.textContent = `
    #aiWidgetBtn { position:fixed;top:18px;right:18px;z-index:900;display:flex;align-items:center;gap:6px;padding:7px 14px;background:#1d4ed8;color:#fff;border:none;border-radius:999px;font-size:12px;font-weight:700;cursor:pointer;box-shadow:0 2px 12px rgba(29,78,216,.45);transition:background .15s; }
    #aiWidgetBtn:hover { background:#2563eb; }
    #aiWidgetPanel { position:fixed;top:58px;right:18px;z-index:901;width:340px;background:#0f172a;border:1px solid #334155;border-radius:18px;box-shadow:0 8px 32px rgba(0,0,0,.6);display:none;flex-direction:column;overflow:hidden; }
    #aiWidgetPanel.open { display:flex; }
    .aiwq-btn { background:#1e293b;border:1px solid #334155;border-radius:10px;padding:7px 12px;font-size:12px;font-weight:600;color:#94a3b8;cursor:pointer;text-align:left;transition:all .15s; }
    .aiwq-btn:hover { background:#334155;color:#e2e8f0; }
    #aiWidgetResp { max-height:220px;overflow-y:auto;font-size:12px;line-height:1.6;color:#cbd5e1;white-space:pre-wrap;padding:12px 14px;border-top:1px solid #1e293b; }
    #aiWidgetInput { flex:1;background:#1e293b;border:1px solid #334155;border-radius:8px;padding:6px 10px;font-size:12px;color:#fff;outline:none; }
    #aiWidgetInput::placeholder { color:#475569; }
    #aiWidgetSend { background:#1d4ed8;color:#fff;border:none;border-radius:8px;padding:6px 12px;font-size:13px;cursor:pointer;font-weight:700; }
    #aiWidgetSend:hover { background:#2563eb; }
    .ai-typing-dot { display:inline-block;width:5px;height:5px;border-radius:50%;background:#64748b;animation:aiDot 1.2s infinite; }
    .ai-typing-dot:nth-child(2){animation-delay:.2s}.ai-typing-dot:nth-child(3){animation-delay:.4s}
    @keyframes aiDot{0%,80%,100%{opacity:.2}40%{opacity:1}}
  `;
  document.head.appendChild(s);
}

/* ── Render do widget ────────────────────────────── */
function buildWidget(clubId) {
  injectStyles();
  const ctx  = pageContext();
  const qs   = QUICK_BY_PAGE[ctx] || QUICK_BY_PAGE.dashboard;

  // Botão flutuante
  const btn = document.createElement('button');
  btn.id = 'aiWidgetBtn';
  btn.innerHTML = '<span style="font-size:14px">🤖</span> IA';

  // Painel
  const panel = document.createElement('div');
  panel.id = 'aiWidgetPanel';
  panel.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid #1e293b;">
      <span style="font-weight:800;color:#fff;font-size:13px;">🤖 Analista IA</span>
      <div style="display:flex;align-items:center;gap:8px;">
        <a href="/staff/analista_ia.html" style="font-size:10px;color:#60a5fa;">Abrir completo →</a>
        <button id="aiWidgetClose" style="background:none;border:none;color:#64748b;cursor:pointer;font-size:16px;line-height:1;">✕</button>
      </div>
    </div>
    <div id="aiWidgetResp" style="display:none;"></div>
    <div style="padding:10px 12px;border-top:1px solid #1e293b;display:flex;gap:6px;">
      <input id="aiWidgetInput" placeholder="Pergunte algo sobre o elenco…">
      <button id="aiWidgetSend">→</button>
    </div>`;

  document.body.appendChild(btn);
  document.body.appendChild(panel);

  // Toggle
  btn.addEventListener('click', () => panel.classList.toggle('open'));
  document.getElementById('aiWidgetClose').addEventListener('click', () => panel.classList.remove('open'));

  // Input send
  const inp = document.getElementById('aiWidgetInput');
  document.getElementById('aiWidgetSend').addEventListener('click', () => { if(inp.value.trim()) run(inp.value.trim(), 'livre'); });
  inp.addEventListener('keydown', e => { if(e.key==='Enter' && inp.value.trim()) run(inp.value.trim(), 'livre'); });

  async function run(question, intent) {
    const resp = document.getElementById('aiWidgetResp');
    resp.style.display = 'block';
    resp.innerHTML = '<span class="ai-typing-dot"></span><span class="ai-typing-dot"></span><span class="ai-typing-dot"></span>';
    inp.value = '';
    try {
      const ctx = await buildCtx(intent, clubId);
      const answer = await askGemini(ctx, question);
      resp.textContent = answer;
    } catch(e) {
      resp.textContent = `Erro: ${e.message}`;
    }
  }
}

/* ── Init ────────────────────────────────────────── */
(function init() {
  localStorage.removeItem('gemini_api_key');
  const clubId = getClubId();
  if (!clubId) {
    // Aguarda auth
    const t = setInterval(() => {
      const id = getClubId();
      if (id) { clearInterval(t); buildWidget(id); }
    }, 500);
    return;
  }
  buildWidget(clubId);
})();
