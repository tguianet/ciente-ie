import { upsertDailyMetrics } from "./core/dailyMetrics.service.js";
import { db, auth } from "../core/firebase.js";
import { onAuthStateChanged } from
  "https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js";
import { collection, getDocs, query, where } from
  "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";

/* ===============================
   DEBUG AUTH
================================ */
onAuthStateChanged(auth, (user) => {
  if (user) {
    console.log("[coleta_pre] Auth UID:", user.uid);
    console.log("[coleta_pre] Auth email:", user.email);
    console.log("[coleta_pre] athleteContext:", localStorage.getItem("athleteContext"));
  } else {
    console.warn("[coleta_pre] Nenhum usuário autenticado no Firebase Auth");
  }
});

/* ===============================
   CONTEXTO DO ATLETA
================================ */
const ctxRaw = localStorage.getItem("athleteContext");
const ctx = ctxRaw ? JSON.parse(ctxRaw) : null;

if (!ctx?.athleteId) {
  alert("Nenhum atleta selecionado.");
  window.location.href = "selecionar_atleta.html";
  throw new Error("athleteContext ausente");
}

if (!ctx?.clubId) {
  alert("Clube não identificado. Faça login novamente.");
  window.location.href = "selecionar_atleta.html";
  throw new Error("clubId ausente");
}

const athleteId = String(ctx.athleteId);
const clubId    = String(ctx.clubId);

/* ===============================
   DATA LOCAL
================================ */
const hoje = new Date();
const yyyy = hoje.getFullYear();
const mm   = String(hoje.getMonth() + 1).padStart(2, "0");
const dd   = String(hoje.getDate()).padStart(2, "0");
const dataHoje = `${yyyy}-${mm}-${dd}`;

document.getElementById("prontidao-data").value = dataHoje;

/* ===============================
   INFO ATLETA
================================ */
// Header com foto
const fotoEl = document.getElementById("atletaFoto");
if (ctx.fotoUrl) {
  fotoEl.innerHTML = `<img src="${ctx.fotoUrl}" style="width:100%;height:100%;object-fit:cover;">`;
} else {
  const p = (ctx.nome || "").trim().split(" ");
  fotoEl.textContent = (p[0]?.[0] || "") + (p[p.length - 1]?.[0] || p[0]?.[1] || "");
  fotoEl.textContent = fotoEl.textContent.toUpperCase();
}
document.getElementById("atletaNomePre").textContent = ctx.nome || "—";
document.getElementById("atletaSubPre").textContent  = [ctx.posicao, ctx.categoria].filter(Boolean).join(" · ");

/* ===============================
   Z-SCORE CMJ
   Busca histórico do atleta e calcula z-score do salto atual.
   Mínimo de 7 registros para z-score ser confiável.
================================ */
async function calcularZScoreCMJ(saltoAtual) {
  try {
    const snap = await getDocs(query(
      collection(db, "daily_metrics"),
      where("athleteId", "==", athleteId),
      where("clubId",    "==", clubId)
    ));

    const historico = [];
    snap.forEach(d => {
      const s = d.data()?.pre?.salto;
      if (s != null && typeof s === "number" && s > 0) historico.push(s);
    });

    if (historico.length < 7) return null; // histórico insuficiente

    const n    = historico.length;
    const mean = historico.reduce((a, b) => a + b, 0) / n;
    const sd   = Math.sqrt(historico.reduce((s, x) => s + (x - mean) ** 2, 0) / n);

    if (sd === 0) return null;

    return Number(((saltoAtual - mean) / sd).toFixed(2));
  } catch (err) {
    console.warn("Erro ao calcular z-score CMJ:", err);
    return null;
  }
}

/* ===============================
   SUBMIT PRÉ
================================ */
document.getElementById("formProntidao")
  .addEventListener("submit", async (e) => {
    e.preventDefault();

    const getVal = (n) =>
      Number(document.querySelector(`input[name="${n}"]:checked`)?.value);

    const sono     = getVal("sono");
    const estresse = getVal("estresse");
    const fadiga   = getVal("fadiga");
    const dor      = getVal("dor");
    const humor    = getVal("humor");

    if (![sono, estresse, fadiga, dor, humor].every(Boolean)) {
      alert("Preencha todas as escalas de prontidão.");
      return;
    }

    const btnSalvar = document.querySelector("#formProntidao [type=submit]");
    const textoOriginal = btnSalvar.textContent;
    btnSalvar.disabled = true;
    btnSalvar.textContent = "Gravando dados…";

    const saltoVal       = document.getElementById("salto").value;
    const salto          = saltoVal ? Number(saltoVal) : null;
    const pesoPreVal     = document.getElementById("pesoPreTreino").value;
    const pesoPreTreino  = pesoPreVal ? Number(pesoPreVal) : null;

    // Z-score CMJ (null se histórico insuficiente ou salto não informado)
    const cmj_zscore = salto != null ? await calcularZScoreCMJ(salto) : null;

    const hora    = new Date().getHours();
    const periodo = hora < 12 ? "manha" : hora < 18 ? "tarde" : "noite";

    // Regiões de dor selecionadas no mapa corporal
    // getSelectedRegions() retorna string[] definido em coleta_pre.html
    const regioes_dor = (typeof window.getSelectedRegions === "function")
      ? window.getSelectedRegions()
      : [];
    const sem_dor_localizada = (typeof window.getSemDorLocalizada === "function")
      ? window.getSemDorLocalizada()
      : false;

    // Fator emocional (piso 1.0, teto 1.3) — calculado no momento da coleta
    function _calcFatorEmocional(h) {
      if (h == null || h <= 2) return 1.0;
      if (h <= 4) return 1.1;
      if (h <= 6) return 1.2;
      return 1.3;
    }
    const fatorEmocional = _calcFatorEmocional(humor);
    const fatorAplicado  = fatorEmocional > 1.0;

    try {
      await upsertDailyMetrics({
        athleteId,
        date: dataHoje,
        block: "pre",
        data: {
          sono,
          estresse,
          fadiga,
          dor,
          hooper:      sono + estresse + fadiga + dor,
          humorEmocional: humor,
          pesoPreTreino,
          salto,
          cmj_zscore,  // null até ter ≥7 registros; dashboard usa quando disponível
          regioes_dor,
          sem_dor_localizada, // [] se nenhuma região marcada; ex: ["Quadríceps Esq.", "Lombar"]
          periodo,
          origem: "manual"
        }
      });

      await upsertDailyMetrics({
        athleteId,
        date: dataHoje,
        block: "scores",
        data: {
          fatorEmocional,
          fatorAplicado,
          fatorCorrigido: null,   // reservado Fase 2
        }
      });

      alert("Prontidão salva com sucesso.");
      window.location.href = "selecionar_atleta.html";

    } catch (err) {
      console.error(err);
      btnSalvar.disabled = false;
      btnSalvar.textContent = textoOriginal;
      alert("Erro ao salvar prontidão. Verifique sua conexão e tente novamente.");
    }
  });