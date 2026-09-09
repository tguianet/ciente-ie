/**
 * operacoes.service.js
 * API central para o módulo Operações (Jogos e Viagens).
 * Padrão: coleções flat com campo clubId.
 */

import { db } from '../core/firebase.js';
import {
  collection, doc, getDoc, getDocs, addDoc, setDoc, updateDoc, deleteDoc,
  query, where, orderBy, serverTimestamp, Timestamp
} from 'https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js';

// ─── helpers ────────────────────────────────────────────────────────────────

function isoWeek(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
}

function semanaAnoAtual() {
  const d = new Date();
  return `S${isoWeek(d)}-${d.getFullYear()}`;
}

// ─── JOGOS ──────────────────────────────────────────────────────────────────

/**
 * @param {string} clubId
 * @param {{ adversario, competicao, mando, dataHoraJogo: Date, local, status }} dados
 */
export async function criarJogo(clubId, dados) {
  const ref = await addDoc(collection(db, 'jogos'), {
    clubId,
    adversario: dados.adversario,
    competicao: dados.competicao || '',
    mando: dados.mando || 'casa',
    dataHoraJogo: Timestamp.fromDate(new Date(dados.dataHoraJogo)),
    local: dados.local || { estadio: '', cidade: '', uf: '' },
    viagemId: null,
    status: dados.status || 'agendado',
    criadoEm: serverTimestamp(),
  });
  return ref.id;
}

export async function atualizarJogo(jogoId, dados) {
  const ref = doc(db, 'jogos', jogoId);
  const payload = { ...dados, atualizadoEm: serverTimestamp() };
  if (dados.dataHoraJogo) {
    payload.dataHoraJogo = Timestamp.fromDate(new Date(dados.dataHoraJogo));
  }
  await updateDoc(ref, payload);
}

export async function excluirJogo(jogoId) {
  await deleteDoc(doc(db, 'jogos', jogoId));
}

export async function listarJogos(clubId) {
  const q = query(
    collection(db, 'jogos'),
    where('clubId', '==', clubId),
    orderBy('dataHoraJogo', 'desc')
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function getJogo(jogoId) {
  const snap = await getDoc(doc(db, 'jogos', jogoId));
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() };
}

export async function vincularJogoViagem(jogoId, viagemId) {
  await updateDoc(doc(db, 'jogos', jogoId), { viagemId, atualizadoEm: serverTimestamp() });
}

// ─── VIAGENS ────────────────────────────────────────────────────────────────

/**
 * @param {string} clubId
 * @param {{ tipoOperacao, periodo, gruposConvocados, hospedagem, status }} dados
 * @param {string} uid  UID do usuário criador
 */
export async function criarViagem(clubId, dados, uid) {
  const ref = await addDoc(collection(db, 'viagens'), {
    clubId,
    tipoOperacao:    dados.tipoOperacao    || 'viagem_no_dia',
    meioTransporte:  dados.meioTransporte  || null,
    periodo: {
      inicio: dados.periodo?.inicio ? Timestamp.fromDate(new Date(dados.periodo.inicio)) : null,
      fim:    dados.periodo?.fim    ? Timestamp.fromDate(new Date(dados.periodo.fim))    : null,
    },
    gruposConvocados: dados.gruposConvocados || [],
    hospedagem: dados.hospedagem || { hotel: '', endereco: '', checkin: null, checkout: null },
    // Snapshot do jogo vinculado
    jogoRef:       dados.jogoRef       || null,
    jogoAdversario:dados.jogoAdversario|| null,
    jogoData:      dados.jogoData      || null,
    jogoHorario:   dados.jogoHorario   || null,
    jogoMando:     dados.jogoMando     || null,
    jogoCidade:    dados.jogoCidade    || null,
    jogoCompeticao:dados.jogoCompeticao|| null,
    status: dados.status || 'planejamento',
    criadoPor: uid || '',
    criadoEm: serverTimestamp(),
    atualizadoEm: serverTimestamp(),
  });
  return ref.id;
}

export async function atualizarViagem(viagemId, dados, uid) {
  const payload = { ...dados, atualizadoEm: serverTimestamp() };
  if (dados.periodo?.inicio) payload.periodo = {
    ...dados.periodo,
    inicio: Timestamp.fromDate(new Date(dados.periodo.inicio)),
    fim: dados.periodo.fim ? Timestamp.fromDate(new Date(dados.periodo.fim)) : null,
  };
  if (uid) payload.atualizadoPor = uid;
  await updateDoc(doc(db, 'viagens', viagemId), payload);
}

export async function listarViagens(clubId) {
  const q = query(
    collection(db, 'viagens'),
    where('clubId', '==', clubId)
  );
  const snap = await getDocs(q);
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => {
      const ta = a.criadoEm?.toMillis ? a.criadoEm.toMillis() : 0;
      const tb = b.criadoEm?.toMillis ? b.criadoEm.toMillis() : 0;
      return tb - ta;
    });
}

export async function excluirViagem(viagemId) {
  await deleteDoc(doc(db, 'viagens', viagemId));
}

export async function getViagem(viagemId) {
  const snap = await getDoc(doc(db, 'viagens', viagemId));
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() };
}

// ─── PARTICIPANTES ───────────────────────────────────────────────────────────

/**
 * Gera participantes a partir dos grupos do Planejamento (snapshot).
 * Não sobrescreve docs já existentes com origem "grupo".
 */
export async function gerarParticipantesDeGrupos(viagemId, clubId, gruposConvocados) {
  if (!gruposConvocados || gruposConvocados.length === 0) return;

  // Busca doc de planejamento da semana atual
  const semana = semanaAnoAtual();
  const planDocId = `${semana}_${clubId}`;
  const planSnap = await getDoc(doc(db, 'assessments_planning', planDocId));
  if (!planSnap.exists()) return;

  const gruposAtletas = planSnap.data().gruposAtletas || {};

  // IDs já existentes na subcoleção (evita duplicar)
  const partSnap = await getDocs(collection(db, 'viagens', viagemId, 'participantes'));
  const idsExistentes = new Set(partSnap.docs.map(d => d.data().pessoaId));

  // Coleta todos os IDs de atleta dos grupos selecionados (sem duplicata)
  const idsSet = new Set();
  gruposConvocados.forEach(g => {
    (gruposAtletas[g] || []).forEach(id => idsSet.add(id));
  });

  // Para cada atleta, busca dados e cria participante
  for (const atletaId of idsSet) {
    if (idsExistentes.has(atletaId)) continue; // já existe, preserva

    let nomeSnapshot = atletaId;
    let grupoOrigem = null;

    // Descobre grupo de origem
    for (const g of gruposConvocados) {
      if ((gruposAtletas[g] || []).includes(atletaId)) { grupoOrigem = g; break; }
    }

    // Busca nome do atleta
    try {
      const atletaSnap = await getDoc(doc(db, 'athletes', atletaId));
      if (atletaSnap.exists()) nomeSnapshot = atletaSnap.data().nome || atletaId;
    } catch (_) {}

    await addDoc(collection(db, 'viagens', viagemId, 'participantes'), {
      tipo: 'atleta',
      pessoaId: atletaId,
      nomeSnapshot,
      origem: 'grupo',
      grupoOrigem,
      status: 'convocado',
      quarto: null,
      assentoTransporte: null,
      observacaoInterna: null,
      observacaoPublica: null,
    });
  }
}

export async function listarParticipantes(viagemId) {
  const snap = await getDocs(collection(db, 'viagens', viagemId, 'participantes'));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function adicionarParticipante(viagemId, dados) {
  const ref = await addDoc(collection(db, 'viagens', viagemId, 'participantes'), {
    tipo: dados.tipo || 'staff',
    pessoaId: dados.pessoaId || dados.nomeSnapshot || '',
    nomeSnapshot: dados.nomeSnapshot || '',
    origem: dados.origem || 'manual',
    grupoOrigem: dados.grupoOrigem || null,
    status: dados.status || 'convocado',
    quarto: dados.quarto || null,
    assentoTransporte: dados.assentoTransporte || null,
    observacaoInterna: dados.observacaoInterna || null,
    observacaoPublica: dados.observacaoPublica || null,
  });
  return ref.id;
}

export async function atualizarParticipante(viagemId, partId, dados) {
  await updateDoc(doc(db, 'viagens', viagemId, 'participantes', partId), dados);
}

export async function removerParticipante(viagemId, partId) {
  await deleteDoc(doc(db, 'viagens', viagemId, 'participantes', partId));
}

// ─── ITINERÁRIO ──────────────────────────────────────────────────────────────

export async function listarItinerario(viagemId) {
  const q = query(
    collection(db, 'viagens', viagemId, 'itinerario'),
    orderBy('dataHora', 'asc')
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function criarEventoItinerario(viagemId, dados, uid) {
  const ref = await addDoc(collection(db, 'viagens', viagemId, 'itinerario'), {
    dataHora: dados.dataHora ? Timestamp.fromDate(new Date(dados.dataHora)) : null,
    tipo: dados.tipo || 'reuniao',
    titulo: dados.titulo || '',
    local: dados.local || '',
    responsavel: dados.responsavel || null,
    escopo: dados.escopo || 'todos',
    destinatarios: dados.destinatarios || [],
    jogoId: dados.jogoId || null,
    transporte: dados.transporte || null,
    status: dados.status || 'previsto',
    criadoEm: serverTimestamp(),
    criadoPor: uid || '',
    atualizadoEm: serverTimestamp(),
    atualizadoPor: uid || '',
  });
  return ref.id;
}

export async function atualizarEventoItinerario(viagemId, eventoId, dados, uid) {
  const payload = { ...dados, atualizadoEm: serverTimestamp(), atualizadoPor: uid || '' };
  if (dados.dataHora) payload.dataHora = Timestamp.fromDate(new Date(dados.dataHora));
  await updateDoc(doc(db, 'viagens', viagemId, 'itinerario', eventoId), payload);
}

export async function excluirEventoItinerario(viagemId, eventoId) {
  await deleteDoc(doc(db, 'viagens', viagemId, 'itinerario', eventoId));
}

// ─── CHECKLIST ───────────────────────────────────────────────────────────────

const CHECKLIST_PADRAO = [
  { item: 'Bolas de jogo', categoria: 'material' },
  { item: 'Cones e coletes de treino', categoria: 'material' },
  { item: 'Bomba de ar', categoria: 'material' },
  { item: 'Uniforme titular (cor confirmada)', categoria: 'uniforme' },
  { item: 'Uniforme reserva', categoria: 'uniforme' },
  { item: 'Água e repositores', categoria: 'alimentacao' },
  { item: 'Lanches / Refeição pós-jogo', categoria: 'alimentacao' },
  { item: 'Kit médico completo', categoria: 'medico' },
  { item: 'Maca e cadeira de rodas', categoria: 'medico' },
  { item: 'Gelo / bolsas de gelo', categoria: 'medico' },
  { item: 'Documentos dos atletas (RG/passaporte)', categoria: 'documentos' },
  { item: 'Súmulas e documentação do clube', categoria: 'documentos' },
];

export async function gerarChecklistPadrao(viagemId) {
  const existente = await getDocs(collection(db, 'viagens', viagemId, 'checklist'));
  if (!existente.empty) return; // já tem itens, não sobrescreve
  for (const item of CHECKLIST_PADRAO) {
    await addDoc(collection(db, 'viagens', viagemId, 'checklist'), {
      ...item, responsavel: null, prazo: null, status: 'pendente',
      concluidoPor: null, concluidoEm: null,
    });
  }
}

export async function listarChecklist(viagemId) {
  const snap = await getDocs(collection(db, 'viagens', viagemId, 'checklist'));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function criarItemChecklist(viagemId, dados) {
  const ref = await addDoc(collection(db, 'viagens', viagemId, 'checklist'), {
    item: dados.item || '',
    categoria: dados.categoria || 'outros',
    responsavel: dados.responsavel || null,
    prazo: dados.prazo ? Timestamp.fromDate(new Date(dados.prazo)) : null,
    status: 'pendente',
    concluidoPor: null,
    concluidoEm: null,
  });
  return ref.id;
}

export async function atualizarItemChecklist(viagemId, itemId, dados) {
  const payload = { ...dados };
  if (dados.prazo) payload.prazo = Timestamp.fromDate(new Date(dados.prazo));
  if (dados.status === 'ok') {
    payload.concluidoEm = serverTimestamp();
  }
  await updateDoc(doc(db, 'viagens', viagemId, 'checklist', itemId), payload);
}

export async function excluirItemChecklist(viagemId, itemId) {
  await deleteDoc(doc(db, 'viagens', viagemId, 'checklist', itemId));
}
