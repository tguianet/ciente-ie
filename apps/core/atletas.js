// atletas.js – Gestão de Atletas Ciente IE

import { 
    db, collection, addDoc, updateDoc, getDocs, getDoc, doc 
} from "./firebase.js";

const athletesRef = collection(db, "athletes");

// ELEMENTOS DA PÁGINA
const modal = document.getElementById("athleteModal");
const modalTitle = document.getElementById("modalTitle");
const addBtn = document.getElementById("addAthleteBtn");
const cancelBtn = document.getElementById("cancelBtn");
const form = document.getElementById("athleteForm");
const tableBody = document.getElementById("athletesTable");

// ABRIR MODAL
addBtn.addEventListener("click", () => {
    form.reset();
    document.getElementById("athleteId").value = "";
    modalTitle.textContent = "Novo Atleta";
    modal.classList.remove("hidden");
    modal.classList.add("flex");
});

// FECHAR MODAL
cancelBtn.addEventListener("click", () => {
    modal.classList.add("hidden");
    modal.classList.remove("flex");
});

// SALVAR
form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const id = document.getElementById("athleteId").value;

    const data = {
        nome: document.getElementById("nome").value,
        categoria: document.getElementById("categoria").value,
        posicao: document.getElementById("posicao").value,
        data_nascimento: document.getElementById("data_nascimento").value,
        ultimo_clube: document.getElementById("ultimo_clube").value,
        ativo: document.getElementById("ativo").checked,
        criado_em: new Date().toISOString()
    };

    if (id === "") {
        await addDoc(athletesRef, data);
    } else {
        await updateDoc(doc(db, "athletes", id), data);
    }

    modal.classList.add("hidden");
    modal.classList.remove("flex");
    loadAthletes();
});

// LISTAR ATLETAS
async function loadAthletes() {
    tableBody.innerHTML = "";
    const snap = await getDocs(athletesRef);

    const atletas = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Ativos primeiro (A-Z), depois inativos (A-Z)
    atletas.sort((a, b) => {
        if (a.ativo === b.ativo) return (a.nome || "").localeCompare(b.nome || "");
        return a.ativo ? -1 : 1;
    });

    atletas.forEach(({ id, ...a }) => {
        const inativo = !a.ativo;
        const rowStyle = inativo ? ' style="opacity:0.5;background:#f9fafb;"' : '';

        const row = `
        <tr${rowStyle}>
            <td class="border p-2">${a.nome}${inativo ? ' <span style="font-size:11px;color:#9ca3af;">(inativo)</span>' : ''}</td>
            <td class="border p-2">${a.categoria}</td>
            <td class="border p-2">${a.posicao}</td>
            <td class="border p-2">${a.data_nascimento || "-"}</td>
            <td class="border p-2">${a.ultimo_clube || "-"}</td>
            <td class="border p-2">${inativo ? "Inativo" : "Ativo"}</td>
            <td class="border p-2 text-center">
                <button onclick="editAthlete('${id}')" class="bg-yellow-500 text-white px-2 py-1 rounded">Editar</button>
                <button onclick="toggleAtivo('${id}', ${a.ativo})" class="${inativo ? 'bg-green-600' : 'bg-red-600'} text-white px-2 py-1 rounded">
                    ${inativo ? "Ativar" : "Desativar"}
                </button>
            </td>
        </tr>`;

        tableBody.insertAdjacentHTML("beforeend", row);
    });
}

// EDITAR
window.editAthlete = async function(id) {
    const snap = await getDoc(doc(db, "athletes", id));
    const a = snap.data();

    document.getElementById("athleteId").value = id;
    document.getElementById("nome").value = a.nome;
    document.getElementById("categoria").value = a.categoria;
    document.getElementById("posicao").value = a.posicao;
    document.getElementById("data_nascimento").value = a.data_nascimento || "";
    document.getElementById("ultimo_clube").value = a.ultimo_clube || "";
    document.getElementById("ativo").checked = a.ativo;

    modalTitle.textContent = "Editar Atleta";
    modal.classList.remove("hidden");
    modal.classList.add("flex");
};

// ATIVAR / DESATIVAR
window.toggleAtivo = async function(id, statusAtual) {
    await updateDoc(doc(db, "athletes", id), { ativo: !statusAtual });
    loadAthletes();
};

// INICIAR
loadAthletes();
