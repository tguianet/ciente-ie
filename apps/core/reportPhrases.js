// reportPhrases.js — Dicionário oficial de linguagem do relatório Ciente IE
// Padrão: [Sistema] + (função no desempenho) · sem linguagem alarmista

export const SISTEMAS_LABEL = {
  neuromuscular: 'Neuromuscular',
  subjetivo:     'Subjetivo',
  autonomico:    'Autonômico',
  cognitivo:     'Cognitivo',
  metabolico:    'Metabólico',
};

export const SISTEMAS_FUNCAO = {
  neuromuscular: 'potência e ações explosivas',
  subjetivo:     'percepção de fadiga e estado geral',
  autonomico:    'recuperação fisiológica',
  cognitivo:     'tomada de decisão e tempo de reação',
  metabolico:    'capacidade de sustentar intensidade',
};

// Alias para nomes capitalizados usados no código (maisPrejudicado?.nome)
export const SISTEMAS_FUNCAO_MAP = {
  'Neuromuscular': 'potência e ações explosivas',
  'Subjetivo':     'percepção de fadiga e estado geral',
  'Autonômico':    'recuperação fisiológica',
  'Cognitivo':     'tomada de decisão e tempo de reação',
  'Metabólico':    'capacidade de sustentar intensidade',
};

// ── Classificadores ───────────────────────────────────────────────────────────

export function classificarProntidao(valor) {
  if (valor >= 70) return 'estavel';
  if (valor >= 60) return 'leve_atencao';
  if (valor >= 50) return 'atencao';
  return 'critica';
}

export function classificarCarga(valor) {
  if (valor < 300)  return 'regenerativa';
  if (valor <= 599) return 'moderada';
  if (valor <= 799) return 'alta';
  return 'muito_alta';
}

export function classificarISP(isp) {
  if (isp >= 70) return 'alto';
  if (isp >= 50) return 'regular';
  if (isp >= 35) return 'limitado';
  return 'insuficiente';
}

// ── Frases por dimensão ───────────────────────────────────────────────────────

export function fraseProntidao(status) {
  switch (status) {
    case 'estavel':      return 'prontidão estável';
    case 'leve_atencao': return 'prontidão com leve atenção';
    case 'atencao':      return 'prontidão em atenção';
    case 'critica':      return 'prontidão abaixo do ideal';
    default:             return 'prontidão em monitoramento';
  }
}

export function fraseCarga(status) {
  switch (status) {
    case 'regenerativa': return 'carga regenerativa';
    case 'moderada':     return 'carga moderada';
    case 'alta':         return 'carga elevada';
    case 'muito_alta':   return 'carga muito elevada';
    default:             return 'carga da semana';
  }
}

export function fraseSistema(sistema) {
  if (!sistema) return '';
  const label  = SISTEMAS_LABEL[sistema]  || SISTEMAS_FUNCAO_MAP[sistema] && sistema;
  const funcao = SISTEMAS_FUNCAO[sistema] || SISTEMAS_FUNCAO_MAP[sistema];
  if (!label) return '';
  return `sistema mais afetado: ${label}${funcao ? ` (${funcao})` : ''}`;
}

export function fraseISP(isp) {
  const status = classificarISP(isp);
  switch (status) {
    case 'alto':         return `ISP ${Math.round(isp)} — adaptação semanal consistente.`;
    case 'regular':      return `ISP ${Math.round(isp)} — acompanhamento da resposta semanal.`;
    case 'limitado':     return `ISP ${Math.round(isp)} — disponibilidade reduzida na semana.`;
    case 'insuficiente': return `ISP ${Math.round(isp)} — condição abaixo do padrão da semana.`;
    default:             return `ISP ${Math.round(isp)}.`;
  }
}

export function fraseACWR(acwr) {
  if (acwr == null) return '';
  if (acwr > 1.5)       return `ACWR ${acwr.toFixed(2)} — exposição semanal muito elevada.`;
  if (acwr > 1.3)       return `ACWR ${acwr.toFixed(2)} — exposição semanal elevada.`;
  if (acwr >= 0.8)      return `ACWR ${acwr.toFixed(2)} — exposição semanal equilibrada.`;
  return                       `ACWR ${acwr.toFixed(2)} — exposição semanal reduzida.`;
}

export function fraseSistemaIndividual(sistema) {
  if (!sistema) return '';
  const label  = SISTEMAS_FUNCAO_MAP[sistema] ? sistema : (SISTEMAS_LABEL[sistema] || sistema);
  const funcao = SISTEMAS_FUNCAO_MAP[sistema] || SISTEMAS_FUNCAO[sistema];
  return `${label}${funcao ? ` — ${funcao}` : ''}.`;
}

// ── Frases compostas ──────────────────────────────────────────────────────────

export function gerarFraseAutomatica({ prontidao, carga, sistema }) {
  const ps = classificarProntidao(prontidao);
  const cs = classificarCarga(carga);
  const sf = sistema ? ` — ${fraseSistema(sistema)}.` : '.';

  if (cs === 'muito_alta' && ps === 'estavel')
    return `Carga muito elevada com manutenção da prontidão${sf}`;
  if (cs === 'alta' && ps === 'estavel')
    return `Carga elevada com prontidão estável${sf}`;
  if ((cs === 'alta' || cs === 'muito_alta') && ps === 'leve_atencao')
    return `Semana de alta exigência com prontidão em leve atenção${sf}`;
  if (cs === 'moderada' && ps === 'estavel')
    return `Carga moderada com prontidão estável — resposta consistente da semana${sf}`;
  if (cs === 'moderada' && ps === 'atencao')
    return `Carga moderada com prontidão em atenção${sf}`;
  if (cs === 'regenerativa' && (ps === 'atencao' || ps === 'critica'))
    return `Carga reduzida com prontidão ainda abaixo do ideal${sf}`;

  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  return `${cap(fraseCarga(cs))} com ${fraseProntidao(ps)}${sf}`;
}

// Frase curta para análise por posição (máx. 1 linha)
export function gerarFrasePosicao({ prontidao, carga, sistema }) {
  const ps = classificarProntidao(prontidao);
  const cs = classificarCarga(carga);
  const funcao = sistema ? (SISTEMAS_FUNCAO[sistema] || SISTEMAS_FUNCAO_MAP[sistema] || sistema.toLowerCase()) : null;

  if (cs === 'alta' || cs === 'muito_alta')
    return `Alta exigência com destaque para ${funcao || 'o sistema mais demandado'}.`;
  if (ps === 'estavel')
    return 'Prontidão estável ao longo da semana.';
  if (ps === 'leve_atencao' || ps === 'atencao')
    return `Monitoramento da semana${funcao ? ` com ênfase em ${funcao}` : ''}.`;
  return 'Acompanhamento da resposta semanal.';
}

// Leitura da semana em blocos (para resumo executivo)
export function gerarLeituraSemana({ prontidao, carga, sistema }) {
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  return [
    prontidao != null ? `${cap(fraseProntidao(classificarProntidao(prontidao)))} (${prontidao.toFixed(1)}).` : null,
    carga != null     ? `${cap(fraseCarga(classificarCarga(carga)))} (${Math.round(carga)} UA).`              : null,
    sistema           ? `${cap(fraseSistema(sistema))}.`                                                       : null,
  ].filter(Boolean);
}
