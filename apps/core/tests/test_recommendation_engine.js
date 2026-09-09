// apps/core/tests/test_recommendation_engine.js
// TDD: testes escritos ANTES da implementação (seção 12 + caso de integração seção 13).
// Roda em browser via index.html. Sem framework — usa runner.js local.
//
// Cobertura por etapa:
//   Etapa 1 — severidadeSinal  (seção 3)
//   Etapa 2 — escoreEixos / scoreToDose  (seções 4-5-7)
//   Etapa 3 — overrides  (seção 6)
//   Etapa 4 — histerese  (seção 7)
//   Etapa 5 — aplicarRTP  (seção 8)
//   Etapa 6 — resolverPrioridade + templates  (seção 9)
//   Integração — caso completo da seção 13

import { test, expect, summary } from './runner.js';
import {
  // Pipeline steps (prefixo _ = exportados só para testes)
  _severidadeZ,
  _severidadeDor,
  _severidadeCarga,
  _severidadeISP,
  _escoreEixos,
  _scoreToDose,
  _maisConservadora,
  _overrides,
  _histerese,
  _aplicarRTP,
  _aplicarPosJogo,
  _resolverPrioridade,
  _gerarRacionalCurto,
  _gerarRestricoes,
  // Adição emocional (v2.0)
  calcAdicaoEmocional,
  // Ponto de entrada
  runMotor,
  // Config (para inspeção nos testes)
  PARAMS,
  RTP_RESTRICOES,
  POS_JOGO_RESTRICOES,
  AXIS_MAX,
} from '../recommendation_engine.js';

// ─────────────────────────────────────────────────────────────────────────────
// ETAPA 1 — severidadeZ / severidadeDor / severidadeCarga / severidadeISP
// ─────────────────────────────────────────────────────────────────────────────

test('severidadeZ: z ≥ -1 → 0 (fronteira -1.0 inclusive)', () => {
  expect(_severidadeZ(0)).toBe(0);
  expect(_severidadeZ(-0.9)).toBe(0);
  expect(_severidadeZ(-1.0)).toBe(0);  // -1.0 ≥ -1 → 0 (range superior vence)
});

test('severidadeZ: -2 < z < -1 → 1 (fronteiras excluídas)', () => {
  expect(_severidadeZ(-1.1)).toBe(1);
  expect(_severidadeZ(-1.9)).toBe(1);
  // -2.0 pertence a z ≤ -2 → sev 2, não testado aqui
});

test('severidadeZ: z < -2 → 2', () => {
  expect(_severidadeZ(-2.1)).toBe(2);
  expect(_severidadeZ(-3.5)).toBe(2);
});

test('severidadeZ: null → 0 (dado ausente = conservador por omissão)', () => {
  expect(_severidadeZ(null)).toBe(0);
});

test('severidadeDor: eva 0 → 0', () => {
  expect(_severidadeDor(0)).toBe(0);
  expect(_severidadeDor(null)).toBe(0);
});

test('severidadeDor: eva 1-3 → 1', () => {
  expect(_severidadeDor(1)).toBe(1);
  expect(_severidadeDor(3)).toBe(1);
});

test('severidadeDor: eva ≥ 4 → 2', () => {
  expect(_severidadeDor(4)).toBe(2);
  expect(_severidadeDor(10)).toBe(2);
});

test('severidadeCarga: ACWR ≤ 1.3 sem DAI → 0', () => {
  expect(_severidadeCarga(1.2, null)).toBe(0);
  expect(_severidadeCarga(1.3, null)).toBe(0);
});

test('severidadeCarga: ACWR 1.31-1.5 → 1', () => {
  expect(_severidadeCarga(1.4, null)).toBe(1);
  expect(_severidadeCarga(1.5, null)).toBe(1);
});

test('severidadeCarga: ACWR > 1.5 sem DAI → 1 (não mais sev2, exige corroboração)', () => {
  expect(_severidadeCarga(1.51, null)).toBe(1);
  expect(_severidadeCarga(2.0, null)).toBe(1);
});

test('severidadeCarga: ACWR > 1.5 com DAI corroborando (ratioCarga > DAI_CARGA_SEV1) → 2', () => {
  const daiMod = { ratioCarga: 4.5, ratioTempo: null }; // > PARAMS.DAI_CARGA_SEV1=4.0
  expect(_severidadeCarga(1.51, daiMod)).toBe(2);
});

test('severidadeCarga: ACWR > 1.5 com DAI baixo → 1 (sem corroboração)', () => {
  const daiBaixo = { ratioCarga: 2.0, ratioTempo: 2.0 }; // abaixo dos limiares SEV1
  expect(_severidadeCarga(1.51, daiBaixo)).toBe(1);
});

test('severidadeCarga: DAI sozinho (sem ACWR) → severidade por DAI', () => {
  const daiAlto = { ratioCarga: 6.0, ratioTempo: null }; // > DAI_CARGA_SEV2=5.5
  expect(_severidadeCarga(null, daiAlto)).toBe(2);
});

test('severidadeISP: estável/positivo → 0', () => {
  expect(_severidadeISP({ classe: 'estavel_ou_positivo', severidade: 0 })).toBe(0);
  expect(_severidadeISP(null)).toBe(0);
});

test('severidadeISP: queda_fraca → 1', () => {
  expect(_severidadeISP({ classe: 'queda_fraca', severidade: 1 })).toBe(1);
});

test('severidadeISP: queda_consistente → 2', () => {
  expect(_severidadeISP({ classe: 'queda_consistente', severidade: 2 })).toBe(2);
});

// ─────────────────────────────────────────────────────────────────────────────
// ETAPA 2 — escoreEixos + scoreToDose
// ─────────────────────────────────────────────────────────────────────────────

// Fixture: severidades do caso de integração da seção 13
const SEV_SEC13 = {
  ia:    { z: -2.1, severidade: 2 },
  inm:   { z: -0.6, severidade: 0 },
  ih:    { z: -1.1, severidade: 1 },
  ic:    { z: -0.3, severidade: 0 },
  isp:   { classe: 'queda_fraca', severidade: 1 },
  carga: { acwr: 1.40, dai: null, severidade: 1 },
  dor:   { local: 'posterior', eva: 2, severidade: 1 },
};

test('escoreEixos: seção 13 → volume=4, intensidade=6, densidade=6, carga_mecanica=2', () => {
  const escores = _escoreEixos(SEV_SEC13);
  expect(escores.volume).toBe(4);
  expect(escores.intensidade).toBe(6);
  expect(escores.densidade).toBe(6);
  expect(escores.carga_mecanica).toBe(2);
});

test('scoreToDose: ratio 0 → manter', () => {
  expect(_scoreToDose(0)).toBe('manter');
});

test('scoreToDose: ratio 0.19 → manter, 0.20 → leve', () => {
  expect(_scoreToDose(0.19)).toBe('manter');
  expect(_scoreToDose(0.20)).toBe('leve');
});

test('scoreToDose: ratio 0.39 → leve, 0.40 → moderado', () => {
  expect(_scoreToDose(0.39)).toBe('leve');
  expect(_scoreToDose(0.40)).toBe('moderado');
});

test('scoreToDose: ratio 0.59 → moderado, 0.60 → forte', () => {
  expect(_scoreToDose(0.59)).toBe('moderado');
  expect(_scoreToDose(0.60)).toBe('forte');
});

test('scoreToDose: ratio 1.0 → forte', () => {
  expect(_scoreToDose(1.0)).toBe('forte');
});

test('scoreToDose: com doteLevePct = 0.30 (gate IGP alta prontidão)', () => {
  expect(_scoreToDose(0.25, 0.30)).toBe('manter');
  expect(_scoreToDose(0.30, 0.30)).toBe('leve');
});

test('maisConservadora: manter < leve < moderado < forte', () => {
  expect(_maisConservadora('manter', 'forte')).toBe('forte');
  expect(_maisConservadora('moderado', 'leve')).toBe('moderado');
  expect(_maisConservadora('forte', 'forte')).toBe('forte');
  expect(_maisConservadora('manter', 'manter')).toBe('manter');
});

// ─────────────────────────────────────────────────────────────────────────────
// ETAPA 3 — overrides (seção 6)
// ─────────────────────────────────────────────────────────────────────────────

test('overrides: dor EVA < 4 → sem encaminhamento, sem alteração em carga_mecanica', () => {
  const sev = { ...SEV_SEC13 };  // eva = 2
  const doses = { volume: 'moderado', intensidade: 'forte', densidade: 'forte', carga_mecanica: 'leve' };
  const { doses: resultado, escalas_imediatas, encaminhamento } = _overrides(sev, doses);
  expect(encaminhamento).toBe(false);
  expect(resultado.carga_mecanica).toBe('leve');  // sem alteração
});

test('overrides: dor EVA ≥ 4 → encaminhamento + carga_mecanica ≥ moderado', () => {
  const sev = { ...SEV_SEC13, dor: { local: 'joelho', eva: 5, severidade: 2 } };
  const doses = { volume: 'leve', intensidade: 'leve', densidade: 'leve', carga_mecanica: 'manter' };
  const { doses: resultado, encaminhamento } = _overrides(sev, doses);
  expect(encaminhamento).toBe(true);
  expect(_maisConservadora(resultado.carga_mecanica, 'moderado')).toBe(resultado.carga_mecanica);
});

test('overrides: IA sev2 → escalas_imediatas contém intensidade e densidade', () => {
  const sev = { ...SEV_SEC13 };  // ia.severidade = 2
  const doses = { volume: 'moderado', intensidade: 'forte', densidade: 'forte', carga_mecanica: 'leve' };
  const { escalas_imediatas } = _overrides(sev, doses);
  expect([...escalas_imediatas].includes('intensidade')).toBe(true);
  expect([...escalas_imediatas].includes('densidade')).toBe(true);
});

test('overrides: INM sev2 → escalas_imediatas contém APENAS carga_mecanica (intensidade removida)', () => {
  const sev = { ...SEV_SEC13, inm: { z: -2.5, severidade: 2 } };
  const doses = { volume: 'leve', intensidade: 'leve', densidade: 'leve', carga_mecanica: 'leve' };
  const { escalas_imediatas } = _overrides(sev, doses);
  expect([...escalas_imediatas].includes('carga_mecanica')).toBe(true);
  expect([...escalas_imediatas].includes('intensidade')).toBe(false); // v2.0: iNM não afeta intensidade metabólica
});

test('overrides: IA sev1 (não sev2) → sem escala imediata por IA', () => {
  const sev = { ...SEV_SEC13, ia: { z: -1.5, severidade: 1 } };
  const doses = { volume: 'leve', intensidade: 'leve', densidade: 'leve', carga_mecanica: 'leve' };
  const { escalas_imediatas } = _overrides(sev, doses);
  // Nenhuma escala imediata por IA (só dor.sev=1, que não aciona)
  expect([...escalas_imediatas].includes('intensidade')).toBe(false);
});

// ─────────────────────────────────────────────────────────────────────────────
// ETAPA 4 — histerese (seção 7)
// ─────────────────────────────────────────────────────────────────────────────

// Estado ontem do caso de integração da seção 13
const ESTADO_ONTEM_SEC13 = {
  volume:         { faixaAtual: 'leve',   faixaBruta: 'leve',   diasEstavel: 0 },
  intensidade:    { faixaAtual: 'leve',   faixaBruta: null,     diasEstavel: 0 },
  densidade:      { faixaAtual: 'leve',   faixaBruta: null,     diasEstavel: 0 },
  carga_mecanica: { faixaAtual: 'manter', faixaBruta: 'manter', diasEstavel: 0 },
};

test('histerese: escalada em 1º dia → segura na faixa atual (leve, sem corroboração)', () => {
  // volume: bruta=moderado, ontem atual=leve, ontem bruta=leve → leve < moderado → 1º dia → segura
  // nSistemasAlterados=1 (< 2, sem corroboração) → exige 2º dia
  const doses = { volume: 'moderado', intensidade: 'leve', densidade: 'leve', carga_mecanica: 'leve' };
  const { doses: resultado } = _histerese(doses, new Set(), ESTADO_ONTEM_SEC13, 1);
  expect(resultado.volume).toBe('leve');
});

test('histerese: escalada em 2º dia consecutivo → sobe', () => {
  // 2º dia: ontem bruta >= faixa alvo
  const estado2doDia = {
    volume: { faixaAtual: 'leve', faixaBruta: 'moderado', diasEstavel: 0 },
  };
  const doses = { volume: 'moderado', intensidade: 'manter', densidade: 'manter', carga_mecanica: 'manter' };
  const { doses: resultado } = _histerese(doses, new Set(), estado2doDia, 0);
  expect(resultado.volume).toBe('moderado');
});

test('histerese: desescalada de leve → imediata', () => {
  const estadoLeve = { volume: { faixaAtual: 'leve', faixaBruta: 'leve', diasEstavel: 0 } };
  const doses = { volume: 'manter', intensidade: 'manter', densidade: 'manter', carga_mecanica: 'manter' };
  const { doses: resultado } = _histerese(doses, new Set(), estadoLeve, 0);
  expect(resultado.volume).toBe('manter'); // desescalada de leve é imediata
});

test('histerese: desescalada de forte → aguarda 1º dia', () => {
  const estadoForte = { volume: { faixaAtual: 'forte', faixaBruta: 'forte', diasEstavel: 0 } };
  const doses = { volume: 'manter', intensidade: 'manter', densidade: 'manter', carga_mecanica: 'manter' };
  const { doses: resultado } = _histerese(doses, new Set(), estadoForte, 0);
  expect(resultado.volume).toBe('forte'); // aguarda confirmação
});

test('histerese: desescalada de forte → desce 1 nível no 2º dia (diasEstavel=1)', () => {
  const estadoForte = { volume: { faixaAtual: 'forte', faixaBruta: 'manter', diasEstavel: 1 } };
  const doses = { volume: 'manter', intensidade: 'manter', densidade: 'manter', carga_mecanica: 'manter' };
  const { doses: resultado } = _histerese(doses, new Set(), estadoForte, 0);
  expect(resultado.volume).toBe('moderado'); // step-by-step: forte → moderado
});

test('histerese: escalada moderado → imediata com corroboração (nSistemas≥2)', () => {
  const estado = { volume: { faixaAtual: 'leve', faixaBruta: 'leve', diasEstavel: 0 } };
  const doses  = { volume: 'moderado', intensidade: 'manter', densidade: 'manter', carga_mecanica: 'manter' };
  const { doses: resultado } = _histerese(doses, new Set(), estado, 2);
  expect(resultado.volume).toBe('moderado'); // imediata com corroboração
});

test('histerese: escalada moderado → aguarda sem corroboração (nSistemas<2)', () => {
  const estado = { volume: { faixaAtual: 'leve', faixaBruta: 'leve', diasEstavel: 0 } };
  const doses  = { volume: 'moderado', intensidade: 'manter', densidade: 'manter', carga_mecanica: 'manter' };
  const { doses: resultado } = _histerese(doses, new Set(), estado, 1);
  expect(resultado.volume).toBe('leve'); // aguarda 2º dia
});

test('histerese: novosEstados registra diasEstavel correto', () => {
  // Primeiro dia com pressão de desescalada de forte → diasEstavel=1
  const estadoForte = { volume: { faixaAtual: 'forte', faixaBruta: 'forte', diasEstavel: 0 } };
  const doses = { volume: 'manter', intensidade: 'manter', densidade: 'manter', carga_mecanica: 'manter' };
  const { novosEstados } = _histerese(doses, new Set(), estadoForte, 0);
  expect(novosEstados.volume.diasEstavel).toBe(1);
});

test('histerese: escala imediata fura a janela de 2 dias (IA sev2 → intensidade e densidade)', () => {
  // Caso seção 13: intensidade/densidade em escalas_imediatas, bruta=forte
  const doses = { volume: 'moderado', intensidade: 'forte', densidade: 'forte', carga_mecanica: 'leve' };
  const escalas_imediatas = new Set(['intensidade', 'densidade']);
  const { doses: resultado } = _histerese(doses, escalas_imediatas, ESTADO_ONTEM_SEC13, 0);
  expect(resultado.intensidade).toBe('forte');  // bypass → sobe no mesmo dia
  expect(resultado.densidade).toBe('forte');    // bypass → sobe no mesmo dia
});

test('histerese: carga_mecanica sem escala imediata → segura (1º dia, bruta > atual)', () => {
  // bruta=leve > faixaAtual=manter, ontem bruta=manter < leve → 1º dia → segura em manter
  // nSistemas=1 (< 2, sem corroboração para leve que não é modForte)
  const doses = { volume: 'manter', intensidade: 'manter', densidade: 'manter', carga_mecanica: 'leve' };
  const { doses: resultado } = _histerese(doses, new Set(), ESTADO_ONTEM_SEC13, 1);
  expect(resultado.carga_mecanica).toBe('manter');
});

test('histerese: sem estado ontem (null) → comportamento conservador', () => {
  const doses = { volume: 'leve', intensidade: 'manter', densidade: 'manter', carga_mecanica: 'manter' };
  const { doses: resultado } = _histerese(doses, new Set(), null);
  // volume: bruta=leve > manter(default), leve não é modForte (idx=1 < 2), exige 2º dia
  expect(resultado.volume).toBe('manter');
});

// ─────────────────────────────────────────────────────────────────────────────
// ETAPA 5 — aplicarRTP (seção 8)
// ─────────────────────────────────────────────────────────────────────────────

test('aplicarRTP: sem RTP → dose_final = dose_pos_histerese', () => {
  const dose = { volume: 'leve', intensidade: 'leve', densidade: 'manter', carga_mecanica: 'manter' };
  expect(_aplicarRTP(dose, null)).toEqual(dose);
});

test('aplicarRTP: RTP aperta (restricao mais conservadora vence)', () => {
  // volume: histerese=leve, restricao_F2=moderado → moderado vence
  const dose = { volume: 'leve', intensidade: 'forte', densidade: 'forte', carga_mecanica: 'manter' };
  const resultado = _aplicarRTP(dose, 2);  // fase F2
  expect(resultado.volume).toBe('moderado');          // F2 força moderado
  expect(resultado.intensidade).toBe('forte');        // forte > moderado(F2) → forte permanece
  expect(resultado.densidade).toBe('forte');          // forte > leve(F2) → forte permanece
  expect(resultado.carga_mecanica).toBe('forte');     // F2 força forte (> manter)
});

test('aplicarRTP: RTP nunca afrouxa (motor mais conservador prevalece)', () => {
  // Motor diz forte, F3 restringe leve → forte prevalece (mais conservador)
  const dose = { volume: 'forte', intensidade: 'forte', densidade: 'forte', carga_mecanica: 'forte' };
  const resultado = _aplicarRTP(dose, 3);  // fase F3
  expect(resultado.volume).toBe('forte');
  expect(resultado.carga_mecanica).toBe('forte');
});

test('aplicarRTP: F0 força forte em todos os eixos', () => {
  const dose = { volume: 'manter', intensidade: 'manter', densidade: 'manter', carga_mecanica: 'manter' };
  const resultado = _aplicarRTP(dose, 0);
  expect(resultado.volume).toBe('forte');
  expect(resultado.intensidade).toBe('forte');
  expect(resultado.densidade).toBe('forte');
  expect(resultado.carga_mecanica).toBe('forte');
});

// ─────────────────────────────────────────────────────────────────────────────
// ETAPA 6 — resolverPrioridade + templates (seção 9)
// ─────────────────────────────────────────────────────────────────────────────

test('resolverPrioridade: encaminhamento → protecao_tecidual', () => {
  const escores = { volume: 4, intensidade: 6, densidade: 6, carga_mecanica: 2 };
  expect(_resolverPrioridade(true, SEV_SEC13, escores)).toBe('protecao_tecidual');
});

test('resolverPrioridade: dor sev2 → protecao_tecidual', () => {
  const sevDorGrave = { ...SEV_SEC13, dor: { eva: 5, severidade: 2 } };
  const escores = { volume: 4, intensidade: 6, densidade: 6, carga_mecanica: 2 };
  expect(_resolverPrioridade(false, sevDorGrave, escores)).toBe('protecao_tecidual');
});

test('resolverPrioridade: maior escore vence; empate por precedência (carga_mecanica > volume > intensidade > densidade)', () => {
  // intensidade=6, densidade=6 → empate → intensidade vence por precedência
  const escores = { volume: 4, intensidade: 6, densidade: 6, carga_mecanica: 2 };
  expect(_resolverPrioridade(false, SEV_SEC13, escores)).toBe('intensidade');
});

test('resolverPrioridade: carga_mecanica maior escore → carga_mecanica', () => {
  const escores = { volume: 2, intensidade: 3, densidade: 3, carga_mecanica: 8 };
  expect(_resolverPrioridade(false, SEV_SEC13, escores)).toBe('carga_mecanica');
});

test('gerarRacionalCurto: inclui frase para cada sinal com sev ≥ 1', () => {
  const frases = _gerarRacionalCurto(SEV_SEC13);
  // ia sev2, ih sev1, isp sev1, carga sev1, dor sev1 → 5 frases; inm sev0, ic sev0 → sem frase
  expect(frases.length).toBe(5);
});

test('gerarRacionalCurto: dor inclui localização', () => {
  const frases = _gerarRacionalCurto(SEV_SEC13);
  const dorFrase = frases.find(f => f.toLowerCase().includes('dor'));
  expect(typeof dorFrase).toBe('string');
  expect(dorFrase.toLowerCase().includes('posterior')).toBe(true);
});

test('gerarRestricoes: só eixos com dose_final ≥ leve', () => {
  // Caso seção 13 dose_final: volume=moderado, intensidade=forte, densidade=moderado, carga_mecanica=forte
  const doseFinal = { volume: 'moderado', intensidade: 'forte', densidade: 'moderado', carga_mecanica: 'forte' };
  const restricoes = _gerarRestricoes(doseFinal);
  expect(restricoes.length).toBe(4);  // todos acima de manter
});

test('gerarRestricoes: eixo manter → sem restrição', () => {
  const doseFinal = { volume: 'manter', intensidade: 'manter', densidade: 'manter', carga_mecanica: 'manter' };
  const restricoes = _gerarRestricoes(doseFinal);
  expect(restricoes.length).toBe(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// ADIÇÃO EMOCIONAL — seletiva por eixo (v2.0)
// ─────────────────────────────────────────────────────────────────────────────

test('adicaoEmocional: humor null → zeros em todos os eixos', () => {
  const r = calcAdicaoEmocional(null);
  expect(r.volume).toBe(0); expect(r.intensidade).toBe(0);
  expect(r.densidade).toBe(0); expect(r.carga_mecanica).toBe(0);
});

test('adicaoEmocional: humor 1-2 → sem adição (baseline)', () => {
  expect(calcAdicaoEmocional(1).volume).toBe(0);
  expect(calcAdicaoEmocional(2).densidade).toBe(0);
});

test('adicaoEmocional: humor 3-4 → vol+0.5, dens+0.5, int=0, mec=0', () => {
  const r3 = calcAdicaoEmocional(3);
  expect(r3.volume).toBe(0.5); expect(r3.intensidade).toBe(0);
  expect(r3.densidade).toBe(0.5); expect(r3.carga_mecanica).toBe(0);
  const r4 = calcAdicaoEmocional(4);
  expect(r4.volume).toBe(0.5); expect(r4.densidade).toBe(0.5);
});

test('adicaoEmocional: humor 5-6 → vol+0.5, int+0.5, dens+1.0, mec=0', () => {
  const r = calcAdicaoEmocional(5);
  expect(r.volume).toBe(0.5); expect(r.intensidade).toBe(0.5);
  expect(r.densidade).toBe(1.0); expect(r.carga_mecanica).toBe(0);
});

test('adicaoEmocional: humor 7 → vol+1.0, int+0.5, dens+1.0, mec=0', () => {
  const r = calcAdicaoEmocional(7);
  expect(r.volume).toBe(1.0); expect(r.intensidade).toBe(0.5);
  expect(r.densidade).toBe(1.0); expect(r.carga_mecanica).toBe(0);
});

test('adicaoEmocional: carga_mecanica sempre 0 (qualquer humor)', () => {
  for (let h = 1; h <= 7; h++) expect(calcAdicaoEmocional(h).carga_mecanica).toBe(0);
});

test('runMotor: humor null → emocional_aplicado false', () => {
  const r = runMotor({ atletaId: 'x', nome: 'X', clubId: 'c', data: '2026-07-01',
    sinaisRaw: { ...SINAIS_NORMAIS, humor: null }, estadoHisterese: null, faseRTP: null });
  expect(r.emocional_aplicado).toBe(false);
  expect(r.fatorAplicado).toBe(false);
});

test('runMotor: humor 7 → emocional_aplicado true, carga_mecanica não afetada', () => {
  const r = runMotor({ atletaId: 'x', nome: 'X', clubId: 'c', data: '2026-07-01',
    sinaisRaw: { ...SINAIS_NORMAIS, humor: 7 }, estadoHisterese: null, faseRTP: null });
  expect(r.emocional_aplicado).toBe(true);
  expect(r.adicao_emocional.carga_mecanica).toBe(0);
});

test('runMotor: humor 5 → adição seletiva reflete nos escore_com_fator', () => {
  const r = runMotor({ atletaId: 'x', nome: 'X', clubId: 'c', data: '2026-07-01',
    sinaisRaw: { ...SINAIS_NORMAIS, humor: 5 }, estadoHisterese: null, faseRTP: null });
  // Com sinais normais (escores base = 0), a adição emocional torna escore_com_fator > escore
  if (r.eixos.volume.escore_com_fator < r.eixos.volume.escore) throw new Error('esperado volume escore_com_fator >= escore');
  expect(r.eixos.carga_mecanica.escore_com_fator).toBe(r.eixos.carga_mecanica.escore); // não afetado
});

// CA4: override duro (dor sev2 / EVA_ENCAMINHAMENTO) mantém precedência mesmo com humor 7
test('runMotor: humor 7 não rompe EVA_ENCAMINHAMENTO', () => {
  // dor EVA = 6 (>= EVA_SEV2=5 e EVA_ENCAMINHAMENTO=5) → encaminhamento + carga_mecanica ≥ moderado
  const r = runMotor({
    atletaId: 'x', nome: 'X', clubId: 'c', data: '2026-07-01',
    sinaisRaw: {
      ia: { z: 0 }, inm: { z: 0 }, ih: { z: 0 }, ic: { z: 0 },
      isp: { classe: 'estavel_ou_positivo', severidade: 0 },
      carga: { acwr: 1.0, dai: null },
      dor: { local: 'lombar', eva: 6 },
      humor: 7,
    },
    estadoHisterese: null, faseRTP: null,
  });
  expect(r.encaminhamento).toBe(true);
  // Override garante carga_mecanica ≥ moderado independentemente do fator
  const idxDoseFinal = ['manter','leve','moderado','forte'].indexOf(r.eixos.carga_mecanica.dose_final);
  if (idxDoseFinal < 2) throw new Error(`carga_mecanica deveria ser ≥ moderado, got ${r.eixos.carga_mecanica.dose_final}`);
});

// CA4: sev2 por IA → escala imediata bypass histerese mesmo com humor 7
test('runMotor: humor 7 não rompe escala imediata sev2 IA', () => {
  const estadoOntem = {
    intensidade: { faixaAtual: 'manter', faixaBruta: 'manter', diasEstavel: 0 },
    densidade:   { faixaAtual: 'manter', faixaBruta: 'manter', diasEstavel: 0 },
    volume:      { faixaAtual: 'manter', faixaBruta: 'manter', diasEstavel: 0 },
    carga_mecanica: { faixaAtual: 'manter', faixaBruta: 'manter', diasEstavel: 0 },
  };
  const r = runMotor({
    atletaId: 'x', nome: 'X', clubId: 'c', data: '2026-07-01',
    sinaisRaw: {
      ia: { z: -2.5 }, inm: { z: 0 }, ih: { z: 0 }, ic: { z: 0 },
      isp: { classe: 'estavel_ou_positivo', severidade: 0 },
      carga: { acwr: 1.0, dai: null },
      dor: { local: null, eva: 0 },
      humor: 7,
    },
    estadoHisterese: estadoOntem, faseRTP: null,
  });
  // IA sev2 → escala imediata em intensidade e densidade (bypass histerese)
  expect(['leve','moderado','forte'].includes(r.eixos.intensidade.dose_pos_histerese)).toBe(true);
  expect(['leve','moderado','forte'].includes(r.eixos.densidade.dose_pos_histerese)).toBe(true);
});

// CA5: histerese continua aplicada após o fator (fator não bypassa histerese)
test('runMotor: histerese aplicada após o fator (escalada requer 2 dias consecutivos)', () => {
  // Atleta em manter ontem, humor 7 hoje. Escores inflados, mas histerese ainda exige 2 dias.
  const estadoOntem = {
    volume:         { faixaAtual: 'manter', faixaBruta: 'manter', diasEstavel: 0 },
    intensidade:    { faixaAtual: 'manter', faixaBruta: 'manter', diasEstavel: 0 },
    densidade:      { faixaAtual: 'manter', faixaBruta: 'manter', diasEstavel: 0 },
    carga_mecanica: { faixaAtual: 'manter', faixaBruta: 'manter', diasEstavel: 0 },
  };
  const r = runMotor({
    atletaId: 'x', nome: 'X', clubId: 'c', data: '2026-07-01',
    sinaisRaw: {
      // IA sev1 apenas (não sev2 → sem escala imediata)
      ia: { z: -1.5 }, inm: { z: 0 }, ih: { z: 0 }, ic: { z: 0 },
      isp: { classe: 'estavel_ou_positivo', severidade: 0 },
      carga: { acwr: 1.0, dai: null },
      dor: { local: null, eva: 0 },
      humor: 7,
    },
    estadoHisterese: estadoOntem, faseRTP: null,
  });
  // Mesmo com humor 7, sem ontem confirmando, histerese segura a escalada
  // (1 sistema alterado = nSistemasAlterados=1 → sem corroboração para mod/forte imediato)
  expect(r.eixos.intensidade.dose_pos_histerese).toBe('manter');
  expect(r.eixos.densidade.dose_pos_histerese).toBe('manter');
  // Mas emocional_aplicado deve refletir o fator aplicado
  expect(r.emocional_aplicado).toBe(true);
  expect(r.fatorAplicado).toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────────
// INTEGRAÇÃO — caso completo da seção 13
// Atleta em RTP F2, com estado de histerese conforme tabela do spec.
// Escores (inalterados): volume=4, intensidade=6, densidade=6, carga_mecanica=2
//
// Dose_bruta com normalização (AXIS_MAX):
//   volume:         4/8=0.50  → moderado  (0.40≤x<0.60)
//   intensidade:    6/10=0.60 → forte     (x≥0.60)
//   densidade:      6/12=0.50 → moderado  (v2: não mais forte)
//   carga_mecanica: 2/8=0.25  → leve      (0.20≤x<0.40)
//
// SEV_SEC13: ia(sev2)+ih(sev1)+isp(sev1)+carga(sev1)+dor(sev1) = 5 sinais → corroboração ativa
//
// Dose_pos_histerese:
//   volume:         bruta=mod(2), atual=leve(1) → escalada, ehModForte=true, corroboração → IMEDIATO → moderado
//   intensidade:    escala_imediata(ia sev2) → forte
//   densidade:      bruta=mod(2), atual=leve(1) → escalada, ehModForte=true, corroboração → IMEDIATO → moderado
//   carga_mecanica: bruta=leve(1), atual=manter(0) → escalada, ehModForte=false → sem corroboração para leve → aguarda → manter
//
// Dose_pos_rtp (F2): moderado(vol vs F2=mod=mod), forte(int vs F2=mod=forte), moderado(den vs F2=leve=mod), forte(mec vs F2=forte=forte)
// Dose_final = dose_pos_rtp (sem pós-jogo):
//   volume=moderado, intensidade=forte, densidade=moderado, carga_mecanica=forte
// ─────────────────────────────────────────────────────────────────────────────

test('INTEGRAÇÃO seção 13: escores corretos', () => {
  const resultado = runMotor({
    atletaId:       'atleta_teste_13',
    nome:           'Atleta Teste',
    clubId:         'clube_teste',
    data:           '2026-06-16',
    sinaisRaw: {
      ia:    { z: -2.1 },
      inm:   { z: -0.6 },
      ih:    { z: -1.1 },
      ic:    { z: -0.3 },
      isp:   { classe: 'queda_fraca', severidade: 1 },
      carga: { acwr: 1.40, dai: null },
      dor:   { local: 'posterior', eva: 2 },
    },
    estadoHisterese: ESTADO_ONTEM_SEC13,
    faseRTP: 2,
  });
  expect(resultado.eixos.volume.escore).toBe(4);
  expect(resultado.eixos.intensidade.escore).toBe(6);
  expect(resultado.eixos.densidade.escore).toBe(6);
  expect(resultado.eixos.carga_mecanica.escore).toBe(2);
});

test('INTEGRAÇÃO seção 13: dose_bruta correta (normalizada)', () => {
  const resultado = runMotor({
    atletaId: 'atleta_teste_13', nome: 'Atleta Teste', clubId: 'clube_teste', data: '2026-06-16',
    sinaisRaw: {
      ia:    { z: -2.1 }, inm: { z: -0.6 }, ih: { z: -1.1 }, ic: { z: -0.3 },
      isp:   { classe: 'queda_fraca', severidade: 1 },
      carga: { acwr: 1.40, dai: null },
      dor:   { local: 'posterior', eva: 2 },
    },
    estadoHisterese: ESTADO_ONTEM_SEC13, faseRTP: 2,
  });
  expect(resultado.eixos.volume.dose_bruta).toBe('moderado');       // 4/8=0.50
  expect(resultado.eixos.intensidade.dose_bruta).toBe('forte');     // 6/10=0.60
  expect(resultado.eixos.densidade.dose_bruta).toBe('moderado');    // 6/12=0.50 (v2: não mais forte)
  expect(resultado.eixos.carga_mecanica.dose_bruta).toBe('leve');   // 2/8=0.25
});

test('INTEGRAÇÃO seção 13: histerese com corroboração — volume e densidade escalam imediatamente', () => {
  // 5 sistemas alterados → corroboração → volume e densidade sobem imediatamente para moderado
  const resultado = runMotor({
    atletaId: 'atleta_teste_13', nome: 'Atleta Teste', clubId: 'clube_teste', data: '2026-06-16',
    sinaisRaw: {
      ia:    { z: -2.1 }, inm: { z: -0.6 }, ih: { z: -1.1 }, ic: { z: -0.3 },
      isp:   { classe: 'queda_fraca', severidade: 1 },
      carga: { acwr: 1.40, dai: null },
      dor:   { local: 'posterior', eva: 2 },
    },
    estadoHisterese: ESTADO_ONTEM_SEC13, faseRTP: 2,
  });
  expect(resultado.eixos.volume.dose_pos_histerese).toBe('moderado');
  expect(resultado.eixos.densidade.dose_pos_histerese).toBe('moderado');
});

test('INTEGRAÇÃO seção 13: (a) carga_mecanica segura no 1º dia de escalada leve', () => {
  // carga_mecanica: bruta=leve, não é modForte → sem corroboração para leve → aguarda
  const resultado = runMotor({
    atletaId: 'atleta_teste_13', nome: 'Atleta Teste', clubId: 'clube_teste', data: '2026-06-16',
    sinaisRaw: {
      ia:    { z: -2.1 }, inm: { z: -0.6 }, ih: { z: -1.1 }, ic: { z: -0.3 },
      isp:   { classe: 'queda_fraca', severidade: 1 },
      carga: { acwr: 1.40, dai: null },
      dor:   { local: 'posterior', eva: 2 },
    },
    estadoHisterese: ESTADO_ONTEM_SEC13, faseRTP: 2,
  });
  expect(resultado.eixos.carga_mecanica.dose_pos_histerese).toBe('manter');
});

test('INTEGRAÇÃO seção 13: (b) escala imediata via sev2 IA → intensidade forte', () => {
  const resultado = runMotor({
    atletaId: 'atleta_teste_13', nome: 'Atleta Teste', clubId: 'clube_teste', data: '2026-06-16',
    sinaisRaw: {
      ia:    { z: -2.1 }, inm: { z: -0.6 }, ih: { z: -1.1 }, ic: { z: -0.3 },
      isp:   { classe: 'queda_fraca', severidade: 1 },
      carga: { acwr: 1.40, dai: null },
      dor:   { local: 'posterior', eva: 2 },
    },
    estadoHisterese: ESTADO_ONTEM_SEC13, faseRTP: 2,
  });
  expect(resultado.eixos.intensidade.dose_pos_histerese).toBe('forte'); // bypass
});

test('INTEGRAÇÃO seção 13: (c) RTP F2 domina — dose_final correta', () => {
  const resultado = runMotor({
    atletaId: 'atleta_teste_13', nome: 'Atleta Teste', clubId: 'clube_teste', data: '2026-06-16',
    sinaisRaw: {
      ia:    { z: -2.1 }, inm: { z: -0.6 }, ih: { z: -1.1 }, ic: { z: -0.3 },
      isp:   { classe: 'queda_fraca', severidade: 1 },
      carga: { acwr: 1.40, dai: null },
      dor:   { local: 'posterior', eva: 2 },
    },
    estadoHisterese: ESTADO_ONTEM_SEC13, faseRTP: 2,
  });
  expect(resultado.eixos.volume.dose_final).toBe('moderado');      // mod vs F2=mod → mod
  expect(resultado.eixos.intensidade.dose_final).toBe('forte');    // forte vs F2=mod → forte
  expect(resultado.eixos.densidade.dose_final).toBe('moderado');   // mod vs F2=leve → mod
  expect(resultado.eixos.carga_mecanica.dose_final).toBe('forte'); // manter vs F2=forte → forte
});

test('INTEGRAÇÃO seção 13: prioridade = intensidade', () => {
  const resultado = runMotor({
    atletaId: 'atleta_teste_13', nome: 'Atleta Teste', clubId: 'clube_teste', data: '2026-06-16',
    sinaisRaw: {
      ia:    { z: -2.1 }, inm: { z: -0.6 }, ih: { z: -1.1 }, ic: { z: -0.3 },
      isp:   { classe: 'queda_fraca', severidade: 1 },
      carga: { acwr: 1.40, dai: null },
      dor:   { local: 'posterior', eva: 2 },
    },
    estadoHisterese: ESTADO_ONTEM_SEC13, faseRTP: 2,
  });
  expect(resultado.prioridade).toBe('intensidade'); // maior escore escore_eixo
  expect(resultado.encaminhamento).toBe(false);
  expect(resultado.rtp.ativo).toBe(true);
  expect(resultado.rtp.fase).toBe('F2');
});

// ─────────────────────────────────────────────────────────────────────────────
// PÓS-JOGO (MD+1 / MD+2) — _aplicarPosJogo e runMotor
// ─────────────────────────────────────────────────────────────────────────────

const DOSE_SAUDAVEL = { volume: 'manter', intensidade: 'manter', densidade: 'manter', carga_mecanica: 'manter' };

test('posJogo: sem contextoJogo → dose inalterada', () => {
  const resultado = _aplicarPosJogo(DOSE_SAUDAVEL, null);
  for (const e of Object.keys(DOSE_SAUDAVEL)) expect(resultado[e]).toBe('manter');
});

test('posJogo: mdPos definido, minutosJogados = 0 → dose inalterada (não jogou)', () => {
  const resultado = _aplicarPosJogo(DOSE_SAUDAVEL, { mdPos: 1, minutosJogados: 0 });
  for (const e of Object.keys(DOSE_SAUDAVEL)) expect(resultado[e]).toBe('manter');
});

test('posJogo: mdPos = 1, titular (>60 min) → floors MD+1 titular aplicados', () => {
  const resultado = _aplicarPosJogo(DOSE_SAUDAVEL, { mdPos: 1, minutosJogados: 90 });
  const esperado = POS_JOGO_RESTRICOES[1].titular;
  for (const e of Object.keys(esperado)) expect(resultado[e]).toBe(esperado[e]);
});

test('posJogo: mdPos = 1, reserva (≤60 min) → floors MD+1 reserva aplicados', () => {
  const resultado = _aplicarPosJogo(DOSE_SAUDAVEL, { mdPos: 1, minutosJogados: 45 });
  const esperado = POS_JOGO_RESTRICOES[1].reserva;
  for (const e of Object.keys(esperado)) expect(resultado[e]).toBe(esperado[e]);
});

test('posJogo: mdPos = 2, titular (>60 min) → floors MD+2 titular aplicados', () => {
  const resultado = _aplicarPosJogo(DOSE_SAUDAVEL, { mdPos: 2, minutosJogados: 70 });
  const esperado = POS_JOGO_RESTRICOES[2].titular;
  for (const e of Object.keys(esperado)) expect(resultado[e]).toBe(esperado[e]);
});

test('posJogo: mdPos = 2, reserva (≤60 min) → floors MD+2 reserva aplicados', () => {
  const resultado = _aplicarPosJogo(DOSE_SAUDAVEL, { mdPos: 2, minutosJogados: 30 });
  const esperado = POS_JOGO_RESTRICOES[2].reserva;
  for (const e of Object.keys(esperado)) expect(resultado[e]).toBe(esperado[e]);
});

test('posJogo: motor mais restritivo que o floor → motor prevalece', () => {
  // Motor calculou 'forte' em tudo; pos-jogo MD+2 titular não deve reduzir
  const doseFort = { volume: 'forte', intensidade: 'forte', densidade: 'forte', carga_mecanica: 'forte' };
  const resultado = _aplicarPosJogo(doseFort, { mdPos: 2, minutosJogados: 90 });
  for (const e of Object.keys(doseFort)) expect(resultado[e]).toBe('forte');
});

test('posJogo: fronteira exata 60min → faixa reserva (não titular)', () => {
  // >60 → titular; =60 → reserva
  const r = _aplicarPosJogo(DOSE_SAUDAVEL, { mdPos: 1, minutosJogados: 60 });
  const esperadoReserva = POS_JOGO_RESTRICOES[1].reserva;
  for (const e of Object.keys(esperadoReserva)) expect(r[e]).toBe(esperadoReserva[e]);
});

test('posJogo: titular + igpAbs crítico (<50) → tier titular_critico MD+2', () => {
  // Atleta jogou 90 min E está em estado Crítico → floor escalona
  const r = _aplicarPosJogo(DOSE_SAUDAVEL, { mdPos: 2, minutosJogados: 90 }, 42);
  const esperado = POS_JOGO_RESTRICOES[2].titular_critico;
  for (const e of Object.keys(esperado)) expect(r[e]).toBe(esperado[e]);
});

test('posJogo: titular + igpAbs crítico (<50) → tier titular_critico MD+1', () => {
  const r = _aplicarPosJogo(DOSE_SAUDAVEL, { mdPos: 1, minutosJogados: 90 }, 35);
  const esperado = POS_JOGO_RESTRICOES[1].titular_critico;
  for (const e of Object.keys(esperado)) expect(r[e]).toBe(esperado[e]);
});

test('posJogo: titular + igpAbs = 50 → tier titular normal (limiar exclusivo)', () => {
  // IGP_CRITICO_POS_JOGO = 50, condição é < 50 → igpAbs 50 não activa crítico
  const r = _aplicarPosJogo(DOSE_SAUDAVEL, { mdPos: 2, minutosJogados: 90 }, 50);
  const esperado = POS_JOGO_RESTRICOES[2].titular;
  for (const e of Object.keys(esperado)) expect(r[e]).toBe(esperado[e]);
});

test('posJogo: reserva com igpAbs crítico → ignora tier crítico (só vale para titular)', () => {
  // Reserva permanece no floor reserva mesmo com IGP baixo
  const r = _aplicarPosJogo(DOSE_SAUDAVEL, { mdPos: 2, minutosJogados: 45 }, 30);
  const esperado = POS_JOGO_RESTRICOES[2].reserva;
  for (const e of Object.keys(esperado)) expect(r[e]).toBe(esperado[e]);
});

// ── runMotor integração pós-jogo ───────────────────────────────────────────

const SINAIS_NORMAIS = {
  ia:    { z: 0 }, inm: { z: 0 }, ih: { z: 0 }, ic: { z: 0 },
  isp:   { classe: 'estavel_ou_positivo', severidade: 0 },
  carga: { acwr: 1.0, dai: null },
  dor:   { local: null, eva: 0 },
};

test('runMotor: pos_jogo.ativo false sem contexto', () => {
  const r = runMotor({ atletaId: 'x', nome: 'X', clubId: 'c', data: '2026-07-06',
    sinaisRaw: SINAIS_NORMAIS, estadoHisterese: null, faseRTP: null });
  expect(r.pos_jogo.ativo).toBe(false);
  expect(r.pos_jogo.md).toBe(null);
  expect(r.pos_jogo.faixa).toBe(null);
});

test('runMotor: MD+1 titular → dose_final ≥ floors MD+1 titular', () => {
  const r = runMotor({ atletaId: 'x', nome: 'X', clubId: 'c', data: '2026-07-06',
    sinaisRaw: SINAIS_NORMAIS, estadoHisterese: null, faseRTP: null,
    contextoJogo: { mdPos: 1, minutosJogados: 90 } });
  expect(r.pos_jogo.ativo).toBe(true);
  expect(r.pos_jogo.faixa).toBe('titular');
  expect(r.pos_jogo.md).toBe('MD+1');
  const floors = POS_JOGO_RESTRICOES[1].titular;
  const DOSES = ['manter','leve','moderado','forte'];
  for (const e of Object.keys(floors)) {
    const idxFinal = DOSES.indexOf(r.eixos[e].dose_final);
    const idxFloor = DOSES.indexOf(floors[e]);
    if (idxFinal < idxFloor) throw new Error(`${e}: dose_final=${r.eixos[e].dose_final} abaixo do floor ${floors[e]}`);
  }
});

test('runMotor: MD+1 titular → racional_curto começa com texto pós-jogo', () => {
  const r = runMotor({ atletaId: 'x', nome: 'X', clubId: 'c', data: '2026-07-06',
    sinaisRaw: SINAIS_NORMAIS, estadoHisterese: null, faseRTP: null,
    contextoJogo: { mdPos: 1, minutosJogados: 75 } });
  expect(r.racional_curto[0]).toContain('MD+1');
  expect(r.racional_curto[0]).toContain('>60');
});

test('runMotor: MD+2 reserva → dose_final ≥ floors MD+2 reserva', () => {
  const r = runMotor({ atletaId: 'x', nome: 'X', clubId: 'c', data: '2026-07-06',
    sinaisRaw: SINAIS_NORMAIS, estadoHisterese: null, faseRTP: null,
    contextoJogo: { mdPos: 2, minutosJogados: 40 } });
  expect(r.pos_jogo.faixa).toBe('reserva');
  const floors = POS_JOGO_RESTRICOES[2].reserva;
  const DOSES = ['manter','leve','moderado','forte'];
  for (const e of Object.keys(floors)) {
    const idxFinal = DOSES.indexOf(r.eixos[e].dose_final);
    const idxFloor = DOSES.indexOf(floors[e]);
    if (idxFinal < idxFloor) throw new Error(`${e}: dose_final=${r.eixos[e].dose_final} abaixo do floor ${floors[e]}`);
  }
});

test('runMotor: MD+1, não jogou (minutosJogados=0) → pos_jogo.ativo false, dose normal', () => {
  const r = runMotor({ atletaId: 'x', nome: 'X', clubId: 'c', data: '2026-07-06',
    sinaisRaw: SINAIS_NORMAIS, estadoHisterese: null, faseRTP: null,
    contextoJogo: { mdPos: 1, minutosJogados: 0 } });
  expect(r.pos_jogo.ativo).toBe(false);
  // Atleta saudável sem sinais → dose manter em tudo
  for (const e of ['volume','intensidade','densidade','carga_mecanica']) {
    expect(r.eixos[e].dose_final).toBe('manter');
  }
});

// Executa o resumo ao final
summary();
