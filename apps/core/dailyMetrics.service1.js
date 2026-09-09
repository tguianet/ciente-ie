import {
  doc,
  getDoc,
  setDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";

import { db } from "./firebase.js";

/* ============================
   UTILIDADES
============================ */

export function getDailyMetricsId(athleteId, date) {
  return `${athleteId}_${date}`;
}

/* ============================
   UPSERT CORE v3 (SaaS READY)
============================ */

export async function upsertDailyMetrics({
  athleteId,
  date,
  block,
  data
}) {
  if (!athleteId || !date || !block || !data) {
    throw new Error("Parâmetros inválidos para upsertDailyMetrics");
  }

  const allowedBlocks = ["pre", "post", "neuro", "features", "scores"];
  if (!allowedBlocks.includes(block)) {
    throw new Error(`Bloco não permitido: ${block}`);
  }

  // 🔹 Busca o atleta para herdar clubId e teamId
  const athleteRef = doc(db, "athletes", athleteId);
  const athleteSnap = await getDoc(athleteRef);

  if (!athleteSnap.exists()) {
    throw new Error("Atleta não encontrado.");
  }

  const athleteData = athleteSnap.data();

  if (!athleteData.clubId) {
    throw new Error("Atleta sem clubId definido.");
  }

  const docId = getDailyMetricsId(athleteId, date);
  const ref = doc(db, "daily_metrics", docId);
  const snap = await getDoc(ref);

  const base = {
    athleteId,
    date,
    clubId: athleteData.clubId,
    teamId: athleteData.teamId || null,
    meta: {
      updatedAt: serverTimestamp()
    }
  };

  if (!snap.exists()) {
    base.meta.createdAt = serverTimestamp();
    base.meta.origem = [block];
  } else {
    const origemAtual = snap.data().meta?.origem || [];
    base.meta.origem = Array.from(new Set([...origemAtual, block]));
  }

  await setDoc(
    ref,
    {
      ...base,
      [block]: data
    },
    { merge: true }
  );

  return docId;
}