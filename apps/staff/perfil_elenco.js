import { db, auth } from "../core/firebase.js";
import {
  collection,
  getDocs,
  query,
  where,
  doc,
  getDoc
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js";

const conteudo = document.getElementById("conteudo");

let atletasSnap, avalSnap, medicoSnap, scoutSnap, planSnap;
let perfPeriodoFiltro = "Todos"; // persiste ao trocar filtro sem recarregar
const atletas = {};
let CLUB_ID = null;

// Cache de avaliações funcionais para o modal de treinos
// [{ athleteId, nome, setores, dataAval }]
let _dfFuncional = [];

/* =============================================================
   MOTOR DE PROTOCOLO FUNCIONAL — embutido (sem import externo)
============================================================= */
function _classQuadril(v) {
  if (v === null || v === undefined || isNaN(Number(v))) return null;
  const n = Number(v);
  if (n < 30) return "high";
  return "low";
}
function _classTornozelo(v) {
  if (v === null || v === undefined || isNaN(Number(v))) return null;
  const n = Number(v);
  if (n < 37)  return "high";
  if (n <= 42) return "moderate";
  return "low";
}
function _classPosterior(v) {
  if (v === null || v === undefined || isNaN(Number(v))) return null;
  const n = Number(v);
  if (n < 130)  return "high";
  if (n <= 150) return "moderate";
  return "low";
}
function _classIliopsoas(label) {
  if (!label || label === "") return null;
  const l = label.toLowerCase();
  if (l === "alta")     return "high";
  if (l === "moderada") return "moderate";
  return "low";
}
function _piorLado(a, b) {
  const ord = { high: 2, moderate: 1, low: 0 };
  return (ord[a] ?? -1) >= (ord[b] ?? -1) ? a : b;
}

const _MAPA_SISTEMA = {
  quadril:        ["A", "C", "E", "I"],
  tornozelo:      ["F", "H"],
  posterior:      ["D", "H"],
  iliopsoas:      ["E", "I"],
  controle_motor: ["G"],
};

const _CATALOGO = {
  A: { name: "Mobilização de quadril em 4 apoios (CARs)",
       pretreino:    "3×8 (cada lado)",
       reabilitacao: "3×15 (cada lado)",
       rationale: "Restaura amplitude ativa · reduz rigidez articular" },
  C: { name: "Hip 90/90 stretch com progressão lateral",
       pretreino:    "3×8 (cada lado)",
       reabilitacao: "3×20 (cada lado)",
       rationale: "Mobilidade rotacional do quadril · adutores e rotadores" },
  E: { name: "Lunges com inclinação de tronco (hip flexor dinâmico)",
       pretreino:    "3×10 (cada lado)",
       reabilitacao: "3×20 (cada lado)",
       rationale: "Alonga iliopsoas · mobiliza quadril em extensão" },
  I: { name: "Dead bug com foco em controle pélvico",
       pretreino:    "3×8 (alternado)",
       reabilitacao: "3×15 (alternado)",
       rationale: "Controle lombopélvico · reduz dominância do iliopsoas" },
  D: { name: "RDL unilateral excêntrico",
       pretreino:    "3×8 (cada lado)",
       reabilitacao: "3×15 (cada lado)",
       rationale: "Isquiotibiais e glúteo excêntrico · risco posterior" },
  F: { name: "Mobilização de tornozelo em meia-ajoelhado (knee-to-wall)",
       pretreino:    "3×10 (cada lado)",
       reabilitacao: "3×20 (cada lado)",
       rationale: "Aumenta dorsiflexão ativa · mobilidade talocrural" },
  H: { name: "Elevação de calcanhar excêntrico (eccentric heel drop)",
       pretreino:    "3×10",
       reabilitacao: "3×20",
       rationale: "Fortalece complexo sural · reduz rigidez distal" },
  G: { name: "Prancha lateral com abdução de quadril (Clam Shell)",
       pretreino:    "3×8 (cada lado)",
       reabilitacao: "3×15 (cada lado)",
       rationale: "Ativação de glúteo médio · controle plano frontal" },
};

function gerarProtocolo(setores = {}) {
  const mob  = setores.mobilidade    || {};
  const flex = setores.flexibilidade || {};

  const risks = {
    quadril:   _piorLado(_classQuadril(mob.quadril_dir),      _classQuadril(mob.quadril_esq)),
    tornozelo: _piorLado(_classTornozelo(mob.tornozelo_dir),  _classTornozelo(mob.tornozelo_esq)),
    posterior: _piorLado(_classPosterior(mob.posteriores_dir),_classPosterior(mob.posteriores_esq)),
    iliopsoas: _piorLado(_classIliopsoas(flex.ilio_dir),      _classIliopsoas(flex.ilio_esq)),
  };

  const sistemasAtivos = Object.entries(risks)
    .filter(([, r]) => r === "high" || r === "moderate")
    .sort(([, a], [, b]) => ({ high:0, moderate:1 }[a]??9) - ({ high:0, moderate:1 }[b]??9))
    .map(([s]) => s);

  const prioritySystems = sistemasAtivos.filter(s => risks[s] === "high");
  const soUmHigh = prioritySystems.length === 1 && sistemasAtivos.length === 1;

  const selecionados = [];
  const vistos = new Set();

  for (const sistema of sistemasAtivos) {
    const risco = risks[sistema];
    let qtde = risco === "high" ? (soUmHigh ? 3 : 2) : 1;
    const novos = (_MAPA_SISTEMA[sistema] || [])
      .filter(c => !vistos.has(c))
      .slice(0, qtde);
    novos.forEach(c => { selecionados.push({ code: c, fromSistema: sistema, risk: risco }); vistos.add(c); });
  }

  if (!vistos.has("G")) selecionados.push({ code:"G", fromSistema:"controle_motor", risk:"low" });

  const COMPLEMENTO = ["G","F","D"];
  if (selecionados.length < 3) {
    for (const c of COMPLEMENTO) {
      if (selecionados.length >= 3) break;
      if (!vistos.has(c)) { selecionados.push({ code:c, fromSistema:"complemento", risk:"low" }); vistos.add(c); }
    }
  }

  const final = selecionados.slice(0, 5);
  const exercises = final.map(({ code, fromSistema, risk }) => {
    const ex = _CATALOGO[code];
    const dk = risk === "high" ? "high" : risk === "moderate" ? "moderate" : "low";
    return { code, name: ex.name, pretreino: ex.pretreino, reabilitacao: ex.reabilitacao, rationale: ex.rationale, fromSistema, risk };
  });

  return { prioritySystems, sistemasAtivos, risks, exercises,
    meta: { totalExercicios: exercises.length, geradoEm: new Date().toISOString() } };
}

// Data de referência para cálculo de dias corridos no relatório médico
// null = usa hoje (comportamento padrão na visualização da aba)
let _dataRefMedico = null;

/* =========================
   BUSCAR DADOS
========================= */

async function carregarDados(){

  atletasSnap = null;
  avalSnap = null;
  medicoSnap = null;
  scoutSnap = null;
  planSnap = null;

  const results = await Promise.allSettled([
    getDocs(query(collection(db,"athletes"), where("clubId","==",CLUB_ID), where("ativo","!=",false))),
    getDocs(query(collection(db,"assessments_functional"), where("clubId","==",CLUB_ID))),
    getDocs(query(collection(db,"assessments_medical"), where("clubId","==",CLUB_ID))),
    getDocs(query(collection(db,"scout_partidas"), where("clubId","==",CLUB_ID))),
    getDocs(query(collection(db,"assessments_planning"), where("clubId","==",CLUB_ID)))
  ]);

  // ATHLETES
  if(results[0].status === "fulfilled"){
    atletasSnap = results[0].value;

    atletasSnap.forEach(doc=>{
      const d = doc.data() || {};
      atletas[doc.id] = (d.nome ?? d.name ?? d.atleta ?? "-")
        .toString()
        .trim() || "-";
    });

  } else {
    console.error("Erro ao buscar athletes:", results[0].reason);
  }

  // AVALIAÇÕES
  if(results[1].status === "fulfilled"){
    avalSnap = results[1].value;
  } else {
    console.error("Erro assessments_functional:", results[1].reason);
    avalSnap = { forEach: () => {} };
  }

  // MÉDICO
  if(results[2].status === "fulfilled"){
    medicoSnap = results[2].value;
  } else {
    console.error("Erro assessments_medical:", results[2].reason);
    medicoSnap = { forEach: () => {} };
  }

  // SCOUT
  if(results[3].status === "fulfilled"){
    scoutSnap = results[3].value;
  } else {
    console.error("Erro scout_partidas:", results[3].reason);
    scoutSnap = { forEach: () => {} };
  }

  // PLANEJAMENTO
  if(results[4].status === "fulfilled"){
    planSnap = results[4].value;
  } else {
    console.error("Erro assessments_planning:", results[4].reason);
    planSnap = { forEach: () => {} };
  }
}

onAuthStateChanged(auth, async (user) => {
  if(!user){
    conteudo.innerHTML = "<p style='padding:1rem;color:red'>Usuário não autenticado.</p>";
    return;
  }

  try {
    const userSnap = await getDoc(doc(db, "users", user.uid));
    CLUB_ID = userSnap.exists() ? userSnap.data().clubId : null;
    if (!CLUB_ID) {
      conteudo.innerHTML = "<p style='padding:1rem;color:red'>Usuário sem clubId configurado.</p>";
      return;
    }
  } catch(e) { console.error(e); return; }

  await carregarDados();
  renderFigurinhas();
});

/* =============================================================
   GRID DE FIGURINHAS — Elenco
============================================================= */
function renderFigurinhas() {
  const grid = document.getElementById('gridAtletas');
  if (!grid || !atletasSnap) return;

  // Status médico mais recente por atleta
  const statusMedMap = {};
  if (medicoSnap) {
    medicoSnap.forEach(d => {
      const data = d.data();
      if (data.tipo === 'lesao' && data.athleteId) {
        const cur = statusMedMap[data.athleteId];
        const date = data.date || '';
        if (!cur || date > cur.date)
          statusMedMap[data.athleteId] = { status: data.dados?.status || 'liberado', date };
      }
    });
  }

  const pillCfg = {
    afastado:  { bg: 'rgba(254,226,226,0.92)', text: '#b91c1c', dot: '#ef4444', label: 'Afastado',   brd: '#fca5a5' },
    transicao: { bg: 'rgba(255,237,213,0.92)', text: '#c2410c', dot: '#f97316', label: 'Transição',  brd: '#fdba74' },
    liberado:  { bg: 'rgba(220,252,231,0.92)', text: '#15803d', dot: '#22c55e', label: 'Disponível', brd: '#86efac' },
  };
  const bgSolid = { afastado: '#fee2e2', transicao: '#ffedd5', liberado: '#dcfce7' };
  const textSolid = { afastado: '#b91c1c', transicao: '#c2410c', liberado: '#15803d' };
  const ordemStatus = { afastado: 0, transicao: 1, liberado: 2 };

  const lista = [];
  atletasSnap.forEach(docSnap => {
    const d = docSnap.data() || {};
    const st = statusMedMap[docSnap.id]?.status || 'liberado';
    lista.push({ id: docSnap.id, d, st });
  });

  lista.sort((a, b) => {
    const os = (ordemStatus[a.st] ?? 2) - (ordemStatus[b.st] ?? 2);
    if (os !== 0) return os;
    return (a.d.nome || '').localeCompare(b.d.nome || '', 'pt-BR');
  });

  const cards = lista.map(({ id, d, st }) => {
    const nome    = (d.nome || d.name || '').trim();
    const posicao = (d.posicao || '').trim();
    const fotoUrl = d.fotoUrl || '';
    const partes  = nome.split(/\s+/);
    const nomeEx  = partes[0] || nome;
    const iniciais = partes.slice(0, 2).map(p => p[0]?.toUpperCase() || '').join('');
    const pill    = pillCfg[st] || pillCfg.liberado;
    const bg      = bgSolid[st]   || bgSolid.liberado;
    const tc      = textSolid[st] || textSolid.liberado;

    const fotoHTML = fotoUrl
      ? `<img src="${fotoUrl}" alt="${nome}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:center top;">`
      : `<div style="position:absolute;inset:0;background:${bg};display:flex;align-items:center;justify-content:center;"><span style="font-size:36px;font-weight:800;color:${tc};">${iniciais}</span></div>`;

    return `
      <div onclick="window.location.href='atleta_perfil.html?id=${id}'"
           style="background:#111827;border:1.5px solid ${pill.brd};border-radius:12px;overflow:hidden;width:85px;flex-shrink:0;cursor:pointer;transition:transform .15s;"
           onmouseenter="this.style.transform='translateY(-3px)'"
           onmouseleave="this.style.transform='translateY(0)'">
        <div style="position:relative;aspect-ratio:2/3;overflow:hidden;">
          ${fotoHTML}
          <div style="position:absolute;inset:0;background:linear-gradient(to bottom,rgba(0,0,0,0.05) 0%,transparent 28%,rgba(0,0,0,0.65) 72%,rgba(0,0,0,0.88) 100%);"></div>
          <div style="position:absolute;bottom:0;left:0;right:0;padding:6px 10px 10px;">
            <div style="font-size:12px;font-weight:700;color:#fff;line-height:1.25;text-shadow:0 1px 4px rgba(0,0,0,0.6);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${nomeEx}</div>
            ${posicao
              ? `<div style="font-size:9px;color:rgba(255,255,255,0.72);text-transform:uppercase;letter-spacing:.04em;margin-bottom:5px;">${posicao}</div>`
              : `<div style="margin-bottom:5px;"></div>`}
            <span style="display:inline-flex;align-items:center;gap:4px;font-size:9px;font-weight:700;padding:2px 8px;border-radius:999px;background:${pill.bg};color:${pill.text};">
              <span style="width:5px;height:5px;border-radius:50%;background:${pill.dot};display:inline-block;"></span>
              ${pill.label}
            </span>
          </div>
        </div>
      </div>`;
  });

  grid.innerHTML = cards.join('');
}

/* =========================
   CLASSIFICAÇÕES FÍSICAS
========================= */

function classVelocidade(v){
  if(v <= 3.90) return "Excelente";
  if(v <= 4.05) return "Muito Bom";
  if(v <= 4.20) return "Bom";
  if(v <= 4.35) return "Regular";
  return "Abaixo";
}

function classAgilidade(v){
  if(v <= 8.5) return "Excelente";
  if(v <= 9.0) return "Muito Bom";
  if(v <= 9.5) return "Bom";
  if(v <= 10.0) return "Regular";
  return "Abaixo";
}

function classSalto(v){
  if(v > 290) return "Excelente";
  if(v >= 270) return "Muito Bom";
  if(v >= 250) return "Bom";
  if(v >= 230) return "Regular";
  return "Abaixo";
}

function classYoYo(v){
  if(v >= 20) return "Excelente";
  if(v >= 18) return "Muito Bom";
  if(v >= 16) return "Bom";
  if(v >= 14) return "Regular";
  return "Abaixo";
}

/* =========================
   CLASSIFICAÇÕES FUNCIONAIS
========================= */

function classAssim(v){
  if(v === null || v === undefined || isNaN(v)) return null;
  if(v < 10) return "Boa";
  if(v <= 15) return "Moderada";
  return "Alta";
}

function classIQ(v){
  if(v === null || v === undefined || isNaN(v)) return null;
  if(v >= 60 && v <= 80) return "Boa";
  if(v >= 50 && v < 60) return "Moderada";
  if(v < 50) return "Alta";
  return null;
}

function classMob(regiao,v){
  if(v === null || v === undefined || v === "" || isNaN(Number(v))) return null;
  v = Number(v);

  if(regiao==="Quadril"){
    if(v > 40) return "Baixa Rigidez";
    if(v < 30) return "Alta Rigidez";
    return "Normal";
  }

  if(regiao==="Tornozelo"){
    if(v > 42) return "Risco Baixo";
    if(v >= 37) return "Risco Moderado";
    return "Risco Alto";
  }

  if(regiao==="Posteriores"){
    if(v > 150) return "Risco Baixo";
    if(v >= 130) return "Risco Moderado";
    return "Risco Alto";
  }
  return null;
}

/* =========================
   CONTROLE DE ABAS
========================= */

window.abrir = async (tipo)=>{
  // Aguarda até 5s pelos dados caso o auth ainda esteja inicializando
  if(!atletasSnap){
    conteudo.innerHTML = "<p style='padding:1rem;color:#888'>Carregando...</p>";
    for(let i=0;i<50;i++){
      await new Promise(r=>setTimeout(r,100));
      if(atletasSnap) break;
    }
  }
  if(!atletasSnap){
    conteudo.innerHTML = "<p style='padding:1rem;color:red'>Erro ao carregar. Verifique se está autenticado.</p>";
    return;
  }
  if(tipo==="medico") montarMedico();
  if(tipo==="funcional") montarFuncional();
  if(tipo==="antropometria") montarAntropometria();
  if(tipo==="fisica") montarFisica();
  if(tipo==="performance") montarPerformance().catch(e => console.error("[perfil_elenco] montarPerformance:", e));
  if(tipo==="psicologica") montarPsicologica();
};

/* =========================
   DEPARTAMENTO MÉDICO
========================= */

function tabelaBonita(titulo, headers, rows){
  return `<div class="mb-8"><h3 class="text-base font-bold text-gray-700 uppercase tracking-wider mb-3 flex items-center gap-2">
    <span class="w-1 h-5 bg-blue-500 rounded-full inline-block"></span>${titulo}</h3>
  <div class="overflow-x-auto rounded-xl border border-gray-200 shadow-sm">
  <table class="w-full text-sm border-collapse">
  <thead><tr class="bg-gray-50 border-b border-gray-200">
    ${headers.map(h=>`<th class="px-4 py-3 text-left font-semibold text-gray-600 whitespace-nowrap">${h}</th>`).join("")}
  </tr></thead>
  <tbody class="divide-y divide-gray-100">
    ${rows||`<tr><td colspan="${headers.length}" class="px-4 py-6 text-center text-gray-400">Sem registros</td></tr>`}
  </tbody></table></div></div>`;
}

function montarMedico(){
  const hoje = new Date();
  hoje.setHours(0,0,0,0);
  const dataRef = _dataRefMedico ? new Date(_dataRefMedico + "T00:00:00") : hoje;
  dataRef.setHours(0,0,0,0);

  // ── Helpers de normalização (cobre legado status_clinico e novo tipo:lesao)
  function dataDeReg(m){ return m.data || m.date || ""; }
  function statusDe(m){
    const d = m.dados || m;
    return (d.status || d.statusAtual || m.status || m.statusAtual || "").toLowerCase();
  }
  function isLesaoDoc(m){
    const d = m.dados || m;
    const s = statusDe(m);
    return m.tipo === "status_clinico"
      || m.tipo === "lesao" || m.tipo === "lesão"
      || d.tipoRegistro === "lesao"
      || (!m.tipoAtendimento && !d.tipoAtendimento && (d.tipoLesao || m.tipoLesao))
      || s === "afastado" || s === "transicao" || s === "transição";
  }
  function isAtendDoc(m){
    return (m.tipo === "atendimento" || m.tipo === "atendimento_diario"
      || m.dados?.tipoRegistro === "atendimento"
      || !!(m.tipoAtendimento || m.dados?.tipoAtendimento))
      && !isLesaoDoc(m);
  }
  function diasDesde(dateStr){
    if(!dateStr) return null;
    return Math.round((hoje - new Date(dateStr + "T00:00:00")) / 86400000);
  }
  function diasEntre(startStr, endStr){
    if(!startStr || !endStr) return null;
    return Math.round((new Date(endStr + "T00:00:00") - new Date(startStr + "T00:00:00")) / 86400000);
  }
  function corDias(n){
    if(n === null) return "text-gray-400";
    if(n >= 14) return "text-red-600 font-bold";
    if(n >= 7)  return "text-yellow-600 font-semibold";
    return "text-green-700 font-semibold";
  }
  function fmtData(str){
    if(!str) return "—";
    const [y,m,d] = str.split("-");
    return `${d}/${m}/${y}`;
  }
  function badgeStatus(status){
    if(!status) return "";
    const s = status.toLowerCase();
    const cfg = {
      afastado:  "bg-red-100 text-red-700 border border-red-200",
      transicao: "bg-yellow-100 text-yellow-700 border border-yellow-200",
      liberado:  "bg-green-100 text-green-700 border border-green-200"
    };
    const labels = { afastado:"Afastado", transicao:"Transição", liberado:"Liberado" };
    const cor = cfg[s] || "bg-gray-100 text-gray-600 border border-gray-200";
    return `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${cor}">${labels[s]||status}</span>`;
  }

  // Por atleta: registro de lesão mais recente
  const statusPorAtleta = {};
  const atendimentos = [];

  medicoSnap.forEach(docSnap=>{
    const m = docSnap.data();
    if(!atletas[m.athleteId]) return;
    if(isLesaoDoc(m)){
      const aid = m.athleteId;
      const dr  = dataDeReg(m);
      if(!statusPorAtleta[aid] || dr > dataDeReg(statusPorAtleta[aid])){
        statusPorAtleta[aid] = m;
      }
    }
    if(isAtendDoc(m)) atendimentos.push(m);
  });

  // ── Tabela de lesões ─────────────────────────────────────────────────
  const statusList = Object.values(statusPorAtleta).sort((a,b)=>{
    const ordem = {afastado:0, transicao:1, liberado:2};
    return (ordem[statusDe(a)]??9) - (ordem[statusDe(b)]??9);
  });

  let rowsL = "";
  statusList.forEach(m=>{
    const d  = m.dados || m;
    const status     = statusDe(m);
    const tipoLesao  = d.tipoLesao  || m.tipoLesao  || "—";
    const regiao     = d.regiao     || m.regiao     || "—";
    const diasPrev   = d.diasAfastado ?? m.diasAfastado ?? null;
    const dataReg    = dataDeReg(m);
    let diasCorr;
    if(status === "liberado"){
      const alta = m.dataAlta || (m.dados && m.dados.dataAlta);
      if(alta){
        diasCorr = diasEntre(dataReg, alta);
      } else {
        // fallback: updatedAt
        const upd = m.updatedAt;
        let fimTs = null;
        if(upd?.seconds)        fimTs = new Date(upd.seconds * 1000);
        else if(upd?.toDate)    fimTs = upd.toDate();
        else if(upd && typeof upd === "string") fimTs = new Date(upd);
        const fimStr = fimTs ? fimTs.toLocaleDateString('en-CA') : null;
        diasCorr = diasEntre(dataReg, fimStr);
      }
    } else {
      diasCorr = diasDesde(dataReg);
    }
    const diasCorrTxt = diasCorr !== null
      ? `${diasCorr} ${diasCorr===1?"dia":"dias"}` : "—";
    const diasPrevTxt = diasPrev != null && diasPrev !== ""
      ? `${diasPrev} dias` : "—";
    const obs = d.observacao || d.obs || m.observacao || "—";
    rowsL += `<tr class="hover:bg-gray-50">
      <td class="px-4 py-3 font-semibold text-gray-800">${atletas[m.athleteId]||"—"}</td>
      <td class="px-4 py-3 text-gray-600">${fmtData(dataReg)}</td>
      <td class="px-4 py-3 ${corDias(diasCorr)}">${diasCorrTxt}</td>
      <td class="px-4 py-3 text-gray-500 text-sm">${diasPrevTxt}</td>
      <td class="px-4 py-3">${tipoLesao}</td>
      <td class="px-4 py-3 text-gray-500 text-sm">${regiao}</td>
      <td class="px-4 py-3">${badgeStatus(status)}</td>
      <td class="px-4 py-3 text-gray-500 text-sm">${obs}</td>
    </tr>`;
  });

  // ── Tabela de atendimentos ───────────────────────────────────────────
  // Filtro por data só se estiver gerando PDF com data de referência selecionada
  const dataRefStr = dataRef.toLocaleDateString('en-CA');
  const atendFiltrados = _dataRefMedico
    ? atendimentos.filter(m => dataDeReg(m) >= dataRefStr)
    : atendimentos;
  atendFiltrados.sort((a,b)=>dataDeReg(b).localeCompare(dataDeReg(a)));
  let rowsA = "";
  atendFiltrados.forEach(m=>{
    const d = m.dados || m;
    const tipoAtend = d.tipoAtendimento || m.tipoAtendimento || "—";
    const queixa    = d.queixa   || "—";
    const conduta   = d.conduta  || d.procedimento || "—";
    const obs       = d.observacao || d.obs || m.observacao || "—";
    rowsA += `<tr class="hover:bg-gray-50">
      <td class="px-4 py-3 font-semibold text-gray-800">${atletas[m.athleteId]||"—"}</td>
      <td class="px-4 py-3 text-gray-600">${fmtData(dataDeReg(m))}</td>
      <td class="px-4 py-3">${tipoAtend}</td>
      <td class="px-4 py-3 text-gray-500 text-sm">${queixa}</td>
      <td class="px-4 py-3 text-gray-500 text-sm">${conduta}</td>
      <td class="px-4 py-3 text-gray-500 text-sm">${obs}</td>
    </tr>`;
  });

  conteudo.innerHTML=`<h2 class="text-xl font-bold mb-6">Departamento Médico</h2>`
    +tabelaBonita("Lesões",["Atleta","Data","Dias Corridos","Dias Previstos","Tipo","Região","Status","Observação"],rowsL)
    +tabelaBonita("Atendimentos de Rotina",["Atleta","Data","Tipo","Queixa","Conduta","Observação"],rowsA);
}

/* =========================
   ANTROPOMETRIA
========================= */

/** Fórmula Navy — mesma usada no formulário de coleta */
function calcNavyLocal(sexo, alt, pescoco, abdomen, quadril){
  if(!alt || !pescoco) return null;
  const h=Number(alt), p=Number(pescoco);
  if(sexo==="M"){
    if(!abdomen) return null;
    const ab=Number(abdomen);
    const gc=495/(1.0324-0.19077*Math.log10(ab-p)+0.15456*Math.log10(h))-450;
    return isFinite(gc)&&gc>0?+gc.toFixed(1):null;
  }
  if(sexo==="F"){
    if(!abdomen||!quadril) return null;
    const ab=Number(abdomen),qd=Number(quadril);
    const gc=495/(1.29579-0.35004*Math.log10(ab+qd-p)+0.22100*Math.log10(h))-450;
    return isFinite(gc)&&gc>0?+gc.toFixed(1):null;
  }
  return null;
}

function classGC(gc){
  if(gc===null||gc===undefined) return "";
  if(gc<7)   return "bg-yellow-50 text-yellow-700 font-semibold";  // Atenção — muito baixo
  if(gc<9)   return "bg-green-200 text-green-900 font-semibold";   // Ótimo — verde escuro
  if(gc<=11) return "bg-green-50 text-green-700 font-semibold";    // Bom   — verde claro
  return "bg-yellow-50 text-yellow-700 font-semibold";             // Atenção — elevado
}
function labelGC(gc){
  if(gc===null||gc===undefined) return "";
  if(gc<7)   return "Atenção";
  if(gc<9)   return "Ótimo";
  if(gc<=11) return "Bom";
  return "Atenção";
}

function montarAntropometria(){
  // Por atleta, pega registro mais recente
  const porAtleta={};
  avalSnap.forEach(docSnap=>{
    const f=docSnap.data();
    if(f.tipo==="fisica"&&f.dados?.antropometria){
      if(!atletas[f.athleteId]) return;
      const ant=porAtleta[f.athleteId];
      if(!ant||f.date>ant.date) porAtleta[f.athleteId]={date:f.date,...f};
    }
  });

  let rows="";
  Object.values(porAtleta)
    .sort((a,b)=>{
      // Pior para melhor: maior %GC primeiro; sem GC vai ao final
      const gcA=a.dados?.antropometria?.navy?.gc_calculado??a.dados?.antropometria?.gordura_percentual??null;
      const gcB=b.dados?.antropometria?.navy?.gc_calculado??b.dados?.antropometria?.gordura_percentual??null;
      if(gcA===null&&gcB===null) return (atletas[a.athleteId]||"").localeCompare(atletas[b.athleteId]||"","pt-BR");
      if(gcA===null) return 1;
      if(gcB===null) return -1;
      return gcB-gcA;
    })
    .forEach(f=>{
      const a  = f.dados.antropometria;
      const peso= a.peso_kg||null;
      const alt = a.estatura_cm||null;

      // %GC: prioridade navy salvo, depois campo manual
      let gc = null;
      let metodo = "";
      if(a.navy?.gc_calculado!=null){
        gc=a.navy.gc_calculado;
        metodo=`<span class="text-xs text-blue-600 ml-1">(Navy)</span>`;
      } else if(a.gordura_percentual!=null){
        gc=a.gordura_percentual;
        metodo=`<span class="text-xs text-gray-400 ml-1">(manual)</span>`;
      }
      // Recalcula se campos Navy presentes mas gc não estava salvo
      if(gc===null&&a.navy?.sexo){
        const n=a.navy;
        gc=calcNavyLocal(n.sexo,alt,n.pescoco_cm,n.abdomen_cm,n.quadril_cm||null);
        if(gc!==null) metodo=`<span class="text-xs text-blue-600 ml-1">(Navy·recalc)</span>`;
      }

      // Massa magra e gorda
      let mm=a.massa_magra_kg??null, mg=a.massa_gorda_kg??null;
      if((mm===null||mg===null)&&gc!==null&&peso){
        mm=+((1-gc/100)*peso).toFixed(1);
        mg=+(gc/100*peso).toFixed(1);
      }

      const fmtGC  = gc!==null  ? `<span class="${classGC(gc)} px-2 py-0.5 rounded">${gc}% · ${labelGC(gc)}${metodo}</span>` : `<span class="text-gray-400">—</span>`;
      const fmtMM  = mm!==null  ? `${mm} kg` : `<span class="text-gray-400">—</span>`;
      const fmtMG  = mg!==null  ? `${mg} kg` : `<span class="text-gray-400">—</span>`;
      const fmtPeso= peso?`${peso} kg`:`<span class="text-gray-400">—</span>`;
      const fmtAlt = alt ?`${alt} cm` :`<span class="text-gray-400">—</span>`;
      const fmtData= f.date?f.date.split("-").reverse().join("/"):"—";

      rows+=`<tr class="hover:bg-gray-50">
        <td class="px-4 py-3 font-semibold text-gray-800">${atletas[f.athleteId]||"—"}</td>
        <td class="px-4 py-3 text-gray-500 text-xs">${fmtData}</td>
        <td class="px-4 py-3">${fmtAlt}</td>
        <td class="px-4 py-3">${fmtPeso}</td>
        <td class="px-4 py-3">${fmtGC}</td>
        <td class="px-4 py-3">${fmtMM}</td>
        <td class="px-4 py-3">${fmtMG}</td>
      </tr>`;
    });

  const legenda = `
    <div class="mt-4 p-4 bg-gray-50 border border-gray-200 rounded-xl text-sm">
      <div class="font-semibold text-gray-700 mb-2 uppercase tracking-wide text-xs">Protocolo &amp; Classificação — % Gordura Corporal</div>
      <div class="text-gray-500 text-xs mb-3">Protocolo Navy (US Navy): medidas de pescoço, abdômen e quadril (fórmula circunferência). Quando não disponível, usa valor manual informado.</div>
      <div class="flex flex-wrap gap-3">
        <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded bg-yellow-50 text-yellow-700 font-semibold text-xs">Atenção — &lt;7% ou &gt;11%</span>
        <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded bg-green-200 text-green-900 font-semibold text-xs">Ótimo — 7% a 8,9%</span>
        <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded bg-green-50 text-green-700 font-semibold text-xs">Bom — 9% a 11%</span>
      </div>
    </div>`;

  conteudo.innerHTML=tabelaBonita("Dados Antropométricos – Composição Corporal",
      ["Atleta","Data","Estatura","Peso","% Gordura","Massa Magra","Massa Gorda"],rows)
    +legenda;
}

/* =========================
   AVALIAÇÃO FÍSICA
========================= */

function montarFisica(){
  let rows="";
  avalSnap.forEach(doc=>{
    const f=doc.data();
    if(f.tipo==="fisica"){
      if(!atletas[f.athleteId]) return;
      const d=f.dados;
      const cV=classVelocidade(d.velocidade_30m),cA=classAgilidade(d.agilidade_ttest);
      const cS=classSalto(d.salto_horizontal),cY=classYoYo(d.yoyo);
      rows+=`<tr class="hover:bg-gray-50">
        <td class="px-4 py-3 font-semibold text-gray-800">${atletas[f.athleteId]||"-"}</td>
        <td class="px-4 py-3 ${corClasse(cV)}">${d.velocidade_30m||"—"}s <span class="text-xs">${cV}</span></td>
        <td class="px-4 py-3 ${corClasse(cA)}">${d.agilidade_ttest||"—"}s <span class="text-xs">${cA}</span></td>
        <td class="px-4 py-3 ${corClasse(cS)}">${d.salto_horizontal||"—"}cm <span class="text-xs">${cS}</span></td>
        <td class="px-4 py-3 ${corClasse(cY)}">${d.yoyo||"—"} <span class="text-xs">${cY}</span></td>
      </tr>`;
    }
  });
  conteudo.innerHTML=`<h2 class="text-xl font-bold mb-6">Avaliação Física</h2>`
    +tabelaBonita("Testes Físicos",["Atleta","Velocidade 30m","Agilidade T-Test","Salto Horizontal","Yo-Yo"],rows);
}

/* =========================
   AVALIAÇÃO FUNCIONAL
========================= */

function tabelaHeader(titulo, cols){
  return `<div class="mb-8"><h3 class="text-base font-bold text-gray-700 uppercase tracking-wider mb-3 flex items-center gap-2">
    <span class="w-1 h-5 bg-blue-500 rounded-full inline-block"></span>${titulo}</h3>
  <div class="overflow-x-auto rounded-xl border border-gray-200 shadow-sm">
  <table class="w-full text-sm border-collapse">
  <thead><tr class="bg-gray-50 border-b border-gray-200">
    <th class="px-4 py-3 text-left font-semibold text-gray-600 whitespace-nowrap">Atleta</th>
    ${cols.map(c=>`<th class="px-4 py-3 text-center font-semibold text-gray-600 whitespace-nowrap">${c}</th>`).join("")}
  </tr></thead><tbody class="divide-y divide-gray-100">`;
}
function tabelaFooter(){ return `</tbody></table></div></div>`; }
function bgCor(txt){
  if(!txt) return "";
  const t=txt.toString().toLowerCase();
  if(t.includes("excelente")||t.includes("boa")||t.includes("normal")||t.includes("baixa")||t.includes("risco baixo")) return "bg-green-50 text-green-800 font-semibold";
  if(t.includes("muito")||t.includes("moderada")||t.includes("regular")||t.includes("risco moderado")) return "bg-yellow-50 text-yellow-800 font-semibold";
  if(t.includes("alta")||t.includes("abaixo")||t.includes("risco alto")) return "bg-red-50 text-red-800 font-semibold";
  return "";
}
function celula(v,c){ return `<td class="px-4 py-3 text-center whitespace-nowrap ${bgCor(c)}">${v}</td>`; }
function badge(v,c){
  if(!v || v===null) return "";
  const t=(c||v||"").toString().toLowerCase();
  const cor=(t.includes("boa")||t.includes("normal")||t.includes("excelente")||t.includes("baixa")||t.includes("risco baixo"))?"bg-green-100 text-green-800 border border-green-200"
    :(t.includes("modera")||t.includes("regular")||t.includes("muito")||t.includes("risco moderado"))?"bg-yellow-100 text-yellow-800 border border-yellow-200"
    :(t.includes("alta")||t.includes("abaixo")||t.includes("risco alto"))?"bg-red-100 text-red-800 border border-red-200"
    :"bg-gray-100 text-gray-600 border border-gray-200";
  return `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${cor}">${v}</span>`;
}

function montarFuncional(){
  const df=[];
  _dfFuncional = []; // reset cache
  avalSnap.forEach(doc=>{
    const f=doc.data();
    if(f.meta?.origem==="avaliacao_funcional"){
      if(!atletas[f.athleteId]) return; // atleta desligado
      const fo=f.setores?.forca||{}, mob=f.setores?.mobilidade||{}, flex=f.setores?.flexibilidade||{};
      const qd=Number(fo.quad_dir),qe=Number(fo.quad_esq),id=Number(fo.isq_dir),ie=Number(fo.isq_esq);
      // Guarda no cache para o modal de treinos (pega só a mais recente por atleta)
      const jaExiste = _dfFuncional.findIndex(x => x.athleteId === f.athleteId);
      const entrada = { athleteId: f.athleteId, nome: atletas[f.athleteId]||"-", setores: f.setores||{}, dataAval: f.date||null };
      if (jaExiste === -1) _dfFuncional.push(entrada);
      else if ((f.date||"") > (_dfFuncional[jaExiste].dataAval||"")) _dfFuncional[jaExiste] = entrada;
      df.push({ nome:atletas[f.athleteId]||"-",
        assimQuad:(qd&&qe)?((Math.abs(qd-qe)/Math.max(qd,qe))*100).toFixed(1):null,
        assimIsq:(id&&ie)?((Math.abs(id-ie)/Math.max(id,ie))*100).toFixed(1):null,
        iqDir:(qd&&id)?((id/qd)*100).toFixed(1):null,
        iqEsq:(qe&&ie)?((ie/qe)*100).toFixed(1):null, mob, flex });
    }
  });

  let t1=tabelaHeader("Assimetria Muscular",[
  "Assim. Quadríceps",
  "Assim. Isquiotibiais",
  "Rel. I/Q Dir",
  "Rel. I/Q Esq"
]);
  df.forEach(d=>{
    const cAQ=d.assimQuad!=null?classAssim(Number(d.assimQuad)):null;
    const cAI=d.assimIsq!=null?classAssim(Number(d.assimIsq)):null;
    const cID=d.iqDir!=null?classIQ(Number(d.iqDir)):null;
    const cIE=d.iqEsq!=null?classIQ(Number(d.iqEsq)):null;
    t1+=`<tr class="hover:bg-gray-50 transition-colors">
  <td class="px-4 py-3 font-semibold text-gray-800">${d.nome}</td>

  <td class="px-4 py-3 text-center ${bgCor(cAQ)}">
    ${d.assimQuad!=null?d.assimQuad+"%":"—"}
    <div class="mt-1">${badge(cAQ,cAQ)}</div>
  </td>

  <td class="px-4 py-3 text-center ${bgCor(cAI)}">
    ${d.assimIsq!=null?d.assimIsq+"%":"—"}
    <div class="mt-1">${badge(cAI,cAI)}</div>
  </td>

  <td class="px-4 py-3 text-center ${bgCor(cID)}">
    ${d.iqDir!=null?d.iqDir+"%":"—"}
    <div class="mt-1">${badge(cID,cID)}</div>
  </td>

  <td class="px-4 py-3 text-center ${bgCor(cIE)}">
    ${d.iqEsq!=null?d.iqEsq+"%":"—"}
    <div class="mt-1">${badge(cIE,cIE)}</div>
  </td>
</tr>`;
  });
  t1+=tabelaFooter();

  let t2=tabelaHeader("Mobilidade Articular – Risco de Lesão",[
  "Quadril Dir",
  "Quadril Esq",
  "Tornozelo Dir",
  "Tornozelo Esq",
  "Posterior Dir",
  "Posterior Esq"
]);
  df.forEach(d=>{
    const m=d.mob;
    const mQD=classMob("Quadril",m.quadril_dir),mQE=classMob("Quadril",m.quadril_esq);
    const mTD=classMob("Tornozelo",m.tornozelo_dir),mTE=classMob("Tornozelo",m.tornozelo_esq);
    const mPD=classMob("Posteriores",m.posteriores_dir),mPE=classMob("Posteriores",m.posteriores_esq);
    t2+=`<tr class="hover:bg-gray-50 transition-colors">
  <td class="px-4 py-3 font-semibold text-gray-800">${d.nome}</td>

  <td class="px-4 py-3 text-center ${bgCor(mQD)}">
    ${m.quadril_dir!=null?m.quadril_dir+"°":"—"}
    <div class="mt-1">${badge(mQD,mQD)}</div>
  </td>

  <td class="px-4 py-3 text-center ${bgCor(mQE)}">
    ${m.quadril_esq!=null?m.quadril_esq+"°":"—"}
    <div class="mt-1">${badge(mQE,mQE)}</div>
  </td>

  <td class="px-4 py-3 text-center ${bgCor(mTD)}">
    ${m.tornozelo_dir!=null?m.tornozelo_dir+"°":"—"}
    <div class="mt-1">${badge(mTD,mTD)}</div>
  </td>

  <td class="px-4 py-3 text-center ${bgCor(mTE)}">
    ${m.tornozelo_esq!=null?m.tornozelo_esq+"°":"—"}
    <div class="mt-1">${badge(mTE,mTE)}</div>
  </td>

  <td class="px-4 py-3 text-center ${bgCor(mPD)}">
    ${m.posteriores_dir!=null?m.posteriores_dir+"°":"—"}
    <div class="mt-1">${badge(mPD,mPD)}</div>
  </td>

  <td class="px-4 py-3 text-center ${bgCor(mPE)}">
    ${m.posteriores_esq!=null?m.posteriores_esq+"°":"—"}
    <div class="mt-1">${badge(mPE,mPE)}</div>
  </td>
</tr>`;
  });
  t2+=tabelaFooter();

  let t3=tabelaHeader("Flexibilidade – Encurtamento Muscular (Risco de Lesão)",["Flex. Quadríceps Dir","Flex. Quadríceps Esq","Flex. Iliopsoas Dir","Flex. Iliopsoas Esq"]);
  df.forEach(d=>{
    const fl=d.flex;
    const fQD=fl.quad_dir||null, fQE=fl.quad_esq||null;
    const fID=fl.ilio_dir||null, fIE=fl.ilio_esq||null;
    function flexLabel(v){ if(!v||v==="") return null; if(v==="Normal") return "Risco Baixo"; if(v==="Moderada") return "Risco Moderado"; if(v==="Alta") return "Risco Alto"; return null; }
    const lQD=flexLabel(fQD), lQE=flexLabel(fQE), lID=flexLabel(fID), lIE=flexLabel(fIE);
    t3+=`<tr class="hover:bg-gray-50 transition-colors"><td class="px-4 py-3 font-semibold text-gray-800">${d.nome}</td>
      <td class="px-4 py-3 text-center ${bgCor(lQD)}">${fQD??"—"}${lQD?`<div class="mt-1">${badge(lQD,lQD)}</div>`:""}</td>
      <td class="px-4 py-3 text-center ${bgCor(lQE)}">${fQE??"—"}${lQE?`<div class="mt-1">${badge(lQE,lQE)}</div>`:""}</td>
      <td class="px-4 py-3 text-center ${bgCor(lID)}">${fID??"—"}${lID?`<div class="mt-1">${badge(lID,lID)}</div>`:""}</td>
      <td class="px-4 py-3 text-center ${bgCor(lIE)}">${fIE??"—"}${lIE?`<div class="mt-1">${badge(lIE,lIE)}</div>`:""}</td></tr>`;
  });
  t3+=tabelaFooter();

  conteudo.innerHTML=`<div class="flex items-center justify-between mb-6">
    <h2 class="text-xl font-bold">Avaliação Funcional</h2>
    <button onclick="abrirModalTreinos()"
      class="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold px-4 py-2 rounded-lg text-sm transition-colors shadow-sm">
      <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/>
      </svg>
      Gerar Treinos
    </button>
  </div>${t1}${t2}${t3}`;
}

/* =========================
   FUNÇÃO DE CORES
========================= */

function corClasse(txt){
  if(!txt) return "";
  const t=txt.toString().toLowerCase();
  if(t.includes("excelente")||t.includes("boa")||t.includes("normal")||t.includes("baixa")||t.includes("risco baixo")) return "bg-green-50 text-green-800 font-semibold";
  if(t.includes("muito")||t.includes("moderada")||t.includes("regular")||t.includes("risco moderado")) return "bg-yellow-50 text-yellow-800 font-semibold";
  if(t.includes("alta")||t.includes("abaixo")||t.includes("risco alto")) return "bg-red-50 text-red-800 font-semibold";
  return "";
}

/* =========================
   PERFORMANCE (SCOUT)
========================= */

/* Converte "YYYY-MM-DD" → "S{week}-{year}" (mesmo algoritmo do planejamento.html) */
function dateToWeekKey(dateStr){
  if(!dateStr) return null;
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d, 12, 0, 0);
  const utc = new Date(Date.UTC(dt.getFullYear(), dt.getMonth(), dt.getDate()));
  utc.setUTCDate(utc.getUTCDate() + 4 - (utc.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((utc - yearStart) / 86400000) + 1) / 7);
  return `S${week}-${utc.getUTCFullYear()}`;
}

/* Monta mapa weekKey → periodo a partir do planSnap */
function buildPeriodoMap(){
  const map = {};
  if(!planSnap) return map;
  planSnap.forEach(doc => {
    const weekKey = doc.id.split("_")[0]; // "S15-2025"
    const p = doc.data().periodo;
    if(weekKey && p) map[weekKey] = p;
  });
  return map;
}

/* ─── Pesos idênticos aos DEFAULT_WEIGHTS do scout ─── */
const PERF_W_DEFAULT = {
  "Gol Pró": 10, "Assistência": 6, "Defesa difícil": 6,
  "Chance clara criada": 5, "Passe-chave": 3,
  "Roubada (combate)": 3, "Roubada (pressão ofensiva)": 2, "Roubada (pós-perda)": 2,
  "Boa decisão": 2, "Finalização": 0.5,
  "Duelo ganho (chão)": 0.5, "Duelo ganho (alto)": 0.5,
  "Erro NF": -3, "Erro pressão": -2,
  "Cartão Amarelo": -2, "Cartão Vermelho": -8,
  "Duelo perdido (chão)": -0.5, "Duelo perdido (alto)": -0.5,
  "Finalização adversária": -3, "Gol Contra (adv)": -8,
};
// Usa os mesmos pesos customizados do scout (localStorage), se existirem
function _loadPerfW() {
  try {
    const r = localStorage.getItem("scout_weights_v1");
    return r ? { ...PERF_W_DEFAULT, ...JSON.parse(r) } : { ...PERF_W_DEFAULT };
  } catch { return { ...PERF_W_DEFAULT }; }
}
let PERF_W = _loadPerfW();

/* Mesma fórmula que scoreTo0_100 do scout — usada por jogo individual.
   frac limitado a 1.0 porque um jogo tem no máximo 90 min. */
function _computeIndice(bruto, minutos, nAcoes){
  const frac = Math.max(0.10, Math.min(1.0, Math.max(0, minutos) / 90));
  const per90 = bruto / frac;
  const conf  = Math.min(1, Math.sqrt(Math.max(0, nAcoes) / 20));
  return Math.min(99, Math.max(1, Math.round(55 + per90 * 2 * conf)));
}

async function montarPerformance(){

  PERF_W = _loadPerfW(); // sincroniza com possíveis customizações salvas no scout

  const periodoMap = buildPeriodoMap();

  // Periodos presentes nas partidas carregadas (para mostrar só botões relevantes)
  const periodosExistentes = new Set(["Todos"]);
  scoutSnap.forEach(doc => {
    const wk = dateToWeekKey(doc.data().data);
    if(wk && periodoMap[wk]) periodosExistentes.add(periodoMap[wk]);
  });

  // Mostra spinner enquanto carrega subcoleções
  conteudo.innerHTML = `<p class="text-sm text-gray-500 p-4">Carregando dados de performance…</p>`;

  /* ── Carrega eventos de cada partida do período selecionado ── */
  const partidasFiltradas = [];
  scoutSnap.forEach(docSnap => {
    if(perfPeriodoFiltro !== "Todos"){
      const wk = dateToWeekKey(docSnap.data().data);
      if(!wk || periodoMap[wk] !== perfPeriodoFiltro) return;
    }
    partidasFiltradas.push(docSnap);
  });

  // Ordena ascendente por data: J1 = primeiro jogo da temporada
  partidasFiltradas.sort((a, b) => {
    const da = a.data()?.data || "";
    const db2 = b.data()?.data || "";
    return da.localeCompare(db2);
  });

  // Busca subcoleção de eventos para cada partida em paralelo
  const eventsResults = await Promise.allSettled(
    partidasFiltradas.map(docSnap =>
      getDocs(collection(db, "scout_partidas", docSnap.id, "events"))
        .then(snap => ({ docSnap, events: snap.docs.map(d => d.data()) }))
    )
  );

  const stats = {};
  let jogoNum = 0;

  eventsResults.forEach(res => {
    if(res.status !== "fulfilled") return;
    jogoNum++;
    const { docSnap, events } = res.value;
    const partida = docSnap.data();
    const played  = partida.playedSeconds || {};
    const durSec  = Math.min(partida.duracaoSegundos || 5400, 7200);

    // Estatísticas deste jogo por atleta (para calcular índice por jogo)
    const jogo = {};

    Object.keys(played).forEach(id => {
      const raw = typeof played[id] === "object" ? (played[id].seconds ?? 0) : (played[id] ?? 0);
      if(raw <= 0) return;
      const min = Math.min(raw, durSec) / 60;
      jogo[id] = { bruto: 0, nAcoes: 0, minutos: min };
      if(!stats[id]){
        stats[id] = { jogos:0, minutos:0, gols:0, assist:0, finaliz:0, chances:0,
                      roubadas:0, boas:0, erros:0, duelos_g:0, duelos_p:0, cartAm:0, cartVerm:0,
                      cartoes:[],
                      _perfSum:0, _perfJogos:0 };
      }
      stats[id].jogos   += 1;
      stats[id].minutos += min;
    });

    // Acumula eventos no jogo e nos contadores de exibição do período
    events.forEach(e => {
      const id = e.athleteId;
      if(!id) return;
      if(jogo[id]) {
        const w = PERF_W[e.action];
        if(w !== undefined) jogo[id].bruto += w;
        if(e.action) jogo[id].nAcoes += 1;
      }
      if(!stats[id]) return;
      if(e.action === "Gol Pró")              stats[id].gols++;
      if(e.action === "Assistência")          stats[id].assist++;
      if(e.action === "Finalização")          stats[id].finaliz++;
      if(e.action === "Chance clara criada")  stats[id].chances++;
      if(e.action === "Boa decisão")          stats[id].boas++;
      if(e.action?.includes("Roubada"))       stats[id].roubadas++;
      if(e.action?.includes("Duelo ganho"))   stats[id].duelos_g++;
      if(e.action?.includes("Duelo perdido")) stats[id].duelos_p++;
      if(e.action === "Erro NF" || e.action === "Erro pressão") stats[id].erros++;
      if(e.action === "Cartão Amarelo")       { stats[id].cartAm++; stats[id].cartoes.push({ tipo:"A", jogo:jogoNum }); }
      if(e.action === "Cartão Vermelho")      { stats[id].cartVerm++; stats[id].cartoes.push({ tipo:"V", jogo:jogoNum }); }
    });

    // Calcula índice por jogo e acumula média ponderada por minutos
    Object.entries(jogo).forEach(([id, gs]) => {
      if(!stats[id] || gs.minutos <= 0) return;
      const idx = _computeIndice(gs.bruto, gs.minutos, gs.nAcoes);
      stats[id]._perfSum   += idx;
      stats[id]._perfJogos += 1;
    });
  });

  /* ── Índice só faz sentido dentro de um período específico ──
     Quando "Todos" está selecionado, misturar períodos com objetivos
     diferentes distorce o índice → coluna oculta.              */
  const mostrarIndice = perfPeriodoFiltro !== "Todos";

  const atletasOrdenados = Object.keys(stats).filter(id => atletas[id]).map(id => {
    const s = stats[id];
    const nome   = atletas[id] || id;
    const indice = (mostrarIndice && s._perfJogos > 0)
      ? Math.round(s._perfSum / s._perfJogos)
      : null;
    return { id, nome, s, indice };
  }).sort((a, b) => (b.s.minutos - a.s.minutos) || (b.indice ?? 0) - (a.indice ?? 0));

  let rows = "";
  atletasOrdenados.forEach(({ nome, s, indice }) => {
    const cartoes = s.cartoes || [];
    let cartStr;
    if(cartoes.length === 0){
      cartStr = "—";
    } else {
      // Agrupa por jogo mantendo ordem
      const byJogo = {};
      const jogoOrder = [];
      cartoes.forEach(c => {
        if(!byJogo[c.jogo]){ byJogo[c.jogo] = []; jogoOrder.push(c.jogo); }
        byJogo[c.jogo].push(c.tipo);
      });
      cartStr = jogoOrder.map(j => {
        const badges = byJogo[j].map(t =>
          `<span style="display:inline-block;padding:1px 5px;border-radius:3px;font-size:10px;font-weight:900;line-height:1.4;background:${t==="A"?"#fef9c3":"#fee2e2"};color:${t==="A"?"#92400e":"#991b1b"};border:1px solid ${t==="A"?"#fde047":"#fca5a5"};">${t}</span>`
        ).join(" ");
        return `<span style="white-space:nowrap;">${badges} <span style="font-size:9px;color:#94a3b8;">(J${j})</span></span>`;
      }).join(" ");
    }

    const indiceCell = mostrarIndice
      ? (() => {
          const cor =
            indice >= 60 ? "bg-green-50 text-green-800 font-semibold" :
            indice >= 45 ? "bg-yellow-50 text-yellow-800 font-semibold" :
            "bg-red-50 text-red-800 font-semibold";
          return `<td class="px-4 py-3 text-center ${cor}">${indice}</td>`;
        })()
      : "";

    rows += `
      <tr class="hover:bg-gray-50">
        <td class="px-4 py-3 font-semibold text-gray-800">${nome}</td>
        <td class="px-4 py-3 text-center">${s.jogos}</td>
        <td class="px-4 py-3 text-center">${s.minutos.toFixed(0)}</td>
        <td class="px-4 py-3 text-center">${s.gols}</td>
        <td class="px-4 py-3 text-center">${s.assist}</td>
        <td class="px-4 py-3 text-center">${s.finaliz}</td>
        <td class="px-4 py-3 text-center">${s.chances}</td>
        <td class="px-4 py-3 text-center">${s.roubadas}</td>
        <td class="px-4 py-3 text-center">${s.boas}</td>
        <td class="px-4 py-3 text-center">${s.erros}</td>
        <td class="px-4 py-3 text-center text-green-700 font-semibold">${s.duelos_g}</td>
        <td class="px-4 py-3 text-center text-red-600 font-semibold">${s.duelos_p}</td>
        <td class="px-4 py-3 text-center">${cartStr}</td>
        ${indiceCell}
      </tr>
    `;
  });

  const headers = [
    "Atleta","Jogos","Min",
    "Gols","Assist","Fin","CC",
    "ROB","Boas","Erros",
    "DG","DP","Cart."
  ];
  if(mostrarIndice) headers.push("Índice (0–100)");

  const periodos = ["Todos", "Preparação", "Competição", "Transição"]
    .filter(p => periodosExistentes.has(p));

  const btnsFiltro = periodos.map(p => {
    const active = p === perfPeriodoFiltro;
    const cor = active
      ? "bg-blue-600 text-white border-blue-600"
      : "bg-white text-gray-600 border-gray-300 hover:border-blue-400";
    return `<button data-filtro-periodo="${p}"
      class="px-4 py-1.5 rounded-full text-sm font-semibold border-2 transition-colors ${cor}">${p}</button>`;
  }).join("");

  const totalFiltradas = atletasOrdenados.length > 0
    ? `<span class="text-sm text-gray-400 ml-auto">${atletasOrdenados.length} atleta(s)</span>` : "";

  const avisoTodos = !mostrarIndice
    ? `<p class="text-xs text-gray-400 mt-1">Selecione um período para ver o Índice de Desempenho (períodos diferentes não são comparáveis).</p>` : "";

  conteudo.innerHTML =
    `<div class="flex items-center gap-2 flex-wrap mb-1">
       <h2 class="text-xl font-bold mr-2">Avaliação de Performance</h2>
       ${btnsFiltro}
       ${totalFiltradas}
     </div>
     ${avisoTodos}
     <div class="mb-5"></div>` +
    tabelaBonita("Dados Brutos" + (mostrarIndice ? " + Índice de Desempenho" : ""), headers, rows) +
    `
    <div class="mt-6 text-sm text-gray-600 bg-gray-50 p-4 rounded-lg border">
      <strong>Legenda:</strong><br>
      • Fin: finalizações • CC: chances claras criadas • ROB: roubadas de bola (todas as categorias)<br>
      • Boas: boas decisões • Erros: erro não forçado + erro sob pressão<br>
      • DG: duelos ganhos (chão + alto) • DP: duelos perdidos • Cart.: cartões 🟡/🔴<br>
      ${mostrarIndice ? `<br><strong>Índice de Desempenho:</strong><br>
      Pesos: gol +10 • assist +6 • CC +5 • boa decisão +2 • passe-chave +3 • fin +0,5 • roubada combate +3 • roubada +2 • duelo ganho +0,5 |
      erro NF −3 • erro pressão −2 • duelo perdido −0,5 • cart. amarelo −2 • cart. vermelho −8.<br>
      Mesmo algoritmo do scout: normalizado per-90, confiança = √(ações/20). Escala 1–99 (55 = neutro).` : ""}
    </div>
    `;

  // Conecta botões de filtro de período
  conteudo.querySelectorAll("[data-filtro-periodo]").forEach(btn => {
    btn.onclick = () => {
      perfPeriodoFiltro = btn.dataset.filtroPeriodo;
      montarPerformance();
    };
  });
}

/* =========================
   PERSONALIDADE
========================= */

function montarPsicologica(){
  let rows="";
  avalSnap.forEach(doc=>{
    const f=doc.data();
    if(f.instrumento==="BFI-44"){
      if(!atletas[f.athleteId]) return;
      const d=f.dados;
      rows+=`<tr class="hover:bg-gray-50">
        <td class="px-4 py-3 font-semibold text-gray-800">${atletas[f.athleteId]||"-"}</td>
        <td class="px-4 py-3 text-center">${d.extroversao?.toFixed(2)||"—"}</td>
        <td class="px-4 py-3 text-center">${d.amabilidade?.toFixed(2)||"—"}</td>
        <td class="px-4 py-3 text-center">${d.conscienciosidade?.toFixed(2)||"—"}</td>
        <td class="px-4 py-3 text-center">${d.estabilidade_emocional?.toFixed(2)||"—"}</td>
        <td class="px-4 py-3 text-center">${d.abertura_experiencias?.toFixed(2)||"—"}</td>
        <td class="px-4 py-3 text-sm italic text-gray-600">${analisarPerfil(d)}</td>
      </tr>`;
    }
  });
  conteudo.innerHTML=`<h2 class="text-xl font-bold mb-6">Avaliação de Personalidade</h2>`
    +tabelaBonita("Perfil BFI-44",["Atleta","Extroversão","Amabilidade","Conscienciosidade","Estab. Emocional","Abertura","Análise"],rows);
}
function analisarPerfil(d){
  if(d.conscienciosidade>4 && d.estabilidade_emocional>4)
    return "Perfil competitivo estável e disciplinado.";
  if(d.extroversao>4)
    return "Perfil comunicativo e com potencial de liderança.";
  if(d.estabilidade_emocional<3)
    return "Atleta pode apresentar maior variabilidade emocional sob pressão.";
  return "Perfil equilibrado.";
}

/* =========================
   EXPORTAR PDF COMPLETO
========================= */

// ── Mapa de seções disponíveis para exportação PDF
const SECOES_PDF = [
  { id: "medico",         titulo: "Departamento Médico",        fn: () => montarMedico(), portrait: true },
  { id: "funcional",     titulo: "Avaliação Funcional",        fn: () => montarFuncional() },
  { id: "antropometria", titulo: "Avaliação Antropométrica",   fn: () => montarAntropometria(), portrait: true },
  { id: "fisica",        titulo: "Avaliação Física",           fn: () => montarFisica() },
  { id: "performance",   titulo: "Avaliação de Performance",   fn: () => montarPerformance(), portrait: true },
  { id: "psicologica",   titulo: "Avaliação de Personalidade", fn: () => montarPsicologica() },
];

// ── Modal de seleção de avaliações
function criarModalSelecaoPDF() {
  if (document.getElementById("modalPDF")) return;
  const m = document.createElement("div");
  m.id = "modalPDF";
  m.style.cssText = "display:none;position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;align-items:center;justify-content:center;";
  m.innerHTML = `
    <div style="background:#fff;border-radius:14px;box-shadow:0 24px 64px rgba(0,0,0,.35);width:440px;max-width:95vw;overflow:hidden;">
      <div style="background:#1e3a5f;padding:18px 22px;display:flex;justify-content:space-between;align-items:center;">
        <div style="color:#fff;font-weight:700;font-size:15px;">Exportar PDF — Selecionar Avaliações</div>
        <button id="btnFecharModalPDF" style="color:#94a3b8;background:none;border:none;cursor:pointer;font-size:20px;line-height:1;">✕</button>
      </div>
      <div style="padding:20px 22px;">
        <div style="font-size:12px;color:#6b7280;margin-bottom:16px;">Cada avaliação selecionada é exportada em páginas próprias, sem corte de tabelas.</div>
        <div style="margin-bottom:16px;padding:12px 14px;background:#f0f7ff;border:1.5px solid #bfdbfe;border-radius:9px;">
          <label style="display:block;font-size:12px;font-weight:700;color:#1e3a5f;margin-bottom:6px;">
            📅 Data de referência — Departamento Médico
          </label>
          <div style="font-size:11px;color:#6b7280;margin-bottom:8px;">
            Dias corridos são calculados a partir desta data. Útil para relatórios retroativos ou para excluir atletas já liberados.
          </div>
          <div style="display:flex;align-items:center;gap:10px;">
            <input type="date" id="inputDataRefMedico"
              style="flex:1;padding:7px 10px;border:1.5px solid #93c5fd;border-radius:7px;font-size:13px;color:#1e293b;background:#fff;cursor:pointer;"
            >
            <button onclick="document.getElementById('inputDataRefMedico').value=new Date().toLocaleDateString('en-CA')"
              style="padding:7px 10px;border:1.5px solid #e2e8f0;border-radius:7px;background:#f8fafc;color:#6b7280;font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap;">
              Hoje
            </button>
          </div>
        </div>
        <div id="listaSecoesPDF" style="display:flex;flex-direction:column;gap:8px;">
          ${SECOES_PDF.map(s => `
            <label style="display:flex;align-items:center;gap:12px;cursor:pointer;padding:10px 14px;border:1.5px solid #e2e8f0;border-radius:9px;transition:background .15s;"
              onmouseover="this.style.background='#f0f7ff';this.style.borderColor='#93c5fd';"
              onmouseout="this.style.background='#fff';this.style.borderColor='#e2e8f0';">
              <input type="checkbox" value="${s.id}" style="accent-color:#3b82f6;width:16px;height:16px;cursor:pointer;flex-shrink:0;">
              <span style="font-size:13px;font-weight:600;color:#1e293b;">${s.titulo}</span>
            </label>`).join("")}
        </div>
        <div style="display:flex;gap:10px;margin-top:20px;">
          <button
            style="flex:1;padding:9px;border:1.5px solid #e2e8f0;border-radius:8px;background:#f8fafc;color:#374151;font-size:12px;font-weight:600;cursor:pointer;"
            onclick="document.querySelectorAll('#listaSecoesPDF input').forEach(cb=>cb.checked=true)">
            Selecionar Todos
          </button>
          <button id="btnGerarPDFModal"
            style="flex:2;padding:9px;border:none;border-radius:8px;background:#3b82f6;color:#fff;font-size:13px;font-weight:700;cursor:pointer;">
            Gerar PDF
          </button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(m);
  document.getElementById("btnFecharModalPDF").onclick = () => { m.style.display = "none"; };
  m.onclick = (e) => { if (e.target === m) m.style.display = "none"; };
  // Inicializa data de referência com hoje
  const inputDataRef = document.getElementById("inputDataRefMedico");
  if (inputDataRef) inputDataRef.value = new Date().toLocaleDateString('en-CA');
  document.getElementById("btnGerarPDFModal").onclick = async () => {
    const sels = [...document.querySelectorAll("#listaSecoesPDF input:checked")].map(cb => cb.value);
    if (!sels.length) { alert("Selecione ao menos uma avaliação."); return; }
    // Aplica data de referência para o departamento médico
    const inputData = document.getElementById("inputDataRefMedico");
    _dataRefMedico = inputData && inputData.value ? inputData.value : null;
    m.style.display = "none";
    await _gerarPDFSecoes(sels);
    _dataRefMedico = null; // reset após geração
  };
}

// ── Geração efetiva do PDF por seções selecionadas
async function _gerarPDFSecoes(idsSelecionados) {
  const btn = document.getElementById("btnExportPDF");
  btn.disabled = true;
  btn.textContent = "Gerando PDF...";

  try {
    const secoes = SECOES_PDF.filter(s => idsSelecionados.includes(s.id));
    const { jsPDF } = window.jspdf;
    // PDF começa com orientação da primeira seção; demais páginas herdam a orientação adicionada
    const orientacaoInicial = secoes[0]?.portrait ? "portrait" : "landscape";
    const pdf    = new jsPDF({ orientation: orientacaoInicial, unit: "mm", format: "a4" });
    const margem = 10;
    const dataStr = new Date().toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" });

    // Container fixo fora da viewport
    const tempEl = document.createElement("div");
    document.body.appendChild(tempEl);

    // CSS interno para tabelas limpas no PDF
    const estiloTabelas = `<style>
      * { box-sizing: border-box; }
      table { border-collapse: collapse; width: 100%; }
      thead tr { background: #1e3a5f !important; }
      th { background: #1e3a5f !important; color: #fff !important; font-size: 11px !important; padding: 7px 10px !important; text-align: left !important; font-weight: 700 !important; }
      td { font-size: 11px !important; padding: 6px 10px !important; border-bottom: 1px solid #e2e8f0 !important; vertical-align: middle !important; color: #1e293b; }
      tbody tr:nth-child(even) td { background: #f8fafc !important; }
      .rounded-xl, .rounded-lg, .rounded { border-radius: 0 !important; }
      .shadow-sm, .shadow { box-shadow: none !important; }
      .overflow-x-auto { overflow: visible !important; }
      h3 { font-size: 12px !important; font-weight: 800 !important; color: #1e3a5f !important; margin: 14px 0 6px !important;
           text-transform: uppercase !important; letter-spacing: .5px !important;
           border-left: 3px solid #3b82f6 !important; padding-left: 8px !important; }
    </style>`;

    let primeira = true;

    for (const s of secoes) {
      const isPortrait = !!s.portrait;
      // Dimensões dependem da orientação da seção
      const pgW = isPortrait ? 210 : 297;
      const pgH = isPortrait ? 297 : 210;
      // Largura do container de captura proporcional à orientação
      const containerW = isPortrait ? 794 : 1120;
      tempEl.style.cssText = `position:absolute;top:0;left:-9999px;width:${containerW}px;background:#fff;padding:24px 28px;font-family:'Segoe UI',Arial,sans-serif;box-sizing:border-box;`;

      conteudo.innerHTML = "";
      await s.fn();
      await new Promise(r => setTimeout(r, 80));

      // Para o médico (portrait), renderiza tudo junto sem dividir por mb-8
      const ehMedico = isPortrait;
      const blocos = ehMedico ? [] : [...conteudo.querySelectorAll(".mb-8")];
      const fatias = blocos.length ? blocos : [conteudo];

      for (let fi = 0; fi < fatias.length; fi++) {
        const fatia = fatias[fi];
        const sufixo = fatias.length > 1 ? ` — parte ${fi + 1} de ${fatias.length}` : "";

        tempEl.innerHTML = `
          ${estiloTabelas}
          <div style="margin-bottom:14px;border-bottom:2.5px solid #3b82f6;padding-bottom:8px;display:flex;justify-content:space-between;align-items:flex-end;">
            <div>
              <div style="font-size:9px;color:#94a3b8;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:2px;">CIENTE IE · PERFIL DO ELENCO</div>
              <div style="font-size:17px;font-weight:800;color:#1e3a5f;">${s.titulo}${sufixo}</div>
            </div>
            <div style="font-size:9px;color:#94a3b8;">${dataStr}</div>
          </div>
          ${fatia.outerHTML}`;

        const canvas = await html2canvas(tempEl, {
          scale: 1.8,
          useCORS: true,
          backgroundColor: "#ffffff",
          logging: false,
        });

        const imgW = pgW - margem * 2;
        const imgH = (canvas.height * imgW) / canvas.width;

        if (!primeira) {
          pdf.addPage([210, 297], isPortrait ? "portrait" : "landscape");
        }
        primeira = false;

        if (imgH <= pgH - margem * 2) {
          pdf.addImage(canvas.toDataURL("image/jpeg", 0.93), "JPEG", margem, margem, imgW, imgH);
        } else {
          // Conteúdo maior que uma página: divide em fatias de altura
          const altSlice = pgH - margem * 2;
          const nSlices  = Math.ceil(imgH / altSlice);
          for (let sl = 0; sl < nSlices; sl++) {
            if (sl > 0) pdf.addPage([210, 297], isPortrait ? "portrait" : "landscape");
            const srcY = Math.round((sl * altSlice / imgH) * canvas.height);
            const srcH = Math.round(Math.min(altSlice / imgH * canvas.height, canvas.height - srcY));
            const sc   = document.createElement("canvas");
            sc.width   = canvas.width;
            sc.height  = srcH;
            sc.getContext("2d").drawImage(canvas, 0, srcY, sc.width, srcH, 0, 0, sc.width, srcH);
            const sh = (srcH * imgW) / canvas.width;
            pdf.addImage(sc.toDataURL("image/jpeg", 0.93), "JPEG", margem, margem, imgW, sh);
          }
        }
      }
    }

    document.body.removeChild(tempEl);
    conteudo.innerHTML = "";
    pdf.save(`perfil_elenco_${new Date().toLocaleDateString('en-CA')}.pdf`);

  } catch (err) {
    console.error("Erro PDF:", err);
    alert("Erro ao gerar PDF. Verifique o console.");
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
        d="M12 10v6m0 0l-3-3m3 3l3-3M3 17v3a1 1 0 001 1h16a1 1 0 001-1v-3M3 7V4a1 1 0 011-1h5l2 2h7a1 1 0 011 1v3"/>
      </svg> Exportar PDF`;
  }
}

window.exportarPDF = async function () {
  if (!atletasSnap) {
    for (let i = 0; i < 50; i++) {
      await new Promise(r => setTimeout(r, 100));
      if (atletasSnap) break;
    }
  }
  if (!atletasSnap) { alert("Dados ainda não carregados. Tente novamente."); return; }
  criarModalSelecaoPDF();
  // Garante que a data de referência está preenchida com hoje ao abrir
  const inputDataRef = document.getElementById("inputDataRefMedico");
  if (inputDataRef && !inputDataRef.value) {
    inputDataRef.value = new Date().toLocaleDateString('en-CA');
  }
  document.getElementById("modalPDF").style.display = "flex";
};
/* =============================================================
   MODAL GERAR TREINOS — Protocolo de exercícios por atleta
============================================================= */

window.abrirModalTreinos = function () {
  const antigo = document.getElementById("modalTreinos");
  if (antigo) antigo.remove();

  if (!_dfFuncional.length) {
    alert("Nenhuma avaliação funcional encontrada. Abra a aba \"Avaliação Funcional\" primeiro.");
    return;
  }

  const lista = [..._dfFuncional].sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));

  const checkboxesHtml = lista.map(a => `
    <label style="display:flex;align-items:center;gap:10px;padding:9px 12px;border:1.5px solid #e5e7eb;border-radius:8px;cursor:pointer;background:#fff;transition:background .15s;">
      <input type="checkbox" id="chk_${a.athleteId}" value="${a.athleteId}"
        style="width:16px;height:16px;accent-color:#059669;cursor:pointer;flex-shrink:0;">
      <span style="font-size:13px;font-weight:600;color:#111827;flex:1;">${a.nome}</span>
      ${a.dataAval ? `<span style="font-size:10px;color:#94a3b8;">${a.dataAval.split("-").reverse().join("/")}</span>` : ""}
    </label>`).join("");

  const m = document.createElement("div");
  m.id = "modalTreinos";
  m.style.cssText = "display:flex;position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;align-items:center;justify-content:center;padding:16px;";

  m.innerHTML = `
    <div style="background:#fff;border-radius:16px;box-shadow:0 24px 64px rgba(0,0,0,.35);width:560px;max-width:100%;max-height:92vh;display:flex;flex-direction:column;overflow:hidden;">
      <div style="background:#064e3b;padding:18px 22px;display:flex;justify-content:space-between;align-items:center;flex-shrink:0;">
        <div>
          <div style="font-size:9px;font-weight:700;color:#6ee7b7;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:2px;">CIENTE IE · AVALIAÇÃO FUNCIONAL</div>
          <div style="font-size:16px;font-weight:800;color:#fff;">Gerar Protocolo de Exercícios</div>
        </div>
        <button id="btnFecharModalTreinos" style="color:#6ee7b7;background:none;border:none;cursor:pointer;font-size:20px;line-height:1;">✕</button>
      </div>
      <div style="padding:16px 22px;border-bottom:1px solid #f0f0f0;flex-shrink:0;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
          <label style="font-size:11px;font-weight:700;color:#374151;text-transform:uppercase;letter-spacing:.05em;">Selecionar Atletas</label>
          <div style="display:flex;gap:8px;">
            <button id="btnSelecionarTodos" style="font-size:11px;font-weight:600;color:#059669;background:none;border:1px solid #059669;border-radius:5px;padding:3px 8px;cursor:pointer;">Todos</button>
            <button id="btnDesmarcarTodos" style="font-size:11px;font-weight:600;color:#6b7280;background:none;border:1px solid #e5e7eb;border-radius:5px;padding:3px 8px;cursor:pointer;">Limpar</button>
          </div>
        </div>
        <div id="listaCheckboxes" style="display:flex;flex-direction:column;gap:6px;max-height:240px;overflow-y:auto;">
          ${checkboxesHtml}
        </div>
        <div id="contadorSelecionados" style="font-size:11px;color:#6b7280;margin-top:8px;">0 atleta(s) selecionado(s)</div>
      </div>
      <div style="padding:14px 22px;background:#f9fafb;border-top:1px solid #e5e7eb;display:flex;justify-content:flex-end;gap:10px;flex-shrink:0;">
        <button id="btnCancelarTreinos" style="padding:9px 18px;border:1.5px solid #e5e7eb;border-radius:8px;background:#fff;color:#374151;font-size:13px;font-weight:600;cursor:pointer;">Fechar</button>
        <button id="btnExportarFicha" disabled
          style="padding:9px 22px;border:none;border-radius:8px;background:#059669;color:#fff;font-size:13px;font-weight:700;cursor:not-allowed;opacity:.5;display:flex;align-items:center;gap:6px;">
          <svg xmlns="http://www.w3.org/2000/svg" style="width:15px;height:15px;" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 10v6m0 0l-3-3m3 3l3-3M3 17v3a1 1 0 001 1h16a1 1 0 001-1v-3"/>
          </svg>
          Exportar PDF(s)
        </button>
      </div>
    </div>`;

  document.body.appendChild(m);

  const fechar = () => m.remove();
  document.getElementById("btnFecharModalTreinos").onclick = fechar;
  document.getElementById("btnCancelarTreinos").onclick   = fechar;
  m.onclick = (e) => { if (e.target === m) fechar(); };

  function atualizarContador() {
    const sel = [...m.querySelectorAll('#listaCheckboxes input[type=checkbox]:checked')];
    const n = sel.length;
    document.getElementById("contadorSelecionados").textContent = `${n} atleta(s) selecionado(s)`;
    const btn = document.getElementById("btnExportarFicha");
    btn.disabled = n === 0;
    btn.style.opacity = n === 0 ? ".5" : "1";
    btn.style.cursor  = n === 0 ? "not-allowed" : "pointer";
    m.querySelectorAll('#listaCheckboxes label').forEach(lbl => {
      const chk = lbl.querySelector('input[type=checkbox]');
      lbl.style.background   = chk.checked ? '#f0fdf4' : '#fff';
      lbl.style.borderColor  = chk.checked ? '#059669' : '#e5e7eb';
    });
  }

  m.querySelectorAll('#listaCheckboxes input[type=checkbox]').forEach(chk => {
    chk.onchange = atualizarContador;
  });

  document.getElementById("btnSelecionarTodos").onclick = () => {
    m.querySelectorAll('#listaCheckboxes input[type=checkbox]').forEach(c => { c.checked = true; });
    atualizarContador();
  };
  document.getElementById("btnDesmarcarTodos").onclick = () => {
    m.querySelectorAll('#listaCheckboxes input[type=checkbox]').forEach(c => { c.checked = false; });
    atualizarContador();
  };

  document.getElementById("btnExportarFicha").onclick = async () => {
    const ids = [...m.querySelectorAll('#listaCheckboxes input[type=checkbox]:checked')].map(c => c.value);
    const entradas = ids.map(id => _dfFuncional.find(x => x.athleteId === id)).filter(Boolean);
    if (!entradas.length) return;
    fechar();
    await _exportarFichasPDF(entradas);
  };
};

// ── Renderiza o HTML de UMA ficha ──────────────────────────────────────────
function _renderFichaAtleta(entrada) {
  const { nome, setores, dataAval } = entrada;
  const p = gerarProtocolo(setores);
  const { prioritySystems, risks, exercises } = p;

  const QR_IMG = "data:image/png;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCAHCAcIDASIAAhEBAxEB/8QAGQABAAMBAQAAAAAAAAAAAAAAAAcICQYF/8QARBAAAAEHBQsKBQMEAwAAAAAAAAECAwYHERIEBRMUFQgWGCExOFaEpbTTCRciJEdRZ4XE5CYyM0FhI0VjJyg0RGJmk//EABQBAQAAAAAAAAAAAAAAAAAAAAD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwC5YAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMZwGzADGcAGzADGcAGzADGcAGzADGcTNcS5zqo67uScBpkAAAAMzbtrOdW7UtyQCGQGzADM24lznVR13ck40yAAAZm3bWc6t2pbkgAaZAKZ8mX2g+W+qEzXbWbEt2pb6gATMAxnABswAhm4lzYlR13fU4hnlNOz7zL0oC5gDM24lznVR13ck40yAAGM40yuJc2JUdd31OAmYBTPlNOz7zL0opmA2YAYzjZgAAZm3bWc6t2pbkgEzcmX2g+W+qAXMAQzdtZsS3alvqAZmgNmAGM40yuJc2JUdd31OAmYBTPlNOz7zL0opmA2YAYzgA2YAYzgA2YAYzgA2YAYzjTK4lzYlR13fU4CZgAAAAAAAAAAAAAAAAGM42YGM4C81y4wRk66MJV1ZlmVSvztLK1WJRaEqRxwSpKYb0TEhDSONNNJiITJ3iTMFxhOg21pbxguJc2JUdd31OF003TmWvf+Frdtms/uFWoaGi/jPifS/h0P3fiBguMJ0G2tLeMGC4wnQba0t4whnDn8Ltv+3DDn8Ltv+3ATNguMJ0G2tLeMGC4wnQba0t4whnDn8Ltv+3FmWJL1zlMwmhdbLsq0abqlYpqOjTpEXzwmvfA/IRz3fkBTO7nZaojNbzrypisq0a9W+tp01JR1eD6p5znRn5HPfj+w4y4lznVR13ck4mblNOz7zL0ohm4lznVR13ck4DTIAFM8Ofwu2/7cBYBdmCMnXRZ5WsyzKpX52lkFYlFoSpHHAYaYb0TEhDSONNNJiITJ3ipl3Oy1RGa3nXlTFZVo16t9bTpqSjq8H1TznOjPyOe/H9hcxiS9c5TMJoXWy7KtGm6pWKajo06RF88Jr3wPyEc935FZuU07PvMvSgIZuJc51Udd3JONMhmbcS5zqo67uScaZAAzNu2s51btS3JAJmw5/C7b/txWZtq9c5TT53XWy7KtGh6pWKajo0CNF88Jr3wPyEc935AWZ5MvtB8t9ULZrsq0xLorErVlZpDX5plkFYk9KejjgPNPN6RhSHEccaaXEUmTuGc1zK3TmWvg+FrdtmrfuFWoaGl/jPifS/h0P3fisyxK6t5ymnzQpV4VlWjTdbtemo6NAkS/JQmvfA7KRz3/gB2eC4wnQba0t4wYLjCdBtrS3jCZgAeMpKrTEpasSRWVZkNQmmRx1eT0p6SCM8487pHlKcV5xxxcZS5e4VM5TTs+8y9KLmCGbpphfPTe/8AFNhWNWf2+s01NRfyGQuovy+L7OxhnOpK0z6pazyRZlZl1QnaRx1eUURiSCMw4w7onkKaV5pxxMZC5e8SZhRt2052TIuCOzbbcpc2rMJ3XW/21bOoeqWRQ0lInRovnpjnOjfkK9zvyKzANMsFxhOg21pbxhJqkqtMSlqxJFZVmQ1CaZHHV5PSnpIIzzjzukeUpxXnHHFxlLl7hUzDn8Ltv+3DDn8Ltv8AtwDlNOz7zL0ogC5cVaYl0bsrqsrNIa/NMsrVYk9KejjgkqU83pGFIcRxxppcRSZO4ezdNN056b3/AIWsKxqz+4VmmpqL+MyF1F+XxfZ2NcS5zqo67uScBczBcYToNtaW8YUzwo27ac7JkXBGmQxnAe0uy0z6uizytZlml1fnaWQViUURiOOAw0w3omEIaRxpppMRCZO8eyzJqS9s1tC8qfbKtGirfVECako44PqmHOdGfkc9+P7CZmJXKXOUzCaF1v8AbKtGm6pZFNR0adIi+emNe+B+Qjnu/I4y6aYXzLXv/FNu2zWf2+rUNDRfyHxPpfw6H7vxB4y7N7awuisStWVmWuvzTLIKxJ7PkqOOA8083pGIyHEccaaXEUmTuEZDs2JKLzlNPmhSrUsq0abrdXpqOjQJEvyRGvfA7KRz3/gWZwGPFHYHuAFMxplcS5sSo67vqcZmjTK4lzYlR13fU4CGeU07PvMvSiALlxVpiXRuyuqys0hr80yytViT0p6OOCSpTzekYUhxHHGmlxFJk7hP/Kadn3mXpRDNxLnOqjru5JwFzMFxhOg21pbxgwXGE6DbWlvGEzCmeHP4Xbf9uAmbBcYToNtaW8YMFxhOg21pbxhDOHP4Xbf9uGHP4Xbf9uAmbBcYToNtaW8YMFxhOg21pbxhxjErq3nKafNClXhWVaNN1u16ajo0CRL8lCa98DspHPf+BZkBjONMriXNiVHXd9TjM0aZXEubEqOu76nATMAAAAAAAAAAAAAAAAAxnGzAxnAaZXEubEqOu76nEM8pp2feZelEzXEubEqOu76nEM8pp2feZelAUzAAABplcS5sSo67vqcZmjTK4lzYlR13fU4CGeU07PvMvSiGbiXOdVHXdyTiZuU07PvMvSiGbiXOdVHXdyTgNMhjONmBjOA0yuJc2JUdd31OOMu52Wr20q868qYrVs6vVvraBDR0lXg+qea98B+R7nY/sOzuJc2JUdd31OJmAUAYky1e2LNPmhpjS5isJU5mpq/L62glNDTIEiBH+mgPPSHPSJUZvRNK6J5XEIUpLM4UbCdOdky3ghdtZsS3alvqAZmgJmwXG7aDbWkXGEZrsq0+qWs8rVlZpDUJ2kcFYk9KYkgjMNPN6RhSmleacaXEUuXvGvwzNu2s51btS3JAA4xmTLV7aVaF5UxWrZ1FW+toENHSRwfVPNe+A/I9zsf2EzMSZavbFmnzQ0xpcxWEqczU1fl9bQSmhpkCRAj/AE0B56Q56RKjN6JpXRPK4hClJ2fJl9oPlvqhM121mxLdqW+oADCjYTpzsmW8ETMMZxswAAAAIZu2s2JbtS31AMzRpldtZsS3alvqAZmgAk1SWCNYXRWJIsysqpX5plkdXlFoSVHHAecYd0T0hDiOONOJjITJ3CMhplcS5sSo67vqcBQBprLV7ZrZ9+sxWVaNLVOtoE1JRwR/SPOc6MzK578X3HZ3Euc6qOu7knEzcpp2feZelEM3Euc6qOu7knAaZDGcbMDGcBea5cb2ydS2Eq6rKzLXUJ2kdarEns+VJII5UlPN6RiMppXmnGlxFLl7xGV3O1JRGlXnXlT7atnV6t9UToaOkq8H1TDXvgPyPc7H9hWYAEm3Li0zEpbdldWZZpdUJpkdarEooj0kEclSmG9EwhTivOONJiIXL3C8uFGwnTnZMt4IzNABM2C43bQba0i4wvNcuKtPqlsJV1WVmkNQnaR1qsSelMSQRypKeb0jClNK8040uIpcveJMABTPlNOz7zL0ohm4lznVR13ck4mblNOz7zL0ohm4lznVR13ck4DTIYzjZgYzgAAACZriXOdVHXdyTjTIZm3Euc6qOu7knGmQDGcaZXEubEqOu76nGZo0yuJc2JUdd31OAmYAAAAAAAAAAAAAAAABjONmBjOA0yuJc2JUdd31OIZ5TTs+8y9KJmuJc2JUdd31OOzaay1RGlWffrMVq2dS1TradDR0kEf0jzXvgMyvc7F9wGTQDTLBcYToNtaW8YMFxhOg21pbxgGZo0yuJc2JUdd31OGC4wnQba0t4wk1SVWmJS1YkisqzIahNMjjq8npT0kEZ5x53SPKU4rzjji4yly9wCpnKadn3mXpRDNxLnOqjru5JxM3Kadn3mXpRDNxLnOqjru5JwGmQxnGzAxnABczky+0Hy31QpmOzZk1Je2a2heVPtlWjRVvqiBNSUccH1TDnOjPyOe/H9gGsoCjVy43trC6N2V1WVmWuvzTLK1WJPZ8lRxwSVKeb0jEZDiOONNLiKTJ3C8oAMzbtrOdW7UtyQDTIZm3bWc6t2pbkgAQyJmuJc51Udd3JOOzuGGWqI0q/G/WYrVs6o1TradDR0lYj+kea98BmV7nYvuLZqSwRk6lrPJFmVlVKhO0jjq8otCVJIIzDjDuiekKaV5pxxMZC5e8BJgAAAKZ8pp2feZelFzBTPlNOz7zL0oCmYCTblxVpiXRuyuqys0hr80yytViT0p6OOCSpTzekYUhxHHGmlxFJk7heXBcYToNtaW8YBmaAC81y4wRk66MJV1ZlmVSvztLK1WJRaEqRxwSpKYb0TEhDSONNNJiITJ3gPF5MvtB8t9UJmu2s2JbtS31AOzZky1RGa2heVMVlWjRVvradNSUccH1TznOjPyOe/H9h7S7KtMS6KxK1ZWaQ1+aZZBWJPSno44DzTzekYUhxHHGmlxFJk7gGQADTLBcYToNtaW8YMFxhOg21pbxgC4lzYlR13fU4mYUAba1Je2LNPndmbNJ9sJU5moahIKoglNDTIEadJ+onMPSHPSJUh3SOK6JxHEIQhJmuGGpL20q/G/WfbVs6o1TqiBDR0lYj+kYa98BmV7nYvuAsyAjO6jWmfVLYSsSzKzLqhO0jqtXlFEYkgjlSIw7onkKaV5pxxMZC5e8UZwo27ac7JkXBAQyNMriXNiVHXd9TjM0aZXEubEqOu76nAQzymnZ95l6UQzcS5zqo67uScTNymnZ95l6UQzcS5zqo67uScBpkMZxswIZwXGE6DbWlvGAZmgNMsFxhOg21pbxgwXGE6DbWlvGAUzuJc51Udd3JONMhGaksEZOpazyRZlZVSoTtI46vKLQlSSCMw4w7onpCmleaccTGQuXvEmAMZxplcS5sSo67vqcZmjTK4lzYlR13fU4CZgAAAAAAAAAAAAAAAAGM42YGZuC43bQba0i4wDs2JXVvNqzCaFKvCtWzqbrdr0NJSJ0iX5KE5zo3ZSvc/8AA7PDn8Ltv+3EM4LjdtBtrSLjBguN20G2tIuMAmbDn8Ltv+3DDn8Ltv8AtxDOC43bQba0i4wYLjdtBtrSLjAJmw5/C7b/ALcMOfwu2/7cQzguN20G2tIuMGC43bQba0i4wBdNN056b3/hawrGrP7hWaamov4zIXUX5fF9nY1xLnOqjru5JwwXG7aDbWkXGEm3LjBGsKW3ZXVmWZVKhNMjrVYlFoSVJBHJUphvRMSFOK8440mIhcvcAvKMZxswMZwFmWJXKXOUzCaF1v8AbKtGm6pZFNR0adIi+emNe+B+Qjnu/I4y6aYXzLXv/FNu2zWf2+rUNDRfyHxPpfw6H7vxXMuJc2JUdd31OOMu52Wr20q868qYrVs6vVvraBDR0lXg+qea98B+R7nY/sArNcS5zqo67uScaZCgDEmWr2xZp80NMaXMVhKnM1NX5fW0EpoaZAkQI/00B56Q56RKjN6JpXRPK4hClJZnCjYTpzsmW8EBDOHP4Xbf9uHMXhKf1rvpvVvj/arPrtXq/VfrUiOOKgj+QjonY3PLDOC43bQba0i4wvNcuKtPqlsJV1WVmkNQnaR1qsSelMSQRypKeb0jClNK8040uIpcveAr/mXf97vx8tqlT/8AakjrX/F0H3fi7NiV1bzlNPmhSrwrKtGm63a9NR0aBIl+ShNe+B2Ujnv/AAOM5TTs+8y9KIAuXFpmJS27K6syzS6oTTI61WJRRHpII5KlMN6JhCnFeccaTEQuXuAalimeHP4Xbf8AbiZsKNhOnOyZbwRTPBcbtoNtaRcYBf8AYkvXOUzCaF1suyrRpuqVimo6NOkRfPCa98D8hHPd+RWblNOz7zL0osBcuKtPqlsJV1WVmkNQnaR1qsSelMSQRypKeb0jClNK8040uIpcveIyu52Wr20q868qYrVs6vVvraBDR0lXg+qea98B+R7nY/sArNcS5zqo67uScaZCjVy4wRrClt2V1ZlmVSoTTI61WJRaElSQRyVKYb0TEhTivOONJiIXL3C8oDGcaZXEubEqOu76nFM8Fxu2g21pFxhZliTUlEYszCaGZtLn2wlsmamr8gqieU0NMnSJ0f6iAw9Gc9GlRndE4ronFcUhSEDs7ppunMte/wDC1u2zWf3CrUNDRfxnxPpfw6H7vxcYxK6t5ymnzQpV4VlWjTdbtemo6NAkS/JQmvfA7KRz3/gcZdNf3KXv8ynxVe5WbV/0qvWKKh/yaOOKgS/K90ONzyP8a5cYI1hS27K6syzKpUJpkdarEotCSpII5KlMN6JiQpxXnHGkxELl7gF5RTPDn8Ltv+3FzBmbguN20G2tIuMAmbmLwlP61303q3x/tVn12r1fqv1qRHHFQR/IR0TsbnlZl3/e78fLapU//akjrX/F0H3fisBcuKtPqlsJV1WVmkNQnaR1qsSelMSQRypKeb0jClNK8040uIpcveK/8pp2feZelAOfTCU/opeterfH+62hXavV+tfRo0ccVBB85HRPxucVgMeKOwPcCGbiXOdVHXdyTjTIBjONMriXNiVHXd9TjM0aZXEubEqOu76nAQzymnZ95l6UVmYkvXNq0+aF1su1bOpuqVihpKRAkRfPCc50b8hXud+Rcy7nZavbSrzrypitWzq9W+toENHSVeD6p5r3wH5Hudj+wrNguN20G2tIuMAmbDn8Ltv+3DDn8Ltv+3EM4LjdtBtrSLjBguN20G2tIuMAmbDn8Ltv+3DDn8Ltv+3EM4LjdtBtrSLjBguN20G2tIuMAmbDn8Ltv+3DDn8Ltv8AtxDOC43bQba0i4wYLjdtBtrSLjAIZGmVxLmxKjru+pxTPBcbtoNtaRcYXmuXFWn1S2Eq6rKzSGoTtI61WJPSmJII5UlPN6RhSmleacaXEUuXvASYAAAAAAAAAAAAAAAAAAMZwGzACGbiXNiVHXd9TiGeU07PvMvSgLmAMZwAbMAMZwAbMAMZxM1xLnOqjru5JwGmQxnGzAAIZuJc2JUdd31OJmAAEM3bWbEt2pb6gGZo0yu2s2JbtS31AMzQGzAAMzbtrOdW7UtyQAJm5TTs+8y9KKZi5nJl9oPlvqhM121mxLdqW+oAGZo2YGM42YAAAUz5TTs+8y9KAuYAzNuJc51Udd3JONMgAZm3bWc6t2pbkgEMjTK4lzYlR13fU4CGeTL7QfLfVC5gpnymnZ95l6UUzAbMAMZxswACmfKadn3mXpRcwUz5TTs+8y9KAhm4lznVR13ck40yGM4AA0yuJc2JUdd31OMzRplcS5sSo67vqcBMwCmfKadn3mXpRTMBswAxnABswAxnABswAzNuJc51Udd3JONMgAAAAAAAAAAAAAAAAAAAAAQzguMJ0G2tLeMJmFM8Ofwu2/7cBbNSVWmJS1YkisqzIahNMjjq8npT0kEZ5x53SPKU4rzjji4yly9wqZymnZ95l6UWZYkvXOUzCaF1suyrRpuqVimo6NOkRfPCa98D8hHPd+RWblNOz7zL0oCmYDs2JKLzlNPmhSrUsq0abrdXpqOjQJEvyRGvfA7KRz3/AIFmcBjxR2B7gBM2C4wnQba0t4wYLjCdBtrS3jCGcOfwu2/7cWZYkvXOUzCaF1suyrRpuqVimo6NOkRfPCa98D8hHPd+QHGYLjCdBtrS3jD2lJYIydS1nkizKyqlQnaRx1eUWhKkkEZhxh3RPSFNK8044mMhcvePFumm6cy17/wtbts1n9wq1DQ0X8Z8T6X8Oh+78XGMSurecpp80KVeFZVo03W7XpqOjQJEvyUJr3wOykc9/wCAFmRmbhRt2052TIuCNMhjOAmbCjbtpzsmRcEMKNu2nOyZFwR2bErlLnKZhNC63+2VaNN1SyKajo06RF89Ma98D8hHPd+R2eAx4o7A9wA4xiTUl7bS0+aGZtLn23VTnmmr8gqiCTU1CgSJ0f6iAwxIa5IiRndE4j4XFeQpSFszguMJ0G2tLeMOMYlcpc2rT5oXW/21bOpuqWRQ0lIgSIvnpjnOjfkK9zvyLMgMzcKNu2nOyZFwRGa7LTPq6LPK1mWaXV+dpZBWJRRGI44DDTDeiYQhpHGmmkxEJk7x4osyxK5S5ymYTQut/tlWjTdUsimo6NOkRfPTGvfA/IRz3fkBDLMmpL2zW0Lyp9sq0aKt9UQJqSjjg+qYc50Z+Rz34/sPaXZvbWF0ViVqysy11+aZZBWJPZ8lRxwHmnm9IxGQ4jjjTS4ikydwn/AY8Udge4DAY8Udge4AUzEzYUbdtOdkyLgiZsBjxR2B7gMBjxR2B7gBYC5cWmfV0YSrqzLNLq/O0srVYlFEYjjglSUw3omEIaRxpppMRCZO8ey01lqiNKs+/WYrVs6lqnW06GjpII/pHmvfAZle52L7gxJRebVmE0KValq2dTdbq9DSUidIl+SI5zo3ZSvc/wDA7MBGaksEZOpazyRZlZVSoTtI46vKLQlSSCMw4w7onpCmleaccTGQuXvEmAACGcFxhOg21pbxhWZtrUl7Ys0+d2Zs0n2wlTmahqEgqiCU0NMgRp0n6icw9Ic9IlSHdI4ronEcQhCE7PDn8Ltv+3DmLwlP61303q3x/tVn12r1fqv1qRHHFQR/IR0TsbnlBcy/3KXwc9fxVe5VrK/0qvWKWm/xqOOKgRfM90OJzyv9q6jYIydS2ErEsysqpUJ2kdVq8otCVJII5UiMO6J6QppXmnHExkLl7x4uZd/3u/Hy2qVP/wBqSOtf8XQfd+Jz6YSn9FL1r1b4/wB1tCu1er9a+jRo44qCD5yOifjc4oUzGzApngMeKOwPcC5gCjV1G3trClt2WJWVZWuoTTI6rV5PZ8lSQRyVEed0j0ZTivOOOLjKXL3Cv7TWpL20qz79Z9tWzqWqdUQIaOkgj+kYa98BmV7nYvuOzu2s51btS3JAIZASbcuKtMS6N2V1WVmkNfmmWVqsSelPRxwSVKeb0jCkOI4400uIpMncLy4LjCdBtrS3jCgDEl65tWnzQutl2rZ1N1SsUNJSIEiL54TnOjfkK9zvyLM4c/hdt/24CZsFxhOg21pbxhJqkqtMSlqxJFZVmQ1CaZHHV5PSnpIIzzjzukeUpxXnHHFxlLl7h7IrM226t5tWnzupV4Vq2dQ9btehpKRAjS/JQnOdG7KV7n/gBMzTWWqI0qz79ZitWzqWqdbToaOkgj+kea98BmV7nYvuIAuo2CMnUthKxLMrKqVCdpHVavKLQlSSCOVIjDuiekKaV5pxxMZC5e8eLhz+F23/AG44xtt1bzlMwndSrwrKtGh63a9NR0adGl+ShNe+B2Ujnv8AwArMNMsFxhOg21pbxhmaNmAEM4LjCdBtrS3jCs13Oy1RGa3nXlTFZVo16t9bTpqSjq8H1TznOjPyOe/H9hf8QzdNML56b3/imwrGrP7fWaamov5DIXUX5fF9nYwznUlaZ9UtZ5Isysy6oTtI46vKKIxJBGYcYd0TyFNK8044mMhcveJMwo27ac7JkXBHZttuUubVmE7rrf7atnUPVLIoaSkTo0Xz0xznRvyFe535FZgGzACmeHP4Xbf9uLMsSXrnKZhNC62XZVo03VKxTUdGnSIvnhNe+B+Qjnu/IDswAAAAAAAAAAAAAAAAGZuC43bQba0i4w0yABGdy4q0+qWwlXVZWaQ1CdpHWqxJ6UxJBHKkp5vSMKU0rzTjS4ily94r/wApp2feZelFzBTPlNOz7zL0oCALlxaZiUtuyurMs0uqE0yOtViUUR6SCOSpTDeiYQpxXnHGkxELl7heXCjYTpzsmW8EZmgAC81y43tk6lsJV1WVmWuoTtI61WJPZ8qSQRypKeb0jEZTSvNONLiKXL3ijIALmXTX9yl7/Mp8VXuVm1f9Kr1iiof8mjjioEvyvdDjc8j/ABrlxgjWFLbsrqzLMqlQmmR1qsSi0JKkgjkqUw3omJCnFeccaTEQuXuHs8mX2g+W+qFzAAZm4LjdtBtrSLjDTIAEZ3LirT6pbCVdVlZpDUJ2kdarEnpTEkEcqSnm9IwpTSvNONLiKXL3iTAAB4y7LTMSlqxK1mWaXVCaZHBWJRRHpIIzzTDeiYQpxXnHGkxELl7hGWFGwnTnZMt4IXbWbEt2pb6gGZoCZsFxu2g21pFxhea5cVafVLYSrqsrNIahO0jrVYk9KYkgjlSU83pGFKaV5pxpcRS5e8SYADjGmtSURmtn36z7ZVo0tU6onTUlHBH9Iw5zozMrnvxfceMpLe2Tros8kVlWVrr87SyOryez5UjjgMOPO6R6MhpHGmnFxlJk7xX/AJTTs+8y9KIZuJc51Udd3JOA0yEM4UbCdOdky3giZhjOA1/UlaZiXRWJIsysy6vzTLI6vKKI9HHAecYd0TyEOI4404mMhMncPFaa1JRGa2ffrPtlWjS1TqidNSUcEf0jDnOjMyue/F9xxlxLmxKjru+pxDPKadn3mXpQFgFJb2yddFnkisqytdfnaWR1eT2fKkccBhx53SPRkNI4004uMpMneJMGZtxLnOqjru5JxpkAzNwXG7aDbWkXGFmWJNSURizMJoZm0ufbCWyZqavyCqJ5TQ0ydInR/qIDD0Zz0aVGd0TiuicVxSFISzIzNu2s51btS3JAAma6a/uUvf5lPiq9ys2r/pVesUVD/k0ccVAl+V7ocbnkfxjEmWr2xZp80NMaXMVhKnM1NX5fW0EpoaZAkQI/00B56Q56RKjN6JpXRPK4hClJ2fJl9oPlvqhM121mxLdqW+oADCjYTpzsmW8ETMMZxswAo1dRsEawujdliWZWVUr80yyq1eUWhJUccElRGHdE9IQ4jjjTiYyEydwr+01lq9s1s+/WYrKtGlqnW0Cako4I/pHnOdGZlc9+L7jWUUz5TTs+8y9KAqapKrT6uizyRWVZkNfnaWR1eT0piOOAw487pHlIaRxppxcZSZO8SZguN20G2tIuMFxLnOqjru5JxpkACjV1GwRrC6N2WJZlZVSvzTLKrV5RaElRxwSVEYd0T0hDiOONOJjITJ3C8oAMmmmstXtmtn36zFZVo0tU62gTUlHBH9I85zozMrnvxfceMpKrT6uizyRWVZkNfnaWR1eT0piOOAw487pHlIaRxppxcZSZO8Wy5TTs+8y9KIZuJc51Udd3JOAYLjdtBtrSLjC5mFGwnTnZMt4ImYYzgNMsKNhOnOyZbwR2bMmpKI0q0Lyp9tWzqKt9UToaOkjg+qYa98B+R7nY/sMmhczky+0Hy31QCwF1Gq0+rowlYlZVmQ1+dpZVavJ6UxHHBKkR53SPKQ0jjTTi4ykyd4ozguN20G2tIuMNMgAYzjTK4lzYlR13fU4zNGmVxLmxKjru+pwEzAAAAAAAAAAAAAAAAAADM3CjbtpzsmRcEBpkKZ8pp2feZelEM4UbdtOdkyLgiZrmX+5S+Dnr+Kr3KtZX+lV6xS03+NRxxUCL5nuhxOeV4QzcS5zqo67uScaZCM1JYIydS1nkizKyqlQnaRx1eUWhKkkEZhxh3RPSFNK8044mMhcveJMAYzgNMsFxhOg21pbxhRq6jVaYlLbssSsqzIahNMjqtXk9KekgjkqI87pHlKcV5xxxcZS5e4BGQma4lznVR13ck47O4YZaojSr8b9ZitWzqjVOtp0NHSViP6R5r3wGZXudi+4mZtrLVEYszCd2mM0mKwlsmahqEvraeU0NMnRoEn6ac89Gc9GlSG9I0ronkcUhCkCzIxnEzYUbdtOdkyLgiGQGmVxLmxKjru+pxMwhm4lzYlR13fU44y7nakvbNbzryp9sq0a9W+qIE1JR1eD6phznRn5HPfj+wCzICjVy43trC6N2V1WVmWuvzTLK1WJPZ8lRxwSVKeb0jEZDiOONNLiKTJ3C8oDGcBplguMJ0G2tLeMKNXUarTEpbdliVlWZDUJpkdVq8npT0kEclRHndI8pTivOOOLjKXL3AIyEzXEuc6qOu7knEMiZriXOdVHXdyTgNMgAZm4UbdtOdkyLggF21nOrdqW5IBM3Jl9oPlvqhU1dlpn1dFnlazLNLq/O0sgrEoojEccBhphvRMIQ0jjTTSYiEyd4tlyZfaD5b6oBcwBGd1GtM+qWwlYlmVmXVCdpHVavKKIxJBHKkRh3RPIU0rzTjiYyFy94ozhRt2052TIuCAhkaZXEubEqOu76nDBcYToNtaW8YVmba1Je2LNPndmbNJ9sJU5moahIKoglNDTIEadJ+onMPSHPSJUh3SOK6JxHEIQhA7PlNOz7zL0opmLmXMv9yl8HPX8VXuVayv8ASq9Ypab/ABqOOKgRfM90OJzyv9q6jYIydS2ErEsysqpUJ2kdVq8otCVJII5UiMO6J6QppXmnHExkLl7wFGQAaZYLjCdBtrS3jAMzQGmWC4wnQba0t4wYLjCdBtrS3jAMzQGmWC4wnQba0t4wYLjCdBtrS3jAJmGZt21nOrdqW5IAwo27ac7JkXBEZrstM+ros8rWZZpdX52lkFYlFEYjjgMNMN6JhCGkcaaaTEQmTvAeKJmuJc51Udd3JOOzuGGWqI0q/G/WYrVs6o1TradDR0lYj+kea98BmV7nYvuJmbay1RGLMwndpjNJisJbJmoahL62nlNDTJ0aBJ+mnPPRnPRpUhvSNK6J5HFIQpAsyMZxM2FG3bTnZMi4IuZguMJ0G2tLeMAXEubEqOu76nEM8pp2feZelFs1JVaYlLViSKyrMhqE0yOOryelPSQRnnHndI8pTivOOOLjKXL3DxWmstURpVn36zFatnUtU62nQ0dJBH9I8174DMr3OxfcBk0A0ywXGE6DbWlvGDBcYToNtaW8YBmaNMriXNiVHXd9TjM0aZXEubEqOu76nATMAAAAAAAAAAAAAAAAAxnGzAzNwXG7aDbWkXGAQyJmuZW6cy18Hwtbts1b9wq1DQ0v8Z8T6X8Oh+78TBcbtoNtaRcYMFxu2g21pFxgFmWJXVvOU0+aFKvCsq0abrdr01HRoEiX5KE174HZSOe/8CzIo1cuMEawpbdldWZZlUqE0yOtViUWhJUkEclSmG9ExIU4rzjjSYiFy9wvKApnhz+F23/bhzF4Sn9a76b1b4/2qz67V6v1X61IjjioI/kI6J2Nzy0zGmVxLmxKjru+pwEM5l3/AHu/Hy2qVP8A9qSOtf8AF0H3fic+mEp/RS9a9W+P91tCu1er9a+jRo44qCD5yOifjc4vZ3c7LV7aVedeVMVq2dXq31tAho6SrwfVPNe+A/I9zsf2EMsSZavbFmnzQ0xpcxWEqczU1fl9bQSmhpkCRAj/AE0B56Q56RKjN6JpXRPK4hClIHZ4DHijsD3ApmNMsKNhOnOyZbwRTPBcbtoNtaRcYBcy4lzYlR13fU4hnlNOz7zL0osBcuKtPqlsJV1WVmkNQnaR1qsSelMSQRypKeb0jClNK8040uIpcveK/wDKadn3mXpQFZmJL1zatPmhdbLtWzqbqlYoaSkQJEXzwnOdG/IV7nfkWZw5/C7b/txTMAFzMOfwu2/7cVmbavXOU0+d11suyrRoeqVimo6NAjRfPCa98D8hHPd+Rxgk1SWCNYXRWJIsysqpX5plkdXlFoSVHHAecYd0T0hDiOONOJjITJ3APZuZWF89N8HxTYVjVb9vrNNTUv8AIZC6i/L4vs7HM3MXg1/1rvpvqvc/arPqVYrHVfrUiSCGnj+Qr4XYnvIuZf7a74Oev4Vvjq1lf7tYq9LTf41JBDTovmc+LE9xXdm21qSiNpZhO7M2aT7bq2TzQ1CQVRPJqahTo06T9ROYYjNcjRJDukcR8LiPKUhChxmHP4Xbf9uKZiZsFxu2g21pFxhDIALmcmX2g+W+qFMxZm4YakojNb8b9Z9sq0ajVOqJ01JR1iP6RhznRmZXPfi+4C5jbVF5ymYTupVqWVaND1ur01HRp0aX5IjXvgdlI57/AMCs2Ax4o7A9wJmwo2E6c7JlvBDCjYTpzsmW8EBDOHP4Xbf9uKzNtXrnKafO662XZVo0PVKxTUdGgRovnhNe+B+Qjnu/I4wAEzXMrdOZa+D4Wt22at+4VahoaX+M+J9L+HQ/d+KZufTCU/opeterfH+62hXavV+tfRo0ccVBB85HRPxucWmYk25cWmYlLbsrqzLNLqhNMjrVYlFEekgjkqUw3omEKcV5xxpMRC5e4BP+Ax4o7A9wLmCGcKNhOnOyZbwRMwCszbbq3m1afO6lXhWrZ1D1u16GkpECNL8lCc50bspXuf8Agdncyt056b4PhawrGq37hWaampf4zIXUX5fF9nY4Auo2CNYXRuyxLMrKqV+aZZVavKLQkqOOCSojDuiekIcRxxpxMZCZO4ezcy/213wc9fwrfHVrK/3axV6Wm/xqSCGnRfM58WJ7iuCzLbV65tWYTuutl2rZ1D1SsUNJSJ0aL54TnOjfkK9zvyKzYc/hdt/247NtrUlEbSzCd2Zs0n23VsnmhqEgqieTU1CnRp0n6icwxGa5GiSHdI4j4XEeUpCFrNguN20G2tIuMAmbAY8Udge4DAY8Udge4EzYUbCdOdky3ghhRsJ052TLeCAhnMu/73fj5bVKn/7Ukda/4ug+78XGNturecpmE7qVeFZVo0PW7XpqOjTo0vyUJr3wOykc9/4C7nakojSrzryp9tWzq9W+qJ0NHSVeD6phr3wH5Hudj+wrMAC5mHP4Xbf9uKZgAuZhz+F23/biZrmVunPTfB8LWFY1W/cKzTU1L/GZC6i/L4vs7HRpSWCNYXRWJIsysqpX5plkdXlFoSVHHAecYd0T0hDiOONOJjITJ3C2Vwwy1e2a3436zFZVo1GqdbQJqSjrEf0jznOjMyue/F9wEzNtXrm1ZhO662XatnUPVKxQ0lInRovnhOc6N+Qr3O/IrNhz+F23/biZrtrNiW7Ut9QDM0AGmVxLmxKjru+pxmaNMriXNiVHXd9TgJmAAAAAAAAAAAAAAAAAAGM4DZgBjOADZgBmbcS5zqo67uScaZAMZxplcS5sSo67vqcTMAAIZu2s2JbtS31AIZ5TTs+8y9KKZgA2YGM4ANmBTPlNOz7zL0oma4lzYlR13fU4mYBjOA2YABjONMriXNiVHXd9TjM0aZXEubEqOu76nAQzymnZ95l6UQzcS5zqo67uScTNymnZ95l6UQzcS5zqo67uScBpkMZxswMZwABplcS5sSo67vqcTMAxnAaZXbWbEt2pb6gGZoAA2YABjOAuZymnZ95l6UUzABswMZwAbMCmfKadn3mXpRTMAEzXEuc6qOu7knGmQzNuJc51Udd3JONMgGM4ANMriXNiVHXd9TgMzQFzOU07PvMvSiGbiXOdVHXdyTgIZAbMDGcBplcS5sSo67vqcTMIZuJc2JUdd31OIZ5TTs+8y9KAma7azYlu1LfUAzNEzXEuc6qOu7knGmQDGcaZXEubEqOu76nGZo0yuJc2JUdd31OAmYAAAAAAAAAAAAAAAABDOC4wnQba0t4wmYUzw5/C7b/twEzYLjCdBtrS3jCs13Oy1RGa3nXlTFZVo16t9bTpqSjq8H1TznOjPyOe/H9hcxiS9c5TMJoXWy7KtGm6pWKajo06RF88Jr3wPyEc935FZuU07PvMvSgKmqStM+qWs8kWZWZdUJ2kcdXlFEYkgjMOMO6J5CmleaccTGQuXvEmYUbdtOdkyLgiGQAbMCjV1G3trClt2WJWVZWuoTTI6rV5PZ8lSQRyVEed0j0ZTivOOOLjKXL3D2cOfwu2/wC3DmLwlP61303q3x/tVn12r1fqv1qRHHFQR/IR0TsbnlBcy/3KXwc9fxVe5VrK/wBKr1ilpv8AGo44qBF8z3Q4nPK+ZsFxhOg21pbxhDOZd/3u/Hy2qVP/ANqSOtf8XQfd+Jhz+F23/bgJmwXGE6DbWlvGGZouZhz+F23/AG4pmAk1SW9tYUtWJIrKsrXUJpkcdXk9nyVJBGeced0j0ZTivOOOLjKXL3C2Vww1Je2lX436z7atnVGqdUQIaOkrEf0jDXvgMyvc7F9xDLErlLnKZhNC63+2VaNN1SyKajo06RF89Ma98D8hHPd+RZm5lYXzLXwfFNu2zVv2+rUNDS/yHxPpfw6H7vxBMwDjG2r1zaswnddbLtWzqHqlYoaSkTo0XzwnOdG/IV7nfkVmw5/C7b/twFMxJqkt7awpasSRWVZWuoTTI46vJ7PkqSCM8487pHoynFecccXGUuXuE/4DHijsD3AYDHijsD3ABcy/3KXwc9fxVe5VrK/0qvWKWm/xqOOKgRfM90OJzyv7NtrLVEYszCd2mM0mKwlsmahqEvraeU0NMnRoEn6ac89Gc9GlSG9I0ronkcUhCk4zMu/73fj5bVKn/wC1JHWv+LoPu/Fxjbbq3nKZhO6lXhWVaND1u16ajo06NL8lCa98DspHPf8AgBxmFG3bTnZMi4IuZguMJ0G2tLeMMzRczDn8Ltv+3AcY21qS9sWafO7M2aT7YSpzNQ1CQVRBKaGmQI06T9ROYekOekSpDukcV0TiOIQhCcZhRt2052TIuCOMbavXOU0+d11suyrRoeqVimo6NAjRfPCa98D8hHPd+RxgCzLEmpL22lp80MzaXPtuqnPNNX5BVEEmpqFAkTo/1EBhiQ1yREjO6JxHwuK8hSkLZnBcYToNtaW8YUAYkvXNq0+aF1su1bOpuqVihpKRAkRfPCc50b8hXud+RZnDn8Ltv+3AQzhRt2052TIuCLzXLi0z6ujCVdWZZpdX52llarEoojEccEqSmG9EwhDSONNNJiITJ3iv+Ax4o7A9wHPpg1/0UvWvqvc/dbQqVYrHWvo0aSCGng+cr4X4nuIDlNOz7zL0opmLmZ6P/RLzvMq3XP8Axo4Kr/yfH9nY2Ax4o7A9wApmAuZgMeKOwPcCmYC81y4wRk66MJV1ZlmVSvztLK1WJRaEqRxwSpKYb0TEhDSONNNJiITJ3iMrudlqiM1vOvKmKyrRr1b62nTUlHV4PqnnOdGfkc9+P7AxK6t5tWYTQpV4Vq2dTdbtehpKROkS/JQnOdG7KV7n/gcZdNN056b3/hawrGrP7hWaamov4zIXUX5fF9nYwXEuc6qOu7knGmQyaYkvXNq0+aF1su1bOpuqVihpKRAkRfPCc50b8hXud+RZnDn8Ltv+3ATNguMJ0G2tLeMKzNtakvbFmnzuzNmk+2EqczUNQkFUQSmhpkCNOk/UTmHpDnpEqQ7pHFdE4jiEIQnZ4c/hdt/24cxeEp/Wu+m9W+P9qs+u1er9V+tSI44qCP5COidjc8oLmX+5S+Dnr+Kr3KtZX+lV6xS03+NRxxUCL5nuhxOeV/ZttZaojFmYTu0xmkxWEtkzUNQl9bTymhpk6NAk/TTnnozno0qQ3pGldE8jikIUnGZl3/e78fLapU//AGpI61/xdB934nPphKf0UvWvVvj/AHW0K7V6v1r6NGjjioIPnI6J+NzihDOFG3bTnZMi4IuZguMJ0G2tLeMIZwGPFHYHuAw5/C7b/twHGNtakvbFmnzuzNmk+2EqczUNQkFUQSmhpkCNOk/UTmHpDnpEqQ7pHFdE4jiEIQnZ3Mv9yl8HPX8VXuVayv8ASq9Ypab/ABqOOKgRfM90OJzyvrM21eucpp87rrZdlWjQ9UrFNR0aBGi+eE174H5COe78izPJl9oPlvqgHZttZaojFmYTu0xmkxWEtkzUNQl9bTymhpk6NAk/TTnnozno0qQ3pGldE8jikIUlZsKNu2nOyZFwRcy7azYlu1LfUAzNAaZYLjCdBtrS3jCTVJVaYlLViSKyrMhqE0yOOryelPSQRnnHndI8pTivOOOLjKXL3CpmHP4Xbf8AbizLEl65ymYTQutl2VaNN1SsU1HRp0iL54TXvgfkI57vyA7MAAAAAAAAAAAAAAAABjONmBjOA0yuJc2JUdd31OIZ5TTs+8y9KJmuJc2JUdd31OIZ5TTs+8y9KApmAAAmbBcbtoNtaRcYWZYk1JRGLMwmhmbS59sJbJmpq/IKonlNDTJ0idH+ogMPRnPRpUZ3ROK6JxXFIUhLMjM27aznVu1LckACZrpr+5S9/mU+Kr3Kzav+lV6xRUP+TRxxUCX5XuhxueR8ALswRrClqxK1mWZVKhNMjgrEotCSpIIzzTDeiYkKcV5xxpMRC5e4T/yZfaD5b6oTNdtZsS3alvqABmaAAAvNcuN7ZOpbCVdVlZlrqE7SOtViT2fKkkEcqSnm9IxGU0rzTjS4ily94n9mTUlEaVaF5U+2rZ1FW+qJ0NHSRwfVMNe+A/I9zsf2GTQuZyZfaD5b6oBM121mxLdqW+oBmaNMrtrNiW7Ut9QDM0BswIzXZvbJ1LWeVqysy11CdpHBWJPZ8qSQRmGnm9IxGU0rzTjS4ily94kwZm3bWc6t2pbkgAdndztSURpV515U+2rZ1erfVE6GjpKvB9Uw174D8j3Ox/YVmAAATNguN20G2tIuMIZGzADM3BcbtoNtaRcYcY01lq9s1s+/WYrKtGlqnW0Cako4I/pHnOdGZlc9+L7jWUUz5TTs+8y9KApmAAA0ywo2E6c7JlvBFGrqNaZiXRuyxLMrMur80yyq1eUUR6OOCSojDuieQhxHHGnExkJk7hGQALM3DDUlEZrfjfrPtlWjUap1ROmpKOsR/SMOc6MzK578X3Fs1Jb2yddFnkisqytdfnaWR1eT2fKkccBhx53SPRkNI4004uMpMneMsxM1xLnOqjru5JwGmQzNwXG7aDbWkXGGmQAMzcFxu2g21pFxhxjTWWr2zWz79Zisq0aWqdbQJqSjgj+kec50ZmVz34vuNZRTPlNOz7zL0oCmYAACZsFxu2g21pFxhea5cVafVLYSrqsrNIahO0jrVYk9KYkgjlSU83pGFKaV5pxpcRS5e8SYACs13Oy1e2lXnXlTFatnV6t9bQIaOkq8H1TzXvgPyPc7H9hGdy4wRrClt2V1ZlmVSoTTI61WJRaElSQRyVKYb0TEhTivOONJiIXL3C8oAAzNwXG7aDbWkXGGmQAMzcFxu2g21pFxhZm4YZavbNb8b9Zisq0ajVOtoE1JR1iP6R5znRmZXPfi+4syACM7qNVp9XRhKxKyrMhr87Syq1eT0piOOCVIjzukeUhpHGmnFxlJk7xRnBcbtoNtaRcYaZAAxnGmVxLmxKjru+pxmaNMriXNiVHXd9TgJmAAAAAAAAAAAAAAAAAYzjZgYzgNMriXNiVHXd9TiZhlopLe2sKWrEkVlWVrqE0yOOryez5KkgjPOPO6R6MpxXnHHFxlLl7hbK4YakvbSr8b9Z9tWzqjVOqIENHSViP6Rhr3wGZXudi+4CzIAAAMzbtrOdW7UtyQBhRt2052TIuCIzXZaZ9XRZ5WsyzS6vztLIKxKKIxHHAYaYb0TCENI4000mIhMneA8UBZm4YZaojSr8b9ZitWzqjVOtp0NHSViP6R5r3wGZXudi+4szguMJ0G2tLeMAzNGzAhnBcYToNtaW8YTMAzNu2s51btS3JAJm5MvtB8t9ULALswRk66LPK1mWZVK/O0sgrEotCVI44DDTDeiYkIaRxpppMRCZO8eyzJlqiM1tC8qYrKtGirfW06ako44PqnnOdGfkc9+P7AOMu2s2JbtS31AMzRr+uyrTEuisStWVmkNfmmWQViT0p6OOA8083pGFIcRxxppcRSZO4RlguMJ0G2tLeMAzNAaZYLjCdBtrS3jCjV1Gq0xKW3ZYlZVmQ1CaZHVavJ6U9JBHJUR53SPKU4rzjji4yly9wCf+TL7QfLfVCZrtrNiW7Ut9QCGeTL7QfLfVCZrtrNiW7Ut9QAMzQAAGmVxLmxKjru+pxMwhm4lzYlR13fU44y7nakvbNbzryp9sq0a9W+qIE1JR1eD6phznRn5HPfj+wDs7trNiW7Ut9QDM0Sauze2sLorErVlZlrr80yyCsSez5KjjgPNPN6RiMhxHHGmlxFJk7hGQDZgAFGrqNvbWFLbssSsqytdQmmR1Wryez5KkgjkqI87pHoynFecccXGUuXuAezymnZ95l6UQzcS5zqo67uScTNcy/3KXwc9fxVe5VrK/0qvWKWm/xqOOKgRfM90OJzyv7NtrLVEYszCd2mM0mKwlsmahqEvraeU0NMnRoEn6ac89Gc9GlSG9I0ronkcUhCkCzIxnEzYUbdtOdkyLgi5mC4wnQba0t4wDM0BplguMJ0G2tLeMGC4wnQba0t4wCmdxLnOqjru5JxpkIzUlgjJ1LWeSLMrKqVCdpHHV5RaEqSQRmHGHdE9IU0rzTjiYyFy94kwAGZt21nOrdqW5IBpkIzXZgjJ10WeVrMsyqV+dpZBWJRaEqRxwGGmG9ExIQ0jjTTSYiEyd4DLMTNcS5zqo67uScXMwXGE6DbWlvGHtKSwRk6lrPJFmVlVKhO0jjq8otCVJIIzDjDuiekKaV5pxxMZC5e8BJgxnGzAhnBcYToNtaW8YBmaLmcmX2g+W+qEAXUarTEpbdliVlWZDUJpkdVq8npT0kEclRHndI8pTivOOOLjKXL3Cf+TL7QfLfVALmAIzuo1pn1S2ErEsysy6oTtI6rV5RRGJII5UiMO6J5CmleaccTGQuXvFGcKNu2nOyZFwQGmQAAAAAAAAAAAAAAAAAAAAxnGzAzNwXG7aDbWkXGAQyJmuZW6cy18Hwtbts1b9wq1DQ0v8Z8T6X8Oh+78UZrsq0+qWs8rVlZpDUJ2kcFYk9KYkgjMNPN6RhSmleacaXEUuXvHssyZavbSrQvKmK1bOoq31tAho6SOD6p5r3wH5Hudj+wCzOHP4Xbf9uGHP4Xbf8AbiGcFxu2g21pFxgwXG7aDbWkXGAQyACTVJYI1hdFYkizKyqlfmmWR1eUWhJUccB5xh3RPSEOI4404mMhMncA9m5lbpzLXwfC1u2zVv3CrUNDS/xnxPpfw6H7vxWZYldW85TT5oUq8KyrRput2vTUdGgSJfkoTXvgdlI57/wKzYLjdtBtrSLjDs2JMtXtizT5oaY0uYrCVOZqavy+toJTQ0yBIgR/poDz0hz0iVGb0TSuieVxCFKQL/imeHP4Xbf9uJmwo2E6c7JlvBGZoDWViS9c5TMJoXWy7KtGm6pWKajo06RF88Jr3wPyEc935HGXTTdOZa9/4Wt22az+4VahoaL+M+J9L+HQ/d+KM7lxvbJ1LYSrqsrMtdQnaR1qsSez5UkgjlSU83pGIymleacaXEUuXvEZXc7UlEaVedeVPtq2dXq31ROho6SrwfVMNe+A/I9zsf2Adnhz+F23/bhhz+F23/bipqkqtPq6LPJFZVmQ1+dpZHV5PSmI44DDjzukeUhpHGmnFxlJk7xJmC43bQba0i4wCZsOfwu2/wC3FZm2r1zlNPnddbLsq0aHqlYpqOjQI0XzwmvfA/IRz3fkcYACZrmVunMtfB8LW7bNW/cKtQ0NL/GfE+l/Dofu/F2bbbq3nKZhO6lXhWVaND1u16ajo06NL8lCa98DspHPf+BWYe0pKrT6uizyRWVZkNfnaWR1eT0piOOAw487pHlIaRxppxcZSZO8B4ouZgMeKOwPcCGcFxu2g21pFxhczCjYTpzsmW8EB2bElF5tWYTQpVqWrZ1N1ur0NJSJ0iX5IjnOjdlK9z/wKzcpp2feZelFs1JWmYl0ViSLMrMur80yyOryiiPRxwHnGHdE8hDiOONOJjITJ3Cv93Oy1e2lXnXlTFatnV6t9bQIaOkq8H1TzXvgPyPc7H9gFM2JKLzlNPmhSrUsq0abrdXpqOjQJEvyRGvfA7KRz3/gWZwGPFHYHuB41y4wRrClt2V1ZlmVSoTTI61WJRaElSQRyVKYb0TEhTivOONJiIXL3C8oAKzNtuUucpp87rrf7ZVo0PVLIpqOjQI0Xz0xr3wPyEc935HZ4UbCdOdky3ghhRsJ052TLeCAhnMu/wC934+W1Sp/+1JHWv8Ai6D7vxOfTCU/opeterfH+62hXavV+tfRo0ccVBB85HRPxucVdNf3KXv8ynxVe5WbV/0qvWKKh/yaOOKgS/K90ONzyP4xiTLV7Ys0+aGmNLmKwlTmamr8vraCU0NMgSIEf6aA89Ic9IlRm9E0ronlcQhSkDs8BjxR2B7gXMEM4UbCdOdky3ghhRsJ052TLeCAmYQzdNN05lr3/ha3bZrP7hVqGhov4z4n0v4dD934pNUlaZiXRWJIsysy6vzTLI6vKKI9HHAecYd0TyEOI4404mMhMncKmcpp2feZelAMOfwu2/7cMOfwu2/7cUzABczDn8Ltv+3DDn8Ltv8AtxTMAFzMOfwu2/7cMOfwu2/7cUzABczDn8Ltv+3DDn8Ltv8AtxTMAHZttXrnKafO662XZVo0PVKxTUdGgRovnhNe+B+Qjnu/IszyZfaD5b6oQApLBGsLorEkWZWVUr80yyOryi0JKjjgPOMO6J6QhxHHGnExkJk7hbK4YZavbNb8b9Zisq0ajVOtoE1JR1iP6R5znRmZXPfi+4Ds7trNiW7Ut9QDM0amXUarT6ujCViVlWZDX52llVq8npTEccEqRHndI8pDSONNOLjKTJ3ijOC43bQba0i4wCZsOfwu2/7cWZYkvXOUzCaF1suyrRpuqVimo6NOkRfPCa98D8hHPd+RQDBcbtoNtaRcYXmuXFWn1S2Eq6rKzSGoTtI61WJPSmJII5UlPN6RhSmleacaXEUuXvASYAAAAAAAAAAAAAAAAAAADM27aznVu1LckAmbky+0Hy31QuYKZ8pp2feZelAXMAZm3Euc6qOu7knGmQDGcaZXEubEqOu76nEzDM27aznVu1LckADTIQzdtZsS3alvqAZmiZriXOdVHXdyTgIZAbMDGcAAAATNcS5zqo67uScaZDM24lznVR13ck40yAYzgNmBmbdtZzq3aluSABDIma4lznVR13ck4mbky+0Hy31QuYADGcbMAAhm4lzYlR13fU4mYBTPlNOz7zL0oC5gDM24lznVR13ck40yAYzgNmAAUz5MvtB8t9UJmu2s2JbtS31AIZ5TTs+8y9KIZuJc51Udd3JOAhkBswACGbiXNiVHXd9TiGeU07PvMvSiGbtrOdW7UtyQCGQAAAAAbMAAxnAXM5TTs+8y9KIZuJc51Udd3JOAhkBswACGbiXNiVHXd9TiZgFM+U07PvMvSgLmAMzbiXOdVHXdyTjTIAAYzjTK4lzYlR13fU4CZgAAAAAAAAAAAAAAAAGZuFG3bTnZMi4I0yGM4CZsKNu2nOyZFwRM1zL/AHKXwc9fxVe5VrK/0qvWKWm/xqOOKgRfM90OJzyv4xiVylzlMwmhdb/bKtGm6pZFNR0adIi+emNe+B+Qjnu/IszcysL5lr4Pim3bZq37fVqGhpf5D4n0v4dD934g4xtrLVEYszCd2mM0mKwlsmahqEvraeU0NMnRoEn6ac89Gc9GlSG9I0ronkcUhCkrNhRt2052TIuCLmXbWbEt2pb6gGZoCZsKNu2nOyZFwRGa7LTPq6LPK1mWaXV+dpZBWJRRGI44DDTDeiYQhpHGmmkxEJk7x4osyxK5S5ymYTQut/tlWjTdUsimo6NOkRfPTGvfA/IRz3fkAuGGWqI0q/G/WYrVs6o1TradDR0lYj+kea98BmV7nYvuLZqSwRk6lrPJFmVlVKhO0jjq8otCVJIIzDjDuiekKaV5pxxMZC5e8V/zLv8Avd+PltUqf/tSR1r/AIug+78TDn8Ltv8AtwFzBjOLmYc/hdt/24pmAAAAJmuJc51Udd3JONMhk0xJeubVp80LrZdq2dTdUrFDSUiBIi+eE5zo35Cvc78izOHP4Xbf9uAhnCjbtpzsmRcEWZYky1RG0swmhpjS5it1bJ5pq/L62nk1NQp0iBH+mgPMRmuRokZvRNI+F5XlKUpeMwGPFHYHuA59MGv+il619V7n7raFSrFY619GjSQQ08HzlfC/E9xAXTX9td7/ADKfCt8dZtX/AHaxV6Kh/wAmkghp0vyufFje4joZwo27ac7JkXBEzZ6P/RLzvMq3XP8Axo4Kr/yfH9nY2Ax4o7A9wAhnCjbtpzsmRcEMKNu2nOyZFwRM2Ax4o7A9wGAx4o7A9wAhnCjbtpzsmRcETNcy/wByl8HPX8VXuVayv9Kr1ilpv8ajjioEXzPdDic8r6zNtUXm1afO6lWpatnUPW6vQ0lIgRpfkiOc6N2Ur3P/AALM8mX2g+W+qAWAUlgjJ1LWeSLMrKqVCdpHHV5RaEqSQRmHGHdE9IU0rzTjiYyFy94kwAAAFM8Ofwu2/wC3DDn8Ltv+3AWZaay1RGlWffrMVq2dS1TradDR0kEf0jzXvgMyvc7F9x4yksEZOpazyRZlZVSoTtI46vKLQlSSCMw4w7onpCmleaccTGQuXvFf8Ofwu2/7cdmxK6t5ymnzQpV4VlWjTdbtemo6NAkS/JQmvfA7KRz3/gBZkAFM8Ofwu2/7cBDN21nOrdqW5IB2dwwy1RGlX436zFatnVGqdbToaOkrEf0jzXvgMyvc7F9x2fMXhKf1rvpvVvj/AGqz67V6v1X61IjjioI/kI6J2Nzysy7/AL3fj5bVKn/7Ukda/wCLoPu/EHtXUbBGTqWwlYlmVlVKhO0jqtXlFoSpJBHKkRh3RPSFNK8044mMhcveKMizLbbq3nKZhO6lXhWVaND1u16ajo06NL8lCa98DspHPf8AgVmATNhRt2052TIuCGFG3bTnZMi4ImbAY8Udge4DAY8Udge4ALmX+5S+Dnr+Kr3KtZX+lV6xS03+NRxxUCL5nuhxOeV/ZttZaojFmYTu0xmkxWEtkzUNQl9bTymhpk6NAk/TTnnozno0qQ3pGldE8jikIUnZ3MrC+Za+D4pt22at+31ahoaX+Q+J9L+HQ/d+Ls22qLzlMwndSrUsq0aHrdXpqOjTo0vyRGvfA7KRz3/gBQDCjbtpzsmRcEaZCmeAx4o7A9wGHP4Xbf8AbgPGuo29tYUtuyxKyrK11CaZHVavJ7PkqSCOSojzukejKcV5xxxcZS5e4V/aa1Je2lWffrPtq2dS1TqiBDR0kEf0jDXvgMyvc7F9xZnmLwlP61303q3x/tVn12r1fqv1qRHHFQR/IR0TsbnlYDHijsD3ACGbiXOdVHXdyTjTIUz5i8Gv+td9N9V7n7VZ9SrFY6r9akSQQ08fyFfC7E95GHP4Xbf9uAmbBcYToNtaW8YSapKrTEpasSRWVZkNQmmRx1eT0p6SCM8487pHlKcV5xxxcZS5e4VMw5/C7b/txZliS9c5TMJoXWy7KtGm6pWKajo06RF88Jr3wPyEc935AdmAAAAAAAAAAAAAAAAAxnGzAxnAaZXEubEqOu76nHZtNakojNbPv1n2yrRpap1ROmpKOCP6RhznRmZXPfi+44y4lzYlR13fU4hnlNOz7zL0oD2rqNvbJ10YSsSsqytdfnaWVWryez5UjjglSI87pHoyGkcaacXGUmTvFGQAAGmVxLmxKjru+pxmaNMriXNiVHXd9TgOMu52Wr20q868qYrVs6vVvraBDR0lXg+qea98B+R7nY/sKzYLjdtBtrSLjDTIAGZuC43bQba0i4wYLjdtBtrSLjDTIAGZuC43bQba0i4w4xprLV7ZrZ9+sxWVaNLVOtoE1JRwR/SPOc6MzK578X3GsopnymnZ95l6UBTMAABswMzbtrOdW7UtyQDTIZm3bWc6t2pbkgAdncMNSURmt+N+s+2VaNRqnVE6ako6xH9Iw5zozMrnvxfcWzUlvbJ10WeSKyrK11+dpZHV5PZ8qRxwGHHndI9GQ0jjTTi4ykyd4yzEzXEuc6qOu7knAaZCGcKNhOnOyZbwRMwxnAWZbay1e20tPndpjNJit1U55oahL62gk1NQoEaBJ+mnPMSGuSIkhvSNI+F5HkKQpZmuGGWr2zW/G/WYrKtGo1TraBNSUdYj+kec50ZmVz34vuOzuJc2JUdd31OJmAeMuy0zEpasStZlml1QmmRwViUUR6SCM80w3omEKcV5xxpMRC5e4RlhRsJ052TLeCF21mxLdqW+oBmaAAAAOzZky1e2lWheVMVq2dRVvraBDR0kcH1TzXvgPyPc7H9hMzEmWr2xZp80NMaXMVhKnM1NX5fW0EpoaZAkQI/00B56Q56RKjN6JpXRPK4hClJ2fJl9oPlvqhM121mxLdqW+oADCjYTpzsmW8EUzwXG7aDbWkXGEMjZgBGdy4q0+qWwlXVZWaQ1CdpHWqxJ6UxJBHKkp5vSMKU0rzTjS4ily94jK7nZavbSrzrypitWzq9W+toENHSVeD6p5r3wH5Hudj+wsyADLRdmCNYUtWJWsyzKpUJpkcFYlFoSVJBGeaYb0TEhTivOONJiIXL3CMhpldtZsS3alvqAZmgNmBGa7N7ZOpazytWVmWuoTtI4KxJ7PlSSCMw083pGIymleacaXEUuXvEmDM27aznVu1LckAC5mFGwnTnZMt4I9pSW9snXRZ5IrKsrXX52lkdXk9nypHHAYced0j0ZDSONNOLjKTJ3jLMTNcS5zqo67uScBpkMZxswMZwGmVxLmxKjru+pxMwhm4lzYlR13fU4mYBDN21mxLdqW+oBmaNMrtrNiW7Ut9QDM0AGmVxLmxKjru+pxmaNMriXNiVHXd9TgJmAAAAAAAAAAAAAAAAAYzjZgQzguMJ0G2tLeMAXEubEqOu76nEM8pp2feZelFs1JVaYlLViSKyrMhqE0yOOryelPSQRnnHndI8pTivOOOLjKXL3DxWmstURpVn36zFatnUtU62nQ0dJBH9I8174DMr3OxfcBQC4lznVR13ck40yEZqSwRk6lrPJFmVlVKhO0jjq8otCVJIIzDjDuiekKaV5pxxMZC5e8SYAxnAaZYLjCdBtrS3jBguMJ0G2tLeMAzNEzXEuc6qOu7knFzMFxhOg21pbxh7SksEZOpazyRZlZVSoTtI46vKLQlSSCMw4w7onpCmleaccTGQuXvASYADM3CjbtpzsmRcEAu2s51btS3JAIZHtLstM+ros8rWZZpdX52lkFYlFEYjjgMNMN6JhCGkcaaaTEQmTvHigJmuJc51Udd3JONMhkCpK0z6pazyRZlZl1QnaRx1eUURiSCMw4w7onkKaV5pxxMZC5e8SZhRt2052TIuCA0yGZt21nOrdqW5IBpkMzbtrOdW7UtyQAIZEzXEuc6qOu7knEMiZriXOdVHXdyTgNMgAZm4UbdtOdkyLggNMgGZuFG3bTnZMi4IYUbdtOdkyLggNMgGZuFG3bTnZMi4IYUbdtOdkyLggNMgGZuFG3bTnZMi4IvNcuLTPq6MJV1Zlml1fnaWVqsSiiMRxwSpKYb0TCENI4000mIhMneAr/wApp2feZelFMxrK01lqiNKs+/WYrVs6lqnW06GjpII/pHmvfAZle52L7iALqNgjJ1LYSsSzKyqlQnaR1Wryi0JUkgjlSIw7onpCmleaccTGQuXvAUZABplguMJ0G2tLeMAzNASbdRqtMSlt2WJWVZkNQmmR1WryelPSQRyVEed0jylOK8444uMpcvcJMuGGWqI0q/G/WYrVs6o1TradDR0lYj+kea98BmV7nYvuA4y4lznVR13ck40yFZm2stURizMJ3aYzSYrCWyZqGoS+tp5TQ0ydGgSfppzz0Zz0aVIb0jSuieRxSEKSs2FG3bTnZMi4ICGQAXmuXGCMnXRhKurMsyqV+dpZWqxKLQlSOOCVJTDeiYkIaRxpppMRCZO8BRkBplguMJ0G2tLeMGC4wnQba0t4wDM0BplguMJ0G2tLeMMzQGmVxLmxKjru+pxDPKadn3mXpRACkt7awpasSRWVZWuoTTI46vJ7PkqSCM8487pHoynFecccXGUuXuE/3Mv9yl8HPX8VXuVayv8ASq9Ypab/ABqOOKgRfM90OJzyvCGbiXOdVHXdyTjTIVmbay1RGLMwndpjNJisJbJmoahL62nlNDTJ0aBJ+mnPPRnPRpUhvSNK6J5HFIQpKzYUbdtOdkyLggNMgGZuFG3bTnZMi4IvNcuLTPq6MJV1Zlml1fnaWVqsSiiMRxwSpKYb0TCENI4000mIhMneAkwAAAAAAAAAAAAAAAABTPDn8Ltv+3FzBjOAuZhz+F23/bhhz+F23/biAFJYI1hdFYkizKyqlfmmWR1eUWhJUccB5xh3RPSEOI4404mMhMncPZwXG7aDbWkXGATNhz+F23/bhhz+F23/AG4hnBcbtoNtaRcYMFxu2g21pFxgEzYc/hdt/wBuGHP4Xbf9uIZwXG7aDbWkXGDBcbtoNtaRcYBM2HP4Xbf9uOzYldW85TT5oUq8KyrRput2vTUdGgSJfkoTXvgdlI57/wACmbTWWr2zWz79Zisq0aWqdbQJqSjgj+kec50ZmVz34vuOzuJc51Udd3JOA0yFM8BjxR2B7gXMEM4UbCdOdky3ggKANtUXm1afO6lWpatnUPW6vQ0lIgRpfkiOc6N2Ur3P/A7O5lYXz03wfFNhWNVv2+s01NS/yGQuovy+L7Ox+NdRrTMS6N2WJZlZl1fmmWVWryiiPRxwSVEYd0TyEOI4404mMhMncJ/5MvtB8t9UAYDHijsD3AYDHijsD3AuYACmeHP4Xbf9uKzNtXrnKafO662XZVo0PVKxTUdGgRovnhNe+B+Qjnu/I4wAEzXMrC+em+D4psKxqt+31mmpqX+QyF1F+XxfZ2OZuYvBr/rXfTfVe5+1WfUqxWOq/WpEkENPH8hXwuxPeTjLhhqSiM1vxv1n2yrRqNU6onTUlHWI/pGHOdGZlc9+L7iZm2tSURtLMJ3ZmzSfbdWyeaGoSCqJ5NTUKdGnSfqJzDEZrkaJId0jiPhcR5SkIUOMw5/C7b/txTMTNguN20G2tIuMGC43bQba0i4wCGRM1zKwvnpvg+KbCsarft9Zpqal/kMhdRfl8X2djjNdlWn1S1nlasrNIahO0jgrEnpTEkEZhp5vSMKU0rzTjS4ily94n+4YakojNb8b9Z9sq0ajVOqJ01JR1iP6RhznRmZXPfi+4Ds8BjxR2B7gMBjxR2B7gTNhRsJ052TLeCGFGwnTnZMt4IDM0WZYldW82rMJoUq8K1bOput2vQ0lInSJfkoTnOjdlK9z/wACswANMrmVunPTfB8LWFY1W/cKzTU1L/GZC6i/L4vs7H2bbVF5ymYTupVqWVaND1ur01HRp0aX5IjXvgdlI57/AMCmdww1JRGa3436z7ZVo1GqdUTpqSjrEf0jDnOjMyue/F9xZnCjYTpzsmW8EBDOAx4o7A9wGHP4Xbf9uJmwo2E6c7JlvBFM8Fxu2g21pFxgHGNtXrnKafO662XZVo0PVKxTUdGgRovnhNe+B+Qjnu/IszyZfaD5b6oQzguN20G2tIuMJmuZf7a74Oev4Vvjq1lf7tYq9LTf41JBDTovmc+LE9xXBZltqi85TMJ3Uq1LKtGh63V6ajo06NL8kRr3wOykc9/4FZsBjxR2B7gWAUlvbJ10WeSKyrK11+dpZHV5PZ8qRxwGHHndI9GQ0jjTTi4ykyd4kwBjONMriXNiVHXd9TjM0aZXEubEqOu76nALppunMte/8LW7bNZ/cKtQ0NF/GfE+l/Dofu/FxjErq3nKafNClXhWVaNN1u16ajo0CRL8lCa98DspHPf+Au52Wr20q868qYrVs6vVvraBDR0lXg+qea98B+R7nY/sIzuXGCNYUtuyurMsyqVCaZHWqxKLQkqSCOSpTDeiYkKcV5xxpMRC5e4BeUYzjZgYzgLMsSuUucpmE0Lrf7ZVo03VLIpqOjTpEXz0xr3wPyEc935HZ5l3/e78fLapU/8A2pI61/xdB934vauXG9snUthKuqysy11CdpHWqxJ7PlSSCOVJTzekYjKaV5pxpcRS5e8eLdNf3KXv8ynxVe5WbV/0qvWKKh/yaOOKgS/K90ONzyPDjG23VvOUzCd1KvCsq0aHrdr01HRp0aX5KE174HZSOe/8Cswk1dmCNYUtWJWsyzKpUJpkcFYlFoSVJBGeaYb0TEhTivOONJiIXL3CMgAaZXEubEqOu76nFM8Fxu2g21pFxhea5cVafVLYSrqsrNIahO0jrVYk9KYkgjlSU83pGFKaV5pxpcRS5e8BJgAAAAAAAAAAAAAAAADGcbMDGcBplcS5sSo67vqcTMIZuJc2JUdd31OIZ5TTs+8y9KAuYAxnABswAxnGmVxLmxKjru+pwEM8pp2feZelEM3Euc6qOu7knEzcpp2feZelEM3Euc6qOu7knAaZDGcbMDGcAFzOTL7QfLfVCmYANmAGM4AADZgAGM4ma4lznVR13ck4mblNOz7zL0ohm4lznVR13ck4DTIAGM4CZrtrOdW7UtyQCGRplcS5sSo67vqcTMAxnAaZXbWbEt2pb6gGZoAADTK4lzYlR13fU4DM0BczlNOz7zL0opmADZgYzgA2YFM+U07PvMvSimYAJmuJc51Udd3JONMhjOAANMriXNiVHXd9TjM0AGzADGcAGzAxnAAAXM5MvtB8t9UJmuJc2JUdd31OIZ5TTs+8y9KAma7azYlu1LfUAzNAAGzADGcaZXEubEqOu76nATMAAAAAAAAAAAAAAAAAxnGzAxnAaZXEubEqOu76nEM8pp2feZelEzXEubEqOu76nEM8pp2feZelAUzAAABplcS5sSo67vqcZmjTK4lzYlR13fU4CGeU07PvMvSiGbiXOdVHXdyTiZuU07PvMvSiGbiXOdVHXdyTgNMhjONmBjOAAAAJNuXFWmJdG7K6rKzSGvzTLK1WJPSno44JKlPN6RhSHEccaaXEUmTuF5cFxhOg21pbxhQBiS9c2rT5oXWy7Vs6m6pWKGkpECRF88JznRvyFe535FmcOfwu2/7cBDOFG3bTnZMi4IYUbdtOdkyLgiZsBjxR2B7gVmbaovNq0+d1KtS1bOoet1ehpKRAjS/JEc50bspXuf8AgBZm5l/uUvg56/iq9yrWV/pVesUtN/jUccVAi+Z7ocTnlf2bbWWqIxZmE7tMZpMVhLZM1DUJfW08poaZOjQJP00556M56NKkN6RpXRPI4pCFJWa5lbpzLXwfC1u2zVv3CrUNDS/xnxPpfw6H7vxdm226t5ymYTupV4VlWjQ9btemo6NOjS/JQmvfA7KRz3/gBxmFG3bTnZMi4IuZguMJ0G2tLeMMzRczDn8Ltv8AtwHGNtakvbFmnzuzNmk+2EqczUNQkFUQSmhpkCNOk/UTmHpDnpEqQ7pHFdE4jiEIQnGYUbdtOdkyLgiZuYvCU/rXfTerfH+1WfXavV+q/WpEccVBH8hHROxueWGbpphfMte/8U27bNZ/b6tQ0NF/IfE+l/Dofu/EHjLs3trC6KxK1ZWZa6/NMsgrEns+So44DzTzekYjIcRxxppcRSZO4RkOzYkovOU0+aFKtSyrRput1emo6NAkS/JEa98DspHPf+BZnAY8Udge4AUzEmqS3trClqxJFZVla6hNMjjq8ns+SpIIzzjzukejKcV5xxxcZS5e4RkAC5lzL/cpfBz1/FV7lWsr/Sq9Ypab/Go44qBF8z3Q4nPK/wBq6jYIydS2ErEsysqpUJ2kdVq8otCVJII5UiMO6J6QppXmnHExkLl7xX+5lbpzLXwfC1u2zVv3CrUNDS/xnxPpfw6H7vxTNz6YSn9FL1r1b4/3W0K7V6v1r6NGjjioIPnI6J+NzihTMaZYLjCdBtrS3jCGcBjxR2B7gMOfwu2/7cBM2C4wnQba0t4wYLjCdBtrS3jDs2JL1zlMwmhdbLsq0abqlYpqOjTpEXzwmvfA/IRz3fkcZdNN05lr3/ha3bZrP7hVqGhov4z4n0v4dD934gjO6jYIydS2ErEsysqpUJ2kdVq8otCVJII5UiMO6J6QppXmnHExkLl7xRkXM59MJT+il616t8f7raFdq9X619GjRxxUEHzkdE/G5xWAx4o7A9wApmAuZgMeKOwPcCszbVF5tWnzupVqWrZ1D1ur0NJSIEaX5IjnOjdlK9z/AMAOMEm3LirTEujdldVlZpDX5pllarEnpT0ccElSnm9IwpDiOONNLiKTJ3D2bmVhfPTfB8U2FY1W/b6zTU1L/IZC6i/L4vs7HZliVylzatPmhdb/AG1bOpuqWRQ0lIgSIvnpjnOjfkK9zvyA7PBcYToNtaW8YZmjZgUzwGPFHYHuAEAKS3trClqxJFZVla6hNMjjq8ns+SpIIzzjzukejKcV5xxxcZS5e4T/AHMv9yl8HPX8VXuVayv9Kr1ilpv8ajjioEXzPdDic8r2Ax4o7A9wGZd/3u/Hy2qVP/2pI61/xdB934gmbBcYToNtaW8YMFxhOg21pbxhDOHP4Xbf9uGHP4Xbf9uApmNMriXNiVHXd9TjM0aZXEubEqOu76nATMAAAAAAAAAAAAAAAAAxnGzAxnAaZXEubEqOu76nHGXc7LV7aVedeVMVq2dXq31tAho6SrwfVPNe+A/I9zsf2HZ3EubEqOu76nEzAMzcFxu2g21pFxgwXG7aDbWkXGGmQAMzcFxu2g21pFxhea5cVafVLYSrqsrNIahO0jrVYk9KYkgjlSU83pGFKaV5pxpcRS5e8SYACmfKadn3mXpRDNxLnOqjru5JxM3Kadn3mXpRDNxLnOqjru5JwGmQzNwXG7aDbWkXGGmQAMgV2VafVLWeVqys0hqE7SOCsSelMSQRmGnm9IwpTSvNONLiKXL3j2WZMtXtpVoXlTFatnUVb62gQ0dJHB9U8174D8j3Ox/YdndtZzq3aluSATNyZfaD5b6oBDOC43bQba0i4wYLjdtBtrSLjDTIAAUauo2CNYXRuyxLMrKqV+aZZVavKLQkqOOCSojDuiekIcRxxpxMZCZO4XlABmbguN20G2tIuMPGXZgjWFLViVrMsyqVCaZHBWJRaElSQRnmmG9ExIU4rzjjSYiFy9w1LEM3bWbEt2pb6gAZmiZsFxu2g21pFxhDI2YARncuKtPqlsJV1WVmkNQnaR1qsSelMSQRypKeb0jClNK8040uIpcveK/8pp2feZelFzBTPlNOz7zL0oCGbiXOdVHXdyTjTIZm3Euc6qOu7knGmQDGcAAAEm3Li0zEpbdldWZZpdUJpkdarEooj0kEclSmG9EwhTivOONJiIXL3CMgAaZYUbCdOdky3gimeC43bQba0i4whkbMAIzuXFWn1S2Eq6rKzSGoTtI61WJPSmJII5UlPN6RhSmleacaXEUuXvFf+U07PvMvSi5gpnymnZ95l6UBDNxLnOqjru5JxpkMzbiXOdVHXdyTjTIBDOFGwnTnZMt4Io1dRrTMS6N2WJZlZl1fmmWVWryiiPRxwSVEYd0TyEOI4404mMhMncIyABZm4YakojNb8b9Z9sq0ajVOqJ01JR1iP6RhznRmZXPfi+4tmpLe2Tros8kVlWVrr87SyOryez5UjjgMOPO6R6MhpHGmnFxlJk7xlmJmuJc51Udd3JOA0yEM4UbCdOdky3giZhjOA1/UlaZiXRWJIsysy6vzTLI6vKKI9HHAecYd0TyEOI4404mMhMncK/3c7LV7aVedeVMVq2dXq31tAho6SrwfVPNe+A/I9zsf2HZ3EubEqOu76nEzAMzcFxu2g21pFxgwXG7aDbWkXGGmQAMZxplcS5sSo67vqcZmjTK4lzYlR13fU4CZgAAAAAAAAAAAAAAAAGM42YEM4LjCdBtrS3jAMzQGmWC4wnQba0t4wYLjCdBtrS3jAMzQGmWC4wnQba0t4wYLjCdBtrS3jAMzQGmWC4wnQba0t4wYLjCdBtrS3jAMzRM1xLnOqjru5JxczBcYToNtaW8Ye0pLBGTqWs8kWZWVUqE7SOOryi0JUkgjMOMO6J6QppXmnHExkLl7wEmDGcbMCGcFxhOg21pbxgC4lzYlR13fU4mYeMpKrTEpasSRWVZkNQmmRx1eT0p6SCM8487pHlKcV5xxxcZS5e4eyAhm7azYlu1LfUAzNGv67KtMS6KxK1ZWaQ1+aZZBWJPSno44DzTzekYUhxHHGmlxFJk7hGWC4wnQba0t4wDM0BplguMJ0G2tLeMGC4wnQba0t4wDM0BplguMJ0G2tLeMGC4wnQba0t4wDM0bMCGcFxhOg21pbxhMwDM27aznVu1LckAmbky+0Hy31QsAuzBGTros8rWZZlUr87SyCsSi0JUjjgMNMN6JiQhpHGmmkxEJk7x7LMmWqIzW0Lypisq0aKt9bTpqSjjg+qec50Z+Rz34/sA7MAAAAAABDN21mxLdqW+oBMw8ZdlWmJdFYlasrNIa/NMsgrEnpT0ccB5p5vSMKQ4jjjTS4ikydwDIABplguMJ0G2tLeMGC4wnQba0t4wDM0XM5MvtB8t9UJmwXGE6DbWlvGHZsyZaojNbQvKmKyrRoq31tOmpKOOD6p5znRn5HPfj+wDswAAAZm3bWc6t2pbkgGmQjNdmCMnXRZ5WsyzKpX52lkFYlFoSpHHAYaYb0TEhDSONNNJiITJ3gMsxM1xLnOqjru5JxczBcYToNtaW8Ye0pLBGTqWs8kWZWVUqE7SOOryi0JUkgjMOMO6J6QppXmnHExkLl7wEmDGcbMCGcFxhOg21pbxgC4lzYlR13fU4hnlNOz7zL0otmpKrTEpasSRWVZkNQmmRx1eT0p6SCM8487pHlKcV5xxxcZS5e4eK01lqiNKs+/WYrVs6lqnW06GjpII/pHmvfAZle52L7gMmgGmWC4wnQba0t4wYLjCdBtrS3jAMzRplcS5sSo67vqcMFxhOg21pbxhJqkqtMSlqxJFZVmQ1CaZHHV5PSnpIIzzjzukeUpxXnHHFxlLl7gHsgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/9k=";

  const dataStr = dataAval
    ? dataAval.split("-").reverse().join("/")
    : new Date().toLocaleDateString("pt-BR");

  const nomeSistema = { quadril:"Quadril", tornozelo:"Tornozelo", posterior:"Posterior", iliopsoas:"Iliopsoas" };
  const corRisco = {
    high:     { bg:"#fee2e2", text:"#b91c1c", label:"Alto" },
    moderate: { bg:"#ffedd5", text:"#c2410c", label:"Moderado" },
    low:      { bg:"#f0fdf4", text:"#15803d", label:"Baixo" },
  };

  const sistemasBadges = Object.entries(risks).map(([s, r]) => {
    const c = corRisco[r] || { bg:"#f9fafb", text:"#6b7280", label:"—" };
    return `<span style="display:inline-flex;align-items:center;padding:3px 10px;border-radius:20px;font-size:10px;font-weight:700;background:${c.bg};color:${c.text};margin:2px;">${nomeSistema[s]}: ${c.label}</span>`;
  }).join("");

  const exRows = exercises.map((ex, i) => {
    const c = corRisco[ex.risk] || corRisco.low;
    const bg = i % 2 === 0 ? "#ffffff" : "#f8fafc";
    return `
      <tr style="background:${bg};">
        <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;text-align:center;width:36px;">
          <span style="display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;background:#0f172a;color:#fff;font-size:10px;font-weight:800;">${ex.code}</span>
        </td>
        <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;">
          <div style="font-size:12px;font-weight:700;color:#0f172a;">${ex.name}</div>
          <div style="font-size:10px;color:#64748b;margin-top:1px;font-style:italic;">${ex.rationale}</div>
        </td>
        <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;vertical-align:top;min-width:160px;">
          <div style="display:flex;gap:10px;">
            <div style="flex:1;background:#f0fdf4;border-radius:6px;padding:5px 8px;">
              <div style="font-size:8px;font-weight:700;color:#064e3b;text-transform:uppercase;letter-spacing:.04em;margin-bottom:2px;">Pré-treino</div>
              <div style="font-size:11px;font-weight:700;color:#065f46;">${ex.pretreino || "—"}</div>
            </div>
            <div style="flex:1;background:#faf5ff;border-radius:6px;padding:5px 8px;">
              <div style="font-size:8px;font-weight:700;color:#6d28d9;text-transform:uppercase;letter-spacing:.04em;margin-bottom:2px;">Reabilitação</div>
              <div style="font-size:11px;font-weight:700;color:#5b21b6;">${ex.reabilitacao || "—"}</div>
            </div>
          </div>
        </td>
        <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;text-align:center;width:56px;">
          <span style="padding:2px 7px;border-radius:20px;font-size:10px;font-weight:700;background:${c.bg};color:${c.text};">${c.label}</span>
        </td>
      </tr>`;
  }).join("");

  const alertaPrioridade = prioritySystems.length
    ? `<div style="background:#fef2f2;border:1.5px solid #fca5a5;border-radius:7px;padding:8px 12px;margin-bottom:12px;font-size:11px;color:#b91c1c;font-weight:600;">⚠ Risco alto: ${prioritySystems.map(s => nomeSistema[s]||s).join(", ")} · priorizar estes exercícios</div>`
    : `<div style="background:#f0fdf4;border:1.5px solid #86efac;border-radius:7px;padding:8px 12px;margin-bottom:12px;font-size:11px;color:#15803d;font-weight:600;">✓ Sem sistemas de alto risco · protocolo de manutenção funcional</div>`;

  return `
    <div style="font-family:'Segoe UI',Arial,sans-serif;background:#fff;">
      <div style="border-bottom:2.5px solid #059669;padding-bottom:10px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:flex-end;">
        <div>
          <div style="font-size:9px;color:#94a3b8;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;">CIENTE IE · PROTOCOLO FUNCIONAL</div>
          <div style="font-size:17px;font-weight:800;color:#0f172a;margin-top:2px;">${nome}</div>
        </div>
        <div style="text-align:right;">
          <div style="font-size:9px;color:#94a3b8;">Avaliação: ${dataStr}</div>
          <div style="font-size:9px;color:#94a3b8;">Gerado: ${new Date().toLocaleDateString("pt-BR")}</div>
        </div>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px;gap:16px;">
        <div style="flex:1;">
          <div style="font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px;">Perfil de Risco por Sistema</div>
          <div style="display:flex;flex-wrap:wrap;gap:4px;">${sistemasBadges}</div>
        </div>
        <div style="flex-shrink:0;text-align:center;">
          <img src="${QR_IMG}" style="width:72px;height:72px;display:block;margin:0 auto;" />
          <div style="font-size:8px;color:#64748b;margin-top:4px;max-width:80px;line-height:1.3;text-align:center;">Escaneie o QR Code para visualizar os exercícios</div>
        </div>
      </div>
      ${alertaPrioridade}
      <div style="font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px;">Protocolo · ${exercises.length} Exercícios</div>
      <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
        <thead>
          <tr style="background:#0f172a;">
            <th style="padding:8px 10px;color:#fff;font-size:10px;font-weight:700;text-transform:uppercase;text-align:center;width:36px;">#</th>
            <th style="padding:8px 10px;color:#fff;font-size:10px;font-weight:700;text-transform:uppercase;text-align:left;">Exercício</th>
            <th style="padding:8px 10px;color:#fff;font-size:10px;font-weight:700;text-transform:uppercase;text-align:left;">Dosagem</th>
            <th style="padding:8px 10px;color:#fff;font-size:10px;font-weight:700;text-transform:uppercase;text-align:center;width:56px;">Risco</th>
          </tr>
        </thead>
        <tbody>${exRows}</tbody>
      </table>
      <div style="margin-top:10px;font-size:8px;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:6px;">
        Protocolo gerado automaticamente · modelo MIHBD-TE · Ciente IE · ${exercises.length} exercícios · ${Object.values(risks).filter(r=>r==='high'||r==='moderate').length} sistema(s) com déficit
      </div>
    </div>`;
}

// ── Exporta fichas de múltiplos atletas (1 página A4 por atleta) ──────────
async function _exportarFichasPDF(entradas) {
  try {
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
    const mX = 12, mY = 12;
    let primeira = true;

    for (const entrada of entradas) {
      const tempEl = document.createElement("div");
      tempEl.style.cssText = "position:fixed;top:-9999px;left:-9999px;width:794px;background:#fff;padding:30px 36px;font-family:'Segoe UI',Arial,sans-serif;box-sizing:border-box;";
      tempEl.innerHTML = _renderFichaAtleta(entrada);
      document.body.appendChild(tempEl);
      await new Promise(r => setTimeout(r, 80));

      const canvas = await html2canvas(tempEl, {
        scale: 1.8, useCORS: true, backgroundColor: "#ffffff", logging: false,
      });
      document.body.removeChild(tempEl);

      const imgW = 210 - mX * 2;
      const imgH = (canvas.height * imgW) / canvas.width;

      if (!primeira) pdf.addPage();
      primeira = false;

      if (imgH <= 297 - mY * 2) {
        pdf.addImage(canvas.toDataURL("image/jpeg", 0.93), "JPEG", mX, mY, imgW, imgH);
      } else {
        const altSlice = 297 - mY * 2;
        const nSlices  = Math.ceil(imgH / altSlice);
        for (let sl = 0; sl < nSlices; sl++) {
          if (sl > 0) pdf.addPage();
          const srcY = Math.round((sl * altSlice / imgH) * canvas.height);
          const srcH = Math.round(Math.min(altSlice / imgH * canvas.height, canvas.height - srcY));
          const sc   = document.createElement("canvas");
          sc.width = canvas.width; sc.height = srcH;
          sc.getContext("2d").drawImage(canvas, 0, srcY, sc.width, srcH, 0, 0, sc.width, srcH);
          pdf.addImage(sc.toDataURL("image/jpeg", 0.93), "JPEG", mX, mY, imgW, (srcH * imgW) / canvas.width);
        }
      }
    }

    const sufixo = entradas.length === 1
      ? entradas[0].nome.replace(/\s+/g,"_")
      : `${entradas.length}_atletas`;
    pdf.save(`protocolo_funcional_${sufixo}_${new Date().toLocaleDateString('en-CA')}.pdf`);

  } catch(e) {
    console.error(e);
    alert("Erro ao gerar PDF. Verifique o console.");
  }
}