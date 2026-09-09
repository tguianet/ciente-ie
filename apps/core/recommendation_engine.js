// apps/core/recommendation_engine.js
// Motor de Recomendação Operacional — Spec v1.2 (MIHBD-TE)
//
// Pipeline (ordem fixa — seção 6):
//   sinaisRaw → severidade → escore bruto → dose_bruta → overrides
//   → histerese → RTP → dose_final → output estruturado
//
// Roda client-side: chamado na abertura do dashboard/relatório com lógica
// compute-if-missing (só calcula se o objeto do dia ainda não existe no Firestore).
//
// Consumidores leem o objeto persistido — nunca recalculam (seção 10).
// Analista IA recebe o objeto pronto e só verbaliza.

import {
  zRawVFC, zRawCMJ, zRawNeuro, zRawHooper,
  calcularACWR, calcularDAI, calcularISPTendencia,
  calcularZScoreCMJ,
} from './stats.js';

// Versão do engine — incrementar aqui força recompute de todos os caches do dia
export const ENGINE_VERSION = '2.2';

// ── Parâmetros calibráveis (seção 10) — versionados aqui, não dispersos ─────
export const PARAMS = {
  // Cortes de z (desvio padrão amostral — MAD agendado para v1.1)
  Z_SEV1: -1,   // z ≤ -1 → sev 1
  Z_SEV2: -2,   // z ≤ -2 → sev 2

  // ACWR
  ACWR_SEV1: 1.3,
  ACWR_SEV2: 1.5,

  // DAI: múltiplos de CARGA_JOGO_REF (800 u.a.) / VOLUME_JOGO_REF (100 min)
  // v1.1: calibrar com dados reais de uma temporada
  DAI_CARGA_SEV1: 4.0,  // > 4.0x carga de jogo em 7d
  DAI_CARGA_SEV2: 5.5,
  DAI_TEMPO_SEV1: 4.5,  // > 4.5x duração de jogo em 7d
  DAI_TEMPO_SEV2: 6.5,

  // Dor — escala EVA (0-10). pre.dor (Hooper 1-7) mapeado para EVA em computeMotorInputs.
  // pre.dor 1-4 = sem/leve (ignorar), pre.dor 5 → EVA 4 → sev1, pre.dor 6 → EVA 5 → sev2
  EVA_SEV1: 4,
  EVA_SEV2: 5,
  EVA_ENCAMINHAMENTO: 5,  // ≥ 5 → flag clínica + restrição mecânica (seção 6.1)

  // Faixas escore → dose (normalização por percentual do máximo do eixo)
  DOSE_LEVE_PCT:              0.20,
  DOSE_LEVE_PCT_ALTA_PRONTIDAO: 0.30,
  DOSE_MODERADO_PCT:          0.40,
  DOSE_FORTE_PCT:             0.60,

  // Pós-jogo (MD+1 / MD+2) — limiar de minutagem para regime titular
  // >60min → recuperação aguda obrigatória; ≤60min → regime reserva (menos restritivo)
  // v1.1: calibrar com dados próprios
  POS_JOGO_LIMIAR_TITULAR_MIN: 60,

  // IGP abaixo deste valor + titular pós-jogo → escalona floor para titular_critico
  // Garante que atletas em estado Crítico não recebem prescrição padrão de recuperação
  IGP_CRITICO_POS_JOGO: 50,

  // Gate IGP para restrição leve (seção 7)
  // Atletas com IGP ≥ este valor recebem DOSE_LEVE_PCT mais alto — sinais subjetivos isolados não bastam
  IGP_GATE_RESTRICAO_LEVE:  75,

  // ISP tendência (slopeNorm = DP/semana normalizado)
  ISP_R2_MIN:       0.30, // r² < 0.30 → baixa confiabilidade → classifica como sev1 (não sev2)
  ISP_R2_SEV1_MIN:  0.15, // r² < 0.15 → inconclusivo → sem penalidade
  ISP_MIN_PONTOS:   5,    // menos de 5 registros → dados insuficientes → sem penalidade
  ISP_QUEDA_FRACA:  -0.5, // slopeNorm entre -0.5 e -1.0 → queda fraca → sev 1
  ISP_QUEDA_FORTE:  -1.0, // slopeNorm < -1.0 com r² ≥ 0.30 → queda consistente → sev 2

  // Absolute iGP thresholds (fallback para atletas cronicamente baixos — z≈0 mascara)
  IGP_ABS_SEV1:     60,   // score < 60 → sev 1 (iH, iA, iC)
  IGP_ABS_SEV2:     50,   // score < 50 → sev 2 (iH, iA, iC)
  IGP_INM_SEV1:     50,   // CMJ: score < 50 → sev 1 (limiar CMJ é 60, não 70)
  IGP_INM_SEV2:     40,   // CMJ: score < 40 → sev 2

  // IGP Crítico + CMJ comprometido → força sev2 para iNM mesmo no primeiro dia
  // Garante restrição imediata de carga mecânica quando o CMJ é o responsável pelo IGP Crítico.
  // Condição: iGP < 50 (Crítico) E absINM < IGP_INM_SEV1 (CMJ também comprometido).
  IGP_CRITICO_INM_GATE: 50,
};

// Escores máximos por eixo (todos os sinais em sev2) — usados para normalização
// volume:         carga(2×2)+isp(1×2)+ih(1×2) = 8
// intensidade:    ia(2×2)+inm(1×2)+isp(1×2)+ih(1×2) = 10
// densidade:      carga(1×2)+ia(2×2)+ih(1×2)+ic(2×2) = 12
// carga_mecanica: inm(2×2)+dor(2×2) = 8
export const AXIS_MAX = { volume: 8, intensidade: 10, densidade: 12, carga_mecanica: 8 };

// Escala de conservadorismo: manter < leve < moderado < forte
const DOSES = ['manter', 'leve', 'moderado', 'forte'];

// Restrições mínimas por MD+1 / MD+2 (pós-jogo)
// Funcionam como PISO (floor) — garantem recuperação mínima independente do estado fisiológico.
// Aplicadas APÓS todo o pipeline (histerese + RTP), nunca aliviam.
// Ativadas apenas para atletas com minutosJogados > 0.
// Titular  = jogou > PARAMS.POS_JOGO_LIMIAR_TITULAR_MIN minutos
// Reserva  = jogou > 0 e ≤ limite acima
export const POS_JOGO_RESTRICOES = {
  1: { // MD+1: recuperação aguda
    titular:         { volume: 'forte',    intensidade: 'forte',    densidade: 'moderado', carga_mecanica: 'forte'   },
    titular_critico: { volume: 'forte',    intensidade: 'forte',    densidade: 'forte',    carga_mecanica: 'forte'   },
    reserva:         { volume: 'moderado', intensidade: 'moderado', densidade: 'leve',     carga_mecanica: 'moderado'},
  },
  2: { // MD+2: segunda janela — progressão ainda conservadora
    titular:         { volume: 'moderado', intensidade: 'moderado', densidade: 'leve',     carga_mecanica: 'moderado'},
    titular_critico: { volume: 'forte',    intensidade: 'moderado', densidade: 'moderado', carga_mecanica: 'forte'   },
    reserva:         { volume: 'leve',     intensidade: 'leve',     densidade: 'manter',   carga_mecanica: 'leve'    },
  },
};

// Racional pós-jogo (por MD × faixa) — prefixado no racional_curto
const POS_JOGO_RACIONAL = {
  1: {
    titular:         'Recuperação pós-jogo (MD+1) — titular com >60 min jogados',
    titular_critico: 'Recuperação pós-jogo (MD+1) — titular em estado Crítico (IGP<50) — restrição máxima',
    reserva:         'Recuperação pós-jogo (MD+1) — participação no jogo',
  },
  2: {
    titular:         'Segunda recuperação pós-jogo (MD+2) — carga mecânica acumulada',
    titular_critico: 'Segunda recuperação pós-jogo (MD+2) — titular em estado Crítico (IGP<50) — restrição elevada',
    reserva:         'Segunda recuperação pós-jogo (MD+2) — participação parcial no jogo',
  },
};

// Restrições mínimas por fase RTP (seção 8)
// ATENÇÃO: a fase impõe TETO de estímulo — o motor só modula igual ou mais conservador.
// Nunca inverter a ordem histerese → RTP (seção 6, caso de teste seção 13).
// Valores baseados em literatura de RTP futebol (referência: Buckthorpe et al. 2019).
// v1.1: calibrar com dados próprios após uma temporada.
export const RTP_RESTRICOES = {
  0: { volume: 'forte',    intensidade: 'forte',    densidade: 'forte',    carga_mecanica: 'forte'   }, // F0: repouso
  1: { volume: 'forte',    intensidade: 'forte',    densidade: 'moderado', carga_mecanica: 'forte'   }, // F1: regenerativo
  2: { volume: 'moderado', intensidade: 'moderado', densidade: 'leve',     carga_mecanica: 'forte'   }, // F2: aeróbico leve
  3: { volume: 'leve',     intensidade: 'leve',     densidade: 'leve',     carga_mecanica: 'moderado'}, // F3: progressão
  4: { volume: 'manter',   intensidade: 'leve',     densidade: 'manter',   carga_mecanica: 'leve'    }, // F4: integração
};

// Matriz de pesos sinal → eixo (seção 4)
// ✓✓ = 2, ✓ = 1, vazio = 0
const PESOS = {
  carga: { volume: 2, intensidade: 0, densidade: 1, carga_mecanica: 0 },
  isp:   { volume: 1, intensidade: 1, densidade: 0, carga_mecanica: 0 },
  ia:    { volume: 0, intensidade: 2, densidade: 2, carga_mecanica: 0 },
  inm:   { volume: 0, intensidade: 1, densidade: 0, carga_mecanica: 2 },
  ih:    { volume: 1, intensidade: 1, densidade: 1, carga_mecanica: 0 },
  ic:    { volume: 0, intensidade: 0, densidade: 2, carga_mecanica: 0 },
  dor:   { volume: 0, intensidade: 0, densidade: 0, carga_mecanica: 2 },
};

// Templates racional_curto (seção 9.2) — uma frase por sinal, mapa fixo
const RACIONAL_TEMPLATES = {
  ia:    { 1: 'Autonômico (VFC) levemente reduzido',              2: 'Autonômico (VFC) significativamente reduzido — estresse fisiológico elevado' },
  inm:   { 1: 'Neuromuscular (CMJ) levemente reduzido',           2: 'Neuromuscular (CMJ) significativamente reduzido — risco de sobrecarga tecidual' },
  ih:    { 1: 'Percepção de fadiga elevada',                      2: 'Percepção de fadiga muito elevada — alerta subjetivo' },
  ic:    { 1: 'Cognitivo (NeuroScore) levemente reduzido',        2: 'Cognitivo (NeuroScore) significativamente reduzido' },
  isp:   { 1: 'ISP em queda fraca',                              2: 'ISP em queda consistente — tendência de deterioração semanal' },
  carga: { 1: 'Carga acumulada em atenção',                      2: 'Carga acumulada elevada — risco de sobrecarga' },
  dor:   { 1: 'Dor localizada leve em {local}',                  2: 'Dor relevante em {local} — encaminhamento clínico indicado' },
};

// Templates restricoes (seção 9.3) — por eixo × dose_final ≥ leve
const RESTRICAO_TEMPLATES = {
  volume: {
    leve:     'Reduzir volume total (~10–15%)',
    moderado: 'Reduzir volume total (~20–30%)',
    forte:    'Reduzir volume total (≥40%) — sessão regenerativa ou apenas técnica',
  },
  intensidade: {
    leve:     'Teto de intensidade levemente reduzido (PSE/velocidade)',
    moderado: 'Reduzir zona alvo de intensidade (ex.: −1 zona)',
    forte:    'Apenas trabalho técnico ou regenerativo — sem alta intensidade',
  },
  densidade: {
    leve:     'Aumentar pausas entre estímulos',
    moderado: 'Aumentar pausas substancialmente e reduzir densidade decisional',
    forte:    'Trabalho fracionado com recuperação ampla entre blocos',
  },
  carga_mecanica: {
    leve:     'Reduzir saltos, sprints e ações excêntricas',
    moderado: 'Retirar ações de alto impacto',
    forte:    'Sem impacto ou contato — apenas regenerativo',
  },
};

// Precedência de segurança para desempate de prioridade (seção 9.1)
const PRECEDENCIA_PRIORIDADE = ['carga_mecanica', 'volume', 'intensidade', 'densidade'];

// Eixos do pipeline (ordem canônica)
const EIXOS_PIPELINE = ['volume', 'intensidade', 'densidade', 'carga_mecanica'];

// ── Adição emocional — seletiva por eixo (pontos brutos, pré-normalização) ───
// Afeta volume, intensidade e densidade; nunca carga_mecanica (sem corroboração neuromuscular)
// Tabela de adição por eixo:
//   humor 1-2: sem adição (baseline)
//   humor 3-4 (leve): volume+0.5, densidade+0.5
//   humor 5-6 (moderado): volume+0.5, intensidade+0.5, densidade+1.0
//   humor 7 (grave): volume+1.0, intensidade+0.5, densidade+1.0
export function calcAdicaoEmocional(humor) {
  if (humor == null || humor <= 2) return { volume: 0, intensidade: 0, densidade: 0, carga_mecanica: 0 };
  if (humor <= 4) return { volume: 0.5, intensidade: 0,   densidade: 0.5, carga_mecanica: 0 };
  if (humor <= 6) return { volume: 0.5, intensidade: 0.5, densidade: 1.0, carga_mecanica: 0 };
  return             { volume: 1.0, intensidade: 0.5, densidade: 1.0, carga_mecanica: 0 };
}

// ── Etapa 1: severidade por sinal ─────────────────────────────────────────────

export function _severidadeZ(z) {
  if (z == null) return 0;
  if (z <= PARAMS.Z_SEV2) return 2;  // z ≤ −2 → 2  (incluindo z = −2)
  if (z < PARAMS.Z_SEV1)  return 1;  // −2 < z < −1 → 1  (−1 fica no 0)
  return 0;                           // z ≥ −1 → 0
}

// Severidade por score absoluto iGP (0-100). Garante detecção de atletas cronicamente baixos
// cujo z≈0 (linha de base deprimida) mascararia a queda.
export function _severidadeAbsoluta(score, sev1Thr, sev2Thr) {
  if (score == null) return 0;
  if (score < sev2Thr) return 2;
  if (score < sev1Thr) return 1;
  return 0;
}

export function _severidadeDor(eva) {
  if (eva == null || eva === 0) return 0;
  if (eva >= PARAMS.EVA_SEV2) return 2;
  if (eva >= PARAMS.EVA_SEV1) return 1;
  return 0;
}

export function _severidadeCarga(acwr, dai) {
  let sev = 0;
  if (acwr != null) {
    if (acwr > PARAMS.ACWR_SEV2) {
      // ACWR > 1.5 sozinho → sev1; sev2 somente quando DAI corrobora
      const daiCorrobora = dai != null && (
        (dai.ratioCarga != null && dai.ratioCarga > PARAMS.DAI_CARGA_SEV1) ||
        (dai.ratioTempo != null && dai.ratioTempo > PARAMS.DAI_TEMPO_SEV1)
      );
      sev = Math.max(sev, daiCorrobora ? 2 : 1);
    } else if (acwr > PARAMS.ACWR_SEV1) {
      sev = Math.max(sev, 1);
    }
  }
  if (dai != null) {
    const cargaAlta  = dai.ratioCarga != null && dai.ratioCarga > PARAMS.DAI_CARGA_SEV2;
    const cargaMod   = dai.ratioCarga != null && dai.ratioCarga > PARAMS.DAI_CARGA_SEV1;
    const tempoAlto  = dai.ratioTempo != null && dai.ratioTempo > PARAMS.DAI_TEMPO_SEV2;
    const tempoMod   = dai.ratioTempo != null && dai.ratioTempo > PARAMS.DAI_TEMPO_SEV1;
    if (cargaAlta || tempoAlto)    sev = Math.max(sev, 2);
    else if (cargaMod || tempoMod) sev = Math.max(sev, 1);
  }
  return sev;
}

// ISP: recebe o objeto classificado {classe, severidade} já resolvido upstream
export function _severidadeISP(isp) {
  return isp?.severidade ?? 0;
}

// Monta o objeto sinais com severidade calculada
function _computeSeveridades(sinaisRaw) {
  const abs = sinaisRaw.absScores ?? {};
  return {
    ia:    { z: sinaisRaw.ia?.z ?? null,  severidade: Math.max(
               _severidadeZ(sinaisRaw.ia?.z ?? null),
               _severidadeAbsoluta(abs.iA, PARAMS.IGP_ABS_SEV1, PARAMS.IGP_ABS_SEV2)) },
    inm:   { z: sinaisRaw.inm?.z ?? null, severidade: Math.max(
               _severidadeZ(sinaisRaw.inm?.z ?? null),
               _severidadeAbsoluta(abs.iNM, PARAMS.IGP_INM_SEV1, PARAMS.IGP_INM_SEV2),
               // IGP Crítico + CMJ comprometido → bypass histerese no primeiro dia
               (abs.iGP != null && abs.iGP < PARAMS.IGP_CRITICO_INM_GATE &&
                abs.iNM != null && abs.iNM < PARAMS.IGP_INM_SEV1) ? 2 : 0) },
    ih:    { z: sinaisRaw.ih?.z ?? null,  severidade: Math.max(
               _severidadeZ(sinaisRaw.ih?.z ?? null),
               _severidadeAbsoluta(abs.iH, PARAMS.IGP_ABS_SEV1, PARAMS.IGP_ABS_SEV2),
               sinaisRaw.ih?.sevComponente ?? 0) },
    ic:    { z: sinaisRaw.ic?.z ?? null,  severidade: Math.max(
               _severidadeZ(sinaisRaw.ic?.z ?? null),
               _severidadeAbsoluta(abs.iC, PARAMS.IGP_ABS_SEV1, PARAMS.IGP_ABS_SEV2)) },
    isp:   { classe: sinaisRaw.isp?.classe ?? 'sem_dados', severidade: _severidadeISP(sinaisRaw.isp) },
    carga: {
      acwr: sinaisRaw.carga?.acwr ?? null,
      dai:  sinaisRaw.carga?.dai  ?? null,
      severidade: _severidadeCarga(sinaisRaw.carga?.acwr ?? null, sinaisRaw.carga?.dai ?? null),
    },
    dor:   {
      local: sinaisRaw.dor?.local ?? null,
      eva:   sinaisRaw.dor?.eva   ?? 0,
      severidade: _severidadeDor(sinaisRaw.dor?.eva ?? 0),
    },
  };
}

// ── Etapa 2: escore por eixo (seções 4-5) ────────────────────────────────────

export function _escoreEixos(sev) {
  const eixos = { volume: 0, intensidade: 0, densidade: 0, carga_mecanica: 0 };
  for (const [sinal, pesos] of Object.entries(PESOS)) {
    const s = sev[sinal]?.severidade ?? 0;
    if (s === 0) continue;
    for (const [eixo, peso] of Object.entries(pesos)) {
      eixos[eixo] += peso * s;
    }
  }
  return eixos;
}

// _scoreToDose: recebe ratio normalizado (0-1)
export function _scoreToDose(ratio, doteLevePct = PARAMS.DOSE_LEVE_PCT) {
  if (ratio < doteLevePct)              return 'manter';
  if (ratio < PARAMS.DOSE_MODERADO_PCT) return 'leve';
  if (ratio < PARAMS.DOSE_FORTE_PCT)    return 'moderado';
  return 'forte';
}

export function _maisConservadora(d1, d2) {
  return DOSES.indexOf(d1) >= DOSES.indexOf(d2) ? d1 : d2;
}

// _doseBruta: normaliza cada eixo pelo seu AXIS_MAX antes de converter em dose
function _doseBruta(escores, doteLevePct = PARAMS.DOSE_LEVE_PCT) {
  return Object.fromEntries(
    Object.entries(escores).map(([eixo, escore]) => {
      const max = AXIS_MAX[eixo] ?? 1;
      return [eixo, _scoreToDose(escore / max, doteLevePct)];
    })
  );
}

// ── Etapa 3: overrides (seção 6) ─────────────────────────────────────────────

export function _overrides(sev, doses) {
  const resultado        = { ...doses };
  const escalas_imediatas = new Set();
  let   encaminhamento   = false;

  // 6.1 Dor relevante: flag clínica + restrição mínima mecânica
  if ((sev.dor?.eva ?? 0) >= PARAMS.EVA_ENCAMINHAMENTO) {
    encaminhamento = true;
    resultado.carga_mecanica = _maisConservadora(resultado.carga_mecanica, 'moderado');
  }

  // 6.2 Escala imediata — escopada aos eixos do sinal (não global)
  if (sev.ia?.severidade  === 2) { escalas_imediatas.add('intensidade'); escalas_imediatas.add('densidade'); }
  // iNM sev2: afeta apenas carga_mecanica (não intensidade metabólica — CMJ indica fadiga neuromuscular, não metabólica)
  if (sev.inm?.severidade === 2) { escalas_imediatas.add('carga_mecanica'); }
  if (sev.dor?.severidade === 2) { escalas_imediatas.add('carga_mecanica'); }

  return { doses: resultado, escalas_imediatas, encaminhamento };
}

// ── Etapa 4: histerese (seção 7) ─────────────────────────────────────────────
// Opera sobre dose_bruta (já com overrides) → produz dose_pos_histerese.
// estadoOntem: { [eixo]: { faixaAtual, faixaBruta, diasEstavel } } | null
// nSistemasAlterados: número de sinais com severidade ≥ 1 (para corroboração)
// Retorna: { doses, novosEstados }

export function _histerese(dosesComOverrides, escalas_imediatas, estadoOntem, nSistemasAlterados = 0) {
  const doses = {};
  const novosEstados = {};

  for (const eixo of EIXOS_PIPELINE) {
    const faixaBruta      = dosesComOverrides[eixo];
    const faixaAtual      = estadoOntem?.[eixo]?.faixaAtual  ?? 'manter';
    const faixaBrutaOntem = estadoOntem?.[eixo]?.faixaBruta  ?? null;
    const diasEstavel     = estadoOntem?.[eixo]?.diasEstavel ?? 0;
    const idxBruta        = DOSES.indexOf(faixaBruta);
    const idxAtual        = DOSES.indexOf(faixaAtual);

    let dose, novosDias;

    if (escalas_imediatas.has(eixo)) {
      // Bypass total: escala imediata por sev2 crítico
      dose      = faixaBruta;
      novosDias = 0;
    } else if (idxBruta > idxAtual) {
      // Escalada (piora)
      const ehModForte      = idxBruta >= 2; // moderado ou forte
      const temCorroboracao = nSistemasAlterados >= 2;
      if (ehModForte && temCorroboracao) {
        // Imediata quando ≥2 sistemas independentes alterados
        dose = faixaBruta;
      } else {
        // Exige 2º dia consecutivo (filtro de ruído)
        const idxBrutaOntem = faixaBrutaOntem != null ? DOSES.indexOf(faixaBrutaOntem) : -1;
        dose = idxBrutaOntem >= idxBruta ? faixaBruta : faixaAtual;
      }
      novosDias = 0;
    } else if (idxBruta < idxAtual) {
      // Desescalada (melhora)
      if (idxAtual <= 1) {
        // manter ou leve → desescalada imediata (baixo risco)
        dose      = faixaBruta;
        novosDias = 0;
      } else {
        // moderado ou forte → step-by-step (máximo 1 nível por dia)
        if (diasEstavel >= 1) {
          // 2º+ dia consecutivo com pressão de melhora: desce 1 nível
          dose      = DOSES[idxAtual - 1];
          novosDias = 0; // reset após dar passo (novo nível precisa ser confirmado)
        } else {
          // 1º dia com bruta < atual: aguarda confirmação
          dose      = faixaAtual;
          novosDias = 1;
        }
      }
    } else {
      // Mesma faixa
      dose      = faixaAtual;
      novosDias = 0;
    }

    doses[eixo]        = dose;
    novosEstados[eixo] = { diasEstavel: novosDias };
  }

  return { doses, novosEstados };
}

// ── Etapa 5: aplicar RTP (seção 8) ───────────────────────────────────────────
// A fase nunca afrouxa — o motor só aperta. maisConservadora(motor, fase) vence sempre.

export function _aplicarRTP(dosePosHisterese, faseRTP) {
  if (faseRTP == null || RTP_RESTRICOES[faseRTP] == null) return { ...dosePosHisterese };
  const restricoes = RTP_RESTRICOES[faseRTP];
  return Object.fromEntries(
    Object.entries(dosePosHisterese).map(([eixo, dose]) => [
      eixo, _maisConservadora(dose, restricoes[eixo]),
    ])
  );
}

// ── Etapa 5b: pós-jogo — floor de recuperação (MD+1 / MD+2) ─────────────────
// contextoJogo: { mdPos: 1|2|null, minutosJogados: number|null }
// igpAbs: iGP absoluto (0-100) ou null — ativa tier titular_critico quando < IGP_CRITICO_POS_JOGO
// Retorna dose com piso elevado quando o atleta jogou no jogo anterior.
// Nunca alivia o motor — _maisConservadora(dose_atual, piso_pos_jogo) vence sempre.

export function _aplicarPosJogo(dose, contextoJogo, igpAbs = null) {
  const mdPos         = contextoJogo?.mdPos         ?? null;
  const minutosJogados = contextoJogo?.minutosJogados ?? null;
  if (!mdPos || !POS_JOGO_RESTRICOES[mdPos]) return { ...dose };
  if (minutosJogados == null || minutosJogados <= 0) return { ...dose };
  const eTitular = minutosJogados > PARAMS.POS_JOGO_LIMIAR_TITULAR_MIN;
  const eCritico = igpAbs != null && igpAbs < PARAMS.IGP_CRITICO_POS_JOGO;
  const faixa    = eTitular
    ? (eCritico ? 'titular_critico' : 'titular')
    : 'reserva';
  const minimos = POS_JOGO_RESTRICOES[mdPos][faixa];
  return Object.fromEntries(
    Object.entries(dose).map(([eixo, d]) => [eixo, _maisConservadora(d, minimos[eixo])])
  );
}

// ── Etapa 6: prioridade + templates (seção 9) ─────────────────────────────────

export function _resolverPrioridade(encaminhamento, sev, escores) {
  // 9.1.1: encaminhamento ou dor sev2 → protecao_tecidual
  if (encaminhamento || (sev.dor?.severidade ?? 0) >= 2) return 'protecao_tecidual';

  // 9.1.2: maior escore; empate → precedência de segurança
  let maior = -1, prioridade = null;
  for (const eixo of PRECEDENCIA_PRIORIDADE) {
    if ((escores[eixo] ?? 0) > maior) {
      maior = escores[eixo];
      prioridade = eixo;
    }
  }
  return prioridade ?? 'volume';
}

function _resolverPrioridadeOperacional(doseFinal) {
  const eixosAtivos = PRECEDENCIA_PRIORIDADE.filter(e =>
    DOSES.indexOf(doseFinal[e]) >= DOSES.indexOf('moderado')
  );
  if (!eixosAtivos.length) return 'sem_modulacao';
  return 'reduzir_' + eixosAtivos.join('_e_');
}

export function _gerarRacionalCurto(sev) {
  const frases = [];
  for (const [sinal, templates] of Object.entries(RACIONAL_TEMPLATES)) {
    const s = sev[sinal];
    if (!s || (s.severidade ?? 0) < 1) continue;
    const nivel = Math.min(s.severidade, 2);
    let frase = templates[nivel] ?? templates[1] ?? '';
    if (sinal === 'dor') {
      frase = frase.replace('{local}', s.local || 'região não especificada');
    }
    frases.push(frase);
  }
  return frases;
}

export function _gerarRestricoes(doseFinal) {
  const restricoes = [];
  for (const eixo of PRECEDENCIA_PRIORIDADE) {
    const dose = doseFinal[eixo];
    if (!dose || dose === 'manter') continue;
    const template = RESTRICAO_TEMPLATES[eixo]?.[dose];
    if (template) restricoes.push(template);
  }
  return restricoes;
}

// ── Ponto de entrada principal ────────────────────────────────────────────────
// sinaisRaw: {
//   ia:    { z: number|null },
//   inm:   { z: number|null },
//   ih:    { z: number|null },
//   ic:    { z: number|null },
//   isp:   { classe: string, severidade: 0|1|2 },
//   carga: { acwr: number|null, dai: DAIObj|null },
//   dor:   { local: string|null, eva: number }   ← EVA 0-10
// }
// estadoHisterese: { [eixo]: { faixaAtual, faixaBruta, diasEstavel } } | null
// faseRTP: 0|1|2|3|4|null

// contextoJogo (opcional): { mdPos: 1|2|null, minutosJogados: number|null }
export function runMotor({ atletaId, nome, clubId, data, sinaisRaw, estadoHisterese, faseRTP, contextoJogo }) {
  // Etapa 1: severidade
  const sev = _computeSeveridades(sinaisRaw);

  // Etapa 2: escore → dose_bruta (com adição emocional seletiva por eixo)
  const escores = _escoreEixos(sev);

  // Adição emocional: incremento seletivo por eixo (não multiplica — adiciona pontos brutos pré-normalização)
  // Nunca afeta carga_mecanica (sem corroboração neuromuscular para isso)
  const adicaoEmoc = calcAdicaoEmocional(sinaisRaw.humor ?? null);
  const emocAplicado = Object.values(adicaoEmoc).some(v => v > 0);
  const escoresComFator = emocAplicado
    ? Object.fromEntries(Object.entries(escores).map(([k, v]) => [k, v + (adicaoEmoc[k] ?? 0)]))
    : escores;

  // Gate IGP: atleta com boa prontidão global exige mais corroboração para restrição leve
  // (sinais subjetivos isolados — IH, ISP — não bastam quando o atleta está estável)
  // Gate não atua quando há sinal objetivo (iA, iNM, dor) com sev≥1
  // nem quando ≥2 sinais subjetivos concordam (ih+isp, ih+carga, etc.)
  const igpAbs = sinaisRaw.absScores?.iGP ?? null;
  const temSinalObjetivo = (sev.ia?.severidade  ?? 0) >= 1
                         || (sev.inm?.severidade ?? 0) >= 1
                         || (sev.dor?.severidade ?? 0) >= 1;
  const nSubjetivosAlterados = [sev.ih, sev.isp, sev.carga]
    .filter(s => (s?.severidade ?? 0) >= 1).length;
  const gateAplicavel = !temSinalObjetivo && nSubjetivosAlterados < 2;
  const doteLevePct   = (igpAbs != null && igpAbs >= PARAMS.IGP_GATE_RESTRICAO_LEVE && gateAplicavel)
    ? PARAMS.DOSE_LEVE_PCT_ALTA_PRONTIDAO
    : PARAMS.DOSE_LEVE_PCT;
  const dose_bruta = _doseBruta(escoresComFator, doteLevePct);

  // Etapa 3: overrides
  const { doses: dosesComOverrides, escalas_imediatas, encaminhamento } = _overrides(sev, dose_bruta);

  // Etapa 4: histerese (nova assinatura + nSistemasAlterados)
  const nSistemasAlterados = Object.values(sev).filter(s => (s?.severidade ?? 0) >= 1).length;
  const { doses: dose_pos_histerese, novosEstados: histerese_novos_estados } =
    _histerese(dosesComOverrides, escalas_imediatas, estadoHisterese, nSistemasAlterados);

  // Etapa 5: RTP
  const dose_pos_rtp = _aplicarRTP(dose_pos_histerese, faseRTP);

  // Etapa 5b: pós-jogo — floor de recuperação (MD+1 / MD+2)
  const dose_final = _aplicarPosJogo(dose_pos_rtp, contextoJogo, igpAbs);

  // Etapa 6: prioridade + templates
  const prioridade = _resolverPrioridade(encaminhamento, sev, escores);

  // Metadados de histerese para auditoria
  const histerese_info = {};
  for (const eixo of EIXOS_PIPELINE) {
    const antigo = estadoHisterese?.[eixo]?.faixaAtual ?? 'manter';
    const novo   = dose_pos_histerese[eixo];
    histerese_info[eixo] =
      novo === antigo                                   ? 'estavel'       :
      DOSES.indexOf(novo) > DOSES.indexOf(antigo)      ? 'escalou_hoje'  :
                                                         'desescalou_hoje';
  }

  // Objeto de saída (seção 9)
  const eixosOutput = {};
  for (const eixo of EIXOS_PIPELINE) {
    eixosOutput[eixo] = {
      escore:              escores[eixo],
      escore_com_fator:    escoresComFator[eixo],
      adicao_emocional:    adicaoEmoc[eixo],
      dose_bruta:          dose_bruta[eixo],
      dose_pos_histerese:  dose_pos_histerese[eixo],
      dose_pos_rtp:        dose_pos_rtp[eixo],
      dose_final:          dose_final[eixo],
      diasEstavel_novo:    histerese_novos_estados[eixo]?.diasEstavel ?? 0,
    };
  }

  // Metadados pós-jogo
  const _pjAtivo       = (contextoJogo?.mdPos != null) && ((contextoJogo?.minutosJogados ?? 0) > 0);
  const _pjEhTitular   = _pjAtivo && (contextoJogo.minutosJogados ?? 0) > PARAMS.POS_JOGO_LIMIAR_TITULAR_MIN;
  const _pjEhCritico   = igpAbs != null && igpAbs < PARAMS.IGP_CRITICO_POS_JOGO;
  const _pjFaixa       = !_pjAtivo ? null
    : _pjEhTitular ? (_pjEhCritico ? 'titular_critico' : 'titular') : 'reserva';
  const _pjRacional    = (_pjAtivo && POS_JOGO_RACIONAL[contextoJogo.mdPos])
    ? POS_JOGO_RACIONAL[contextoJogo.mdPos][_pjFaixa]
    : null;

  return {
    atleta:                  nome ?? atletaId,
    clubId,
    data,
    sinais:                  sev,
    eixos:                   eixosOutput,
    adicao_emocional:        adicaoEmoc,
    emocional_aplicado:      emocAplicado,
    // Mantido para compatibilidade retroativa com consumidores existentes
    fatorEmocional:          emocAplicado ? 'seletivo' : 'nenhum',
    fatorAplicado:           emocAplicado,
    prioridade,
    prioridade_operacional:  _resolverPrioridadeOperacional(dose_final),
    // pos-jogo no topo do racional (contexto mais imediato), sinais a seguir
    racional_curto:          _pjRacional ? [_pjRacional, ..._gerarRacionalCurto(sev)] : _gerarRacionalCurto(sev),
    restricoes:              _gerarRestricoes(dose_final),
    histerese:               histerese_info,
    encaminhamento,
    rtp: {
      ativo:                        faseRTP != null,
      fase:                         faseRTP != null ? `F${faseRTP}` : null,
      restricao_minima:             faseRTP != null ? RTP_RESTRICOES[faseRTP] : null,
      motor_aplicado_dentro_da_fase: faseRTP != null,
    },
    pos_jogo: {
      ativo:            _pjAtivo,
      md:               contextoJogo?.mdPos != null ? `MD+${contextoJogo.mdPos}` : null,
      minutos_jogados:  contextoJogo?.minutosJogados ?? null,
      faixa:            _pjFaixa,
      restricao_minima: _pjAtivo && POS_JOGO_RESTRICOES[contextoJogo.mdPos]
        ? POS_JOGO_RESTRICOES[contextoJogo.mdPos][_pjFaixa]
        : null,
    },
  };
}

// ── Classificação ISP para sinaisRaw (upstream do motor) ──────────────────────
// Converte o retorno de calcularISPTendencia em {classe, severidade}.
// Parâmetros calibráveis em PARAMS.ISP_*.
export function classificarISPParaMotor(ispTendencia) {
  if (!ispTendencia) return { classe: 'sem_dados', severidade: 0 };
  const slopeNorm  = ispTendencia._score     ?? null;
  const r2         = ispTendencia._r2        ?? 1;
  const nRegistros = ispTendencia._nRegistros ?? 0;

  if (slopeNorm == null || slopeNorm >= PARAMS.ISP_QUEDA_FRACA) {
    return { classe: 'estavel_ou_positivo', severidade: 0 };
  }
  // Dados insuficientes ou r² muito baixo: inconclusivo, sem penalidade
  if (nRegistros < PARAMS.ISP_MIN_PONTOS || r2 < PARAMS.ISP_R2_SEV1_MIN) {
    return { classe: 'dados_insuficientes', severidade: 0 };
  }
  // Queda fraca: slope fraco OU r² abaixo do limiar de sev2
  if (slopeNorm >= PARAMS.ISP_QUEDA_FORTE || r2 < PARAMS.ISP_R2_MIN) {
    return { classe: 'queda_fraca', severidade: 1 };
  }
  return { classe: 'queda_consistente', severidade: 2 };
}

// IGP absoluto a partir dos 4 componentes (espelha fórmula de calcularProntidao)
function _calcAbsIGP(iH, iA, iNM, iC) {
  const vals = [iH, iA, iNM, iC].filter(v => v != null);
  if (!vals.length) return null;
  const media = vals.reduce((a, b) => a + b, 0) / vals.length;
  const pior  = Math.max(Math.min(...vals), 30);
  return Math.round((media * 0.8 + pior * 0.2) * 10) / 10;
}

// ── Computar inputs do motor a partir dos dados brutos do atleta ──────────────
// dm: documento daily_metrics de hoje (pode ser null se sem dados no dia)
// historico: array de daily_metrics (todos os dias anteriores do atleta/clube)
// hoje: string 'YYYY-MM-DD'
//
// NOTA v1: pre.dor é a subescala Hooper (1-7). Mapeada para EVA (0-6) por
// proximidade clínica. Um campo eva (0-10) separado em coleta_pre daria mais
// granularidade — adicionar em v1.1.
export function computeMotorInputs(dm, historico, hoje) {
  const athleteId = dm?.athleteId ?? null;
  const pre       = dm?.pre  ?? {};
  const hrv       = dm?.hrv  ?? {};
  const neuro     = dm?.neuro ?? {};

  const ia_z  = zRawVFC(athleteId, hrv.lnRR      ?? null, historico, hoje);
  const inm_z = zRawCMJ(athleteId, pre.salto      ?? null, historico, hoje);
  const ih_z  = zRawHooper(athleteId, pre.hooper  ?? null, historico, hoje);
  const ic_z  = zRawNeuro(athleteId, neuro.score  ?? null, historico, hoje);

  const ispTendencia = calcularISPTendencia(athleteId, historico, hoje);
  const isp          = classificarISPParaMotor(ispTendencia);

  const acwr = calcularACWR(athleteId, historico, hoje);
  const dai  = calcularDAI(athleteId, historico, hoje);

  // Hooper dor (1-7) → EVA-like (0-6): 1=sem dor→0, 7=intensa→6
  const dorHooper = pre.dor ?? null;
  const eva       = dorHooper != null ? Math.max(0, dorHooper - 1) : 0;
  const local     = Array.isArray(pre.regioes_dor) && pre.regioes_dor.length > 0
    ? pre.regioes_dor.join(', ')
    : null;

  // ── Scores absolutos iGP (fallback para z≈0 em atletas cronicamente baixos) ──
  // Espelha as fórmulas de calcularProntidao em dashboard.js.
  const _clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // iH: Hooper sumado (4-28) → 0-100 (inverso: maior hooper = pior)
  const absIH = pre.hooper != null
    ? _clamp(Math.round(100 - ((pre.hooper - 4) / 24 * 100)), 0, 100)
    : null;

  // Severidade por componente individual: sono ou fadiga isolados em 6-7
  // captura o caso "um indicador crítico + outros normais" que o total dilui
  const sevComponenteIH = (() => {
    const s = pre.sono   ?? 0;
    const f = pre.fadiga ?? 0;
    if (s === 7 || f === 7) return 2;
    if (s >= 6  || f >= 6)  return 1;
    return 0;
  })();

  // iC: NeuroScore já é 0-100
  const absIC = neuro.score != null ? _clamp(neuro.score, 0, 100) : null;

  // iA: escala absoluta lnRR (piecewise, calibrada em dashboard.js)
  const absIA = (() => {
    const ln = hrv.lnRR ?? null;
    if (ln == null) return null;
    let s;
    if      (ln < 2.5) s = 5  + (ln - 1.5) * 30;
    else if (ln < 3.0) s = 35 + (ln - 2.5) * 30;
    else if (ln < 3.5) s = 50 + (ln - 3.0) * 30;
    else if (ln < 4.0) s = 65 + (ln - 3.5) * 30;
    else if (ln < 4.5) s = 80 + (ln - 4.0) * 24;
    else               s = 92 + Math.min((ln - 4.5) * 5, 5);
    return Math.round(_clamp(s, 5, 97));
  })();

  // iNM: usa a mesma função do dashboard para garantir alinhamento
  // (z-score 60% + % melhor 30d 40%, com fallback absoluto quando histórico insuficiente)
  const absINM = calcularZScoreCMJ(athleteId, pre.salto ?? null, pre.dor ?? null, historico, hoje);

  return {
    ia:    { z: ia_z  },
    inm:   { z: inm_z },
    ih:    { z: ih_z, sevComponente: sevComponenteIH },
    ic:    { z: ic_z  },
    isp,
    carga: { acwr, dai },
    dor:   { local, eva },
    humor: pre.humorEmocional ?? null,
    absScores: { iH: absIH, iA: absIA, iNM: absINM, iC: absIC, iGP: _calcAbsIGP(absIH, absIA, absINM, absIC) },
  };
}

// ── compute-if-missing — ponto de entrada client-side ────────────────────────
// Roda na abertura do dashboard/relatório.
// Para cada atleta do dia: se o objeto ainda não existe no Firestore, computa e persiste.
// estadoHisterese e faseRTP são lidos do Firestore (rtp_progress + motor_state).
//
// db: instância Firestore (firebase-firestore)
// atletas: array [{id, nome, ...}]
// daily: array de daily_metrics do dia (já carregado)
// historico: array de daily_metrics histórico (já carregado)
// hoje: 'YYYY-MM-DD'
// clubId: string
import {
  doc, getDoc, setDoc, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js';

export async function computeIfMissing({ db, atletas, daily, historico, hoje, clubId, rtpProgressMap, contextoJogoMap }) {
  // 1. Lê todos os daily_recommendations em paralelo
  const snaps = await Promise.all(
    atletas.map(a => getDoc(doc(db, 'daily_recommendations', `${a.id}_${hoje}`)))
  );

  const cached   = [];
  const pendentes = []; // { atleta, idx }

  snaps.forEach((snap, idx) => {
    if (snap.exists()) {
      // Recomputa se: versão do engine mudou, ou dados do atleta foram atualizados após o cache.
      const snapData     = snap.data();
      const dmToday      = daily.find(d => d.athleteId === atletas[idx].id) ?? null;
      const computedAt   = snapData._computedAt?.toDate?.() ?? null;
      const dmUpdatedAt  = dmToday?.meta?.updatedAt?.toDate?.() ?? null;
      const versaoOk     = snapData._engineVersion === ENGINE_VERSION;
      const dadosOk      = dmToday == null
        || (computedAt != null && dmUpdatedAt != null && dmUpdatedAt <= computedAt);
      // Invalida cache se pós-jogo agora está ativo mas o cache foi salvo sem ele
      const ctxJogo      = contextoJogoMap?.[atletas[idx].id] ?? null;
      const posJogoAgora = ctxJogo?.mdPos != null && (ctxJogo?.minutosJogados ?? 0) > 0;
      const posJogoOk    = !posJogoAgora || (snapData.pos_jogo?.ativo === true);
      if (versaoOk && dadosOk && posJogoOk) {
        cached.push({ atletaId: atletas[idx].id, status: 'cached', data: snapData });
      } else {
        pendentes.push({ atleta: atletas[idx] }); // versão ou dados desatualizados → recomputa
      }
    } else {
      pendentes.push({ atleta: atletas[idx] });
    }
  });

  if (!pendentes.length) return cached;

  // 2. Lê todos os motor_state dos pendentes em paralelo
  const stateSnaps = await Promise.all(
    pendentes.map(({ atleta }) =>
      getDoc(doc(db, 'motor_state', `${clubId}_${atleta.id}`)).catch(() => null)
    )
  );

  // 3. Computa todos os motores (CPU — sem I/O)
  const outputs = pendentes.map(({ atleta }, i) => {
    const dm             = daily.find(d => d.athleteId === atleta.id) ?? null;
    const sinaisRaw      = computeMotorInputs(dm, historico, hoje);
    const snap           = stateSnaps[i];
    const estadoHisterese = snap?.exists() ? (snap.data().histerese ?? null) : null;
    const faseRTP        = rtpProgressMap?.[atleta.id]  ?? null;
    const contextoJogo   = contextoJogoMap?.[atleta.id] ?? null;

    const output = runMotor({
      atletaId: atleta.id, nome: atleta.nome, clubId,
      data: hoje, sinaisRaw, estadoHisterese, faseRTP, contextoJogo,
    });
    return { atleta, output };
  });

  // 4. Persiste tudo em paralelo (recomendações + motor_state)
  await Promise.all(outputs.flatMap(({ atleta, output }) => {
    const novoEstado = {};
    for (const eixo of EIXOS_PIPELINE) {
      novoEstado[eixo] = {
        faixaAtual:  output.eixos[eixo].dose_pos_histerese,
        faixaBruta:  output.eixos[eixo].dose_bruta,
        diasEstavel: output.eixos[eixo].diasEstavel_novo,
      };
    }
    return [
      setDoc(doc(db, 'daily_recommendations', `${atleta.id}_${hoje}`),
             { ...output, _computedAt: serverTimestamp(), _engineVersion: ENGINE_VERSION }),
      setDoc(doc(db, 'motor_state', `${clubId}_${atleta.id}`),
             { clubId, histerese: novoEstado, updatedAt: serverTimestamp() },
             { merge: true }),
    ];
  }));

  const computados = outputs.map(({ atleta, output }) => ({
    atletaId: atleta.id, status: 'computed', data: output,
  }));

  return [...cached, ...computados];
}
