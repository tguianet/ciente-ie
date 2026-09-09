/**
 * Adapter Polar Team Pro
 * Lê CSV ou XLSX exportado pelo Polar, mapeia colunas automaticamente.
 * Depende dos globais XLSX (SheetJS) e Papa (PapaParse) carregados pela página.
 */

import { normalizarTexto } from './gps.service.js';

// Aliases conhecidos por campo. A coluna é normalizada antes do match:
// lowercase, sem acentos, sem conteúdo entre [], sem espaços extras.
const POLAR_FIELD_ALIASES = {
  nome:                    ['player name', 'name', 'athlete name', 'athlete'],
  distanciaTotal:          ['total distance', 'distancia total', 'total dist'],
  distanciaPorMin:         ['distance / min', 'distance per min', 'dist/min', 'dist / min', 'd/min'],
  velocidadeMax:           ['maximum speed', 'max speed', 'speed max', 'top speed'],
  velocidadeMedia:         ['average speed', 'avg speed', 'mean speed'],
  sprints:                 ['sprints', 'sprint count', 'number of sprints', 'no. of sprints'],
  distanciaEmSprint:       ['sprint distance', 'distance in sprint zone', 'sprint dist', 'distance sprint', 'dist sprint'],
  distanciaAltaVelocidade: ['distance in speed zone', 'hsr', 'high speed running', 'high speed distance'],
  aceleracoes:             ['number of accelerations', 'accelerations', 'accel count', 'no. of accelerations'],
  desaceleracoes:          ['number of decelerations', 'decelerations', 'decel count', 'no. of decelerations'],
  cargaTreino:             ['training load score', 'training load', 'load score'],
  cargaCardio:             ['cardio load', 'cardiac load'],
  duracaoMin:              ['duration', 'time', 'playing time', 'total time'],
};

function normalizarHeader(h) {
  return normalizarTexto(String(h))
    .replace(/\[.*?\]/g, '')  // remove [unidade]
    .replace(/\(.*?\)/g, '')  // remove (unidade)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Mapeia os headers do arquivo para os campos do schema.
 * Retorna { mapa: { campo: colIdx }, zonaVelocidadeCols: [idx, ...] }
 *
 * Nota: "distance in speed zone" pode se repetir (uma coluna por zona).
 * Nesse caso, guardamos todos os índices em zonaVelocidadeCols para somar na leitura.
 * TODO: quando houver um export real do América, confirmar se zonas precisam ser
 * filtradas (ex: só Z4+Z5) em vez de somadas integralmente.
 */
function mapearColunas(headers) {
  const mapa = {};
  const zonaVelocidadeCols = [];
  const normHeaders = headers.map((h, i) => ({ norm: normalizarHeader(h), idx: i }));

  for (const [campo, aliases] of Object.entries(POLAR_FIELD_ALIASES)) {
    for (const { norm, idx } of normHeaders) {
      for (const alias of aliases) {
        if (norm.includes(alias)) {
          if (alias === 'distance in speed zone') {
            // Pode ter múltiplas colunas de zona — coleta todas
            zonaVelocidadeCols.push(idx);
            if (mapa[campo] === undefined) mapa[campo] = idx;
          } else if (mapa[campo] === undefined) {
            mapa[campo] = idx;
          }
          break;
        }
      }
    }
  }

  return { mapa, zonaVelocidadeCols };
}

function getVal(row, idx) {
  if (idx === undefined || idx === null) return null;
  const v = row[idx];
  return (v !== undefined && v !== null && v !== '') ? v : null;
}

function parsearLinhas(rows, mapa, zonaVelocidadeCols) {
  const porAtleta = [];

  for (const row of rows) {
    const nome = getVal(row, mapa.nome);
    if (!nome || String(nome).trim() === '') continue;

    // HSR: soma todas as zonas se múltiplas, caso contrário usa o campo direto
    let distanciaAltaVelocidade = null;
    if (zonaVelocidadeCols.length > 1) {
      distanciaAltaVelocidade = zonaVelocidadeCols.reduce((acc, idx) => {
        const v = parseFloat(getVal(row, idx));
        return acc + (isNaN(v) ? 0 : v);
      }, 0);
    } else {
      const v = parseFloat(getVal(row, mapa.distanciaAltaVelocidade));
      distanciaAltaVelocidade = isNaN(v) ? null : v;
    }

    // Carga externa: prefere training_load_score, fallback cardio_load
    let cargaExterna = null;
    const cargaTreino = parseFloat(getVal(row, mapa.cargaTreino));
    const cargaCardio = parseFloat(getVal(row, mapa.cargaCardio));
    if (!isNaN(cargaTreino) && cargaTreino > 0) {
      cargaExterna = { tipo: 'training_load_score', valor: cargaTreino };
    } else if (!isNaN(cargaCardio) && cargaCardio > 0) {
      cargaExterna = { tipo: 'cardio_load', valor: cargaCardio };
    }

    const num = (idx) => { const v = parseFloat(getVal(row, idx)); return isNaN(v) ? null : v; };
    const int = (idx) => { const v = parseInt(getVal(row, idx)); return isNaN(v) ? null : v; };

    porAtleta.push({
      atletaId: null, // resolvido no passo de vinculação
      nomeOriginalArquivo: String(nome).trim(),
      distanciaTotal:          num(mapa.distanciaTotal),
      distanciaPorMin:         num(mapa.distanciaPorMin),
      velocidadeMax:           num(mapa.velocidadeMax),
      velocidadeMedia:         num(mapa.velocidadeMedia),
      sprints:                 int(mapa.sprints),
      distanciaEmSprint:       num(mapa.distanciaEmSprint),
      distanciaAltaVelocidade,
      aceleracoes:             int(mapa.aceleracoes),
      desaceleracoes:          int(mapa.desaceleracoes),
      cargaExterna,
      duracaoMin:              num(mapa.duracaoMin),
    });
  }

  return porAtleta;
}

async function parsearCSV(file) {
  if (typeof Papa === 'undefined') throw new Error('PapaParse não carregado.');
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: false,
      skipEmptyLines: true,
      complete: ({ data, errors }) => {
        if (errors.length && data.length < 2) { reject(new Error(errors[0].message)); return; }
        const headers = (data[0] || []).map(h => String(h ?? ''));
        const { mapa, zonaVelocidadeCols } = mapearColunas(headers);
        const porAtleta = parsearLinhas(data.slice(1), mapa, zonaVelocidadeCols);
        resolve({ porAtleta });
      },
      error: (err) => reject(new Error(err.message)),
    });
  });
}

async function parsearXLSX(file) {
  if (typeof XLSX === 'undefined') throw new Error('SheetJS (XLSX) não carregado.');
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(e.target.result, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
        if (data.length < 2) { reject(new Error('Planilha sem dados.')); return; }
        const headers = (data[0] || []).map(h => String(h ?? ''));
        const rows = data.slice(1).filter(r => r.some(v => v !== null && v !== ''));
        const { mapa, zonaVelocidadeCols } = mapearColunas(headers);
        const porAtleta = parsearLinhas(rows, mapa, zonaVelocidadeCols);
        resolve({ porAtleta });
      } catch (err) { reject(err); }
    };
    reader.onerror = () => reject(new Error('Erro ao ler arquivo.'));
    reader.readAsArrayBuffer(file);
  });
}

export async function parsearArquivoPolar(file) {
  const nome = file.name.toLowerCase();
  if (nome.endsWith('.xlsx') || nome.endsWith('.xls')) return parsearXLSX(file);
  return parsearCSV(file);
}
