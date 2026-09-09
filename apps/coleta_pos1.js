/* ================================
   IMPORTS
================================ */

import { db } from "./core/firebase.js";

import {
  doc,
  getDoc
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";

import { upsertDailyMetrics } from "./core/dailyMetrics.service.js";

/* ================================
   INIT
================================ */

document.addEventListener("DOMContentLoaded", init);

async function init() {

  const athleteContextRaw = localStorage.getItem("athleteContext");

  if (!athleteContextRaw) {
    alert("Atleta não identificado.");
    window.location.href = "selecionar_atleta.html";
    return;
  }

  const athleteContext = JSON.parse(athleteContextRaw);
  const { athleteId, nome } = athleteContext;

  if (!athleteId) {
    alert("Atleta inválido.");
    window.location.href = "selecionar_atleta.html";
    return;
  }

  const hoje = new Date();
  const date = hoje.toISOString().slice(0, 10);
  document.getElementById("dataHoje").value = date;

  document.getElementById("atletaNome").innerText =
    `Atleta: ${nome ?? "-"}`;

  let pse = null;
  let concentracaoEsforco = null;
  let qualidade = null;

  /* ================================
     MAPAS DE LEGENDAS
  ================================ */

  const pseLegendaMap = {
    1: "Muito leve",
    2: "Leve",
    3: "Moderado",
    4: "Moderado",
    5: "Um pouco intenso",
    6: "Intenso",
    7: "Muito intenso",
    8: "Muito intenso",
    9: "Submáximo",
    10: "Máximo"
  };

  const densLegendaMap = {
    1: "Poucos estímulos intensos",
    2: "Baixa concentração de estímulos intensos",
    3: "Concentração moderada",
    4: "Alta concentração de estímulos intensos",
    5: "Muito alta concentração de estímulos intensos"
  };

  const qualLegendaMap = {
    1: "Muito ruim",
    2: "Ruim",
    3: "Regular",
    4: "Boa",
    5: "Excelente"
  };

  const fatorDensidadeMap = {
    1: 0.6,
    2: 0.7,
    3: 0.8,
    4: 0.9,
    5: 1.0
  };

  /* ================================
     PSE
  ================================ */

  document.querySelectorAll("[data-pse]").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-pse]")
        .forEach(b => b.classList.remove("selected"));

      btn.classList.add("selected");
      pse = Number(btn.dataset.pse);

      document.getElementById("pseLegenda").innerText =
        pseLegendaMap[pse] || "";
    });
  });

  /* ================================
     CONCENTRAÇÃO DE ESFORÇO
  ================================ */

  document.querySelectorAll("[data-dens]").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-dens]")
        .forEach(b => b.classList.remove("selected"));

      btn.classList.add("selected");
      concentracaoEsforco = Number(btn.dataset.dens);

      document.getElementById("densLegenda").innerText =
        densLegendaMap[concentracaoEsforco] || "";
    });
  });

  /* ================================
     QUALIDADE
  ================================ */

  document.querySelectorAll("[data-qual]").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-qual]")
        .forEach(b => b.classList.remove("selected"));

      btn.classList.add("selected");
      qualidade = Number(btn.dataset.qual);

      document.getElementById("qualLegenda").innerText =
        qualLegendaMap[qualidade] || "";
    });
  });

  /* ================================
     SUBMIT
  ================================ */

  document.getElementById("formPos")
    .addEventListener("submit", async (e) => {
      e.preventDefault();

      const tempo = Number(document.getElementById("tempo").value);

      if (!pse || !tempo || !concentracaoEsforco || !qualidade) {
        alert("Preencha todos os campos.");
        return;
      }

      // 🔹 Carga clássica (mantida)
      const carga = pse * tempo;

      // 🔹 Nova: carga ajustada por densidade
      const fatorDensidade = fatorDensidadeMap[concentracaoEsforco];
      const cargaAjustada = carga * fatorDensidade;

      await upsertDailyMetrics({
        athleteId,
        date,
        block: "post",
        data: {
          pse,
          tempo,
          concentracaoEsforco,
          fatorDensidade,
          qualidade,
          carga,
          cargaAjustada
        }
      });

      alert("Pós-treino salvo com sucesso.");
      window.location.href = "selecionar_atleta.html";
    });
}
