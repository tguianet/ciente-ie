// apps/core/stats.js
// Módulo estatístico puro — sem DOM, sem Firebase.
// Importado por: recommendation_engine.js, prontidao.js (via wrappers), outros consumers.
//
// NOTA METODOLÓGICA (dívida consciente registrada):
// z-scores calculados com desvio padrão amostral (n-1), não com MAD (Median Absolute
// Deviation). O spec v1.2 menciona "z robusto (MAD)" — a implementação real usa DP amostral.
// MAD agendado para v1.1: em janelas de 7d (CMJ/Neuro), um outlier inflaciona DP e mascara
// desvios reais; nas de 28d (VFC) o impacto é menor. Ao implementar MAD, adicionar guarda
// para MAD = 0 (muitos valores iguais → divisão por zero).

// ── Constantes de referência de jogo ─────────────────────────────────────────
export const CARGA_JOGO_REF  = 800; // u.a. — PSE × duração de um jogo referência
export const VOLUME_JOGO_REF = 100; // min  — duração de referência do jogo

// ── Helpers básicos ───────────────────────────────────────────────────────────
export function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

export function cmjToScoreAbs(cm) {
  if (cm == null) return 60;
  if (cm < 30)   return 25;
  if (cm < 35)   return 40;
  if (cm < 40)   return 52;
  if (cm < 45)   return 65;
  if (cm < 50)   return 78;
  return 90;
}

export function mapNeuro(n) {
  if (n === 'estavel')      return 70;
  if (n === 'leve_atencao') return 60;
  if (n === 'atencao')      return 45;
  if (n === 'instavel')     return 25;
  return null;
}

// Modulador Hooper genérico (escala 1–7, 1=ótimo, assimétrico: penalidade > bônus)
export function moduladorHooper(val) {
  if (val == null) return 0;
  if (val <= 2) return +3;
  if (val <= 4) return  0;
  if (val === 5) return -4;
  if (val === 6) return -7;
  return -10; // val === 7
}

// Modulador de sono (subescala Hooper, penalidades reduzidas)
export function moduladorSono(val) {
  if (val == null) return 0;
  if (val <= 2) return +3;
  if (val <= 4) return  0;
  if (val === 5) return -2;
  if (val === 6) return -4;
  return -6; // val === 7
}

// ── Escala absoluta lnRR → score VFC ─────────────────────────────────────────
export function lnToScoreAbsVFC(ln) {
  if (ln == null) return 65;
  let s;
  if      (ln < 2.5) s = 5  + (ln - 1.5) * 30;
  else if (ln < 3.0) s = 35 + (ln - 2.5) * 30;
  else if (ln < 3.5) s = 50 + (ln - 3.0) * 30;
  else if (ln < 4.0) s = 65 + (ln - 3.5) * 30;
  else if (ln < 4.5) s = 80 + (ln - 4.0) * 24;
  else               s = 92 + Math.min((ln - 4.5) * 5, 5);
  return Math.round(Math.max(5, Math.min(s, 97)));
}

// Escala absoluta CMJ → score (fallback sem histórico)
function cmjAbsScore(cm) {
  return cmjToScoreAbs(cm);
}

// ── Indicadores 0-100 (usados por prontidao.js via wrappers) ─────────────────
// Todos recebem `historico` e `hoje` como parâmetros explícitos (sem DOM).

export function calcularHooperScore(hooper) {
  if (hooper == null) return null;
  const minimo = 4, maximo = 28;
  return clamp(100 - ((hooper - minimo) / (maximo - minimo) * 100), 0, 100);
}

// Neuromuscular: z-score (60%) + % melhor 30d (40%) + modulador dor
export function calcularZScoreCMJ(athleteId, saltoAtual, dor, historico, hoje) {
  if (saltoAtual == null || !athleteId) return null;

  const saltos = historico
    .filter(d => d.athleteId === athleteId && d?.pre?.salto != null && d.date !== hoje)
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .map(d => d.pre.salto);

  let compZScore;
  const recentes = saltos.slice(-7);
  if (recentes.length < 5) {
    compZScore = cmjAbsScore(saltoAtual);
  } else {
    const media  = recentes.reduce((a, b) => a + b, 0) / recentes.length;
    const desvio = Math.sqrt(recentes.reduce((s, x) => s + (x - media) ** 2, 0) / (recentes.length - 1));
    compZScore = desvio === 0
      ? 50
      : clamp(Math.round(50 + ((saltoAtual - media) / desvio * 10)), 0, 100);
  }

  let compMelhor;
  const ultimos30 = saltos.slice(-30);
  if (ultimos30.length < 3) {
    compMelhor = cmjAbsScore(saltoAtual);
  } else {
    const melhor = Math.max(...ultimos30);
    const pct    = saltoAtual / melhor;
    compMelhor   = clamp(Math.round((pct - 0.70) / (1.00 - 0.70) * 100), 0, 100);
  }

  const indicador = Math.round(compZScore * 0.6 + compMelhor * 0.4);
  return clamp(indicador + moduladorHooper(dor), 0, 100);
}

// Autonômico: blend 60% absoluto + 40% z-score (28d)
export function calcularIndicadorVFC(athleteId, lnRR, estresse, historico, hoje) {
  if (lnRR == null || !athleteId) return null;

  const lnSeries = historico
    .filter(d => d.athleteId === athleteId && d?.hrv?.lnRR != null && d.date !== hoje)
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .slice(-28)
    .map(d => d.hrv.lnRR);

  if (lnSeries.length < 5) return clamp(lnToScoreAbsVFC(lnRR), 0, 100);

  const mu    = lnSeries.reduce((a, b) => a + b, 0) / lnSeries.length;
  const sigma = Math.sqrt(lnSeries.reduce((s, x) => s + (x - mu) ** 2, 0) / lnSeries.length);
  const sigmaEfetivo = Math.max(sigma, 0.20);
  const z     = (lnRR - mu) / sigmaEfetivo;
  const compAbsoluto = lnToScoreAbsVFC(lnRR);
  const compZScore   = Math.round(20 + 80 / (1 + Math.exp(-1.4 * z)));
  return clamp(Math.round(compAbsoluto * 0.6 + compZScore * 0.4), 0, 100);
}

// Cognitivo: score bruto (70%) + z-score 7d (30%) + modulador sono
export function calcularIndicadorNeuro(athleteId, scoreAtual, sono, historico, hoje) {
  if (scoreAtual == null || !athleteId) return null;

  const scores = historico
    .filter(d => d.athleteId === athleteId && d?.neuro?.score != null && d.date !== hoje)
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .map(d => d.neuro.score);

  if (scores.length < 5) return clamp(scoreAtual + moduladorSono(sono), 0, 100);

  const compAbsoluto = clamp(scoreAtual, 0, 100);
  const recentes = scores.slice(-7);
  const media    = recentes.reduce((a, b) => a + b, 0) / recentes.length;
  const desvio   = Math.sqrt(recentes.reduce((s, x) => s + (x - media) ** 2, 0) / (recentes.length - 1));
  const compZScore = desvio === 0
    ? compAbsoluto
    : clamp(Math.round(50 + ((scoreAtual - media) / desvio * 10)), 0, 100);
  return clamp(Math.round(compAbsoluto * 0.7 + compZScore * 0.3) + moduladorSono(sono), 0, 100);
}

// IGP (Índice Global de Prontidão, 0-100)
export function calcularProntidao(dm, historico, hoje, basalRef) {
  const hooper     = dm?.pre?.hooper    ?? null;
  const salto      = dm?.pre?.salto     ?? null;
  const lnRR       = dm?.hrv?.lnRR      ?? null;
  const neuroScore = dm?.neuro?.score   ?? null;
  const neuro      = dm?.neuro?.classificacao ?? null;
  const sono       = dm?.pre?.sono      ?? null;
  const estresse   = dm?.pre?.estresse  ?? null;
  const dor        = dm?.pre?.dor       ?? null;

  const inFadiga    = hooper != null ? calcularHooperScore(hooper) : null;
  const inMuscular  = calcularZScoreCMJ(dm?.athleteId, salto, dor, historico, hoje);
  const inAutonomico = dm?.hrv?.score != null
    ? clamp(dm.hrv.score, 0, 100)
    : calcularIndicadorVFC(dm?.athleteId, lnRR, estresse, historico, hoje);
  const inCognitivo = neuroScore != null
    ? calcularIndicadorNeuro(dm?.athleteId, neuroScore, sono, historico, hoje)
    : mapNeuro(neuro);

  const indicadores   = [inFadiga, inMuscular, inAutonomico, inCognitivo].filter(v => v != null);
  const mediaSimples  = indicadores.length ? indicadores.reduce((a, b) => a + b, 0) / indicadores.length : null;
  const piorSistema   = indicadores.length ? Math.min(...indicadores) : null;
  const piorEfetivo   = piorSistema != null ? Math.max(piorSistema, 30) : null;
  const global        = mediaSimples != null
    ? Math.round((mediaSimples * 0.8 + piorEfetivo * 0.2) * 10) / 10
    : null;

  let status = 'Sem dados';
  if (global != null) {
    if (global < 50) status = 'Crítico';
    else if (global < 60) status = 'Atenção';
    else if (global < 70) status = 'Atenção Leve';
    else status = 'Estável';
  }

  const _basal     = typeof basalRef === 'number' ? basalRef : 70;
  const custoGlobal = global != null ? Math.max(0, +(_basal - global).toFixed(1)) : null;

  const IH  = inFadiga;
  const IA  = inAutonomico;
  const INM = inMuscular;
  const IC  = inCognitivo;

  const sistemasColetados = [
    { nome: 'Subjetivo',     val: IH  },
    { nome: 'Autonômico',    val: IA  },
    { nome: 'Neuromuscular', val: INM },
    { nome: 'Cognitivo',     val: IC  },
  ].filter(s => s.val != null);
  const sistemasNorm = sistemasColetados.map(s => ({
    ...s, ratio: s.val / (s.nome === 'Neuromuscular' ? 60 : 70),
  }));
  const _pior = sistemasNorm.length
    ? sistemasNorm.reduce((a, b) => a.ratio <= b.ratio ? a : b)
    : null;
  const maisPrejudicado = _pior && _pior.ratio < 1 ? _pior : null;

  return { global, status, inFadiga, inMuscular, inAutonomico, inCognitivo,
           IH, IA, INM, IC, maisPrejudicado, custoGlobal };
}

// ── z bruto (sem conversão para score) — usado por recommendation_engine.js ──
// Retorna null se histórico insuficiente; 0 se desvio = 0.
// Convenção: negativo = abaixo da média = pior desempenho.

export function zRawCMJ(athleteId, saltoAtual, historico, hoje) {
  if (saltoAtual == null || !athleteId) return null;
  const saltos = historico
    .filter(d => d.athleteId === athleteId && d?.pre?.salto != null && d.date !== hoje)
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .map(d => d.pre.salto)
    .slice(-7);
  if (saltos.length < 5) return null;
  const media  = saltos.reduce((a, b) => a + b, 0) / saltos.length;
  const desvio = Math.sqrt(saltos.reduce((s, x) => s + (x - media) ** 2, 0) / (saltos.length - 1));
  const desvioEfetivo = Math.max(desvio, 1.5); // piso 1.5 cm — evita z explodido em atletas de CMJ muito consistente
  return parseFloat(((saltoAtual - media) / desvioEfetivo).toFixed(2));
}

export function zRawVFC(athleteId, lnRR, historico, hoje) {
  if (lnRR == null || !athleteId) return null;
  const series = historico
    .filter(d => d.athleteId === athleteId && d?.hrv?.lnRR != null && d.date !== hoje)
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .slice(-28)
    .map(d => d.hrv.lnRR);
  if (series.length < 5) return null;
  const mu     = series.reduce((a, b) => a + b, 0) / series.length;
  const sigma  = Math.sqrt(series.reduce((s, x) => s + (x - mu) ** 2, 0) / series.length);
  const sigmaEfetivo = Math.max(sigma, 0.20);
  return parseFloat(((lnRR - mu) / sigmaEfetivo).toFixed(2));
}

export function zRawNeuro(athleteId, scoreAtual, historico, hoje) {
  if (scoreAtual == null || !athleteId) return null;
  const scores = historico
    .filter(d => d.athleteId === athleteId && d?.neuro?.score != null && d.date !== hoje)
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .map(d => d.neuro.score)
    .slice(-7);
  if (scores.length < 5) return null;
  const media  = scores.reduce((a, b) => a + b, 0) / scores.length;
  const desvio = Math.sqrt(scores.reduce((s, x) => s + (x - media) ** 2, 0) / (scores.length - 1));
  const desvioEfetivo = Math.max(desvio, 3); // piso 3 pts — evita z explodido em atletas de NeuroScore consistente
  return parseFloat(((scoreAtual - media) / desvioEfetivo).toFixed(2));
}

// z do score Hooper (0-100, maior = mais pronto) sobre janela 28d
export function zRawHooper(athleteId, hooperAtual, historico, hoje) {
  if (hooperAtual == null || !athleteId) return null;
  const scoreAtual = calcularHooperScore(hooperAtual);
  const scores = historico
    .filter(d => d.athleteId === athleteId && d?.pre?.hooper != null && d.date !== hoje)
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .slice(-28)
    .map(d => calcularHooperScore(d.pre.hooper));
  if (scores.length < 5) return null;
  const media  = scores.reduce((a, b) => a + b, 0) / scores.length;
  const desvio = Math.sqrt(scores.reduce((s, x) => s + (x - media) ** 2, 0) / (scores.length - 1));
  const desvioEfetivo = Math.max(desvio, 3); // piso 3 pts — evita z explodido em atletas de Hooper muito consistente
  return parseFloat(((scoreAtual - media) / desvioEfetivo).toFixed(2));
}

// ── Carga acumulada ───────────────────────────────────────────────────────────

export function calcularACWR(athleteId, historico, hoje) {
  if (!athleteId) return null;
  const cargas = historico
    .filter(d => d.athleteId === athleteId && d?.post?.carga != null && d.date < hoje)
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .map(d => ({ date: d.date, carga: d.post.carga }));
  if (cargas.length < 4) return null;

  const aguda     = cargas.slice(-7).reduce((s, d) => s + d.carga, 0);
  const ultimos28 = cargas.slice(-28);
  if (ultimos28.length < 4) return null;

  const semanas = [];
  for (let i = 0; i < 4; i++) {
    const ini = Math.max(0, ultimos28.length - (i + 1) * 7);
    const fim = ultimos28.length - i * 7;
    semanas.push(ultimos28.slice(ini, fim).reduce((s, d) => s + d.carga, 0));
  }
  const cronica = semanas.reduce((s, v) => s + v, 0) / semanas.length;
  if (cronica === 0) return null;
  return parseFloat((aguda / cronica).toFixed(2));
}

// DAI: carga e volume acumulados nos últimos 7d como múltiplos da referência de jogo.
// Interpretação: ratioCarga = 3.5 → acumulou 3,5 jogos de carga em 7d.
// v1.1: calibrar limiares de severidade com dados reais de uma temporada.
export function calcularDAI(athleteId, historico, hoje) {
  if (!athleteId) return null;
  const dados = historico
    .filter(d => d.athleteId === athleteId && d.date < hoje)
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .slice(-7);
  const carga7d = dados.reduce((s, d) => s + (d?.post?.carga ?? 0), 0);
  const tempo7d = dados.reduce((s, d) => s + (d?.post?.tempo ?? 0), 0);
  return {
    carga7d,
    tempo7d,
    ratioCarga: CARGA_JOGO_REF > 0 ? parseFloat((carga7d / CARGA_JOGO_REF).toFixed(2)) : null,
    ratioTempo: VOLUME_JOGO_REF > 0 ? parseFloat((tempo7d / VOLUME_JOGO_REF).toFixed(2)) : null,
  };
}

// ── ISP / Tendência ───────────────────────────────────────────────────────────
export const ISP_PESOS = { IH: 0.20, IA: 0.25, INM: 0.35, IC: 0.20 };

export function _ispRegression(pontos) {
  if (pontos.length < 2) return null;
  const sw  = pontos.reduce((s, p) => s + p.w, 0);
  const mx  = pontos.reduce((s, p) => s + p.x * p.w, 0) / sw;
  const my  = pontos.reduce((s, p) => s + p.y * p.w, 0) / sw;
  const num = pontos.reduce((s, p) => s + p.w * (p.x - mx) * (p.y - my), 0);
  const den = pontos.reduce((s, p) => s + p.w * (p.x - mx) ** 2, 0);
  const slope = den === 0 ? 0 : num / den;
  return { slope, intercept: my - slope * mx };
}

export function _ispDP(vals) {
  if (vals.length < 2) return 0;
  const m = vals.reduce((s, v) => s + v, 0) / vals.length;
  return Math.sqrt(vals.reduce((s, v) => s + (v - m) ** 2, 0) / vals.length);
}

export function _ispR2(pontos, slope, intercept) {
  if (pontos.length < 2) return 0;
  const sw    = pontos.reduce((s, p) => s + p.w, 0);
  const my    = pontos.reduce((s, p) => s + p.y * p.w, 0) / sw;
  const ssTot = pontos.reduce((s, p) => s + p.w * (p.y - my) ** 2, 0);
  const ssRes = pontos.reduce((s, p) => s + p.w * (p.y - (intercept + slope * p.x)) ** 2, 0);
  return ssTot === 0 ? 0 : Math.max(0, 1 - ssRes / ssTot);
}

export function classificarTendencia(slope, r2) {
  if (slope == null) return null;
  if ((r2 ?? 1) < 0.10) return { label: 'Estável',    icon: '→', cor: '#15803d', bg: '#dcfce7' };
  if (slope >  1.5)     return { label: 'Melhorando', icon: '↑', cor: '#1d4ed8', bg: '#dbeafe' };
  if (slope < -1.5)     return { label: 'Piorando',   icon: '↓', cor: '#ef4444', bg: '#fee2e2' };
  return                       { label: 'Estável',    icon: '→', cor: '#15803d', bg: '#dcfce7' };
}

export function classificarTendenciaGlobal(slopeNorm, r2) {
  if (slopeNorm == null) return null;
  if ((r2 ?? 1) < 0.10) return { label: 'Estável',    icon: '→', cor: '#15803d', bg: '#dcfce7' };
  if (slopeNorm >  0.5) return { label: 'Melhorando', icon: '↑', cor: '#1d4ed8', bg: '#dbeafe' };
  if (slopeNorm < -0.5) return { label: 'Piorando',   icon: '↓', cor: '#ef4444', bg: '#fee2e2' };
  return                       { label: 'Estável',    icon: '→', cor: '#15803d', bg: '#dcfce7' };
}

export function calcularISPTendencia(athleteId, historico, hoje) {
  if (!athleteId) return null;

  const hojeDate = new Date(hoje + 'T00:00:00');
  const limite28 = new Date(hojeDate.getTime() - 28 * 86400000).toISOString().slice(0, 10);

  const _peso   = date => {
    const diff = Math.floor((hojeDate - new Date(date + 'T00:00:00')) / 86400000);
    return diff < 7 ? 4 : diff < 14 ? 3 : diff < 21 ? 2 : 1;
  };
  const _semana = date => {
    const diff = Math.floor((hojeDate - new Date(date + 'T00:00:00')) / 86400000);
    return diff < 7 ? 4 : diff < 14 ? 3 : diff < 21 ? 2 : 1;
  };

  const dados = historico
    .filter(d => d.athleteId === athleteId && d.date >= limite28 && d.date <= hoje)
    .sort((a, b) => a.date.localeCompare(b.date));

  // IH — regressão diária ponderada
  const pontosIH = dados
    .map((d, i) => {
      const v = calcularHooperScore(d.pre?.hooper ?? null);
      return v != null ? { x: i + 1, y: v, w: _peso(d.date) } : null;
    }).filter(Boolean);

  let resultIH = null;
  if (pontosIH.length >= 4) {
    const reg = _ispRegression(pontosIH);
    const raw = reg.slope * 7;
    const dp  = _ispDP(pontosIH.map(p => p.y));
    const r2  = _ispR2(pontosIH, reg.slope, reg.intercept);
    resultIH  = { slopeRaw: raw, slopeNorm: dp > 0 ? raw / dp : 0, r2 };
  }

  function _calcSistema(fn) {
    const porSem = {};
    dados.forEach(d => {
      const v = fn(d);
      if (v == null) return;
      const s = _semana(d.date);
      if (!porSem[s]) porSem[s] = [];
      porSem[s].push(v);
    });
    const medias = Object.entries(porSem).map(([sem, vals]) => ({
      x: Number(sem),
      y: vals.reduce((a, b) => a + b, 0) / vals.length,
      w: Number(sem),
    }));
    if (medias.length < 2) return null;
    const reg = _ispRegression(medias);
    const dp  = _ispDP(medias.map(m => m.y));
    const r2  = _ispR2(medias, reg.slope, reg.intercept);
    return { slopeRaw: reg.slope, slopeNorm: dp > 0 ? reg.slope / dp : 0, r2 };
  }

  const resultIA  = _calcSistema(d =>
    calcularIndicadorVFC(athleteId, d.hrv?.lnRR ?? null, d.pre?.estresse ?? null, historico, hoje));
  const resultINM = _calcSistema(d =>
    calcularZScoreCMJ(athleteId, d.pre?.salto ?? null, d.pre?.dor ?? null, historico, hoje));
  const resultIC  = _calcSistema(d => {
    const ns = d.neuro?.score ?? null;
    return ns != null
      ? calcularIndicadorNeuro(athleteId, ns, d.pre?.sono ?? null, historico, hoje)
      : null;
  });

  const sistemas = [
    resultIH  ? { key: 'IH',  ...resultIH,  peso: ISP_PESOS.IH  } : null,
    resultIA  ? { key: 'IA',  ...resultIA,  peso: ISP_PESOS.IA  } : null,
    resultINM ? { key: 'INM', ...resultINM, peso: ISP_PESOS.INM } : null,
    resultIC  ? { key: 'IC',  ...resultIC,  peso: ISP_PESOS.IC  } : null,
  ].filter(Boolean);

  if (!sistemas.length) return null;

  const pesoTotal  = sistemas.reduce((s, x) => s + x.peso, 0);
  const globalNorm = sistemas.reduce((s, x) => s + x.slopeNorm * x.peso, 0) / pesoTotal;
  const globalR2   = sistemas.reduce((s, x) => s + x.r2 * x.peso, 0) / pesoTotal;

  return {
    global: classificarTendenciaGlobal(globalNorm, globalR2),
    IH:  resultIH  ? classificarTendencia(resultIH.slopeRaw,  resultIH.r2)  : null,
    IA:  resultIA  ? classificarTendencia(resultIA.slopeRaw,  resultIA.r2)  : null,
    INM: resultINM ? classificarTendencia(resultINM.slopeRaw, resultINM.r2) : null,
    IC:  resultIC  ? classificarTendencia(resultIC.slopeRaw,  resultIC.r2)  : null,
    _score:      globalNorm,
    _r2:         globalR2,        // exposto para o motor calcular severidadeISP
    _nRegistros: dados.length,    // total de registros diários na janela 28d
  };
}
