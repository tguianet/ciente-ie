// ──────────────────────────────────────────────────────────────────────────────
// session_engine.js — Motor de Estruturação de Sessão Coletiva
// Associa o dia do microciclo + capacidade coletiva → estrutura de blocos de treino
// com princípios táticos, assinatura fisiológica e base para ajustes individuais.
// ──────────────────────────────────────────────────────────────────────────────

// ── Princípios de Jogo — assinatura fisiológica ───────────────────────────────
// assinatura: 1=baixo  2=médio  3=alto  (eixos do MIHBD-TE)
// eixos_motor: eixos do motor de recomendação que se sobrepõem a este princípio
export const PRINCIPIOS = {
  defensivo: {
    nome: 'Sistema Defensivo',
    cor:  '#1d4ed8',
    assinatura: { inm: 2, ia: 3, ic: 3, mecanico: 2 },
    eixos_motor: ['volume', 'densidade', 'intensidade'],
    exercicios: [
      '6x4 Defesa da área', '8x6 defesa organizada', '11x11 bloco médio/alto',
      'Basculação lateral', 'Cobertura defensiva',
      'Linha de quatro', 'Defesa de cruzamentos',
      'Defesa de bolas longas', 'Compactação vertical', 'Defesa em inferioridade',
    ],
    exercicios_por_intensidade: {
      alta:     ['11x11 bloco médio/alto', 'Defesa em inferioridade', 'Basculação lateral', '6x4 Defesa da área'],
      moderada: ['8x6 defesa organizada', 'Cobertura defensiva', 'Linha de quatro', 'Defesa de cruzamentos'],
      baixa:    ['Defesa de bolas longas', 'Compactação vertical'],
    },
    objetivos: ['Compactação', 'Cobertura', 'Equilíbrio defensivo', 'Comunicação', 'Controle da profundidade', 'Fechamento do corredor central'],
  },
  ofensivo: {
    nome: 'Sistema Ofensivo',
    cor:  '#7c3aed',
    assinatura: { inm: 2, ia: 3, ic: 3, mecanico: 2 },
    eixos_motor: ['volume', 'densidade', 'intensidade'],
    exercicios: [
      '5x3 ataque x defesa', '6x4 ataque x defesa',
      'Ataque posicional', 'Terceiro homem',
      'Ultrapassagens', 'Apoio + ruptura',
      'Criação de superioridade', 'Jogo entre linhas',
    ],
    exercicios_por_intensidade: {
      alta:     ['6x4 ataque x defesa', 'Jogo entre linhas', 'Criação de superioridade'],
      moderada: ['Ataque posicional', 'Terceiro homem', 'Ultrapassagens', '5x3 ataque x defesa'],
      baixa:    ['Apoio + ruptura'],
    },
    objetivos: ['Criação de superioridade', 'Circulação de bola', 'Jogo entre linhas'],
  },
  posse: {
    nome: 'Posse de Bola',
    cor:  '#0891b2',
    assinatura: { inm: 1, ia: 2, ic: 3, mecanico: 1 },
    eixos_motor: ['intensidade'],
    exercicios: [
      'Rondo 4x2', 'Rondo 5x2', 'Rondo 6x3',
      'Jogo posicional', 'Posse por setores',
      'Posse com coringas', 'Posse orientada',
      'Troca de corredor', 'Switch play', 'Conservação + progressão',
    ],
    exercicios_por_intensidade: {
      alta:     [],
      moderada: ['Rondo 6x3', 'Jogo posicional', 'Posse orientada', 'Troca de corredor', 'Switch play', 'Conservação + progressão'],
      baixa:    ['Rondo 4x2', 'Rondo 5x2', 'Posse com coringas', 'Posse por setores'],
    },
    objetivos: ['Controle do jogo', 'Atrair pressão', 'Manutenção da posse'],
  },
  transicao: {
    nome: 'Transição',
    cor:  '#dc2626',
    assinatura: { inm: 3, ia: 3, ic: 2, mecanico: 3 },
    eixos_motor: ['carga_mecanica', 'volume', 'densidade'],
    exercicios: [
      '3x2 contra-ataque', '4x3 transição ofensiva', '5x4',
      'Ataque rápido', '5 segundos',
      'Recuperação imediata', 'Retorno defensivo', 'Pressão pós-perda',
    ],
    exercicios_por_intensidade: {
      alta:     ['5x4', '5 segundos', 'Pressão pós-perda', 'Recuperação imediata'],
      moderada: ['4x3 transição ofensiva', 'Ataque rápido', 'Retorno defensivo'],
      baixa:    ['3x2 contra-ataque'],
    },
    objetivos: ['Reagir rapidamente', 'Transição ofensiva', 'Pressão pós-perda'],
  },
  pressao: {
    nome: 'Pressão',
    cor:  '#d97706',
    assinatura: { inm: 1, ia: 3, ic: 2, mecanico: 1 },
    eixos_motor: ['volume', 'densidade'],
    exercicios: [
      '11x9 pressão alta', 'Armadilhas laterais',
      'Direcionamento', 'Pressão ao goleiro', 'Pressão aos zagueiros',
      'Fechar linha de passe', 'Pressão coordenada',
    ],
    exercicios_por_intensidade: {
      alta:     ['11x9 pressão alta', 'Pressão ao goleiro', 'Pressão coordenada', 'Armadilhas laterais'],
      moderada: ['Pressão aos zagueiros', 'Direcionamento', 'Fechar linha de passe'],
      baixa:    [],
    },
    objetivos: ['Recuperar a posse rapidamente', 'Forçar erro na saída', 'Controlar espaço'],
  },
  confrontos: {
    nome: 'Confrontos',
    cor:  '#16a34a',
    assinatura: { inm: 3, ia: 1, ic: 3, mecanico: 3 },
    eixos_motor: ['carga_mecanica', 'intensidade'],
    exercicios: [
      '1x1 ofensivo', '1x1 defensivo',
      '2x2 cobertura', '3x3', '4x4 mini-jogo',
      'Superioridade 2x1', 'Superioridade 3x2', 'Inferioridade 1x2',
    ],
    exercicios_por_intensidade: {
      alta:     ['3x3', '4x4 mini-jogo', 'Superioridade 3x2', 'Inferioridade 1x2'],
      moderada: ['2x2 cobertura', 'Superioridade 2x1', '1x1 ofensivo', '1x1 defensivo'],
      baixa:    [],
    },
    objetivos: ['Evolução técnica individual', 'Tomada de decisão', 'Capacidade de drible e marcação'],
  },
  finalizacoes: {
    nome: 'Finalizações',
    cor:  '#b45309',
    assinatura: { inm: 3, ia: 1, ic: 2, mecanico: 3 },
    eixos_motor: ['carga_mecanica'],
    exercicios: [
      'Cruzamentos (1º e 2º poste)', 'Infiltrações',
      'Finalização rápida (poucos toques)', 'Finalização após combinação',
      'Ataques ao último terço', 'Finalização após transição',
      'Finalização sob pressão (marcador ativo)', '3x2', '4x3',
    ],
    exercicios_por_intensidade: {
      alta:     ['3x2', '4x3', 'Finalização após transição', 'Finalização sob pressão (marcador ativo)', 'Ataques ao último terço'],
      moderada: ['Cruzamentos (1º e 2º poste)', 'Infiltrações', 'Finalização após combinação', 'Finalização rápida (poucos toques)'],
      baixa:    [],
    },
    objetivos: ['Converter oportunidades', 'Combinações no último terço', 'Eficiência ofensiva'],
  },
};

// ── Templates de sessão por dia do microciclo ─────────────────────────────────
// duracao_ref = referência para capacidade Alta (Moderada/Reduzida são ajustadas)
// intensidade = 'baixa' | 'moderada' | 'alta'
const SESSAO_TEMPLATES = {
  'MD+1': {
    justificativa: 'Regenerativo pós-jogo — volume mínimo, sem impacto mecânico ou metabólico',
    blocos: [
      { nome: 'Ativação',     principio: 'posse',  intensidade: 'baixa',  duracao_ref: [8,  10], pse_ref: [2,3], descricao: 'Técnica individual + mobilidade ativa — sem sprint' },
      { nome: 'Bloco Único',  principio: 'posse',  intensidade: 'baixa',  duracao_ref: [10, 15], pse_ref: [3,4], descricao: 'Rondos e conservação leve — baixíssima exigência mecânica' },
    ],
    // Grupo estímulo: jogadores que não atuaram ou jogaram <60 min
    blocos_estimulo: [
      { nome: 'Ativação',        principio: 'posse',      intensidade: 'baixa',    duracao_ref: [12,15], pse_ref: [3,4], descricao: 'Rondo 5x2 + mobilidade ativa' },
      { nome: 'Bloco Principal', principio: 'transicao',  intensidade: 'alta',     duracao_ref: [8,12],  pse_ref: [6,8], descricao: 'Jogo-treino ou coletivo com regras — alta intensidade para grupo que não jogou (ratio 3:1)' },
      { nome: 'Jogo Final',      principio: 'ofensivo',   intensidade: 'moderada', duracao_ref: [15,20], pse_ref: [5,7], descricao: 'Coletivo posicional ou jogo reduzido — manutenção de ritmo e confiança' },
    ],
    justificativa_estimulo: 'Grupo estímulo (não jogou / <60 min) — coletivo ou jogo-treino com 8–12 min de alta intensidade (180–260 UA)',
  },
  'MD+2': {
    justificativa: 'Regenerativo — retomada técnica com baixo custo neuromuscular',
    blocos: [
      { nome: 'Ativação',      principio: 'posse',   intensidade: 'baixa',    duracao_ref: [10,12], pse_ref: [3,4], descricao: 'Rondo 4x2 + mobilidade' },
      { nome: 'Bloco Técnico', principio: 'posse',   intensidade: 'baixa',    duracao_ref: [12,16], pse_ref: [3,5], descricao: 'Posse orientada — sem pressão máxima' },
      { nome: 'Jogo Final',    principio: 'posse',   intensidade: 'baixa',    duracao_ref: [5, 8],  pse_ref: [3,5], descricao: 'Posse com coringas — ritmo controlado' },
    ],
    // Grupo estímulo: carga significativamente maior que titulares
    blocos_estimulo: [
      { nome: 'Ativação',        principio: 'posse',      intensidade: 'baixa',    duracao_ref: [12,14], pse_ref: [3,4], descricao: 'Rondo 5x2 + ativação técnica' },
      { nome: 'Posicional',      principio: 'ofensivo',   intensidade: 'moderada', duracao_ref: [15,18], pse_ref: [5,6], descricao: 'Ataque posicional + trabalho tático por setor' },
      { nome: 'Bloco Principal', principio: 'transicao',  intensidade: 'alta',     duracao_ref: [12,18], pse_ref: [6,8], descricao: 'Coletivo ou jogo-treino com ênfase em transição — 1 bloco contínuo (ratio 3:1)' },
      { nome: 'Jogo Final',      principio: 'ofensivo',   intensidade: 'moderada', duracao_ref: [10,14], pse_ref: [5,7], descricao: 'Jogo posicional com foco em posse e circulação' },
    ],
    justificativa_estimulo: 'Grupo estímulo (não jogou / <60 min) — coletivo/jogo-treino com 12–18 min de alta intensidade (300–420 UA)',
  },
  'MD+3': {
    justificativa: 'Retomada de carga — foco ofensivo coletivo com bloco de confrontos em alta intensidade',
    blocos: [
      { nome: 'Ativação',        principio: 'posse',      intensidade: 'baixa',    duracao_ref: [12,14], pse_ref: [3,4], descricao: 'Rondo 5x2 + técnica individual' },
      { nome: 'Posicional',      principio: 'ofensivo',   intensidade: 'moderada', duracao_ref: [15,18], pse_ref: [4,6], descricao: '6x4 criação de superioridade — terceiro homem' },
      { nome: 'Bloco Principal', principio: 'confrontos', intensidade: 'alta',     duracao_ref: [8,12],  pse_ref: [6,8], descricao: '3x3 e 4x4 campo pequeno — alta intensidade, tomada de decisão e explosão neuromuscular (ratio 3:1)' },
      { nome: 'Jogo Final',      principio: 'ofensivo',   intensidade: 'moderada', duracao_ref: [10,15], pse_ref: [5,7], descricao: 'Jogo posicional com superioridade alternada' },
    ],
  },
  'MD-4': {
    justificativa: 'Desenvolvimento — volume e princípios coletivos completos, início de alta intensidade',
    blocos: [
      { nome: 'Ativação',        principio: 'posse',     intensidade: 'baixa',    duracao_ref: [9,11],  pse_ref: [3,4], descricao: 'Rondo 6x3 + ativação física' },
      { nome: 'Posicional',      principio: 'ofensivo',  intensidade: 'moderada', duracao_ref: [11,15], pse_ref: [5,6], descricao: 'Ataque posicional — terceiro homem e ultrapassagens' },
      { nome: 'Bloco Principal', principio: 'defensivo', intensidade: 'alta',     duracao_ref: [14,18], pse_ref: [6,8], descricao: '11x11 bloco médio — compactação e cobertura coletiva' },
      { nome: 'Bloco Compl.',    principio: 'transicao', intensidade: 'alta',     duracao_ref: [8,10],  pse_ref: [6,8], descricao: '5x4 transição ofensiva e defensiva' },
      { nome: 'Jogo Final',      principio: 'defensivo', intensidade: 'moderada', duracao_ref: [9,12],  pse_ref: [6,8], descricao: 'Jogo com regra de pressão pós-perda' },
    ],
  },
  'MD-3': {
    justificativa: 'Pico de carga — máxima exigência de transição, pressão e intensidade coletiva',
    blocos: [
      { nome: 'Ativação',        principio: 'posse',     intensidade: 'baixa',    duracao_ref: [9,11],  pse_ref: [3,5], descricao: 'Rondo 6x3 + ativação específica' },
      { nome: 'Posicional',      principio: 'defensivo', intensidade: 'moderada', duracao_ref: [12,14], pse_ref: [5,7], descricao: '8x6 defesa organizada — linha de 4 e cobertura' },
      { nome: 'Bloco Principal', principio: 'transicao', intensidade: 'alta',     duracao_ref: [15,19], pse_ref: [7,9], descricao: '5x4 transição + Pressão pós-perda — máxima intensidade' },
      { nome: 'Bloco Compl.',    principio: 'pressao',   intensidade: 'alta',     duracao_ref: [8,11],  pse_ref: [7,8], descricao: 'Pressão coordenada — armadilhas laterais e direcionamento' },
      { nome: 'Jogo Final',      principio: 'defensivo', intensidade: 'alta',     duracao_ref: [12,15], pse_ref: [8,9], descricao: '11x11 com foco defensivo e pressão alta' },
    ],
  },
  'MD-2': {
    justificativa: 'Tapering — manutenção técnica com baixo custo mecânico e neuromuscular',
    blocos: [
      { nome: 'Ativação',        principio: 'posse',        intensidade: 'baixa',    duracao_ref: [9,11],  pse_ref: [3,4], descricao: 'Rondo 5x2 + mobilidade' },
      { nome: 'Posicional',      principio: 'posse',        intensidade: 'moderada', duracao_ref: [13,16], pse_ref: [4,6], descricao: 'Posse orientada — troca de corredor e switch play' },
      { nome: 'Bloco Principal', principio: 'finalizacoes', intensidade: 'moderada', duracao_ref: [13,16], pse_ref: [5,7], descricao: 'Cruzamentos + infiltrações — combinações no último terço' },
      { nome: 'Jogo Final',      principio: 'ofensivo',     intensidade: 'moderada', duracao_ref: [9,13],  pse_ref: [5,6], descricao: 'Jogo posicional com pressão reduzida' },
    ],
  },
  'MD-1': {
    justificativa: 'Ativação final — estímulo neural breve, sem volume ou carga mecânica acumulada',
    blocos: [
      { nome: 'Ativação',        principio: 'posse',        intensidade: 'baixa',    duracao_ref: [6,7],  pse_ref: [3,4], descricao: 'Rondo leve + técnica individual' },
      { nome: 'Bloco Principal', principio: 'finalizacoes', intensidade: 'moderada', duracao_ref: [9,11], pse_ref: [5,6], descricao: 'Finalizações após combinação — poucos toques, alta velocidade' },
      { nome: 'Bloco Compl.',    principio: 'confrontos',   intensidade: 'moderada', duracao_ref: [6,7],  pse_ref: [5,6], descricao: '1x1 e 2x2 curtos — estímulo de excitabilidade neural' },
      { nome: 'Jogo Final',      principio: 'finalizacoes', intensidade: 'moderada', duracao_ref: [6,9],  pse_ref: [5,7], descricao: 'Finalização em alta velocidade — mínimo de toques' },
    ],
  },
  'D1': {
    justificativa: 'Reativação — retomada coletiva progressiva após folga ou jogo',
    blocos: [
      { nome: 'Ativação',        principio: 'posse',     intensidade: 'baixa',    duracao_ref: [10,11], pse_ref: [3,4], descricao: 'Rondo 4x2 + técnica individual' },
      { nome: 'Posicional',      principio: 'ofensivo',  intensidade: 'moderada', duracao_ref: [11,14], pse_ref: [4,6], descricao: 'Ataque posicional leve — movimentação sincronizada' },
      { nome: 'Bloco Principal', principio: 'defensivo', intensidade: 'moderada', duracao_ref: [11,14], pse_ref: [5,7], descricao: '8x6 defesa organizada — cobertura e equilíbrio' },
      { nome: 'Jogo Final',      principio: 'ofensivo',  intensidade: 'moderada', duracao_ref: [8,11],  pse_ref: [5,7], descricao: 'Jogo com superioridade alternada' },
    ],
  },
  'D2': {
    justificativa: 'Sobrecarga I — volume tático com início de transições em alta intensidade',
    blocos: [
      { nome: 'Ativação',        principio: 'posse',     intensidade: 'baixa',    duracao_ref: [9,11],  pse_ref: [3,5], descricao: 'Rondo 6x3 + ativação física' },
      { nome: 'Posicional',      principio: 'ofensivo',  intensidade: 'moderada', duracao_ref: [12,16], pse_ref: [5,7], descricao: 'Ataque posicional — terceiro homem + ultrapassagens' },
      { nome: 'Bloco Principal', principio: 'defensivo', intensidade: 'alta',     duracao_ref: [14,17], pse_ref: [6,8], descricao: '11x11 bloco médio — compactação vertical' },
      { nome: 'Bloco Compl.',    principio: 'transicao', intensidade: 'alta',     duracao_ref: [8,11],  pse_ref: [6,8], descricao: '4x3 transição ofensiva e contra-ataque' },
      { nome: 'Jogo Final',      principio: 'defensivo', intensidade: 'alta',     duracao_ref: [9,12],  pse_ref: [7,9], descricao: 'Jogo com regra de pressão pós-perda' },
    ],
  },
  'D3': {
    justificativa: 'Pico de carga — máxima exigência coletiva, transição e intensidade',
    blocos: [
      { nome: 'Ativação',        principio: 'posse',     intensidade: 'baixa',    duracao_ref: [9,11],  pse_ref: [3,5], descricao: 'Rondo 6x3 + ativação específica' },
      { nome: 'Posicional',      principio: 'defensivo', intensidade: 'moderada', duracao_ref: [12,14], pse_ref: [5,7], descricao: '8x6 defesa organizada — cobertura e linha de 4' },
      { nome: 'Bloco Principal', principio: 'transicao', intensidade: 'alta',     duracao_ref: [15,19], pse_ref: [7,9], descricao: '5x4 transição + Pressão pós-perda — alta intensidade' },
      { nome: 'Bloco Compl.',    principio: 'pressao',   intensidade: 'alta',     duracao_ref: [8,11],  pse_ref: [7,8], descricao: 'Pressão coordenada — armadilhas e direcionamento' },
      { nome: 'Jogo Final',      principio: 'defensivo', intensidade: 'alta',     duracao_ref: [12,15], pse_ref: [8,9], descricao: '11x11 com regra de pressão e transição obrigatória' },
    ],
  },
  'D4': {
    justificativa: 'Dissipação — redução de carga, foco técnico e ofensivo',
    blocos: [
      { nome: 'Ativação',        principio: 'posse',        intensidade: 'baixa',    duracao_ref: [9,11],  pse_ref: [3,4], descricao: 'Rondo 5x2 + mobilidade' },
      { nome: 'Posicional',      principio: 'posse',        intensidade: 'moderada', duracao_ref: [13,16], pse_ref: [4,6], descricao: 'Posse orientada — troca de corredor' },
      { nome: 'Bloco Principal', principio: 'finalizacoes', intensidade: 'moderada', duracao_ref: [13,16], pse_ref: [5,7], descricao: 'Cruzamentos + infiltrações — combinações no último terço' },
      { nome: 'Jogo Final',      principio: 'ofensivo',     intensidade: 'moderada', duracao_ref: [9,13],  pse_ref: [5,6], descricao: 'Jogo posicional com pressão reduzida' },
    ],
  },
  'D5': {
    justificativa: 'Potenciação — estímulo neural curto antes do jogo, sem acúmulo de fadiga',
    blocos: [
      { nome: 'Ativação',        principio: 'posse',        intensidade: 'baixa',    duracao_ref: [6,7],  pse_ref: [3,4], descricao: 'Rondo leve + técnica individual' },
      { nome: 'Bloco Principal', principio: 'confrontos',   intensidade: 'moderada', duracao_ref: [9,11], pse_ref: [5,7], descricao: '1x1 e 2x2 — excitabilidade neural e tomada de decisão' },
      { nome: 'Bloco Compl.',    principio: 'finalizacoes', intensidade: 'moderada', duracao_ref: [7,9],  pse_ref: [5,6], descricao: 'Finalizações rápidas após combinação' },
      { nome: 'Jogo Final',      principio: 'finalizacoes', intensidade: 'moderada', duracao_ref: [6,7],  pse_ref: [5,7], descricao: 'Finalização em alta velocidade — poucos toques' },
    ],
  },
  'D6': {
    justificativa: 'Manutenção — carga e exigências semelhantes ao jogo competitivo',
    blocos: [
      { nome: 'Ativação',        principio: 'posse',        intensidade: 'baixa',    duracao_ref: [9,10],  pse_ref: [3,4], descricao: 'Rondo 5x2 + ativação' },
      { nome: 'Posicional',      principio: 'ofensivo',     intensidade: 'moderada', duracao_ref: [9,11],  pse_ref: [5,6], descricao: 'Ataque posicional — movimentação sincronizada' },
      { nome: 'Bloco Principal', principio: 'confrontos',   intensidade: 'moderada', duracao_ref: [11,13], pse_ref: [5,7], descricao: '2x2 e 3x3 — decisões e capacidade individual' },
      { nome: 'Bloco Compl.',    principio: 'finalizacoes', intensidade: 'moderada', duracao_ref: [7,9],   pse_ref: [5,7], descricao: 'Finalizações após combinação — parede, tabela, apoio' },
      { nome: 'Jogo Final',      principio: 'ofensivo',     intensidade: 'moderada', duracao_ref: [9,11],  pse_ref: [6,7], descricao: 'Jogo com regras ofensivas — superioridade e progressão' },
    ],
  },
};

// ── Ajuste por capacidade coletiva ────────────────────────────────────────────
const CAP_AJUSTE = {
  Alta:     { fator_alta: 1.00, fator_mod: 1.00, remove_complementar: false, adapta_principal: false },
  Moderada: { fator_alta: 0.82, fator_mod: 1.00, remove_complementar: false, adapta_principal: false },
  Reduzida: { fator_alta: 0.65, fator_mod: 0.82, remove_complementar: true,  adapta_principal: true  },
};

// ── Labels legíveis para eixos ─────────────────────────────────────────────────
const EIXO_LABEL = {
  inm: 'Neuromuscular (INM)', ia: 'Autonômico/Metabólico (IA)',
  ic: 'Cognitivo (IC)', mecanico: 'Carga Mecânica',
};
const EIXO_MOTOR_LABEL = {
  volume: 'Volume', intensidade: 'Intensidade',
  densidade: 'Densidade', carga_mecanica: 'Carga Mecânica',
};

// ── Função principal ───────────────────────────────────────────────────────────
/**
 * @param {string} diaMicrocicloLabel  ex: 'MD-3', 'D2', 'MD+1'
 * @param {string} capacidadeColetiva  'Alta' | 'Moderada' | 'Reduzida'
 * @returns {object|null}
 */
export function gerarSessao(diaMicrocicloLabel, capacidadeColetiva = 'Alta') {
  const template = SESSAO_TEMPLATES[diaMicrocicloLabel];
  if (!template) return null;

  const ajuste = CAP_AJUSTE[capacidadeColetiva] || CAP_AJUSTE.Alta;

  let blocos = template.blocos.map(b => {
    const p = PRINCIPIOS[b.principio] || {};
    let duracao = [...b.duracao_ref];

    if (b.intensidade === 'alta') {
      duracao = duracao.map(v => Math.round(v * ajuste.fator_alta));
    } else if (b.intensidade === 'moderada') {
      duracao = duracao.map(v => Math.round(v * ajuste.fator_mod));
    }

    return {
      ...b,
      principio_nome:   p.nome   ?? b.principio,
      principio_cor:    p.cor    ?? '#6b7280',
      exercicios:       p.exercicios ?? [],
      objetivos:        p.objetivos  ?? [],
      eixos_motor:      p.eixos_motor ?? [],
      duracao,
      duracao_fmt: duracao[0] === duracao[1]
        ? `${duracao[0]} min`
        : `${duracao[0]}–${duracao[1]} min`,
    };
  });

  // Capacidade Reduzida: remove complementar e suaviza bloco principal de alta
  if (ajuste.remove_complementar) {
    blocos = blocos.filter(b => b.nome !== 'Bloco Compl.');
  }
  if (ajuste.adapta_principal) {
    blocos = blocos.map(b => {
      if (b.intensidade === 'alta' && b.nome === 'Bloco Principal') {
        const p = PRINCIPIOS.posse;
        return {
          ...b,
          principio:      'posse',
          principio_nome: p.nome,
          principio_cor:  p.cor,
          exercicios:     p.exercicios,
          objetivos:      p.objetivos,
          eixos_motor:    p.eixos_motor,
          intensidade:    'moderada',
          pse_ref:        [4, 6],
          descricao:      'Posse orientada — substituição por capacidade coletiva reduzida',
        };
      }
      return b;
    });
  }

  // Assinatura fisiológica da sessão (média ponderada — principal tem peso 3, jogo 2, compl 2, outros 1)
  const _PESO = { 'Bloco Principal': 3, 'Bloco Compl.': 2, 'Jogo Final': 2, Posicional: 1.5, Ativação: 1, 'Bloco Técnico': 1, 'Bloco Único': 1 };
  const acc = { inm: 0, ia: 0, ic: 0, mecanico: 0 };
  let pesoTotal = 0;
  for (const b of blocos) {
    const p = PRINCIPIOS[b.principio];
    if (!p) continue;
    const w = _PESO[b.nome] ?? 1;
    for (const k of ['inm', 'ia', 'ic', 'mecanico']) acc[k] += p.assinatura[k] * w;
    pesoTotal += w;
  }
  const _lbl = v => v <= 1.5 ? 'baixo' : v <= 2.3 ? 'médio' : 'alto';
  const assinatura = {};
  for (const k of ['inm', 'ia', 'ic', 'mecanico']) {
    assinatura[k] = _lbl(pesoTotal > 0 ? acc[k] / pesoTotal : 0);
  }

  // Eixos do motor em atenção (para cruzar com restrições individuais)
  const eixosMotorEmAtencao = [
    ...new Set(
      blocos
        .filter(b => b.intensidade !== 'baixa')
        .flatMap(b => PRINCIPIOS[b.principio]?.eixos_motor ?? [])
    ),
  ];

  const duracaoTotal = Math.round(
    blocos.reduce((s, b) => s + (b.duracao[0] + b.duracao[1]) / 2, 0)
  );

  const blocoPrincipal = blocos.find(b => b.nome === 'Bloco Principal') ?? blocos[1] ?? blocos[0];

  // Blocos de estímulo (MD+1 / MD+2 — jogadores que não atuaram ou jogaram <60 min)
  let blocos_estimulo = null;
  if (template.blocos_estimulo) {
    blocos_estimulo = template.blocos_estimulo.map(b => {
      const p = PRINCIPIOS[b.principio] || {};
      let duracao = [...b.duracao_ref];
      if (b.intensidade === 'alta') {
        duracao = duracao.map(v => Math.round(v * ajuste.fator_alta));
      } else if (b.intensidade === 'moderada') {
        duracao = duracao.map(v => Math.round(v * ajuste.fator_mod));
      }
      return {
        ...b,
        principio_nome: p.nome ?? b.principio,
        principio_cor:  p.cor  ?? '#6b7280',
        exercicios:     p.exercicios ?? [],
        objetivos:      p.objetivos  ?? [],
        eixos_motor:    p.eixos_motor ?? [],
        duracao,
        duracao_fmt: duracao[0] === duracao[1]
          ? `${duracao[0]} min`
          : `${duracao[0]}–${duracao[1]} min`,
      };
    });
  }

  return {
    diaMicrociclo:          diaMicrocicloLabel,
    capacidade:             capacidadeColetiva,
    justificativa:          template.justificativa,
    blocos,
    blocos_estimulo,
    justificativa_estimulo: template.justificativa_estimulo ?? null,
    assinatura,
    eixos_motor_em_atencao: eixosMotorEmAtencao,
    duracao_total_est:      duracaoTotal,
    principio_principal:    blocoPrincipal?.principio ?? null,
    principio_principal_nome: blocoPrincipal?.principio_nome ?? '',
  };
}

/**
 * Retorna atletas que precisam de adaptação dado o que a sessão exige.
 * Cruza eixos_motor_em_atencao da sessão com restrições do motor por atleta.
 *
 * @param {object}  sessao           saída de gerarSessao()
 * @param {Map}     motorRecsMap     athleteId → motor output
 * @param {Map}     atletasMedicoMap athleteId → { nome, statusMed, ... }
 * @returns {Array<{id, nome, eixos_restritos, motivo}>}
 */
export function calcMotorFlags(sessao, motorRecsMap, atletasMedicoMap) {
  if (!sessao || !motorRecsMap || !atletasMedicoMap) return [];

  const DOSES_ATIVAS = new Set(['forte', 'moderado']);
  const flags = [];

  for (const [id, motorRec] of motorRecsMap.entries()) {
    const med = atletasMedicoMap.get(id);
    if (!med || med.statusMed === 'afastado') continue;

    const eixos = motorRec.eixos || {};
    const eixosRestritos = sessao.eixos_motor_em_atencao
      .filter(e => DOSES_ATIVAS.has(eixos[e]?.dose_final));

    if (!eixosRestritos.length) continue;

    flags.push({
      id,
      nome:          med.nome,
      eixos_restritos: eixosRestritos,
      motivo:        eixosRestritos.map(e => EIXO_MOTOR_LABEL[e] || e).join(' + '),
      encaminhamento: !!motorRec.encaminhamento,
    });
  }

  // Atletas com encaminhamento primeiro, depois por número de restrições
  return flags.sort((a, b) => {
    if (a.encaminhamento !== b.encaminhamento) return a.encaminhamento ? -1 : 1;
    return b.eixos_restritos.length - a.eixos_restritos.length;
  });
}

// ── Sugestão de exercícios por zona de intensidade (Analista Telê) ────────────
/**
 * A partir da sessão gerada, agrupa os princípios por zona de intensidade
 * e retorna até 3 exercícios por princípio — pronto para o Telê verbalizar.
 *
 * @param {object} sessao - saída de gerarSessao()
 * @returns {{ alta: Array, moderadaBaixa: Array }}
 *   Cada item: { principio, nome, cor, exercicios: string[] }
 */
export function gerarSugestaoExercicios(sessao) {
  if (!sessao) return { alta: [], moderadaBaixa: [] };

  function _coletar(blocos, zona) {
    const vistos = new Set();
    const resultado = [];

    for (const bloco of blocos) {
      const emZona = zona === 'alta'
        ? bloco.intensidade === 'alta'
        : bloco.intensidade === 'moderada' || bloco.intensidade === 'baixa';

      if (!emZona) continue;
      if (vistos.has(bloco.principio)) continue;

      const p = PRINCIPIOS[bloco.principio];
      if (!p?.exercicios_por_intensidade) continue;

      // Usa a intensidade real do bloco como chave; baixa cai em moderada como fallback
      const chave = bloco.intensidade === 'baixa'
        ? (p.exercicios_por_intensidade.baixa?.length ? 'baixa' : 'moderada')
        : bloco.intensidade;

      const lista = p.exercicios_por_intensidade[chave] ?? [];
      if (lista.length === 0) continue;

      vistos.add(bloco.principio);
      resultado.push({
        principio: bloco.principio,
        nome:      p.nome,
        cor:       p.cor,
        exercicios: lista.slice(0, 3),
      });
    }

    return resultado;
  }

  const blocos = sessao.blocos ?? [];
  return {
    alta:          _coletar(blocos, 'alta'),
    moderadaBaixa: _coletar(blocos, 'moderadaBaixa'),
  };
}
