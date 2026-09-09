// apps/core/briefing_engine.js
// Briefing Pré-Treino — Modelo Ciente
//
// Calcula a prescrição coletiva da sessão de campo cruzando:
//   dia do microciclo (envelope-base) × capacidade coletiva (modificador)
//
// Roda client-side, on-demand (sem persistência).
// Consumidores: modal no dashboard e seção no PDF Status Diário.

// ── Envelope-base por dia do microciclo ──────────────────────────────────────
// Valores da spec (seção 2). Dias D1-D6: período Preparação/Transição.
// veloc / cod usam nível base ('Alta' | 'Moderada' | 'Baixa') — dots calculados
// dinamicamente cruzando nível × capacidade coletiva.
// duracaoMinFloor: duração mínima em minutos que o modificador de capacidade não pode
// ultrapassar para baixo (evita sessões inviáveis em dias regenerativos).
// Referências para os envelopes:
// – Buchheit & Laursen (2013) Sports Med: ratios e duração de intervalos em futebol
// – Malone et al. (2017) IJSPP: HSR semanal como % do jogo por dia do microciclo
// – Owen et al. (2017) J Strength Cond Res: periodização semanal em futebol profissional
// – Nédélec et al. (2013) Sports Med: protocolos de recuperação pós-jogo
// – Akenhead & Nassis (2016) IJSPP: monitoramento de carga em elite
//
// Alta intensidade como % do volume total da sessão (excl. aquecimento/resfriamento):
//   MD+1/MD+2 rec.: 0%    — recuperação ativa, sem estímulo de alta
//   MD+3/D1:       ~15–20% — transição/reativação
//   MD-4/D2:       ~20–28% — desenvolvimento (20-30% per user spec; sem componente de pressão do jogo)
//   MD-3/D3:       ~25–32% — pico de carga semanal
//   MD-2/D4/D6:    ~15–20% — tapering/manutenção
//   MD-1/D5:        0–10%  — ativação + priming opcional pré-jogo
//
// cargaUA ≈ RPE-sessão × duração (UA); jogo ref. ≈ 650–750 UA (RPE 7-8 × 90 min)
const ENVELOPE = {
  // ── Microciclo competitivo ────────────────────────────────────────────────
  // MD+1: recuperação aguda. Nédélec et al. → 20-30 min, Z1-Z2, sem alta intensidade.
  'MD+1': { nome: 'Regenerativo (pós-jogo)', duracao: [20,30], alta: [0,0],   modBaixo: [17,26], cargaUA: [60,110],  veloc: 'Baixa',    cod: 'Baixa',    duracaoMinFloor: 18, pse_alvo: [3,4] },
  // MD+2: segunda janela de recuperação. Ligeira progressão, ainda sem alta intensidade.
  'MD+2': { nome: 'Regenerativo',            duracao: [25,35], alta: [0,0],   modBaixo: [21,30], cargaUA: [80,150],  veloc: 'Baixa',    cod: 'Baixa',    duracaoMinFloor: 22, pse_alvo: [3,5] },
  // MD+3: transição. ~15-20% alta → 8-12 min em 50-55 min. Malone: ~25-35% HSR do jogo.
  // cargaUA: PSE-sessão esperado 4.5–7 × 45–55 min → [200,380]. Teto elevado pois
  // exposição a velocidade/COD empurra PSE para 6-7 nos blocos de alta int.
  'MD+3': { nome: 'Transição',               duracao: [45,55], alta: [8,12],  modBaixo: [35,42], cargaUA: [200,380], veloc: 'Moderada', cod: 'Moderada',                       pse_alvo: [5,6] },
  // MD-4: desenvolvimento. 20-28% alta → 12-18 min em 55-65 min. Malone: ~35-50% HSR.
  'MD-4': { nome: 'Desenvolvimento',         duracao: [55,65], alta: [12,18], modBaixo: [38,46], cargaUA: [300,420], veloc: 'Moderada', cod: 'Moderada',                       pse_alvo: [5,7] },
  // MD-3: pico. 25-32% alta → 16-22 min em 60-65 min. Owen: ~50-70% HSR do jogo.
  'MD-3': { nome: 'Pico de carga',           duracao: [60,65], alta: [16,22], modBaixo: [38,42], cargaUA: [440,540], veloc: 'Alta',     cod: 'Alta',                           pse_alvo: [6,8] },
  // MD-2: tapering. Reduz volume ~25% vs MD-3, mantém alguma intensidade (Akenhead).
  'MD-2': { nome: 'Tapering · redução',      duracao: [45,55], alta: [8,12],  modBaixo: [32,40], cargaUA: [220,320], veloc: 'Moderada', cod: 'Moderada',                       pse_alvo: [5,6] },
  // MD-1: ativação. Curta, priming neuromuscular opcional (Ramírez-Campillo et al. PAP).
  'MD-1': { nome: 'Ativação final',          duracao: [25,35], alta: [0,5],   modBaixo: [20,28], cargaUA: [80,140],  veloc: 'Baixa',    cod: 'Baixa',    duracaoMinFloor: 22, pse_alvo: [4,6] },
  // ── Semana sem jogo (D1-D6) — espelha estrutura MD com progressão D1→D3→D5 ──
  'D1':   { nome: 'Reativação',              duracao: [40,50], alta: [8,12],  modBaixo: [30,38], cargaUA: [180,340], veloc: 'Moderada', cod: 'Moderada',                       pse_alvo: [5,6] },
  'D2':   { nome: 'Sobrecarga I',            duracao: [55,65], alta: [12,18], modBaixo: [38,46], cargaUA: [300,420], veloc: 'Moderada', cod: 'Moderada',                       pse_alvo: [5,7] },
  'D3':   { nome: 'Sobrecarga II · pico',    duracao: [60,65], alta: [16,22], modBaixo: [38,42], cargaUA: [440,540], veloc: 'Alta',     cod: 'Alta',                           pse_alvo: [6,8] },
  'D4':   { nome: 'Dissipação',              duracao: [45,55], alta: [8,12],  modBaixo: [32,40], cargaUA: [220,320], veloc: 'Moderada', cod: 'Moderada',                       pse_alvo: [5,6] },
  'D5':   { nome: 'Potenciação',             duracao: [25,35], alta: [0,5],   modBaixo: [20,28], cargaUA: [80,140],  veloc: 'Baixa',    cod: 'Baixa',    duracaoMinFloor: 20,  pse_alvo: [4,6] },
  'D6':   { nome: 'Manutenção',              duracao: [45,55], alta: [8,14],  modBaixo: [30,40], cargaUA: [220,320], veloc: 'Moderada', cod: 'Moderada',                       pse_alvo: [5,6] },
};

// ── Envelope de estímulo para não-jogadores em MD+1 / MD+2 ──────────────────
// Atletas com < 60 min no jogo não acumularam carga de jogo e precisam de
// estímulo moderado para não perder adaptação. Esses envelopes são usados para
// gerar a prescrição do "Grupo Estímulo" paralela à prescrição regenerativa.
const ENVELOPE_ESTIMULO = {
  // MD+1 não-jogadores: equivalente a MD+3 (transição) — 15-20% alta em 45-55 min
  'MD+1': { duracao: [45,55], alta: [8,12],  modBaixo: [35,42], cargaUA: [200,380], veloc: 'Moderada', cod: 'Moderada', pse_alvo: [5,6] },
  // MD+2 não-jogadores: equivalente a MD-4 (desenvolvimento) — 20-28% alta em 55-65 min
  // User spec: 20-30% alta com blocos de 10-20 min
  'MD+2': { duracao: [55,65], alta: [12,18], modBaixo: [38,46], cargaUA: [300,420], veloc: 'Moderada', cod: 'Moderada', pse_alvo: [5,7] },
};

// ── Estrutura de blocos por zona de intensidade ───────────────────────────────
// Formato split: { alta?, modBaixo?, nota? }
// Duração total = aquecimento + blocos + pausas entre blocos + resfriamento.
// As notas abaixo detalham o aquecimento/resfriamento incluído no envelope.
// Ratios (esforço:pausa) por referência Buchheit & Laursen (2013):
//   Alta intensidade (HIIT long intervals): 3:1 a 4:1
//   Moderada/baixa (aeróbico extensivo):    2:1
//   Recuperativa:                           1:2 a 1:3
//
// Blocos de alta: 10-20 min por bloco (per user spec, consistent com long interval HIIT)
// Dias de desenvolvimento/pico: 1 bloco longo de 12-20 min (acúmulo metabólico contínuo)
// Dias de transição/tapering: blocos menores 8-12 min
// Priming MD-1/D5: séries curtas opcionais para PAP pré-jogo

const BLOCOS_BASE = {
  // Recuperação: sem alta intensidade
  'MD+1': {
    modBaixo: { formato: '2 séries de 6–8 min',       ratio: '1:3 (esforço:pausa)' },
    nota: 'Sem alta intensidade. Aquecimento ~5 min · resfriamento ~3 min',
  },
  'MD+2': {
    modBaixo: { formato: '2 blocos leves de 8–10 min', ratio: '1:2 (esforço:pausa)' },
    nota: 'Sem alta intensidade. Aquecimento ~5 min · resfriamento ~3 min',
  },
  // Transição e reativação
  'MD+3': {
    alta:     { formato: '1 bloco de 8–12 min',        ratio: '3:1 (esforço:pausa)' },
    modBaixo: { formato: '2 blocos de 10–15 min',      ratio: '2:1 (esforço:pausa)' },
    nota: 'Aquecimento ~10 min · resfriamento ~5 min',
  },
  'D1': {
    alta:     { formato: '1 bloco de 8–12 min',        ratio: '3:1 (esforço:pausa)' },
    modBaixo: { formato: '2 blocos de 10–14 min',      ratio: '2:1 (esforço:pausa)' },
    nota: 'Aquecimento ~8 min · resfriamento ~5 min',
  },
  // Desenvolvimento: 1 bloco longo (10-20 min) para acúmulo metabólico contínuo
  'MD-4': {
    alta:     { formato: '1 bloco de 12–18 min',       ratio: '3:1 (esforço:pausa)' },
    modBaixo: { formato: '2 blocos de 10–14 min',      ratio: '2:1 (esforço:pausa)' },
    nota: 'Aquecimento ~10 min · resfriamento ~5 min',
  },
  'D2': {
    alta:     { formato: '1 bloco de 12–18 min',       ratio: '3:1 (esforço:pausa)' },
    modBaixo: { formato: '2 blocos de 10–14 min',      ratio: '2:1 (esforço:pausa)' },
    nota: 'Aquecimento ~10 min · resfriamento ~5 min',
  },
  // Pico: blocos longos (15-20 min), máximo de HSR semanal
  'MD-3': {
    alta:     { formato: '1–2 blocos de 15–20 min',    ratio: '4:1 (esforço:pausa)' },
    modBaixo: { formato: '1 bloco de 10–14 min',       ratio: '2:1 (esforço:pausa)' },
    nota: 'Aquecimento ~10 min · resfriamento ~5 min',
  },
  'D3': {
    alta:     { formato: '1–2 blocos de 15–20 min',    ratio: '4:1 (esforço:pausa)' },
    modBaixo: { formato: '1 bloco de 10–14 min',       ratio: '2:1 (esforço:pausa)' },
    nota: 'Aquecimento ~10 min · resfriamento ~5 min',
  },
  // Tapering e manutenção: volume reduzido, alguma intensidade mantida
  'MD-2': {
    alta:     { formato: '1 bloco de 8–12 min',        ratio: '3:1 (esforço:pausa)' },
    modBaixo: { formato: '2 blocos de 8–12 min',       ratio: '2:1 (esforço:pausa)' },
    nota: 'Aquecimento ~8 min · resfriamento ~5 min',
  },
  'D4': {
    alta:     { formato: '1 bloco de 8–12 min',        ratio: '3:1 (esforço:pausa)' },
    modBaixo: { formato: '2 blocos de 8–12 min',       ratio: '2:1 (esforço:pausa)' },
    nota: 'Aquecimento ~8 min · resfriamento ~5 min',
  },
  'D6': {
    alta:     { formato: '1 bloco de 8–12 min',        ratio: '3:1 (esforço:pausa)' },
    modBaixo: { formato: '2 blocos de 8–12 min',       ratio: '2:1 (esforço:pausa)' },
    nota: 'Aquecimento ~8 min · resfriamento ~5 min',
  },
  // Ativação pré-jogo: priming opcional + blocos de baixa intensidade
  'MD-1': {
    alta:     { formato: '1–2 séries de priming de 3–5 min', ratio: '3:1 (esforço:pausa)', opcional: true },
    modBaixo: { formato: '2 blocos de ativação de 8–10 min', ratio: '2:1 (esforço:pausa)' },
    nota: 'Priming de alta intensidade opcional (PAP). Aquecimento ~5 min · resfriamento ~3 min',
  },
  'D5': {
    alta:     { formato: '1–2 séries de priming de 3–5 min', ratio: '3:1 (esforço:pausa)', opcional: true },
    modBaixo: { formato: '2 blocos de 8–10 min',             ratio: '2:1 (esforço:pausa)' },
    nota: 'Priming opcional. Aquecimento ~5 min · resfriamento ~3 min',
  },
};

// Blocos do grupo estímulo (não-jogadores em MD+1/MD+2)
const BLOCOS_ESTIMULO = {
  // MD+1 est. ≡ MD+3: 1 bloco alta 8-12 min + 2 blocos mod 10-14 min
  'MD+1': {
    alta:     { formato: '1 bloco de 8–12 min',   ratio: '3:1 (esforço:pausa)' },
    modBaixo: { formato: '2 blocos de 10–14 min', ratio: '2:1 (esforço:pausa)' },
    nota: 'Aquecimento ~10 min · resfriamento ~5 min',
  },
  // MD+2 est. ≡ MD-4: 1 bloco longo alta 12-18 min + 2 blocos mod 10-14 min
  'MD+2': {
    alta:     { formato: '1 bloco de 12–18 min',  ratio: '3:1 (esforço:pausa)' },
    modBaixo: { formato: '2 blocos de 10–14 min', ratio: '2:1 (esforço:pausa)' },
    nota: 'Aquecimento ~10 min · resfriamento ~5 min',
  },
};

// Nota de ajuste de blocos por capacidade coletiva
function _blocosMod(capacidade) {
  if (capacidade === 'Moderada') return 'Reduzir para 1 bloco de alta intensidade e ampliar pausas em 1–2 min';
  if (capacidade === 'Reduzida') return 'Suspender alta intensidade — apenas blocos de moderada/baixa com pausas ≥4 min';
  return null;
}

// Posições com maior exposição fisiológica por assinatura do dia
const POSICOES_RISCO = {
  'MD+1':  [],
  'MD+2':  [],
  'MD+3':  ['Lateral', 'Ponta'],
  'MD-4':  ['Lateral', 'Ponta', 'Centroavante'],
  'MD-3':  ['Lateral', 'Ponta', 'Centroavante'],
  'MD-2':  ['Lateral', 'Ponta'],
  'MD-1':  ['Volante', 'Meia'],
  'D1':    ['Zagueiro', 'Volante'],
  'D2':    ['Lateral', 'Ponta', 'Centroavante'],
  'D3':    ['Lateral', 'Ponta', 'Centroavante'],
  'D4':    ['Lateral', 'Ponta'],
  'D5':    ['Volante', 'Meia'],
  'D6':    ['Lateral', 'Ponta'],
};

// Modificadores separados por dimensão — preserva intensidade em capacidade Moderada.
// Reduzida preserva pequenas exposições de alta intensidade (×0.40) evitando descondicionamento.
// Para o output (modificador_pct), usa-se MODIFICADOR_CARGAUA como referência de carga total.
const MODIFICADOR_DURACAO  = { 'Alta': 1.00, 'Moderada': 0.82, 'Reduzida': 0.68 };
const MODIFICADOR_ALTA     = { 'Alta': 1.00, 'Moderada': 1.00, 'Reduzida': 0.40 };
const MODIFICADOR_MODBAIXO = { 'Alta': 1.00, 'Moderada': 0.82, 'Reduzida': 0.65 };
const MODIFICADOR_CARGAUA  = { 'Alta': 1.00, 'Moderada': 0.82, 'Reduzida': 0.55 };

const MODIF_TEXTO = {
  'Alta':     'mantida conforme o planejamento',
  'Moderada': 'ajustada (~18% abaixo da carga planejada — volume reduzido, intensidade preservada)',
  'Reduzida': 'ajustada (~45% abaixo da carga planejada para o dia)',
};

const SISTEMA_ADJ = {
  'Autonômico':    'autonômica',
  'Neuromuscular': 'neuromuscular',
  'Subjetivo':     'subjetiva (percepção de fadiga)',
  'Cognitivo':     'cognitiva',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function _intervalo(base, fator) {
  return [Math.round(base[0] * fator), Math.round(base[1] * fator)];
}

function _fmt(par) {
  if (!par || par[0] == null) return '—';
  if (par[0] === par[1]) return String(par[0]);
  return `${par[0]}–${par[1]}`;
}

// Número de dots (1-5) para velocidade e mudanças de direção.
// Nível base do dia × capacidade coletiva do elenco.
// Alta → 5 | Moderada → 4 (cap. Alta) ou 3 (cap. Mod/Red) | Baixa → 2 (cap. Alta/Mod) ou 1 (cap. Red)
export function calcDots(nivel, capacidade) {
  if (nivel === 'Alta')     return 5;
  if (nivel === 'Moderada') return capacidade === 'Alta' ? 4 : 3;
  // Baixa
  return capacidade === 'Reduzida' ? 1 : 2;
}

// ── Lógica de capacidade coletiva ─────────────────────────────────────────────
export function calcCapacidadeColetiva(igps, atletasProntidaoMap = null, atletasIds = []) {
  if (!igps.length) return 'Reduzida';

  // Mediana (mais robusta a outliers que média)
  const sorted  = [...igps].sort((a, b) => a - b);
  const n       = sorted.length;
  const mediana = n % 2 === 0
    ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2
    : sorted[Math.floor(n / 2)];

  // % atletas em estado Crítico
  let pctCriticos;
  if (atletasProntidaoMap && atletasIds.length) {
    const nCrit = atletasIds.filter(id => atletasProntidaoMap.get(id)?.status === 'Crítico').length;
    pctCriticos = nCrit / atletasIds.length;
  } else {
    // fallback: infere do próprio array de IGPs (IGP < 50 = Crítico)
    pctCriticos = igps.filter(v => v < 50).length / igps.length;
  }

  if (mediana >= 70 && pctCriticos <= 0.10) return 'Alta';
  if (mediana >= 55 && pctCriticos <= 0.25) return 'Moderada';
  return 'Reduzida';
}

function _fatorDominante(atletasLiberados, atletasProntidaoMap) {
  const contagem = {};
  atletasLiberados.forEach(({ id }) => {
    const p = atletasProntidaoMap.get(id);
    if ((p?.status === 'Crítico' || p?.status === 'Atenção') && p?.sistema) {
      contagem[p.sistema] = (contagem[p.sistema] || 0) + 1;
    }
  });
  const entries = Object.entries(contagem).sort((a, b) => b[1] - a[1]);
  return entries.length && entries[0][1] > 0 ? entries[0][0] : null;
}

function _gerarJustificativa(label, capacidade, excecoes, fatorDominante) {
  const status = MODIF_TEXTO[capacidade] || 'ajustada';
  let ctx = '';
  if (capacidade === 'Alta') {
    ctx = 'O índice de capacidade adaptativa agregado está compatível com os estímulos previstos para o dia.';
  } else if (capacidade === 'Moderada') {
    const fd = fatorDominante
      ? `Redução ${SISTEMA_ADJ[fatorDominante] || fatorDominante.toLowerCase()} observada em parte do elenco. `
      : '';
    ctx = `${fd}O índice de capacidade adaptativa agregado ainda é compatível com os estímulos do dia, com ajuste de volume e intensidade.`;
  } else {
    const fd = fatorDominante
      ? `Redução ${SISTEMA_ADJ[fatorDominante] || fatorDominante.toLowerCase()} significativa no elenco. `
      : '';
    ctx = `${fd}Volume e alta intensidade foram substancialmente reduzidos para preservar a integridade do elenco.`;
  }

  let excFrase = '';
  if (excecoes.length > 0) {
    const nLabel = excecoes.length === 1 ? '1 atleta' : `${excecoes.length} atletas`;
    const motivos = {};
    excecoes.forEach(e => { motivos[e.motivo] = (motivos[e.motivo] || 0) + 1; });
    const entries = Object.entries(motivos).sort((a, b) => b[1] - a[1]);
    const [motivoPred, contPred] = entries[0] ?? ['—', 0];
    // Menciona causa específica apenas se ela representa maioria absoluta das exceções
    const causaClara = contPred > excecoes.length / 2;
    excFrase = causaClara
      ? ` Recomenda-se ajuste individual para ${nLabel} — principal fator: ${motivoPred.toLowerCase()}.`
      : ` Recomenda-se ajuste individual para ${nLabel} com indicadores alterados.`;
  }

  return `A recomendação da sessão foi ${status} em relação ao dia ${label}. ${ctx}${excFrase}`;
}

// ── Ponto de entrada ──────────────────────────────────────────────────────────
/**
 * @param {object|null} diaMicrocicloObj   - retorno de calcularDiaMicrociclo()
 * @param {Map}  atletasProntidaoMap       - _atletasProntidao (id → {status, global, causas, sistema})
 * @param {Map}  atletasMedicoMap          - _atletasMedico (id → {nome, posicao, statusMed})
 * @param {object} [minutosByAtleta]       - _minutosByAtleta (id → segundos jogados no último jogo)
 * @returns {object} briefing com tipo: 'sessao' | 'sem_sessao' | 'sem_dados'
 */
export function gerarBriefing({ diaMicrocicloObj, atletasProntidaoMap, atletasMedicoMap, minutosByAtleta = {} }) {
  const rawLabel = diaMicrocicloObj?.label ?? '—';

  // Normaliza variantes: "MD-1 (B)" → "MD-1"
  const label = rawLabel.replace(/\s*\([^)]*\)/, '').trim();

  // Dias sem sessão de campo
  const semSessao = new Set(['Folga', 'MD0', '—', 'Jogo A', 'Jogo B', 'Jogo', 'Semana dupla']);
  if (semSessao.has(rawLabel) || semSessao.has(label) || rawLabel.startsWith('Jogo')) {
    const motivo = label === 'Folga'
      ? 'Folga — sem sessão de campo'
      : (label === 'MD0' || rawLabel.startsWith('Jogo'))
        ? 'Dia de jogo — sem sessão de campo'
        : 'Fora do microciclo';
    return { tipo: 'sem_sessao', label: rawLabel, objetivo: diaMicrocicloObj?.objetivo || '', motivo };
  }

  const envelope = ENVELOPE[label];
  if (!envelope) {
    return { tipo: 'sem_dados', label: rawLabel, objetivo: diaMicrocicloObj?.objetivo || '' };
  }

  // Atletas ativos: excluir afastados
  const atletasLiberados = [];
  atletasMedicoMap.forEach((med, id) => {
    if (med.statusMed !== 'afastado') atletasLiberados.push({ id, statusMed: med.statusMed });
  });

  const igps = atletasLiberados
    .map(({ id }) => atletasProntidaoMap.get(id)?.global)
    .filter(v => v != null);

  const idsLiberados = atletasLiberados.map(({ id }) => id);
  const capacidade = calcCapacidadeColetiva(igps, atletasProntidaoMap, idsLiberados);

  // Modificadores separados por dimensão
  const fatorDuracao  = MODIFICADOR_DURACAO[capacidade];
  const fatorAlta     = MODIFICADOR_ALTA[capacidade];
  const fatorModBaixo = MODIFICADOR_MODBAIXO[capacidade];
  const fatorCargaUA  = MODIFICADOR_CARGAUA[capacidade];

  // Dots para velocidade e mudanças de direção (nivel base × capacidade)
  const dotsVeloc = calcDots(envelope.veloc, capacidade);
  const dotsCod   = calcDots(envelope.cod,   capacidade);

  // cortaAlta: somente em Reduzida (fatorAlta = 0.40 → baixo, mas não zero)
  const cortaAlta = fatorAlta <= 0.50;

  // Duração com piso mínimo para evitar sessões inviáveis (ex: regenerativo Reduzida → 12 min)
  const duracaoBruta = _intervalo(envelope.duracao, fatorDuracao);
  const minFloor = envelope.duracaoMinFloor ?? 0;
  const duracao = minFloor > 0
    ? [Math.max(duracaoBruta[0], minFloor), Math.max(duracaoBruta[1], minFloor + 5)]
    : duracaoBruta;

  // modBaixo acompanha o piso quando é um dia puramente regenerativo (alta=0)
  const modBaixoBruto = _intervalo(envelope.modBaixo, fatorModBaixo);
  const modBaixo = (minFloor > 0 && envelope.alta[1] === 0)
    ? [Math.max(modBaixoBruto[0], minFloor - 3), Math.max(modBaixoBruto[1], minFloor + 2)]
    : modBaixoBruto;

  const prescricao = {
    duracao,
    cargaUA:  _intervalo(envelope.cargaUA, fatorCargaUA),
    alta:     cortaAlta ? [0, Math.round(envelope.alta[1] * fatorAlta)] : _intervalo(envelope.alta, fatorAlta),
    modBaixo,
    veloc:    capacidade === 'Reduzida' && envelope.veloc === 'Alta' ? 'Moderada' : envelope.veloc,
    cod:      capacidade === 'Reduzida' && envelope.cod   === 'Alta' ? 'Moderada' : envelope.cod,
    pse_alvo: envelope.pse_alvo ?? null,
    dots:     { veloc: dotsVeloc, cod: dotsCod },
    blocos:   BLOCOS_BASE[label] || null,
    blocosMod: _blocosMod(capacidade),
    fmt: {},
  };
  prescricao.fmt.duracao      = _fmt(prescricao.duracao)  + ' min';
  prescricao.fmt.cargaUA      = _fmt(prescricao.cargaUA)  + ' UA';
  prescricao.fmt.alta         = _fmt(prescricao.alta)     + ' min';
  prescricao.fmt.modBaixo     = _fmt(prescricao.modBaixo) + ' min';
  prescricao.fmt.pse_alvo     = prescricao.pse_alvo ? `PSE ${_fmt(prescricao.pse_alvo)}` : null;

  // Exceções: atletas liberados com status Crítico ou Atenção
  const excecoes = [];
  atletasLiberados.forEach(({ id, statusMed }) => {
    if (statusMed === 'transicao') return;
    const p = atletasProntidaoMap.get(id);
    if (p?.status === 'Crítico' || p?.status === 'Atenção') {
      excecoes.push({
        nome:   atletasMedicoMap.get(id)?.nome || id,
        status: p.status,
        motivo: p.causas?.split(' · ')[0] || p.sistema || '—',
      });
    }
  });

  // ── Separação Grupo Recuperação / Grupo Estímulo (MD+1 / MD+2) ──────────────
  // Em dias pós-jogo, atletas com < 60 min jogados não precisam de protocolo
  // regenerativo — precisam de estímulo moderado para não perder adaptação.
  // Gera prescrição paralela (prescricao_estimulo) com envelope próprio.
  let notaNaoJogadores  = null;
  let prescricaoEstimulo = null;
  let grupoRecuperacao   = null; // { n, nomes[] }
  let grupoEstimulo      = null; // { n, nomes[], capacidade, modificador_pct }

  if (label === 'MD+1' || label === 'MD+2') {
    const LIMIAR_SEG = 60 * 60; // 60 minutos em segundos
    const atletasRec  = [];
    const atletasEst  = [];

    atletasLiberados.forEach(({ id, statusMed }) => {
      if (statusMed === 'transicao') return;
      const jogouMuito = (minutosByAtleta[id] ?? 0) >= LIMIAR_SEG;
      if (jogouMuito) atletasRec.push(id);
      else            atletasEst.push(id);
    });

    if (atletasEst.length > 0) {
      // Capacidade coletiva do grupo estímulo (própria — pode diferir do grupo rec)
      const igpsEst  = atletasEst.map(id => atletasProntidaoMap.get(id)?.global).filter(v => v != null);
      const capEst   = calcCapacidadeColetiva(igpsEst, atletasProntidaoMap, atletasEst);
      const envEst   = ENVELOPE_ESTIMULO[label];
      const blocosEst = BLOCOS_ESTIMULO[label] || null;

      const fatorEstDuracao  = MODIFICADOR_DURACAO[capEst];
      const fatorEstAlta     = MODIFICADOR_ALTA[capEst];
      const fatorEstModBaixo = MODIFICADOR_MODBAIXO[capEst];
      const fatorEstCargaUA  = MODIFICADOR_CARGAUA[capEst];

      prescricaoEstimulo = {
        capacidade:      capEst,
        modificador_pct: Math.round(MODIFICADOR_CARGAUA[capEst] * 100),
        duracao:         _intervalo(envEst.duracao,  fatorEstDuracao),
        cargaUA:         _intervalo(envEst.cargaUA,  fatorEstCargaUA),
        alta:            fatorEstAlta <= 0.50 ? [0, Math.round(envEst.alta[1] * fatorEstAlta)] : _intervalo(envEst.alta, fatorEstAlta),
        modBaixo:        _intervalo(envEst.modBaixo, fatorEstModBaixo),
        veloc:           capEst === 'Reduzida' && envEst.veloc === 'Alta' ? 'Moderada' : envEst.veloc,
        cod:             capEst === 'Reduzida' && envEst.cod   === 'Alta' ? 'Moderada' : envEst.cod,
        pse_alvo:        envEst.pse_alvo ?? null,
        dots:            { veloc: calcDots(envEst.veloc, capEst), cod: calcDots(envEst.cod, capEst) },
        blocos_alta:     blocosEst?.alta     || null,
        blocos_modBaixo: blocosEst?.modBaixo || null,
        blocos_nota:     blocosEst?.nota     || null,
        blocosMod:       _blocosMod(capEst),
        fmt:             {},
      };
      prescricaoEstimulo.fmt.duracao  = _fmt(prescricaoEstimulo.duracao)  + ' min';
      prescricaoEstimulo.fmt.cargaUA  = _fmt(prescricaoEstimulo.cargaUA)  + ' UA';
      prescricaoEstimulo.fmt.alta     = _fmt(prescricaoEstimulo.alta)     + ' min';
      prescricaoEstimulo.fmt.modBaixo = _fmt(prescricaoEstimulo.modBaixo) + ' min';
      prescricaoEstimulo.fmt.pse_alvo = prescricaoEstimulo.pse_alvo ? `PSE ${_fmt(prescricaoEstimulo.pse_alvo)}` : null;

      grupoEstimulo    = { n: atletasEst.length, capacidade: capEst, modificador_pct: Math.round(MODIFICADOR_CARGAUA[capEst] * 100) };
      grupoRecuperacao = { n: atletasRec.length };

      notaNaoJogadores = { n: atletasEst.length };
    }
  }

  const fatorDom = _fatorDominante(atletasLiberados, atletasProntidaoMap);
  const posRisco = POSICOES_RISCO[label] || [];

  // Em dias divididos (grupo rec + grupo est), a prescrição principal representa
  // apenas o grupo recuperação — ajusta o label de capacidade coletiva para ser mais preciso.
  const capacidadeRec = grupoRecuperacao
    ? (() => {
        const LIMIAR_SEG = 60 * 60;
        const idsRec  = atletasLiberados
          .filter(({ id, statusMed }) => statusMed !== 'transicao' && (minutosByAtleta[id] ?? 0) >= LIMIAR_SEG)
          .map(({ id }) => id);
        const igpsRec = idsRec.map(id => atletasProntidaoMap.get(id)?.global).filter(v => v != null);
        return igpsRec.length ? calcCapacidadeColetiva(igpsRec, atletasProntidaoMap, idsRec) : capacidade;
      })()
    : capacidade;

  const justificativa = (capacidadeRec === 'Alta' && excecoes.length === 0 && !notaNaoJogadores)
    ? null
    : _gerarJustificativa(rawLabel, capacidadeRec, excecoes, fatorDom);

  return {
    tipo:                'sessao',
    label:               rawLabel,
    objetivo:            diaMicrocicloObj?.objetivo || '',
    cor:                 diaMicrocicloObj?.cor || '#6b7280',
    envelope_nome:       envelope.nome,
    capacidade_coletiva: capacidadeRec,
    modificador_pct:     Math.round(MODIFICADOR_CARGAUA[capacidadeRec] * 100),
    prescricao,
    prescricao_estimulo: prescricaoEstimulo,
    grupo_recuperacao:   grupoRecuperacao,
    grupo_estimulo:      grupoEstimulo,
    posicoes_risco:      posRisco,
    excecoes,
    nota_nao_jogadores:  notaNaoJogadores,
    justificativa,
    n_atletas:           atletasLiberados.length,
    n_com_dados:         igps.length,
  };
}
