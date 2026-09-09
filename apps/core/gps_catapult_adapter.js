/**
 * Adapter Catapult OpenField
 * A nomenclatura de colunas varia por clube — o adapter usa matching fuzzy
 * e sempre exibe uma tela de confirmação antes de salvar.
 * Depende do global Papa (PapaParse) carregado pela página.
 */

import { normalizarTexto } from './gps.service.js';

// Sugestões de match por campo (não garantidas — só um ponto de partida)
export const CATAPULT_FIELD_GUESSES = {
  nome:                    ['player name', 'athlete', 'name', 'player', 'jogador'],
  distanciaTotal:          ['total distance', 'distance', 'total dist', 'dist total'],
  distanciaPorMin:         ['distance per minute', 'dist/min', 'm/min', 'distance / min'],
  velocidadeMax:           ['top speed', 'max velocity', 'max speed', 'maximum speed', 'peak speed'],
  velocidadeMedia:         ['average speed', 'avg speed', 'mean velocity', 'average velocity'],
  sprints:                 ['sprints', 'sprint count', 'number of sprints', 'sprint efforts', 'no. sprints'],
  distanciaEmSprint:       ['sprint distance', 'distance in sprint zone', 'sprint dist', 'distance sprint', 'dist sprint'],
  distanciaAltaVelocidade: ['high speed distance', 'hsr', 'hsd', 'high speed running', 'high intensity distance'],
  aceleracoes:             ['acceleration efforts', 'accelerations', 'accel efforts', 'acc efforts', 'no. accel'],
  desaceleracoes:          ['deceleration efforts', 'decelerations', 'decel efforts', 'dec efforts', 'no. decel'],
  playerLoad:              ['player load', 'playerload', 'player_load', 'pl'],
  duracaoMin:              ['duration', 'time on feet', 'minutes played', 'playing time', 'total time'],
};

function normalizarHeader(h) {
  return normalizarTexto(String(h))
    .replace(/\[.*?\]/g, '')
    .replace(/\(.*?\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Sugere o mapeamento coluna→campo para os headers do arquivo.
 * Retorna { [headerOriginal]: campo | null }
 */
export function sugerirMapeamento(headers) {
  const sugestoes = {};

  for (const header of headers) {
    const norm = normalizarHeader(header);
    let melhorCampo = null;
    let melhorScore = 0;

    for (const [campo, aliases] of Object.entries(CATAPULT_FIELD_GUESSES)) {
      for (const alias of aliases) {
        if (norm === alias) {
          // Match exato tem prioridade absoluta
          melhorCampo = campo;
          melhorScore = 999;
          break;
        }
        if (norm.includes(alias) || alias.includes(norm)) {
          const score = alias.length;
          if (score > melhorScore) { melhorCampo = campo; melhorScore = score; }
        }
      }
      if (melhorScore === 999) break;
    }

    sugestoes[header] = melhorCampo;
  }

  return sugestoes;
}

/**
 * Lê apenas os headers do CSV (primeiras 2 linhas — header + 1 amostra).
 */
export async function lerHeadersCatapult(file) {
  if (typeof Papa === 'undefined') throw new Error('PapaParse não carregado.');
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: false,
      preview: 2,
      skipEmptyLines: true,
      complete: ({ data }) => {
        if (!data[0]) { reject(new Error('CSV vazio.')); return; }
        const headers = data[0].map(h => String(h ?? '').trim()).filter(Boolean);
        resolve(headers);
      },
      error: (err) => reject(new Error(err.message)),
    });
  });
}

/**
 * Parseia o arquivo CSV usando o mapeamento confirmado pelo usuário.
 * mapeamento: { "Column Name in file": "campoDeSistema" | null }
 */
export async function parsearArquivoCatapult(file, mapeamento) {
  if (typeof Papa === 'undefined') throw new Error('PapaParse não carregado.');
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: false,
      skipEmptyLines: true,
      complete: ({ data, errors }) => {
        if (data.length < 2) { reject(new Error('CSV sem dados.')); return; }

        const headers = data[0].map(h => String(h ?? '').trim());

        // Monta índice: campoSistema → colIdx
        const colMap = {};
        headers.forEach((h, i) => {
          const campo = mapeamento[h];
          if (campo && colMap[campo] === undefined) colMap[campo] = i;
        });

        const porAtleta = [];

        for (const row of data.slice(1)) {
          const get = (campo) => {
            const idx = colMap[campo];
            if (idx === undefined) return null;
            const v = row[idx];
            return (v !== undefined && v !== null && v !== '') ? v : null;
          };

          const nome = get('nome');
          if (!nome) continue;

          const playerLoadVal = parseFloat(get('playerLoad'));

          const num = (c) => { const v = parseFloat(get(c)); return isNaN(v) ? null : v; };
          const int = (c) => { const v = parseInt(get(c)); return isNaN(v) ? null : v; };

          porAtleta.push({
            atletaId: null,
            nomeOriginalArquivo: String(nome).trim(),
            distanciaTotal:          num('distanciaTotal'),
            distanciaPorMin:         num('distanciaPorMin'),
            velocidadeMax:           num('velocidadeMax'),
            velocidadeMedia:         num('velocidadeMedia'),
            sprints:                 int('sprints'),
            distanciaEmSprint:       num('distanciaEmSprint'),
            distanciaAltaVelocidade: num('distanciaAltaVelocidade'),
            aceleracoes:             int('aceleracoes'),
            desaceleracoes:          int('desaceleracoes'),
            cargaExterna: (!isNaN(playerLoadVal) && playerLoadVal > 0)
              ? { tipo: 'playerload', valor: playerLoadVal }
              : null,
            duracaoMin: num('duracaoMin'),
          });
        }

        resolve({ porAtleta });
      },
      error: (err) => reject(new Error(err.message)),
    });
  });
}
