import { upsertDailyMetrics } from "./core/dailyMetrics.service.js";

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

const athleteId = String(ctx.athleteId);

// ✅ clubId NUNCA pode ser undefined
const clubId = String(ctx.clubId || "ciente");

/* ===============================
   DATA LOCAL (YYYY-MM-DD)
================================ */
const hoje = new Date();
const yyyy = hoje.getFullYear();
const mm = String(hoje.getMonth() + 1).padStart(2, "0");
const dd = String(hoje.getDate()).padStart(2, "0");
const dataHoje = `${yyyy}-${mm}-${dd}`;

document.getElementById("prontidao-data").value = dataHoje;

/* ===============================
   INFO ATLETA
================================ */
document.getElementById("prontidao-atleta-info").innerHTML =
  `<strong>Atleta:</strong> ${ctx.nome || "—"}`;

/* ===============================
   SUBMIT PRÉ
================================ */
document.getElementById("formProntidao")
  .addEventListener("submit", async (e) => {
    e.preventDefault();

    const getVal = (n) =>
      Number(document.querySelector(`input[name="${n}"]:checked`)?.value);

    const sono = getVal("sono");
    const estresse = getVal("estresse");
    const fadiga = getVal("fadiga");
    const dor = getVal("dor");

    if (![sono, estresse, fadiga, dor].every(Boolean)) {
      alert("Preencha todas as escalas de prontidão.");
      return;
    }

    const salto = document.getElementById("salto").value || null;

    const hora = new Date().getHours();
    const periodo = hora < 12 ? "manha" : hora < 18 ? "tarde" : "noite";

    try {
      // (opcional) log pra você confirmar o contrato:
      console.log("upsertDailyMetrics args:", { athleteId, dataHoje, clubId });

      await upsertDailyMetrics({
  athleteId: athleteId,
  date: dataHoje,
  block: "pre",
  data: {
    sono,
    estresse,
    fadiga,
    dor,
    hooper: sono + estresse + fadiga + dor,
    salto: salto ? Number(salto) : null,
    periodo,
    origem: "manual"
  }
});


      alert("Prontidão salva com sucesso.");
      window.location.href = "selecionar_atleta.html";

    } catch (err) {
      console.error(err);
      alert("Erro ao salvar prontidão.");
    }
  });
