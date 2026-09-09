/* ================================
   IMPORTS
================================ */

import { db } from "./core/firebase.js";
import {
  collection,
  query,
  where,
  getDocs,
  limit
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";
import { upsertDailyMetrics } from "./core/dailyMetrics.service.js";

/* ================================
   CONSTANTES DE DETECÇÃO
   Duplicata = PSE idêntico E tempo dentro de ±TOLERANCIA_MIN minutos.
================================ */
const TOLERANCIA_MIN = 2;

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
  const { athleteId, nome, clubId } = athleteContext;

  if (!athleteId) {
    alert("Atleta inválido.");
    window.location.href = "selecionar_atleta.html";
    return;
  }

  const hoje = new Date();
  const date = hoje.toLocaleDateString('en-CA');
  document.getElementById("dataHoje").value = date;
  // Header com foto
  const fotoEl = document.getElementById("atletaFoto");
  const fotoUrl = athleteContext.fotoUrl;
  if (fotoUrl) {
    fotoEl.innerHTML = `<img src="${fotoUrl}" style="width:100%;height:100%;object-fit:cover;">`;
  } else {
    const p = (nome || "").trim().split(" ");
    fotoEl.textContent = ((p[0]?.[0] || "") + (p[p.length - 1]?.[0] || p[0]?.[1] || "")).toUpperCase();
  }
  document.getElementById("atletaNome").textContent = nome ?? "—";
  document.getElementById("atletaSubPos").textContent = [athleteContext.posicao, athleteContext.categoria].filter(Boolean).join(" · ");

  let pse        = null;
  let densidade  = null;
  let qualidade  = null;
  let tipoSessao = "treino"; // será "jogo" se o scout detectar partida hoje

  // ── Tenta pré-preencher o tempo a partir da partida do dia no scout ──
  const minJogo = await buscarMinutosJogo(athleteId, date, clubId);
  if (minJogo !== null) {
    tipoSessao = "jogo";
    document.getElementById("tempo").value = minJogo;
    const hint = document.getElementById("tempoHint");
    if (hint) {
      hint.textContent = `Preenchido automaticamente — ${minJogo} min jogados no jogo de hoje`;
      hint.style.display = "block";
    }
  }

  /* ================================
     LEGENDAS
  ================================ */

  const pseLegendaMap = {
    1: "Muito leve", 2: "Leve", 3: "Moderado", 4: "Moderado",
    5: "Um pouco intenso", 6: "Intenso", 7: "Muito intenso",
    8: "Muito intenso", 9: "Submáximo", 10: "Máximo"
  };
  const densLegendaMap = {
    1: "Poucos estímulos intensos", 2: "Baixa concentração",
    3: "Concentração moderada",     4: "Alta concentração",
    5: "Muito alta concentração"
  };
  const qualLegendaMap = {
    1: "Muito ruim", 2: "Ruim", 3: "Regular", 4: "Boa", 5: "Excelente"
  };

  /* ================================
     BOTÕES DE ESCALA
  ================================ */

  document.querySelectorAll("[data-pse]").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-pse]").forEach(b => b.classList.remove("selected"));
      btn.classList.add("selected");
      pse = Number(btn.dataset.pse);
      document.getElementById("pseLegenda").innerText = pseLegendaMap[pse] || "";
    });
  });

  document.querySelectorAll("[data-dens]").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-dens]").forEach(b => b.classList.remove("selected"));
      btn.classList.add("selected");
      densidade = Number(btn.dataset.dens);
      document.getElementById("densLegenda").innerText = densLegendaMap[densidade] || "";
    });
  });

  document.querySelectorAll("[data-qual]").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-qual]").forEach(b => b.classList.remove("selected"));
      btn.classList.add("selected");
      qualidade = Number(btn.dataset.qual);
      document.getElementById("qualLegenda").innerText = qualLegendaMap[qualidade] || "";
    });
  });

  /* ================================
     HELPER — LABEL DE PERÍODO
     Detecta período automaticamente
     pelo horário do device.
       < 12h  → Manhã
       12–17h → Tarde
       ≥ 18h  → Noite
  ================================ */

  function labelPeriodo() {
    const h = new Date().getHours();
    if (h < 12) return "Manhã";
    if (h < 18) return "Tarde";
    return "Noite";
  }

  /* ================================
     HELPER — RECALCULAR AGREGADOS
     Sempre chamado antes de salvar.
     Garante que post.carga, post.tempo,
     post.pse, post.densidade e
     post.qualidade reflitam todas as
     sessões do dia.
  ================================ */

  function recalcularAgregados(sessoes) {
    const totalTempo = sessoes.reduce((s, x) => s + x.tempo, 0);
    const totalCarga = sessoes.reduce((s, x) => s + x.carga, 0);

    // PSE ponderado pelo tempo (sessão mais longa pesa mais)
    const psePonderado = totalTempo > 0
      ? sessoes.reduce((s, x) => s + x.pse * x.tempo, 0) / totalTempo
      : sessoes.reduce((s, x) => s + x.pse, 0) / sessoes.length;

    // Densidade e qualidade: média simples entre sessões
    const densMedia = sessoes.reduce((s, x) => s + x.densidade, 0) / sessoes.length;
    const qualMedia = sessoes.reduce((s, x) => s + x.qualidade, 0) / sessoes.length;

    return {
      sessoes,                          // array completo para histórico granular
      carga:     Math.round(totalCarga),// soma — campo que prontidao.js usa para ACWR/ISP
      tempo:     totalTempo,            // soma
      pse:       +psePonderado.toFixed(1),
      densidade: +densMedia.toFixed(1),
      qualidade: +qualMedia.toFixed(1),
      tipo:      tipoSessao
    };
  }

  /* ================================
     HELPER — BUSCAR MINUTOS DO JOGO
     Consulta scout_partidas para ver se
     há uma partida salva hoje para este
     clube. Retorna os minutos jogados
     pelo atleta, ou null se não houver.
  ================================ */

  async function buscarMinutosJogo(athleteId, date, clubId) {
    try {
      if (!clubId) return null;
      const snap = await getDocs(query(
        collection(db, "scout_partidas"),
        where("clubId", "==", clubId),
        where("data",   "==", date),
        limit(1)
      ));
      if (snap.empty) return null;
      const partida = snap.docs[0].data();
      const ps = partida.playedSeconds?.[athleteId];
      if (!ps) return null;
      const seconds = typeof ps === "object" ? (ps.seconds ?? 0) : (typeof ps === "number" ? ps : 0);
      return seconds > 0 ? Math.round(seconds / 60) : null;
    } catch (e) {
      console.warn("[coleta_pos] Erro ao buscar minutos do jogo:", e);
      return null;
    }
  }

  /* ================================
     HELPER — BUSCAR POST EXISTENTE
     Consulta Firestore pelo documento
     do atleta no dia atual.
     Retorna o bloco post já mesclado,
     ou null se for a primeira sessão.
  ================================ */

  async function buscarPostExistente() {
    try {
      const ctx = JSON.parse(localStorage.getItem("userContext") || "{}");
      const cid = clubId || ctx.clubId || null;
      if (!cid) return null;

      const snap = await getDocs(query(
        collection(db, "daily_metrics"),
        where("athleteId", "==", athleteId),
        where("clubId",    "==", cid),
        where("date",      "==", date)
      ));

      // Mescla todos os documentos do dia (mesma lógica do prontidao.js)
      let merged = null;
      snap.forEach(d => {
        const data = d.data();
        if (!data.post) return;
        if (!merged) { merged = { ...data.post }; return; }
        Object.keys(data.post).forEach(k => {
          if (merged[k] == null && data.post[k] != null) merged[k] = data.post[k];
        });
      });

      return merged; // null = nenhum post salvo hoje ainda
    } catch (e) {
      console.warn("[coleta_pos] Erro ao buscar post existente:", e);
      return null; // em caso de erro, trata como primeira sessão
    }
  }

  /* ================================
     SUBMIT — LÓGICA PRINCIPAL
  ================================ */

  let salvando = false; // trava contra duplo clique rápido (< 1s)

  document.getElementById("formPos").addEventListener("submit", async (e) => {
    e.preventDefault();

    if (salvando) return;
    salvando = true;

    const btnSalvar = e.target.querySelector("[type=submit]");
    const textoOriginal = btnSalvar.textContent;
    btnSalvar.disabled = true;
    btnSalvar.textContent = "Gravando dados…";

    try {
      const tempo = Number(document.getElementById("tempo").value);

      if (!pse || !tempo || !densidade || !qualidade) {
        alert("Preencha todos os campos.");
        salvando = false;
        btnSalvar.disabled = false;
        btnSalvar.textContent = textoOriginal;
        return;
      }

      const novaSessao = {
        label:     labelPeriodo(),
        pse,
        tempo,
        densidade,
        qualidade,
        carga: pse * tempo
      };

      // ── Verifica o que já existe no Firestore para este atleta hoje ──
      const postExistente = await buscarPostExistente();

      let dadosFinais;

      if (!postExistente) {
        // ─────────────────────────────────────────────────
        // CASO 1 — Primeira sessão do dia
        // Salva diretamente, sem verificação de duplicata.
        // ─────────────────────────────────────────────────
        dadosFinais = recalcularAgregados([novaSessao]);

      } else {
        // ─────────────────────────────────────────────────
        // Normaliza sessões existentes para array.
        // Suporte retroativo a documentos antigos que não
        // têm post.sessoes (estrutura plana pse/tempo/carga).
        // ─────────────────────────────────────────────────
        const sessoesExistentes = Array.isArray(postExistente.sessoes)
          ? postExistente.sessoes
          : [{
              label:     postExistente.label     || "Sessão 1",
              pse:       postExistente.pse,
              tempo:     postExistente.tempo,
              densidade: postExistente.densidade,
              qualidade: postExistente.qualidade,
              carga:     postExistente.carga
            }];

        // ─────────────────────────────────────────────────
        // CASO 2 — Duplicata detectada
        // Critério: PSE idêntico E tempo dentro de ±2min.
        // → Atleta clicou salvar mais de uma vez na mesma
        //   sessão. Ignora silenciosamente.
        // ─────────────────────────────────────────────────
        const isDuplicata = sessoesExistentes.some(s =>
          s.pse === novaSessao.pse &&
          Math.abs((s.tempo ?? 0) - novaSessao.tempo) <= TOLERANCIA_MIN
        );

        if (isDuplicata) {
          console.info("[coleta_pos] Duplicata detectada — ignorada.");
          // Navega normalmente sem salvar nada
          alert("Pós-treino salvo com sucesso.");
          window.location.href = "selecionar_atleta.html";
          return;
        }

        // ─────────────────────────────────────────────────
        // CASO 3 — Nova sessão legítima (tarde, noite…)
        // Valores diferentes → adiciona ao array e
        // recalcula todos os agregados.
        // ─────────────────────────────────────────────────

        // Garante label único: se "Tarde" já existe → "Tarde 2"
        const labelsUsados = sessoesExistentes.map(s => s.label);
        let label = novaSessao.label;
        if (labelsUsados.includes(label)) {
          let n = 2;
          while (labelsUsados.includes(`${label} ${n}`)) n++;
          label = `${label} ${n}`;
        }
        novaSessao.label = label;

        dadosFinais = recalcularAgregados([...sessoesExistentes, novaSessao]);
      }

      // ── Persiste ──
      const pesoPosVal    = document.getElementById("pesoPosTreino").value;
      const pesoPosTreino = pesoPosVal ? Number(pesoPosVal) : null;

      await upsertDailyMetrics({
        athleteId,
        date,
        block: "post",
        data:  { ...dadosFinais, pesoPosTreino }
      });

      alert("Pós-treino salvo com sucesso.");
      window.location.href = "selecionar_atleta.html";

    } catch (err) {
      console.error("[coleta_pos] Erro ao salvar:", err);
      alert("Erro ao salvar. Tente novamente.");
    } finally {
      salvando = false;
      btnSalvar.disabled    = false;
      btnSalvar.textContent = textoOriginal;
    }
  });
}