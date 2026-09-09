import { db, auth } from "../core/firebase.js";
import {
  collection, getDocs, getDoc,
  query, where, doc
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";
import { onAuthStateChanged } from
  "https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js";
import {
  calcularHooperScore, calcularZScoreCMJ, calcularIndicadorVFC,
  calcularIndicadorNeuro, calcularProntidao as _calcularProntidao,
} from "../core/stats.js";

const params    = new URLSearchParams(location.search);
const ATLETA_ID = params.get('id');
let CLUB_ID     = null;

let _metricas28    = [];   // últimos 28 dias (calendário)
let _metricasSem   = [];   // dias da semana atual (seg → hoje)
let _todosMetricas = {};   // date → data (histórico completo)
let _chartPront  = null;
let _chartCarga  = null;

/* ─────────────────────────────────────
   SCORE HELPERS — wrappers sobre stats.js
   Constrói historico compatível adicionando athleteId em cada registro.
───────────────────────────────────── */
function _historicoParaStats(registros) {
  return registros.map(r => ({ ...r, athleteId: ATLETA_ID }));
}

function calcularIA(lnRR, todos28) {
  return calcularIndicadorVFC(ATLETA_ID, lnRR, null, _historicoParaStats(todos28), null);
}

function calcularINM(salto, dor, todos28) {
  return calcularZScoreCMJ(ATLETA_ID, salto, dor, _historicoParaStats(todos28), null);
}

function calcularIC(neuroScore, sono, todos28) {
  return calcularIndicadorNeuro(ATLETA_ID, neuroScore, sono, _historicoParaStats(todos28), null);
}

function calcularIGP(dm, todos28) {
  const historico = _historicoParaStats(todos28);
  const result = _calcularProntidao({ ...dm, athleteId: ATLETA_ID }, historico, dm?.date ?? null);
  return { global: result.global, IH: result.IH, IA: result.IA, INM: result.INM, IC: result.IC };
}

/* ─────────────────────────────────────
   HELPERS
───────────────────────────────────── */
function getSegundaFeira() {
  const hoje = new Date();
  const dow  = hoje.getDay(); // 0=dom, 1=seg ...
  const diff = dow === 0 ? 6 : dow - 1;
  const seg  = new Date(hoje);
  seg.setDate(hoje.getDate() - diff);
  seg.setHours(0, 0, 0, 0);
  return seg;
}

function dateToBR(str) {
  const [, m, d] = str.split('-');
  return `${d}/${m}`;
}

/* ─────────────────────────────────────
   INIT
───────────────────────────────────── */
onAuthStateChanged(auth, async user => {
  if (!user) { location.href = '/login.html'; return; }
  if (!ATLETA_ID) { location.href = 'perfil_elenco.html'; return; }

  const ctx = JSON.parse(localStorage.getItem('userContext') || '{}');
  CLUB_ID = ctx.clubId || null;
  if (!CLUB_ID) {
    const snap = await getDoc(doc(db, 'users', user.uid));
    CLUB_ID = snap.exists() ? snap.data().clubId : null;
  }
  if (!CLUB_ID) return;

  await carregarMetricas();

  await Promise.all([
    carregarHeader(),
    renderQ1(),
    renderQ2(),
    carregarQ3(),
    carregarQ4(),
  ]);
});

/* ─────────────────────────────────────
   CARREGA MÉTRICAS (28 dias + semana)
───────────────────────────────────── */
async function carregarMetricas() {
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  const hojeStr = hoje.toLocaleDateString('en-CA');

  // Limites
  const d28 = new Date(hoje);
  d28.setDate(hoje.getDate() - 27);
  const d28Str = d28.toLocaleDateString('en-CA');

  const segunda    = getSegundaFeira();
  const segundaStr = segunda.toLocaleDateString('en-CA');

  // Uma única query — mesmo padrão do dashboard.js
  const snap = await getDocs(query(
    collection(db, 'daily_metrics'),
    where('athleteId', '==', ATLETA_ID),
    where('clubId',    '==', CLUB_ID)
  ));

  const todos = {};
  snap.forEach(ds => {
    const d = ds.data();
    if (d.date) todos[d.date] = d;
  });
  _todosMetricas = todos;

  // Preenche 28 dias (hoje-27 → hoje), inclusive dias sem dados
  _metricas28 = [];
  for (let i = 27; i >= 0; i--) {
    const dt = new Date(hoje);
    dt.setDate(hoje.getDate() - i);
    const str = dt.toLocaleDateString('en-CA');
    _metricas28.push(todos[str] ? { ...todos[str] } : { date: str });
  }

  // Semana atual: segunda → hoje
  _metricasSem = [];
  for (let d = new Date(segunda); d <= hoje; d.setDate(d.getDate() + 1)) {
    const str = new Date(d).toLocaleDateString('en-CA');
    _metricasSem.push(todos[str] ? { ...todos[str] } : { date: str });
  }
}

/* ─────────────────────────────────────
   HEADER
───────────────────────────────────── */
async function carregarHeader() {
  const snap = await getDoc(doc(db, 'athletes', ATLETA_ID));
  if (!snap.exists()) return;
  const d = snap.data();
  const nome = (d.nome || d.name || '').trim();
  document.getElementById('headerNome').textContent = nome;
  document.title = `${nome} · Ciente IE`;
  document.getElementById('headerPosicao').textContent = d.posicao || '';

  const fotoEl = document.getElementById('headerFoto');
  if (d.fotoUrl) {
    fotoEl.innerHTML = `<img src="${d.fotoUrl}" style="width:100%;height:100%;object-fit:cover;">`;
  } else {
    const p = nome.split(/\s+/);
    fotoEl.textContent = p.slice(0, 2).map(x => x[0]?.toUpperCase() || '').join('');
  }

  // Status médico (última lesão)
  const medSnap = await getDocs(query(
    collection(db, 'assessments_medical'),
    where('athleteId', '==', ATLETA_ID),
    where('clubId',    '==', CLUB_ID)
  ));
  let ultima = null;
  medSnap.forEach(dd => {
    const data = dd.data();
    if (data.tipo === 'lesao' && (!ultima || (data.date || '') > (ultima.date || '')))
      ultima = data;
  });
  const st = ultima?.dados?.status || 'liberado';
  const stCfg = {
    afastado:  { bg: '#fee2e2', text: '#b91c1c', label: 'Afastado'   },
    transicao: { bg: '#ffedd5', text: '#c2410c', label: 'Transição'  },
    liberado:  { bg: '#dcfce7', text: '#15803d', label: 'Disponível' },
  };
  const sc = stCfg[st] || stCfg.liberado;
  const stEl = document.getElementById('headerStatus');
  stEl.textContent = sc.label;
  stEl.style.background = sc.bg;
  stEl.style.color = sc.text;
}

/* ─────────────────────────────────────
   Q1 — SEMANA ATUAL (seg → hoje)
───────────────────────────────────── */
function renderQ1() {
  const el = document.getElementById('q1Conteudo');

  const hojeStr       = new Date().toLocaleDateString('en-CA');
  const diasColetados = _metricasSem.filter(r => r.pre?.sono != null).length;
  const totalDiasSem  = _metricasSem.length;

  // Último registro da semana com dados, mesmo que não seja hoje
  const ultimo = [..._metricasSem].reverse().find(r => r.pre?.sono != null);
  const stale  = ultimo ? ultimo.date !== hojeStr : false;

  if (!ultimo) {
    el.innerHTML = `<p style="font-size:13px;color:#9ca3af;">Sem registros esta semana.</p>`;
    return;
  }

  const pre    = ultimo.pre    || {};
  const post   = ultimo.post   || {};

  const hooper   = pre.hooper     ?? null;
  const sono     = pre.sono       ?? null;
  const fadiga   = pre.fadiga     ?? null;
  const estresse = pre.estresse   ?? null;
  const dor      = pre.dor        ?? null;

  // CMJ, HRV, Neuro e Carga: último dado da semana por índice
  const semRev  = [..._metricasSem].reverse();
  const dmCMJ   = semRev.find(r => r.pre?.salto   != null) || {};
  const dmHRV   = semRev.find(r => r.hrv?.lnRR    != null) || {};
  const dmNeuro = semRev.find(r => r.neuro?.score != null) || {};
  const dmPost  = semRev.find(r => r.post?.pse    != null) || {};
  const cmj     = dmCMJ.pre?.salto    ?? null;
  const lnRRRaw = dmHRV.hrv?.lnRR     ?? null;
  const lnRR    = lnRRRaw != null ? Math.round(lnRRRaw * 100) / 100 : null;
  const neuroSc = dmNeuro.neuro?.score ?? null;

  // IGP calculado a partir do documento "ultimo" — igual ao dashboard
  // passado = _metricas28 excluindo o próprio dia de referência
  const passado28 = _metricas28.filter(r => r.date !== ultimo.date);
  const { global: igp, IH: sIH } = calcularIGP(ultimo, passado28);

  // Scores individuais calculados a partir do doc de referência de cada índice
  const sIA_real   = lnRRRaw != null ? calcularIA(lnRRRaw,  _metricas28.filter(r => r.date !== dmHRV.date))   : null;
  const sINM_real  = cmj     != null ? calcularINM(cmj, dmCMJ.pre?.dor ?? null, _metricas28.filter(r => r.date !== dmCMJ.date))   : null;
  const sIC_real   = neuroSc != null ? calcularIC(neuroSc,  dmNeuro.pre?.sono ?? null, _metricas28.filter(r => r.date !== dmNeuro.date)) : null;

  // Staleness por indicador
  const staleCMJ   = !dmCMJ.date   || dmCMJ.date   !== hojeStr;
  const staleHRV   = !dmHRV.date   || dmHRV.date   !== hojeStr;
  const staleNeuro = !dmNeuro.date || dmNeuro.date !== hojeStr;

  // Pill colorida igual ao padrão da prontidão
  function scorePill(score, isStale, type = 'default') {
    if (score == null) return '';
    const v = Math.round(score);
    let cor, bg;
    if (isStale) {
      cor = '#9ca3af'; bg = '#f3f4f6';
    } else if (type === 'cmj') {
      cor = v >= 60 ? '#15803d' : v >= 50 ? '#a16207' : v >= 40 ? '#c2410c' : '#b91c1c';
      bg  = v >= 60 ? '#dcfce7' : v >= 50 ? '#fef9c3' : v >= 40 ? '#ffedd5' : '#fee2e2';
    } else {
      cor = v >= 70 ? '#15803d' : v >= 60 ? '#a16207' : v >= 50 ? '#c2410c' : '#b91c1c';
      bg  = v >= 70 ? '#dcfce7' : v >= 60 ? '#fef9c3' : v >= 50 ? '#ffedd5' : '#fee2e2';
    }
    return `<span style="display:inline-block;padding:2px 8px;border-radius:6px;font-weight:700;font-size:11px;background:${bg};color:${cor};">Score ${v}/100</span>`;
  }
  // datas de referência de cada índice
  const dataCMJ   = dmCMJ.date   ? dateToBR(dmCMJ.date)   : null;
  const dataHRV   = dmHRV.date   ? dateToBR(dmHRV.date)   : null;
  const dataNeuro = dmNeuro.date ? dateToBR(dmNeuro.date) : null;
  const dataCarga = dmPost.date  ? dateToBR(dmPost.date)  : null;
  const postDados= dmPost.post || {};
  const pse      = postDados.pse      ?? null;
  const volume   = postDados.tempo    ?? null;
  const carga    = postDados.carga    != null ? Math.round(postDados.carga) : null;
  const qualidade= postDados.qualidade ?? null;

  // ACWR
  const cargas28 = _metricas28.map(r => r.post?.carga ?? null).filter(v => v != null);
  const cargas7  = _metricas28.slice(-7).map(r => r.post?.carga ?? null).filter(v => v != null);
  let acwr = null, acwrCor = '#6b7280';
  if (cargas28.length >= 4 && cargas7.length >= 2) {
    const aguda   = cargas7.reduce((s, v) => s + v, 0) / 7;
    const cronica = cargas28.reduce((s, v) => s + v, 0) / 28;
    if (cronica > 0) {
      acwr = (aguda / cronica).toFixed(2);
      acwrCor = stale ? '#9ca3af' : acwr > 1.5 ? '#b91c1c' : acwr > 1.3 ? '#c2410c' : acwr < 0.8 ? '#9ca3af' : '#15803d';
    }
  }

  function igpCor(v) {
    if (v == null) return '#9ca3af';
    if (stale) return '#9ca3af';
    if (v >= 70) return '#15803d';
    if (v >= 60) return '#84cc16';
    if (v >= 50) return '#c2410c';
    return '#b91c1c';
  }

  // cel: se stale, texto sempre cinza
  function cel(label, val, unidade = '', cor = null) {
    const c   = stale ? '#9ca3af' : (cor || (val != null ? '#111827' : '#d1d5db'));
    const txt = val != null ? `${val}${unidade}` : '—';
    return `
      <div style="padding:4px 0;border-bottom:1px solid #f3f4f6;">
        <p style="font-size:9px;color:#9ca3af;margin:0;text-transform:uppercase;letter-spacing:.04em;">${label}</p>
        <p style="font-size:13px;font-weight:700;color:${c};margin:0;">${txt}</p>
      </div>`;
  }

  function corHooper(v) {
    if (v == null || stale) return stale ? '#9ca3af' : '#d1d5db';
    if (v <= 14) return '#15803d'; if (v <= 20) return '#c2410c'; return '#b91c1c';
  }
  function corEscala(v) {
    if (v == null || stale) return stale ? '#9ca3af' : '#d1d5db';
    return v <= 2 ? '#15803d' : v <= 4 ? '#c2410c' : '#b91c1c';
  }

  const igpVal   = igp != null ? Math.round(igp) : null;
  const igpLabel = stale ? `IGP · ${dateToBR(ultimo.date)}` : 'IGP hoje';

  el.innerHTML = `
    <div style="display:flex;gap:10px;margin-bottom:14px;">
      <div style="text-align:center;background:${igpVal != null && !stale ? '#f0fdf4' : '#f9fafb'};border-radius:10px;padding:10px 14px;flex:1;">
        <p style="font-size:28px;font-weight:800;color:${igpCor(igpVal)};margin:0;">${igpVal ?? '—'}</p>
        <p style="font-size:9px;color:#6b7280;margin:2px 0 0;text-transform:uppercase;">${igpLabel}</p>
      </div>
      <div style="text-align:center;background:#f8fafc;border-radius:10px;padding:10px 14px;flex:1;">
        <p style="font-size:28px;font-weight:800;color:#1e3a5f;margin:0;">${diasColetados}/${totalDiasSem}</p>
        <p style="font-size:9px;color:#6b7280;margin:2px 0 0;text-transform:uppercase;">Dias coletados</p>
      </div>
    </div>

    ${stale ? `<p style="font-size:9px;color:#9ca3af;margin:0 0 8px;">Sem coleta hoje · último: ${dateToBR(ultimo.date)}</p>` : ''}

    <!-- Hooper em linha: 4 inputs + total -->
    <div style="margin-bottom:10px;">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px;">
        <p style="font-size:9px;font-weight:700;color:#3b82f6;text-transform:uppercase;margin:0;">Subjetivo · Hooper</p>
        <span style="font-size:9px;color:#9ca3af;">${dateToBR(ultimo.date)}</span>
      </div>
      <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:4px;">
        ${[
          ['Sono',     sono,     corEscala(sono)],
          ['Estresse', estresse, corEscala(estresse)],
          ['Fadiga',   fadiga,   corEscala(fadiga)],
          ['Dor',      dor,      corEscala(dor)],
          ['IH',       hooper,   corHooper(hooper)],
        ].map(([lbl, val, cor]) => `
          <div style="text-align:center;background:#f9fafb;border-radius:7px;padding:5px 2px;">
            <p style="font-size:8px;color:#9ca3af;margin:0;text-transform:uppercase;">${lbl}</p>
            <p style="font-size:13px;font-weight:800;color:${stale ? '#9ca3af' : cor};margin:0;">${val ?? '—'}</p>
          </div>`).join('')}
      </div>
      ${sIH != null ? `<div style="margin:4px 0 0;text-align:right;">${scorePill(sIH, stale)}</div>` : ''}
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:10px;">

      <!-- INM -->
      <div style="background:#f9fafb;border-radius:8px;padding:8px;">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px;">
          <div>
            <p style="font-size:8px;font-weight:700;color:#3b82f6;text-transform:uppercase;margin:0;line-height:1.2;">Neuromuscular</p>
            <p style="font-size:7px;color:#9ca3af;text-transform:uppercase;margin:0;line-height:1.2;">Salto</p>
          </div>
          ${dataCMJ ? `<span style="font-size:8px;color:#9ca3af;">${dataCMJ}</span>` : ''}
        </div>
        ${cel('Salto', cmj, ' cm')}
        ${sINM_real != null ? `<div style="margin:4px 0 0;">${scorePill(sINM_real, staleCMJ, 'cmj')}</div>` : ''}
      </div>

      <!-- IA -->
      <div style="background:#f9fafb;border-radius:8px;padding:8px;">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px;">
          <div>
            <p style="font-size:8px;font-weight:700;color:#10b981;text-transform:uppercase;margin:0;line-height:1.2;">Autonômico</p>
            <p style="font-size:7px;color:#9ca3af;text-transform:uppercase;margin:0;line-height:1.2;">VFC</p>
          </div>
          ${dataHRV ? `<span style="font-size:8px;color:#9ca3af;">${dataHRV}</span>` : ''}
        </div>
        ${cel('lnRR', lnRR, ' ms')}
        ${sIA_real != null ? `<div style="margin:4px 0 0;">${scorePill(sIA_real, staleHRV)}</div>` : ''}
      </div>

      <!-- IC -->
      <div style="background:#f9fafb;border-radius:8px;padding:8px;">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px;">
          <div>
            <p style="font-size:8px;font-weight:700;color:#8b5cf6;text-transform:uppercase;margin:0;line-height:1.2;">Cognitivo</p>
            <p style="font-size:7px;color:#9ca3af;text-transform:uppercase;margin:0;line-height:1.2;">Neuroscore</p>
          </div>
          ${dataNeuro ? `<span style="font-size:8px;color:#9ca3af;">${dataNeuro}</span>` : ''}
        </div>
        ${cel('Score', neuroSc, '/100')}
        ${sIC_real != null ? `<div style="margin:4px 0 0;">${scorePill(sIC_real, staleNeuro)}</div>` : ''}
      </div>
    </div>

    <!-- Carga -->
    <div>
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px;">
        <p style="font-size:9px;font-weight:700;color:#f97316;text-transform:uppercase;margin:0;">Carga</p>
        ${dataCarga ? `<span style="font-size:9px;color:#9ca3af;">${dataCarga}</span>` : ''}
      </div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:4px;">
        ${[
          ['PSE',  pse,      '/10'],
          ['Vol',  volume,   '\''],
          ['Carga',carga,    ' UA'],
          ['Qual', qualidade,'/5'],
        ].map(([lbl, val, un]) => `
          <div style="text-align:center;background:#f9fafb;border-radius:7px;padding:5px 2px;">
            <p style="font-size:8px;color:#9ca3af;margin:0;text-transform:uppercase;">${lbl}</p>
            <p style="font-size:13px;font-weight:800;color:${stale?'#9ca3af':(val!=null?'#111827':'#d1d5db')};margin:0;">${val != null ? `${val}${un}` : '—'}</p>
          </div>`).join('')}
      </div>
      ${acwr != null ? `<p style="font-size:9px;color:${stale?'#9ca3af':'#6b7280'};margin:4px 0 0;text-align:right;">ACWR: <strong style="color:${stale?'#9ca3af':acwrCor};">${acwr}</strong></p>` : ''}
    </div>

    ${pre.regioes_dor?.length ? `
      <div style="margin-top:8px;padding:6px 8px;background:${stale ? '#f9fafb' : '#fef2f2'};border-radius:6px;">
        <p style="font-size:10px;color:${stale ? '#9ca3af' : '#b91c1c'};margin:0;"><strong>Dor:</strong> ${pre.regioes_dor.join(', ')}</p>
      </div>` : ''}
  `;
}

/* ─────────────────────────────────────
   Q2 — GRÁFICOS 28 DIAS
───────────────────────────────────── */
function renderQ2() {
  const labels = _metricas28.map(r => dateToBR(r.date));

  // IGP calculado dia a dia (usando os 28 dias como janela de histórico)
  const igpSeries = _metricas28.map(dm => {
    const { global } = calcularIGP(dm, _metricas28);
    return global != null ? Math.round(global) : null;
  });

  window._series28 = {
    labels,
    igp:    igpSeries,
    hooper: _metricas28.map(r => r.pre?.hooper  ?? null),
    cmj:    _metricas28.map(r => r.pre?.salto   ?? null),
    hrv:    _metricas28.map(r => r.hrv?.lnRR    ?? null),   // ← hrv, não neuro
    carga:  _metricas28.map(r => r.post?.carga  ?? null),
  };

  renderGraficoCarga();
  trocarGrafico('igp');
}

function makeChartOpts(color, yMax) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: {
        ticks: { font: { size: 9 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 7 },
        grid: { display: false },
      },
      y: {
        min: 0,
        ...(yMax ? { max: yMax } : {}),
        ticks: { font: { size: 9 } },
        grid: { color: '#f3f4f6' },
      }
    }
  };
}

function mediaValores(arr) {
  const validos = arr.filter(v => v != null);
  if (!validos.length) return null;
  return validos.reduce((a, b) => a + b, 0) / validos.length;
}

function datasetMedia(labels, media, cor) {
  if (media == null) return null;
  return {
    label: 'Média',
    data: Array(labels.length).fill(Math.round(media * 10) / 10),
    borderColor: cor + 'aa',
    borderDash: [4, 4],
    borderWidth: 1.5,
    pointRadius: 0,
    fill: false,
    tension: 0,
    spanGaps: true,
    order: 2,
  };
}

function renderGraficoCarga() {
  const canvas = document.getElementById('graficoCarga');
  if (!canvas) return;
  if (_chartCarga) { _chartCarga.destroy(); _chartCarga = null; }
  const dados  = window._series28.carga;
  const media  = mediaValores(dados);
  const datasets = [{
    label: 'Carga (UA)',
    data: dados,
    backgroundColor: '#8b5cf688',
    borderColor: '#8b5cf6',
    borderWidth: 1,
    borderRadius: 3,
    order: 1,
  }];
  const linhaMedia = datasetMedia(window._series28.labels, media, '#8b5cf6');
  if (linhaMedia) datasets.push({ ...linhaMedia, type: 'line' });
  _chartCarga = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: { labels: window._series28.labels, datasets },
    options: makeChartOpts('#8b5cf6', null),
  });
}

window.trocarGrafico = function(tipo) {
  const todos = ['igp', 'hooper', 'cmj', 'hrv'];
  todos.forEach(b => {
    const el = document.getElementById(`btnGrafico_${b}`);
    if (!el) return;
    const ativo = b === tipo;
    el.style.background  = ativo ? '#eff6ff' : '#f9fafb';
    el.style.color       = ativo ? '#1d4ed8' : '#6b7280';
    el.style.borderColor = ativo ? '#3b82f6' : '#e5e7eb';
  });

  if (!window._series28) return;

  const cfgs = {
    igp:    { label: 'IGP',          color: '#15803d', dados: window._series28.igp,    yMax: 100 },
    hooper: { label: 'IH (Hooper)',  color: '#f97316', dados: window._series28.hooper, yMax: 28  },
    cmj:    { label: 'CMJ (cm)',     color: '#3b82f6', dados: window._series28.cmj,    yMax: null },
    hrv:    { label: 'VFC (lnRR)',   color: '#10b981', dados: window._series28.hrv,    yMax: null },
  };
  const c = cfgs[tipo];
  if (!c) return;

  const canvas = document.getElementById('graficoProntidao');
  if (!canvas) return;
  if (_chartPront) { _chartPront.destroy(); _chartPront = null; }

  const media = mediaValores(c.dados);
  const datasets = [{
    label: c.label,
    data: c.dados,
    borderColor: c.color,
    backgroundColor: c.color + '20',
    borderWidth: 2,
    pointRadius: 3,
    pointHoverRadius: 5,
    tension: 0.3,
    spanGaps: true,
    fill: true,
    order: 1,
  }];
  const linhaMedia = datasetMedia(window._series28.labels, media, c.color);
  if (linhaMedia) datasets.push(linhaMedia);

  _chartPront = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: { labels: window._series28.labels, datasets },
    options: makeChartOpts(c.color, c.yMax),
  });
};

/* ─────────────────────────────────────
   Q3 — PERFORMANCE
───────────────────────────────────── */
function _dateToWeekKey(dateStr) {
  if (!dateStr) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt  = new Date(y, m - 1, d, 12, 0, 0);
  const utc = new Date(Date.UTC(dt.getFullYear(), dt.getMonth(), dt.getDate()));
  utc.setUTCDate(utc.getUTCDate() + 4 - (utc.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((utc - yearStart) / 86400000) + 1) / 7);
  return `S${week}-${utc.getUTCFullYear()}`;
}

function _corIP(v) {
  if (v == null) return '#9ca3af';
  if (v >= 70) return '#15803d';
  if (v >= 60) return '#4ade80';
  if (v >= 50) return '#c2410c';
  return '#b91c1c';
}
function _bgIP(v) {
  if (v == null) return '#f3f4f6';
  if (v >= 70) return '#dcfce7';
  if (v >= 60) return '#f0fdf4';
  if (v >= 50) return '#ffedd5';
  return '#fee2e2';
}

function _renderTabelaPartidas(lista) {
  if (!lista.length) return `<p style="font-size:12px;color:#9ca3af;padding:4px 0;">Nenhuma partida.</p>`;
  return `<div style="display:flex;flex-direction:column;gap:4px;">
    ${lista.map(p => {
      const corMin = p.minutos >= 80 ? '#15803d' : p.minutos >= 45 ? '#c2410c' : '#9ca3af';
      const adv = p.adversario ? `<span style="font-size:11px;color:#6b7280;flex:1;text-align:center;">${p.adversario}</span>` : '<span style="flex:1;"></span>';
      const ipBadge = p.ip != null
        ? `<span style="display:inline-block;padding:1px 7px;border-radius:5px;font-size:11px;font-weight:700;background:${_bgIP(p.ip)};color:${_corIP(p.ip)};flex-shrink:0;">IP ${Math.round(p.ip)}</span>`
        : `<span style="font-size:11px;color:#d1d5db;flex-shrink:0;">IP —</span>`;
      return `<div style="display:flex;align-items:center;gap:6px;padding:5px 8px;background:#f9fafb;border-radius:6px;">
        <span style="font-size:11px;color:#374151;flex-shrink:0;">${p.data || '—'}</span>
        ${adv}
        <span style="font-size:12px;font-weight:700;color:${corMin};flex-shrink:0;">${p.minutos}'</span>
        ${ipBadge}
      </div>`;
    }).join('')}
  </div>`;
}

async function carregarQ3() {
  const el = document.getElementById('q3Conteudo');

  const [snapPartidas, snapPlan] = await Promise.all([
    getDocs(query(collection(db, 'scout_partidas'), where('clubId', '==', CLUB_ID))),
    getDocs(query(collection(db, 'assessments_planning'), where('clubId', '==', CLUB_ID))),
  ]);

  // Mapa weekKey → período
  const periodoMap = {};
  snapPlan.forEach(d => {
    const wk = d.id.split('_')[0];
    const p  = d.data().periodo;
    if (wk && p) periodoMap[wk] = p;
  });

  // Agrupa docs por data: preferindo doc do scout (sem fonte='manual') sobre manual
  const porData = {};
  snapPartidas.forEach(d => {
    const p = { id: d.id, ...d.data() };
    if (p.data?.toDate) p.data = p.data.toDate().toLocaleDateString('en-CA');
    if (!p.data) return;
    const existing = porData[p.data];
    // Prefere doc sem fonte='manual' (scout) sobre manual
    if (!existing || (existing.fonte === 'manual' && p.fonte !== 'manual')) {
      porData[p.data] = p;
    }
  });

  const partidas = [];
  Object.values(porData).forEach(p => {
    const raw = p.playedSeconds?.[ATLETA_ID];
    if (raw == null) return;
    // Suporta formato número (manual/scout) e objeto {seconds:N} (GPS)
    const segs = typeof raw === 'object' ? (raw.seconds ?? 0) : (typeof raw === 'number' ? raw : 0);
    if (segs <= 0) return;
    const wk = _dateToWeekKey(p.data);
    const periodo = periodoMap[wk] || null;
    const min = Math.round(segs / 60);
    const ip  = p.perfSnapshot?.[ATLETA_ID]?.performance ?? null;
    partidas.push({ ...p, minutos: min, periodo, ip });
  });
  partidas.sort((a, b) => (b.data || '').localeCompare(a.data || ''));

  if (!partidas.length) {
    el.innerHTML = `<p style="font-size:13px;color:#9ca3af;">Sem dados de partidas.</p>`;
    return;
  }

  const totalMin   = partidas.reduce((s, p) => s + p.minutos, 0);
  const totalJogos = partidas.length;
  const ipsValidos = partidas.map(p => p.ip).filter(v => v != null);
  const mediaIP    = ipsValidos.length ? Math.round(ipsValidos.reduce((s, v) => s + v, 0) / ipsValidos.length) : null;

  const competicao  = partidas.filter(p => p.periodo === 'Competição');
  const preparacao  = partidas.filter(p => p.periodo === 'Preparação' || p.periodo === 'Transição');
  const semPeriodo  = partidas.filter(p => !p.periodo);

  function secaoPartidas(titulo, cor, lista) {
    if (!lista.length) return '';
    const tot = lista.reduce((s, p) => s + p.minutos, 0);
    const med = Math.round(tot / lista.length);
    return `
      <div style="margin-bottom:12px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
          <p style="font-size:10px;font-weight:700;color:${cor};text-transform:uppercase;letter-spacing:.05em;margin:0;">${titulo}</p>
          <span style="font-size:9px;color:#9ca3af;">${lista.length} jogo${lista.length > 1 ? 's' : ''} · ${tot}' · média ${med}'</span>
        </div>
        ${_renderTabelaPartidas(lista)}
      </div>`;
  }

  el.innerHTML = `
    <div style="display:flex;gap:8px;margin-bottom:14px;">
      <div style="text-align:center;background:#eff6ff;border-radius:10px;padding:8px 12px;flex:1;">
        <p style="font-size:22px;font-weight:800;color:#1d4ed8;margin:0;">${totalJogos}</p>
        <p style="font-size:9px;color:#6b7280;margin:2px 0 0;text-transform:uppercase;">Partidas</p>
      </div>
      <div style="text-align:center;background:#f0fdf4;border-radius:10px;padding:8px 12px;flex:1;">
        <p style="font-size:22px;font-weight:800;color:#15803d;margin:0;">${totalMin}'</p>
        <p style="font-size:9px;color:#6b7280;margin:2px 0 0;text-transform:uppercase;">Min. totais</p>
      </div>
      <div style="text-align:center;background:#fefce8;border-radius:10px;padding:8px 12px;flex:1;">
        <p style="font-size:22px;font-weight:800;color:${_corIP(mediaIP)};margin:0;">${mediaIP ?? '—'}</p>
        <p style="font-size:9px;color:#6b7280;margin:2px 0 0;text-transform:uppercase;">Índice de Performance (Média)</p>
      </div>
    </div>
    ${secaoPartidas('Período Competitivo', '#1d4ed8', competicao)}
    ${secaoPartidas('Período Preparatório', '#15803d', preparacao)}
    ${secaoPartidas('Sem período cadastrado', '#9ca3af', semPeriodo)}
  `;
}

/* ─────────────────────────────────────
   Q4 — DEPTO MÉDICO
───────────────────────────────────── */
async function carregarQ4() {
  const el = document.getElementById('q4Conteudo');

  const snap = await getDocs(query(
    collection(db, 'assessments_medical'),
    where('athleteId', '==', ATLETA_ID),
    where('clubId',    '==', CLUB_ID)
  ));

  const lesoes = [], atendimentos = [];
  snap.forEach(ds => {
    const r = ds.data();
    const tipo = (r.tipo || r.dados?.tipoRegistro || '').toLowerCase();
    if (tipo === 'lesao' || tipo === 'lesão')  lesoes.push(r);
    if (tipo === 'atendimento')                atendimentos.push(r);
  });
  // campo de data pode ser "data" ou "date" dependendo da versão
  const dateOf  = r => r.data || r.date || '';
  const statusOf = r => (r.dados?.status || r.dados?.statusAtual || r.status || r.statusAtual || 'liberado').toLowerCase();
  const altaOf  = r => r.dataAlta || r.dados?.dataAlta || null;

  lesoes.sort((a, b)       => (dateOf(b)).localeCompare(dateOf(a)));
  atendimentos.sort((a, b) => (dateOf(b)).localeCompare(dateOf(a)));

  function diasCorridos(ini, fim) {
    if (!ini) return null;
    const start = new Date(ini + 'T00:00:00');
    const end   = fim ? new Date(fim + 'T00:00:00') : new Date();
    end.setHours(0, 0, 0, 0);
    return Math.round((end - start) / 86400000);
  }

  const stCor   = { afastado: '#b91c1c', transicao: '#c2410c', liberado: '#15803d' };
  const stBg    = { afastado: '#fee2e2', transicao: '#ffedd5', liberado: '#dcfce7' };
  const stLabel = { afastado: 'Afastado', transicao: 'Transição', liberado: 'Liberado' };

  // Calcula dias de afastamento para uma lesão (mesmo algoritmo do medical.html)
  function diasAfastadoReal(l) {
    const st  = statusOf(l);
    const dt  = dateOf(l);
    const alta = altaOf(l);
    if (!dt) return null;
    const inicio = new Date(dt + 'T00:00:00');
    let fim;
    if (st === 'liberado' || st === 'apto') {
      if (alta) {
        fim = new Date(alta + 'T00:00:00');
      } else {
        // fallback: updatedAt (igual ao medical.html)
        const upd = l.updatedAt;
        if (upd?.seconds)       fim = new Date(upd.seconds * 1000);
        else if (upd?.toDate)   fim = upd.toDate();
        else if (typeof upd === 'string') fim = new Date(upd);
        else                    fim = new Date();
      }
    } else {
      // afastado ou transicao: conta até hoje
      fim = new Date();
    }
    fim.setHours(0, 0, 0, 0);
    return Math.max(0, Math.round((fim - inicio) / 86400000));
  }

  // Soma TODOS os dias afastados (histórico completo — inclui múltiplas lesões)
  const totalDiasAfastado = lesoes.reduce((s, l) => s + (diasAfastadoReal(l) || 0), 0);
  const lesaoAtiva = lesoes.find(l => {
    const st = statusOf(l);
    return st === 'afastado' || st === 'transicao';
  });

  const contagemDor = {};
  _metricas28.forEach(r => {
    (r.pre?.regioes_dor || []).forEach(reg => {
      contagemDor[reg] = (contagemDor[reg] || 0) + 1;
    });
  });
  const totalMencoesDor = Object.values(contagemDor).reduce((s, v) => s + v, 0) || 1;
  const dorTop = Object.entries(contagemDor)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);

  // Card de resumo de afastamento
  const resumoAfastHTML = lesoes.length ? (() => {
    const diasAtual = lesaoAtiva ? diasAfastadoReal(lesaoAtiva) : null;
    const stAtiva   = lesaoAtiva ? statusOf(lesaoAtiva) : null;
    const bgTotal   = lesaoAtiva ? '#fee2e2' : '#f9fafb';
    const corTotal  = lesaoAtiva ? '#b91c1c' : '#374151';
    return `
      <div style="display:flex;gap:8px;margin-bottom:12px;">
        <div style="text-align:center;background:${bgTotal};border-radius:10px;padding:8px 10px;flex:1;">
          <p style="font-size:22px;font-weight:800;color:${corTotal};margin:0;">${diasAtual ?? totalDiasAfastado}</p>
          <p style="font-size:9px;color:#6b7280;margin:2px 0 0;text-transform:uppercase;">
            ${lesaoAtiva ? (stAtiva === 'transicao' ? 'Dias Afastado (Atual) · Transição' : 'Dias Afastado (Atual)') : 'Dias Perdidos (Total)'}
          </p>
        </div>
        <div style="text-align:center;background:#f9fafb;border-radius:10px;padding:8px 10px;flex:1;">
          <p style="font-size:22px;font-weight:800;color:#374151;margin:0;">${lesoes.length}</p>
          <p style="font-size:9px;color:#6b7280;margin:2px 0 0;text-transform:uppercase;">Lesão${lesoes.length !== 1 ? 'ões' : ''}</p>
        </div>
        ${lesaoAtiva && totalDiasAfastado > 0 ? `
        <div style="text-align:center;background:#f9fafb;border-radius:10px;padding:8px 10px;flex:1;">
          <p style="font-size:22px;font-weight:800;color:#374151;margin:0;">${totalDiasAfastado}</p>
          <p style="font-size:9px;color:#6b7280;margin:2px 0 0;text-transform:uppercase;">Total histórico</p>
        </div>` : ''}
      </div>`;
  })() : '';

  const lesaoHTML = lesoes.length
    ? lesoes.slice(0, 4).map(l => {
        const d     = l.dados || {};
        const st    = statusOf(l);
        const alta  = altaOf(l);
        const dt    = dateOf(l);
        const dc    = diasAfastadoReal(l);
        const ativa = st === 'afastado' || st === 'transicao';
        const previsto = d.diasAfastado || l.diasAfastado;
        return `
          <div style="padding:7px 8px;background:#fafafa;border-radius:8px;border:1px solid ${ativa ? stCor[st]+'44' : '#f3f4f6'};margin-bottom:5px;">
            <div style="display:flex;justify-content:space-between;gap:4px;margin-bottom:4px;">
              <span style="font-size:11px;font-weight:700;color:#111827;line-height:1.3;">${d.tipoLesao || l.tipoLesao || '—'}<br>
                <span style="font-weight:400;color:#6b7280;font-size:10px;">${d.regiao || l.regiao || ''}</span>
              </span>
              <span style="font-size:9px;font-weight:700;padding:2px 6px;border-radius:999px;white-space:nowrap;background:${stBg[st] || '#f9fafb'};color:${stCor[st] || '#6b7280'};">
                ${stLabel[st] || st}
              </span>
            </div>
            <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px;">
              <span style="font-size:10px;color:#9ca3af;">${dt || '—'}${alta ? ` → ${alta}` : ativa ? ' → hoje' : ''}</span>
              ${dc != null
                ? `<span style="font-size:12px;font-weight:800;color:${ativa ? stCor[st] : '#374151'};">${dc}d${!ativa && !alta && previsto ? ' (prev)' : ''}</span>`
                : previsto ? `<span style="font-size:12px;font-weight:800;color:#9ca3af;">${previsto}d prev</span>` : ''}
            </div>
          </div>`;
      }).join('')
    : `<p style="font-size:12px;color:#9ca3af;">Sem lesões.</p>`;

  const atendHTML = atendimentos.length
    ? atendimentos.slice(0, 5).map(a => {
        const d = a.dados || {};
        return `
          <div style="padding:5px 0;border-bottom:1px solid #f3f4f6;">
            <div style="display:flex;gap:6px;align-items:flex-start;">
              <span style="font-size:9px;color:#9ca3af;white-space:nowrap;margin-top:1px;">${dateOf(a) || '—'}</span>
              <div>
                <p style="font-size:11px;font-weight:600;color:#374151;margin:0;">${d.tipoAtendimento || '—'}</p>
                ${d.queixa ? `<p style="font-size:10px;color:#6b7280;margin:1px 0 0;">${d.queixa}</p>` : ''}
              </div>
            </div>
          </div>`;
      }).join('')
    : `<p style="font-size:12px;color:#9ca3af;">Sem atendimentos.</p>`;

  const dorHTML = dorTop.length ? `
    <div style="margin-top:14px;padding-top:12px;border-top:1px solid #f3f4f6;">
      <p style="font-size:9px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.05em;margin:0 0 8px;">
        Locais de Dor · últimos 28 dias
      </p>
      ${dorTop.map(([reg, cnt]) => {
        const pct = Math.round((cnt / totalMencoesDor) * 100);
        const cor = pct >= 50 ? '#b91c1c' : pct >= 25 ? '#c2410c' : '#f97316';
        return `
          <div style="margin-bottom:6px;">
            <div style="display:flex;justify-content:space-between;margin-bottom:2px;">
              <span style="font-size:10px;color:#374151;">${reg}</span>
              <span style="font-size:10px;font-weight:700;color:${cor};">${pct}%</span>
            </div>
            <div style="height:5px;background:#f3f4f6;border-radius:999px;overflow:hidden;">
              <div style="height:100%;width:${pct}%;background:${cor};border-radius:999px;"></div>
            </div>
          </div>`;
      }).join('')}
    </div>` : '';

  el.innerHTML = `
    ${resumoAfastHTML}
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
      <div>
        <p style="font-size:9px;font-weight:700;color:#ef4444;text-transform:uppercase;letter-spacing:.05em;margin:0 0 6px;">Lesões</p>
        ${lesaoHTML}
      </div>
      <div>
        <p style="font-size:9px;font-weight:700;color:#3b82f6;text-transform:uppercase;letter-spacing:.05em;margin:0 0 6px;">Atendimentos</p>
        ${atendHTML}
      </div>
    </div>
    ${dorHTML}`;
}

/* ═══════════════════════════════════════════════════════
   ABA AVALIAÇÕES
═══════════════════════════════════════════════════════ */
let _avalFisica      = null;
let _avalFuncional   = null;
let _avalPsicologica = null;
let _avalCarregada   = false;
let _avalRendered    = false;
let _chartAvalFis    = null;
let _chartAvalPsi    = null;

/* ── Tab switch ─────────────────────────────────────── */
window.switchTab = function(tab) {
  const monit   = document.getElementById('panelMonitoramento');
  const aval    = document.getElementById('panelAvaliacoes');
  const treinos = document.getElementById('panelTreinos');
  const btnM    = document.getElementById('tabBtnMonit');
  const btnA    = document.getElementById('tabBtnAval');
  const btnT    = document.getElementById('tabBtnTreinos');

  const setDisplay = (el, val) => { if (el) el.style.display = val; };
  const ativo = (btn, on) => {
    if (!btn) return;
    btn.style.color        = on ? '#1e3a5f' : '#9ca3af';
    btn.style.fontWeight   = on ? '700'     : '500';
    btn.style.borderBottom = on ? '2px solid #1e3a5f' : '2px solid transparent';
  };

  setDisplay(monit,   'none');
  setDisplay(aval,    'none');
  setDisplay(treinos, 'none');
  ativo(btnM, false); ativo(btnA, false); ativo(btnT, false);

  if (tab === 'monitoramento') {
    setDisplay(monit, 'grid');
    ativo(btnM, true);
  } else if (tab === 'avaliacoes') {
    setDisplay(aval, 'block');
    ativo(btnA, true);
    carregarAvaliacoes().then(() => { if (!_avalRendered) { _avalRendered = true; renderAvalTab(); } });
  } else if (tab === 'treinos') {
    setDisplay(treinos, 'block');
    ativo(btnT, true);
    carregarTreinos();
  }
};

/* ── Carrega assessments_functional por atleta ───────── */
async function carregarAvaliacoes() {
  if (_avalCarregada) return;
  _avalCarregada = true;
  const snap = await getDocs(query(
    collection(db, 'assessments_functional'),
    where('athleteId', '==', ATLETA_ID),
    where('clubId',    '==', CLUB_ID)
  ));
  snap.forEach(ds => {
    const f = ds.data();
    const d = f.date || '';
    if (f.tipo === 'fisica') {
      if (!_avalFisica || d > (_avalFisica.date || '')) _avalFisica = f;
    }
    if (f.meta?.origem === 'avaliacao_funcional') {
      if (!_avalFuncional || d > (_avalFuncional.date || '')) _avalFuncional = f;
    }
    if (f.instrumento === 'BFI-44') {
      if (!_avalPsicologica || d > (_avalPsicologica.date || '')) _avalPsicologica = f;
    }
  });
}

/* ── Classificações (espelho de perfil_elenco.js) ─────── */
function _cv(v) {
  if (v == null) return [null, 0];
  if (v <= 3.90) return ["Excelente", 95]; if (v <= 4.05) return ["Muito Bom", 80];
  if (v <= 4.20) return ["Bom", 65];       if (v <= 4.35) return ["Regular", 45];
  return ["Abaixo", 25];
}
function _ca(v) {
  if (v == null) return [null, 0];
  if (v <= 8.5) return ["Excelente", 95]; if (v <= 9.0) return ["Muito Bom", 80];
  if (v <= 9.5) return ["Bom", 65];       if (v <= 10.0) return ["Regular", 45];
  return ["Abaixo", 25];
}
function _cs(v) {
  if (v == null) return [null, 0];
  if (v > 290) return ["Excelente", 95]; if (v >= 270) return ["Muito Bom", 80];
  if (v >= 250) return ["Bom", 65];      if (v >= 230) return ["Regular", 45];
  return ["Abaixo", 25];
}
function _cy(v) {
  if (v == null) return [null, 0];
  if (v >= 20) return ["Excelente", 95]; if (v >= 18) return ["Muito Bom", 80];
  if (v >= 16) return ["Bom", 65];       if (v >= 14) return ["Regular", 45];
  return ["Abaixo", 25];
}
function _clsBadge(label) {
  if (!label) return '';
  const l = label.toLowerCase();
  const cor = (l === 'excelente' || l === 'muito bom') ? '#15803d:#dcfce7'
    : l === 'bom' ? '#4d7c0f:#ecfccb'
    : l === 'regular' ? '#b45309:#fef9c3'
    : '#b91c1c:#fee2e2';
  const [text, bg] = cor.split(':');
  return `<span style="display:inline-block;padding:2px 8px;border-radius:999px;font-size:10px;font-weight:700;background:${bg};color:${text};">${label}</span>`;
}
function _classMob(regiao, v) {
  if (v == null || v === '' || isNaN(Number(v))) return null;
  v = Number(v);
  if (regiao === 'Quadril')    { return v > 40 ? 'Baixa Rigidez' : v < 30 ? 'Alta Rigidez' : 'Normal'; }
  if (regiao === 'Tornozelo')  { return v > 42 ? 'Risco Baixo' : v >= 37 ? 'Risco Moderado' : 'Risco Alto'; }
  if (regiao === 'Posteriores'){ return v > 150 ? 'Risco Baixo' : v >= 130 ? 'Risco Moderado' : 'Risco Alto'; }
  return null;
}
function _classFlex(label) {
  if (!label) return null;
  const l = label.toLowerCase();
  if (l === 'normal') return 'Normal'; if (l === 'moderada') return 'Moderada'; if (l === 'alta') return 'Alta';
  return null;
}
function _mobBadge(label) {
  if (!label) return '<span style="color:#d1d5db;">—</span>';
  const l = label.toLowerCase();
  const cor = (l.includes('baixo') || l.includes('baixa') || l === 'normal') ? '#15803d:#dcfce7'
    : l.includes('moderado') ? '#b45309:#fef9c3'
    : '#b91c1c:#fee2e2';
  const [text, bg] = cor.split(':');
  return `<span style="display:inline-block;padding:2px 8px;border-radius:999px;font-size:10px;font-weight:700;background:${bg};color:${text};">${label}</span>`;
}
function _calcNavy(sexo, alt, pescoco, abdomen, quadril) {
  if (!alt || !pescoco) return null;
  const h = Number(alt), p = Number(pescoco);
  if (sexo === 'M') {
    if (!abdomen) return null;
    const ab = Number(abdomen);
    const gc = 495 / (1.0324 - 0.19077 * Math.log10(ab - p) + 0.15456 * Math.log10(h)) - 450;
    return isFinite(gc) && gc > 0 ? +gc.toFixed(1) : null;
  }
  if (sexo === 'F') {
    if (!abdomen || !quadril) return null;
    const ab = Number(abdomen), qd = Number(quadril);
    const gc = 495 / (1.29579 - 0.35004 * Math.log10(ab + qd - p) + 0.22100 * Math.log10(h)) - 450;
    return isFinite(gc) && gc > 0 ? +gc.toFixed(1) : null;
  }
  return null;
}
function _gcBadge(gc) {
  if (gc == null) return '<span style="color:#d1d5db;">—</span>';
  const [label, bg, text] = gc < 7 ? ['Atenção', '#fef9c3', '#b45309']
    : gc < 9  ? ['Ótimo', '#dcfce7', '#15803d']
    : gc <= 11 ? ['Bom', '#d1fae5', '#065f46']
    : ['Atenção', '#fef9c3', '#b45309'];
  return `<span style="display:inline-block;padding:2px 8px;border-radius:999px;font-size:10px;font-weight:700;background:${bg};color:${text};">${label}</span>`;
}

/* ── Render principal ─────────────────────────────────── */
function renderAvalTab() {
  renderAvalQ1();
  renderAvalQ2();
  renderAvalQ3();
  renderAvalQ4();
}

/* ── Q1 Antropometria ─────────────────────────────────── */
function renderAvalQ1() {
  const el = document.getElementById('avalQ1');
  if (!el) return;
  const f = _avalFisica;
  if (!f?.dados?.antropometria) {
    el.innerHTML = '<p style="font-size:13px;color:#9ca3af;">Sem avaliação registrada.</p>'; return;
  }
  const a = f.dados.antropometria;
  const peso = a.peso_kg ?? null;
  const alt  = a.estatura_cm ?? null;
  let gc = a.navy?.gc_calculado ?? a.gordura_percentual ?? null;
  let metodo = gc != null ? (a.navy?.gc_calculado != null ? 'Navy' : 'Manual') : null;
  if (gc == null && a.navy?.sexo) {
    gc = _calcNavy(a.navy.sexo, alt, a.navy.pescoco_cm, a.navy.abdomen_cm, a.navy.quadril_cm ?? null);
    if (gc != null) metodo = 'Navy·recalc';
  }
  let mm = a.massa_magra_kg ?? null, mg = a.massa_gorda_kg ?? null;
  if ((mm == null || mg == null) && gc != null && peso) {
    mm = +((1 - gc / 100) * peso).toFixed(1);
    mg = +(gc / 100 * peso).toFixed(1);
  }
  const imc = (peso && alt) ? (peso / ((alt / 100) ** 2)).toFixed(1) : null;
  const dataFmt = f.date ? f.date.split('-').reverse().join('/') : '—';

  const metrica = (label, val, unit = '') => `
    <div style="background:#f9fafb;border-radius:10px;padding:12px 14px;">
      <p style="font-size:9px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.05em;margin:0 0 4px;">${label}</p>
      <p style="font-size:20px;font-weight:800;color:#111827;margin:0;line-height:1;">${val != null ? val : '—'}<span style="font-size:11px;font-weight:500;color:#6b7280;margin-left:2px;">${val != null ? unit : ''}</span></p>
    </div>`;

  el.innerHTML = `
    <p style="font-size:10px;color:#9ca3af;margin:0 0 10px;">Última avaliação: <strong style="color:#374151;">${dataFmt}</strong></p>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px;">
      ${metrica('Estatura', alt, ' cm')}
      ${metrica('Peso', peso, ' kg')}
      ${metrica('IMC', imc, ' kg/m²')}
      ${metrica('Massa Magra', mm, ' kg')}
      ${metrica('Massa Gorda', mg, ' kg')}
      <div style="background:#f9fafb;border-radius:10px;padding:12px 14px;">
        <p style="font-size:9px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.05em;margin:0 0 4px;">% Gordura${metodo ? ` <span style="font-weight:400;text-transform:none;">(${metodo})</span>` : ''}</p>
        <p style="font-size:20px;font-weight:800;color:#111827;margin:0 0 4px;line-height:1;">${gc != null ? gc : '—'}<span style="font-size:11px;font-weight:500;color:#6b7280;margin-left:2px;">${gc != null ? '%' : ''}</span></p>
        ${_gcBadge(gc)}
      </div>
    </div>`;
}

/* ── Q2 Avaliação Física ──────────────────────────────── */
function renderAvalQ2() {
  const el = document.getElementById('avalQ2');
  if (!el) return;
  const f = _avalFisica;
  const d = f?.dados || {};
  const vel  = d.velocidade_30m    != null ? Number(d.velocidade_30m)    : null;
  const agil = d.agilidade_ttest   != null ? Number(d.agilidade_ttest)   : null;
  const salt = d.salto_horizontal  != null ? Number(d.salto_horizontal)  : null;
  const yoyo = d.yoyo              != null ? Number(d.yoyo)              : null;
  const temDados = [vel, agil, salt, yoyo].some(v => v != null);
  if (!temDados) {
    el.innerHTML = '<p style="font-size:13px;color:#9ca3af;">Sem avaliação registrada.</p>'; return;
  }
  const dataFmt = f?.date ? f.date.split('-').reverse().join('/') : '—';
  const [lVel,  sVel]  = _cv(vel);
  const [lAgil, sAgil] = _ca(agil);
  const [lSalt, sSalt] = _cs(salt);
  const [lYoyo, sYoyo] = _cy(yoyo);
  const barCor = s => s >= 80 ? '#22c55e' : s >= 60 ? '#86efac' : s >= 45 ? '#fbbf24' : '#f87171';

  const canvasId = 'canvasAvalFis';
  el.innerHTML = `
    <p style="font-size:10px;color:#9ca3af;margin:0 0 10px;">Última avaliação: <strong style="color:#374151;">${dataFmt}</strong></p>
    <div style="position:relative;height:150px;margin-bottom:14px;"><canvas id="${canvasId}"></canvas></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
      ${[
        ['Velocidade 30m', vel, 's', lVel, sVel],
        ['Agilidade T-Test', agil, 's', lAgil, sAgil],
        ['Salto Horizontal', salt, 'cm', lSalt, sSalt],
        ['Yo-Yo', yoyo, '', lYoyo, sYoyo],
      ].map(([label, val, unit, cls]) => `
        <div style="background:#f9fafb;border-radius:8px;padding:8px 10px;">
          <p style="font-size:9px;color:#9ca3af;text-transform:uppercase;margin:0 0 2px;">${label}</p>
          <p style="font-size:15px;font-weight:800;color:#111827;margin:0 0 4px;">${val != null ? val + unit : '—'}</p>
          ${_clsBadge(cls)}
        </div>`).join('')}
    </div>`;

  if (_chartAvalFis) { _chartAvalFis.destroy(); _chartAvalFis = null; }
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const scores = [sVel, sAgil, sSalt, sYoyo];
  const labels = ['Velocidade', 'Agilidade', 'Salto', 'Yo-Yo'];
  _chartAvalFis = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        data: scores.map(s => s || 0),
        backgroundColor: scores.map(s => barCor(s)),
        borderRadius: 6,
        borderSkipped: false,
      }],
    },
    options: {
      indexAxis: 'y',
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ` Score ${c.raw}/100` } } },
      scales: {
        x: { min: 0, max: 100, grid: { color: '#f3f4f6' }, ticks: { font: { size: 10 } } },
        y: { grid: { display: false }, ticks: { font: { size: 10 } } },
      },
    },
  });
}

/* ── Q3 Avaliação Funcional ───────────────────────────── */
function renderAvalQ3() {
  const el = document.getElementById('avalQ3');
  if (!el) return;
  const f = _avalFuncional;
  if (!f?.setores) {
    el.innerHTML = '<p style="font-size:13px;color:#9ca3af;">Sem avaliação registrada.</p>'; return;
  }
  const { forca = {}, mobilidade = {}, flexibilidade = {} } = f.setores;
  const dataFmt = f.date ? f.date.split('-').reverse().join('/') : '—';

  const qd = Number(forca.quad_dir), qe = Number(forca.quad_esq);
  const id = Number(forca.isq_dir),  ie = Number(forca.isq_esq);
  const assimQ = (qd && qe) ? ((Math.abs(qd - qe) / Math.max(qd, qe)) * 100).toFixed(1) : null;
  const assimI = (id && ie) ? ((Math.abs(id - ie) / Math.max(id, ie)) * 100).toFixed(1) : null;
  const iqD = (qd && id) ? ((id / qd) * 100).toFixed(1) : null;
  const iqE = (qe && ie) ? ((ie / qe) * 100).toFixed(1) : null;

  const secao = (titulo, rows) => `
    <div style="margin-bottom:12px;">
      <p style="font-size:9px;font-weight:700;color:#374151;text-transform:uppercase;letter-spacing:.06em;margin:0 0 6px;border-left:3px solid #3b82f6;padding-left:6px;">${titulo}</p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;">${rows}</div>
    </div>`;
  const lin = (label, val, badge) => `
    <div style="background:#f9fafb;border-radius:7px;padding:7px 9px;">
      <p style="font-size:9px;color:#9ca3af;margin:0 0 2px;">${label}</p>
      <p style="font-size:13px;font-weight:700;color:#111827;margin:0 0 3px;">${val ?? '—'}</p>
      ${badge || ''}
    </div>`;

  el.innerHTML = `
    <p style="font-size:10px;color:#9ca3af;margin:0 0 10px;">Última avaliação: <strong style="color:#374151;">${dataFmt}</strong></p>
    ${secao('Força & Assimetria', [
      lin('Assimétria Quad.', assimQ != null ? assimQ + '%' : null, _mobBadge(assimQ != null ? (assimQ < 10 ? 'Risco Baixo' : assimQ <= 15 ? 'Risco Moderado' : 'Risco Alto') : null)),
      lin('Assimétria Isq.', assimI != null ? assimI + '%' : null, _mobBadge(assimI != null ? (assimI < 10 ? 'Risco Baixo' : assimI <= 15 ? 'Risco Moderado' : 'Risco Alto') : null)),
      lin('Rel. I/Q Dir.', iqD != null ? iqD + '%' : null, _mobBadge(iqD != null ? (iqD >= 60 && iqD <= 80 ? 'Risco Baixo' : iqD >= 50 ? 'Risco Moderado' : 'Risco Alto') : null)),
      lin('Rel. I/Q Esq.', iqE != null ? iqE + '%' : null, _mobBadge(iqE != null ? (iqE >= 60 && iqE <= 80 ? 'Risco Baixo' : iqE >= 50 ? 'Risco Moderado' : 'Risco Alto') : null)),
    ].join(''))}
    ${secao('Mobilidade Articular', [
      lin('Quadril Dir.', mobilidade.quadril_dir != null ? mobilidade.quadril_dir + '°' : null, _mobBadge(_classMob('Quadril', mobilidade.quadril_dir))),
      lin('Quadril Esq.', mobilidade.quadril_esq != null ? mobilidade.quadril_esq + '°' : null, _mobBadge(_classMob('Quadril', mobilidade.quadril_esq))),
      lin('Tornozelo Dir.', mobilidade.tornozelo_dir != null ? mobilidade.tornozelo_dir + '°' : null, _mobBadge(_classMob('Tornozelo', mobilidade.tornozelo_dir))),
      lin('Tornozelo Esq.', mobilidade.tornozelo_esq != null ? mobilidade.tornozelo_esq + '°' : null, _mobBadge(_classMob('Tornozelo', mobilidade.tornozelo_esq))),
      lin('Posterior Dir.', mobilidade.posteriores_dir != null ? mobilidade.posteriores_dir + '°' : null, _mobBadge(_classMob('Posteriores', mobilidade.posteriores_dir))),
      lin('Posterior Esq.', mobilidade.posteriores_esq != null ? mobilidade.posteriores_esq + '°' : null, _mobBadge(_classMob('Posteriores', mobilidade.posteriores_esq))),
    ].join(''))}
    ${secao('Flexibilidade', [
      lin('Quadríceps Dir.', flexibilidade.quad_dir || null, _mobBadge(_classFlex(flexibilidade.quad_dir))),
      lin('Quadríceps Esq.', flexibilidade.quad_esq || null, _mobBadge(_classFlex(flexibilidade.quad_esq))),
      lin('Iliopsoas Dir.', flexibilidade.ilio_dir || null, _mobBadge(_classFlex(flexibilidade.ilio_dir))),
      lin('Iliopsoas Esq.', flexibilidade.ilio_esq || null, _mobBadge(_classFlex(flexibilidade.ilio_esq))),
    ].join(''))}`;
}

/* ── Q4 Avaliação Psicológica ─────────────────────────── */
function renderAvalQ4() {
  const el = document.getElementById('avalQ4');
  if (!el) return;
  const f = _avalPsicologica;
  if (!f?.dados) {
    el.innerHTML = '<p style="font-size:13px;color:#9ca3af;">Sem avaliação registrada.</p>'; return;
  }
  const d = f.dados;
  const dataFmt = f.date ? f.date.split('-').reverse().join('/') : '—';
  const dims = [
    { label: 'Extroversão',       val: d.extroversao          ?? null, cor: '#3b82f6' },
    { label: 'Amabilidade',       val: d.amabilidade          ?? null, cor: '#10b981' },
    { label: 'Conscienciosidade', val: d.conscienciosidade     ?? null, cor: '#8b5cf6' },
    { label: 'Estab. Emocional',  val: d.estabilidade_emocional ?? null, cor: '#f59e0b' },
    { label: 'Abertura',          val: d.abertura_experiencias ?? null, cor: '#ef4444' },
  ];

  function analisarPerfil(d) {
    if (d.conscienciosidade > 4 && d.estabilidade_emocional > 4) return 'Perfil competitivo estável e disciplinado.';
    if (d.extroversao > 4) return 'Perfil comunicativo com potencial de liderança.';
    if (d.estabilidade_emocional < 3) return 'Pode apresentar maior variabilidade emocional sob pressão.';
    return 'Perfil equilibrado.';
  }

  const canvasId = 'canvasAvalPsi';
  el.innerHTML = `
    <p style="font-size:10px;color:#9ca3af;margin:0 0 10px;">Última avaliação: <strong style="color:#374151;">${dataFmt}</strong></p>
    <div style="position:relative;height:200px;margin-bottom:14px;"><canvas id="${canvasId}"></canvas></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-bottom:10px;">
      ${dims.map(dim => `
        <div style="background:#f9fafb;border-radius:8px;padding:7px 10px;display:flex;align-items:center;gap:8px;">
          <div style="width:3px;height:28px;border-radius:2px;background:${dim.cor};flex-shrink:0;"></div>
          <div>
            <p style="font-size:9px;color:#9ca3af;margin:0;">${dim.label}</p>
            <p style="font-size:16px;font-weight:800;color:#111827;margin:0;line-height:1.1;">${dim.val != null ? dim.val.toFixed(2) : '—'}<span style="font-size:9px;font-weight:500;color:#9ca3af;">/5</span></p>
          </div>
        </div>`).join('')}
    </div>
    <div style="background:#eff6ff;border-radius:8px;padding:10px 12px;">
      <p style="font-size:9px;font-weight:700;color:#1d4ed8;text-transform:uppercase;letter-spacing:.05em;margin:0 0 3px;">Análise</p>
      <p style="font-size:12px;color:#1e40af;margin:0;">${analisarPerfil(d)}</p>
    </div>`;

  if (_chartAvalPsi) { _chartAvalPsi.destroy(); _chartAvalPsi = null; }
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  _chartAvalPsi = new Chart(canvas.getContext('2d'), {
    type: 'radar',
    data: {
      labels: dims.map(x => x.label),
      datasets: [{
        data: dims.map(x => x.val ?? 0),
        backgroundColor: 'rgba(59,130,246,0.15)',
        borderColor: '#3b82f6',
        borderWidth: 2,
        pointBackgroundColor: dims.map(x => x.cor),
        pointRadius: 4,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        r: {
          min: 0, max: 5,
          ticks: { stepSize: 1, font: { size: 9 }, backdropColor: 'transparent' },
          pointLabels: { font: { size: 10 } },
          grid: { color: '#e5e7eb' },
        },
      },
    },
  });
}

/* ─────────────────────────────────────
   HISTÓRICO DE TREINOS (Visão Mensal)
───────────────────────────────────── */
let _treinos        = null; // null = não carregado
let _treinoFiltroTipo    = '';
let _treinoMesAtual = new Date().getMonth();
let _treinoAnoAtual = new Date().getFullYear();

const _COR_TIPO_T  = { Campo:'#2563eb', 'Físico':'#059669', Complementar:'#7c3aed' };
const _BG_TIPO_T   = { Campo:'#dbeafe', 'Físico':'#dcfce7', Complementar:'#f3e8ff' };
const MESES_PT_T   = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
                      'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
const DIAS_SEM_T   = ['Seg','Ter','Qua','Qui','Sex','Sáb','Dom'];
const DIA_OFFSET_T = { Seg:0, Ter:1, Qua:2, Qui:3, Sex:4, 'Sáb':5, Dom:6 };

function _weekKeyToMonday(weekKey) {
  // weekKey = "S31-2026"
  const m = weekKey.match(/^S(\d+)-(\d{4})$/);
  if (!m) return null;
  const week = parseInt(m[1]), year = parseInt(m[2]);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const w1mon = new Date(jan4);
  w1mon.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() || 7) - 1));
  const mon = new Date(w1mon);
  mon.setUTCDate(w1mon.getUTCDate() + (week - 1) * 7);
  return mon;
}

async function carregarTreinos() {
  const lista = document.getElementById('treinoHistoricoLista');
  if (!lista) return;

  if (_treinos !== null) { renderTreinos(); return; }

  lista.innerHTML = '<p style="font-size:13px;color:#9ca3af;">Carregando...</p>';

  try {
    const snap = await getDocs(query(
      collection(db, 'assessments_planning'),
      where('clubId', '==', CLUB_ID)
    ));

    const sessoesAtleta = [];

    snap.docs.forEach(docSnap => {
      const data = docSnap.data();
      const weekKey = data.week || docSnap.id.split('_')[0];
      const sessions   = data.sessions   || data.plano || {};
      const gruposAtl  = data.gruposAtletas || {};

      const monday = _weekKeyToMonday(weekKey);
      if (!monday) return;

      DIAS_SEM_T.forEach((dia, i) => {
        const sessoesDia = sessions[dia];
        if (!Array.isArray(sessoesDia)) return;

        const dataDate = new Date(monday);
        dataDate.setUTCDate(monday.getUTCDate() + i);
        const dateStr = dataDate.toISOString().slice(0, 10);

        sessoesDia.forEach(s => {
          const grupoSessao = s.grupo || 'Geral';
          const idsGrupo = gruposAtl[grupoSessao] || [];
          if (!idsGrupo.includes(ATLETA_ID)) return;
          sessoesAtleta.push({ ...s, date: dateStr, diaSemana: dia, weekKey });
        });
      });
    });

    // Carregar jogos do atleta (scout_partidas)
    const snapPartidas = await getDocs(query(
      collection(db, 'scout_partidas'),
      where('clubId', '==', CLUB_ID)
    ));
    snapPartidas.docs.forEach(d => {
      const p = d.data();
      const raw = p.playedSeconds?.[ATLETA_ID];
      if (raw == null) return;
      const segs = typeof raw === 'object' ? (raw.seconds ?? 0) : (typeof raw === 'number' ? raw : 0);
      if (segs <= 0) return;
      let dateStr = p.data || '';
      if (dateStr?.toDate) dateStr = dateStr.toDate().toLocaleDateString('en-CA');
      sessoesAtleta.push({
        tipo: 'Jogo',
        date: dateStr,
        adversario: p.adversario || 'Jogo',
        minutos: Math.round(segs / 60),
        duracaoTotal: p.duracaoSegundos ? Math.round(p.duracaoSegundos / 60) : null,
      });
    });

    // ── Jogos do scout_partidas (com minutos reais) ──────────────────
    const datesNoScout = new Set();
    try {
      const snapPartidas = await getDocs(query(
        collection(db, 'scout_partidas'),
        where('clubId', '==', CLUB_ID)
      ));
      snapPartidas.docs.forEach(d => {
        const p = d.data();
        const raw = p.playedSeconds?.[ATLETA_ID];
        if (raw == null) return;
        const segs = typeof raw === 'object' ? (raw.seconds ?? 0) : (typeof raw === 'number' ? raw : 0);
        if (segs <= 0) return;
        let dateStr = p.data || '';
        if (dateStr?.toDate) dateStr = dateStr.toDate().toLocaleDateString('en-CA');
        datesNoScout.add(dateStr);
        sessoesAtleta.push({
          tipo: 'Jogo',
          date: dateStr,
          adversario: p.adversario || 'Jogo',
          minutos: Math.round(segs / 60),
          duracaoTotal: p.duracaoSegundos ? Math.round(p.duracaoSegundos / 60) : null,
          fonte: 'scout',
        });
      });
    } catch(e) { console.warn('scout_partidas:', e); }

    // ── Jogos do planejamento (fallback quando não há scout) ─────────
    snap.docs.forEach(docSnap => {
      const data = docSnap.data();
      const weekKey   = data.week || docSnap.id.split('_')[0];
      const gruposAtl = data.gruposAtletas || {};
      const jogos     = data.jogos || [];

      jogos.forEach(j => {
        if (!j.data) return;
        if (datesNoScout.has(j.data)) return; // já tem dado do scout
        const jogoGrups = Array.isArray(j.grupo) ? j.grupo : (j.grupo ? [j.grupo] : ['Geral']);
        const atletaNoGrupo = jogoGrups.some(g => (gruposAtl[g] || []).includes(ATLETA_ID));
        if (!atletaNoGrupo) return;
        sessoesAtleta.push({
          tipo: 'Jogo',
          date: j.data,
          adversario: j.adversario || 'Jogo',
          minutos: null,
          duracaoTotal: null,
          fonte: 'planejamento',
        });
      });
    });

    sessoesAtleta.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    _treinos = sessoesAtleta;
  } catch(e) {
    console.error('Erro ao carregar treinos:', e);
    _treinos = [];
  }

  // Wire filtros de tipo
  document.querySelectorAll('.btnTreinoFiltroTipo').forEach(btn => {
    btn.addEventListener('click', () => {
      _treinoFiltroTipo = btn.dataset.tipo;
      document.querySelectorAll('.btnTreinoFiltroTipo').forEach(b => {
        const on = b.dataset.tipo === _treinoFiltroTipo;
        b.style.background  = on ? '#3b82f6' : '#fff';
        b.style.color       = on ? '#fff'    : '#6b7280';
        b.style.borderColor = on ? '#3b82f6' : '#e5e7eb';
        b.style.fontWeight  = on ? '700'     : '600';
      });
      renderTreinos();
    });
  });

  // Wire navegação de mês
  document.getElementById('btnTreinoMesAnterior')?.addEventListener('click', () => {
    _treinoMesAtual--;
    if (_treinoMesAtual < 0) { _treinoMesAtual = 11; _treinoAnoAtual--; }
    renderTreinos();
  });
  document.getElementById('btnTreinoProxMes')?.addEventListener('click', () => {
    _treinoMesAtual++;
    if (_treinoMesAtual > 11) { _treinoMesAtual = 0; _treinoAnoAtual++; }
    renderTreinos();
  });

  renderTreinos();
}

function renderTreinos() {
  const lista = document.getElementById('treinoHistoricoLista');
  if (!lista || _treinos === null) return;

  // Atualiza label do mês
  const lblMes = document.getElementById('treinoMesLabel');
  if (lblMes) lblMes.textContent = `${MESES_PT_T[_treinoMesAtual]} ${_treinoAnoAtual}`;

  // Filtra por tipo e mês atual (jogos sempre aparecem, independente do filtro de tipo)
  const registros = _treinos.filter(t => {
    if (_treinoFiltroTipo && t.tipo !== 'Jogo' && t.tipo !== _treinoFiltroTipo) return false;
    if (!t.date) return false;
    const d = new Date(t.date + 'T12:00:00');
    return d.getMonth() === _treinoMesAtual && d.getFullYear() === _treinoAnoAtual;
  });

  // Indexa por dateStr
  const porData = {};
  registros.forEach(t => {
    if (!porData[t.date]) porData[t.date] = [];
    porData[t.date].push(t);
  });

  const ultimoDia = new Date(_treinoAnoAtual, _treinoMesAtual + 1, 0).getDate();
  const startDow  = (new Date(_treinoAnoAtual, _treinoMesAtual, 1).getDay() + 6) % 7; // 0=seg
  const numRows   = Math.ceil((startDow + ultimoDia) / 7);
  const hojeStr   = new Date().toLocaleDateString('en-CA');
  const totalTreinosMes = registros.length;

  const INT_COR = { Alta:'#dc2626', Moderada:'#d97706', Baixa:'#16a34a' };
  const INT_BG  = { Alta:'#fee2e2', Moderada:'#fef3c7', Baixa:'#dcfce7' };

  let html = `
  <div style="background:#fff;border-radius:12px;border:1px solid #e5e7eb;box-shadow:0 1px 4px rgba(0,0,0,.06);overflow:hidden;">
    <!-- Cabeçalho dos dias -->
    <div style="display:grid;grid-template-columns:repeat(7,1fr);border-bottom:2px solid #e5e7eb;background:#f8fafc;">
      ${['Seg','Ter','Qua','Qui','Sex','Sáb','Dom'].map(d =>
        `<div style="padding:8px 4px;text-align:center;font-size:10px;font-weight:800;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;">${d}</div>`
      ).join('')}
    </div>
    <!-- Grade de dias -->
    <div style="display:grid;grid-template-columns:repeat(7,1fr);">`;

  for (let pos = 0; pos < numRows * 7; pos++) {
    const dayNum = pos - startDow + 1;
    const inMonth = dayNum >= 1 && dayNum <= ultimoDia;

    if (!inMonth) {
      html += `<div style="min-height:80px;background:#fafafa;border-right:1px solid #f3f4f6;border-bottom:1px solid #f3f4f6;${pos%7===6?'border-right:none;':''}"></div>`;
      continue;
    }

    const dateStr = `${_treinoAnoAtual}-${String(_treinoMesAtual+1).padStart(2,'0')}-${String(dayNum).padStart(2,'0')}`;
    const isHoje  = dateStr === hojeStr;
    const sessoes = porData[dateStr] || [];
    const bgCell  = isHoje ? '#eff6ff' : '#fff';
    const borderR = pos % 7 === 6 ? 'border-right:none;' : 'border-right:1px solid #f0f0f0;';

    html += `<div style="min-height:80px;padding:5px 4px;vertical-align:top;background:${bgCell};border-bottom:1px solid #f0f0f0;${borderR}">`;
    html += `<div style="font-size:11px;font-weight:${isHoje?'800':'500'};color:${isHoje?'#2563eb':'#9ca3af'};margin-bottom:4px;${isHoje?'background:#dbeafe;display:inline-block;width:20px;height:20px;border-radius:50%;text-align:center;line-height:20px;font-size:10px;':''}">
      ${dayNum}
    </div>`;

    sessoes.forEach(s => {
      if (s.tipo === 'Jogo') {
        const durStr   = s.duracaoTotal ? `/${s.duracaoTotal}` : '';
        const minLabel = s.minutos != null
          ? `<div style="font-size:8px;color:#6b7280;margin-top:1px;">Tempo: <b style="color:#374151;">${s.minutos}${durStr} min</b></div>`
          : `<div style="font-size:8px;color:#9ca3af;margin-top:1px;font-style:italic;">Sem minutagem</div>`;
        html += `<div title="Jogo · ${s.adversario}${s.minutos != null ? ' · '+s.minutos+' min' : ''}" style="margin-bottom:3px;padding:3px 5px;border-radius:5px;background:#fee2e2;border-left:3px solid #dc2626;cursor:default;">
          <div style="font-size:9px;font-weight:700;color:#dc2626;text-transform:uppercase;letter-spacing:.02em;">⚽ Jogo</div>
          <div style="font-size:10px;font-weight:600;color:#374151;line-height:1.2;">${s.adversario}</div>
          ${minLabel}
        </div>`;
        return;
      }
      const tipoDisplay = s.tipo === 'Campo' ? 'Técnico' : (s.tipo || '');
      const bg  = _BG_TIPO_T[s.tipo]  || '#f3f4f6';
      const cor = _COR_TIPO_T[s.tipo] || '#6b7280';
      const lbl = s.atividade || tipoDisplay;
      const tooltip = [tipoDisplay, s.grupo, s.atividade, s.volume ? s.volume+' min' : '', s.intensidade].filter(Boolean).join(' · ');
      const metaLines = [];
      if (s.volume)      metaLines.push(`<span style="font-size:8px;color:#6b7280;">Tempo: <b style="color:#374151;">${s.volume} min</b></span>`);
      if (s.intensidade) metaLines.push(`<span style="font-size:8px;color:#6b7280;">Carga: <b style="color:${INT_COR[s.intensidade]||'#374151'};">${s.intensidade}</b></span>`);
      html += `<div title="${tooltip}" style="margin-bottom:3px;padding:3px 5px;border-radius:5px;background:${bg};border-left:3px solid ${cor};cursor:default;">
        <div style="font-size:9px;font-weight:700;color:${cor};text-transform:uppercase;letter-spacing:.02em;">${tipoDisplay}</div>
        <div style="font-size:10px;font-weight:600;color:#374151;line-height:1.2;">${lbl}</div>
        ${metaLines.length ? `<div style="display:flex;flex-direction:column;gap:1px;margin-top:2px;">${metaLines.join('')}</div>` : ''}
      </div>`;
    });

    html += `</div>`;
  }

  html += `</div></div>`;

  if (totalTreinosMes === 0) {
    html += `<p style="font-size:13px;color:#9ca3af;text-align:center;padding:20px 0;">Nenhum treino planejado neste mês.</p>`;
  }

  lista.innerHTML = html;
}

