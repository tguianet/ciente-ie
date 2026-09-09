import {
  collection,
  addDoc,
  updateDoc,
  getDocs,
  serverTimestamp,
  doc,
  getDoc,
  query,
  where,
  orderBy
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";

import { db, auth } from "/core/firebase.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js";

/* ============================
   ENUMS (FECHADOS)
============================ */

const POSICOES = [
  "Goleiro", "Lateral", "Zagueiro", "Volante",
  "Meia", "Ponta", "Centro-Avante"
];

const CATEGORIAS = ["Sub-20", "Profissional"];

/* ============================
   DOM — CADASTRO
============================ */

const form      = document.getElementById("formAtleta");
const msg       = document.getElementById("mensagem");
const btnLimpar = document.getElementById("btnLimpar");
const btnSalvar = document.getElementById("btnSalvar");

/* ============================
   DOM — GERENCIAR
============================ */

const filtroBusca     = document.getElementById("filtroBusca");
const filtroCategoria = document.getElementById("filtroCategoria");
const filtroStatus    = document.getElementById("filtroStatus");
const listaAtletas    = document.getElementById("listaAtletas");
const msgGerenciar    = document.getElementById("mensagemGerenciar");

/* ============================
   ESTADO
============================ */

let authReady       = false;
let currentUserData = null;
let atletasCache    = [];   // todos os atletas do clube em memória

/* ============================
   FOTO — compressão + base64
============================ */

function comprimirFoto(file, tamanho = 120, qualidade = 0.75) {
  return new Promise((resolve, reject) => {
    if (file.size > 5 * 1024 * 1024) { reject(new Error("Arquivo maior que 5 MB.")); return; }
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width  = tamanho;
        canvas.height = tamanho;
        const ctx = canvas.getContext('2d');
        // Crop centralizado
        const lado = Math.min(img.width, img.height);
        const ox   = (img.width  - lado) / 2;
        const oy   = (img.height - lado) / 2;
        ctx.drawImage(img, ox, oy, lado, lado, 0, 0, tamanho, tamanho);
        resolve(canvas.toDataURL('image/jpeg', qualidade));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function uploadFotoAtleta(athleteId, file) {
  if (!file) return null;
  return comprimirFoto(file);
}

/* ============================
   AUTH
============================ */

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    authReady = false;
    btnSalvar.disabled = true;
    btnSalvar.classList.add("opacity-50", "cursor-not-allowed");
    return;
  }

  try {
    const snap = await getDoc(doc(db, "users", user.uid));

    if (!snap.exists()) {
      setMsg("Usuário sem configuração de clube.", true);
      return;
    }

    currentUserData = snap.data();

    if (!currentUserData.clubId) {
      setMsg("Usuário sem clubId definido.", true);
      return;
    }

    authReady = true;
    btnSalvar.disabled = false;
    btnSalvar.classList.remove("opacity-50", "cursor-not-allowed");

    await carregarAtletas();

  } catch (err) {
    console.error(err);
    setMsg("Erro ao carregar dados do usuário.", true);
  }
});

/* ============================
   HELPERS — MENSAGENS
============================ */

function setMsg(texto, erro = false) {
  msg.textContent = texto;
  msg.className = "text-center font-medium " + (erro ? "text-red-600" : "text-green-600");
}

function setMsgGerenciar(texto, erro = false) {
  msgGerenciar.textContent = texto;
  msgGerenciar.className = "text-center font-medium text-sm " + (erro ? "text-red-600" : "text-green-600");
  if (texto) setTimeout(() => { msgGerenciar.textContent = ""; }, 4000);
}

/* ============================
   CARREGAR ATLETAS
============================ */

async function carregarAtletas() {
  try {
    const q = query(
      collection(db, "athletes"),
      where("clubId", "==", currentUserData.clubId),
      orderBy("nome")
    );

    const snap = await getDocs(q);

    atletasCache = snap.docs.map(d => ({
      id:   d.id,
      ...d.data(),
      // compatibilidade: documentos sem campo "ativo" são tratados como ativos
      ativo: d.data().ativo !== false
    }));

    renderizarLista();

  } catch (err) {
    console.error(err);
    listaAtletas.innerHTML = `<p class="text-red-500 text-sm text-center py-4">Erro ao carregar atletas.</p>`;
  }
}

/* ============================
   RENDERIZAR LISTA
============================ */

function renderizarLista() {
  const busca     = filtroBusca.value.trim().toLowerCase();
  const categoria = filtroCategoria.value;
  const status    = filtroStatus.value;   // "ativos" | "inativos" | "todos"

  const filtrados = atletasCache.filter(a => {
    const nomeOk      = !busca || a.nome.toLowerCase().includes(busca);
    const catOk       = !categoria || a.categoria === categoria;
    const statusOk    = status === "todos"
                          ? true
                          : status === "ativos"
                            ? a.ativo === true
                            : a.ativo === false;
    return nomeOk && catOk && statusOk;
  });

  if (!filtrados.length) {
    listaAtletas.innerHTML = `<p class="text-gray-400 text-sm text-center py-4">Nenhum atleta encontrado.</p>`;
    return;
  }

  listaAtletas.innerHTML = filtrados.map(a => `
    <div class="rounded-lg border ${a.ativo ? "bg-white" : "bg-gray-50 opacity-60"}">

      <div class="flex items-center justify-between p-3">
        <!-- Foto miniatura -->
        <div class="shrink-0 mr-3">
          ${a.fotoUrl
            ? `<img src="${a.fotoUrl}" alt="${a.nome}" class="w-9 h-9 rounded-full object-cover border"/>`
            : `<div class="w-9 h-9 rounded-full bg-gray-200 flex items-center justify-center text-gray-500 text-sm font-bold border">${a.nome.charAt(0).toUpperCase()}</div>`
          }
        </div>

        <div class="flex-1 min-w-0">
          <p class="font-medium truncate">${a.nome}</p>
          <p class="text-xs text-gray-500">${a.posicao} · ${a.categoria}</p>
        </div>

        <div class="flex items-center gap-2 ml-3 shrink-0">
          <span class="text-xs px-2 py-0.5 rounded-full font-medium
                       ${a.ativo ? "bg-green-100 text-green-700" : "bg-gray-200 text-gray-500"}">
            ${a.ativo ? "Ativo" : "Inativo"}
          </span>

          <button
            data-id="${a.id}"
            class="btn-editar text-xs px-3 py-1.5 rounded-lg font-medium transition-colors
                   bg-amber-50 text-amber-700 hover:bg-amber-100 border border-amber-200">
            ✏️ Editar
          </button>

          <button
            data-id="${a.id}"
            class="btn-foto text-xs px-3 py-1.5 rounded-lg font-medium transition-colors
                   bg-gray-50 text-gray-600 hover:bg-gray-100 border">
            📷 Foto
          </button>

          <button
            data-id="${a.id}"
            data-ativo="${a.ativo}"
            class="btn-toggle text-xs px-3 py-1.5 rounded-lg font-medium transition-colors
                   ${a.ativo ? "bg-red-50 text-red-600 hover:bg-red-100" : "bg-blue-50 text-blue-600 hover:bg-blue-100"}">
            ${a.ativo ? "Desativar" : "Reativar"}
          </button>
        </div>
      </div>

      <!-- Painel de edição (oculto por padrão) -->
      <div id="painelEditar_${a.id}" class="hidden border-t px-4 py-4 bg-amber-50 rounded-b-lg">
        <p class="text-xs font-semibold text-amber-800 mb-3">Editar dados do atleta</p>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
          <div>
            <label class="block text-xs font-medium text-gray-600 mb-1">Nome completo</label>
            <input id="editNome_${a.id}" type="text" value="${a.nome.replace(/"/g, '&quot;')}"
                   class="w-full p-2 border rounded-lg text-sm"/>
          </div>
          <div>
            <label class="block text-xs font-medium text-gray-600 mb-1">Data de nascimento</label>
            <input id="editNasc_${a.id}" type="date" value="${a.dataNascimento || a.data_nascimento || ''}"
                   class="w-full p-2 border rounded-lg text-sm"/>
          </div>
          <div>
            <label class="block text-xs font-medium text-gray-600 mb-1">Posição</label>
            <select id="editPosicao_${a.id}" class="w-full p-2 border rounded-lg text-sm">
              ${POSICOES.map(p => `<option${p === a.posicao ? ' selected' : ''}>${p}</option>`).join('')}
            </select>
          </div>
          <div>
            <label class="block text-xs font-medium text-gray-600 mb-1">Categoria</label>
            <select id="editCategoria_${a.id}" class="w-full p-2 border rounded-lg text-sm">
              ${CATEGORIAS.map(c => `<option${c === a.categoria ? ' selected' : ''}>${c}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="flex items-center gap-2">
          <button data-id="${a.id}"
                  class="btn-salvar-edicao text-xs px-4 py-1.5 rounded-lg font-medium
                         bg-amber-600 text-white hover:bg-amber-700 transition-colors">
            Salvar alterações
          </button>
          <button data-id="${a.id}"
                  class="btn-cancelar-edicao text-xs px-4 py-1.5 rounded-lg font-medium
                         bg-white text-gray-600 hover:bg-gray-100 border transition-colors">
            Cancelar
          </button>
          <p id="msgEditar_${a.id}" class="text-xs text-gray-500 ml-2"></p>
        </div>
      </div>

      <!-- Painel de upload de foto (oculto por padrão) -->
      <div id="painelFoto_${a.id}" class="hidden border-t px-4 py-3 bg-gray-50 rounded-b-lg">
        <p class="text-xs font-semibold text-gray-600 mb-2">Alterar foto · JPG / PNG · máx. 5 MB</p>
        <div class="flex items-center gap-3">
          <input type="file" accept="image/*"
                 id="inputFoto_${a.id}"
                 class="flex-1 text-sm file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0
                        file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"/>
          <button data-id="${a.id}"
                  class="btn-salvar-foto text-xs px-4 py-1.5 rounded-lg font-medium
                         bg-blue-600 text-white hover:bg-blue-700 transition-colors">
            Salvar
          </button>
        </div>
        <p id="msgFoto_${a.id}" class="text-xs mt-1 text-gray-500"></p>
      </div>

    </div>
  `).join("");

  // Botão toggle/desativar
  listaAtletas.querySelectorAll(".btn-toggle").forEach(btn => {
    btn.addEventListener("click", () => toggleAtleta(btn.dataset.id, btn.dataset.ativo === "true"));
  });

  // Botão abrir/fechar painel de edição
  listaAtletas.querySelectorAll(".btn-editar").forEach(btn => {
    btn.addEventListener("click", () => {
      const painel = document.getElementById(`painelEditar_${btn.dataset.id}`);
      if (painel) painel.classList.toggle("hidden");
    });
  });

  // Botão cancelar edição
  listaAtletas.querySelectorAll(".btn-cancelar-edicao").forEach(btn => {
    btn.addEventListener("click", () => {
      document.getElementById(`painelEditar_${btn.dataset.id}`)?.classList.add("hidden");
    });
  });

  // Botão salvar edição
  listaAtletas.querySelectorAll(".btn-salvar-edicao").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id     = btn.dataset.id;
      const msgEl  = document.getElementById(`msgEditar_${id}`);
      const nome   = document.getElementById(`editNome_${id}`)?.value.trim();
      const nasc   = document.getElementById(`editNasc_${id}`)?.value;
      const posicao    = document.getElementById(`editPosicao_${id}`)?.value;
      const categoria  = document.getElementById(`editCategoria_${id}`)?.value;

      if (!nome || !posicao || !categoria) {
        msgEl.textContent = "Preencha todos os campos.";
        msgEl.className = "text-xs text-red-600 ml-2";
        return;
      }

      btn.disabled = true;
      btn.textContent = "Salvando…";
      msgEl.textContent = "";

      try {
        const dadosAtualizar = { nome, posicao, categoria };
        if (nasc) dadosAtualizar.dataNascimento = nasc;

        await updateDoc(doc(db, "athletes", id), dadosAtualizar);

        // atualizar cache local
        const idx = atletasCache.findIndex(a => a.id === id);
        if (idx !== -1) Object.assign(atletasCache[idx], dadosAtualizar);

        setMsgGerenciar("Atleta atualizado com sucesso.");
        renderizarLista();

      } catch (err) {
        console.error(err);
        msgEl.textContent = "Erro ao salvar.";
        msgEl.className = "text-xs text-red-600 ml-2";
        btn.disabled = false;
        btn.textContent = "Salvar alterações";
      }
    });
  });

  // Botão abrir painel de foto
  listaAtletas.querySelectorAll(".btn-foto").forEach(btn => {
    btn.addEventListener("click", () => {
      const painel = document.getElementById(`painelFoto_${btn.dataset.id}`);
      if (painel) painel.classList.toggle("hidden");
    });
  });

  // Botão salvar foto
  listaAtletas.querySelectorAll(".btn-salvar-foto").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id    = btn.dataset.id;
      const input = document.getElementById(`inputFoto_${id}`);
      const msgEl = document.getElementById(`msgFoto_${id}`);
      const file  = input?.files[0];

      if (!file) { msgEl.textContent = "Selecione uma imagem."; return; }

      btn.disabled = true;
      btn.textContent = "Enviando…";
      msgEl.textContent = "";

      try {
        const fotoUrl = await uploadFotoAtleta(id, file);
        await updateDoc(doc(db, "athletes", id), { fotoUrl });

        // atualizar cache local
        const idx = atletasCache.findIndex(a => a.id === id);
        if (idx !== -1) atletasCache[idx].fotoUrl = fotoUrl;

        msgEl.textContent = "Foto salva!";
        msgEl.className = "text-xs mt-1 text-green-600 font-medium";

        // fechar painel após 1.5s
        setTimeout(() => {
          document.getElementById(`painelFoto_${id}`)?.classList.add("hidden");
          renderizarLista();
        }, 1500);

      } catch (err) {
        console.error(err);
        msgEl.textContent = err.message || "Erro ao enviar foto.";
        msgEl.className = "text-xs mt-1 text-red-600";
      } finally {
        btn.disabled = false;
        btn.textContent = "Salvar";
      }
    });
  });
}

/* ============================
   ATIVAR / DESATIVAR
============================ */

async function toggleAtleta(atletaId, ativoAtual) {
  const novoStatus = !ativoAtual;
  const label      = novoStatus ? "reativado" : "desativado";

  try {
    await updateDoc(doc(db, "athletes", atletaId), { ativo: novoStatus });

    // atualizar cache local sem rebuscar no Firestore
    const idx = atletasCache.findIndex(a => a.id === atletaId);
    if (idx !== -1) atletasCache[idx].ativo = novoStatus;

    renderizarLista();
    setMsgGerenciar(`Atleta ${label} com sucesso.`);

  } catch (err) {
    console.error(err);
    setMsgGerenciar("Erro ao atualizar atleta.", true);
  }
}

/* ============================
   EVENTOS — FILTROS
============================ */

filtroBusca.addEventListener("input", renderizarLista);
filtroCategoria.addEventListener("change", renderizarLista);
filtroStatus.addEventListener("change", renderizarLista);

/* ============================
   EVENTOS — CADASTRO
============================ */

btnLimpar.addEventListener("click", () => {
  form.reset();
  msg.textContent = "";
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();

  if (!authReady || !currentUserData) {
    setMsg("Aguardando autenticação…", true);
    return;
  }

  const nome           = document.getElementById("nome").value.trim();
  const dataNascimento = document.getElementById("dataNascimento").value;
  const posicao        = document.getElementById("posicao").value;
  const categoria      = document.getElementById("categoria").value;

  if (!nome || !dataNascimento || !posicao || !categoria) {
    setMsg("Preencha todos os campos obrigatórios.", true);
    return;
  }

  if (!POSICOES.includes(posicao) || !CATEGORIAS.includes(categoria)) {
    setMsg("Posição ou categoria inválida.", true);
    return;
  }

  try {
    btnSalvar.disabled = true;
    btnSalvar.textContent = "Salvando…";

    const novoDoc = await addDoc(collection(db, "athletes"), {
      nome,
      dataNascimento,
      posicao,
      categoria,
      fotoUrl:   "",
      ativo:     true,
      clubId:    currentUserData.clubId,
      teamId:    currentUserData.teamId || null,
      createdAt: serverTimestamp()
    });

    // Upload de foto, se selecionada
    const fotoFile = document.getElementById("foto").files[0];
    if (fotoFile) {
      try {
        btnSalvar.textContent = "Enviando foto…";
        const fotoUrl = await uploadFotoAtleta(novoDoc.id, fotoFile);
        await updateDoc(doc(db, "athletes", novoDoc.id), { fotoUrl });
      } catch (fotoErr) {
        console.warn("Foto não enviada:", fotoErr);
        setMsg("Atleta salvo, mas houve erro no upload da foto.", true);
      }
    }

    // adicionar ao cache local e re-renderizar
    atletasCache.push({ id: novoDoc.id, nome, dataNascimento, posicao, categoria, ativo: true });
    atletasCache.sort((a, b) => a.nome.localeCompare(b.nome));
    renderizarLista();

    setMsg("Atleta cadastrado com sucesso!");
    form.reset();

  } catch (err) {
    console.error(err);
    setMsg("Erro ao salvar atleta.", true);

  } finally {
    btnSalvar.disabled = false;
    btnSalvar.textContent = "Salvar atleta";
  }
});