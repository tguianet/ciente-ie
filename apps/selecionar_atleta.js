import {
  collection, getDocs, query, orderBy, where, doc, getDoc
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";
import { db, auth } from "./core/firebase.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js";

let atletas = [];
let atletaAtivo = null;   // atleta selecionado para o modal

const cardsContainer = document.getElementById("cardsContainer");
const searchInput    = document.getElementById("searchInput");

/* ============================
   CONTEXTO
============================ */
function setAthleteContext(atleta) {
  localStorage.setItem("athleteContext", JSON.stringify({
    athleteId: atleta.id,
    nome:      atleta.nome,
    categoria: atleta.categoria,
    posicao:   atleta.posicao,
    clubId:    atleta.clubId,
    fotoUrl:   atleta.fotoUrl || null,
  }));
}

function getIniciais(nome = "") {
  const p = nome.trim().split(" ");
  if (p.length === 1) return p[0][0]?.toUpperCase() || "";
  return (p[0][0] + p[p.length - 1][0]).toUpperCase();
}

/* ============================
   RENDER FIGURINHAS
============================ */
function renderCards(lista) {
  cardsContainer.innerHTML = "";

  if (!lista.length) {
    cardsContainer.innerHTML = `<p style="color:#9ca3af;font-size:14px;padding:20px 0;">Nenhum atleta encontrado.</p>`;
    return;
  }

  lista.forEach(atleta => {
    const iniciais = getIniciais(atleta.nome);
    const primeiroNome = atleta.nome.trim().split(" ")[0];

    const card = document.createElement("div");
    card.style.cssText = `
      position:relative;width:calc(14.2857% - 7px);aspect-ratio:2/3;border-radius:8px;
      overflow:hidden;cursor:pointer;flex-shrink:0;
      box-shadow:0 2px 6px rgba(0,0,0,0.18);
    `;

    // Fundo: foto ou iniciais
    const fundo = atleta.fotoUrl
      ? `<img src="${atleta.fotoUrl}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;" loading="lazy">`
      : `<div style="position:absolute;inset:0;background:linear-gradient(135deg,#1e3a5f,#2d5080);display:flex;align-items:center;justify-content:center;font-size:28px;font-weight:800;color:#fff;">${iniciais}</div>`;

    card.innerHTML = `
      ${fundo}
      <!-- Degradê -->
      <div style="position:absolute;inset:0;background:linear-gradient(to bottom,transparent 40%,rgba(0,0,0,0.85) 100%);"></div>
      <!-- Nome -->
      <div style="position:absolute;bottom:0;left:0;right:0;padding:3px 3px 5px;">
        <p style="font-size:9px;font-weight:700;color:#fff;margin:0;text-align:center;line-height:1.2;text-shadow:0 1px 4px rgba(0,0,0,0.7);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${primeiroNome}</p>
      </div>
    `;

    card.onclick = () => abrirModal(atleta);
    cardsContainer.appendChild(card);
  });
}

/* ============================
   MODAL DE AÇÃO
============================ */
function abrirModal(atleta) {
  atletaAtivo = atleta;

  const fotoEl = document.getElementById("modalFoto");
  if (atleta.fotoUrl) {
    fotoEl.innerHTML = `<img src="${atleta.fotoUrl}" style="width:100%;height:100%;object-fit:cover;">`;
  } else {
    fotoEl.textContent = getIniciais(atleta.nome);
    fotoEl.style.background = '#1e3a5f';
  }

  document.getElementById("modalNome").textContent = atleta.nome;
  document.getElementById("modalSub").textContent  =
    [atleta.posicao, atleta.categoria].filter(Boolean).join(" · ");

  const modal = document.getElementById("actionModal");
  modal.classList.add("open");
  document.body.style.overflow = "hidden";
}

window.fecharModal = function() {
  document.getElementById("actionModal").classList.remove("open");
  document.body.style.overflow = "";
  atletaAtivo = null;
};

window._abrirPre = function() {
  if (!atletaAtivo) return;
  setAthleteContext(atletaAtivo);
  window.location.href = "/coleta_pre.html";
};

window._abrirPos = function() {
  if (!atletaAtivo) return;
  setAthleteContext(atletaAtivo);
  window.location.href = "/coleta_pos.html";
};

window._abrirNeuro = function() {
  if (!atletaAtivo) return;
  setAthleteContext(atletaAtivo);
  window.location.href = "/neuroscore.html";
};

/* ============================
   BUSCA
============================ */
searchInput.addEventListener("input", () => {
  const termo = searchInput.value.toLowerCase();
  renderCards(atletas.filter(a => a.nome.toLowerCase().includes(termo)));
});

/* ============================
   INIT
============================ */
onAuthStateChanged(auth, async (user) => {
  if (!user) { window.location.href = "/login.html"; return; }

  try {
    let clubId = null;
    try { clubId = JSON.parse(localStorage.getItem("userContext") || "{}").clubId ?? null; } catch {}

    if (!clubId) {
      const snap = await getDoc(doc(db, "users", user.uid));
      clubId = snap.exists() ? snap.data().clubId : null;
    }
    if (!clubId) return;

    const snap = await getDocs(query(
      collection(db, "athletes"),
      where("clubId", "==", clubId),
      where("ativo", "!=", false),
      orderBy("ativo"),
      orderBy("nome")
    ));

    atletas = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderCards(atletas);

  } catch (err) {
    console.error(err);
    cardsContainer.innerHTML = `<p style="color:#dc2626;">Erro ao carregar atletas.</p>`;
  }
});
