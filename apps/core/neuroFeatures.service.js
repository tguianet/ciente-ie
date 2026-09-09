/* =====================================================
   NeuroScore – Features Analíticas
   (SEM Cloud Functions, SEM índice composto)
   ===================================================== */

import { db } from "./firebase.js";
import {
  collection,
  query,
  where,
  orderBy,
  limit,
  getDocs,
  updateDoc,
  doc
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";

export async function calcularNeuroFeatures(athleteId) {
  if (!athleteId) return;

  /* ===============================
     QUERY SIMPLES (SEM ÍNDICE)
  =============================== */
  const q = query(
    collection(db, "daily_metrics"),
    where("athleteId", "==", athleteId),
    orderBy("date", "desc"),
    limit(30)
  );

  const snap = await getDocs(q);

  /* ===============================
     FILTRA NO JS
  =============================== */
  const registros = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(r => typeof r.neuro?.score === "number");

  if (registros.length < 4) return;

  const usados = registros.slice(0, 14);
  const scores = usados.map(r => r.neuro.score);

  /* ===============================
     Z-SCORE
  =============================== */
  const media = scores.reduce((a,b)=>a+b,0) / scores.length;
  const desvio = Math.sqrt(
    scores.reduce((s,x)=>s+(x-media)**2,0) / scores.length
  );

  const atual = usados[0];
  const z_neuro = desvio
    ? Number(((atual.neuro.score - media) / desvio).toFixed(2))
    : 0;

  /* ===============================
     TENDÊNCIA
  =============================== */
  const xs = scores.map((_,i)=>i);
  const ys = scores;
  const n = xs.length;

  const somaX = xs.reduce((a,b)=>a+b,0);
  const somaY = ys.reduce((a,b)=>a+b,0);
  const somaXY = xs.reduce((s,x,i)=>s+x*ys[i],0);
  const somaXX = xs.reduce((s,x)=>s+x*x,0);

  let slope = 0;
  const den = n*somaXX - somaX*somaX;
  if (den !== 0) {
    slope = (n*somaXY - somaX*somaY) / den;
  }

  const tendencia_7d =
    slope > 0.3 ? "melhora" :
    slope < -0.3 ? "queda" :
    "estavel";

  /* ===============================
     DELTA PRÉ
  =============================== */
  const pre = usados.filter(r => r.neuro.horario === "manha");
  let delta_pre = null;

  if (pre.length >= 3) {
    const mediaPre =
      pre.reduce((s,r)=>s+r.neuro.score,0) / pre.length;

    if (mediaPre > 0) {
      delta_pre = Number(
        (((atual.neuro.score - mediaPre) / mediaPre) * 100).toFixed(1)
      );
    }
  }

  /* ===============================
     UPDATE
  =============================== */
  const ref = doc(db, "daily_metrics", atual.id);

  await updateDoc(ref, {
    "neuro.features": {
      z_neuro,
      tendencia_7d,
      delta_pre
    }
  });
}
