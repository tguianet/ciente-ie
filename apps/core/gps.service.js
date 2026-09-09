import { db } from './firebase.js';
import {
  doc, getDoc, setDoc, getDocs,
  collection, query, where, Timestamp
} from 'https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js';

export function normalizarTexto(texto) {
  if (!texto) return '';
  return String(texto).trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

// Salva (ou sobrescreve) bloco GPS de uma sessão
export async function salvarSessaoGPS(clubId, date, dadosGPS) {
  const ref = doc(db, 'clubs', clubId, 'sessoes', date);
  await setDoc(ref, {
    gps: { ...dadosGPS, importadoEm: Timestamp.now() }
  }, { merge: true });
}

// Lista todas as sessões com dado GPS, mais recente primeiro
export async function listarSessoesGPS(clubId) {
  const snap = await getDocs(collection(db, 'clubs', clubId, 'sessoes'));
  return snap.docs
    .filter(d => d.data().gps)
    .map(d => ({ id: d.id, gps: d.data().gps }))
    .sort((a, b) => (b.id > a.id ? 1 : -1));
}

// Busca dados GPS de uma sessão específica (por date = YYYY-MM-DD)
export async function buscarSessaoGPS(clubId, date) {
  const snap = await getDoc(doc(db, 'clubs', clubId, 'sessoes', date));
  return snap.exists() ? (snap.data().gps || null) : null;
}

// Retorna todos os atletas do clube (sem filtro ativo para não perder nenhum)
export async function buscarAtletasDoClube(clubId) {
  const q = query(collection(db, 'athletes'), where('clubId', '==', clubId));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ── Configurações por clube ─────────────────────────────────────

export async function buscarMapeamentoCatapult(clubId) {
  const snap = await getDoc(doc(db, 'clubs', clubId, 'configuracoes', 'mapeamentoCatapult'));
  return snap.exists() ? snap.data() : null;
}

export async function salvarMapeamentoCatapult(clubId, mapeamento) {
  await setDoc(
    doc(db, 'clubs', clubId, 'configuracoes', 'mapeamentoCatapult'),
    { mapeamento, atualizadoEm: Timestamp.now() }
  );
}

export async function buscarMapeamentoNomes(clubId) {
  const snap = await getDoc(doc(db, 'clubs', clubId, 'configuracoes', 'mapeamentoNomes'));
  return snap.exists() ? (snap.data().mapeamento || {}) : {};
}

export async function salvarMapeamentoNomes(clubId, mapeamento) {
  await setDoc(
    doc(db, 'clubs', clubId, 'configuracoes', 'mapeamentoNomes'),
    { mapeamento, atualizadoEm: Timestamp.now() }
  );
}

// Retorna todas as partidas scout do clube (para cálculo de minutagem)
export async function buscarScoutPartidas(clubId) {
  const snap = await getDocs(query(
    collection(db, 'scout_partidas'),
    where('clubId', '==', clubId)
  ));
  return snap.docs.map(d => {
    const data = d.data();
    let dataStr = data.data;
    if (dataStr?.toDate) dataStr = dataStr.toDate().toLocaleDateString('en-CA');
    return {
      id: d.id,
      data: typeof dataStr === 'string' ? dataStr : null,
      duracaoSegundos: data.duracaoSegundos || 5400,
      playedSeconds: data.playedSeconds || {},
    };
  }).filter(p => p.data).sort((a, b) => b.data.localeCompare(a.data));
}

// Retorna um Set com as datas (YYYY-MM-DD) de jogos do clube
export async function buscarDatasJogo(clubId) {
  const snap = await getDocs(query(
    collection(db, 'scout_partidas'),
    where('clubId', '==', clubId)
  ));
  const datas = new Set();
  snap.forEach(d => {
    let data = d.data().data;
    if (data?.toDate) data = data.toDate().toLocaleDateString('en-CA');
    if (typeof data === 'string') datas.add(data);
  });
  return datas;
}
