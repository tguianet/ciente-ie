/**
 * nutricao.js — Módulo de Nutrição · Reposição & Suplementação
 * Pesagem pré/pós treino, risco de desidratação e protocolo coletivo do dia.
 */

import {
  collection, getDocs, query, where
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";
import { db } from "../core/firebase.js";

const HOJE = new Date().toLocaleDateString('en-CA');

// ── Microciclo (copiado do dashboard.js — leitura de localStorage) ──────────
function _getMicrocicloCtx() {
  const hoje = new Date();
  function getISOWeek(d) {
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
    const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    return Math.ceil((((t - y) / 86400000) + 1) / 7);
  }
  const semana = `S${getISOWeek(hoje)}-${hoje.getFullYear()}`;
  const clubId = JSON.parse(localStorage.getItem('userContext') || '{}').clubId || '';
  const raw = localStorage.getItem(`microciclo_${semana}_${clubId}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function _getMicrocicloManualDia(dateStr, clubId) {
  const raw = localStorage.getItem(`microciclo_dia_${dateStr}_${clubId}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function calcularDiaMicrociclo() {
  const clubId = JSON.parse(localStorage.getItem('userContext') || '{}').clubId || '';
  const manual = _getMicrocicloManualDia(HOJE, clubId);
  if (manual?.label) return manual;

  const ctx = _getMicrocicloCtx();
  if (!ctx) return null;

  const hoje = new Date(); hoje.setHours(0,0,0,0);
  const periodo = ctx.periodo || 'Preparação';

  function parseLocal(str) {
    const [y,m,d] = str.split('-').map(Number);
    return new Date(y, m-1, d);
  }
  function diffDias(a, b) { return Math.round((a - b) / 86400000); }

  const objs = {
    D1: { label:'D1', objetivo:'Reativação',    cor:'#3b82f6' },
    D2: { label:'D2', objetivo:'Sobrecarga I',  cor:'#f97316' },
    D3: { label:'D3', objetivo:'Sobrecarga II', cor:'#ef4444' },
    D4: { label:'D4', objetivo:'Dissipação',    cor:'#8b5cf6' },
    D5: { label:'D5', objetivo:'Potenciação',   cor:'#10b981' },
    D6: { label:'D6', objetivo:'Manutenção',    cor:'#6b7280' },
    D7: { label:'D7', objetivo:'Folga',         cor:'#9ca3af' },
  };

  if (ctx.jogoA) {
    const jogoA = parseLocal(ctx.jogoA);
    const jogoB = ctx.jogoB ? parseLocal(ctx.jogoB) : null;
    if (jogoB) {
      const dA = diffDias(hoje, jogoA), dB = diffDias(hoje, jogoB);
      if (dA === 0)  return { periodo, label:'Jogo A',    objetivo:'Competição',          cor:'#1d4ed8' };
      if (dB === 0)  return { periodo, label:'Jogo B',    objetivo:'Competição',          cor:'#1d4ed8' };
      if (dA === 1)  return { periodo, label:'MD+1',      objetivo:'Repouso ou Recovery', cor:'#8b5cf6' };
      if (dB === -1) return { periodo, label:'MD-1 (B)',  objetivo:'Ativação',            cor:'#10b981' };
      if (dB === -2) return { periodo, label:'MD-2 (B)',  objetivo:'Reativação',          cor:'#f59e0b' };
      return { periodo, label:'Semana dupla', objetivo:'Recuperação', cor:'#6b7280' };
    }
    const diff = diffDias(hoje, jogoA);
    const mapa = {
      '0':  { label:'MD0',  objetivo:'Competição',          cor:'#1d4ed8' },
      '1':  { label:'MD+1', objetivo:'Repouso ou Recovery', cor:'#8b5cf6' },
      '2':  { label:'MD+2', objetivo:'Regenerativo',        cor:'#7c3aed' },
      '3':  { label:'MD+3', objetivo:'Adaptação',           cor:'#6366f1' },
      '-3': { label:'MD-3', objetivo:'Potenciação',         cor:'#ef4444' },
      '-2': { label:'MD-2', objetivo:'Reconstrução',        cor:'#f97316' },
      '-1': { label:'MD-1', objetivo:'Ativação',            cor:'#10b981' },
    };
    if (diff <= -4) {
      const dow = hoje.getDay();
      if (dow === 1) return { periodo, ...objs.D1 };
      if (dow === 2) return { periodo, ...objs.D2 };
      if (dow === 3) return { periodo, ...objs.D3 };
    }
    return { periodo, ...(mapa[String(diff)] || { label:'—', objetivo:'Fora do microciclo', cor:'#9ca3af' }) };
  }

  if (periodo === 'Preparação' || periodo === 'Transição') {
    const diasSemana = ['D7','D1','D2','D3','D4','D5','D6'];
    return { periodo, ...(objs[diasSemana[hoje.getDay()]] || objs.D7) };
  }
  return { periodo, label:'—', objetivo:'Sem jogo cadastrado', cor:'#9ca3af' };
}

// ── Protocolo coletivo ───────────────────────────────────────────────────────
function getProtocolo(label) {
  const JOGO = {
    contexto: 'Dia de Jogo — protocolo de competição',
    corBorda: '#1d4ed8', corBg: '#eff6ff',
    fases: [
      { label: 'Antes · 3–4h', itens: [
        { nome: 'Carboidrato', dose: '3–4 g/kg' },
        { nome: 'Proteína leve', dose: '0,2 g/kg' },
        { nome: 'Hidratação pré', dose: '500 ml + 300 ml no aquecimento' },
      ]},
      { label: 'Durante', itens: [
        { nome: 'Isotônico / Gel CHO', dose: '30–60 g CHO/h' },
        { nome: 'Hidratação', dose: '150–250 ml a cada 15 min' },
      ]},
      { label: 'Depois · 0–2h', itens: [
        { nome: 'Whey Protein', dose: '0,3–0,4 g/kg' },
        { nome: 'Carboidrato', dose: '1 g/kg' },
        { nome: 'Eletrólitos', dose: 'Reposição de sódio' },
        { nome: 'Hidratação', dose: '150% da perda hídrica' },
      ]},
    ],
  };

  const RECOVERY_ALTO = {
    contexto: 'Pós-Jogo · Recuperação Máxima — ressíntese de glicogênio e reparo muscular',
    corBorda: '#8b5cf6', corBg: '#f5f3ff',
    fases: [
      { label: 'Ao acordar', itens: [
        { nome: 'Proteína de alto valor', dose: '0,4 g/kg' },
        { nome: 'Carboidrato integral', dose: '1–1,5 g/kg' },
        { nome: 'Hidratação', dose: '500 ml' },
      ]},
      { label: 'Pós-atividade leve', itens: [
        { nome: 'Shake ou fruta', dose: 'CHO moderado' },
        { nome: 'Hidratação', dose: 'Conforme sede + 20%' },
      ]},
      { label: 'Foco do dia', itens: [
        { nome: 'Anti-inflamatório natural', dose: 'Cúrcuma, gengibre, ômega-3' },
        { nome: 'Vitamina C, D, Zinco', dose: 'Micronutrientes de suporte' },
        { nome: 'Creatina', dose: '3–5 g' },
      ]},
    ],
  };

  const RECOVERY_MOD = {
    contexto: 'Recuperação Ativa — rehidratação e anti-inflamatórios',
    corBorda: '#7c3aed', corBg: '#f5f3ff',
    fases: [
      { label: 'Ao acordar', itens: [
        { nome: 'Proteína', dose: '0,3–0,4 g/kg' },
        { nome: 'Carboidrato moderado', dose: '1 g/kg' },
        { nome: 'Hidratação', dose: '500 ml' },
      ]},
      { label: 'Pós-atividade', itens: [
        { nome: 'Hidratação', dose: 'Conforme sede' },
        { nome: 'Whey Protein', dose: '0,3 g/kg' },
      ]},
      { label: 'Foco do dia', itens: [
        { nome: 'Anti-inflamatório natural', dose: 'Cúrcuma, gengibre, ômega-3' },
        { nome: 'Micronutrientes', dose: 'Vitamina C, D, Zinco' },
      ]},
    ],
  };

  const ALTA_CARGA = {
    contexto: 'Alta Carga — maior demanda energética e muscular da semana',
    corBorda: '#ef4444', corBg: '#fef2f2',
    fases: [
      { label: 'Antes · 1–2h', itens: [
        { nome: 'Carboidrato', dose: '1–2 g/kg' },
        { nome: 'Proteína leve', dose: '0,2 g/kg' },
        { nome: 'Hidratação', dose: '500 ml' },
      ]},
      { label: 'Durante', itens: [
        { nome: 'Isotônico', dose: '30–60 g CHO/h' },
        { nome: 'Hidratação', dose: '200–250 ml a cada 15 min' },
      ]},
      { label: 'Depois · 0–2h', itens: [
        { nome: 'Whey Protein', dose: '0,3–0,4 g/kg' },
        { nome: 'Carboidrato', dose: '1 g/kg' },
        { nome: 'Creatina', dose: '3–5 g/dia' },
        { nome: 'Hidratação', dose: '150% da perda hídrica' },
      ]},
    ],
  };

  const REATIVACAO = {
    contexto: 'Reativação — estímulo moderado, foco em carboidrato e proteína',
    corBorda: '#6366f1', corBg: '#eef2ff',
    fases: [
      { label: 'Antes · 1–2h', itens: [
        { nome: 'Carboidrato', dose: '0,5–1 g/kg' },
        { nome: 'Hidratação', dose: '400 ml' },
      ]},
      { label: 'Durante', itens: [
        { nome: 'Hidratação', dose: '150–200 ml a cada 15 min' },
        { nome: 'Isotônico (se >60 min)', dose: '30 g CHO/h' },
      ]},
      { label: 'Depois · 0–2h', itens: [
        { nome: 'Whey Protein', dose: '0,3 g/kg' },
        { nome: 'Carboidrato', dose: '0,8 g/kg' },
        { nome: 'Creatina', dose: '3–5 g/dia' },
      ]},
    ],
  };

  const PRECARGA = {
    contexto: 'Velocidade e qualidade de movimento — preservar reservas energéticas',
    corBorda: '#f97316', corBg: '#fff7ed',
    fases: [
      { label: 'Antes · 1–2h', itens: [
        { nome: 'Carboidrato', dose: '0,5–1 g/kg' },
        { nome: 'Hidratação', dose: '400 ml' },
      ]},
      { label: 'Durante', itens: [
        { nome: 'Isotônico (se >45 min)', dose: '20–30 g CHO/h' },
        { nome: 'Hidratação', dose: '150–200 ml a cada 15 min' },
      ]},
      { label: 'Depois', itens: [
        { nome: 'Whey Protein', dose: '0,3 g/kg' },
        { nome: 'Carboidrato', dose: '0,5 g/kg' },
        { nome: 'Hidratação', dose: '150% da perda hídrica' },
      ]},
    ],
  };

  const VESPERA = {
    contexto: 'Véspera de Jogo — recarga de glicogênio e hidratação progressiva',
    corBorda: '#10b981', corBg: '#f0fdf4',
    fases: [
      { label: 'Antes · 1h', itens: [
        { nome: 'Carboidrato (carb loading)', dose: '1–1,5 g/kg' },
        { nome: 'Hidratação progressiva', dose: '500 ml a cada 3h ao longo do dia' },
      ]},
      { label: 'Durante (treino leve)', itens: [
        { nome: 'Hidratação', dose: 'Conforme sede' },
        { nome: 'Isotônico', dose: 'Opcional' },
      ]},
      { label: 'Depois', itens: [
        { nome: 'Whey Protein', dose: '0,25 g/kg' },
        { nome: 'Carboidrato', dose: '0,8 g/kg' },
        { nome: 'Hidratação (antes de dormir)', dose: '400 ml' },
      ]},
    ],
  };

  const FOLGA = {
    contexto: 'Folga — alimentação balanceada, sem protocolo de performance',
    corBorda: '#9ca3af', corBg: '#f9fafb',
    fases: [
      { label: 'Foco do dia', itens: [
        { nome: 'Alimentação balanceada', dose: 'Variedade de macro e micronutrientes' },
        { nome: 'Anti-inflamatórios', dose: 'Frutas, vegetais, ômega-3' },
        { nome: 'Hidratação', dose: '35–40 ml/kg/dia' },
      ]},
      { label: 'Suplementação de base', itens: [
        { nome: 'Creatina (se em uso)', dose: '3–5 g/dia' },
        { nome: 'Vitamina D', dose: 'Conforme exame' },
      ]},
      { label: 'Evitar', itens: [
        { nome: 'Álcool', dose: 'Compromete recuperação muscular' },
        { nome: 'Excesso de gordura saturada', dose: 'Aumenta inflamação' },
      ]},
    ],
  };

  const mapa = {
    'MD0': JOGO, 'Jogo A': JOGO, 'Jogo B': JOGO,
    'MD+1': RECOVERY_ALTO,
    'MD+2': RECOVERY_MOD,
    'MD+3': REATIVACAO,
    'MD-1': VESPERA, 'MD-1 (B)': VESPERA,
    'MD-2': PRECARGA, 'MD-2 (B)': PRECARGA,
    'MD-3': ALTA_CARGA, 'MD-4': ALTA_CARGA,
    'Semana dupla': RECOVERY_MOD,
    'D1': REATIVACAO,
    'D2': ALTA_CARGA,
    'D3': ALTA_CARGA,
    'D4': RECOVERY_MOD,
    'D5': VESPERA,
    'D6': ALTA_CARGA,
    'D7': FOLGA,
  };
  return mapa[label] || null;
}

// ── Cálculo de risco de desidratação ────────────────────────────────────────
function calcRisco(pre, pos) {
  if (!pre || !pos || pre <= 0) return null;
  const perdaAbs = pre - pos;
  const perdaRel = (perdaAbs / pre) * 100;
  const reposicao = perdaAbs * 1.5;
  let risco;
  if (perdaRel < 2)      risco = 'Normal';
  else if (perdaRel < 3) risco = 'Atenção';
  else                   risco = 'Alerta';

  // Recomendação baseada em guidelines ACSM/ISSN/IOC
  // Base sempre é água; isotônico/soro entram como complemento conforme a magnitude da perda.
  const volFmt = reposicao.toFixed(1);
  let recomendacao;
  if (perdaRel < 1) {
    recomendacao = {
      liquido: 'Água',
      detalhe: `${volFmt} L de água. Perdas abaixo de 1% não exigem reposição de eletrólitos.`,
    };
  } else if (perdaRel < 2) {
    recomendacao = {
      liquido: 'Água + sódio',
      detalhe: `${volFmt} L — principalmente água, com pitada de sal ou alimento salgado na refeição. O sódio favorece a retenção hídrica.`,
    };
  } else if (perdaRel < 3) {
    recomendacao = {
      liquido: 'Água + isotônico',
      detalhe: `${volFmt} L — alternar água com isotônico (6–8% CHO + sódio) ao longo das 4h para repor eletrólitos e carboidrato.`,
    };
  } else {
    recomendacao = {
      liquido: 'Água + isotônico + soro oral',
      detalhe: `${volFmt} L — água + isotônico + soro de reidratação oral. Monitorar cor da urina (deve ficar amarelo claro). Comunicar ao staff médico.`,
    };
  }

  return { perdaAbs, perdaRel, reposicao, risco, recomendacao };
}

// ── Estado global ────────────────────────────────────────────────────────────
let _atletas = [];
let _pesosMap = {};  // athleteId → { pesoPreTreino, pesoPosTreino }
let _filtCat = '';

// ── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  // Data formatada no cabeçalho
  const hoje = new Date();
  const dataFmt = hoje.toLocaleDateString('pt-BR', { weekday:'long', day:'2-digit', month:'long', year:'numeric' });
  document.getElementById('dataHoje').textContent = dataFmt.charAt(0).toUpperCase() + dataFmt.slice(1);

  // Microciclo badge
  const mc = calcularDiaMicrociclo();
  if (mc) {
    document.getElementById('mcBadge').innerHTML =
      `<span style="display:inline-block;font-size:13px;font-weight:800;background:${mc.cor};color:#fff;padding:5px 14px;border-radius:12px;">${mc.label}</span>
       <span class="text-sm text-gray-500 ml-2">${mc.objetivo}</span>`;
  }

  // Protocolo do dia
  renderProtocolo(mc);

  // Carregar atletas e dados de hoje
  const uc = JSON.parse(localStorage.getItem('userContext') || '{}');
  const clubId = uc.clubId;
  if (!clubId) return;

  try {
    // Atletas ativos
    const qA = query(collection(db, 'athletes'), where('clubId','==', clubId), where('ativo','==', true));
    const snapA = await getDocs(qA);
    _atletas = snapA.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a,b) => (a.nome||'').localeCompare(b.nome||'', 'pt-BR'));

    // daily_metrics de hoje — lê pesoPreTreino (bloco pre) e pesoPosTreino (bloco post)
    const qM = query(collection(db, 'daily_metrics'), where('clubId','==', clubId), where('date','==', HOJE));
    const snapM = await getDocs(qM);
    snapM.forEach(d => {
      const data = d.data();
      const id   = data.athleteId;
      if (!id) return;
      if (!_pesosMap[id]) _pesosMap[id] = {};
      if (data.pre?.pesoPreTreino  != null) _pesosMap[id].pesoPreTreino  = data.pre.pesoPreTreino;
      if (data.post?.pesoPosTreino != null) _pesosMap[id].pesoPosTreino  = data.post.pesoPosTreino;
    });

    // Popular filtro de categoria
    const cats = [...new Set(_atletas.map(a => a.categoria).filter(Boolean))].sort();
    const sel = document.getElementById('filtroCat');
    cats.forEach(c => { const o = document.createElement('option'); o.value = c; o.textContent = c; sel.appendChild(o); });
    sel.addEventListener('change', () => { _filtCat = sel.value; renderTabela(); });

    renderTabela();
  } catch(e) {
    console.error('Erro ao carregar atletas:', e);
    document.getElementById('tabelaContainer').innerHTML =
      '<p class="text-center text-red-500 py-10 text-sm">Erro ao carregar dados.</p>';
  }
}

// ── Renderiza protocolo do dia ───────────────────────────────────────────────
function renderProtocolo(mc) {
  const panel = document.getElementById('protocoloPanel');
  if (!mc || !mc.label) {
    panel.innerHTML = `<p class="text-sm text-gray-400">Microciclo não configurado — acesse o Planejamento para definir a semana.</p>`;
    return;
  }

  const proto = getProtocolo(mc.label);
  if (!proto) {
    panel.innerHTML = `<p class="text-sm text-gray-400">Nenhum protocolo definido para "${mc.label}".</p>`;
    return;
  }

  const fasesHtml = proto.fases.map(f => `
    <div style="border:1px solid ${proto.corBorda}33;border-radius:10px;padding:12px 14px;background:#fff;">
      <p style="font-size:10px;font-weight:700;color:${proto.corBorda};text-transform:uppercase;letter-spacing:.07em;margin:0 0 8px;">${f.label}</p>
      ${f.itens.map(item => `
        <div style="display:flex;justify-content:space-between;align-items:baseline;padding:5px 0;border-top:1px solid #f3f4f6;font-size:12.5px;">
          <span style="color:#374151;">${item.nome}</span>
          <span style="font-family:monospace;color:${proto.corBorda};font-size:11.5px;font-weight:600;">${item.dose}</span>
        </div>`).join('')}
    </div>`).join('');

  panel.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap;">
      <p style="font-size:12px;font-weight:700;color:#374151;margin:0;">Protocolo coletivo do dia</p>
      <span style="font-size:11px;color:#6b7280;">${proto.contexto}</span>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;">
      ${fasesHtml}
    </div>`;
}

// ── Renderiza tabela de atletas ──────────────────────────────────────────────
function renderTabela() {
  const filtrados = _filtCat
    ? _atletas.filter(a => a.categoria === _filtCat)
    : _atletas;

  document.getElementById('contadorAtletas').textContent =
    `${filtrados.length} atleta${filtrados.length !== 1 ? 's' : ''}`;

  if (!filtrados.length) {
    document.getElementById('tabelaContainer').innerHTML =
      '<p class="text-center text-gray-400 py-10 text-sm">Nenhum atleta encontrado.</p>';
    return;
  }

  const sem_pre  = filtrados.filter(a => !_pesosMap[a.id]?.pesoPreTreino).length;
  const sem_pos  = filtrados.filter(a => !_pesosMap[a.id]?.pesoPosTreino).length;
  const avisoHtml = (sem_pre > 0 || sem_pos > 0)
    ? `<p class="text-xs text-amber-600 mb-3">
        ${sem_pre > 0 ? `<strong>${sem_pre}</strong> atleta(s) sem peso pré · ` : ''}
        ${sem_pos > 0 ? `<strong>${sem_pos}</strong> atleta(s) sem peso pós` : ''}
        — pesos preenchidos pelos próprios atletas nas coletas.
      </p>`
    : '';

  const linhas = filtrados.map(a => {
    const p   = _pesosMap[a.id] || {};
    const pre = p.pesoPreTreino  ?? null;
    const pos = p.pesoPosTreino  ?? null;
    const risco = (pre != null && pos != null) ? calcRisco(pre, pos) : null;
    const iniciais = (a.nome || '?').split(' ').map(n => n[0]).join('').slice(0,2).toUpperCase();
    const avatar = a.fotoUrl
      ? `<img src="${a.fotoUrl}" class="w-8 h-8 rounded-full object-cover flex-shrink-0" alt="" />`
      : `<div class="w-8 h-8 rounded-full bg-slate-700 text-white flex items-center justify-center text-xs font-bold flex-shrink-0">${iniciais}</div>`;

    const celPre = pre != null
      ? `<span class="font-mono text-sm text-gray-800">${pre.toFixed(1)} kg</span>`
      : `<span class="text-xs text-gray-300">Aguardando</span>`;
    const celPos = pos != null
      ? `<span class="font-mono text-sm text-gray-800">${pos.toFixed(1)} kg</span>`
      : `<span class="text-xs text-gray-300">Aguardando</span>`;

    return `
    <tr class="border-b border-gray-100 hover:bg-gray-50">
      <td class="px-4 py-3">
        <div class="flex items-center gap-3">
          ${avatar}
          <div>
            <p class="text-sm font-semibold text-gray-900 leading-tight">${a.nome || '—'}</p>
            <p class="text-xs text-gray-400">${a.posicao || ''}${a.categoria ? ' · ' + a.categoria : ''}</p>
          </div>
        </div>
      </td>
      <td class="px-4 py-3">${celPre}</td>
      <td class="px-4 py-3">${celPos}</td>
      <td class="px-4 py-3 text-sm font-mono text-gray-700">${risco ? `${risco.perdaAbs.toFixed(1)} kg · ${risco.perdaRel.toFixed(1)}%` : '<span class="text-gray-300">—</span>'}</td>
      <td class="px-4 py-3">${risco
        ? `<div>
             <span class="font-mono text-sm font-bold" style="color:#1d4ed8;">${risco.reposicao.toFixed(1)} L</span>
             <span class="text-xs font-semibold text-gray-500 ml-1">· ${risco.recomendacao.liquido}</span>
             <p class="text-xs text-gray-400 mt-0.5 leading-snug max-w-[220px]">${risco.recomendacao.detalhe}</p>
           </div>`
        : '<span class="text-gray-300">—</span>'
      }</td>
      <td class="px-4 py-3">${risco ? _riscoPill(risco.risco) : '<span class="text-gray-300 text-xs">—</span>'}</td>
    </tr>`;
  }).join('');

  document.getElementById('tabelaContainer').innerHTML = `
    ${avisoHtml}
    <table class="w-full min-w-[640px]">
      <thead>
        <tr class="border-b border-gray-200 bg-gray-50">
          <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Atleta</th>
          <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Peso pré</th>
          <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Peso pós</th>
          <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Perda hídrica</th>
          <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Repor (4h)</th>
          <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Risco</th>
        </tr>
      </thead>
      <tbody>${linhas}</tbody>
    </table>`;
}

function _riscoPill(risco) {
  const map = {
    Normal:  { bg:'#f0fdf4', color:'#16a34a', border:'#bbf7d0' },
    Atenção: { bg:'#fffbeb', color:'#d97706', border:'#fde68a' },
    Alerta:  { bg:'#fef2f2', color:'#dc2626', border:'#fecaca' },
  };
  const s = map[risco] || map.Normal;
  return `<span style="display:inline-block;font-size:11px;font-weight:700;background:${s.bg};color:${s.color};border:1px solid ${s.border};padding:2px 10px;border-radius:999px;">${risco}</span>`;
}


// ── Start ────────────────────────────────────────────────────────────────────
init();
