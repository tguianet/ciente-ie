import { db, auth } from "../core/firebase.js";
import { collection, getDocs, query, where, doc, getDoc, setDoc, serverTimestamp } from
  "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";
import { gerarBriefing } from "../core/briefing_engine.js";
import { gerarSessao, calcMotorFlags } from "../core/session_engine.js";

/* ─── CACHE DE PREFETCH (sessionStorage) ─────────────────────────────────────
   O splash (staff/index.html) pré-carrega as coleções principais.
   Aqui lemos do cache se disponível (< 5 min), senão buscamos no Firestore.
   ─────────────────────────────────────────────────────────────────────────── */
const DASH_CACHE_TTL = 5 * 60 * 1000;

function _revive(val) {
  if (val === null || val === undefined) return val;
  if (val && typeof val === 'object' && val._ts)
    return { toDate: () => new Date(val._ts), seconds: new Date(val._ts).getTime() / 1000 };
  if (Array.isArray(val)) return val.map(_revive);
  if (val && typeof val === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(val)) out[k] = _revive(v);
    return out;
  }
  return val;
}

function _snapFromCache(name) {
  try {
    const raw = sessionStorage.getItem('dash_' + name);
    if (!raw) return null;
    const { ts, docs } = JSON.parse(raw);
    if (Date.now() - ts > DASH_CACHE_TTL) return null;
    const wrapped = docs.map(({ id, data }) => ({ id, data: () => _revive(data) }));
    return { empty: wrapped.length === 0, docs: wrapped, forEach: fn => wrapped.forEach(fn) };
  } catch { return null; }
}

async function _getDocsCache(name, q) {
  const cached = _snapFromCache(name);
  if (cached) { console.debug('[cache hit]', name); return cached; }
  console.debug('[cache miss]', name);
  return getDocs(q);
}
import { onAuthStateChanged } from
  "https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js";
import { computeIfMissing } from "../core/recommendation_engine.js";
import {
  calcularHooperScore, calcularZScoreCMJ, calcularIndicadorVFC,
  calcularIndicadorNeuro, calcularProntidao as _calcularProntidao,
  calcularISPTendencia as _calcularISPTendencia, mapNeuro, moduladorHooper,
  zRawCMJ, zRawVFC, zRawHooper, zRawNeuro,
} from "../core/stats.js";

let CLUB_ID = null;
let CLUB_NAME = null;
let CLUB_LOGO = null;

/* =====================================================
   MICROCICLO — leitura do localStorage do planejamento
===================================================== */
function _getMicrocicloCtx() {
  // Tenta encontrar a chave da semana atual
  const hoje = new Date();
  function getISOWeek(d) {
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
    const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    return Math.ceil((((t - y) / 86400000) + 1) / 7);
  }
  const semana = `S${getISOWeek(hoje)}-${hoje.getFullYear()}`;
  const clubId = JSON.parse(localStorage.getItem('userContext') || '{}').clubId || '';
  const chave  = `microciclo_${semana}_${clubId}`;
  const raw    = localStorage.getItem(chave);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function calcularDiaMicrociclo() {
  // Manual reference set on planning page takes priority over auto-calculation
  const _clubId = JSON.parse(localStorage.getItem('userContext') || '{}').clubId || '';
  const _manual = _getMicrocicloManualDia(new Date().toLocaleDateString('en-CA'), _clubId);
  if (_manual?.label) return _manual;

  const ctx = _getMicrocicloCtx();
  if (!ctx) return null;

  const hoje = new Date(); hoje.setHours(0,0,0,0);
  const periodo = ctx.periodo || 'Preparação';

  function parseLocal(str) {
    const [y,m,d] = str.split('-').map(Number);
    const dt = new Date(y, m-1, d); dt.setHours(0,0,0,0); return dt;
  }
  function diffDias(a, b) { return Math.round((a - b) / 86400000); }

  const objs = {
    D1: { label: 'D1', objetivo: 'Reativação',    detalhe: 'Fortalecimento neuromuscular — início do ciclo de carga',              cor: '#3b82f6' },
    D2: { label: 'D2', objetivo: 'Sobrecarga I',  detalhe: 'Desenvolvimento metabólico — resistência aeróbica e capacidade glicolítica', cor: '#f97316' },
    D3: { label: 'D3', objetivo: 'Sobrecarga II', detalhe: 'Pico de carga — força, alta solicitação neuromuscular',                     cor: '#ef4444' },
    D4: { label: 'D4', objetivo: 'Dissipação',    detalhe: 'Redução de carga — início da dissipação da fadiga acumulada',               cor: '#8b5cf6' },
    D5: { label: 'D5', objetivo: 'Potenciação',   detalhe: 'Baixo volume — manutenção da excitabilidade neural',                        cor: '#10b981' },
    D6: { label: 'D6', objetivo: 'Manutenção',    detalhe: 'Carga e exigências física-cognitiva semelhantes ao jogo competitivo',       cor: '#6b7280' },
    D7: { label: 'D7', objetivo: 'Folga',         detalhe: 'Folga — recuperação espontânea',                                            cor: '#9ca3af' },
  };

  // Se há jogo na semana (qualquer período), usa lógica MD-X com D1/D2 no início
  if (ctx.jogoA) {
    const jogoA = parseLocal(ctx.jogoA);
    const jogoB = ctx.jogoB ? parseLocal(ctx.jogoB) : null;

    if (jogoB) {
      const dA = diffDias(hoje, jogoA);
      const dB = diffDias(hoje, jogoB);
      if (dA === 0) return { periodo, label: 'Jogo A',      objetivo: 'Competição',            detalhe: 'Jogo — mobilização máxima de todos os sistemas',                        cor: '#1d4ed8' };
      if (dB === 0) return { periodo, label: 'Jogo B',      objetivo: 'Competição',            detalhe: 'Jogo — mobilização máxima de todos os sistemas',                        cor: '#1d4ed8' };
      if (dA === 1) return { periodo, label: 'MD+1',        objetivo: 'Repouso ou Recovery',          detalhe: 'Pico de fadiga pós-jogo — repouso e início da ressíntese de glicogênio', cor: '#8b5cf6' };
      if (dB === -1) return { periodo, label: 'MD-1 (B)',   objetivo: 'Ativação',              detalhe: 'Ativação leve — mobilização neural sem acúmulo de fadiga',              cor: '#10b981' };
      if (dB === -2) return { periodo, label: 'MD-2 (B)',   objetivo: 'Reativação',            detalhe: 'Recuperação parcial — reestimulação neuromuscular controlada',          cor: '#f59e0b' };
      return { periodo, label: 'Semana dupla', objetivo: 'Recuperação', detalhe: 'Semana comprimida', cor: '#6b7280' };
    }

    const diff = diffDias(hoje, jogoA);
    const mapa = {
       '0':  { label: 'MD0',  objetivo: 'Competição',            detalhe: 'Jogo — mobilização máxima de todos os sistemas',                        cor: '#1d4ed8' },
       '1':  { label: 'MD+1', objetivo: 'Repouso ou Recovery',           detalhe: 'Pico de fadiga pós-jogo — repouso e início da ressíntese de glicogênio', cor: '#8b5cf6' },
       '2':  { label: 'MD+2', objetivo: 'Regenerativo', detalhe: 'Recuperação ativa — redução de metabólitos',                          cor: '#7c3aed' },
       '3':  { label: 'MD+3', objetivo: 'Adaptação', detalhe: 'Estímulo aeróbio e neuromuscular',                                  cor: '#6366f1' },
      '-3':  { label: 'MD-3', objetivo: 'Potenciação',          detalhe: 'Última sessão de alta carga — força e demanda neuromuscular elevada',    cor: '#ef4444' },
      '-2':  { label: 'MD-2', objetivo: 'Reconstrução',         detalhe: 'Redução de volume — velocidade e qualidade de movimento em foco',        cor: '#f97316' },
      '-1':  { label: 'MD-1', objetivo: 'Ativação',             detalhe: 'Baixo volume — ativação neural e preservação do estado de prontidão',    cor: '#10b981' },
    };
    if (diff <= -4) {
      const dow = hoje.getDay();
      if (dow === 1) return { periodo, ...objs['D1'] };
      if (dow === 2) return { periodo, ...objs['D2'] };
      if (dow === 3) return { periodo, ...objs['D3'] };
    }
    return { periodo, ...(mapa[String(diff)] || { label: '—', objetivo: 'Fora do microciclo', detalhe: '', cor: '#9ca3af' }) };
  }

  // Sem jogo na semana — Preparação/Transição: D1–D7 por dia da semana
  if (periodo === 'Preparação' || periodo === 'Transição') {
    const diasSemana = ['D7','D1','D2','D3','D4','D5','D6'];
    const labelEfetivo = diasSemana[hoje.getDay()];
    return { periodo, ...(objs[labelEfetivo] || objs['D7']) };
  }

  // Competitivo sem jogo cadastrado
  return { periodo, label: '—', objetivo: 'Sem jogo cadastrado', detalhe: '', cor: '#9ca3af' };
}

function _getMicrocicloManualDia(dateStr, clubId, grupo) {
  // Try group-specific key first (if grupo provided), then fall back to Oficial
  const suf = (grupo && grupo !== 'Oficial') ? `_${grupo}` : '';
  const raw = localStorage.getItem(`microciclo_dia_${dateStr}_${clubId}${suf}`);
  if (raw) { try { return JSON.parse(raw); } catch { /* fall through */ } }
  if (suf) {
    const rawOf = localStorage.getItem(`microciclo_dia_${dateStr}_${clubId}`);
    if (rawOf) { try { return JSON.parse(rawOf); } catch { return null; } }
  }
  return null;
}

function _getActiveDashGroup() {
  const val = document.getElementById('dashFiltroGrupo')?.value || '';
  // Only return if it's a real group, not a generic filter value
  if (val === 'G1' || val === 'G2' || val === 'G3' || val === 'G4' || val === 'Transição - RTP' || val === 'Restrição') return val;
  // Check mc_groups_config to find the oficial group
  try {
    const clubId = JSON.parse(localStorage.getItem('userContext') || '{}').clubId || '';
    const cfg = JSON.parse(localStorage.getItem(`mc_groups_config_${clubId}`) || 'null');
    return cfg?.oficial || 'Oficial';
  } catch { return 'Oficial'; }
}

async function obterContextoMicrocicloFinal() {
  // Manual reference set by coach on the planning page takes priority
  const clubId = JSON.parse(localStorage.getItem('userContext') || '{}').clubId || '';
  const hojStr = new Date().toLocaleDateString('en-CA');
  const grupo  = _getActiveDashGroup();
  const manual = _getMicrocicloManualDia(hojStr, clubId, grupo);
  if (manual?.label) return manual;

  const mc = calcularDiaMicrociclo();
  // Se o planejamento já tem MD+/MD- ou é dia de jogo, usar direto
  const label = mc?.label || '';
  if (label.startsWith('MD') || label === 'Jogo A' || label === 'Jogo B') return mc;

  // Caso contrário (Dx por dia da semana, ou null), consultar scout_partidas
  if (!clubId) return mc;

  try {
    const hoje = new Date(); hoje.setHours(0,0,0,0);
    const hojStr2 = hoje.toISOString().slice(0,10);
    const d4ago  = new Date(hoje.getTime() - 4 * 86400000).toISOString().slice(0,10);
    const d4fte  = new Date(hoje.getTime() + 4 * 86400000).toISOString().slice(0,10);

    // Busca sem filtro de range para evitar necessidade de índice composto no Firestore.
    // Filtra client-side (coleção pequena — ~50 jogos/temporada).
    const snap = await getDocs(query(
      collection(db, 'scout_partidas'),
      where('clubId', '==', clubId)
    ));
    const todasPartidas = [];
    snap.forEach(d => {
      const p = d.data();
      // Normaliza: converte Timestamp para string "YYYY-MM-DD" se necessário
      if (p.data?.toDate) p.data = p.data.toDate().toLocaleDateString('en-CA');
      todasPartidas.push(p);
    });
    const partidas = todasPartidas.filter(p => typeof p.data === 'string' && p.data >= d4ago && p.data <= d4fte);
    if (!partidas.length) return mc;

    const passadas = partidas.filter(p => p.data < hojStr2).sort((a,b) => b.data.localeCompare(a.data));
    const futuras  = partidas.filter(p => p.data > hojStr2).sort((a,b) => a.data.localeCompare(b.data));
    const hojeJogo = partidas.some(p => p.data === hojStr2);
    const periodo  = mc?.periodo || 'Competição';

    const mapaMais = {
      1: { label:'MD+1', objetivo:'Repouso ou Recovery',              detalhe:'Pico de fadiga pós-jogo — repouso e início da ressíntese de glicogênio', cor:'#8b5cf6' },
      2: { label:'MD+2', objetivo:'Regenerativo',  detalhe:'Retomada leve — monitorar VFC e dor muscular',                          cor:'#7c3aed' },
      3: { label:'MD+3', objetivo:'Adaptação', detalhe:'Estímulo aeróbio e neuromuscular',                                      cor:'#6366f1' },
    };
    const mapaMenos = {
      1: { label:'MD-1', objetivo:'Ativação',     detalhe:'Baixo volume — ativação neural e preservação do estado de prontidão', cor:'#10b981' },
      2: { label:'MD-2', objetivo:'Reconstrução', detalhe:'Redução de volume — velocidade e qualidade de movimento em foco',     cor:'#f97316' },
      3: { label:'MD-3', objetivo:'Potenciação',  detalhe:'Última sessão de alta carga — força e demanda neuromuscular elevada', cor:'#ef4444' },
    };

    if (hojeJogo) return { periodo, label:'MD0', objetivo:'Competição', detalhe:'Jogo — mobilização máxima de todos os sistemas', cor:'#1d4ed8' };

    if (futuras.length) {
      const diasAte = Math.round((new Date(futuras[0].data + 'T00:00:00') - hoje) / 86400000);
      if (diasAte <= 3 && mapaMenos[diasAte]) return { periodo, ...mapaMenos[diasAte] };
    }
    if (passadas.length) {
      const diasDesde = Math.round((hoje - new Date(passadas[0].data + 'T00:00:00')) / 86400000);
      if (diasDesde <= 3 && mapaMais[diasDesde]) return { periodo, ...mapaMais[diasDesde] };
    }
  } catch(e) {
    console.warn('obterContextoMicrocicloFinal:', e);
  }
  return mc;
}

async function renderBannerMicrociclo(containerId = 'bannerMicrociclo') {
  const el = document.getElementById(containerId);
  if (!el) return;
  const mc = await obterContextoMicrocicloFinal();
  if (!mc) { el.style.display = 'none'; return; }
  if (mc.label === '—') {
    if (mc.objetivo === 'Sem jogo cadastrado') {
      el.style.display = 'flex';
      el.style.flexWrap = 'wrap';
      el.innerHTML = `<span style="font-size:12px;color:#93c5fd;font-style:italic;">⚽ Cadastre um jogo no Planejamento para ver o contexto do microciclo.</span>`;
      return;
    }
    el.style.display = 'none'; return;
  }
  el.style.display = 'flex';
  el.style.flexWrap = 'wrap';
  el.innerHTML = `
    <span style="background:${mc.cor};color:#fff;font-size:12px;font-weight:800;padding:5px 14px;border-radius:20px;white-space:nowrap;letter-spacing:.03em;">${mc.label}</span>
    <span style="font-size:13px;font-weight:700;color:#ffffff;">${mc.objetivo}</span>
    <span style="font-size:11px;color:#93c5fd;flex:1;min-width:80px;">${mc.detalhe}</span>
    <span style="font-size:11px;color:#64748b;background:#f1f5f9;padding:2px 10px;border-radius:20px;white-space:nowrap;">Período · ${mc.periodo}</span>
  `;
}

async function sincronizarMicrocicloFirestore() {
  try {
    const clubId = JSON.parse(localStorage.getItem('userContext') || '{}').clubId || '';
    if (!clubId) return;

    const hoje = new Date();
    function getISOWeek(d) {
      const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
      t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
      const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
      return Math.ceil((((t - y) / 86400000) + 1) / 7);
    }
    const semana = `S${getISOWeek(hoje)}-${hoje.getFullYear()}`;
    const chave  = `microciclo_${semana}_${clubId}`;

    let data = null;

    const snap = await getDoc(doc(db, 'assessments_planning', `${semana}_${clubId}`));
    if (snap.exists()) {
      data = snap.data();
    } else {
      // Fallback: documentos legados salvos com addDoc têm campo "week" em vez de ID composto
      const legado = await getDocs(query(
        collection(db, 'assessments_planning'),
        where('week',   '==', semana),
        where('clubId', '==', clubId)
      ));
      if (!legado.empty) data = legado.docs[0].data();
    }

    if (!data) return;
    const sorted = [...(data.jogos || [])].sort((a, b) => a.data.localeCompare(b.data));

    localStorage.setItem(chave, JSON.stringify({
      jogoA:        sorted[0]?.data || null,
      jogoB:        sorted[1]?.data || null,
      periodo:      data.periodo    || 'Preparação',
      jogos:        data.jogos      || [],
      diasComTreino: Object.entries(data.sessions || {})
        .filter(([, v]) => v && v.length > 0)
        .map(([dia]) => dia),
    }));

    // Constrói mapa inverso athleteId → grupo para o grid de cards
    if (data.gruposAtletas) {
      _gruposAtletasDash = {};
      Object.entries(data.gruposAtletas).forEach(([grupo, ids]) => {
        (ids || []).forEach(id => { _gruposAtletasDash[id] = grupo; });
      });
    }

    // Restaura rótulo manual do dia atual (microciclo_dias) se não estiver no localStorage
    const hojStr = hoje.toLocaleDateString('en-CA');
    const chaveManual = `microciclo_dia_${hojStr}_${clubId}`;
    if (!localStorage.getItem(chaveManual)) {
      const snapDia = await getDoc(doc(db, 'microciclo_dias', `${hojStr}_${clubId}`));
      if (snapDia.exists()) {
        const { label, objetivo, detalhe, cor, periodo } = snapDia.data();
        localStorage.setItem(chaveManual, JSON.stringify({ label, objetivo, detalhe, cor, periodo }));
      }
    }

    renderBannerMicrociclo('bannerMicrociclo');
  } catch(e) {
    console.warn('sincronizarMicrocicloFirestore:', e);
  }
}

// Protocolos pós-treino (usados no Status Diário e no PDF)
const _posMapSistema = {
  'Autonômico':    'Pulsetto 15 min (Stress) · Respiração 4-7-8 5 ciclos · sem PAP',
  'Neuromuscular': 'Gelo localizado 15 min · Foam roller posterior 5 min · Bota Pneumática 25 min · 80 mmHg',
  'Cognitivo':     'Respiração 4-7-8 5 ciclos · Silêncio 5 min · Visualização 2 min',
  'Subjetivo':     'Foam roller global 5 min · Alongamento passivo 8 min · Respiração 4-7-8 3 ciclos',
};
const _posMapMicro = {
  'MD+1':'Bota Pneumática 30 min + Gelo localizado 15 min · Pulsetto 15 min · recovery obrigatório',
  'MD+2':'Foam roller global 5 min + Hidroterapia 10 min fria · Alongamento passivo 8 min',
  'MD+3':'Bota Pneumática 20 min + Foam roller global 5 min · sono prioritário',
  'MD-3':'Gelo localizado 15 min + Foam roller posterior 4 min · Proteína + CHO 30 min',
  'MD-2':'Foam roller global 5 min + Banho contrastante 6 min · Alongamento passivo 5 min',
  'MD-1':'Alongamento passivo global 8 min · Foam roller global 5 min · sem carga · sono prioritário',
  'MD0': 'Gelo localizado 15 min + Bota Pneumática 20 min · Reidratação imediata · iniciar MD+1',
  'D1':  'Foam roller global 4 min + Alongamento passivo 5 min · hidratação',
  'D2':  'Foam roller posterior 4 min + Gelo localizado 10 min · Proteína + CHO 30 min',
  'D3':  'Gelo localizado 15 min + Bota Pneumática 25 min · Foam roller posterior 3 min',
  'D4':  'Foam roller global 5 min + Banho contrastante 6 min · sono prioritário',
  'D5':  'Foam roller posterior 4 min + Gelo localizado 10 min · Bota Pneumática 20 min',
  'D6':  'Alongamento passivo global 8 min · Foam roller global 5 min · hidratação · sono',
  'D7':  'Folga — sem protocolo estruturado',
};

// Cache dos dados médicos para uso no PDF
const _dadosMedicos = { afastados: [], transicao: [], liberados: [] };
// ── Estado do modal de atleta (abas) ─────────────────────────────────────────
let _cmAtletaId  = null;   // athleteId do atleta aberto no modal
let _cmProntHTML = '';     // HTML da aba Prontidão (já calculado localmente)
let _cmAbaCarga  = {};     // cache HTML: `${atletaId}_${aba}` → html
// Cache de prontidão para uso no PDF
const _prontidao = { criticos: [], atencao: [] };
// Cache unificado por atleta para o grid de cards
const _atletasMedico    = new Map(); // athleteId → { nome, posicao, statusMed, infoMed, dias }
const _atletasProntidao = new Map(); // athleteId → { status, causas, sistema, global, IH, IA, INM }
const _atletasFaseRTP   = new Map(); // athleteId → faseRTP mais recente conhecida (persiste sem dados)
let   _atletasMap       = {};        // athleteId → { nome, posicao }
let   _gruposAtletasDash = {};       // athleteId → grupoName (Geral, G1, G2, G3)
let   _historicoAtleta  = {};        // athleteId → registros[] — para cálculo de tendência
const _sistemaSemanal   = new Map(); // athleteId → { nome, contagem, media } — sistema mais afetado na semana
const _recoveryCardDataMap = new Map(); // athleteId → sugestao string (protocolosFinal)
let   _minutosByAtleta  = {};        // athleteId → segundos jogados no último jogo
let   _gruposByAtleta   = {};        // athleteId → grupo do planejamento para hoje
const _motorRecomendacoes = new Map(); // athleteId → motor output do dia (compute-if-missing)

/* =====================================================
   EXPORTAÇÃO PDF
===================================================== */
// ── Helpers HTML→canvas→PDF ────────────────────────────────────────────────
async function _renderizarPaginaHTML(pdf, htmlStr, isFirstPage) {
  // Cria div oculto fora da viewport, renderiza, captura, insere no PDF
  const wrapper = document.createElement("div");
  wrapper.style.cssText = [
    "position:fixed", "left:-9999px", "top:0",
    "width:794px",          // ~A4 a 96dpi
    "background:#ffffff",
    "font-family:Arial,sans-serif",
    "padding:0", "margin:0",
  ].join(";");
  wrapper.innerHTML = htmlStr;
  document.body.appendChild(wrapper);

  await new Promise(r => setTimeout(r, 80)); // deixa o browser renderizar

  const canvas = await html2canvas(wrapper, {
    scale: 2.5,
    useCORS: true,
    backgroundColor: "#ffffff",
    windowWidth: 794,
    width: 794,
    height: wrapper.scrollHeight,
    logging: false,
  });
  document.body.removeChild(wrapper);

  // Divide canvas em fatias A4 (297mm × 210mm → proporção 297/210 = 1.414)
  const A4_W_PX = canvas.width;
  const A4_H_PX = Math.round(canvas.width * (297 / 210));
  let offsetY = 0;

  while (offsetY < canvas.height) {
    if (!isFirstPage || offsetY > 0) pdf.addPage([210, 297]);
    isFirstPage = false;

    const sliceH = Math.min(A4_H_PX, canvas.height - offsetY);
    const sliceCanvas = document.createElement("canvas");
    sliceCanvas.width  = A4_W_PX;
    sliceCanvas.height = A4_H_PX;
    const ctx = sliceCanvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, A4_W_PX, A4_H_PX);
    ctx.drawImage(canvas, 0, offsetY, A4_W_PX, sliceH, 0, 0, A4_W_PX, sliceH);

    const imgData = sliceCanvas.toDataURL("image/jpeg", 0.92);
    pdf.addImage(imgData, "JPEG", 0, 0, 210, 297);
    offsetY += A4_H_PX;
  }
}

export async function gerarStatusDiarioPDF() {
    // Overlay de carregamento
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML = `<div style="background:#fff;border-radius:14px;padding:32px 40px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.18);">
      <p style="font-size:16px;font-weight:700;color:#111827;margin-bottom:8px;">Status Diário</p>
      <p style="font-size:13px;color:#6b7280;">Gerando PDF…</p>
    </div>`;
    document.body.appendChild(overlay);

    try {
      const { jsPDF } = window.jspdf;


      // ── Dados comuns ──────────────────────────────────────
      const dataFormatada = new Date().toLocaleDateString("pt-BR", {
        weekday: "long", day: "2-digit", month: "long", year: "numeric",
      });
      const dataCapitalizada = dataFormatada.charAt(0).toUpperCase() + dataFormatada.slice(1);
      const dataArquivo = new Date().toLocaleDateString('en-CA');
      const mc = calcularDiaMicrociclo();
      const mcLabel = mc?.label || '—';

      // ── Coleta dados ──────────────────────────────────────
      function coletarMicroRecovery() {
        const resultado = [];
        ["critico", "atencao", "apto"].forEach(nivel => {
          (_mrBuckets[nivel] || []).forEach(at => resultado.push({ ...at, nivel }));
        });
        return resultado;
      }
      const mrDados = coletarMicroRecovery();

      // ── CSS base compartilhado ────────────────────────────
      const CSS_BASE = `
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: Arial, sans-serif; background: #fff; color: #111827; }
        .page { width: 794px; padding: 22px 36px 18px; background: #fff; }
        .header-sub { font-size: 10px; color: #6b7280; margin-bottom: 3px; }
        .header-title { font-size: 20px; font-weight: 800; color: #111827; margin-bottom: 2px; }
        .header-date  { font-size: 11px; color: #9ca3af; margin-bottom: 6px; }
        .divider { border: none; border-top: 1px solid #e5e7eb; margin-bottom: 8px; }
        .rodape { font-size: 9px; color: #9ca3af; margin-top: 10px; padding-top: 6px; border-top: 1px solid #e5e7eb; }
        .banner { display:flex; align-items:center; gap:8px; background:#1e3a5f; border-radius:8px;
                  padding:5px 12px; margin-bottom:10px; flex-wrap:wrap; }
        .banner-pill { font-size:10px; font-weight:800; color:#fff; padding:3px 10px;
                       border-radius:12px; white-space:nowrap; }
        .banner-obj  { font-size:11px; font-weight:700; color:#fff; }
        .banner-det  { font-size:10px; color:#93c5fd; flex:1; }
        .banner-per  { font-size:10px; color:#cbd5e1; background:#0f2a4a; padding:2px 10px;
                       border-radius:12px; white-space:nowrap; }
        table { width:100%; border-collapse:collapse; font-size:11px; }
        thead tr { background:#f3f4f6; }
        thead th { padding:4px 6px; text-align:left; font-size:9px; font-weight:700;
                   color:#6b7280; text-transform:uppercase; letter-spacing:.04em; }
        tbody tr:nth-child(even) { background:#f9fafb; }
        tbody tr:nth-child(odd)  { background:#ffffff; }
        td { padding:4px 6px; vertical-align:top; border-bottom:1px solid #e5e7eb; font-size:10.5px; }
        .tag { display:inline-block; font-size:9px; font-weight:700; padding:2px 7px;
               border-radius:10px; white-space:nowrap; }
        .tag-red    { background:#fee2e2; color:#b91c1c; }
        .tag-orange { background:#ffedd5; color:#c2410c; }
        .tag-green  { background:#dcfce7; color:#15803d; }
        .tag-blue   { background:#dbeafe; color:#1d4ed8; }
        .tag-purple { background:#ede9fe; color:#6d28d9; }
        .tag-gray   { background:#f3f4f6; color:#6b7280; }
        .small { font-size:9px; color:#6b7280; margin-top:2px; }
        .small-red { font-size:9px; color:#b91c1c; font-weight:600; }
        .region { font-size:8.5px; color:#374151; }
        .rtp-pill { display:inline-block; font-size:8.5px; font-weight:700; padding:2px 7px;
                    border-radius:8px; margin-top:3px; }
        .sug { font-size:9px; color:#374151; }
        .sug-label { font-size:9px; font-weight:700; color:#2563eb; }
        .legenda-box { margin-top:8px; background:#fff1f2; border:1px solid #fca5a5;
                       border-radius:6px; padding:6px 10px; font-size:9px; color:#640014; }
        .legenda-rtp { margin-top:4px; background:#f0f9ff; border:1px solid #bae6fd;
                       border-radius:6px; padding:6px 10px; font-size:9px; color:#1e40af; }
        .secao-title { font-size:13px; font-weight:800; color:#111827; margin-bottom:6px; }
        .ex-nome { font-size:10px; font-weight:700; color:#374151; }
        .ex-vol  { font-size:9px; color:#2563eb; font-weight:600; }
        .ex-nota { font-size:8.5px; color:#9ca3af; }
      `;

      // ── Helper: cabeçalho HTML ────────────────────────────
      function htmlCabecalho(titulo) {
        let bannerHtml = '';
        if (mc && mc.label !== '—') {
          bannerHtml = `
            <div class="banner">
              <span class="banner-pill" style="background:${mc.cor}">${mc.label}</span>
              <span class="banner-obj">${mc.objetivo}</span>
              <span class="banner-det">${mc.detalhe}</span>
              <span class="banner-per">Período · ${mc.periodo}</span>
            </div>`;
        }
        const { categoria: _fCat, grupo: _fGrupo } = _getFiltrosDash();
        const _filtrosAtivos = [
          _fCat   ? `Categoria: ${_fCat}` : '',
          _fGrupo ? `Grupo: ${_fGrupo}` : '',
        ].filter(Boolean).join(' · ');
        const filtroSubHtml = _filtrosAtivos
          ? `<p style="font-size:10px;color:#2563eb;margin-bottom:6px;">Filtros: ${_filtrosAtivos}</p>` : '';
        return `
          <p class="header-sub">DEPTO. DE INTELIGÊNCIA ESPORTIVA - CIENTE IE</p>
          <p class="header-title">${titulo}</p>
          <p class="header-date">${dataCapitalizada}</p>
          ${filtroSubHtml}<hr class="divider">
          ${bannerHtml}`;
      }

      function htmlRodape(pag, total) {
        return `<p class="rodape">Gerado em ${new Date().toLocaleString("pt-BR")} · Ciente IE · pág. ${pag}/${total}</p>`;
      }

      // ── Cores helpers ─────────────────────────────────────
      const corMedTag = { afastado:'tag-red', transicao:'tag-orange', liberado:'tag-green' };
      const labelMed  = { afastado:'Afastado', transicao:'Transição', liberado:'Liberado' };
      const corProntTag = {
        'Crítico':'tag-red', 'Atenção':'tag-orange',
        'Atenção Leve':'tag-orange', 'Estável':'tag-green', 'Sem dados':'tag-gray'
      };
      const corSistTag = {
        'Neuromuscular':'tag-purple','Autonômico':'tag-blue',
        'Cognitivo':'tag-green','Subjetivo':'tag-orange'
      };

      // ── Garante que _motorRecomendacoes está populado (fallback Firestore) ─────
      {
        const todosIdsPDF = Array.from(_atletasMedico.keys());
        const faltandoPDF = todosIdsPDF.filter(id => !_motorRecomendacoes.has(id));
        if (faltandoPDF.length > 0) {
          const snaps = await Promise.all(
            faltandoPDF.map(id => getDoc(doc(db, 'daily_recommendations', `${id}_${dataArquivo}`)).catch(() => null))
          );
          snaps.forEach((snap, i) => {
            if (snap?.exists()) _motorRecomendacoes.set(faltandoPDF[i], snap.data());
          });
        }
      }

      // ════════════════════════════════════════════════════
      // PÁGINA 1 — Situação do Elenco
      // ════════════════════════════════════════════════════
      {
        const abreviarRegiao = s => s.replace(/ Dir\./g," D.").replace(/ Esq\./g," E.");
        const matrizConsiderar = {
          "Neuromuscular": ["Reduzir magnitude mecânica","Aumentar pausas"],
          "Autonômico":    ["Reduzir intensidade","Aumentar pausas"],
          "Cognitivo":     ["Reduzir complexidade","Aumentar pausas"],
          "Subjetivo":     ["Reduzir volume","Reduzir densidade"],
        };
        const ordemPront = { "Crítico":0,"Atenção":1,"Atenção Leve":2,"Estável":3,"Sem dados":4 };
        const ordemPosPDF = ["goleiro","lateral","zagueiro","volante","meia","ponta","centro-avante","centroavante","atacante"];

        const listaAtl = Array.from(_atletasMedico.entries())
          .filter(([id, med]) => _atletaPassaFiltrosDash(id, med))
          .map(([id, med]) => {
          const pront = _atletasProntidao.get(id) || { status:"Sem dados", causas:"", sistema:null };
          const _semDados = pront.global==null && pront.IH==null && pront.IA==null && pront.INM==null;
          const faseRTP = (_semDados && _atletasFaseRTP.has(id))
            ? _atletasFaseRTP.get(id)
            : calcularFaseRTP(med.statusMed, {
                global:pront.global, inFadiga:pront.IH, inMuscular:pront.INM, inAutonomico:pront.IA, dor:pront.dor
              }, _atletasFaseRTP.get(id)?.fase ?? 0);
          return { id, med, pront, faseRTP };
        });

        listaAtl.sort((a,b) => {
          const mA = a.med.statusMed==="afastado"?0:a.med.statusMed==="transicao"?1:2;
          const mB = b.med.statusMed==="afastado"?0:b.med.statusMed==="transicao"?1:2;
          if (mA!==mB) return mA-mB;
          // Transição: ordena F1→F4 (fase menor = mais longe do retorno = primeiro)
          if (a.med.statusMed==="transicao" && b.med.statusMed==="transicao") {
            const fA = a.faseRTP?.fase ?? 0;
            const fB = b.faseRTP?.fase ?? 0;
            if (fA!==fB) return fA-fB;
          }
          const sA = ordemPront[a.pront.status]??4;
          const sB = ordemPront[b.pront.status]??4;
          if (sA!==sB) return sA-sB;
          const gA = a.pront.global??999, gB = b.pront.global??999;
          if (Math.abs(gA-gB)>0.05) return gA-gB;
          return a.med.nome.localeCompare(b.med.nome,"pt-BR");
        });

        let linhas = '';
        listaAtl.forEach(({ id, med, pront, faseRTP }) => {
          // Coluna DEPTO. MÉDICO
          const tagMed = `<span class="tag ${corMedTag[med.statusMed]||'tag-green'}">${labelMed[med.statusMed]||'Liberado'}</span>`;
          const diasHtml = med.dias!=null
            ? `<span style="font-size:9px;font-weight:700;color:${med.dias>=14?'#b91c1c':med.dias>=7?'#d97706':'#16a34a'};float:right">${med.dias}d</span>`
            : '';
          const infoHtml = med.infoMed ? `<div class="small">${med.infoMed}</div>` : '';
          let rtpHtml = '';
          if (faseRTP) {
            rtpHtml = `<div><span class="rtp-pill" style="background:${faseRTP.bg};color:${faseRTP.cor}">F${faseRTP.fase} · ${faseRTP.label}</span></div>`;
          }

          // Coluna PRONTIDÃO
          const tagPront = `<span class="tag ${corProntTag[pront.status]||'tag-gray'}">${pront.status}</span>`;
          let causasHtml = '';
          if (pront.causas) {
            pront.causas.split(" · ").forEach(c => {
              if (c.startsWith("Dor")) {
                const dorVal = parseInt((c.match(/Dor \((\d+)\/7\)/) || [])[1] || "0");
                const dorCrit = dorVal >= 5;
                const labelDor = c.split(" · ")[0];
                const partes = c.split(" · ").slice(1);
                const regioes = partes.slice(0,3).map(abreviarRegiao).join(", ") + (partes.length>3?"…":"");
                causasHtml += `<div class="${dorCrit?'small-red':'small'}">${labelDor}</div>`;
                if (regioes && regioes !== "sem local.") causasHtml += `<div class="region">${regioes}</div>`;
              } else {
                causasHtml += `<div class="small">${c}</div>`;
              }
            });
          }

          // Coluna TREINO HOJE — usa motor de recomendação
          const _EIXO_PDF  = { volume:'Volume', intensidade:'Intensidade', densidade:'Densidade', carga_mecanica:'Carga Mec.' };
          const _DOSE_COR  = { forte:['#b91c1c','#fee2e2'], moderado:['#c2410c','#ffedd5'], leve:['#92400e','#fefce8'] };
          const _PREC_PDF  = ['carga_mecanica','volume','intensidade','densidade'];
          let treinoHtml = '<span style="color:#9ca3af">—</span>';
          if (med.statusMed !== 'afastado') {
            const mRec = _motorRecomendacoes.get(id);
            if (mRec) {
              if (mRec.encaminhamento) {
                treinoHtml = `<span class="tag tag-red" style="font-size:9px;white-space:nowrap;">→ Encaminhar ao DM</span>`;
              } else {
                const chips = _PREC_PDF
                  .filter(e => mRec.eixos?.[e]?.dose_final && mRec.eixos[e].dose_final !== 'manter')
                  .map(e => {
                    const dose = mRec.eixos[e].dose_final;
                    const [color, bg] = _DOSE_COR[dose] || ['#374151','#f3f4f6'];
                    return `<span style="font-size:8.5px;font-weight:700;color:${color};background:${bg};padding:1px 5px;border-radius:4px;margin-right:2px;white-space:nowrap;">${_EIXO_PDF[e]} ↓</span>`;
                  });
                if (chips.length) {
                  treinoHtml = `<div style="display:flex;flex-wrap:wrap;gap:2px;margin-bottom:2px;">${chips.join('')}</div>`;
                  const rest = (mRec.restricoes || []).slice(0, 1);
                  if (rest.length) treinoHtml += rest.map(r => `<div class="sug">${r}</div>`).join('');
                } else {
                  treinoHtml = `<span style="font-size:9px;font-weight:700;color:#15803d;">Treino normal</span>`;
                }
              }
            }
          }

          // Coluna ! DM
          const dmHtml = pront.flagDM
            ? `<div style="text-align:center"><span class="tag tag-red" style="font-size:10px;white-space:nowrap;">! DM</span>${(pront.flagDMMotivos||[]).map(m=>`<div class="small-red">${m}</div>`).join('')}</div>`
            : `<span style="color:#d1d5db;font-size:13px;">—</span>`;

          linhas += `<tr>
            <td style="font-weight:700">${med.nome}</td>
            <td style="color:#6b7280">${med.posicao||'—'}</td>
            <td>${diasHtml}${tagMed}${infoHtml}${rtpHtml}</td>
            <td>${tagPront}${causasHtml}</td>
            <td>${treinoHtml}</td>
            <td style="text-align:center">${dmHtml}</td>
          </tr>`;
        });

        const temRTP = Array.from(_atletasMedico.values()).some(m => m.statusMed !== "liberado");
        const legendaRTP = temRTP ? `
          <div class="legenda-rtp">
            <strong>RTP:</strong> F0 Afastado · F1 Recondicionamento · F2 Treino Adaptado · F3 Treino Coletivo · F4 Apto · Liberado
          </div>` : '';

        // Contadores para o bloco de resumo
        const _cnt = { afastado:0, transicao:0, liberado:0, admin:0, critico:0, atencao:0, atencao_leve:0, estavel:0, sem_dados:0 };
        _atletasMedico.forEach((med, id) => {
          if (med.statusMed === 'afastado')       { _cnt.afastado++;  return; }
          if (med.statusMed === 'transicao')      { _cnt.transicao++; return; }
          if (med.statusMed === 'afastado_admin') { _cnt.admin++;     return; }
          _cnt.liberado++;
          const p = _atletasProntidao.get(id) || {};
          if      (p.status === 'Crítico')      _cnt.critico++;
          else if (p.status === 'Atenção')      _cnt.atencao++;
          else if (p.status === 'Atenção Leve') _cnt.atencao_leve++;
          else if (p.status === 'Estável')      _cnt.estavel++;
          else                                  _cnt.sem_dados++;
        });
        function _cntCard(n, label, bg, color) {
          return `<div style="background:${bg};border-radius:8px;padding:10px 14px;text-align:center;min-width:65px;">` +
            `<div style="font-size:22px;font-weight:800;color:${color};line-height:1;">${n}</div>` +
            `<div style="font-size:10px;font-weight:700;color:${color};text-transform:uppercase;letter-spacing:.04em;margin-top:3px;white-space:nowrap;">${label}</div>` +
            `</div>`;
        }
        const _cntLabelStyle = 'font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px;';
        const htmlContadores = `
          <div style="display:flex;gap:20px;margin-bottom:10px;align-items:flex-start;">
            <div>
              <p style="${_cntLabelStyle}">Depto. Médico</p>
              <div style="display:flex;gap:6px;">
                ${_cntCard(_cnt.afastado,  'Afastado',  '#fee2e2', '#b91c1c')}
                ${_cntCard(_cnt.transicao, 'Transição', '#ffedd5', '#c2410c')}
                ${_cntCard(_cnt.liberado,  'Liberado',  '#f0fdf4', '#15803d')}
                ${_cnt.admin ? _cntCard(_cnt.admin, 'Admin.', '#ede9fe', '#7c3aed') : ''}
              </div>
            </div>
            <div>
              <p style="${_cntLabelStyle}">Status de Prontidão</p>
              <div style="display:flex;gap:6px;">
                ${_cntCard(_cnt.critico,      'Crítico',    '#fef2f2', '#991b1b')}
                ${_cntCard(_cnt.atencao,      'Atenção',    '#fff7ed', '#c2410c')}
                ${_cntCard(_cnt.atencao_leve, 'Aten. Leve', '#fefce8', '#92400e')}
                ${_cntCard(_cnt.estavel,      'Estável',    '#f0fdf4', '#15803d')}
                ${_cnt.sem_dados ? _cntCard(_cnt.sem_dados, 'Sem dados', '#f3f4f6', '#6b7280') : ''}
              </div>
            </div>
          </div>`;

        // ── Briefing Pré-Treino para o PDF ───────────────────────────────────────
        const _atletasMedicoPDF = new Map(
          Array.from(_atletasMedico.entries()).filter(([id, med]) => _atletaPassaFiltrosDash(id, med))
        );
        const _bPDF = gerarBriefing({
          diaMicrocicloObj:    mc,
          atletasProntidaoMap: _atletasProntidao,
          atletasMedicoMap:    _atletasMedicoPDF,
          minutosByAtleta:     _minutosByAtleta,
        });
        function _htmlBriefingPDF(b) {
          if (b.tipo !== 'sessao') return '';
          const CAP_COR_PDF = { Alta: '#15803d', Moderada: '#d97706', Reduzida: '#dc2626' };
          const CAP_BG_PDF  = { Alta: '#f0fdf4', Moderada: '#fffbeb', Reduzida: '#fef2f2' };
          const p = b.prescricao;
          const col = (label, val) =>
            `<div style="text-align:center;padding:4px 8px;background:#fff;border-radius:6px;min-width:60px;">` +
            `<div style="font-size:8px;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;margin-bottom:2px;">${label}</div>` +
            `<div style="font-size:11px;font-weight:800;color:#111827;">${val}</div></div>`;
          const colDots = (label, n) => {
            const dots = Array.from({length:5}, (_,i) => `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${i<n?'#1e3a5f':'#e5e7eb'};margin:0 1px;"></span>`).join('');
            return `<div style="text-align:center;padding:4px 8px;background:#fff;border-radius:6px;min-width:70px;">` +
              `<div style="font-size:8px;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px;">${label}</div>` +
              `<div style="display:flex;justify-content:center;">${dots}</div></div>`;
          };
          const posHtml = b.posicoes_risco.length
            ? `<div style="margin-top:6px;font-size:9px;color:#374151;"><strong>Posições em atenção:</strong> ${b.posicoes_risco.join(' · ')}</div>` : '';
          const excHtml = b.excecoes.length
            ? `<div style="margin-top:4px;font-size:9px;color:#374151;"><strong>Ajuste individual (${b.excecoes.length}):</strong> ${b.excecoes.map(e => `${e.nome} — ${e.motivo}`).join(' · ')}</div>` : '';
          const naoJogHtml = b.nota_nao_jogadores
            ? `<div style="margin-top:5px;font-size:9px;color:#78350f;background:#fffbeb;border-left:2px solid #fcd34d;padding:4px 8px;border-radius:0 4px 4px 0;"><strong>Atenção — ${b.nota_nao_jogadores.n} atleta(s) com < 60 min no jogo:</strong> ${b.nota_nao_jogadores.texto}</div>` : '';
          const blocosHtml = p.blocos ? (() => {
            const bl = p.blocos;
            const partes = [];
            if (bl.alta) partes.push(`Alta: ${bl.alta.formato} (${bl.alta.ratio}${bl.alta.opcional ? ', opcional' : ''})`);
            if (bl.modBaixo) partes.push(`Mod/Baixa: ${bl.modBaixo.formato} (${bl.modBaixo.ratio})`);
            return `<div style="margin-top:5px;font-size:9px;color:#374151;"><strong>Blocos e pausas:</strong> ${partes.join(' · ')}${p.blocosMod ? ` · ⚠ ${p.blocosMod}` : ''}${bl.nota ? ` — ${bl.nota}` : ''}</div>`;
          })() : '';
          const justHtml = b.justificativa
            ? `<div style="margin-top:6px;font-size:8.5px;color:#374151;font-style:italic;border-left:2px solid #6366f1;padding-left:6px;">${b.justificativa}</div>` : '';
          return `
            <div style="background:${CAP_BG_PDF[b.capacidade_coletiva]};border:1px solid #e2e8f0;border-radius:8px;padding:8px 12px;margin-bottom:8px;">
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap;">
                <span style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#374151;">Briefing Pré-Treino</span>
                <span style="background:${b.cor};color:#fff;font-size:9px;font-weight:800;padding:2px 8px;border-radius:10px;">${b.label}</span>
                <span style="font-size:10px;font-weight:700;color:#1e3a8a;">${b.envelope_nome} · ${b.objetivo}</span>
                <span style="margin-left:auto;font-size:9px;font-weight:700;color:${CAP_COR_PDF[b.capacidade_coletiva]};">Capacidade: ${b.capacidade_coletiva} (${b.modificador_pct}%)</span>
              </div>
              <div style="display:flex;gap:6px;flex-wrap:wrap;">
                ${col('Duração', p.fmt.duracao)}
                ${col('Carga interna', p.fmt.cargaUA)}
                ${p.fmt.pse_alvo ? col('PSE-Alvo', p.fmt.pse_alvo) : ''}
                ${col('Alta Intensidade', p.fmt.alta)}
                ${col('Intensidade Moderada / Baixa', p.fmt.modBaixo)}
                ${colDots('Velocidade', p.dots.veloc)}
                ${colDots('Mud. Direção', p.dots.cod)}
              </div>
              ${blocosHtml}${posHtml}${excHtml}${naoJogHtml}${justHtml}
            </div>`;
        }
        const htmlBriefingPDF = _htmlBriefingPDF(_bPDF);

        const html1 = `<style>${CSS_BASE}</style>
          <div class="page">
            ${htmlCabecalho("Dashboard · Situação Diária")}
            ${htmlBriefingPDF}
            ${htmlContadores}
            <p class="secao-title">Situação do Elenco</p>
            <table>
              <thead><tr>
                <th style="width:18%">ATLETA</th>
                <th style="width:7%">POS.</th>
                <th style="width:15%">DEPTO. MÉDICO</th>
                <th style="width:18%">PRONTIDÃO</th>
                <th style="width:30%">TREINO HOJE</th>
                <th style="width:12%;text-align:center;">! DM</th>
              </tr></thead>
              <tbody>${linhas}</tbody>
            </table>
            <div class="legenda-box">
              <strong>TREINO HOJE:</strong> restrições de carga geradas pelo motor (eixos: Carga Mec. · Volume · Intensidade · Densidade). Chips coloridos indicam o que reduzir. "Treino normal" = sem restrição. "→ Encaminhar ao DM" = atleta não deve treinar antes de avaliação médica.
            </div>
            ${legendaRTP}
            ${htmlRodape(1,3)}
          </div>`;

        const pdf = new jsPDF({ orientation:"portrait", unit:"mm", format:"a4" });
        await _renderizarPaginaHTML(pdf, html1, true);

        // ════════════════════════════════════════════════════
        // PÁGINAS 2/3 — Recovery Pré e Pós-Treino
        // ════════════════════════════════════════════════════
        const corStatusCss = { critico:'tag-red', atencao:'tag-orange', apto:'tag-green' };
        const labelNivel   = { critico:'Crítico', atencao:'Atenção', apto:'Estável' };
        const corSistCss   = {
          'Neuromuscular':'color:#7c3aed;font-weight:700',
          'Autonômico':   'color:#2563eb;font-weight:700',
          'Cognitivo':    'color:#0d9488;font-weight:700',
          'Subjetivo':    'color:#ea580c;font-weight:700',
        };

        // ── PRÉ-TREINO ────────────────────────────────────
        let linhasPre = '';
        mrDados.forEach(at => {
          let exercHtml = '';
          if (at.nivel === 'apto') {
            const paps = [];
            if (at.papForca)    paps.push('PAP Força');
            if (at.papCognitivo) paps.push('PAP Cognitivo');
            exercHtml = `<span style="color:#2563eb;font-weight:700;font-size:10px">${paps.length?paps.join(' · '):'Treino normal'}</span>`;
          } else if (at.exRecovery?.length > 0) {
            exercHtml = at.exRecovery.map(ex => `
              <div style="margin-bottom:4px">
                <span class="ex-nome">${ex.icon} ${ex.nome}</span>
                <span class="ex-vol"> · ${ex.vol}</span>
                <div class="ex-nota">${ex.nota}</div>
              </div>`).join('');
          } else {
            exercHtml = '<span style="color:#9ca3af;font-style:italic;font-size:9px">Sem dados suficientes</span>';
          }
          linhasPre += `<tr>
            <td style="font-weight:700">${at.nome}</td>
            <td><span class="tag ${corStatusCss[at.nivel]||'tag-gray'}">${labelNivel[at.nivel]||at.nivel}</span></td>
            <td>${at.sistema?`<span style="${corSistCss[at.sistema]||''}">${at.sistema}</span>`:''}</td>
            <td>${exercHtml}</td>
          </tr>`;
        });

        // ── PÓS-TREINO ────────────────────────────────────
        const posBase = _posMapMicro[mcLabel] || '';

        let linhasPos = '';
        mrDados.forEach(at => {
          const comprometido = at.nivel==='critico' || at.nivel==='atencao' || at.nivel==='atencao_leve';
          let posTxt = '';
          if (comprometido && at.sistema && _posMapSistema[at.sistema]) posTxt = _posMapSistema[at.sistema];
          else if (posBase) posTxt = posBase;
          linhasPos += `<tr>
            <td style="font-weight:700">${at.nome}</td>
            <td><span class="tag ${corStatusCss[at.nivel]||'tag-gray'}">${labelNivel[at.nivel]||at.nivel}</span></td>
            <td>${at.sistema?`<span style="${corSistCss[at.sistema]||''}">${at.sistema}</span>`:''}</td>
            <td style="font-size:10px;color:#374151">${posTxt||'—'}</td>
          </tr>`;
        });

        const colTabPre = `
          <thead><tr>
            <th style="width:22%">ATLETA</th>
            <th style="width:12%">STATUS</th>
            <th style="width:14%">SISTEMA</th>
            <th style="width:52%">EXERCÍCIOS · ${mcLabel}</th>
          </tr></thead>`;
        const colTabPos = `
          <thead><tr>
            <th style="width:22%">ATLETA</th>
            <th style="width:12%">STATUS</th>
            <th style="width:14%">SISTEMA</th>
            <th style="width:52%">PÓS-TREINO · ${mcLabel}</th>
          </tr></thead>`;

        const html2 = `<style>${CSS_BASE}</style>
          <div class="page">
            ${htmlCabecalho("Recovery Pré-Treino · " + mcLabel)}
            <p class="secao-title">Protocolo Pré-Treino por Atleta</p>
            <table>${colTabPre}<tbody>${linhasPre}</tbody></table>
            <div style="margin-top:28px"></div>
            <p class="secao-title">Protocolo Pós-Treino por Atleta</p>
            <table>${colTabPos}<tbody>${linhasPos}</tbody></table>
            ${htmlRodape('2–3',3)}
          </div>`;

        await _renderizarPaginaHTML(pdf, html2, false);

        overlay.remove();
        pdf.save(`dashboard_${dataArquivo}.pdf`);
        if (new URLSearchParams(window.location.search).get('from') === 'relatorios') setTimeout(() => { window.location.href = '/staff/relatorios.html'; }, 800);
      }

    } catch (err) {
      overlay.remove();
      console.error("Erro ao gerar PDF:", err);
      alert("Erro ao gerar o PDF. Verifique o console.");
    }
}

export async function abrirStatusDiario() {
  const ctx       = JSON.parse(localStorage.getItem('userContext') || '{}');
  const nomeClube = ctx.clubName || ctx.clubId || 'Clube';
  const logoClube = ctx.clubLogoUrl || null;
  const mc        = calcularDiaMicrociclo();
  const _hoje     = new Date();
  const dataFmtRaw = _hoje.toLocaleDateString('pt-BR', { weekday:'long', day:'2-digit', month:'long', year:'numeric' });
  const dataFmt   = dataFmtRaw.charAt(0).toUpperCase() + dataFmtRaw.slice(1);

  const win = window.open('', '_blank');
  win.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Carregando…</title><style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;background:#f8fafc;}</style></head><body><div style="text-align:center;color:#6b7280"><div style="font-size:24px">⏳</div><div>Carregando dados…</div></div></body></html>`);

  // ── Tokens de cor ─────────────────────────────────────────────────────────────
  const COR = { critico:'#dc2626', atencao:'#ea580c', leve:'#f59e0b', estavel:'#16a34a', semdados:'#94a3b8' };

  // ── Helpers ───────────────────────────────────────────────────────────────────
  function classificarPorIGP(igp) {
    if (igp == null) return 'semdados';
    if (igp >= 70) return 'estavel';
    if (igp >= 60) return 'leve';
    if (igp >= 50) return 'atencao';
    return 'critico';
  }
  function primeiroUltimo(nome) {
    const partes = (nome || '').trim().split(/\s+/);
    if (partes.length <= 2) return nome;
    return partes[0] + ' ' + partes[partes.length - 1];
  }
  function labelCls(cls) {
    return { critico:'Crítico', atencao:'Atenção', leve:'Aten. Leve', estavel:'Estável', semdados:'Sem dados' }[cls] || '—';
  }
  function normPos(p) {
    const m = (p || '').toLowerCase();
    if (m === 'goleiro')   return 'Goleiro';
    if (m === 'lateral')   return 'Lateral';
    if (m === 'zagueiro')  return 'Zagueiro';
    if (m === 'volante')   return 'Volante';
    if (m === 'meia')      return 'Meia';
    if (m === 'ponta')     return 'Ponta';
    if (m.includes('centro') || m === 'atacante' || m === 'centroavante') return 'Centroavante';
    return p || '—';
  }

  const MATRIZ = {
    Neuromuscular: ['Reduzir magnitude mecânica', 'Aumentar pausas'],
    Autonômico:    ['Reduzir intensidade', 'Aumentar pausas'],
    Subjetivo:     ['Reduzir volume', 'Reduzir densidade'],
    Cognitivo:     ['Reduzir complexidade', 'Aumentar pausas'],
  };

  // ── Garante que _motorRecomendacoes está populado (fallback Firestore) ───────
  {
    const todosIds = Array.from(_atletasMedico.keys());
    const faltando = todosIds.filter(id => !_motorRecomendacoes.has(id));
    if (faltando.length > 0) {
      const hojeStr = new Date().toLocaleDateString('en-CA');
      const snaps = await Promise.all(
        faltando.map(id => getDoc(doc(db, 'daily_recommendations', `${id}_${hojeStr}`)).catch(() => null))
      );
      snaps.forEach((snap, i) => {
        if (snap?.exists()) _motorRecomendacoes.set(faltando[i], snap.data());
      });
    }
  }

  // ── Monta view por atleta ─────────────────────────────────────────────────────
  const atletasView = Array.from(_atletasMedico.entries())
    .filter(([id, med]) => _atletaPassaFiltrosDash(id, med))
    .map(([id, med]) => {
    const pront   = _atletasProntidao.get(id) || { status:'Sem dados', causas:'', sistema:null, global:null };
    const faseRTP = _atletasFaseRTP.get(id) || null;
    const igp     = pront.global != null ? Math.round(pront.global) : null;
    const cls     = classificarPorIGP(igp);
    const sistKey = _sistemaSemanal.get(id)?.nome || pront.sistema || null;
    const cons    = (sistKey && cls !== 'estavel' && cls !== 'semdados') ? (MATRIZ[sistKey] || []) : [];
    return {
      id, nome: primeiroUltimo(med.nome), posicao: normPos(med.posicao),
      dmStatus: med.statusMed || 'liberado',
      dias: med.dias,
      infoMed: med.infoMed || '',
      rtpFase: (med.statusMed === 'transicao' && faseRTP) ? `F${faseRTP.fase}` : null,
      rtpFaseObj: faseRTP,
      igp, classificacao: cls,
      IH:  pront.IH  != null ? Math.round(pront.IH)  : null,
      IA:  pront.IA  != null ? Math.round(pront.IA)  : null,
      INM: pront.INM != null ? Math.round(pront.INM) : null,
      IC:  pront.IC  != null ? Math.round(pront.IC)  : null,
      ispTend: (igp != null && pront.ispTend?.global) ? pront.ispTend.global : null,
      metrica: pront.causas || '',
      consideracoes: cons,
      temDM: !!(pront.flagDM),
      motorRec: _motorRecomendacoes.get(id) || null,
    };
  });

  const afastados       = atletasView.filter(a => a.dmStatus === 'afastado').sort((a, b) => (a.dias ?? 999) - (b.dias ?? 999));
  const transicao       = atletasView.filter(a => a.dmStatus === 'transicao');
  const afastadosAdmin  = atletasView.filter(a => a.dmStatus === 'afastado_admin').sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  const liberados       = atletasView.filter(a => a.dmStatus === 'liberado');
  const emDM            = [...afastados, ...transicao, ...afastadosAdmin];

  // ── Contadores ────────────────────────────────────────────────────────────────
  function renderContadores() {
    const c = { critico:0, atencao:0, leve:0, estavel:0, semdados:0 };
    liberados.forEach(a => { c[a.classificacao] = (c[a.classificacao] || 0) + 1; });
    const cc = (n, lbl, cor) =>
      `<div style="background:${cor}1a;border:1px solid ${cor}55;border-radius:8px;padding:9px 13px;text-align:center;min-width:58px;">` +
      `<div style="font-size:22px;font-weight:800;color:${cor};line-height:1;">${n}</div>` +
      `<div style="font-size:9px;font-weight:700;color:${cor};text-transform:uppercase;letter-spacing:.04em;margin-top:3px;white-space:nowrap;">${lbl}</div>` +
      `</div>`;
    const secLabel = 'font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.06em;margin-bottom:7px;';
    return `<div style="display:flex;gap:18px;margin-bottom:14px;align-items:flex-start;flex-wrap:wrap;">
      <div>
        <div style="${secLabel}">Depto. Médico</div>
        <div style="display:flex;gap:8px;">
          ${cc(afastados.length, 'Afastado', '#dc2626')}
          ${cc(transicao.length, 'Transição', '#0ea5e9')}
          ${afastadosAdmin.length ? cc(afastadosAdmin.length, 'Admin.', '#7c3aed') : ''}
        </div>
      </div>
      <div>
        <div style="${secLabel}">Status de Prontidão</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          ${cc(c.critico,  'Crítico',   COR.critico)}
          ${cc(c.atencao,  'Atenção',   COR.atencao)}
          ${cc(c.leve,     'Aten. Leve',COR.leve)}
          ${cc(c.estavel,  'Estável',   COR.estavel)}
          ${c.semdados > 0 ? cc(c.semdados, 'Sem Dados', COR.semdados) : ''}
        </div>
      </div>
    </div>`;
  }

  // ── Helper: footer de restrições por eixo ────────────────────────────────────
  const _RESTR_EL    = { volume: 'Volume', intensidade: 'Intensidade', densidade: 'Densidade', carga_mecanica: 'Carga Mecânica' };
  const _RESTR_PR    = ['carga_mecanica', 'volume', 'intensidade', 'densidade'];
  const _RESTR_DOSES = ['manter', 'leve', 'moderado', 'forte'];
  const _RESTR_COR   = { forte: '#dc2626', moderado: '#f97316', leve: '#eab308' };
  const _RESTR_VERBO = { forte: 'Reduzir', moderado: 'Reduzir', leve: 'Ajustar', manter: 'Manter' };
  function _footerRestricoes(a) {
    if (a.dmStatus === 'afastado') return '';
    const _ex = a.motorRec?.eixos || {};
    const restritos = _RESTR_PR
      .map(e => ({ e, dose: _ex[e]?.dose_final }))
      .filter(({ dose }) => dose && dose !== 'manter');
    const cor = c => _RESTR_COR[c] || '#374151';
    const itens = restritos.map(({ e, dose }) =>
      `<div style="display:flex;align-items:center;gap:5px;margin-top:3px;">
        <span style="width:8px;height:8px;border-radius:50%;background:${cor(dose)};flex-shrink:0;display:inline-block;"></span>
        <span style="font-size:11px;color:${cor(dose)};font-weight:700;">${_RESTR_VERBO[dose]} ${_RESTR_EL[e]}</span>
      </div>`
    ).join('');
    const restricaoFrase = (a.motorRec?.restricoes || [])[0];
    const fraseHtml = restricaoFrase
      ? `<div style="font-size:10px;color:#6b7280;margin-top:4px;line-height:1.3;">${restricaoFrase}</div>`
      : '';
    if (restritos.length) {
      return `<div style="margin-top:6px;border-top:1px solid #f3f4f6;padding-top:5px;">
        <div style="font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.05em;margin-bottom:2px;">Treino hoje</div>
        ${itens}
        ${fraseHtml}
      </div>`;
    }
    return `<div style="margin-top:6px;border-top:1px solid #f3f4f6;padding-top:5px;display:flex;align-items:center;gap:5px;">
      <span style="width:8px;height:8px;border-radius:50%;background:#16a34a;flex-shrink:0;display:inline-block;"></span>
      <span style="font-size:11px;font-weight:600;color:#16a34a;">Treino normal</span>
    </div>`;
  }

  // ── Cards DM (4 por linha) ────────────────────────────────────────────────────
  function renderCardDM(a) {
    const borderCor = a.dmStatus === 'transicao' ? '#0ea5e9' : a.dmStatus === 'afastado_admin' ? '#7c3aed' : '#64748b';
    const seloCor   = borderCor;
    const seloLabel = a.dmStatus === 'transicao' ? 'Transição' : a.dmStatus === 'afastado_admin' ? 'Administrativo' : 'Afastado';
    const diasStr   = a.dias != null ? ` · ${a.dias}d` : '';
    let extra = '';
    const faseTag = (a.dmStatus === 'transicao' && a.rtpFase)
      ? ` <span style="font-size:8px;font-weight:800;padding:1px 5px;border-radius:4px;background:#fff;color:${seloCor};border:1px solid ${seloCor}77;">${a.rtpFase}</span>`
      : '';
    const igpCor = COR[a.classificacao] || COR.semdados;
    const igpTopRight = (a.dmStatus === 'transicao' && a.igp != null)
      ? `<span style="font-size:13px;font-weight:900;color:${igpCor};line-height:1;">${a.igp}</span>`
      : '';
    return `<div style="border:1px solid #e4e7ec;border-left:4px solid ${borderCor};border-radius:0 8px 8px 0;background:#fff;padding:10px 12px;width:100%;box-sizing:border-box;">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:4px;margin-bottom:2px;">
        <div style="font-size:13px;font-weight:800;color:#161a20;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;">${a.nome}</div>
        ${igpTopRight}
      </div>
      <div style="font-size:10px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px;">${a.posicao}</div>
      <div style="display:flex;align-items:center;flex-wrap:wrap;gap:3px;">
        <span style="display:inline-flex;align-items:center;background:${seloCor}1a;border:1px solid ${seloCor}55;border-radius:999px;padding:3px 8px;font-size:10px;font-weight:800;color:${seloCor};">${seloLabel}${diasStr}</span>
        ${faseTag}
      </div>
      ${a.infoMed ? `<div style="margin-top:5px;font-size:10px;color:#6b7280;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${a.infoMed}</div>` : ''}
      ${_footerRestricoes(a)}
    </div>`;
  }

  // ── Chip do campo ─────────────────────────────────────────────────────────────
  function renderChip(a) {
    const cor = COR[a.classificacao] || COR.semdados;
    const lbl = labelCls(a.classificacao);
    const igpStr = a.igp != null ? String(a.igp) : '—';
    const dmSelo = a.temDM
      ? `<span style="font-size:9px;font-weight:800;padding:2px 6px;border-radius:4px;background:#fee2e2;color:#dc2626;margin-left:3px;flex-shrink:0;">DM</span>`
      : '';
    const semdados = a.classificacao === 'semdados';
    const encaminhamento = a.dmStatus !== 'afastado' && a.motorRec?.encaminhamento;
    const footerRestricoes = semdados
      ? `<div style="font-size:11px;color:#94a3b8;margin-top:4px;">Sem leitura hoje</div>`
      : encaminhamento
        ? `<div style="font-size:11px;font-weight:700;color:#b91c1c;margin-top:4px;">Encaminhar ao DM</div>`
        : _footerRestricoes(a);

    // Mini gráfico de barras dos 4 sistemas
    function _barCor(val, isNM) {
      if (val == null) return '#e2e8f0';
      if (isNM) return val >= 60 ? '#16a34a' : val >= 50 ? '#ca8a04' : val >= 40 ? '#ea580c' : '#dc2626';
      return val >= 70 ? '#16a34a' : val >= 60 ? '#ca8a04' : val >= 50 ? '#ea580c' : '#dc2626';
    }
    const sistemas = [
      { lbl: 'S',  val: a.IH,  nm: false },
      { lbl: 'A',  val: a.IA,  nm: false },
      { lbl: 'NM', val: a.INM, nm: true  },
      { lbl: 'C',  val: a.IC,  nm: false },
    ];
    const miniChart = semdados ? '' : `
      <div style="display:flex;gap:3px;margin:6px 0 3px;align-items:flex-end;">
        ${sistemas.map(({ lbl: sl, val, nm }) => {
          const c = _barCor(val, nm);
          const h = val != null ? Math.max(3, Math.round(val * 0.22)) : 3;
          return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:1px;">
            <span style="font-size:8px;font-weight:700;color:${c};line-height:1;">${val ?? '—'}</span>
            <div style="width:100%;background:#f1f5f9;border-radius:2px;height:22px;position:relative;overflow:hidden;">
              <div style="position:absolute;bottom:0;width:100%;height:${h}px;background:${c};border-radius:2px 2px 0 0;"></div>
            </div>
            <span style="font-size:8px;color:#94a3b8;line-height:1;">${sl}</span>
          </div>`;
        }).join('')}
      </div>`;

    return `<div style="width:210px;flex-shrink:0;box-sizing:border-box;border:1px solid #e4e7ec;border-left:4px solid ${cor};border-radius:0 8px 8px 0;background:#fff;padding:10px 12px;display:flex;flex-direction:column;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;gap:3px;">
        <div style="display:flex;align-items:center;flex-wrap:nowrap;min-width:0;">
          <span style="font-size:11px;font-weight:800;padding:2px 8px;border-radius:4px;background:${cor};color:#fff;white-space:nowrap;">${lbl}</span>
          ${dmSelo}
        </div>
        <div style="display:flex;align-items:center;gap:3px;flex-shrink:0;">
          <span style="font-size:21px;font-weight:900;color:${cor};line-height:1;">${igpStr}</span>
          ${a.ispTend ? `<span style="font-size:16px;font-weight:900;color:${a.ispTend.cor};line-height:1;">${a.ispTend.icon}</span>` : ''}
        </div>
      </div>
      <div style="font-size:13px;font-weight:800;color:#161a20;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${a.nome}</div>
      ${miniChart}
      ${footerRestricoes}
    </div>`;
  }

  // ── Painel Em Campo (3 setores) ───────────────────────────────────────────────
  function renderCampo() {
    if (!liberados.length) return `<div style="color:#9ca3af;font-size:12px;text-align:center;padding:20px;">Nenhum atleta liberado.</div>`;
    const setores = [
      { nome:'Defesa', posicoes:['Goleiro','Lateral','Zagueiro'] },
      { nome:'Meio',   posicoes:['Volante','Meia'] },
      { nome:'Ataque', posicoes:['Ponta','Centroavante'] },
    ];
    const ordenar = lista => [...lista].sort((a, b) => {
      if (a.classificacao === 'semdados' && b.classificacao !== 'semdados') return 1;
      if (b.classificacao === 'semdados' && a.classificacao !== 'semdados') return -1;
      return (a.igp ?? 999) - (b.igp ?? 999);
    });
    return setores.map(setor => {
      const grupos = setor.posicoes
        .map(pos => ({ pos, atletas: ordenar(liberados.filter(a => a.posicao === pos)) }))
        .filter(g => g.atletas.length > 0);
      if (!grupos.length) return '';
      return `<div style="margin-bottom:14px;">
        <div style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:#475569;padding-bottom:6px;border-bottom:2px solid #cbd5e1;margin-bottom:10px;">${setor.nome}</div>
        ${grupos.map(g => `
          <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:10px;">
            <div style="display:flex;align-items:center;gap:5px;">
              <span style="font-size:13px;font-weight:700;color:#475569;">${g.pos}</span>
              <span style="display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:#e5e7eb;font-size:11px;font-weight:700;color:#475569;flex-shrink:0;">${g.atletas.length}</span>
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:8px;">${g.atletas.map(a => renderChip(a)).join('')}</div>
          </div>`).join('')}
      </div>`;
    }).join('');
  }

  // ── Banner microciclo ─────────────────────────────────────────────────────────
  const bannerHtml = mc ? `
    <div style="display:flex;align-items:center;gap:8px;background:#1e3a5f;border-radius:8px;padding:6px 12px;margin-bottom:14px;flex-wrap:wrap;">
      <span style="font-size:10px;font-weight:800;color:#fff;background:${mc.cor};padding:2px 8px;border-radius:8px;">${mc.label}</span>
      <span style="font-size:11px;font-weight:700;color:#fff;">${mc.objetivo}</span>
      <span style="font-size:10px;color:#93c5fd;flex:1;">${mc.detalhe}</span>
      <span style="font-size:9px;color:#cbd5e1;background:#0f2a4a;padding:2px 8px;border-radius:8px;">Período · ${mc.periodo || '—'}</span>
    </div>` : '';

  // ── Legenda ───────────────────────────────────────────────────────────────────
  const legendaHtml = [
    ['Crítico', COR.critico, '< 50'],
    ['Atenção',  COR.atencao, '50–59'],
    ['Aten. Leve', COR.leve, '60–69'],
    ['Estável',  COR.estavel, '≥ 70'],
    ['Sem dados', COR.semdados, '—'],
  ].map(([lbl, cor, faixa]) =>
    `<span style="display:inline-flex;align-items:center;gap:5px;font-size:10px;color:${cor};font-weight:700;">
      <span style="width:10px;height:10px;border-radius:2px;background:${cor};display:inline-block;flex-shrink:0;"></span>
      ${lbl} <span style="font-weight:400;color:#9ca3af;">${faixa}</span>
    </span>`
  ).join('');

  // ── HTML final ────────────────────────────────────────────────────────────────
  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<title>Status Diário — ${nomeClube}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:'Segoe UI',Arial,sans-serif;background:#f8fafc;color:#161a20;}
  .pg{max-width:920px;margin:0 auto;padding:24px 20px 32px;}
  .blk{background:#fff;border-radius:10px;border:1px solid #e4e7ec;padding:16px 18px;margin-bottom:14px;}
  .sec-title{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:#9ca3af;margin-bottom:12px;}
  .pbt{position:fixed;bottom:20px;right:20px;background:#161a20;color:#fff;border:none;padding:10px 20px;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.2);z-index:999;}
  @media print{@page{size:A4 portrait;margin:6mm;}body{background:#fff;}.pbt{display:none;}.pg{padding:0;max-width:100%;}.blk{box-shadow:none;border-radius:4px;break-inside:avoid;}}
  @media(max-width:560px){.dm-grid{grid-template-columns:repeat(2,1fr) !important;}}
</style>
</head>
<body>
<div class="pg">

  <!-- Header -->
  <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:8px;">
    <div style="display:flex;align-items:center;gap:12px;">
      ${logoClube ? `<img src="${logoClube}" style="width:48px;height:48px;object-fit:contain;flex-shrink:0;">` : ''}
      <div>
        <div style="font-size:16px;font-weight:900;color:#161a20;letter-spacing:-.01em;">${nomeClube}</div>
        <h1 style="font-size:20px;font-weight:900;color:#161a20;letter-spacing:-.02em;">Status Diário</h1>
        <div style="font-size:11px;color:#6b7280;margin-top:2px;">${dataFmt}</div>
        <div style="font-size:9px;color:#9ca3af;margin-top:3px;">DEPTO. DE INTELIGÊNCIA ESPORTIVA - CIENTE IE</div>
      </div>
    </div>
  </div>

  <!-- Microciclo -->
  ${bannerHtml}

  <!-- Contadores -->
  ${renderContadores()}

  <!-- Departamento Médico -->
  ${emDM.length ? `
  <div class="blk">
    <div class="sec-title">Departamento Médico</div>
    <div class="dm-grid" style="display:flex;flex-wrap:wrap;gap:8px;">
      ${emDM.map(a => `<div style="width:200px;flex-shrink:0;">${renderCardDM(a)}</div>`).join('')}
    </div>
  </div>` : ''}

  <!-- Em Campo -->
  <div class="blk">
    <div class="sec-title">Em Campo · Por Posição</div>
    ${renderCampo()}
  </div>

  <!-- Legenda IGP -->
  <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-bottom:6px;">${legendaHtml}</div>
  <!-- Legenda Restrições -->
  <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-bottom:8px;">
    <span style="font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.05em;">Restrições:</span>
    ${[['#dc2626','Alta'],['#f97316','Média'],['#eab308','Leve'],['#16a34a','Sem restrição']].map(([c,l]) =>
      `<span style="display:inline-flex;align-items:center;gap:5px;font-size:10px;color:#374151;">
        <span style="width:8px;height:8px;border-radius:50%;background:${c};display:inline-block;flex-shrink:0;"></span>${l}
      </span>`).join('')}
  </div>
  <div style="font-size:10px;color:#9ca3af;">Gerado em ${new Date().toLocaleString('pt-BR')} · Ciente IE</div>
  <div style="font-size:10px;color:#9ca3af;margin-top:3px;">⚠ Sugestões geradas automaticamente. Não substituem a avaliação da comissão técnica.</div>

</div>
<button class="pbt" onclick="window.print()">Imprimir / PDF</button>
<script>
(function(){
  var pg;
  window.addEventListener('beforeprint', function(){
    pg = document.querySelector('.pg');
    if(!pg) return;
    var pageH = (297 - 12) * 3.7795; // A4 minus 6mm top+bottom margins in px
    var ratio = pageH / pg.scrollHeight;
    if(ratio < 1) document.body.style.zoom = ratio;
  });
  window.addEventListener('afterprint', function(){
    document.body.style.zoom = '';
  });
})();
</script>
</body>
</html>`;

  win.document.open();
  win.document.write(html);
  win.document.close();
}

function configurarExportacaoPDF() {
  const btn = document.getElementById("exportarPDF");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "Gerando PDF…";
    try { await gerarStatusDiarioPDF(); }
    catch(e) { /* já tratado dentro */ }
    finally { btn.disabled = false; btn.textContent = "Status Diário"; }
  });
}


/* =========================
   DATA DE HOJE
========================= */
const hoje = new Date().toLocaleDateString('en-CA');

/* =====================================================
   ÚLTIMA PARTIDA — minutos jogados por atleta
===================================================== */
async function carregarUltimaPartidaDash() {
  _minutosByAtleta = {};
  try {
    const snap = await _getDocsCache('scout_partidas', query(
      collection(db, "scout_partidas"), where("clubId", "==", CLUB_ID)
    ));
    if (snap.empty) return;
    const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    docs.sort((a, b) => {
      const da = a.data || "", db2 = b.data || "";
      if (db2 !== da) return db2.localeCompare(da);
      return (b.createdAt?.seconds ?? 0) - (a.createdAt?.seconds ?? 0);
    });
    const p = docs[0];
    const durSec = Math.min(p.duracaoSegundos || 5400, 7200);
    if (p.playedSeconds) {
      Object.entries(p.playedSeconds).forEach(([id, val]) => {
        const raw = typeof val === "object" ? (val.seconds ?? 0) : typeof val === "number" ? val : 0;
        const seg = Math.min(raw, durSec);
        if (seg > 0) _minutosByAtleta[id] = seg;
      });
    }
  } catch(e) { console.warn("carregarUltimaPartidaDash:", e); }
}

async function carregarGruposPlanejamentoDash() {
  _gruposByAtleta = {};
  const hoje = new Date().toLocaleDateString('en-CA');
  try {
    const snap = await getDocs(query(
      collection(db, 'athlete_sessions'),
      where('clubId', '==', CLUB_ID),
      where('date', '==', hoje)
    ));
    snap.docs.forEach(d => {
      const v = d.data();
      if (v.athleteId && v.grupo) _gruposByAtleta[v.athleteId] = v.grupo;
    });
  } catch(e) { console.warn('carregarGruposPlanejamentoDash:', e); }
}

/* =====================================================
   FILTROS DO DASHBOARD
===================================================== */
function _preencherFiltrosCategorias() {
  const cats = [...new Set(
    Array.from(_atletasMedico.values()).map(a => a.categoria).filter(Boolean)
  )].sort();
  const sel = document.getElementById("dashFiltroCategoria");
  if (!sel) return;
  const valorAtual = sel.value;
  sel.innerHTML = `<option value="">Todas</option>` + cats.map(c => `<option value="${c}">${c}</option>`).join("");
  if (valorAtual) sel.value = valorAtual;
}

function _getFiltrosDash() {
  return {
    categoria: document.getElementById("dashFiltroCategoria")?.value ?? "",
    grupo:     document.getElementById("dashFiltroGrupo")?.value ?? "",
  };
}

function _atletaPassaFiltrosDash(id, med) {
  const { categoria, grupo } = _getFiltrosDash();
  if (categoria && med.categoria !== categoria) return false;
  if (grupo) {
    const grupoAtleta = _gruposByAtleta[id] || _gruposAtletasDash[id];
    if (!grupoAtleta || grupoAtleta !== grupo) return false;
  }
  return true;
}

onAuthStateChanged(auth, async (user) => {
  if (!user) { window.location.href = "/login.html"; return; }
  try {
    // 1. localStorage (rápido, salvo no login)
    const ctx = JSON.parse(localStorage.getItem("userContext") || "{}");
    CLUB_ID = ctx?.clubId ?? null;
    // 2. Fallback Firestore
    if (!CLUB_ID) {
      const snap = await getDoc(doc(db, "users", user.uid));
      CLUB_ID = snap.exists() ? snap.data().clubId : null;
    }
    if (!CLUB_ID) { console.error("Usuário sem clubId"); return; }
    await Promise.all([
      carregarUltimaPartidaDash(),
      carregarGruposPlanejamentoDash(),
      carregarDepartamentoMedico(),
    ]);
    _preencherFiltrosCategorias();
    await carregarProntidaoERecovery();
    configurarExportacaoPDF();

    // Wire up filter listeners
    document.getElementById("dashFiltroCategoria")?.addEventListener("change", () => {
      renderStatusCountCards();
      renderGridAtletas();
    });
    document.getElementById("dashFiltroGrupo")?.addEventListener("change", () => {
      renderStatusCountCards();
      renderGridAtletas();
    });
  } catch(e) { console.error(e); }
  finally { document.dispatchEvent(new Event('dashboardReady')); }
});

document.addEventListener("DOMContentLoaded", () => {});

// Auto-trigger via query param (ex: dashboard.html?relatorio=status)
document.addEventListener('dashboardReady', () => {
  const rel = new URLSearchParams(window.location.search).get('relatorio');
  if (!rel) return;
  const map = { status: 'exportarPDF', geral: 'btnRelatorioGeral' };
  const id = map[rel];
  if (id) document.getElementById(id)?.click();
});

/* =====================================================
   FRASE ORIENTADORA (SIMPLES)
===================================================== */
function fraseOrientadora(status) {
  if (status === "Crítico") {
    return "Priorizar recuperação ou treinar apenas com carga reduzida.";
  }
  if (status === "Atenção") {
    return "Monitorar. Ajustar volume ou intensidade se necessário.";
  }
  if (status === "Atenção Leve") {
    return "Dentro do aceitável. Observar se persistir por mais de 2 dias.";
  }
  return "Treino normal.";
}

/* =====================================================
   LOADERS DAS ABAS DO MODAL DE ATLETA
===================================================== */
function _cmFmtData(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

async function _cmLoadMedico(atletaId) {
  const snap = await getDocs(query(
    collection(db, 'assessments_medical'),
    where('athleteId', '==', atletaId),
    where('clubId',    '==', CLUB_ID)
  ));
  const lesoes = [], atends = [];
  snap.forEach(ds => {
    const r = ds.data();
    const tipo = (r.tipo || r.dados?.tipoRegistro || '').toLowerCase();
    if (tipo === 'lesao' || tipo === 'lesão') lesoes.push(r);
    if (tipo === 'atendimento')              atends.push(r);
  });
  const df = r => r.data || r.date || '';
  lesoes.sort((a, b) => df(b).localeCompare(df(a)));
  atends.sort((a, b) => df(b).localeCompare(df(a)));

  const hoje = new Date(); hoje.setHours(0,0,0,0);
  const stCfg = {
    afastado:  { bg: '#fee2e2', cor: '#dc2626', label: 'Afastado'  },
    transicao: { bg: '#e0f2fe', cor: '#0ea5e9', label: 'Transição' },
    liberado:  { bg: '#dcfce7', cor: '#16a34a', label: 'Liberado'  },
  };
  function diasEntre(isoInicio, isoFim) {
    if (!isoInicio) return null;
    const fim = isoFim ? new Date(isoFim + 'T00:00:00') : hoje;
    return Math.round((fim - new Date(isoInicio + 'T00:00:00')) / 86400000);
  }

  const lesHTML = lesoes.length ? lesoes.slice(0, 5).map(l => {
    const d  = l.dados || {};
    const st = stCfg[l.status] || stCfg.liberado;
    const dt = l.data || l.date;
    const isLiberado = (l.status || d.status || d.statusAtual || '').toLowerCase().includes('liber');
    const dataAlta = l.dataAlta || d.dataAlta || null;
    // Para liberados: alta explícita → usa; sem alta → usa updatedAt como proxy; ainda sem nada → hoje
    let fimIso = null;
    if (isLiberado) {
      if (dataAlta) {
        fimIso = dataAlta;
      } else {
        const upd = l.updatedAt;
        let updDate = null;
        if (upd?.seconds)      updDate = new Date(upd.seconds * 1000);
        else if (upd?.toDate)  updDate = upd.toDate();
        else if (upd && typeof upd === 'string') updDate = new Date(upd);
        if (updDate) fimIso = updDate.toLocaleDateString('en-CA');
      }
    }
    const diasN = diasEntre(dt, fimIso);
    const info = [d.regiao || l.regiao, diasN != null ? diasN + 'd' : null].filter(Boolean).join(' · ');
    return `<div style="border:1px solid #f3f4f6;border-radius:8px;padding:10px 12px;margin-bottom:8px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
        <span style="font-size:13px;font-weight:700;color:#374151;">${d.tipoLesao || l.tipoLesao || 'Lesão'}</span>
        <span style="font-size:11px;font-weight:700;padding:2px 8px;border-radius:4px;background:${st.bg};color:${st.cor};">${st.label}</span>
      </div>
      ${info ? `<div style="font-size:12px;color:#6b7280;">${info}</div>` : ''}
      ${dt ? `<div style="font-size:11px;color:#9ca3af;margin-top:3px;">${_cmFmtData(dt)}</div>` : ''}
    </div>`;
  }).join('') : `<p style="font-size:12px;color:#9ca3af;text-align:center;padding:16px 0;">Sem lesões registradas.</p>`;

  const atHTML = atends.length ? atends.slice(0, 5).map(a => {
    const d  = a.dados || {};
    const dt = a.data || a.date;
    return `<div style="border:1px solid #f3f4f6;border-radius:8px;padding:10px 12px;margin-bottom:8px;">
      <div style="font-size:13px;font-weight:700;color:#374151;margin-bottom:3px;">${d.tipo || d.tipoAtendimento || 'Atendimento'}</div>
      ${d.queixa ? `<div style="font-size:12px;color:#6b7280;">${d.queixa}</div>` : ''}
      ${dt ? `<div style="font-size:11px;color:#9ca3af;margin-top:3px;">${_cmFmtData(dt)}</div>` : ''}
    </div>`;
  }).join('') : `<p style="font-size:12px;color:#9ca3af;text-align:center;padding:16px 0;">Sem atendimentos registrados.</p>`;

  return `<div style="padding:20px 24px;">
    <div style="margin-bottom:20px;">
      <p style="font-size:11px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.06em;margin:0 0 10px;">Lesões · ${lesoes.length}</p>
      ${lesHTML}
    </div>
    <div>
      <p style="font-size:11px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.06em;margin:0 0 10px;">Atendimentos · ${atends.length}</p>
      ${atHTML}
    </div>
  </div>`;
}

async function _cmLoadAvaliacoes(atletaId) {
  const snap = await getDocs(query(
    collection(db, 'assessments_functional'),
    where('athleteId', '==', atletaId),
    where('clubId',    '==', CLUB_ID)
  ));
  let fisica = null, funcional = null, psico = null;
  snap.forEach(ds => {
    const f = ds.data();
    const d = f.date || f.data || '';
    const orig = f.meta?.origem || '';
    if (orig === 'testes_fisicos'      && (!fisica    || d > (fisica._d    || ''))) fisica    = { ...f, _d: d };
    if (orig === 'avaliacao_funcional' && (!funcional || d > (funcional._d || ''))) funcional = { ...f, _d: d };
    if (f.instrumento === 'BFI-44'     && (!psico     || d > (psico._d     || ''))) psico     = { ...f, _d: d };
  });

  function secao(titulo, html, data) {
    return `<div style="margin-bottom:20px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
        <p style="font-size:11px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.06em;margin:0;">${titulo}</p>
        ${data ? `<span style="font-size:11px;color:#9ca3af;">${_cmFmtData(data)}</span>` : ''}
      </div>
      ${html}
    </div>`;
  }
  function campo(label, valor, unidade = '') {
    return `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #f9fafb;">
      <span style="font-size:12px;color:#6b7280;">${label}</span>
      <span style="font-size:12px;font-weight:700;color:#374151;">${valor != null && valor !== '' ? valor + (unidade ? ' ' + unidade : '') : '—'}</span>
    </div>`;
  }
  const vazio = txt => `<p style="font-size:12px;color:#9ca3af;text-align:center;padding:12px 0;">${txt}</p>`;

  // Física — Antropometria + Desempenho
  let fisicaHTML = '';
  if (fisica) {
    const ant = fisica.dados?.antropometria || {};
    const dd  = fisica.dados || {};
    const peso = ant.peso_kg ?? null;
    const alt  = ant.estatura_cm ?? null;
    const imc  = (peso && alt) ? (peso / ((alt / 100) ** 2)).toFixed(1) : null;
    const gc   = ant.navy?.gc_calculado ?? ant.gordura_percentual ?? null;
    fisicaHTML = [
      campo('Estatura',    alt,  'cm'),
      campo('Peso',        peso, 'kg'),
      campo('IMC',         imc,  'kg/m²'),
      campo('% Gordura',   gc != null ? Number(gc).toFixed(1) : null, '%'),
      campo('Velocidade 30m',   dd.velocidade_30m   != null ? Number(dd.velocidade_30m).toFixed(2)  : null, 's'),
      campo('Agilidade T-Test', dd.agilidade_ttest  != null ? Number(dd.agilidade_ttest).toFixed(2) : null, 's'),
      campo('Salto Horizontal', dd.salto_horizontal != null ? Number(dd.salto_horizontal)            : null, 'cm'),
      campo('Yo-Yo',            dd.yoyo             != null ? Number(dd.yoyo)                        : null, 'm'),
    ].join('');
  }

  // Funcional — Força, Mobilidade, Flexibilidade
  function _classMobInline(regiao, v) {
    if (v == null || v === '' || isNaN(Number(v))) return null;
    v = Number(v);
    if (regiao === 'Quadril')   { return v > 40 ? 'Baixa Rigidez' : v < 30 ? 'Alta Rigidez' : 'Normal'; }
    if (regiao === 'Tornozelo') { return v > 42 ? 'Risco Baixo' : v >= 37 ? 'Risco Moderado' : 'Risco Alto'; }
    return null;
  }
  function _mobBadgeInline(label) {
    if (!label) return '';
    const l = label.toLowerCase();
    const cor = (l.includes('baixo') || l.includes('baixa') || l === 'normal') ? '#15803d:#dcfce7'
      : l.includes('moderado') ? '#b45309:#fef9c3'
      : '#b91c1c:#fee2e2';
    const [text, bg] = cor.split(':');
    return `<span style="padding:1px 7px;border-radius:999px;font-size:10px;font-weight:700;background:${bg};color:${text};">${label}</span>`;
  }
  function campoComBadge(label, valor, unidade, badge) {
    const val = valor != null && valor !== '' ? valor + (unidade ? ' ' + unidade : '') : '—';
    return `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #f9fafb;">
      <span style="font-size:12px;color:#6b7280;">${label}</span>
      <span style="display:flex;align-items:center;gap:6px;font-size:12px;font-weight:700;color:#374151;">${val}${badge ? ' ' + badge : ''}</span>
    </div>`;
  }

  let funcionalHTML = '';
  if (funcional?.setores) {
    const { forca = {}, mobilidade = {}, flexibilidade = {} } = funcional.setores;
    const qd = forca.quad_dir != null ? Number(forca.quad_dir) : null;
    const qe = forca.quad_esq != null ? Number(forca.quad_esq) : null;
    const id = forca.isq_dir  != null ? Number(forca.isq_dir)  : null;
    const ie = forca.isq_esq  != null ? Number(forca.isq_esq)  : null;
    const assimQ = (qd && qe) ? ((Math.abs(qd - qe) / Math.max(qd, qe)) * 100).toFixed(1) : null;
    const assimI = (id && ie) ? ((Math.abs(id - ie) / Math.max(id, ie)) * 100).toFixed(1) : null;
    const assimQBadge = assimQ != null ? _mobBadgeInline(assimQ < 10 ? 'Risco Baixo' : assimQ <= 15 ? 'Risco Moderado' : 'Risco Alto') : '';
    const assimIBadge = assimI != null ? _mobBadgeInline(assimI < 10 ? 'Risco Baixo' : assimI <= 15 ? 'Risco Moderado' : 'Risco Alto') : '';
    const flexLabel = v => { if (!v) return null; const l = v.toLowerCase(); return l === 'normal' ? 'Normal' : l === 'moderada' ? 'Moderada' : l === 'alta' ? 'Alta' : null; };
    funcionalHTML = [
      campoComBadge('Assimetria Quadríceps',   assimQ, '%', assimQBadge),
      campoComBadge('Assimetria Isquiotibiais', assimI, '%', assimIBadge),
      campoComBadge('Quadril Dir.',    mobilidade.quadril_dir,   '°', _mobBadgeInline(_classMobInline('Quadril',   mobilidade.quadril_dir))),
      campoComBadge('Quadril Esq.',    mobilidade.quadril_esq,   '°', _mobBadgeInline(_classMobInline('Quadril',   mobilidade.quadril_esq))),
      campoComBadge('Tornozelo Dir.',  mobilidade.tornozelo_dir, '°', _mobBadgeInline(_classMobInline('Tornozelo', mobilidade.tornozelo_dir))),
      campoComBadge('Tornozelo Esq.', mobilidade.tornozelo_esq, '°', _mobBadgeInline(_classMobInline('Tornozelo', mobilidade.tornozelo_esq))),
      campoComBadge('Flexib. Quad. Dir.', flexibilidade.quad_dir, '', _mobBadgeInline(flexLabel(flexibilidade.quad_dir))),
      campoComBadge('Flexib. Quad. Esq.', flexibilidade.quad_esq, '', _mobBadgeInline(flexLabel(flexibilidade.quad_esq))),
    ].join('');
  }

  // Big Five
  let psicHTML = '';
  if (psico?.dados) {
    const d = psico.dados;
    const dims = [
      ['Extroversão',       d.extroversao],
      ['Amabilidade',       d.amabilidade],
      ['Conscienciosidade', d.conscienciosidade],
      ['Estab. Emocional',  d.estabilidade_emocional],
      ['Abertura',          d.abertura_experiencias],
    ];
    const barCor = v => v >= 4 ? '#22c55e' : v >= 3 ? '#eab308' : '#f87171';
    psicHTML = dims.map(([label, val]) => {
      if (val == null) return campo(label, null);
      const pct = Math.round((val / 5) * 100);
      return `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #f9fafb;">
        <span style="font-size:12px;color:#6b7280;">${label}</span>
        <div style="display:flex;align-items:center;gap:8px;">
          <div style="width:60px;height:6px;border-radius:3px;background:#f3f4f6;overflow:hidden;">
            <div style="width:${pct}%;height:100%;background:${barCor(val)};border-radius:3px;"></div>
          </div>
          <span style="font-size:12px;font-weight:700;color:#374151;min-width:20px;text-align:right;">${Number(val).toFixed(1)}</span>
        </div>
      </div>`;
    }).join('');
  }

  return `<div style="padding:20px 24px;">
    ${secao('Avaliação Física',             fisica    ? fisicaHTML    : vazio('Sem avaliação física.'),    fisica?._d)}
    ${secao('Avaliação Funcional',          funcional ? funcionalHTML : vazio('Sem avaliação funcional.'), funcional?._d)}
    ${secao('Perfil Psicológico · BFI-44',  psico     ? psicHTML      : vazio('Sem avaliação psicológica.'), psico?._d)}
  </div>`;
}

async function _cmLoadCarga(atletaId) {
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  const d14 = new Date(hoje);
  d14.setDate(hoje.getDate() - 14);
  const d14Str = d14.toLocaleDateString('en-CA');

  // Sem filtro de range de data no Firestore (evita índice composto) — filtra no JS
  const snap = await getDocs(query(
    collection(db, 'daily_metrics'),
    where('athleteId', '==', atletaId),
    where('clubId',    '==', CLUB_ID)
  ));

  let melhor = null;
  snap.forEach(ds => {
    const d = ds.data();
    if (!d.post?.pse && !d.post?.carga) return;
    if ((d.date || '') < d14Str) return; // só últimos 14 dias
    if (!melhor || (d.date || '') > (melhor.date || '')) melhor = d;
  });

  if (!melhor) {
    return `<div style="padding:32px;text-align:center;color:#9ca3af;font-size:13px;">Sem dados de carga nos últimos 14 dias.</div>`;
  }

  const post = melhor.post || {};
  const dataFmt = melhor.date ? melhor.date.split('-').reverse().join('/') : '—';

  let gpsAtleta = null;
  try {
    const gpsSnap = await getDoc(doc(db, 'clubs', CLUB_ID, 'sessoes', melhor.date));
    if (gpsSnap.exists()) {
      const gpsData = gpsSnap.data()?.gps;
      gpsAtleta = (gpsData?.porAtleta || []).find(a => a.atletaId === atletaId) || null;
    }
  } catch (e) { /* GPS opcional */ }

  function metCard(label, val, sub, cor) {
    return `<div style="background:#f9fafb;border:1px solid #f3f4f6;border-radius:10px;padding:12px 10px;text-align:center;">
      <div style="font-size:20px;font-weight:800;color:${cor || '#374151'};line-height:1;">${val ?? '—'}</div>
      <div style="font-size:10px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;margin-top:4px;">${label}</div>
      ${sub ? `<div style="font-size:9px;color:#9ca3af;margin-top:2px;">${sub}</div>` : ''}
    </div>`;
  }

  const densidadeCor = { 'Leve': '#16a34a', 'Moderada': '#ca8a04', 'Alta': '#ea580c', 'Muito Alta': '#dc2626' };
  const qualLbl = ['', '★ Ruim', '★★ Regular', '★★★ Boa', '★★★★ Muito boa', '★★★★★ Excelente'];

  const km   = gpsAtleta?.distanciaTotal          != null ? (gpsAtleta.distanciaTotal / 1000).toFixed(2) : null;
  const mMin = gpsAtleta?.distanciaPorMin         != null ? Math.round(gpsAtleta.distanciaPorMin)        : null;
  const hsr  = gpsAtleta?.distanciaAltaVelocidade != null ? Math.round(gpsAtleta.distanciaAltaVelocidade): null;

  return `<div style="padding:20px 24px;">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
      <p style="font-size:11px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.06em;margin:0;">Última sessão</p>
      <span style="font-size:12px;color:#9ca3af;">${dataFmt}</span>
    </div>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:16px;">
      ${metCard('PSE', post.pse != null ? post.pse + '/10' : null, null,
        post.pse >= 8 ? '#dc2626' : post.pse >= 6 ? '#ea580c' : post.pse >= 4 ? '#ca8a04' : '#16a34a')}
      ${metCard('Volume', post.volume != null ? post.volume + "'" : null, 'min', '#1d4ed8')}
      ${metCard('Carga', post.carga != null ? Math.round(post.carga) : null, 'UA', '#7c3aed')}
      ${metCard('Densidade', post.densidade || null, null, densidadeCor[post.densidade] || '#6b7280')}
    </div>
    ${post.qualidade ? `<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:10px 14px;margin-bottom:16px;display:flex;justify-content:space-between;align-items:center;">
      <span style="font-size:12px;font-weight:700;color:#15803d;">Qualidade</span>
      <span style="font-size:12px;font-weight:700;color:#15803d;">${qualLbl[post.qualidade] || post.qualidade}</span>
    </div>` : ''}
    ${(km != null || mMin != null || hsr != null) ? `
    <p style="font-size:11px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.06em;margin:0 0 8px;">GPS</p>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;">
      ${metCard('Dist. Total', km != null ? km + ' km' : null, null, '#1e40af')}
      ${metCard('Dist./min', mMin != null ? mMin + ' m/min' : null, null, '#0369a1')}
      ${metCard('HSR', hsr != null ? hsr + ' m' : null, 'alta vel.', '#7c3aed')}
    </div>` : `<p style="font-size:12px;color:#9ca3af;text-align:center;padding:8px 0;">Sem dados de GPS para esta sessão.</p>`}
  </div>`;
}

async function _cmLoadDesempenho(atletaId) {
  const snapPartidas = await getDocs(query(collection(db, 'scout_partidas'), where('clubId', '==', CLUB_ID)));

  let totalJogos = 0, totalMinutos = 0;
  const partidas = [];
  const porData = {};
  snapPartidas.forEach(ds => {
    const p = { id: ds.id, ...ds.data() };
    if (p.data?.toDate) p.data = p.data.toDate().toLocaleDateString('en-CA');
    if (!p.data) return;
    const existing = porData[p.data];
    if (!existing || (existing.fonte === 'manual' && p.fonte !== 'manual')) porData[p.data] = p;
  });
  Object.values(porData).forEach(p => {
    const raw = p.playedSeconds?.[atletaId];
    if (raw == null) return;
    const segs = typeof raw === 'object' ? (raw.seconds ?? 0) : (typeof raw === 'number' ? raw : 0);
    if (segs <= 0) return;
    const min = Math.round(segs / 60);
    totalJogos++;
    totalMinutos += min;
    partidas.push({ data: p.data, adversario: p.adversario || null, minutos: min });
  });
  partidas.sort((a, b) => (b.data || '').localeCompare(a.data || ''));
  const ultimos5 = partidas.slice(0, 5);
  const mediaMin = totalJogos > 0 ? Math.round(totalMinutos / totalJogos) : null;

  const resumo = totalJogos > 0
    ? `<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:20px;">
        <div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;padding:10px;text-align:center;">
          <div style="font-size:24px;font-weight:800;color:#0369a1;">${totalJogos}</div>
          <div style="font-size:10px;font-weight:700;color:#0284c7;text-transform:uppercase;letter-spacing:.04em;margin-top:4px;">Jogos</div>
        </div>
        <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:10px;text-align:center;">
          <div style="font-size:24px;font-weight:800;color:#15803d;">${totalMinutos}'</div>
          <div style="font-size:10px;font-weight:700;color:#16a34a;text-transform:uppercase;letter-spacing:.04em;margin-top:4px;">Minutos</div>
        </div>
        <div style="background:#fafafa;border:1px solid #e5e7eb;border-radius:8px;padding:10px;text-align:center;">
          <div style="font-size:24px;font-weight:800;color:#374151;">${mediaMin}'</div>
          <div style="font-size:10px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;margin-top:4px;">Média/Jogo</div>
        </div>
      </div>`
    : `<div style="background:#f9fafb;border-radius:8px;padding:16px;text-align:center;font-size:12px;color:#9ca3af;margin-bottom:20px;">Sem jogos registrados na temporada.</div>`;

  const jogosHTML = ultimos5.length
    ? ultimos5.map(p => {
        const corMin = p.minutos >= 80 ? '#15803d' : p.minutos >= 45 ? '#c2410c' : '#9ca3af';
        const dataFmt = p.data ? p.data.split('-').reverse().join('/') : '—';
        return `<div style="display:flex;align-items:center;justify-content:space-between;background:#f9fafb;border-radius:6px;padding:8px 12px;">
          <span style="font-size:12px;color:#374151;flex-shrink:0;">${dataFmt}</span>
          ${p.adversario ? `<span style="font-size:12px;color:#6b7280;flex:1;text-align:center;">${p.adversario}</span>` : `<span style="flex:1;"></span>`}
          <span style="font-size:13px;font-weight:700;color:${corMin};flex-shrink:0;">${p.minutos}'</span>
        </div>`;
      }).join('')
    : '';

  return `<div style="padding:20px 24px;">
    ${resumo}
    ${ultimos5.length ? `<p style="font-size:11px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.06em;margin:0 0 8px;">Últimos ${ultimos5.length} Jogos</p><div style="display:flex;flex-direction:column;gap:6px;">${jogosHTML}</div>` : ''}
  </div>`;
}

async function _cmLoadPerfil(atletaId) {
  const snapAval = await getDocs(query(collection(db, 'assessments_functional'), where('athleteId', '==', atletaId), where('clubId', '==', CLUB_ID)));

  let fisica = null;
  snapAval.forEach(ds => {
    const f = ds.data();
    if (f.tipo !== 'fisica') return;
    const d = f.date || f.data || '';
    if (!fisica || d > (fisica._d || '')) fisica = { ...f, _d: d };
  });

  function secTitulo(txt, data) {
    return `<div style="display:flex;align-items:center;justify-content:space-between;margin:0 0 10px;">
      <p style="font-size:11px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.06em;margin:0;">${txt}</p>
      ${data ? `<span style="font-size:11px;color:#9ca3af;">${data.split('-').reverse().join('/')}</span>` : ''}
    </div>`;
  }
  function campo(label, valor, unidade) {
    return `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #f9fafb;">
      <span style="font-size:12px;color:#6b7280;">${label}</span>
      <span style="font-size:12px;font-weight:700;color:#374151;">${valor != null && valor !== '' ? valor + (unidade ? ' ' + unidade : '') : '—'}</span>
    </div>`;
  }
  const vazio = txt => `<p style="font-size:12px;color:#9ca3af;text-align:center;padding:10px 0;">${txt}</p>`;

  let antHTML = '';
  if (fisica?.dados?.antropometria) {
    const ant = fisica.dados.antropometria;
    const peso = ant.peso_kg ?? null;
    const alt  = ant.estatura_cm ?? null;
    const imc  = (peso && alt) ? (peso / ((alt / 100) ** 2)).toFixed(1) : null;
    const gc   = ant.navy?.gc_calculado ?? ant.gordura_percentual ?? null;
    antHTML = [
      campo('Estatura', alt, 'cm'),
      campo('Peso', peso, 'kg'),
      campo('IMC', imc, 'kg/m²'),
      campo('% Gordura', gc != null ? Number(gc).toFixed(1) : null, '%'),
    ].join('');
  }

  return `<div style="padding:20px 24px;">
    <div style="margin-bottom:20px;">
      ${secTitulo('Antropométrica', fisica?._d)}
      ${fisica?.dados?.antropometria ? antHTML : vazio('Sem avaliação antropométrica.')}
    </div>
  </div>`;
}

/* =====================================================
   DEPARTAMENTO MÉDICO (INALTERADO)
===================================================== */
async function carregarDepartamentoMedico() {
  const afastadosEl  = document.getElementById("listaAfastados");
  const transicaoEl  = document.getElementById("listaTransicao");
  const liberadosEl  = document.getElementById("listaLiberados");
  const msgAfastados = document.getElementById("msgAfastados");
  const msgTransicao = document.getElementById("msgTransicao");
  const msgLiberados = document.getElementById("msgLiberados");
  const cntAfastados = document.getElementById("countAfastados");
  const cntTransicao = document.getElementById("countTransicao");
  const cntLiberados = document.getElementById("countLiberados");

  if (afastadosEl) afastadosEl.innerHTML  = '';
  if (transicaoEl) transicaoEl.innerHTML  = '';
  if (liberadosEl) liberadosEl.innerHTML = '';

  // Reseta cache para o PDF
  _dadosMedicos.afastados = [];
  _dadosMedicos.transicao = [];
  _dadosMedicos.liberados = [];

  let nAfastados = 0, nTransicao = 0, nLiberados = 0;

  try {
    // ── Carrega atletas e registros médicos em paralelo ───────────────────
    const [atletasSnap, medicalSnap] = await Promise.all([
      _getDocsCache('athletes', query(
        collection(db, "athletes"), where("clubId","==",CLUB_ID), where("ativo","!=",false)
      )),
      _getDocsCache('assessments_medical', query(
        collection(db, "assessments_medical"), where("clubId","==",CLUB_ID)
      )),
    ]);

    const atletasMap = {}; // id → { nome, posicao, fotoUrl, categoria }
    atletasSnap.forEach(d => {
      atletasMap[d.id] = {
        nome:                  d.data().nome     || d.id,
        posicao:               d.data().posicao  || d.data().position || "",
        fotoUrl:               d.data().fotoUrl  || "",
        categoria:             d.data().categoria || "",
        afastadoAdmin:         d.data().afastadoAdmin         || false,
        motivoAdmin:           d.data().motivoAdmin           || "",
        dataAfastamentoAdmin:  d.data().dataAfastamentoAdmin  || "",
      };
    });
    // Popula cache global
    _atletasMap = atletasMap;
    Object.entries(atletasMap).forEach(([id, a]) => {
      _atletasMedico.set(id, { nome: a.nome, posicao: a.posicao, fotoUrl: a.fotoUrl, categoria: a.categoria, statusMed: "liberado", infoMed: "", dias: null });
    });

    const statusPorAtleta = new Map(); // athleteId → entry mais recente com status

    medicalSnap.forEach(docSnap => {
      const data = docSnap.data();
      const d = data.dados || data;

      const temStatus = !!(d.status || d.statusAtual || data.status || data.statusAtual);
      const ehTipoClinico = data.tipo === "status_clinico"
        || data.tipo === "lesao" || data.tipo === "lesão"
        || d.tipoRegistro === "lesao";
      const temLesao = !!(d.tipoLesao || data.tipoLesao);
      const semAtendimento = !data.tipoAtendimento && !d.tipoAtendimento;

      if (!temStatus && !ehTipoClinico && !(semAtendimento && temLesao)) return;

      const dataReg = data.data || data.date
        || (data.createdAt?.toDate ? data.createdAt.toDate().toLocaleDateString('en-CA') : "");

      const atual = statusPorAtleta.get(data.athleteId);
      if (!atual || dataReg > (atual._dataReg || "")) {
        statusPorAtleta.set(data.athleteId, { ...data, _dataReg: dataReg });
      }
    });

    // ── Identifica afastados e em transição ───────────────
    const atletasRestritos = new Set(); // ids que NÃO vão para Liberados

    const hojeD = new Date(); hojeD.setHours(0,0,0,0);
    function diasCorridos(entry) {
      const dr = entry._dataReg || entry.data || entry.date || "";
      if (!dr) return null;
      return Math.round((hojeD - new Date(dr + "T00:00:00")) / 86400000);
    }
    function diasTag(n) {
      if (n === null) return "";
      const cor = n >= 14 ? "color:#b91c1c;font-weight:700;"
                : n >= 7  ? "color:#d97706;font-weight:600;"
                :            "color:#16a34a;font-weight:600;";
      return `<span style="${cor}font-size:13px;">${n} ${n===1?"dia":"dias"}</span>`;
    }
    function itemHtml(nome, info, dias) {
      return `
        <li class="mb-2 pb-2 border-b border-gray-100 last:border-0">
          <p class="font-medium">${nome}</p>
          ${info ? `<p class="text-xs text-gray-500">${info}</p>` : ""}
          <p class="text-xs mt-0.5">${diasTag(dias)}</p>
        </li>`;
    }

    statusPorAtleta.forEach((entry, athleteId) => {
      if (!atletasMap[athleteId]) return; // ignora atletas desativados ou removidos
      const atleta = atletasMap[athleteId] || { nome: athleteId, posicao: "" };
      const nome = atleta.nome;
      const d = entry.dados || entry;
      const status = (
        d.status || d.statusAtual ||
        entry.status || entry.statusAtual || ""
      ).toLowerCase().trim();
      const tipoLesao = d.tipoLesao || entry.tipoLesao || "";
      const regiao    = d.regiao    || entry.regiao    || "";
      const info = [tipoLesao, regiao].filter(Boolean).join(" · ");
      const dias = diasCorridos(entry);

      if (status === "afastado") {
        if (afastadosEl) afastadosEl.innerHTML += itemHtml(nome, info, dias);
        _dadosMedicos.afastados.push({ nome, info, dias });
        _atletasMedico.set(athleteId, { nome, posicao: atletasMap[athleteId]?.posicao || "", fotoUrl: atletasMap[athleteId]?.fotoUrl || "", categoria: atletasMap[athleteId]?.categoria || "", statusMed: "afastado", infoMed: info, dias });
        atletasRestritos.add(athleteId);
        nAfastados++;
      } else if (status === "transicao" || status === "transição") {
        if (transicaoEl) transicaoEl.innerHTML += itemHtml(nome, info, dias);
        _dadosMedicos.transicao.push({ nome, info, dias });
        _atletasMedico.set(athleteId, { nome, posicao: atletasMap[athleteId]?.posicao || "", fotoUrl: atletasMap[athleteId]?.fotoUrl || "", categoria: atletasMap[athleteId]?.categoria || "", statusMed: "transicao", infoMed: info, dias, dataTransicao: entry._dataReg || null });
        atletasRestritos.add(athleteId);
        nTransicao++;
      }
    });

    // ── Afastados administrativos ─────────────────────────────────────────
    Object.entries(atletasMap).forEach(([id, a]) => {
      if (!a.afastadoAdmin) return;
      const current = _atletasMedico.get(id);
      // Aplica se ainda não está no mapa OU se estava como "liberado" (sem restrição médica ativa)
      if (!current || current.statusMed === "liberado") {
        const diasAdmin = a.dataAfastamentoAdmin
          ? Math.round((hojeD - new Date(a.dataAfastamentoAdmin + "T00:00:00")) / 86400000)
          : null;
        const base = current || { nome: a.nome, posicao: a.posicao || "", fotoUrl: a.fotoUrl || "", categoria: a.categoria || "" };
        _atletasMedico.set(id, { ...base, statusMed: "afastado_admin", infoMed: a.motivoAdmin || "Administrativo", dias: diasAdmin });
        atletasRestritos.add(id);
      }
    });

    // ── Liberados = todos os atletas não restritos, ordenados por posição ──
    const ordemPosicao = ["goleiro","lateral","zagueiro","volante","meia","ponta","centro-avante","centroavante","atacante"];
    const liberadosOrdenados = Object.entries(atletasMap)
      .filter(([id]) => !atletasRestritos.has(id))
      .sort(([, a], [, b]) => {
        const ia = ordemPosicao.indexOf((a.posicao || "").toLowerCase().trim());
        const ib = ordemPosicao.indexOf((b.posicao || "").toLowerCase().trim());
        const oa = ia === -1 ? 99 : ia;
        const ob = ib === -1 ? 99 : ib;
        return oa !== ob ? oa - ob : a.nome.localeCompare(b.nome, "pt-BR");
      });

    liberadosOrdenados.forEach(([id, atleta]) => {
      const { nome, posicao } = atleta;
      if (liberadosEl) liberadosEl.innerHTML += `
        <li class="flex items-center gap-1">
          <span class="font-medium">${nome}</span>
          ${posicao ? `<span class="text-gray-400">· ${posicao}</span>` : ""}
        </li>`;
      _dadosMedicos.liberados.push({ nome, info: posicao, dias: null });
      nLiberados++;
    });

  } catch (error) {
    console.error(error);
  }

  if (msgAfastados) msgAfastados.style.display = nAfastados ? "none" : "block";
  if (msgTransicao) msgTransicao.style.display = nTransicao ? "none" : "block";
  if (msgLiberados) msgLiberados.style.display = nLiberados ? "none" : "block";
  if (cntAfastados) cntAfastados.textContent = nAfastados;
  if (cntTransicao) cntTransicao.textContent = nTransicao;
  if (cntLiberados) cntLiberados.textContent = nLiberados;
}

/* =====================================================
   PRONTIDÃO + RECOVERY (VERSÃO FINAL)
===================================================== */
async function carregarProntidaoERecovery() {

  const listaCriticos = document.getElementById("listaCriticos");
  const listaAtencao = document.getElementById("listaAtencao");
  const listaRecovery = document.getElementById("listaRecovery");

  const msgCriticos = document.getElementById("msgCriticos");
  const msgAtencao = document.getElementById("msgAtencao");
  const msgRecovery = document.getElementById("msgRecovery");

  if (listaCriticos) listaCriticos.innerHTML = '';
  if (listaAtencao)  listaAtencao.innerHTML = '';
  if (listaRecovery) {
    listaRecovery.innerHTML = '';
    listaRecovery._critico  = [];
    listaRecovery._moderado = [];
    listaRecovery._leve     = [];
  }
  _prontidao.criticos = [];
  _prontidao.atencao  = [];

  let temCritico = false;
  let temAtencao = false;
  let temRecovery = false;

  try {
    const atletasSnap = await getDocs(query(
      collection(db, "athletes"), where("clubId","==",CLUB_ID), where("ativo","!=",false)
    ));
    const atletasMap = {};
    atletasSnap.forEach(doc => {
      atletasMap[doc.id] = doc.data().nome || doc.id;
    });

    // ── Carrega fases RTP salvas no Firestore (isolado para não derrubar o resto) ─
    const rtpProgressLocal = {};
    try {
      const rtpSnap = await getDocs(query(
        collection(db, "rtp_progress"), where("clubId", "==", CLUB_ID)
      ));
      rtpSnap.docs.forEach(d => {
        const data = d.data();
        if (data.athleteId) rtpProgressLocal[data.athleteId] = { fase: data.fase ?? 0, dataAvanco: data.dataAvanco ?? null };
      });
    } catch(e) { console.warn("rtp_progress load:", e); }

    // ── Puxa TODO o histórico do clube (para z-score individual) ──
    const _d90 = new Date(); _d90.setDate(_d90.getDate() - 90);
    const _desde = _d90.toLocaleDateString('en-CA');
    const dailySnap = await _getDocsCache('daily_metrics', query(
      collection(db, "daily_metrics"),
      where("clubId","==",CLUB_ID),
      where("date",">=",_desde)
    ));

    // Agrupa registros por atleta (todos os dias)
    const historicoAtleta = {};
    dailySnap.forEach(docSnap => {
      const d = docSnap.data();
      if (!historicoAtleta[d.athleteId]) historicoAtleta[d.athleteId] = [];
      historicoAtleta[d.athleteId].push(d);
    });

    // ── Helpers ──────────────────────────────────────────
    function clamp(v, mn, mx) { return Math.max(mn, Math.min(mx, v)); }

    // Consolida regiões de dor bilaterais: ["Quadríceps Dir.", "Quadríceps Esq."] → ["Quadríceps Dir / Esq"]
    function consolidarRegioes(regioes) {
      const arr = Array.isArray(regioes) ? regioes : [];
      const resultado = [];
      const usados = new Set();
      for (const r of arr) {
        if (usados.has(r)) continue;
        if (r.endsWith(' Dir.')) {
          const base = r.slice(0, -5);
          const par = base + ' Esq.';
          if (arr.includes(par) && !usados.has(par)) {
            resultado.push(base + ' Dir / Esq');
            usados.add(r); usados.add(par);
            continue;
          }
        } else if (r.endsWith(' Esq.')) {
          const base = r.slice(0, -5);
          const par = base + ' Dir.';
          if (arr.includes(par) && !usados.has(par)) {
            resultado.push(base + ' Dir / Esq');
            usados.add(r); usados.add(par);
            continue;
          }
        }
        resultado.push(r);
        usados.add(r);
      }
      return resultado;
    }



    function faseAtleta(registros) {
      const dias = new Set(registros.map(r => r.date)).size;
      if (dias < 7)  return { nome: "bootstrap", dias };
      if (dias < 21) return { nome: "transicao",  dias };
      return           { nome: "maduro",      dias };
    }

    // ── Recomendação de sessão baseada no sistema mais afetado ───
    function recomendacaoSistema(sistema) {
      if (!sistema) return null;
      const mapa = {
        "Subjetivo":     { evitar: "sessões longas e de alta intensidade", liberar: "volume leve ou individualizado" },
        "Autonômico":    { evitar: "intervalados longos e alto volume aeróbio", liberar: "força técnica controlada e tático curto" },
        "Neuromuscular": { evitar: "sprint, pliometria e força pesada", liberar: "técnico leve e aeróbio moderado" },
        "Cognitivo":     { evitar: "tático complexo e alta demanda atencional", liberar: "físico simples ou regenerativo" },
      };
      return mapa[sistema.nome] || null;
    }

    // ── Matriz de ajuste de treino por sistema crítico ────
    // Retorna top 2 sugestões (prioridades 1 e 2 da matriz)
    function matrizConsiderar(sistema) {
      if (!sistema) return null;
      const matriz = {
        "Neuromuscular": [
          "Reduzir magnitude mecânica",
          "Aumentar pausas",
          "Reduzir volume",
          "Reduzir intensidade explosiva",
          "Simplificar se necessário",
        ],
        "Autonômico": [
          "Reduzir intensidade",
          "Aumentar pausas",
          "Reduzir volume",
          "Moderar magnitude mecânica",
          "Reduzir complexidade se sobrecarga geral",
        ],
        "Cognitivo": [
          "Reduzir complexidade",
          "Aumentar pausas",
          "Reduzir intensidade decisional",
          "Reduzir volume",
          "Manter mecânica só se bem tolerada",
        ],
        "Subjetivo": [
          "Reduzir volume",
          "Reduzir densidade",
          "Moderar intensidade",
          "Reduzir magnitude mecânica se dor/fadiga altas",
          "Simplificar complexidade se estresse/sono ruins",
        ],
      };
      const lista = matriz[sistema.nome];
      if (!lista) return null;
      return lista.slice(0, 2); // top 2 prioridades
    }

    // ── Badge visual de sistema ───────────────────────────
    function badgeSistema(sistema) {
      if (!sistema) return "";
      const cores = {
        "Subjetivo":     "bg-orange-100 text-orange-700",
        "Autonômico":    "bg-blue-100 text-blue-700",
        "Neuromuscular": "bg-purple-100 text-purple-700",
        "Cognitivo":     "bg-teal-100 text-teal-700",
      };
      const cor = cores[sistema.nome] || "bg-gray-100 text-gray-600";
      return `<span class="text-xs font-semibold px-2 py-0.5 rounded-full ${cor}">${sistema.nome}</span>`;
    }

    // ── Mini-badges dos 4 sistemas ────────────────────────
    // Só exibe sistemas com pelo menos um indicador coletado.
    // Se sobrar apenas 1 badge, omite a linha (a causa escrita já diz tudo).
    function miniBadgesSistemas(IH, IA, INM, IC, coletados) {
      // Só sistemas alterados no dia, nomes completos
      // Amarelo = atenção, Vermelho = crítico
      const cor = score => score === 1 ? "bg-yellow-100 text-yellow-700"
                                       : "bg-red-100 text-red-700";

      const alterados = [
        coletados.IH  && IH  > 0 ? { label: "Subjetivo",     score: IH  >= 2 ? 2 : 1 } : null,
        coletados.IA  && IA  > 0 ? { label: "Autonômico",    score: IA  >= 3 ? 2 : 1 } : null,
        coletados.INM && INM > 0 ? { label: "Neuromuscular", score: INM >= 3 ? 2 : 1 } : null,
        coletados.IC  && IC  > 0 ? { label: "Cognitivo",     score: IC  >= 3 ? 2 : 1 } : null,
      ].filter(Boolean);

      if (alterados.length === 0) return "";

      return alterados
        .map(c => `<span class="text-xs px-1.5 py-0.5 rounded font-medium ${cor(c.score)}">${c.label}</span>`)
        .join(" ");
    }

    // ── Helper: formata causas com regiões de dor em negrito ──
    function formatarCausasHTML(causasStr, corBase) {
      if (!causasStr) return "";
      return causasStr.split(" · ").map(c => {
        if (c.startsWith("Dor")) {
          const partes = c.split(" · ");
          const label = partes[0];
          const regioes = partes.slice(1).join(", ");
          const dorVal = parseInt((label.match(/Dor \((\d+)\/7\)/) || [])[1] || "0");
          const corDor = dorVal >= 5 ? "text-red-600" : corBase;
          return regioes
            ? `<span class="${corDor}">${label}</span> <span class="font-bold text-gray-900">${regioes}</span>`
            : `<span class="${corDor}">${label}</span>`;
        }
        return `<span>${c}</span>`;
      }).join(" · ");
    }

    // Persiste no cache de módulo para uso na tendência dos cards
    _historicoAtleta = historicoAtleta;
    const historicoFlat = Object.values(historicoAtleta).flat();

    // ── Processa apenas registros de HOJE ─────────────────
    Object.entries(historicoAtleta).forEach(([athleteId, registros]) => {
      const dataHoje = registros.find(r => r.date === hoje);
      if (!dataHoje) return;

      const nome = atletasMap[athleteId] || athleteId;

      // ── Calcula prontidão via função canônica (stats.js) ─
      const calc = _calcularProntidao({ ...dataHoje, athleteId }, historicoFlat, hoje);
      const { IH, IA, INM, IC, maisPrejudicado } = calc;
      const salto      = dataHoje.pre?.salto          ?? null;
      const lnRR       = dataHoje.hrv?.lnRR           ?? null;
      const neuroScore = dataHoje.neuro?.score        ?? null;
      const sono       = dataHoje.pre?.sono           ?? null;
      const estresse   = dataHoje.pre?.estresse       ?? null;
      const dor        = dataHoje.pre?.dor            ?? null;
      const hooper         = dataHoje.pre?.hooper         ?? null;
      const humorEmocional = dataHoje.pre?.humorEmocional ?? null;
      const ispTend = _calcularISPTendencia(athleteId, historicoFlat, hoje);

      // ── Flag de estado de fadiga (Aguda / Residual / Persistente) ─────────
      const fadigaFlag = (() => {
        const agudaIH  = IH  != null && IH  < 60;
        const agudaINM = INM != null && INM < 50;
        const agudaDor = dor != null && dor >= 4;
        const isAguda  = agudaIH || agudaINM || agudaDor;

        // Residual: média ponderada IH+INM nos últimos 3 dias abaixo de 63
        const ult3 = registros
          .filter(r => r.date <= hoje)
          .sort((a, b) => b.date.localeCompare(a.date))
          .slice(0, 3)
          .reverse();
        let isResidual = false;
        if (ult3.length >= 2) {
          const _pesos = ult3.length === 3 ? [0.2, 0.3, 0.5] : [0.4, 0.6];
          const compostos = ult3.map(dm => {
            const ih  = calcularHooperScore(dm.pre?.hooper ?? null);
            const inm = calcularZScoreCMJ(athleteId, dm.pre?.salto ?? null, dm.pre?.dor ?? null, historicoFlat, dm.date);
            const vals = [ih, inm].filter(v => v != null);
            return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
          });
          const validos = compostos.filter(v => v != null);
          if (validos.length >= 2) {
            const pesos = _pesos.slice(-validos.length);
            const somaP = pesos.reduce((a, b) => a + b, 0);
            const media = validos.reduce((acc, v, i) => acc + v * pesos[i], 0) / somaP;
            isResidual = media < 63 && !isAguda;
          }
        }

        // Persistente: ISP global em queda consistente — sinal de fadiga estrutural
        // (não requer retrocomputing: aproveita o ISP já calculado)
        const isPersistente = ispTend?.global?.label === 'Piorando';

        // Precedência: Persistente > Residual > Aguda > Nenhuma
        if (isPersistente) {
          const piores = [
            ispTend?.IH?.label  === 'Piorando' ? 'Subjetivo'     : null,
            ispTend?.IA?.label  === 'Piorando' ? 'Autonômico'    : null,
            ispTend?.INM?.label === 'Piorando' ? 'Neuromuscular' : null,
            ispTend?.IC?.label  === 'Piorando' ? 'Cognitivo'     : null,
          ].filter(Boolean);
          return { nivel: 'persistente', eixoPrincipal: piores[0] ?? 'ISP' };
        }
        if (isResidual) {
          return { nivel: 'residual', eixoPrincipal: agudaINM ? 'Neuromuscular' : 'Subjetivo' };
        }
        if (isAguda) {
          return { nivel: 'aguda', eixoPrincipal: agudaINM ? 'Neuromuscular' : agudaDor ? 'Dor' : 'Subjetivo' };
        }
        return { nivel: 'nenhuma', eixoPrincipal: null };
      })();

      // ── Tendência: regressão linear do global (últimas 4 semanas) ────────
      const tendencia = (() => {
        const corte = new Date(); corte.setDate(corte.getDate() - 28);
        const cortStr = corte.toLocaleDateString('en-CA');
        const janela = registros.filter(r => r.date >= cortStr && r.date < hoje);
        if (janela.length < 5) return null;
        // Calcula global de cada ponto da janela
        const pontos = [];
        janela.forEach((dm, idx) => {
          const c = _calcularProntidao({ ...dm, athleteId }, historicoFlat, dm.date);
          if (c.global != null) pontos.push({ x: idx, y: c.global });
        });
        if (pontos.length < 5) return null;
        const n = pontos.length;
        const sx  = pontos.reduce((s, p) => s + p.x, 0);
        const sy  = pontos.reduce((s, p) => s + p.y, 0);
        const sx2 = pontos.reduce((s, p) => s + p.x * p.x, 0);
        const sxy = pontos.reduce((s, p) => s + p.x * p.y, 0);
        const denom = n * sx2 - sx * sx;
        if (denom === 0) return null;
        const slope = (n * sxy - sx * sy) / denom;
        if      (slope >  0.3) return { seta: "↑", cor: "#15803d", title: `Melhora (${slope.toFixed(2)}/dia)` };
        else if (slope < -0.3) return { seta: "↓", cor: "#b91c1c", title: `Queda (${slope.toFixed(2)}/dia)` };
        else                   return { seta: "→", cor: "#92400e", title: `Estável (${slope.toFixed(2)}/dia)` };
      })();


      // Classes por sistema: < 50 = crítico, < 60 = atenção, < 70 = atenção leve
      const classSistema = v => v == null ? null : v < 50 ? "critico" : v < 60 ? "atencao" : v < 70 ? "atencao_leve" : null;
      // Classes por subescala Hooper (1–7) — cada indicador usa seu valor bruto
      const classFadiga   = (() => {
        const fadiga = dataHoje.pre?.fadiga ?? null;
        if (fadiga == null) return null;
        if (fadiga >= 6) return "critico";
        if (fadiga >= 5) return "atencao";
        return null;
      })();
      const classDor      = (() => {
        if (dor == null) return null;
        if (dor >= 6) return "critico";
        if (dor >= 4) return "atencao";
        return null;
      })();
      const classSono     = (() => {
        if (sono == null) return null;
        if (sono >= 6) return "critico";
        if (sono >= 5) return "atencao";
        return null;
      })();
      const classEstresse = (() => {
        if (estresse == null) return null;
        if (estresse >= 6) return "critico";
        if (estresse >= 5) return "atencao";
        return null;
      })();
      const classHRV   = classSistema(IA);
      const classCMJ   = INM == null ? null : INM < 40 ? "critico" : INM < 50 ? "atencao" : INM < 60 ? "atencao_leve" : null;
      const classNeuro = classSistema(IC);

      const status = calc.status ?? "Sem dados";

      const recSistema = recomendacaoSistema(maisPrejudicado);

      // ── Monta causas legíveis ────────────────────────────
      // Hooper subescalas: mostrar valor bruto 1–7 quando alterado
      // VFC / Salto / Cognitivo: mostrar score 0–100
      const causas = [];

      // Subescalas Hooper (1–7, limiar ≥ 5 = atenção, ≥ 6 = crítico)
      if (sono     != null && sono     >= 5) causas.push(`Sono (${sono}/7)`);
      if (estresse != null && estresse >= 5) causas.push(`Estresse (${estresse}/7)`);
      // Fadiga: usa IH (score 0–100 do hooper total) como proxy — mostra bruto se subescalas OK
      const fadiga = dataHoje.pre?.fadiga ?? null;
      if (fadiga   != null && fadiga   >= 5) causas.push(`Fadiga (${fadiga}/7)`);
      if (dor      != null && dor      >= 4) {
        const regioes = dataHoje?.pre?.regioes_dor;
        const regioesFmt = consolidarRegioes(regioes || []);
        const localStr = regioesFmt.length ? `: ${regioesFmt.join(", ")}` : "";
        causas.push(`Dor (${dor}/7)${localStr}`);
      }
      // Se nenhuma subescala isolada acendeu mas o IH global está baixo, mostra o hooper total
      if (causas.filter(c => c.startsWith("Sono") || c.startsWith("Estresse") || c.startsWith("Fadiga") || c.startsWith("Dor")).length === 0) {
        if (IH != null && IH < 50) causas.push(`Hooper (${hooper})`);
      }

      // VFC, Salto, Cognitivo com score 0–100
      if (IA  != null && IA  < 70) causas.push(`VFC (${Math.round(IA)}/100)`);
      if (INM != null && INM < 60) causas.push(`Salto (${Math.round(INM)}/100)`);
      if (IC  != null && IC  < 70) causas.push(`Cognitivo (${Math.round(IC)}/100)`);

      // Fallback: status alterado mas sem causas específicas
      if (causas.length === 0 && status !== "Estável" && status !== "Sem dados") {
        const todos = [
          IH  != null ? { label: "Fadiga",    val: IH  } : null,
          IA  != null ? { label: "VFC",       val: IA  } : null,
          INM != null ? { label: "Salto",     val: INM } : null,
          IC  != null ? { label: "Cognitivo", val: IC  } : null,
        ].filter(Boolean).sort((a, b) => a.val - b.val);
        if (todos[0]) causas.push(`${todos[0].label} (${Math.round(todos[0].val)}/100)`);
      }

      const causasStr = causas.join(" · ");

      // Flag DM: atleta deve passar pelo fisioterapeuta antes do treino
      // Critérios: Dor ≥ 5, IGP Crítico (<50), INM crítico (<40)
      const flagDMMotivos = [];
      if (dor != null && dor >= 5)   flagDMMotivos.push(`Dor ${dor}/7`);
      if (status === 'Crítico')      flagDMMotivos.push(`IGP Crítico (${calc.global != null ? Math.round(calc.global) : '—'})`);
      if (classCMJ === 'critico')    flagDMMotivos.push('INM crítico');
      const flagDM = flagDMMotivos.length > 0;

      // Sistemas com dados coletados (para miniBadges)
      const coletados = {
        IH:  IH  != null,
        IA:  IA  != null,
        INM: INM != null,
        IC:  IC  != null,
      };

      const faseBadge = faseAtleta(registros).nome === "bootstrap"
        ? `<span class="text-xs text-gray-400 italic">(bootstrap)</span>`
        : "";

      /* ===== MICRO-RECOVERY / PAP ===== */
      prescricaoMicroRecovery(nome, athleteId, status, {
        classSono, classEstresse, classFadiga, classDor,
        classHRV, classCMJ, classNeuro,
        sono, estresse, fadiga, dor, hrv: lnRR, cmjZ: INM, neuroScore, ispTend,
        sistema: maisPrejudicado?.nome || null,
      });

      /* ===== PRONTIDÃO ===== */
      if (status === "Crítico") {
        const recHTML = recSistema
          ? `<p class="text-xs text-red-600 mt-1"><span class="font-bold">✗</span> ${recSistema.evitar}</p>`
          : "";
        const considerarTop2 = matrizConsiderar(maisPrejudicado);
        const considerarHTML = considerarTop2
          ? `<div class="mt-1.5 bg-blue-50 border border-blue-100 rounded px-2 py-1">
               <p class="text-[10px] font-semibold text-blue-500 uppercase tracking-wide mb-0.5">Considerar no treino</p>
               ${considerarTop2.map((s, i) => `<p class="text-xs text-blue-700"><span class="font-bold">${i + 1}.</span> ${s}</p>`).join("")}
             </div>`
          : "";
        const sistemaBadgesHTML = miniBadgesSistemas(
          IH  != null && IH  < 60 ? (IH  < 50 ? 2 : 1) : 0,
          IA  != null && IA  < 60 ? (IA  < 50 ? 2 : 1) : 0,
          INM != null && INM < 50 ? (INM < 40 ? 2 : 1) : 0,
          IC  != null && IC  < 60 ? (IC  < 50 ? 2 : 1) : 0,
          coletados
        );
        if (listaCriticos) listaCriticos.innerHTML += `
          <li class="mb-2 pb-2 border-b border-gray-100 last:border-0">
            <div class="flex items-center gap-1 flex-wrap">
              <p class="font-semibold">${nome}</p>
              ${faseBadge}
            </div>
            <p class="text-red-600 mt-0.5">${formatarCausasHTML(causasStr, "text-red-600")}</p>
            ${sistemaBadgesHTML ? `<div class="flex flex-wrap gap-1 mt-1">${sistemaBadgesHTML}</div>` : ""}
            ${recHTML}
            ${considerarHTML}
          </li>
        `;
        _prontidao.criticos.push({ nome, causas: causasStr, sistema: maisPrejudicado?.nome || null, rec: recSistema });
        _atletasProntidao.set(athleteId, { status: "Crítico", causas: causasStr, sistema: maisPrejudicado?.nome || null, global: calc.global, IH: calc.IH, IA: calc.IA, INM: calc.INM, IC, dor, tendencia, ispTend, classSono, classFadiga, classEstresse, classDor, classHRV, classCMJ, classNeuro, flagDM, flagDMMotivos, humorEmocional, fadigaFlag });
        temCritico = true;
      }

      if (status === "Atenção" || status === "Atenção Leve") {
        const recHTML = recSistema
          ? `<p class="text-xs text-red-600 mt-1"><span class="font-bold">✗</span> ${recSistema.evitar}</p>`
          : "";
        const considerarTop2 = matrizConsiderar(maisPrejudicado);
        const considerarHTML = considerarTop2
          ? `<div class="mt-1.5 bg-blue-50 border border-blue-100 rounded px-2 py-1">
               <p class="text-[10px] font-semibold text-blue-500 uppercase tracking-wide mb-0.5">Considerar no treino</p>
               ${considerarTop2.map((s, i) => `<p class="text-xs text-blue-700"><span class="font-bold">${i + 1}.</span> ${s}</p>`).join("")}
             </div>`
          : "";
        const sistemaBadgesHTML = miniBadgesSistemas(
          IH  != null && IH  < 60 ? (IH  < 50 ? 2 : 1) : 0,
          IA  != null && IA  < 60 ? (IA  < 50 ? 2 : 1) : 0,
          INM != null && INM < 50 ? (INM < 40 ? 2 : 1) : 0,
          IC  != null && IC  < 60 ? (IC  < 50 ? 2 : 1) : 0,
          coletados
        );
        if (listaAtencao) listaAtencao.innerHTML += `
          <li class="mb-2 pb-2 border-b border-gray-100 last:border-0">
            <div class="flex items-center gap-1 flex-wrap">
              <p class="font-semibold">${nome}</p>
              ${faseBadge}
            </div>
            <p class="text-yellow-700 mt-0.5">${formatarCausasHTML(causasStr, "text-yellow-700")}</p>
            ${sistemaBadgesHTML ? `<div class="flex flex-wrap gap-1 mt-1">${sistemaBadgesHTML}</div>` : ""}
            ${recHTML}
            ${considerarHTML}
          </li>
        `;
        _prontidao.atencao.push({ nome, causas: causasStr, sistema: maisPrejudicado?.nome || null, rec: recSistema });
        _atletasProntidao.set(athleteId, { status, causas: causasStr, sistema: maisPrejudicado?.nome || null, global: calc.global, IH: calc.IH, IA: calc.IA, INM: calc.INM, IC, dor, tendencia, ispTend, classSono, classFadiga, classEstresse, classDor, classHRV, classCMJ, classNeuro, flagDM, flagDMMotivos, humorEmocional, fadigaFlag });
        temAtencao = true;
      }

      // Estável — registra no cache para o grid de cards (com causas se houver indicadores em atenção)
      if (status === "Estável") {
        _atletasProntidao.set(athleteId, { status: "Estável", causas: causasStr, sistema: maisPrejudicado?.nome || null, global: calc.global, IH: calc.IH, IA: calc.IA, INM: calc.INM, IC, tendencia, ispTend, classSono, classFadiga, classEstresse, classDor, classHRV, classCMJ, classNeuro, flagDM, flagDMMotivos, humorEmocional, fadigaFlag });

        // Exibe na lista de Atenção se houver dor >= 4 mesmo com status global Estável
        if (classDor) {
          if (listaAtencao) listaAtencao.innerHTML += `
            <li class="mb-2 pb-2 border-b border-gray-100 last:border-0">
              <div class="flex items-center gap-1 flex-wrap">
                <p class="font-semibold">${nome}</p>
                ${faseBadge}
              </div>
              <p class="text-yellow-700 mt-0.5">${formatarCausasHTML(causasStr, "text-yellow-700")}</p>
            </li>
          `;
          temAtencao = true;
        }
      }

      // "Sem dados" com flagDM — ex: dor ≥ 5 sem IGP calculável
      if (status === "Sem dados" && flagDM) {
        _atletasProntidao.set(athleteId, { status: "Sem dados", causas: causasStr, sistema: null, global: null, IH: calc.IH, IA: calc.IA, INM: calc.INM, IC, dor, tendencia: null, classSono, classFadiga, classEstresse, classDor, classHRV, classCMJ, classNeuro, flagDM, flagDMMotivos, humorEmocional, fadigaFlag });
      }

      // ── Sistema mais afetado na semana (segunda-feira da semana atual) ──
      {
        const hojeW  = new Date();
        const dowW   = hojeW.getDay(); // 0=Dom, 1=Seg … 6=Sab
        const corte  = new Date(hojeW);
        corte.setDate(hojeW.getDate() - (dowW === 0 ? 6 : dowW - 1));
        const cortStr = corte.toLocaleDateString('en-CA');
        const janela7 = registros.filter(r => r.date >= cortStr);

        const soma  = { Subjetivo: 0, Autonômico: 0, Neuromuscular: 0, Cognitivo: 0 };
        const cont  = { Subjetivo: 0, Autonômico: 0, Neuromuscular: 0, Cognitivo: 0 };

        janela7.forEach(dm => {
          const c = _calcularProntidao({ ...dm, athleteId }, historicoFlat, dm.date);
          if (c.IH  != null) { soma.Subjetivo     += c.IH;  cont.Subjetivo++;     }
          if (c.IA  != null) { soma.Autonômico     += c.IA;  cont.Autonômico++;    }
          if (c.INM != null) { soma.Neuromuscular  += c.INM; cont.Neuromuscular++; }
          if (c.IC  != null) { soma.Cognitivo      += c.IC;  cont.Cognitivo++;     }
        });

        const medias = {};
        Object.keys(soma).forEach(s => { if (cont[s] > 0) medias[s] = soma[s] / cont[s]; });

        if (Object.keys(medias).length > 0) {
          const [sistNome, sistMedia] = Object.entries(medias).sort((a, b) => a[1] - b[1])[0];
          _sistemaSemanal.set(athleteId, { nome: sistNome, media: Math.round(sistMedia), dias: janela7.length });
        }
      }

      /* ===== RECOVERY (Modelo Ciente IE) ===== */

      if (status !== "Estável") {

        // ── Normaliza scores 0–100 para 0–1 (inverte: 100=ótimo → 0, 0=pior → 1)
        const normIH  = IH  != null ? clamp((100 - IH)  / 100, 0, 1) : 0;
        const normIA  = IA  != null ? clamp((100 - IA)  / 100, 0, 1) : 0;
        const normINM = INM != null ? clamp((100 - INM) / 100, 0, 1) : 0;
        const normIC  = IC  != null ? clamp((100 - IC)  / 100, 0, 1) : 0;

        const scoreRecovery = normIH * 0.30 + normIA * 0.30 + normINM * 0.25 + normIC * 0.15;

        const temCriticoQualquer = [classSono, classEstresse, classFadiga, classDor,
                                     classHRV, classCMJ, classNeuro].some(c => c === "critico");
        const temAtencaoQualquer = [classSono, classEstresse, classFadiga, classDor,
                                     classHRV, classCMJ, classNeuro].some(c => c === "atencao" || c === "atencao_leve");

        let nivel, corNivel, acaoNivel;
        if (scoreRecovery >= 0.40 || (temCriticoQualquer && scoreRecovery >= 0.25)) {
          nivel     = "Alto";
          corNivel  = "text-red-700 bg-red-50 border border-red-200";
          acaoNivel = "Recuperação Ativa obrigatória · Ajuste de carga";
        } else if (scoreRecovery >= 0.20 || temCriticoQualquer) {
          nivel     = "Moderado";
          corNivel  = "text-orange-700 bg-orange-50 border border-orange-200";
          acaoNivel = "Recuperação Ativa · 2–3 modalidades";
        } else {
          nivel     = "Leve";
          corNivel  = "text-yellow-700 bg-yellow-50 border border-yellow-200";
          acaoNivel = "Recuperação Ativa · 1 modalidade";
        }

        const dominiosAtivos = [IH, IA, INM, IC].filter(v => v != null && v < 50).length || 1;

        // ── Protocolos por indicador ──────────────────────
        const protocolos = [];

        // ── N3: SONO ──────────────────────────────────────
        // Respiração reduz arousal cortical; gelo não tem relação com sono
        if (classSono === "critico" || classSono === "atencao")
          protocolos.push({ m: "Respiração Guiada 4-7-8", d: "5–8 min", grupo: "respiracao" });

        // ── N3: ESTRESSE ──────────────────────────────────
        // Atenção → Respiração Guiada (proporcional, sem equipamento)
        // Crítico → entra na contagem autonômica para decisão do Pulsetto (abaixo)
        if (classEstresse === "atencao")
          protocolos.push({ m: "Respiração Guiada 4-7-8", d: "5–8 min", grupo: "respiracao" });

        // ── N2: FADIGA ────────────────────────────────────
        // Crítico: menor intensidade + foam roller para não aprofundar fadiga
        // Atenção: active recovery clássico
        if (classFadiga === "critico")
          protocolos.push({ m: "Bike leve 50–60% FCmáx + Foam roller", d: "20 min" });
        else if (classFadiga === "atencao")
          protocolos.push({ m: "Bike 60–70% FCmáx", d: "15–20 min" });

        // ── N2: DOR ───────────────────────────────────────
        // Crítico: compressão + gelo localizado
        // Atenção: só compressão
        if (classDor === "critico")
          protocolos.push({ m: "Botas compressão + Gelo localizado", d: "25–30 min", grupo: "gelo" });
        else if (classDor === "atencao")
          protocolos.push({ m: "Botas de compressão 80 mmHg", d: "20–30 min" });

        // ── N2: CMJ ───────────────────────────────────────
        if (classCMJ === "critico")      protocolos.push({ m: "Botas + Gelo", d: "30–45 min", grupo: "gelo" });
        else if (classCMJ === "atencao") protocolos.push({ m: "Gelo + Bike",  d: "25–30 min", grupo: "gelo" });

        // ── N1: PULSETTO — regra autonômica unificada ─────
        // Indicadores autonômicos: HRV, NeuroScore, Estresse crítico
        // Pulsetto → ≥1 autonômico crítico OU ≥2 autonômicos em atenção
        // Respiração Guiada → apenas 1 autonômico em atenção (sem Estresse crítico)
        const autCriticos = [classHRV, classNeuro].filter(c => c === "critico").length
                          + (classEstresse === "critico" ? 1 : 0);
        const autAtencao  = [classHRV, classNeuro].filter(c => c === "atencao").length
                          + (classEstresse === "atencao" ? 1 : 0);

        if (autCriticos >= 1) {
          const partes = [];
          if (classHRV    === "critico") partes.push("Respiração");
          if (classNeuro  === "critico") partes.push("Mindfulness");
          const label = partes.length > 0 ? `Pulsetto + ${partes.join(" + ")}` : "Pulsetto";
          protocolos.push({ m: label, d: "15–20 min", grupo: "pulsetto" });
        } else if (autAtencao >= 2) {
          protocolos.push({ m: "Pulsetto", d: "15 min", grupo: "pulsetto" });
        } else if (autAtencao === 1) {
          // Já pode ter sido adicionada Respiração Guiada por sono/estresse acima;
          // grupo "respiracao" garante que não duplica
          protocolos.push({ m: "Respiração Guiada 4-7-8", d: "5–8 min", grupo: "respiracao" });
        }

        // Remove duplicatas por grupo (mantém primeira ocorrência de cada grupo)
        const gruposVistos = new Set();
        const protocolosUnicos = protocolos.filter(p => {
          const chave = p.grupo || p.m;
          if (gruposVistos.has(chave)) return false;
          gruposVistos.add(chave);
          return true;
        });

        const limite = dominiosAtivos >= 3 ? 4 : dominiosAtivos === 2 ? 3 : 2;
        const protocolosFinal = protocolosUnicos.slice(0, limite);

        if (protocolosFinal.length === 0)
          protocolosFinal.push({ m: "Mobilidade leve + Alongamento passivo", d: "15–20 min" });

        // ── Prioridade: sistema mais comprometido (maior normX = pior) ──
        const scoresDominio = [
          { nome: "Subjetivo",     cor: "text-orange-700 bg-orange-50 border border-orange-200", score: normIH  },
          { nome: "Autonômico",    cor: "text-blue-700 bg-blue-50 border border-blue-200",        score: normIA  },
          { nome: "Neuromuscular", cor: "text-red-700 bg-red-50 border border-red-200",            score: normINM },
          { nome: "Cognitivo",     cor: "text-purple-700 bg-purple-50 border border-purple-200",   score: normIC  },
        ].filter(s => s.score > 0);
        scoresDominio.sort((a, b) => b.score - a.score);
        const prioridade = scoresDominio[0] || { nome: maisPrejudicado?.nome || "Geral", cor: "text-gray-600 bg-gray-50 border border-gray-200" };

        const sugestaoTexto = protocolosFinal
          .map(p => `${p.m} <span class="text-gray-400">${p.d}</span>`)
          .join(" &nbsp;·&nbsp; ");

        if (listaRecovery) {
          listaRecovery._critico  = listaRecovery._critico  || [];
          listaRecovery._moderado = listaRecovery._moderado || [];
          listaRecovery._leve     = listaRecovery._leve     || [];
          listaRecovery._geral    = listaRecovery._geral    || [];
        }

        // Objeto estruturado para o PDF (sem precisar parsear HTML)
        const cardData = {
          nome,
          prioNome: prioridade.nome,
          sugestao: protocolosFinal.map(p => p.m + " (" + p.d + ")").join(" - "),
        };
        _recoveryCardDataMap.set(athleteId, cardData.sugestao);

        const cardHTML = `
          <div class="py-3 border-b border-gray-100 last:border-0" data-pdfnome="${nome.replace(/"/g,'&quot;')}" data-pdfprio="${prioridade.nome.replace(/"/g,'&quot;')}" data-pdfsug="${protocolosFinal.map(p => p.m + ' (' + p.d + ')').join(' - ').replace(/"/g,'&quot;')}">
            <div class="flex items-center justify-between mb-1">
              <p class="font-semibold text-sm text-gray-800">${nome}</p>
            </div>
            <p class="text-xs mb-1">
              <span class="text-gray-400 font-medium">Prioridade:</span>
              <span class="font-semibold px-1.5 py-0.5 rounded ${prioridade.cor}">${prioridade.nome}</span>
            </p>
            <p class="text-xs text-gray-600">
              <span class="text-gray-400 font-medium">Sugestão:</span>
              ${sugestaoTexto}
            </p>
          </div>`;

        if (listaRecovery) {
          if      (nivel === "Alto")     listaRecovery._critico.push(cardHTML);
          else if (nivel === "Moderado") listaRecovery._moderado.push(cardHTML);
          else                           listaRecovery._leve.push(cardHTML);
        }
        temRecovery = true;
      } else {
        // ── Estável → Recovery Geral (opcional) ───────────
        if (listaRecovery) {
          listaRecovery._geral = listaRecovery._geral || [];
          listaRecovery._geral.push(nome);
        }
      }

      // Armazena fase RTP com piso do Firestore — salva se avançou
      const _statusMedRTP = _atletasMedico.get(athleteId)?.statusMed;
      if (_statusMedRTP && _statusMedRTP !== "liberado" && _statusMedRTP !== "afastado") {
        const _rtpEntry = rtpProgressLocal[athleteId] ?? { fase: 0, dataAvanco: null };
        const faseSalvaRTP = _rtpEntry.fase ?? 0;
        const dataAvancoRTP = _rtpEntry.dataAvanco ?? null;
        const dataTransicaoRTP = _atletasMedico.get(athleteId)?.dataTransicao ?? null;

        // F2+ exige salto pós-transição; sem ele, piso é F1 (mesmo regra do prontidao.js)
        // Se o avanço salvo é de um ciclo anterior à transição atual, zera (novo ciclo de lesão)
        const faseSalvaValida = (() => {
          if (faseSalvaRTP <= 0) return 0;
          // Novo ciclo de lesão: avanço registrado antes do início da transição atual
          if (dataTransicaoRTP && dataAvancoRTP && dataAvancoRTP < dataTransicaoRTP) return 0;
          if (!dataTransicaoRTP) return faseSalvaRTP;
          const temSaltoPosTrans = registros.some(
            r => r.pre?.salto != null && r.date >= dataTransicaoRTP
          );
          if (!temSaltoPosTrans && faseSalvaRTP >= 2) return 1;
          return faseSalvaRTP;
        })();

        // Injeta último salto e última VFC se não coletados hoje
        // Salto: só considera registros APÓS início da transição (evita usar CMJ pré-lesão)
        let dmRTPef = dataHoje;
        if (!dataHoje?.pre?.salto) {
          const lastSaltoRTP = registros
            .filter(r => r.date < hoje && r.pre?.salto != null
                         && (!dataTransicaoRTP || r.date >= dataTransicaoRTP))
            .sort((a, b) => b.date.localeCompare(a.date))[0]?.pre?.salto;
          if (lastSaltoRTP != null)
            dmRTPef = { ...dmRTPef, pre: { ...(dmRTPef.pre || {}), salto: lastSaltoRTP } };
        }
        if (!dmRTPef?.hrv?.lnRR) {
          const lastHrvRTP = registros
            .filter(r => r.date < hoje && r.hrv?.lnRR != null)
            .sort((a, b) => b.date.localeCompare(a.date))[0]?.hrv;
          if (lastHrvRTP != null)
            dmRTPef = { ...dmRTPef, hrv: { ...(dmRTPef.hrv || {}), lnRR: lastHrvRTP.lnRR } };
        }
        const calcRTP = dmRTPef === dataHoje ? calc : _calcularProntidao({ ...dmRTPef, athleteId }, historicoFlat, dmRTPef.date ?? hoje);
        const faseRTPstore = calcularFaseRTP(_statusMedRTP, { global: calcRTP.global, inFadiga: calcRTP.IH, inMuscular: calcRTP.INM, inAutonomico: calcRTP.IA, dor: dmRTPef?.pre?.dor ?? null }, faseSalvaValida);
        if (faseRTPstore != null) {
          _atletasFaseRTP.set(athleteId, faseRTPstore);
          // Salva no Firestore se avançou
          if (faseRTPstore.fase > faseSalvaValida) {
            rtpProgressLocal[athleteId] = { fase: faseRTPstore.fase, dataAvanco: hoje };
            setDoc(doc(db, "rtp_progress", `${CLUB_ID}_${athleteId}`), {
              athleteId, clubId: CLUB_ID,
              fase: faseRTPstore.fase,
              dataAvanco: hoje,
              updatedAt: serverTimestamp()
            }, { merge: true }).catch(e => console.warn("salvarRTPProgress:", e));
          }
        }
      }

    });

    // Para atletas sem dados hoje: usa fase salva no Firestore
    Object.entries(rtpProgressLocal).forEach(([athleteId, entry]) => {
      const fase       = entry?.fase ?? 0;
      const dataAvanco = entry?.dataAvanco ?? null;
      if (!_atletasFaseRTP.has(athleteId) && fase > 0) {
        const med = _atletasMedico.get(athleteId);
        if (med?.statusMed === "transicao") {
          // Ignora fase de ciclo anterior
          const dataTransicao = med.dataTransicao ?? null;
          const faseValida = (dataTransicao && dataAvanco && dataAvanco < dataTransicao) ? 1 : fase;
          _atletasFaseRTP.set(athleteId, _buildFaseObjDash(faseValida));
        }
      }
    });

    // Fallback: lê cache localStorage gravado pelo prontidao.js para atletas ainda sem fase
    // Garante que o dashboard veja a mesma fase calculada pelo prontidão mesmo antes de um avanço no Firestore
    try {
      const localRTPCache = JSON.parse(localStorage.getItem(`rtp_cache_${CLUB_ID}`) || '{}');
      _atletasMedico.forEach((med, athleteId) => {
        if (!_atletasFaseRTP.has(athleteId) && med.statusMed === "transicao") {
          const cached = localRTPCache[athleteId];
          if (cached && cached.fase > 0) _atletasFaseRTP.set(athleteId, cached);
        }
      });
    } catch(e) {}

    // ── Render 3 colunas (só se elemento ainda existe no HTML) ──
    if (listaRecovery) {
    const col = (titulo, cor, borda, items) => `
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2 mb-2 pb-2 border-b ${borda}">
          <span class="w-2 h-2 rounded-full ${cor}"></span>
          <span class="text-xs font-bold uppercase tracking-wide ${cor.replace('bg-','text-')}">${titulo}</span>
          <span class="ml-auto text-xs font-semibold text-gray-500">${items.length}</span>
        </div>
        ${items.length ? items.join('') : '<p class="text-xs text-gray-400 py-3 text-center">Nenhum atleta</p>'}
      </div>`;

    const geralNomes = (listaRecovery._geral || []);
    const geralHTML = geralNomes.length ? `
      <div class="mt-4 pt-4 border-t border-gray-100">
        <p class="text-xs font-bold uppercase tracking-wide text-gray-400 mb-2">Recovery Geral — Estáveis (opcional)</p>
        <p class="text-xs text-gray-400 mb-3">Foam roller global · Alongamento passivo · Banho frio · Mobilidade articular · 15–20 min</p>
        <div class="flex flex-wrap gap-1">
          ${geralNomes.map(n => `<span class="text-xs bg-gray-50 border border-gray-200 text-gray-600 px-2 py-0.5 rounded">${n}</span>`).join("")}
        </div>
      </div>` : "";

    listaRecovery.innerHTML = `
      <div class="flex gap-4 items-start">
        ${col('Crítico',  'bg-red-500',    'border-red-200',    listaRecovery._critico  || [])}
        <div class="w-px self-stretch bg-gray-200"></div>
        ${col('Moderado', 'bg-orange-400', 'border-orange-200', listaRecovery._moderado || [])}
        <div class="w-px self-stretch bg-gray-200"></div>
        ${col('Leve',     'bg-yellow-400', 'border-yellow-200', listaRecovery._leve     || [])}
      </div>
      ${geralHTML}`;
    } // fim if (listaRecovery)

    // renderizarMicroRecovery() — painéis antigos removidos, recovery agora nos cards

  } catch (error) {
    console.error(error);
  }

  if (msgCriticos) msgCriticos.style.display = temCritico ? "none" : "block";
  if (msgAtencao)  msgAtencao.style.display  = temAtencao ? "none" : "block";
  if (msgRecovery) msgRecovery.style.display = temRecovery ? "none" : "block";

  // Atualiza contadores dos novos cards
  const cntCriticos = document.getElementById("countCriticos");
  const cntAtencao  = document.getElementById("countAtencao");
  if (cntCriticos) cntCriticos.textContent = _prontidao.criticos.length;
  if (cntAtencao)  cntAtencao.textContent  = _prontidao.atencao.length;

  // Sincroniza dados do microciclo do Firestore antes de renderizar
  // para garantir que o jogo cadastrado apareça no recovery dos cards
  await sincronizarMicrocicloFirestore();

  // Renderiza imediatamente — sem bloquear no motor
  renderStatusCountCards();
  renderGridAtletas();
  renderBannerMicrociclo('bannerMicrociclo');

  // Motor compute-if-missing — roda em background, re-renderiza só se houver novos cálculos
  (async () => {
    try {
      const rtpProgressMap = {};
      _atletasFaseRTP.forEach((faseObj, athleteId) => {
        rtpProgressMap[athleteId] = faseObj?.fase ?? null;
      });
      const atletasMotor  = Object.entries(_atletasMap).map(([id, a]) => ({ id, nome: a.nome }));
      const historicoFlat = Object.values(_historicoAtleta).flat();
      const dailyHoje     = historicoFlat.filter(r => r.date === hoje);

      // Constrói contextoJogoMap para modulação pós-jogo (MD+1 / MD+2)
      const _mcHoje = calcularDiaMicrociclo();
      const _mcLabel = _mcHoje?.label ?? '';
      const _mdPos = _mcLabel === 'MD+1' ? 1 : _mcLabel === 'MD+2' ? 2 : null;
      const contextoJogoMap = {};
      if (_mdPos) {
        atletasMotor.forEach(({ id }) => {
          const seg = _minutosByAtleta[id] ?? null;
          contextoJogoMap[id] = { mdPos: _mdPos, minutosJogados: seg != null ? seg / 60 : null };
        });
      }

      const resultados    = await computeIfMissing({
        db, atletas: atletasMotor, daily: dailyHoje, historico: historicoFlat,
        hoje, clubId: CLUB_ID, rtpProgressMap, contextoJogoMap,
      });
      let algumDado = false;
      resultados.forEach(({ atletaId, data }) => {
        if (data) { _motorRecomendacoes.set(atletaId, data); algumDado = true; }
      });
      if (algumDado) renderGridAtletas();
    } catch (e) {
      console.warn('[Motor] compute-if-missing falhou:', e);
    }
  })();
}

/* =====================================================
   CONTADORES DE STATUS
===================================================== */
function renderStatusCountCards() {
  const countEl = document.getElementById('statusCountCards');
  if (!countEl) return;

  const counts = { afastado: 0, transicao: 0, admin: 0, liberado: 0, critico: 0, atencao: 0, atencao_leve: 0, estavel: 0, sem_dados: 0 };
  _atletasMedico.forEach((med, id) => {
    if (!_atletaPassaFiltrosDash(id, med)) return;
    if (med.statusMed === 'afastado')       { counts.afastado++;  return; }
    if (med.statusMed === 'transicao')      { counts.transicao++; return; }
    if (med.statusMed === 'afastado_admin') { counts.admin++;     return; }
    counts.liberado++;
    const pront = _atletasProntidao.get(id) || {};
    if      (pront.status === 'Crítico')      counts.critico++;
    else if (pront.status === 'Atenção')      counts.atencao++;
    else if (pront.status === 'Atenção Leve') counts.atencao_leve++;
    else if (pront.status === 'Estável')      counts.estavel++;
    else                                      counts.sem_dados++;
  });

  const medDefs   = [
    { key: 'afastado',  label: 'Afastado',  bg: '#fee2e2', text: '#b91c1c', brd: '#fca5a5' },
    { key: 'transicao', label: 'Transição', bg: '#ffedd5', text: '#c2410c', brd: '#fdba74' },
    { key: 'liberado',  label: 'Liberado',  bg: '#f0fdf4', text: '#15803d', brd: '#86efac' },
  ];
  const adminDefs = [
    { key: 'admin', label: 'Admin.', bg: '#ede9fe', text: '#7c3aed', brd: '#c4b5fd' },
  ];
  const prontDefs = [
    { key: 'critico',      label: 'Crítico',    bg: '#fef2f2', text: '#991b1b', brd: '#fca5a5' },
    { key: 'atencao',      label: 'Atenção',    bg: '#fff7ed', text: '#c2410c', brd: '#fdba74' },
    { key: 'atencao_leve', label: 'Aten. Leve', bg: '#fefce8', text: '#92400e', brd: '#fde68a' },
    { key: 'estavel',      label: 'Estável',    bg: '#f0fdf4', text: '#15803d', brd: '#86efac' },
    { key: 'sem_dados',    label: 'Sem Dados',  bg: '#f3f4f6', text: '#6b7280', brd: '#d1d5db' },
  ];

  function cardHtml({ key, label, bg, text, brd }) {
    const n = counts[key];
    const opacity = n === 0 ? '0.45' : '1';
    return `<div style="background:${bg};border:1.5px solid ${brd};border-radius:10px;padding:10px 6px 8px;text-align:center;opacity:${opacity};transition:opacity .2s;min-width:52px;">` +
      `<p style="font-size:22px;font-weight:900;color:${text};line-height:1;margin:0;letter-spacing:-1px;">${n}</p>` +
      `<p style="font-size:8.5px;font-weight:600;color:${text};margin:4px 0 0;text-transform:uppercase;letter-spacing:.04em;white-space:nowrap;">${label}</p>` +
      `</div>`;
  }

  const labelStyle = 'font-size:9px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.07em;margin:0 0 5px;';
  const divider = `<div style="width:1px;background:#e5e7eb;align-self:stretch;margin-top:2px;"></div>`;
  countEl.innerHTML =
    `<div style="display:flex;flex-direction:column;gap:5px;">` +
      `<p style="${labelStyle}">Depto. Médico</p>` +
      `<div style="display:flex;gap:7px;">${medDefs.map(cardHtml).join('')}</div>` +
    `</div>` +
    (counts.admin > 0 ? divider + `<div style="display:flex;flex-direction:column;gap:5px;">` +
      `<p style="font-size:9px;font-weight:700;color:#7c3aed;text-transform:uppercase;letter-spacing:.07em;margin:0 0 5px;">Administrativo</p>` +
      `<div style="display:flex;gap:7px;">${adminDefs.map(cardHtml).join('')}</div>` +
    `</div>` : '') +
    divider +
    `<div style="display:flex;flex-direction:column;gap:5px;">` +
      `<p style="${labelStyle}">Status de Prontidão</p>` +
      `<div style="display:flex;gap:7px;">${prontDefs.map(cardHtml).join('')}</div>` +
    `</div>`;
}

/* =====================================================
   GRID DE CARDS POR ATLETA — Situação do Elenco
===================================================== */
// ── RTP: Return to Play — fases de progressão ───────────────────────────────
function _buildFaseObjDash(fase) {
  const fases = {
    4: { fase: 4, label: "Apto",              descricao: "Global ≥ 70, todos ≥ 60 e dor < 4",  cor: "#15803d", bg: "#dcfce7" },
    3: { fase: 3, label: "Treino Coletivo",   descricao: "INM ≥ 60, Auton. ≥ 50 e dor < 4",   cor: "#0369a1", bg: "#e0f2fe" },
    2: { fase: 2, label: "Treino Adaptado",   descricao: "Neuromuscular ≥ 60 e Auton. ≥ 50",   cor: "#7c3aed", bg: "#ede9fe" },
    1: { fase: 1, label: "Recondicionamento", descricao: "Subjetivo ≥ 60 e Neuromuscular ≥ 50", cor: "#b45309", bg: "#fef9c3" },
    0: { fase: 0, label: "Afastado",          descricao: "Aguardando transição médica",          cor: "#b91c1c", bg: "#fee2e2" },
  };
  return fases[fase] ?? fases[1];
}

function _calcularFaseIndicadoresDash(prontidao) {
  const { global, inFadiga, inMuscular, inAutonomico, dor } = prontidao || {};
  const semDor = dor == null || dor < 4;
  if (global >= 70
    && (inFadiga     == null || inFadiga     >= 60)
    && inMuscular    != null && inMuscular   >= 60
    && (inAutonomico == null || inAutonomico >= 60)
    && semDor) return 4;
  if ((inFadiga     == null || inFadiga     >= 60)
    && inMuscular    != null && inMuscular   >= 60
    && (inAutonomico == null || inAutonomico >= 50)
    && semDor) return 3;
  // F2 automático: basta ter realizado o salto (CMJ coletado)
  if (inMuscular != null) return 2;
  return 1;  // Sem CMJ → Recondicionamento
}

function calcularFaseRTP(statusMedico, prontidao, faseSalva = 0) {
  if (!statusMedico || statusMedico === "liberado") return null;
  if (statusMedico === "afastado") return _buildFaseObjDash(0);
  const faseCalculada = _calcularFaseIndicadoresDash(prontidao);
  const faseEfetiva   = Math.max(faseCalculada, faseSalva ?? 0);
  return _buildFaseObjDash(faseEfetiva);
}

function renderGridAtletas() {
  const grid = document.getElementById("gridSituacao");
  if (!grid) return;
  grid.innerHTML = "";
  grid.style.cssText = "display:flex;flex-direction:column;gap:16px;";

  // Ordem de prioridade para exibição
  const ordemStatus = { "afastado": 0, "transicao": 1, "afastado_admin": 1, "Crítico": 2, "Atenção": 3, "Atenção Leve": 4, "Estável": 5, "Sem dados": 6 };
  const ordemPos    = ["goleiro","lateral","zagueiro","volante","meia","ponta","centro-avante","centroavante","atacante"];

  // Monta lista unificada de todos os atletas (aplicando filtros ativos)
  const lista = Array.from(_atletasMedico.entries()).filter(([id, med]) => _atletaPassaFiltrosDash(id, med)).map(([id, med]) => {
    const pront = _atletasProntidao.get(id) || { status: "Sem dados", causas: "", sistema: null };
    // Prioridade de ordenação: status mais grave primeiro (médico ou prontidão)
    const prioMed   = ordemStatus[med.statusMed]   ?? 4;
    const prioPront = ordemStatus[pront.status]     ?? 4;
    const prio      = Math.min(prioMed, prioPront);
    const posIdx    = ordemPos.indexOf((med.posicao || "").toLowerCase().trim());
    const group = med.statusMed === 'afastado' ? 'afastado'
      : med.statusMed === 'transicao' ? 'transicao'
      : med.statusMed === 'afastado_admin' ? 'afastado_admin'
      : pront.status === 'Crítico' ? 'critico'
      : pront.status === 'Atenção' ? 'atencao'
      : pront.status === 'Atenção Leve' ? 'atencao_leve'
      : pront.status === 'Estável' ? 'estavel'
      : 'sem_dados';
    return { id, med, pront, prio, posIdx: posIdx === -1 ? 99 : posIdx, group };
  });

  lista.sort((a, b) => {
    // 1. Afastado/transição sempre no topo
    const medPrioA = a.med.statusMed === "afastado" ? 0 : a.med.statusMed === "transicao" ? 1 : 2;
    const medPrioB = b.med.statusMed === "afastado" ? 0 : b.med.statusMed === "transicao" ? 1 : 2;
    if (medPrioA !== medPrioB) return medPrioA - medPrioB;
    // 1b. Dentro da transição: ordem crescente de fase (F1 → F4)
    if (medPrioA === 1 && medPrioB === 1) {
      const fA = _atletasFaseRTP.get(a.id)?.fase ?? 0;
      const fB = _atletasFaseRTP.get(b.id)?.fase ?? 0;
      if (fA !== fB) return fA - fB;
    }
    // 2. Liberados: "Sem dados" sempre ao final
    const semA = a.pront.status === "Sem dados" ? 1 : 0;
    const semB = b.pront.status === "Sem dados" ? 1 : 0;
    if (semA !== semB) return semA - semB;
    // 3. Ordenação por IGP crescente (pior primeiro)
    const ga = a.pront.global ?? 999;
    const gb = b.pront.global ?? 999;
    if (Math.abs(ga - gb) > 0.05) return ga - gb;
    return a.med.nome.localeCompare(b.med.nome, "pt-BR");
  });

  // Config visual por status médico
  const medConfig = {
    afastado:       { border: "border-red-200",    dot: "bg-red-500",    label: "Afastado",       labelCor: "text-red-600",    bg: "bg-red-50",    pillBg: "rgba(254,226,226,0.92)", pillText: "#b91c1c", pillDot: "#ef4444" },
    transicao:      { border: "border-orange-200", dot: "bg-orange-400", label: "Transição",      labelCor: "text-orange-600", bg: "bg-orange-50", pillBg: "rgba(255,237,213,0.92)", pillText: "#c2410c", pillDot: "#f97316" },
    afastado_admin: { border: "border-purple-200", dot: "bg-purple-500", label: "Administrativo", labelCor: "text-purple-600", bg: "bg-purple-50", pillBg: "rgba(237,233,254,0.92)", pillText: "#7c3aed", pillDot: "#8b5cf6" },
    liberado:       { border: "border-green-200",  dot: "bg-green-500",  label: "Liberado",       labelCor: "text-green-600",  bg: "bg-green-50",  pillBg: "rgba(220,252,231,0.92)", pillText: "#15803d", pillDot: "#22c55e" },
  };

  // Config visual por status prontidão
  const prontConfig = {
    "Crítico":      { border: "border-red-200",    dot: "bg-red-600",    labelCor: "text-red-700",    causaCor: "text-red-600",    bg: "bg-red-50" },
    "Atenção":      { border: "border-orange-200", dot: "bg-orange-500", labelCor: "text-orange-700", causaCor: "text-orange-700", bg: "bg-orange-50" },
    "Atenção Leve": { border: "border-yellow-200", dot: "bg-yellow-400", labelCor: "text-yellow-700", causaCor: "text-yellow-700", bg: "bg-yellow-50" },
    "Estável":      { border: "border-green-200",  dot: "bg-green-500",  labelCor: "text-green-700",  causaCor: "text-gray-400",   bg: "bg-green-50" },
    "Sem dados":    { border: "border-gray-200",   dot: "bg-gray-300",   labelCor: "text-gray-400",   causaCor: "text-gray-300",   bg: "bg-gray-50" },
  };

  // Pílula inline (face do card) por status prontidão — para atletas liberados
  const prontPill = {
    "Crítico":      { bg: "rgba(254,226,226,0.92)", text: "#b91c1c", dot: "#ef4444" },
    "Atenção":      { bg: "rgba(255,237,213,0.92)", text: "#c2410c", dot: "#f97316" },
    "Atenção Leve": { bg: "rgba(254,249,195,0.92)", text: "#92400e", dot: "#eab308" },
    "Estável":      { bg: "rgba(220,252,231,0.92)", text: "#15803d", dot: "#22c55e" },
    "Sem dados":    { bg: "rgba(243,244,246,0.85)", text: "#9ca3af", dot: "#d1d5db" },
  };

  function diasTag(n) {
    if (n === null || n === undefined) return "";
    const cor = n >= 14 ? "text-red-600 font-bold" : n >= 7 ? "text-orange-500 font-semibold" : "text-green-600 font-semibold";
    return `<span class="${cor} text-[10px]">${n}d</span>`;
  }

  // Matriz de ajuste (top 3) para uso nos cards do grid
  const _matrizGrid = {
    "Neuromuscular": ["Reduzir magnitude mecânica", "Aumentar pausas", "Reduzir volume"],
    "Autonômico":    ["Reduzir intensidade", "Aumentar pausas", "Reduzir volume"],
    "Cognitivo":     ["Reduzir complexidade", "Aumentar pausas", "Reduzir intensidade decisional"],
    "Subjetivo":     ["Reduzir volume", "Reduzir densidade", "Moderar intensidade"],
  };

  // ── Tabela de recovery por dia do microciclo × sistema ──────────────────────
  // Pré: aquecimento dirigido antes do treino | Pós: recuperação direcionada
  const _recoveryMapa = {
    'D1':   { pre: ['A: Bike leve 5 min · 55–60% FCmáx', 'B: Foam roller global 3 min'],                                   pos: ['A: Foam roller global 4 min + Alongamento passivo 5 min', 'B: Mobilidade articular 5 min'] },
    'D2':   { pre: ['A: Bike leve 5 min · 60–65% FCmáx', 'B: Mini-band MMII 2×10 · carga mínima'],                        pos: ['A: Foam roller posterior 4 min + Gelo localizado 10 min', 'B: Bota Pneumática 20 min · 80 mmHg'] },
    'D3':   { pre: ['A: Bike leve 5 min · 60–65% FCmáx', 'B: Isométricos MI 2×10s · sem dor'],                            pos: ['A: Gelo localizado 15 min + Foam roller posterior 3 min', 'B: Bota Pneumática 25 min + Foam roller 3 min'] },
    'D4':   { pre: ['A: Bike leve 5 min · 55% FCmáx', 'B: Foam roller global 3 min + Respiração 4-7-8 3 ciclos'],          pos: ['A: Foam roller global 5 min + Alongamento passivo 5 min', 'B: Banho frio 5 min + Alongamento passivo'] },
    'D5':   { pre: ['A: Bike leve 5 min · 65% FCmáx', 'B: Mini-band MMII 2×10 + Escadinha 3×5m'],                         pos: ['A: Foam roller posterior 4 min + Gelo localizado 10 min', 'B: Bota Pneumática 20 min'] },
    'D6':   { pre: ['A: Bike leve 3 min · 55% FCmáx', 'B: Alongamento passivo global 5 min'],                              pos: ['A: Alongamento passivo global 8 min', 'B: Foam roller global 5 min + Respiração 4-7-8'] },
    'D7':   { pre: ['Folga — sem protocolo'],                                                                                pos: ['Folga — sem protocolo'] },
    'MD+1': { pre: ['A: Bike leve 5 min · 50–55% FCmáx · recovery ativo obrigatório', 'B: Hidroterapia 10 min fria'],      pos: ['A: Bota Pneumática 30 min + Gelo localizado 15 min', 'B: Pulsetto 15 min (Stress) + Foam roller global 5 min'] },
    'MD+2': { pre: ['A: Bike leve 5 min · 55% FCmáx', 'B: Foam roller global 3 min + Respiração 4-7-8'],                   pos: ['A: Foam roller global 5 min + Hidroterapia 10 min', 'B: Alongamento passivo 8 min + Respiração diafragmática'] },
    'MD+3': { pre: ['A: Bike leve 5 min · 60% FCmáx', 'B: Mini-band MMII 2×10'],                                           pos: ['A: Foam roller global 5 min + Alongamento passivo 5 min', 'B: Bota Pneumática 20 min'] },
    'MD-3': { pre: ['A: Bike leve 5 min · 65% FCmáx', 'B: Isométricos MI 2×10s'],                                          pos: ['A: Gelo localizado 15 min + Foam roller posterior 4 min', 'B: Bota Pneumática 20 min + Proteína + CHO 30 min'] },
    'MD-2': { pre: ['A: Bike leve 5 min · 65% FCmáx', 'B: Mini-band MMII 2×10 + Escadinha 3×5m'],                         pos: ['A: Foam roller global 5 min + Banho contrastante 6 min', 'B: Alongamento passivo 8 min'] },
    'MD-1': { pre: ['A: Bike leve 3 min · 60% FCmáx (ativação — não recovery)', 'B: Isométricos MI 2×8s + Visualização'],  pos: ['A: Alongamento passivo global 8 min', 'B: Foam roller global 5 min · sem carga mecânica'] },
    'MD0':  { pre: ['A: Bike leve 3 min · 55% FCmáx + Visualização 2 min', 'B: Escadinha 3×5m + Visualização 2 min'],      pos: ['A: Gelo localizado 15 min + Bota Pneumática 20 min', 'B: Reidratação imediata + Pulsetto 15 min · iniciar MD+1'] },
  };

  // Pré por sistema comprometido — sobrepõe o do dia
  const _recoveryPorSistema = {
    'Autonômico':    { pre: ['A: Bike leve 3 min · 55% FCmáx + Respiração 4-7-8 3 ciclos', 'B: Pulsetto 10 min (Stress) + Visualização 2 min'] },
    'Neuromuscular': { pre: ['A: Bike leve 5 min · 55–60% FCmáx', 'B: Foam roller posterior 3 min + Isométricos MI 2×8s'] },
    'Cognitivo':     { pre: ['A: Bike leve 3 min · 55% FCmáx + App Stroop nível básico 1\'30\"', 'B: Bola de reação 2 min + Respiração 4-7-8 3 ciclos'] },
    'Subjetivo':     { pre: ['A: Bike leve 3 min · 55% FCmáx + Alongamento passivo 3 min', 'B: Foam roller global 3 min + Visualização 2 min'] },
  };

  // Regiões MMII — bota indicada
  const _REGIOES_MMII = new Set([
    'Gluteo Dir.','Gluteo Esq.','Virilha Dir.','Virilha Esq.',
    'Adutor Dir.','Adutor Esq.','Abdutor Dir.','Abdutor Esq.',
    'Quadriceps Dir.','Quadriceps Esq.','Isquiotibial Dir.','Isquiotibial Esq.',
    'Joelho Dir.','Joelho Esq.','Canela Dir.','Canela Esq.',
    'Panturrilha Dir.','Panturrilha Esq.','Tornozelo Dir.','Tornozelo Esq.',
  ]);

  function _posCards(pront, mcLabel) {
    const { classFadiga, classDor, classHRV, classCMJ, classNeuro, classEstresse } = pront;
    const regioes = pront.regioesDor || [];
    const mmii = regioes.length === 0 || regioes.some(r => _REGIOES_MMII.has(r));

    // MD+1: recovery obrigatório — protocolo fixo independente do sistema
    if (mcLabel === 'MD+1') return ['A: Bota Pneumática 30 min + Gelo localizado 15 min', 'B: Pulsetto 15 min (Stress) + Foam roller global 5 min'];
    // MD+2: metabólico leve
    if (mcLabel === 'MD+2') return ['A: Foam roller global 5 min + Hidroterapia 10 min fria', 'B: Alongamento passivo global 8 min'];
    // MD-1: não é recovery — ativação apenas, protocolo passivo suave
    if (mcLabel === 'MD-1') return ['A: Alongamento passivo global 8 min · sem carga', 'B: Foam roller global 5 min · sem compressão ativa'];
    if (mcLabel === 'D7')   return ['Folga — sem protocolo'];

    const res = [];

    // Neuromuscular (CMJ / Dor) — prioridade 1
    const cr = c => c === 'critico';
    const al = c => c === 'critico' || c === 'atencao' || c === 'atencao_leve';
    if (cr(classCMJ) || cr(classDor))
      res.push(
        mmii ? 'A: Bota Pneumática 25–30 min · 80 mmHg + Gelo localizado 15 min' : 'A: Gelo localizado 15 min + Foam roller posterior 4 min',
        mmii ? 'B: Foam roller posterior 5 min + Gelo localizado 10 min'           : 'B: Foam roller posterior 5 min + Alongamento passivo 5 min'
      );
    else if (al(classCMJ) || al(classDor))
      res.push(
        'A: Foam roller posterior 4 min + Gelo localizado 10 min',
        mmii ? 'B: Bota Pneumática 20 min · 80 mmHg' : 'B: Alongamento passivo MI 5 min'
      );

    // Fadiga — prioridade 2 (só se neuromuscular ok)
    if (res.length === 0) {
      if (cr(classFadiga))
        res.push('A: Bota Pneumática 20 min + Foam roller global 5 min', 'B: Banho frio 5 min + Alongamento passivo 5 min');
      else if (al(classFadiga))
        res.push('A: Foam roller global 5 min + Alongamento passivo 5 min', 'B: Banho contrastante 6 min');
    }

    // Autonômico (HRV / Estresse / Neuro) — prioridade 3
    const autCrit = [classHRV, classNeuro].filter(c => c === 'critico').length + (classEstresse === 'critico' ? 1 : 0);
    const autAten = [classHRV, classNeuro].filter(c => c === 'atencao' || c === 'atencao_leve').length + (classEstresse === 'atencao' || classEstresse === 'atencao_leve' ? 1 : 0);
    if (autCrit >= 1) {
      const item = (mcLabel === 'MD-1' || mcLabel === 'MD0')
        ? ['A: Visualização 3 min + Respiração 4-7-8 5 ciclos', 'B: Alongamento passivo global 8 min']
        : ['A: Pulsetto 15 min (Stress)', 'B: Respiração 4-7-8 5 ciclos + Visualização 3 min'];
      res.push(...item);
    } else if (autAten >= 2) {
      res.push(
        (mcLabel === 'MD-1' || mcLabel === 'MD0') ? 'A: Respiração 4-7-8 5 ciclos + Visualização 3 min' : 'A: Pulsetto 10 min (Stress)',
        'B: Respiração diafragmática 5 min'
      );
    } else if (autAten === 1 && res.length === 0) {
      res.push('A: Respiração 4-7-8 5 ciclos', 'B: Foam roller global 5 min');
    }

    // Fallback pelo dia
    if (res.length === 0) {
      const base = _recoveryMapa[mcLabel];
      return base ? base.pos : ['A: Foam roller global 5 min', 'B: Alongamento passivo global 5 min'];
    }

    return res.slice(0, 2);
  }

  // ── Briefing Pré-Treino ───────────────────────────────────────────────────
  window._abrirBriefing = function() {
    const mc = calcularDiaMicrociclo();

    // Respeita os filtros ativos do dashboard (categoria, grupo)
    const atletasMedicoFiltrado = new Map(
      Array.from(_atletasMedico.entries()).filter(([id, med]) => _atletaPassaFiltrosDash(id, med))
    );

    const b  = gerarBriefing({
      diaMicrocicloObj:    mc,
      atletasProntidaoMap: _atletasProntidao,
      atletasMedicoMap:    atletasMedicoFiltrado,
      minutosByAtleta:     _minutosByAtleta,
    });

    const sessao     = gerarSessao(mc?.label, b.capacidade_coletiva);
    const motorFlags = calcMotorFlags(sessao, _motorRecomendacoes, atletasMedicoFiltrado);

    const modal   = document.getElementById('modalBriefing');
    const content = document.getElementById('modalBriefingContent');
    if (!modal || !content) return;
    content.innerHTML = _renderBriefingModal(b, sessao, motorFlags);
    modal.style.display = 'flex';
  };

  function _renderBriefingModal(b, sessao = null, motorFlags = []) {
    const pill = (txt, bg, color = '#fff') =>
      `<span style="display:inline-block;font-size:11px;font-weight:700;background:${bg};color:${color};padding:3px 10px;border-radius:12px;white-space:nowrap;">${txt}</span>`;

    if (b.tipo === 'sem_sessao') {
      return `
        <p style="font-size:16px;font-weight:800;color:#111827;margin:0 0 16px;">Briefing Pré-Treino</p>
        <div style="background:#f3f4f6;border-radius:10px;padding:24px;text-align:center;">
          <p style="font-size:14px;font-weight:700;color:#374151;margin:0 0 4px;">${b.label}</p>
          <p style="font-size:13px;color:#6b7280;margin:0;">${b.motivo}</p>
        </div>`;
    }

    if (b.tipo === 'sem_dados') {
      return `
        <p style="font-size:16px;font-weight:800;color:#111827;margin:0 0 16px;">Briefing Pré-Treino</p>
        <div style="background:#f3f4f6;border-radius:10px;padding:24px;text-align:center;">
          <p style="font-size:13px;color:#6b7280;margin:0;">Dia "${b.label}" sem envelope definido para prescrição.</p>
        </div>`;
    }

    const CAP_COR = { Alta: ['#16a34a', '#f0fdf4'], Moderada: ['#d97706', '#fffbeb'], Reduzida: ['#dc2626', '#fef2f2'] };
    const [capCorText, capCorBg] = CAP_COR[b.capacidade_coletiva] || ['#6b7280', '#f3f4f6'];
    const p = b.prescricao;

    const row = (label, val) =>
      `<div style="background:#f8fafc;border-radius:8px;padding:10px 12px;">
        <p style="font-size:10px;color:#6b7280;margin:0 0 4px;text-transform:uppercase;letter-spacing:.04em;">${label}</p>
        <p style="font-size:15px;font-weight:800;color:#111827;margin:0;">${val}</p>
      </div>`;

    // Dots: bolinhas coloridas (preenchidas e vazias)
    const dotsHtml = (n) => {
      let html = '';
      for (let i = 1; i <= 5; i++) {
        const filled = i <= n;
        html += `<span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${filled ? '#1e3a5f' : '#e5e7eb'};margin-right:4px;"></span>`;
      }
      return html;
    };
    const rowDots = (label, n) =>
      `<div style="background:#f8fafc;border-radius:8px;padding:10px 12px;">
        <p style="font-size:10px;color:#6b7280;margin:0 0 6px;text-transform:uppercase;letter-spacing:.04em;">${label}</p>
        <div style="display:flex;align-items:center;gap:0;">${dotsHtml(n)}</div>
      </div>`;

    const posHtml = b.posicoes_risco.length
      ? `<div style="margin-top:14px;">
          <p style="font-size:11px;font-weight:700;color:#374151;text-transform:uppercase;letter-spacing:.06em;margin:0 0 6px;">Posições em atenção</p>
          <div style="display:flex;flex-wrap:wrap;gap:6px;">
            ${b.posicoes_risco.map(p => pill(p, '#eff6ff', '#1d4ed8')).join('')}
          </div>
         </div>`
      : '';

    const excHtml = b.excecoes.length
      ? `<div style="margin-top:14px;">
          <p style="font-size:11px;font-weight:700;color:#374151;text-transform:uppercase;letter-spacing:.06em;margin:0 0 6px;">Ajuste individual (${b.excecoes.length})</p>
          <div style="display:flex;flex-direction:column;gap:6px;">
            ${b.excecoes.map(e => {
              const ec = e.status === 'Crítico' ? '#dc2626' : '#d97706';
              const eb = e.status === 'Crítico' ? '#fef2f2' : '#fffbeb';
              return `<div style="display:flex;align-items:center;gap:8px;padding:7px 10px;background:#fafafa;border:1px solid #e5e7eb;border-radius:8px;">
                <span style="font-size:12px;font-weight:700;color:#111827;flex:1;">${e.nome}</span>
                <span style="font-size:10px;font-weight:700;background:${eb};color:${ec};padding:2px 8px;border-radius:8px;">${e.status}</span>
                <span style="font-size:11px;color:#6b7280;">${e.motivo}</span>
              </div>`;
            }).join('')}
          </div>
         </div>`
      : '';

    const naoJogHtml = b.nota_nao_jogadores
      ? `<div style="margin-top:14px;background:#fffbeb;border:1px solid #fcd34d;border-radius:10px;padding:12px 14px;">
          <p style="font-size:11px;font-weight:700;color:#92400e;text-transform:uppercase;letter-spacing:.06em;margin:0 0 6px;">Atenção — ${b.nota_nao_jogadores.n} atleta(s) com menos de 60 min no jogo</p>
          <p style="font-size:12px;color:#78350f;margin:0;line-height:1.55;">${b.nota_nao_jogadores.texto}</p>
         </div>`
      : '';

    const justHtml = b.justificativa
      ? `<div style="margin-top:14px;background:#f0f4ff;border-left:3px solid #6366f1;border-radius:0 8px 8px 0;padding:10px 14px;">
          <p style="font-size:10px;font-weight:700;color:#4338ca;text-transform:uppercase;letter-spacing:.06em;margin:0 0 4px;">Justificativa</p>
          <p style="font-size:12px;color:#374151;margin:0;line-height:1.55;">${b.justificativa}</p>
         </div>`
      : '';

    const semDados = (b.n_com_dados > 0 && b.n_com_dados < b.n_atletas)
      ? `<p style="font-size:11px;color:#9ca3af;margin:8px 0 0;">${b.n_com_dados} de ${b.n_atletas} atletas com dados hoje.</p>`
      : '';

    const { categoria: _filtCat } = _getFiltrosDash();
    const filtroTag = _filtCat
      ? `<span style="font-size:10px;font-weight:600;background:#eff6ff;color:#1d4ed8;padding:2px 8px;border-radius:8px;margin-left:4px;">Categoria: ${_filtCat}</span>`
      : '';

    return `
      <!-- Cabeçalho -->
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;flex-wrap:wrap;">
        <p style="font-size:16px;font-weight:800;color:#111827;margin:0;flex:1;">Briefing Pré-Treino${filtroTag}</p>
        <span style="display:inline-block;font-size:12px;font-weight:800;background:${b.cor};color:#fff;padding:4px 12px;border-radius:12px;">${b.label}</span>
      </div>
      <p style="font-size:13px;color:#374151;margin:-10px 0 14px;font-weight:600;">${b.envelope_nome} · ${b.objetivo}</p>

      <!-- Capacidade coletiva / header grupos -->
      ${b.prescricao_estimulo ? `
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:12px;background:#fef9ec;border:1px solid #fcd34d;border-radius:10px;padding:9px 14px;">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="#b45309" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
        <p style="font-size:12px;color:#92400e;margin:0;flex:1;">Elenco dividido: <strong>${b.grupo_recuperacao?.n ?? '?'} em recuperação</strong> (jogaram >60 min) · <strong>${b.grupo_estimulo?.n ?? '?'} em estímulo</strong> (jogaram <60 min)</p>
      </div>` : `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;background:${capCorBg};border-radius:10px;padding:10px 14px;">
        <p style="font-size:12px;color:#374151;margin:0;flex:1;">Capacidade coletiva do elenco</p>
        <span style="font-size:13px;font-weight:800;color:${capCorText};">${b.capacidade_coletiva}</span>
        <span style="font-size:11px;color:#6b7280;">(${b.modificador_pct}% do envelope)</span>
      </div>`}

      <!-- Grid de prescrição — Grupo Recuperação -->
      <p style="font-size:11px;font-weight:700;color:#374151;text-transform:uppercase;letter-spacing:.06em;margin:0 0 8px;">
        ${b.prescricao_estimulo ? `Grupo Recuperação (${b.grupo_recuperacao?.n ?? ''} atletas) · <span style="color:${capCorText};font-weight:800;">${b.capacidade_coletiva}</span>` : 'Prescrição da sessão'}
      </p>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:8px;">
        ${row('Duração total', p.fmt.duracao)}
        ${row('Carga interna', p.fmt.cargaUA)}
        ${p.fmt.pse_alvo ? row('PSE-Alvo', p.fmt.pse_alvo) : ''}
        ${row('Minutos em Alta Intensidade', p.fmt.alta)}
        ${row('Minutos em Intensidade Moderada / Baixa', p.fmt.modBaixo)}
        ${rowDots('Exposição à velocidade', p.dots.veloc)}
        ${rowDots('Mudanças de direção', p.dots.cod)}
      </div>
      ${p.blocos ? (() => {
        const bl = p.blocos;
        const altaHtml = bl.alta ? `
          <div style="background:#fff7ed;border-radius:8px;padding:10px 14px;margin-bottom:6px;">
            <p style="font-size:10px;font-weight:700;color:#9a3412;text-transform:uppercase;letter-spacing:.04em;margin:0 0 4px;">Blocos Alta Intensidade${bl.alta.opcional ? ' · opcional' : ''}</p>
            <p style="font-size:13px;font-weight:700;color:#111827;margin:0;">${bl.alta.formato}</p>
            <p style="font-size:12px;color:#374151;margin:4px 0 0;">${bl.alta.ratio}</p>
          </div>` : '';
        const modHtml = bl.modBaixo ? `
          <div style="background:#f0f6ff;border-radius:8px;padding:10px 14px;">
            <p style="font-size:10px;font-weight:700;color:#1e40af;text-transform:uppercase;letter-spacing:.04em;margin:0 0 4px;">Blocos Moderada / Baixa</p>
            <p style="font-size:13px;font-weight:700;color:#111827;margin:0;">${bl.modBaixo.formato}</p>
            <p style="font-size:12px;color:#374151;margin:4px 0 0;">${bl.modBaixo.ratio}</p>
          </div>` : '';
        return `
        <p style="font-size:11px;font-weight:700;color:#374151;text-transform:uppercase;letter-spacing:.06em;margin:14px 0 8px;">Estrutura de blocos e pausas</p>
        ${altaHtml}${modHtml}
        ${bl.nota ? `<p style="font-size:11px;color:#6b7280;margin:6px 0 0;">${bl.nota}</p>` : ''}
        ${p.blocosMod ? `<p style="font-size:11px;color:#d97706;margin:4px 0 0;font-weight:600;">⚠ ${p.blocosMod}</p>` : ''}`;
      })() : ''}

      <!-- Grid de prescrição — Grupo Estímulo (quando presente) -->
      ${b.prescricao_estimulo ? (() => {
        const pe = b.prescricao_estimulo;
        const ge = b.grupo_estimulo;
        const CAP_COR_E = { Alta: ['#16a34a', '#f0fdf4'], Moderada: ['#d97706', '#fffbeb'], Reduzida: ['#dc2626', '#fef2f2'] };
        const [cce] = CAP_COR_E[ge?.capacidade] || ['#6b7280', '#f3f4f6'];
        const blocosAltaHtml = pe.blocos_alta ? `
          <div style="background:#fff7ed;border-radius:8px;padding:10px 14px;margin-bottom:6px;">
            <p style="font-size:10px;font-weight:700;color:#9a3412;text-transform:uppercase;letter-spacing:.04em;margin:0 0 4px;">Blocos Alta Intensidade</p>
            <p style="font-size:13px;font-weight:700;color:#111827;margin:0;">${pe.blocos_alta.formato}</p>
            <p style="font-size:12px;color:#374151;margin:4px 0 0;">${pe.blocos_alta.ratio}</p>
          </div>` : '';
        const blocosModHtml = pe.blocos_modBaixo ? `
          <div style="background:#f0f6ff;border-radius:8px;padding:10px 14px;">
            <p style="font-size:10px;font-weight:700;color:#1e40af;text-transform:uppercase;letter-spacing:.04em;margin:0 0 4px;">Blocos Moderada / Baixa</p>
            <p style="font-size:13px;font-weight:700;color:#111827;margin:0;">${pe.blocos_modBaixo.formato}</p>
            <p style="font-size:12px;color:#374151;margin:4px 0 0;">${pe.blocos_modBaixo.ratio}</p>
          </div>` : '';
        return `
        <div style="margin-top:16px;border-top:2px dashed #e5e7eb;padding-top:14px;">
          <p style="font-size:11px;font-weight:700;color:#374151;text-transform:uppercase;letter-spacing:.06em;margin:0 0 8px;">
            Grupo Estímulo (${ge?.n ?? ''} atletas) · <span style="color:${cce};font-weight:800;">${ge?.capacidade ?? ''}</span>
          </p>
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:8px;">
            ${row('Duração total', pe.fmt.duracao)}
            ${row('Carga interna', pe.fmt.cargaUA)}
            ${pe.fmt.pse_alvo ? row('PSE-Alvo', pe.fmt.pse_alvo) : ''}
            ${row('Minutos em Alta Intensidade', pe.fmt.alta)}
            ${row('Minutos em Intensidade Moderada / Baixa', pe.fmt.modBaixo)}
            ${rowDots('Exposição à velocidade', pe.dots.veloc)}
            ${rowDots('Mudanças de direção', pe.dots.cod)}
          </div>
          ${blocosAltaHtml}
          ${blocosModHtml}
          ${pe.blocos_nota ? `<p style="font-size:11px;color:#6b7280;margin:6px 0 0;">${pe.blocos_nota}</p>` : ''}
          ${pe.blocosMod ? `<p style="font-size:11px;color:#d97706;margin:4px 0 0;font-weight:600;">⚠ ${pe.blocosMod}</p>` : ''}
        </div>`;
      })() : ''}

      ${posHtml}
      ${excHtml}
      ${justHtml}
      ${semDados}
      <!-- Aviso -->
      <p style="font-size:10px;color:#9ca3af;margin-top:16px;line-height:1.4;">⚠ Sugestões geradas automaticamente. Não substituem a avaliação da comissão técnica.</p>
      <!-- Botão exportar PDF -->
      <div style="margin-top:12px;display:flex;justify-content:flex-end;">
        <button id="btnExportBriefingPdf" onclick="window._exportBriefingPDF()"
                style="display:flex;align-items:center;gap:6px;background:#1e3a5f;color:#fff;border:none;border-radius:8px;padding:8px 18px;font-size:12px;font-weight:700;cursor:pointer;box-shadow:0 2px 8px rgba(30,58,95,.18);transition:background .15s;"
                onmouseover="this.style.background='#16304f'" onmouseout="this.style.background='#1e3a5f'">
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3"/></svg>
          Exportar PDF
        </button>
      </div>`;
  }

  window._exportBriefingPDF = async function() {
    const btn     = document.getElementById('btnExportBriefingPdf');
    const content = document.getElementById('modalBriefingContent');
    if (!content) return;

    if (btn) { btn.disabled = true; btn.textContent = 'Gerando…'; }

    try {
      const { jsPDF } = window.jspdf;
      const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });

      const canvas = await html2canvas(content, {
        scale: 2.5,
        useCORS: true,
        backgroundColor: '#ffffff',
        logging: false,
        // exclui o próprio botão de exportar do print
        ignoreElements: el => el.id === 'btnExportBriefingPdf',
      });

      const A4_W   = 210;
      const A4_H   = 297;
      const margin = 12;
      const printW = A4_W - margin * 2;
      const printH = A4_H - margin * 2;
      const A4_W_PX = canvas.width;
      const A4_H_PX = Math.round(canvas.width * (printH / printW));

      let offsetY = 0;
      let first   = true;
      while (offsetY < canvas.height) {
        if (!first) pdf.addPage([A4_W, A4_H]);
        first = false;
        const sliceH      = Math.min(A4_H_PX, canvas.height - offsetY);
        const sliceCanvas = document.createElement('canvas');
        sliceCanvas.width  = A4_W_PX;
        sliceCanvas.height = A4_H_PX;
        const ctx = sliceCanvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, A4_W_PX, A4_H_PX);
        ctx.drawImage(canvas, 0, offsetY, A4_W_PX, sliceH, 0, 0, A4_W_PX, sliceH);
        pdf.addImage(sliceCanvas.toDataURL('image/jpeg', 0.92), 'JPEG', margin, margin, printW, printH);
        offsetY += A4_H_PX;
      }

      const hoje = new Date().toISOString().slice(0, 10);
      pdf.save(`briefing-pre-treino-${hoje}.pdf`);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3"/></svg> Exportar PDF';
      }
    }
  };

  // Função global para toggle do painel de recovery — usa DOM traversal
  window._toggleRecovery = function(btn) {
    const el = btn.previousElementSibling;
    if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
  };

  // ── Toggle Considerar — usa DOM traversal ─────────────────────────────────
  window._toggleConsiderar = function(btn) {
    const el = btn.nextElementSibling;
    if (!el) return;
    const aberto = el.style.display !== 'none';
    el.style.display = aberto ? 'none' : 'block';
    const arrow = btn.querySelector('span:last-child');
    if (arrow) arrow.textContent = aberto ? '▼' : '▲';
  };

  // ── Modal de atleta com abas ─────────────────────────────────────────────
  window._fecharCardModal = function() {
    const m = document.getElementById('cardModal');
    if (m) m.style.display = 'none';
    _cmAtletaId = null;
    _cmAbaCarga = {};
  };

  window._modalAbaSelecionar = async function(aba) {
    const ABAS = ['prontidao', 'medico', 'carga', 'avaliacoes', 'perfil', 'desempenho'];
    ABAS.forEach(t => {
      const btn = document.getElementById(`cmTab_${t}`);
      if (!btn) return;
      const ativo = t === aba;
      btn.style.color        = ativo ? '#1e3a5f' : '#9ca3af';
      btn.style.borderBottom = ativo ? '2px solid #1e3a5f' : '2px solid transparent';
    });

    const content = document.getElementById('cardModalContent');
    if (!content) return;

    if (aba === 'prontidao') { content.innerHTML = _cmProntHTML; return; }

    const cKey = `${_cmAtletaId}_${aba}`;
    if (_cmAbaCarga[cKey]) { content.innerHTML = _cmAbaCarga[cKey]; return; }

    content.innerHTML = `<div style="padding:48px;text-align:center;color:#9ca3af;font-size:13px;">Carregando...</div>`;
    let html = '';
    try {
      if (aba === 'medico')     html = await _cmLoadMedico(_cmAtletaId);
      if (aba === 'carga')      html = await _cmLoadCarga(_cmAtletaId);
      if (aba === 'avaliacoes') html = await _cmLoadAvaliacoes(_cmAtletaId);
      if (aba === 'perfil')     html = await _cmLoadPerfil(_cmAtletaId);
      if (aba === 'desempenho') html = await _cmLoadDesempenho(_cmAtletaId);
    } catch(e) {
      html = `<div style="padding:32px;text-align:center;color:#ef4444;font-size:13px;">Erro ao carregar: ${e.message}</div>`;
    }
    _cmAbaCarga[cKey] = html;
    content.innerHTML = html;
  };

  window._toggleCardDetalhe = function(faceEl) {
    const detail = faceEl.nextElementSibling;
    if (!detail) return;
    const modal = document.getElementById('cardModal');
    if (!modal) return;

    const card     = faceEl.parentElement;
    _cmAtletaId    = card.dataset.atletaid  || null;
    _cmProntHTML   = `<div style="padding:16px 20px;">${detail.innerHTML}</div>`;
    _cmAbaCarga    = {};

    const nome     = card.dataset.nome    || '';
    const fotoUrl  = card.dataset.fotourl || '';
    const posicao  = card.dataset.posicao || '';
    const iniciais = nome.split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0].toUpperCase()).join('');
    const infoEl   = document.getElementById('cardModalAtletaInfo');
    if (infoEl) {
      infoEl.innerHTML = `
        ${fotoUrl
          ? `<img src="${fotoUrl}" style="width:48px;height:48px;border-radius:50%;object-fit:cover;object-position:center top;border:2px solid #e5e7eb;flex-shrink:0;">`
          : `<div style="width:48px;height:48px;border-radius:50%;background:#f3f4f6;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700;color:#9ca3af;flex-shrink:0;">${iniciais}</div>`
        }
        <div style="min-width:0;">
          <div style="font-size:17px;font-weight:800;color:#111827;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${nome}</div>
          <div style="font-size:12px;color:#6b7280;">${posicao}<span id="cardModalIdade"></span></div>
        </div>`;
    }

    if (_cmAtletaId) {
      const thisId = _cmAtletaId;
      getDoc(doc(db, 'athletes', thisId)).then(s => {
        if (_cmAtletaId !== thisId || !s.exists()) return;
        const nasc = s.data().data_nascimento;
        if (!nasc) return;
        const hoje = new Date(), n = new Date(nasc);
        let a = hoje.getFullYear() - n.getFullYear();
        if (hoje.getMonth() < n.getMonth() || (hoje.getMonth() === n.getMonth() && hoje.getDate() < n.getDate())) a--;
        const el = document.getElementById('cardModalIdade');
        if (el) el.textContent = ` · ${a} anos`;
      }).catch(() => {});
    }

    window._modalAbaSelecionar('prontidao');
    modal.style.display = 'flex';
  };

  let _cardIdx = 0;
  const mcAtual = calcularDiaMicrociclo();
  const mcLabel = mcAtual ? mcAtual.label : null;
  const recoveryBase = mcLabel ? (_recoveryMapa[mcLabel] || null) : null;
  const cardBuckets = { afastado: [], transicao: [], afastado_admin: [], critico: [], atencao: [], atencao_leve: [], estavel: [], sem_dados: [] };

  lista.forEach(({ id, med, pront, group }) => {
    const mc = medConfig[med.statusMed]   || medConfig.liberado;
    const pc = prontConfig[pront.status]  || prontConfig["Estável"];

    // ── RTP fase ──────────────────────────────────────────────────────────
    // Usa fase do cache (Firestore) se sem dados hoje; com dados, aplica piso histórico
    const faseRTP = _atletasFaseRTP.has(id) && (pront.global == null && pront.IH == null && pront.IA == null && pront.INM == null)
      ? _atletasFaseRTP.get(id)
      : calcularFaseRTP(med.statusMed, {
          global:        pront.global,
          inFadiga:      pront.IH,
          inMuscular:    pront.INM,
          inAutonomico:  pront.IA,
        }, _atletasFaseRTP.get(id)?.fase ?? 0);
    const rtpHTML = (faseRTP && med.statusMed !== 'afastado_admin')
      ? `<span style="display:inline-block;margin-top:3px;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:800;background:${faseRTP.bg};color:${faseRTP.cor};">F${faseRTP.fase} · ${faseRTP.label}</span>`
      : "";

    const diasEl  = diasTag(med.dias);
    const infoMed = med.statusMed === 'afastado'
      ? `<div style="margin-top:6px;background:#fff1f2;border:1px solid #fecaca;border-radius:5px;padding:6px 9px;">
           <p style="font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.05em;margin:0 0 3px;">Lesão</p>
           <p style="font-size:12px;font-weight:700;color:#b91c1c;margin:0 0 2px;">${med.infoMed || 'Não informada'}</p>
           ${med.dias != null ? `<p style="font-size:11px;color:#dc2626;font-weight:600;margin:0;">${med.dias} dia${med.dias !== 1 ? 's' : ''} afastado</p>` : ''}
         </div>`
      : med.infoMed ? `<span class="text-gray-400 text-[12px] block mt-0.5 leading-tight">${med.infoMed}</span>` : "";
    const causas  = pront.causas
      ? pront.causas.split(" · ").map(c => `<span class="${pc.causaCor} text-[13px] block leading-snug mt-0.5">${c}</span>`).join("")
      : `<span class="text-gray-300 text-[13px]">—</span>`;

    // ── ISP Tendência ─────────────────────────────────────────────────────
    const ispTendGlobal = pront.ispTend?.global || null;

    // ── Badge de estado de fadiga ─────────────────────────────────────────
    const _ffCfg = {
      aguda:       { bg: '#fef9c3', cor: '#854d0e', label: 'Fadiga Aguda'       },
      residual:    { bg: '#ffedd5', cor: '#9a3412', label: 'Fadiga Residual'    },
      persistente: { bg: '#fee2e2', cor: '#991b1b', label: 'Fadiga Persistente' },
    };
    const _ff     = pront.fadigaFlag ?? { nivel: 'nenhuma', eixoPrincipal: null };
    const _ffItem = _ffCfg[_ff.nivel];
    const fadigaBadgeHTML = _ffItem
      ? `<span title="${_ff.eixoPrincipal ? 'Eixo: ' + _ff.eixoPrincipal : ''}" style="font-size:10px;font-weight:700;padding:1px 6px;border-radius:4px;background:${_ffItem.bg};color:${_ffItem.cor};cursor:default;">${_ffItem.label}</span>`
      : '';

    // ── Círculo de prontidão global ───────────────────────────────────────
    const globalVal = pront.global != null ? Math.round(pront.global) : null;
    const circuloCores = {
      "Crítico":      { bg: "#fee2e2", text: "#b91c1c" },
      "Atenção":      { bg: "#ffedd5", text: "#c2410c" },
      "Atenção Leve": { bg: "#fef9c3", text: "#92400e" },
      "Estável":      { bg: "#dcfce7", text: "#15803d" },
      "Sem dados":    { bg: "#f3f4f6", text: "#9ca3af" },
    };
    const cc = circuloCores[pront.status] || circuloCores["Sem dados"];
    const circuloHTML = globalVal != null
      ? `<div style="width:44px;height:44px;border-radius:50%;background:${cc.bg};display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:700;color:${cc.text};flex-shrink:0;">${globalVal}</div>`
      : `<div style="width:44px;height:44px;border-radius:50%;background:#f3f4f6;display:flex;align-items:center;justify-content:center;font-size:10px;color:#9ca3af;flex-shrink:0;">—</div>`;

    // ── Bloco Motor de Recomendação (compute-if-missing) ─────────────────────
    const _sistSemNome = _sistemaSemanal.get(id)?.nome || pront.sistema || null;
    const motorRec = _motorRecomendacoes.get(id);
    const considerarCardHTML = (() => {
      if (med.statusMed === 'afastado') return '';
      if (!motorRec) return '';
      // Sem dados de prontidão → não gerar sugestão
      if (pront.status === 'Sem dados' || globalVal == null) {
        return `<div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:8px 12px;margin-top:8px;text-align:center;">
          <span style="font-size:12px;color:#9ca3af;">Sem dados suficientes para gerar sugestão</span>
        </div>`;
      }

      const _DOSES_CHIP  = ['manter', 'leve', 'moderado', 'forte'];
      const _DOSE_LABELS = { manter: 'Manter', leve: 'Leve', moderado: 'Moderado', forte: 'Forte' };
      const _DOSE_VERBO  = { forte: 'Reduzir', moderado: 'Reduzir', leve: 'Ajustar', manter: 'Manter' };
      const _EIXO_LABELS = { volume: 'Volume', intensidade: 'Intensidade', densidade: 'Densidade', carga_mecanica: 'Carga Mecânica' };
      const _PREC_CHIP   = ['carga_mecanica', 'volume', 'intensidade', 'densidade'];

      // Eixo dominante: maior dose, precedência como desempate
      const eixos = motorRec.eixos || {};
      let maxDoseIdx = -1, eixoDom = null;
      for (const e of _PREC_CHIP) {
        const idx = _DOSES_CHIP.indexOf(eixos[e]?.dose_final ?? 'manter');
        if (idx > maxDoseIdx) { maxDoseIdx = idx; eixoDom = e; }
      }
      const doseDom = _DOSES_CHIP[Math.max(0, maxDoseIdx)];

      // Cor por dose dominante (encaminhamento força vermelho)
      const _CHIP_CORES = {
        forte:    { bg: '#fee2e2', border: '#fca5a5', title: '#b91c1c', text: '#b91c1c' },
        moderado: { bg: '#fffbeb', border: '#fcd34d', title: '#92400e', text: '#92400e' },
        leve:     { bg: '#fefce8', border: '#fde047', title: '#713f12', text: '#854d0e' },
        manter:   { bg: '#f0fdf4', border: '#bbf7d0', title: '#166534', text: '#15803d' },
      };
      const cor = _CHIP_CORES[(motorRec.encaminhamento || doseDom === 'forte') ? 'forte' : doseDom] || _CHIP_CORES.manter;

      // Rótulo principal: "Reduzir Carga Mecânica"
      const chipLabel = eixoDom && doseDom !== 'manter'
        ? `${_DOSE_VERBO[doseDom]} ${_EIXO_LABELS[eixoDom]}`
        : 'Sem modulação necessária';

      // Linha de prioridade: "Reduzir volume e carga mecânica"
      const eixosAtivos = _PREC_CHIP.filter(e => _DOSES_CHIP.indexOf(eixos[e]?.dose_final ?? 'manter') >= _DOSES_CHIP.indexOf('moderado'));
      const eixosLeve   = _PREC_CHIP.filter(e => eixos[e]?.dose_final === 'leve');
      let prioLabel;
      if (motorRec.encaminhamento || motorRec.prioridade === 'protecao_tecidual') {
        prioLabel = 'Encaminhamento + restrição mecânica';
      } else if (eixosAtivos.length) {
        prioLabel = 'Reduzir ' + eixosAtivos.map(e => _EIXO_LABELS[e]).join(' e ').toLowerCase();
      } else if (eixosLeve.length) {
        prioLabel = 'Ajuste leve em ' + eixosLeve.map(e => _EIXO_LABELS[e]).join(' e ').toLowerCase();
      } else {
        prioLabel = 'Treino normal';
      }

      // Banner DM
      const dmBanner = motorRec.encaminhamento
        ? `<p style="font-size:11px;font-weight:700;color:#b91c1c;background:#fee2e2;border:1px solid #fca5a5;border-radius:4px;padding:5px 8px;margin-bottom:8px;">Encaminhar ao DM antes do treino</p>`
        : '';

      // Racional (sem z-scores) — só exibe se há alguma restrição ativa
      const temRestricaoAtiva = _PREC_CHIP.some(e => (eixos[e]?.dose_final ?? 'manter') !== 'manter');
      const racionalHTML = temRestricaoAtiva && (motorRec.racional_curto || []).length
        ? `<div style="margin-bottom:8px;">
             <p style="font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px;">Por que está em atenção</p>
             ${motorRec.racional_curto.map(f => `<p style="font-size:12px;color:${cor.text};line-height:1.5;margin:2px 0;">· ${f}</p>`).join('')}
           </div>`
        : '';

      // Restrições
      const restricoesHTML = (motorRec.restricoes || []).length
        ? `<div style="margin-bottom:8px;">
             <p style="font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px;">O que modular hoje</p>
             ${motorRec.restricoes.map(r => `<p style="font-size:12px;color:#374151;line-height:1.5;margin:2px 0;">· ${r}</p>`).join('')}
           </div>`
        : '';

      // Doses dos 4 eixos com diasEstavel por eixo
      const _PILL_BG        = { manter: '#f3f4f6', leve: '#fef9c3', moderado: '#fde68a', forte: '#fecaca' };
      const _PILL_TEXT      = { manter: '#9ca3af', leve: '#78350f',  moderado: '#92400e', forte: '#b91c1c' };
      const _RESTR_LABELS   = { manter: 'Livre', leve: 'Restrição Leve', moderado: 'Restrição Média', forte: 'Restrição Alta' };
      const eixosTabela = `<div>
        <p style="font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px;">Restrições por eixo</p>
        ${_PREC_CHIP.map(e => {
          const dose = eixos[e]?.dose_final ?? 'manter';
          const diasEst = eixos[e]?.diasEstavel_novo;
          const diasTag = (dose !== 'manter' && diasEst != null && diasEst > 0)
            ? `<span style="font-size:10px;color:#9ca3af;margin-left:4px;">${diasEst}d est.</span>`
            : '';
          return `<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid #f3f4f6;">
            <span style="font-size:12px;color:#6b7280;">${_EIXO_LABELS[e]}</span>
            <div style="display:flex;align-items:center;gap:2px;">
              <span style="font-size:11px;font-weight:700;background:${_PILL_BG[dose]};color:${_PILL_TEXT[dose]};padding:2px 8px;border-radius:4px;">${_RESTR_LABELS[dose]}</span>
              ${diasTag}
            </div>
          </div>`;
        }).join('')}
      </div>`;

      // Ajuste emocional aplicado
      const emocHTML = motorRec.emocional_aplicado
        ? `<p style="font-size:10px;color:#16a34a;font-weight:600;margin-top:6px;">✓ Ajuste emocional aplicado (humor favorável)</p>`
        : '';

      return `<button onclick="_toggleConsiderar(this)"
        style="width:100%;text-align:left;background:${cor.bg};border:1px solid ${cor.border};border-radius:6px;padding:7px 10px;cursor:pointer;display:flex;justify-content:space-between;align-items:flex-start;gap:6px;margin-top:8px;">
        <div style="flex:1;min-width:0;">
          <div style="font-size:12px;font-weight:700;color:${cor.title};line-height:1.3;">${chipLabel}</div>
          <div style="font-size:11px;color:${cor.text};opacity:.85;margin-top:2px;">${prioLabel}</div>
        </div>
        <span style="font-size:10px;color:${cor.text};opacity:.7;flex-shrink:0;padding-top:3px;">▼</span>
      </button>
      <div style="display:none;background:#fff;border:1px solid ${cor.border};border-radius:0 0 6px 6px;padding:10px 12px;margin-top:-1px;">
        ${dmBanner}
        ${racionalHTML}
        ${restricoesHTML}
        ${eixosTabela}
        ${emocHTML}
        <p style="font-size:10px;color:#9ca3af;margin-top:8px;line-height:1.4;">⚠ Sugestões geradas automaticamente. Não substituem a avaliação da comissão técnica.</p>
      </div>`;
    })();

    // ── Painel de Recovery colapsável ─────────────────────────────────────────
    const cardId = `mrec_${_cardIdx++}`;
    let recoveryHTML = "";
    if (recoveryBase) {
      const estaComprometido = pront.status === "Crítico" || pront.status === "Atenção" || pront.status === "Atenção Leve";
      const { classSono, classFadiga, classEstresse, classDor, classHRV, classCMJ, classNeuro } = pront;
      const al = c => c === "critico" || c === "atencao";

      // Uma única recomendação pré e pós — prioridade N1 → N2 → N3
      let preExtra = null;
      let posExtra = null;

      // Pré: sistema comprometido sobrepõe o do dia — usa sistema semanal
      const skCard = (() => {
        const s = _sistSemNome || pront.sistema || '';
        if (s.includes('Auton')) return 'Autonômico';
        if (s.includes('Neuro') && s.includes('musc')) return 'Neuromuscular';
        if (s.includes('Cogn')) return 'Cognitivo';
        if (s.includes('Subj')) return 'Subjetivo';
        return s;
      })();
      const sistPre = (estaComprometido && skCard && _recoveryPorSistema[skCard])
        ? _recoveryPorSistema[skCard].pre
        : recoveryBase.pre;

      // Pós: gerado por _posCards (cruzamento dia × indicador × região MMII)
      const itensPre = sistPre;
      const itensPos = _posCards(pront, mcLabel);

      const renderItens = (itens, cor) => itens.map(it =>
        it === '—'
          ? `<hr style="border:none;border-top:1px dashed #e5e7eb;margin:3px 0;">`
          : `<p style="font-size:12px;color:${cor};line-height:1.4;margin:2px 0;">· ${it}</p>`
      ).join('');

      const isMDp1 = mcLabel === 'MD+1';
      const isMDm1 = mcLabel === 'MD-1';
      const contextoMicro = isMDp1
        ? `<p style="font-size:11px;color:#7c3aed;font-weight:700;background:#f3e8ff;border-radius:4px;padding:3px 8px;display:inline-block;margin-bottom:4px;">⚠ MD+1 — Recovery obrigatório · sem carga</p>`
        : isMDm1
        ? `<p style="font-size:11px;color:#059669;font-weight:700;background:#d1fae5;border-radius:4px;padding:3px 8px;display:inline-block;margin-bottom:4px;">▶ MD-1 — Ativação · não é recovery</p>`
        : '';

      recoveryHTML = `
        <div id="${cardId}" style="display:none;margin-top:4px;">
          ${contextoMicro}
          <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;padding:8px 10px;margin-bottom:4px;">
            <p style="font-size:11px;font-weight:700;color:#15803d;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px;">Pré-treino · ${mcLabel}</p>
            ${renderItens(itensPre, '#166534')}
          </div>
          <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;padding:8px 10px;">
            <p style="font-size:11px;font-weight:700;color:#1d4ed8;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px;">Pós-treino · ${mcLabel}</p>
            ${renderItens(itensPos, '#1e40af')}
          </div>
        </div>
        <button onclick="_toggleRecovery(this)"
          style="width:100%;margin-top:4px;font-size:11px;color:#6b7280;background:#f9fafb;border:1px solid #e5e7eb;border-radius:4px;padding:5px 0;cursor:pointer;text-align:center;">
          ↕ Recovery ${mcLabel}
        </button>`;
    } else {
      recoveryHTML = `<p style="font-size:11px;color:#d1d5db;margin-top:4px;text-align:center;">Sem jogo cadastrado no planejamento</p>`;
    }

    // ── Foto ou iniciais ─────────────────────────────────────────────────────
    const iniciais = med.nome.split(' ').filter(Boolean).slice(0,2).map(p => p[0].toUpperCase()).join('');
    const fotoHTML = med.fotoUrl
      ? `<img src="${med.fotoUrl}" alt="${med.nome}"
              style="width:48px;height:48px;border-radius:50%;object-fit:cover;border:2px solid ${cc.bg};flex-shrink:0;"/>`
      : `<div style="width:48px;height:48px;border-radius:50%;background:${cc.bg};display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:700;color:${cc.text};flex-shrink:0;border:2px solid ${cc.bg};">${iniciais}</div>`;

    // ── Painel de indicadores do dia ─────────────────────────────────────────
    const _dotCor = c => c === 'critico' ? '#ef4444' : c === 'atencao' ? '#f97316' : c === 'atencao_leve' ? '#eab308' : '#22c55e';
    const _dot = (label, cls, temDados) => {
      const cor = temDados ? _dotCor(cls) : '#d1d5db';
      return `<span style="display:inline-flex;align-items:center;gap:4px;white-space:nowrap;"><span style="width:8px;height:8px;border-radius:50%;background:${cor};flex-shrink:0;display:inline-block;"></span><span style="font-size:13px;color:#6b7280;">${label}</span></span>`;
    };
    const temIH  = pront.IH  != null;
    const temIA  = pront.IA  != null;
    const temINM = pront.INM != null;
    const temIC  = pront.IC  != null;
    const indicadoresLinhas = [];
    const _humorLabels = ["Excelente","Muito bom","Bom","Regular","Ruim","Muito ruim","Péssimo"];
    const humorTag = pront.humorEmocional != null
      ? `<span style="font-size:12px;font-weight:600;color:#6b7280;background:#f3f4f6;border-radius:4px;padding:2px 7px;white-space:nowrap;">Humor: ${_humorLabels[pront.humorEmocional - 1]}</span>`
      : '';
    if (temIH)  indicadoresLinhas.push(`<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;"><span style="font-size:13px;font-weight:600;color:#9ca3af;width:104px;flex-shrink:0;">Subjetivo</span><div style="display:flex;gap:8px;flex-wrap:wrap;">${_dot('Sono',temIH?pront.classSono:null,temIH)}${_dot('Fadiga',temIH?pront.classFadiga:null,temIH)}${_dot('Estresse',temIH?pront.classEstresse:null,temIH)}${_dot('Dor',temIH?pront.classDor:null,temIH)}${humorTag}</div></div>`);
    if (temIA)  indicadoresLinhas.push(`<div style="display:flex;align-items:center;gap:8px;"><span style="font-size:13px;font-weight:600;color:#9ca3af;width:104px;flex-shrink:0;">Autonômico</span>${_dot('HRV',pront.classHRV,true)}</div>`);
    if (temINM) indicadoresLinhas.push(`<div style="display:flex;align-items:center;gap:8px;"><span style="font-size:13px;font-weight:600;color:#9ca3af;width:104px;flex-shrink:0;">Neuromuscular</span>${_dot('CMJ',pront.classCMJ,true)}</div>`);
    if (temIC)  indicadoresLinhas.push(`<div style="display:flex;align-items:center;gap:8px;"><span style="font-size:13px;font-weight:600;color:#9ca3af;width:104px;flex-shrink:0;">Cognitivo</span>${_dot('Neuro',pront.classNeuro,true)}</div>`);
    const indicadoresHTML = indicadoresLinhas.length
      ? `<div style="background:#f9fafb;border-radius:6px;padding:10px 12px;margin-bottom:10px;display:flex;flex-direction:column;gap:7px;">${indicadoresLinhas.join('')}</div>`
      : '';

    // ── IDs únicos para detalhe ───────────────────────────────────────────────
    const detalheId  = `det_${_cardIdx}`;
    const chevronId  = `chv_${_cardIdx}`;

    const nomePartes = med.nome.trim().split(/\s+/);
    const nomeExibido = nomePartes.length > 1
      ? `${nomePartes[0]} ${nomePartes[nomePartes.length - 1]}`
      : nomePartes[0];

    cardBuckets[group || 'sem_dados'].push(`
      <div data-nome="${med.nome}" data-atletaid="${id}" data-fotourl="${med.fotoUrl||''}" data-posicao="${med.posicao||''}" style="background:#111827;border:1.5px solid ${cc.bg};border-radius:12px;overflow:hidden;transition:box-shadow .15s;width:115px;flex-shrink:0;">

        <!-- Figurinha — face clicável -->
        <div onclick="_toggleCardDetalhe(this)"
             style="position:relative;aspect-ratio:2/3;cursor:pointer;user-select:none;overflow:hidden;">

          <!-- Fundo: foto ou iniciais -->
          ${med.fotoUrl
            ? `<img src="${med.fotoUrl}" alt="${med.nome}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:center top;">`
            : `<div style="position:absolute;inset:0;background:${cc.bg};display:flex;align-items:center;justify-content:center;"><span style="font-size:36px;font-weight:800;color:${cc.text};">${iniciais}</span></div>`
          }

          <!-- Degradê: topo leve + base escura -->
          <div style="position:absolute;inset:0;background:linear-gradient(to bottom,rgba(0,0,0,0.05) 0%,transparent 28%,rgba(0,0,0,0.65) 72%,rgba(0,0,0,0.88) 100%);"></div>

          <!-- IGP — círculo topo direito (sem seta) -->
          <div style="position:absolute;top:7px;right:7px;width:26px;height:26px;border-radius:50%;background:${cc.bg};display:flex;align-items:center;justify-content:center;border:2px solid rgba(255,255,255,0.55);box-shadow:0 2px 8px rgba(0,0,0,0.35);">
            <span style="font-size:10px;font-weight:800;color:${cc.text};line-height:1;">${globalVal != null ? globalVal : "—"}</span>
          </div>

          <!-- Info inferior -->
          <div style="position:absolute;bottom:0;left:0;right:0;padding:6px 10px 10px;">
            <div style="font-size:12px;font-weight:700;color:#fff;line-height:1.25;text-shadow:0 1px 4px rgba(0,0,0,0.6);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${nomeExibido}</div>
            ${med.posicao ? `<div style="font-size:9px;color:rgba(255,255,255,0.72);text-transform:uppercase;letter-spacing:.04em;margin-bottom:5px;">${med.posicao}</div>` : `<div style="margin-bottom:5px;"></div>`}
            <div style="display:flex;align-items:center;gap:4px;flex-wrap:nowrap;overflow:hidden;">
              ${med.statusMed === 'afastado' || med.statusMed === 'transicao' || med.statusMed === 'afastado_admin'
                ? `<span style="display:inline-flex;align-items:center;gap:3px;font-size:9px;font-weight:700;padding:3px 9px;border-radius:999px;background:${mc.pillBg};color:${mc.pillText};backdrop-filter:blur(2px);white-space:nowrap;flex-shrink:1;min-width:0;">
                     <span style="width:5px;height:5px;border-radius:50%;background:${mc.pillDot};flex-shrink:0;display:inline-block;"></span>
                     ${med.statusMed === 'afastado_admin' ? 'Adm' : mc.label}
                   </span>
                   ${(faseRTP && med.statusMed !== 'afastado_admin') ? `<span style="font-size:9px;font-weight:800;padding:3px 7px;border-radius:999px;background:${faseRTP.bg};color:${faseRTP.cor};backdrop-filter:blur(2px);white-space:nowrap;flex-shrink:0;">F${faseRTP.fase}</span>` : ''}
                   ${pront.flagDM ? `<span title="Passar pelo DM antes do treino: ${(pront.flagDMMotivos||[]).join(' · ')}" style="font-size:11px;font-weight:900;color:#dc2626;background:rgba(255,255,255,0.85);border-radius:50%;width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;line-height:1;">!</span>` : ''}`
                : (() => {
                    const pp = prontPill[pront.status] || prontPill["Sem dados"];
                    const shortLabel = { "Atenção Leve": "At. Leve", "Sem dados": "—" }[pront.status] || pront.status;
                    return `<span style="display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:700;padding:3px 11px;border-radius:999px;background:${pp.bg};color:${pp.text};backdrop-filter:blur(2px);white-space:nowrap;">
                      <span style="width:6px;height:6px;border-radius:50%;background:${pp.dot};flex-shrink:0;display:inline-block;"></span>
                      ${shortLabel}
                    </span>
                    ${pront.flagDM ? `<span title="Passar pelo DM antes do treino: ${(pront.flagDMMotivos||[]).join(' · ')}" style="font-size:11px;font-weight:900;color:#dc2626;background:rgba(255,255,255,0.85);border-radius:50%;width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;line-height:1;">!</span>` : ''}`; })()
              }
            </div>
          </div>
        </div>

        <!-- Detalhe colapsável -->
        <div data-detalhe style="display:none;border-top:1px solid #f3f4f6;padding:10px 12px;background:#fff;">

          <!-- Painel de indicadores -->
          ${indicadoresHTML}

          <!-- Depto. Médico / ADM -->
          <div class="${mc.bg} rounded px-3 py-2 mb-3">
            <p class="text-[12px] font-semibold text-gray-400 uppercase tracking-wide leading-none mb-1.5">${med.statusMed === 'afastado_admin' ? 'Adm' : 'Depto. Médico'}</p>
            <div class="flex items-center gap-1.5">
              <span class="w-2 h-2 rounded-full ${mc.dot} shrink-0"></span>
              <span class="font-bold text-[15px] ${mc.labelCor}">${mc.label}</span>
              ${diasEl}
            </div>
            ${infoMed}
            ${rtpHTML}
          </div>

          <!-- Prontidão Global -->
          <div class="${pc.bg} rounded px-3 py-2 mb-3">
            <div class="flex items-center justify-between leading-none mb-1.5">
              <p class="text-[12px] font-semibold text-gray-400 uppercase tracking-wide leading-none">Prontidão Global</p>
            </div>
            <div class="flex items-center gap-1.5">
              <span class="w-2 h-2 rounded-full ${pc.dot} shrink-0"></span>
              <span class="font-bold text-[15px] ${pc.labelCor}">${pront.status}</span>
              ${ispTendGlobal ? `<span style="font-size:12px;font-weight:700;padding:2px 8px;border-radius:4px;background:${ispTendGlobal.bg};color:${ispTendGlobal.cor};">ISP ${ispTendGlobal.icon} ${ispTendGlobal.label}</span>` : ""}
              ${fadigaBadgeHTML}
            </div>
            ${causas}
          </div>

          ${considerarCardHTML}

        </div>
      </div>
    `);
  });

  // ── Seção Depto. Médico (afastados) + Administrativo ─────────────────────
  const cardsAfastado  = cardBuckets.afastado       || [];
  const cardsTransicao = cardBuckets.transicao       || [];
  const cardsAdmin     = cardBuckets.afastado_admin  || [];
  const temDMAfastado  = cardsAfastado.length > 0;
  if (temDMAfastado || cardsAdmin.length > 0) {
    const secRestritos = document.createElement('div');
    const labelStyle = 'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px;';
    let innerHtml = '<div style="display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap;">';
    if (temDMAfastado) {
      innerHtml += `<div>
        <p style="${labelStyle}color:#b91c1c;">Depto. Médico</p>
        <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:flex-start;">${cardsAfastado.join('')}</div>
      </div>`;
    }
    if (cardsAdmin.length > 0) {
      const sep = temDMAfastado
        ? `<div style="width:1px;background:#e5e7eb;align-self:stretch;min-height:80px;"></div>`
        : '';
      innerHtml += `${sep}<div>
        <p style="${labelStyle}color:#7c3aed;">Administrativo</p>
        <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:flex-start;">${cardsAdmin.join('')}</div>
      </div>`;
    }
    innerHtml += '</div>';
    secRestritos.innerHTML = innerHtml;
    grid.appendChild(secRestritos);
  }

  // ── Seção RTP — Em Transição (figurinhas, linha própria) ─────────────────
  if (cardsTransicao.length > 0) {
    const hasDMacima = temDMAfastado || cardsAdmin.length > 0;
    const sepRTP = hasDMacima ? `<hr style="border:none;border-top:1px solid #e5e7eb;margin:4px 0 10px;">` : '';
    const labelStyle = 'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px;';
    const secRTP = document.createElement('div');
    secRTP.innerHTML = `
      ${sepRTP}
      <p style="${labelStyle}color:#c2410c;">Transição · RTP</p>
      <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:flex-start;">${cardsTransicao.join('')}</div>
    `;
    grid.appendChild(secRTP);
  }

  // ── Seção Status de Prontidão — agrupada por grupo de treino ───────────────
  const cardsPront = [
    ...(cardBuckets.critico     || []),
    ...(cardBuckets.atencao     || []),
    ...(cardBuckets.atencao_leve|| []),
    ...(cardBuckets.estavel     || []),
    ...(cardBuckets.sem_dados   || []),
  ];
  if (cardsPront.length > 0) {
    const sep = (cardsAfastado.length > 0 || cardsTransicao.length > 0 || cardsAdmin.length > 0)
      ? `<hr style="border:none;border-top:1px solid #e5e7eb;margin:4px 0 10px;">`
      : '';

    // Agrupar cards de prontidão por grupo (Geral, G1, G2, G3)
    const ORDEM_GRUPOS = ['Geral', 'G1', 'G2', 'G3', 'G4', 'Transição - RTP'];
    const hasGrupos = Object.keys(_gruposAtletasDash).length > 0;

    let prontHtml = '';
    if (hasGrupos) {
      // Mapeia card index → grupo (usamos a mesma ordem da lista original)
      const gruposUsados = new Map(); // grupo → [cardHtml]
      const semGrupo = [];

      // Percorre lista de atletas na ordem original (critico→sem_dados)
      const listaOrdenada = lista.filter(({ group }) =>
        ['critico','atencao','atencao_leve','estavel','sem_dados'].includes(group)
      );
      listaOrdenada.forEach(({ id }) => {
        const grupo = _gruposAtletasDash[id] || null;
        // Busca o card HTML do bucket correspondente para este atleta
        const atlBucket = lista.find(l => l.id === id);
        if (!atlBucket) return;
        // O card HTML foi pushed para cardBuckets — precisamos identificá-lo pelo atleta
        // Como cardBuckets armazena HTML strings, usamos data-nome para identificar
        const cardHtml = Object.values(cardBuckets).flat()
          .find(c => c.includes(`data-nome="${atlBucket.med.nome}"`));
        if (!cardHtml) return;
        if (grupo && ORDEM_GRUPOS.includes(grupo)) {
          if (!gruposUsados.has(grupo)) gruposUsados.set(grupo, []);
          gruposUsados.get(grupo).push(cardHtml);
        } else {
          semGrupo.push(cardHtml);
        }
      });

      const labelSec = 'font-size:9.5px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.08em;margin:0 0 7px;';
      const cntStyle = 'font-size:9px;font-weight:600;background:#f3f4f6;color:#6b7280;border-radius:999px;padding:1px 6px;margin-left:5px;text-transform:none;letter-spacing:0;vertical-align:middle;';
      ORDEM_GRUPOS.forEach(g => {
        const cards = gruposUsados.get(g) || [];
        if (!cards.length) return;
        prontHtml += `<div style="margin-bottom:12px;">
          <p style="${labelSec}">${g} <span style="${cntStyle}">${cards.length}</span></p>
          <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:flex-start;">${cards.join('')}</div>
        </div>`;
      });
      if (semGrupo.length) {
        prontHtml += `<div style="margin-bottom:12px;">
          <p style="${labelSec}">Sem grupo <span style="${cntStyle}">${semGrupo.length}</span></p>
          <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:flex-start;">${semGrupo.join('')}</div>
        </div>`;
      }
    } else {
      prontHtml = `<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:flex-start;">${cardsPront.join('')}</div>`;
    }

    const secPront = document.createElement('div');
    secPront.innerHTML = `
      ${sep}
      <p style="font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.08em;margin-bottom:${hasGrupos ? '12' : '8'}px;">Status de Prontidão <span style="font-weight:400;text-transform:none;letter-spacing:0;">(${cardsPront.length} liberados)</span></p>
      ${prontHtml}
    `;
    grid.appendChild(secPront);
  }
}
/* =====================================================
   MICRO-RECOVERY & PAP  —  ENGINE DE PRESCRIÇÃO
===================================================== */

const _mrBuckets = { critico: [], atencao: [], apto: [] };

function prescricaoMicroRecovery(nome, id, status, ind) {
  const {
    classSono, classEstresse, classFadiga, classDor,
    classHRV, classCMJ, classNeuro,
    ispTend, sistema,
  } = ind;

  const al = (c) => c === "critico" || c === "atencao";
  const cr = (c) => c === "critico";

  // ── Nível geral baseado em IGP (status) e ISP Tendência ──────
  let nivel;
  if (ispTend?.global?.label === 'Piorando') {
    nivel = "critico";
  } else if (ispTend?.global?.label === 'Estável') {
    nivel = status === "Crítico" ? "critico" : "atencao";
  } else {
    nivel = status === "Crítico" ? "critico" : status === "Atenção" ? "atencao" : "apto";
  }

  // ── Pool de exercícios de recovery (Crítico / Atenção) ────────
  const pool = [];

  if (al(classFadiga)) {
    pool.push({ p: cr(classFadiga) ? 4 : 3, cat: "Fadiga",       icon: "⚡", nome: "Bike ergométrica",              vol: cr(classFadiga) ? "5 min · cad. muito leve" : "3–4 min · cad. leve",   nota: "Sem elevar FC acima de 65%" });
    pool.push({ p: cr(classFadiga) ? 3 : 2, cat: "Fadiga",       icon: "⚡", nome: "Foam roller global",             vol: "2–3 min",                                                              nota: "Quad, posterior, panturrilha, lombar" });
  }
  if (al(classDor)) {
    pool.push({ p: cr(classDor)    ? 4 : 3, cat: "Dor",          icon: "🦵", nome: "Foam roller — seg. afetado",     vol: "3 min · pressão progressiva",                                         nota: "Não forçar dor aguda" });
    pool.push({ p: 2,                        cat: "Dor",          icon: "🦵", nome: "Extensora / Flexora leve",       vol: "1×10 rep · carga mínima",                                             nota: "Fluxo sanguíneo local — sem dor" });
  }
  if (al(classSono)) {
    pool.push({ p: cr(classSono)   ? 3 : 2, cat: "Sono",         icon: "🌙", nome: "Bike — ativação arousal",        vol: "3–4 min · cad. ritmada",                                              nota: "Eleva alerta sem fadiga" });
    pool.push({ p: 2,                        cat: "Sono",         icon: "🌙", nome: "Escadinha de agilidade",        vol: "3×5m · padrão ritmado",                                               nota: "Estimulação neuromuscular suave" });
  }
  if (al(classEstresse)) {
    pool.push({ p: cr(classEstresse)?4 : 3, cat: "Estresse",     icon: "😮‍💨", nome: "Respiração 4-7-8",            vol: "3 ciclos",                                                             nota: "Ativa parassimpático — reduz cortisol" });
    pool.push({ p: cr(classEstresse)?3 : 2, cat: "Estresse",     icon: "😮‍💨", nome: "Jogo cognitivo de madeira",   vol: "3 min · sem pressão",                                                  nota: "Foco calmo — reduz ruminação" });
  }
  if (al(classHRV)) {
    pool.push({ p: cr(classHRV)    ? 4 : 2, cat: "HRV",          icon: "❤️", nome: "Respiração diafragmática",      vol: "3 ciclos 4-7-8",                                                      nota: "Elevar tônus vagal" });
    pool.push({ p: cr(classHRV)    ? 3 : 1, cat: "HRV",          icon: "❤️", nome: "Bola suíça — postura relaxada", vol: "3 min",                                                               nota: "Respiração abdominal" });
  }
  if (al(classCMJ)) {
    pool.push({ p: cr(classCMJ)    ? 4 : 3, cat: "CMJ",          icon: "🦿", nome: "Foam roller — membros inferiores", vol: "3 min",                                                            nota: "Liberar antes de qualquer salto" });
    if (!cr(classCMJ))
      pool.push({ p: 2,                      cat: "CMJ",          icon: "🦿", nome: "Cama elástica — saltos leves",  vol: "2×5 rep · sem intenção máx.",                                        nota: "Aterrissagem bilateral controlada" });
  }
  if (al(classNeuro)) {
    pool.push({ p: cr(classNeuro)  ? 3 : 2, cat: "NeuroScore",   icon: "🧩", nome: "App Stroop — nível básico",     vol: "1'30\" · sem pressão",                                                nota: "Ativação cortical suave" });
    pool.push({ p: 1,                        cat: "NeuroScore",   icon: "🧩", nome: "Bola de reação — rebote livre", vol: "1–2 min",                                                             nota: "Ativação visual suave" });
  }

  const vistos = new Set();
  const exRecovery = pool
    .sort((a, b) => b.p - a.p)
    .filter(e => { if (vistos.has(e.nome)) return false; vistos.add(e.nome); return true; })
    .slice(0, 4);

  if (exRecovery.length === 0 && nivel !== "apto")
    exRecovery.push({ cat: "Geral", icon: "🔄", nome: "Foam roller global", vol: "2 min", nota: "Preparação geral" });

  // ── PAP para Apto: indica Força e/ou Cognitivo ────────────────
  // Força:    CMJ ou HRV ou fadiga sem alertas críticos → pode potencializar
  // Cognitivo: NeuroScore ou sono sem alertas críticos → pode potencializar
  // Omite domínio se indicador crítico nele
  let papForca    = true;
  let papCognitivo = true;

  if (nivel === "apto") {
    // Se CMJ crítico ou fadiga crítica → evitar contraste de força
    if (cr(classCMJ) || cr(classFadiga)) papForca = false;
    // Se NeuroScore crítico ou sono crítico → evitar PAP cognitivo
    if (cr(classNeuro) || cr(classSono)) papCognitivo = false;
  } else {
    papForca = false;
    papCognitivo = false;
  }

  // PAP adaptado (Atenção) — indica versão reduzida
  let papAdaptado = nivel === "atencao";

  _mrBuckets[nivel].push({ id, nome, nivel, exRecovery, papForca, papCognitivo, papAdaptado, ispTend, sistema });
}

// ── Render ─────────────────────────────────────────────────────
function renderizarMicroRecovery() {
  const cfg = {
    critico: { lista: "listaMRCritico", msg: "msgMRCritico", count: "countMRCritico" },
    atencao: { lista: "listaMRAtencao", msg: "msgMRAtencao", count: "countMRAtencao" },
    apto:    { lista: "listaMRApto",    msg: "msgMRApto",    count: "countMRApto"    },
  };

  Object.entries(_mrBuckets).forEach(([nivel, atletas]) => {
    const { lista, msg, count } = cfg[nivel];
    const listaEl = document.getElementById(lista);
    const msgEl   = document.getElementById(msg);
    const cntEl   = document.getElementById(count);
    if (!listaEl) return;

    cntEl.textContent = atletas.length;
    msgEl.style.display = atletas.length ? "none" : "block";
    listaEl.innerHTML = "";

    atletas.forEach(({ nome, nivel, exRecovery, papForca, papCognitivo, papAdaptado, ispTend }) => {

      const ispTendGlobal = ispTend?.global;
      const ispBadge = ispTendGlobal
        ? `<span class="text-xs font-semibold px-1.5 py-0.5 rounded ml-1" style="background:${ispTendGlobal.bg};color:${ispTendGlobal.cor};">ISP ${ispTendGlobal.icon} ${ispTendGlobal.label}</span>`
        : "";

      // ── Exercícios de recovery (Crítico / Atenção) ──────────
      let recoveryBlock = "";
      if (exRecovery.length > 0) {
        const label = nivel === "critico" ? "Recuperação Passiva" : "Micro-Recovery";
        const labelColor = nivel === "critico" ? "text-red-700 bg-red-50" : "text-yellow-700 bg-yellow-50";
        const rows = exRecovery.map(e => `
          <div class="flex gap-2 items-start py-1.5 border-b border-gray-100 last:border-0">
            <span class="text-sm leading-none mt-0.5">${e.icon}</span>
            <div class="flex-1 min-w-0">
              <p class="text-xs font-semibold text-gray-800">${e.nome}</p>
              <p class="text-xs text-blue-600 font-medium">${e.vol}</p>
              <p class="text-xs text-gray-400">${e.nota}</p>
            </div>
          </div>`).join("");
        recoveryBlock = `
          <p class="text-xs font-bold uppercase tracking-wide ${labelColor} px-2 py-0.5 rounded inline-block mb-2">
            ${label} · escolher 2–3
          </p>
          ${rows}`;
      }

      // ── PAP badges (Apto) ────────────────────────────────────
      let papBlock = "";
      if (nivel === "apto") {
        const badges = [];
        if (papForca)
          badges.push(`<span class="inline-flex items-center gap-1 text-xs font-bold px-2.5 py-1 rounded-full bg-blue-100 text-blue-700">🏋️ PAP Força</span>`);
        if (papCognitivo)
          badges.push(`<span class="inline-flex items-center gap-1 text-xs font-bold px-2.5 py-1 rounded-full bg-purple-100 text-purple-700">🧩 PAP Cognitivo</span>`);
        if (badges.length === 0)
          badges.push(`<span class="text-xs text-gray-400 italic">Verificar indicadores</span>`);
        papBlock = `<div class="flex flex-wrap gap-2 mt-1">${badges.join("")}</div>`;
      }

      // ── PAP adaptado (Atenção) ───────────────────────────────
      let papAdaptadoBlock = "";
      if (papAdaptado) {
        papAdaptadoBlock = `
          <div class="mt-2 pt-2 border-t border-dashed border-gray-200">
            <p class="text-xs font-bold uppercase tracking-wide text-yellow-700 bg-yellow-50 px-2 py-0.5 rounded inline-block mb-1">PAP Adaptado</p>
            <p class="text-xs text-gray-500">Executar após recovery · aguardar 4 min antes do treino</p>
          </div>`;
      }

      listaEl.innerHTML += `
        <div class="pb-3 border-b border-gray-100 last:border-0 last:pb-0">
          <p class="font-semibold text-sm text-gray-800 mb-2">${nome}${ispBadge}</p>
          ${recoveryBlock}
          ${papBlock}
          ${papAdaptadoBlock}
        </div>`;
    });
  });
}