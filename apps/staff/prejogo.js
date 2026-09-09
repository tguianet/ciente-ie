import { db } from "../core/firebase.js";
import {
  collection, getDocs, query, where, doc, getDoc
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";
import { calcularProntidao } from "../core/stats.js";

// ── Constants ─────────────────────────────────────────────────────────────────
const COR_VERDE  = '#10b981';
const COR_AMBAR  = '#f59e0b';
const COR_VERM   = '#ef4444';
const BG_PAGE    = '#f1efe8';
const BG_SEC     = '#f8f7f3';

const POSICOES_CFG = [
  { label: 'Goleiros',   match: ['goleiro'] },
  { label: 'Laterais',   match: ['lateral'] },
  { label: 'Zagueiros',  match: ['zagueiro'] },
  { label: 'Volantes',   match: ['volante'] },
  { label: 'Meias',      match: ['meia'] },
  { label: 'Pontas',     match: ['ponta'] },
  { label: 'Centro-Av.', match: ['centro-avante','centroavante','atacante','centro avante'] },
];


// ── Colour helpers ─────────────────────────────────────────────────────────────
function corIGP(igp) {
  if (igp >= 70) return COR_VERDE;
  if (igp >= 60) return COR_AMBAR;
  return COR_VERM;
}

// Absolute load thresholds (PSE×min platform scale)
function corCarga(valor) {
  if (valor == null) return '#d1d5db';
  if (valor <= 300) return '#3b82f6';   // baixa — azul
  if (valor <= 600) return COR_AMBAR;   // moderada — âmbar
  if (valor <= 800) return '#f97316';   // alta — laranja
  return COR_VERM;                       // muito alta — vermelho
}

// ── Linear regression + tendência ────────────────────────────────────────────
function linearReg(pts) {
  const n = pts.length;
  const sx = pts.reduce((s, p) => s + p.x, 0);
  const sy = pts.reduce((s, p) => s + p.y, 0);
  const sxy = pts.reduce((s, p) => s + p.x * p.y, 0);
  const sx2 = pts.reduce((s, p) => s + p.x * p.x, 0);
  const denom = n * sx2 - sx * sx;
  if (denom === 0) return { slope: 0 };
  return { slope: (n * sxy - sx * sy) / denom };
}

function calcTendencia(dmList, hoje) {
  const cutoff = new Date(hoje + 'T00:00:00');
  cutoff.setDate(cutoff.getDate() - 28);
  const cutStr = cutoff.toLocaleDateString('en-CA');
  const pts = dmList
    .filter(d => d.date >= cutStr && d.date <= hoje)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d, i) => { const igp = calcularProntidao(d, dmList, hoje).global; return igp != null ? { x: i, y: igp } : null; })
    .filter(Boolean);
  if (pts.length < 5) return null;
  const { slope } = linearReg(pts);
  if (slope > 0.3) return 'up';
  if (slope < -0.3) return 'down';
  return 'stable';
}

// ── Name helpers ──────────────────────────────────────────────────────────────
function abreviarNome(nome) {
  const partes = (nome || '').trim().split(/\s+/);
  const primeiro = partes[0] || '';
  if (primeiro.length <= 10) return primeiro;
  const ultimo = partes[partes.length - 1];
  return `${primeiro[0]}. ${ultimo}`;
}

function corAvatar(nome) {
  const palette = ['#64748b', '#3b82f6', '#14b8a6', '#f97316'];
  let h = 0;
  for (const c of (nome || '')) h = (h * 31 + c.charCodeAt(0)) & 0xffff;
  return palette[h % palette.length];
}

function iniciais(nome) {
  const partes = (nome || '').trim().split(/\s+/).filter(Boolean);
  if (!partes.length) return '?';
  if (partes.length === 1) return partes[0].slice(0, 2).toUpperCase();
  return (partes[0][0] + partes[partes.length - 1][0]).toUpperCase();
}

// ── Medical status map ────────────────────────────────────────────────────────
function buildStatusMedicoMap(medicoSnap) {
  const latest = {};
  medicoSnap.forEach(d => {
    const data = d.data();
    const dd   = data.dados || data;
    const aid  = data.athleteId;
    if (!aid) return;
    const temStatus    = !!(dd.status || dd.statusAtual || data.status || data.statusAtual);
    const ehClinico    = data.tipo === 'status_clinico' || data.tipo === 'lesao' || data.tipo === 'lesão' || dd.tipoRegistro === 'lesao';
    const temLesao     = !!(dd.tipoLesao || data.tipoLesao);
    const semAtend     = !data.tipoAtendimento && !dd.tipoAtendimento;
    if (!temStatus && !ehClinico && !(semAtend && temLesao)) return;
    const dataReg = data.data || data.date ||
      (data.createdAt?.toDate ? data.createdAt.toDate().toLocaleDateString('en-CA') : '');
    if (!latest[aid] || dataReg > (latest[aid]._dataReg || '')) {
      latest[aid] = { ...data, _dd: dd, _dataReg: dataReg };
    }
  });
  const map = {};
  Object.entries(latest).forEach(([aid, entry]) => {
    const dd = entry._dd || entry;
    const status = (dd.status || dd.statusAtual || entry.status || entry.statusAtual || '').toLowerCase().trim();
    if (status === 'afastado') map[aid] = 'afastado';
    else if (status === 'transição' || status === 'transicao') map[aid] = 'transicao';
  });
  return map;
}

// ── Próximo jogo ──────────────────────────────────────────────────────────────
function isoWeekStr() {
  const d = new Date();
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `S${Math.ceil((((t - y) / 86400000) + 1) / 7)}-${d.getFullYear()}`;
}

async function getProximoJogo(clubId, hoje) {
  const chave = `microciclo_${isoWeekStr()}_${clubId}`;
  const raw = localStorage.getItem(chave);
  if (raw) {
    try {
      const ctx = JSON.parse(raw);
      const sorted = [...(ctx.jogos || [])].sort((a, b) => a.data.localeCompare(b.data));
      const prox = sorted.find(j => j.data >= hoje);
      if (prox) return prox;
    } catch(e) {}
  }
  try {
    const snap = await getDoc(doc(db, 'assessments_planning', `${isoWeekStr()}_${clubId}`));
    if (snap.exists()) {
      const sorted = [...(snap.data().jogos || [])].sort((a, b) => a.data.localeCompare(b.data));
      const prox = sorted.find(j => j.data >= hoje);
      if (prox) return prox;
    }
  } catch(e) { console.warn('[PreJogo] getProximoJogo:', e); }
  return null;
}

// ── Chart renderers ───────────────────────────────────────────────────────────
function renderCargaChart(cargaSemana) {
  const W = 160, BAR_H = 34, LABEL_H = 12, H = BAR_H + LABEL_H;
  const labels = ['S','T','Q','Q','S','S','D'];
  const GAP = 4;
  const barW = (W - GAP * 6) / 7;
  const maxVal = Math.max(...cargaSemana.filter(v => v != null), 1);

  let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:${H}px;display:block;">`;
  cargaSemana.forEach((val, i) => {
    const x  = i * (barW + GAP);
    const cx = x + barW / 2;
    if (val != null) {
      const bh  = Math.max(2, (val / maxVal) * (BAR_H - 4));
      const y   = BAR_H - bh;
      svg += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${bh.toFixed(1)}" fill="${corCarga(val)}" rx="1.5"/>`;
    } else {
      svg += `<rect x="${x.toFixed(1)}" y="${(BAR_H - 2).toFixed(1)}" width="${barW.toFixed(1)}" height="2" fill="#e5e7eb" rx="1"/>`;
    }
    svg += `<text x="${cx.toFixed(1)}" y="${H - 2}" text-anchor="middle" font-size="8" fill="#9ca3af" font-family="'Segoe UI',sans-serif">${labels[i]}</text>`;
  });
  return svg + '</svg>';
}

function renderIGPChart(dados14d) {
  const VW = 230, VH = 78;
  const ML = 28, MT = 5, MB = 5, MR = 4;
  const PW = VW - ML - MR;
  const PH = VH - MT - MB;

  const n    = dados14d.length;
  const mapX = i   => ML + i * (PW / Math.max(n - 1, 1));
  const mapY = val => MT + PH - (val / 100) * PH;

  const hasData = dados14d.some(v => v != null);

  let svg = `<svg viewBox="0 0 ${VW} ${VH}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:${VH}px;display:block;">`;

  // Y axis grid lines + labels at 0, 60, 70, 100
  [{ v: 100, lbl: '100' }, { v: 70, lbl: '70' }, { v: 60, lbl: '60' }, { v: 50, lbl: '50' }, { v: 0, lbl: '0' }].forEach(({ v, lbl }) => {
    const y    = mapY(v).toFixed(1);
    const isT  = v === 70 || v === 60 || v === 50;
    const gCol = isT ? (v === 70 ? COR_VERDE : v === 60 ? COR_AMBAR : COR_VERM) : '#e5e7eb';
    const dash = isT ? '3,3' : '';
    svg += `<line x1="${ML}" y1="${y}" x2="${VW - MR}" y2="${y}" stroke="${gCol}" stroke-width="${isT ? '0.8' : '0.4'}" ${dash ? `stroke-dasharray="${dash}"` : ''} opacity="${isT ? '0.5' : '0.7'}"/>`;
    svg += `<text x="${ML - 3}" y="${(+y + 3).toFixed(1)}" text-anchor="end" font-size="7" fill="#9ca3af" font-family="'Segoe UI',sans-serif">${lbl}</text>`;
  });

  // Y axis line
  svg += `<line x1="${ML}" y1="${MT}" x2="${ML}" y2="${MT + PH}" stroke="#e5e7eb" stroke-width="0.5"/>`;

  if (!hasData) {
    svg += `<text x="${(ML + PW / 2).toFixed(1)}" y="${(MT + PH / 2 + 4).toFixed(1)}" text-anchor="middle" font-size="9" fill="#9ca3af" font-family="'Segoe UI',sans-serif">Sem dados</text>`;
    return svg + '</svg>';
  }

  // Collect non-null points (preserving X index for spacing)
  const pts = dados14d.map((v, i) => v != null ? { i, v } : null).filter(Boolean);

  // Segments — connect consecutive non-null points, bridging null gaps
  for (let j = 0; j < pts.length - 1; j++) {
    const { i: i1, v: v1 } = pts[j];
    const { i: i2, v: v2 } = pts[j + 1];
    svg += `<line x1="${mapX(i1).toFixed(1)}" y1="${mapY(v1).toFixed(1)}" x2="${mapX(i2).toFixed(1)}" y2="${mapY(v2).toFixed(1)}" stroke="${corIGP(v1)}" stroke-width="1.5" stroke-linecap="round"/>`;
  }

  // Last point dot
  if (pts.length) {
    const { i, v } = pts[pts.length - 1];
    svg += `<circle cx="${mapX(i).toFixed(1)}" cy="${mapY(v).toFixed(1)}" r="2.5" fill="${corIGP(v)}"/>`;
  }

  return svg + '</svg>';
}

// ── Athlete card HTML ─────────────────────────────────────────────────────────
function renderAtletaCard(at) {
  const { nome, fotoUrl, status, igpHoje, tendencia, fatorAplicado } = at;

  const cardBg = status === 'afastado'
    ? 'rgba(136,135,128,0.12)'
    : status === 'transicao'
      ? 'rgba(245,158,11,0.12)'
      : BG_SEC;

  const avatarStyle = `width:38px;height:38px;border-radius:50%;background:${corAvatar(nome)};display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#fff;flex-shrink:0;`;
  const fotoEl = fotoUrl
    ? `<img src="${fotoUrl}" alt="" style="width:38px;height:38px;border-radius:50%;object-fit:cover;object-position:center top;" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">
       <div style="${avatarStyle}display:none;">${iniciais(nome)}</div>`
    : `<div style="${avatarStyle}">${iniciais(nome)}</div>`;

  let statusEl;
  if (status === 'apto') {
    const cor   = igpHoje != null ? corIGP(igpHoje) : '#9ca3af';
    const val   = igpHoje != null ? Math.round(igpHoje) : '—';
    const arrow = tendencia === 'up' ? '↗' : tendencia === 'down' ? '↘' : tendencia === 'stable' ? '→' : '';
    const arrowCor = tendencia === 'up' ? COR_VERDE : tendencia === 'down' ? COR_VERM : '#9ca3af';
    statusEl = `<div style="line-height:1.2;">
      <span style="font-size:16px;font-weight:600;color:${cor};">${val}</span>${arrow
        ? ` <span style="font-size:11px;color:${arrowCor};">${arrow}</span>` : ''}
    </div>`;
  } else if (status === 'transicao') {
    statusEl = `<div style="font-size:12px;font-weight:500;color:${COR_AMBAR};">Transição</div>`;
  } else {
    statusEl = `<div style="font-size:12px;font-weight:500;color:${COR_VERM};">Afastado</div>`;
  }

  const border = status === 'afastado'
    ? '1.5px solid #ef4444'
    : status === 'transicao'
      ? '1.5px solid #f97316'
      : '1.5px solid transparent';

  return `<div style="width:88px;flex-shrink:0;padding:7px 3px;border-radius:6px;background:${cardBg};border:${border};text-align:center;">
  <div style="display:flex;justify-content:center;margin-bottom:4px;">${fotoEl}</div>
  <p style="font-size:11px;color:#6b7280;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin:0 0 2px;padding:0 3px;">${abreviarNome(nome)}</p>
  ${statusEl}
  ${fatorAplicado ? '<div style="width:6px;height:6px;border-radius:50%;background:#6b7280;margin:3px auto 0;opacity:.55;" title="Ajuste emocional ativo"></div>' : '<div style="height:9px;"></div>'}
</div>`;
}

// ── Position row HTML ─────────────────────────────────────────────────────────
function renderPosicaoRow(label, atletas) {
  if (!atletas.length) return '';
  const total      = atletas.length;
  const afastados  = atletas.filter(a => a.status === 'afastado').length;
  const transicao  = atletas.filter(a => a.status === 'transicao').length;
  const disp       = total - afastados - transicao;
  const pct        = Math.round((disp / total) * 100);
  const cards      = atletas.map(renderAtletaCard).join('');

  return `<div style="background:#fff;border:0.5px solid #e5e7eb;border-radius:8px;padding:10px 14px;display:flex;align-items:flex-start;gap:12px;">
  <div style="width:90px;flex-shrink:0;padding-top:2px;">
    <div style="font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:#2c2c2a;">${label}</div>
    <div style="font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:#9ca3af;margin-top:6px;">Disponíveis</div>
    <div style="font-size:13px;font-weight:700;color:#2c2c2a;margin-top:1px;">${disp}/${total} · ${pct}%</div>
  </div>
  <div style="flex:1;display:flex;flex-wrap:wrap;gap:6px;">${cards}</div>
</div>`;
}

// ── Full document ─────────────────────────────────────────────────────────────
function buildDocument({ nomeClube, categoria, proximoJogo, kpiContadores, kpiCarga, kpiIGP, posRows, dataGeracao }) {
  let headerTitle, headerSub;
  if (proximoJogo) {
    const [y, m, d] = proximoJogo.data.split('-');
    const parts = [`${d}/${m}/${y}`];
    if (proximoJogo.horario) parts.push(proximoJogo.horario);
    if (proximoJogo.local)   parts.push(proximoJogo.local);
    headerTitle = `${nomeClube} vs ${proximoJogo.adversario || '—'}`;
    headerSub   = `<div style="font-size:13px;color:#6b7280;margin-top:2px;">${parts.join(' · ')}</div>`;
  } else {
    headerTitle = 'Sem jogo agendado';
    headerSub   = '';
  }

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<title>Relatório Pré-Jogo — ${nomeClube}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:'Segoe UI',Arial,sans-serif;background:${BG_PAGE};color:#2c2c2a;min-height:100vh;}
  .kpi-grid{display:grid;grid-template-columns:1.3fr 1fr 1fr;gap:12px;}
  @media(max-width:900px){.kpi-grid{grid-template-columns:1fr 1fr;}}
  @media(max-width:600px){.kpi-grid{grid-template-columns:1fr;}.top-row{flex-direction:column!important;}}
  @media print{
    @page{size:A4 portrait;margin:7mm;}
    body{background:#fff!important;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
    .no-print{display:none!important;}
    .main-container{padding:0!important;}
    .kpi-grid{grid-template-columns:1.3fr 1fr 1fr!important;gap:6px!important;}
    .kpi-card{padding:8px!important;}
  }
</style>
</head>
<body>
<div class="main-container" style="max-width:960px;margin:0 auto;padding:28px 20px;">

  <!-- Header -->
  <div class="top-row" style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:12px;">
    <div>
      <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:#9a7b4b;margin-bottom:4px;">RELATÓRIO PRÉ-JOGO${categoria ? ' · ' + categoria : ''}</div>
      <h1 style="font-size:23px;font-weight:500;color:#1a1a18;">${headerTitle}</h1>
      ${headerSub}
      <div style="font-size:12px;color:#9ca3af;margin-top:4px;">Gerado em ${dataGeracao}</div>
      <div style="font-size:10px;color:#9ca3af;margin-top:3px;">DEPTO. DE INTELIGÊNCIA ESPORTIVA - CIENTE IE</div>
    </div>
    <button class="no-print" onclick="window.print()"
      style="padding:8px 20px;background:#1a1a18;color:#fff;border:none;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;flex-shrink:0;">
      Imprimir / PDF
    </button>
  </div>

  <!-- KPI Row -->
  <div class="kpi-grid" style="margin-bottom:16px;">
    <!-- Card A: Contadores -->
    <div class="kpi-card" style="background:${BG_SEC};border-radius:8px;padding:12px;display:flex;align-items:center;">
      ${kpiContadores}
    </div>
    <!-- Card B: Carga -->
    <div class="kpi-card" style="background:#fff;border:0.5px solid #e5e7eb;border-radius:8px;padding:12px;">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#6b7280;margin-bottom:7px;">CARGA PSE×MIN · GRUPO</div>
      ${kpiCarga}
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:7px;">
        ${[['#3b82f6','≤300 Baixa'],['#f59e0b','301-600 Mod.'],['#f97316','601-800 Alta'],['#ef4444','>800 Muito Alta']].map(([c,l])=>`<span style="display:flex;align-items:center;gap:3px;font-size:9px;color:#6b7280;white-space:nowrap;"><span style="width:8px;height:8px;border-radius:50%;background:${c};flex-shrink:0;"></span>${l}</span>`).join('')}
      </div>
    </div>
    <!-- Card C: IGP -->
    <div class="kpi-card" style="background:#fff;border:0.5px solid #e5e7eb;border-radius:8px;padding:12px;">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#6b7280;margin-bottom:7px;">IGP MÉDIO · GRUPO</div>
      ${kpiIGP}
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:7px;">
        ${[['#10b981','≥70 Estável'],['#f59e0b','60-69 Atenção'],['#ef4444','<60 Crítico']].map(([c,l])=>`<span style="display:flex;align-items:center;gap:3px;font-size:9px;color:#6b7280;white-space:nowrap;"><span style="width:8px;height:8px;border-radius:50%;background:${c};flex-shrink:0;"></span>${l}</span>`).join('')}
      </div>
    </div>
  </div>

  <!-- Position table -->
  <div style="display:flex;flex-direction:column;gap:6px;">
    ${posRows || '<div style="text-align:center;padding:40px;color:#9ca3af;font-size:14px;">Nenhum atleta encontrado.</div>'}
  </div>

  <!-- Footer -->
  <div style="margin-top:20px;padding-top:10px;border-top:1.5px solid #e5e7eb;text-align:center;">
    <div style="font-size:11px;font-weight:600;color:#1a1a18;letter-spacing:.02em;">DEPTO. DE INTELIGÊNCIA ESPORTIVA - CIENTE IE América</div>
    <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:#9a7b4b;margin-top:3px;">Ciente IE</div>
  </div>

</div>
<script>
(function(){
  window.addEventListener('beforeprint', function(){
    var mc = document.querySelector('.main-container');
    if(!mc) return;
    var pageH = (297 - 14) * 3.7795;
    var ratio = pageH / mc.scrollHeight;
    if(ratio < 1) document.documentElement.style.zoom = ratio;
  });
  window.addEventListener('afterprint', function(){
    document.documentElement.style.zoom = '';
  });
})();
</script>
</body>
</html>`;
}

// ── Main export ───────────────────────────────────────────────────────────────
export async function abrirRelatorioPreJogo(categoria = '') {
  const ctx    = JSON.parse(localStorage.getItem('userContext') || '{}');
  const clubId = ctx.clubId;
  if (!clubId) { alert('Clube não identificado.'); return; }

  const nomeClube = ctx.clubName || clubId;
  const hoje      = new Date().toLocaleDateString('en-CA');

  const win = window.open('', '_blank');
  win.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Carregando…</title>
    <style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;background:${BG_PAGE};}</style>
    </head><body><div style="text-align:center;color:#2c2c2a;"><div style="font-size:28px;">⏳</div><p style="margin-top:8px;">Carregando dados…</p></div></body></html>`);

  try {
    // ── 1. Fetch (5 queries in parallel) ─────────────────────────────────────
    const [atletasSnap, dmSnap, rtpSnap, medicoSnap] = await Promise.all([
      getDocs(query(collection(db, 'athletes'),            where('clubId', '==', clubId), where('ativo', '!=', false))),
      getDocs(query(collection(db, 'daily_metrics'),       where('clubId', '==', clubId))),
      getDocs(query(collection(db, 'rtp_progress'),        where('clubId', '==', clubId))),
      getDocs(query(collection(db, 'assessments_medical'), where('clubId', '==', clubId))),
    ]);
    const proximoJogo = await getProximoJogo(clubId, hoje);

    // ── 2. Build maps ─────────────────────────────────────────────────────────
    const atletasMap = {};
    atletasSnap.forEach(d => {
      const a = { id: d.id, ...d.data() };
      if (categoria && a.categoria !== categoria) return;
      atletasMap[d.id] = a;
    });

    const rtpMap = {};
    rtpSnap.forEach(d => {
      const data = d.data();
      const aid  = data.athleteId;
      if (aid && data.fase != null) {
        if (rtpMap[aid] == null || data.fase > rtpMap[aid]) rtpMap[aid] = data.fase;
      }
    });
    try {
      const lsCache = JSON.parse(localStorage.getItem(`rtp_cache_${clubId}`) || '{}');
      Object.entries(lsCache).forEach(([aid, cached]) => {
        if (rtpMap[aid] == null && cached?.fase != null) rtpMap[aid] = cached.fase;
      });
    } catch(e) {}

    const statusMedMap = buildStatusMedicoMap(medicoSnap);

    const dmPorAtleta = {}, dmPorData = {};
    dmSnap.forEach(d => {
      const dm = { id: d.id, ...d.data() };
      if (!atletasMap[dm.athleteId]) return;
      if (!dmPorAtleta[dm.athleteId]) dmPorAtleta[dm.athleteId] = [];
      dmPorAtleta[dm.athleteId].push(dm);
      if (!dmPorData[dm.date]) dmPorData[dm.date] = [];
      dmPorData[dm.date].push(dm);
    });
    Object.values(dmPorAtleta).forEach(list => list.sort((a, b) => a.date.localeCompare(b.date)));

    // ── 3. Per-athlete data ───────────────────────────────────────────────────
    const atletas = Object.values(atletasMap).map(at => {
      const sm      = statusMedMap[at.id] || '';
      const rtpFase = rtpMap[at.id] ?? null;

      // Status driven exclusively by assessments_medical (same as original prejogo.js)
      let status;
      if (sm === 'afastado')                         status = 'afastado';
      else if (sm === 'transicao' || sm === 'transição') status = 'transicao';
      else                                           status = 'apto';

      const dmList  = dmPorAtleta[at.id] || [];
      const dmHoje  = (dmPorData[hoje] || []).find(d => d.athleteId === at.id) || null;
      const igpHoje  = (status === 'apto' && dmHoje) ? calcularProntidao(dmHoje, dmList, hoje).global : null;
      const tendencia = status === 'apto' ? calcTendencia(dmList, hoje) : null;

      return {
        id: at.id, nome: at.nome || '—', posicao: at.posicao || '',
        fotoUrl: at.fotoUrl || '', status, igpHoje, tendencia,
        fatorAplicado: dmHoje?.scores?.fatorAplicado ?? false,
      };
    });

    // ── 4. KPI counts ─────────────────────────────────────────────────────────
    const total     = atletas.length;
    const liberados = atletas.filter(a => a.status === 'apto').length;
    const transicao = atletas.filter(a => a.status === 'transicao').length;
    const afastados = atletas.filter(a => a.status === 'afastado').length;

    const pctL = total ? Math.round((liberados / total) * 100) : 0;
    const pctT = total ? Math.round((transicao / total) * 100) : 0;
    const pctA = total ? Math.round((afastados / total) * 100) : 0;

    const divider = `<div style="width:1px;background:#e5e7eb;align-self:stretch;"></div>`;
    const kpiItem = (val, label, cor) =>
      `<div style="flex:1;text-align:center;padding:0 4px;">
        <div style="font-size:18px;font-weight:600;color:${cor};">${val}</div>
        <div style="font-size:9px;text-transform:uppercase;letter-spacing:.04em;color:#6b7280;white-space:nowrap;">${label}</div>
      </div>`;
    const kpiContadores = kpiItem(liberados, `Liberados · ${pctL}%`, COR_VERDE)
      + divider + kpiItem(transicao, `Transição · ${pctT}%`, COR_AMBAR)
      + divider + kpiItem(afastados, `Afastados · ${pctA}%`, COR_VERM);

    // ── 5. Chart data ─────────────────────────────────────────────────────────
    // Current week Mon–Sun
    const weekDays = (() => {
      const d   = new Date(hoje + 'T00:00:00');
      const dow = d.getDay();
      const mon = new Date(d);
      mon.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
      return Array.from({ length: 7 }, (_, i) => {
        const dd = new Date(mon); dd.setDate(mon.getDate() + i);
        return dd.toLocaleDateString('en-CA');
      });
    })();

    const cargaSemana = weekDays.map(date => {
      const dms = (dmPorData[date] || []).filter(d => d.post?.carga != null);
      return dms.length ? dms.reduce((s, d) => s + d.post.carga, 0) / dms.length : null;
    });

    const aptoIds = new Set(atletas.filter(a => a.status === 'apto').map(a => a.id));
    const igpGrupo14d = (() => {
      const dias = [];
      for (let i = 13; i >= 0; i--) {
        const d = new Date(hoje + 'T00:00:00'); d.setDate(d.getDate() - i);
        dias.push(d.toLocaleDateString('en-CA'));
      }
      return dias.map(date => {
        const igps = (dmPorData[date] || [])
          .filter(d => aptoIds.has(d.athleteId))
          .map(d => calcularProntidao(d, dmPorAtleta[d.athleteId] || [], hoje).global)
          .filter(v => v != null);
        return igps.length ? igps.reduce((s, v) => s + v, 0) / igps.length : null;
      });
    })();

    // ── 6. Group by position ──────────────────────────────────────────────────
    const prioridade = a => a.status === 'apto' ? 0 : a.status === 'transicao' ? 1 : 2;

    const posGrupos = POSICOES_CFG.map(({ label, match }) => {
      const grupo = atletas.filter(a => {
        const n = (a.posicao || '').toLowerCase().trim().replace(/\s+/g, '-');
        return match.some(m => n.includes(m));
      });
      grupo.sort((a, b) => {
        const pa = prioridade(a), pb = prioridade(b);
        if (pa !== pb) return pa - pb;
        if (a.status === 'apto') return (b.igpHoje ?? -1) - (a.igpHoje ?? -1);
        return a.nome.localeCompare(b.nome);
      });
      return { label, atletas: grupo };
    }).filter(g => g.atletas.length > 0);

    // ── 7. Render ─────────────────────────────────────────────────────────────
    const [hy, hm, hd] = hoje.split('-');
    const html = buildDocument({
      nomeClube,
      categoria,
      proximoJogo,
      kpiContadores,
      kpiCarga:      renderCargaChart(cargaSemana),
      kpiIGP:        renderIGPChart(igpGrupo14d),
      posRows:       posGrupos.map(g => renderPosicaoRow(g.label, g.atletas)).join(''),
      dataGeracao:   `${hd}/${hm}/${hy}`,
    });

    win.document.open();
    win.document.write(html);
    win.document.close();

  } catch(err) {
    console.error('[PreJogo]', err);
    try {
      win.document.open();
      win.document.write(`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:32px;color:#b91c1c;">
        <strong>Erro ao gerar relatório:</strong> ${err.message}</body></html>`);
      win.document.close();
    } catch(e) {}
  }
}
