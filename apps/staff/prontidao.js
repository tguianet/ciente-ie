// v2
import { db, auth } from "../core/firebase.js";
import {
  collection,
  getDocs,
  query,
  where,
  doc,
  getDoc,
  setDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js";
import {
  clamp            as _clamp,
  cmjToScoreAbs    as _cmjToScoreAbs,
  mapNeuro         as _mapNeuro,
  moduladorHooper  as _moduladorHooper,
  calcularHooperScore    as _calcularHooperScore,
  calcularZScoreCMJ      as _calcularZScoreCMJ,
  calcularIndicadorVFC   as _calcularIndicadorVFC,
  calcularIndicadorNeuro as _calcularIndicadorNeuro,
  calcularACWR           as _calcularACWR,
  calcularProntidao      as _calcularProntidao,
  calcularISPTendencia   as _calcularISPTendencia,
  lnToScoreAbsVFC,
  _ispRegression, _ispDP, _ispR2,
  classificarTendencia, classificarTendenciaGlobal,
  ISP_PESOS,
} from "../core/stats.js";

// ── Referências de jogo (configuráveis) ──────────────────────────────────────
const CARGA_JOGO_REF  = 800; // u.a. — PSE × duração referência do jogo
const VOLUME_JOGO_REF = 100; // min  — duração de referência do jogo

const hoje = new Date().toLocaleDateString('en-CA');
const _filtroDataEl = document.getElementById("filtroData");
if (_filtroDataEl) _filtroDataEl.value = hoje;

let atletas = [];
let daily = [];
let historico = [];
let assessmentsMedical = [];
let rtpProgressMap = {};   // athleteId → fase salva (0–4)
let graficoCardAtual = null;
let CLUB_ID   = null;
let CLUB_NAME = null;
let CLUB_LOGO = null;
let _gruposPront = {}; // athleteId → grupo (Geral, G1, G2, G3)

// Filtro de minutos jogados: mapa athleteId → segundos jogados no jogo selecionado
let minutosByAthleta = {};

// Filtro de grupo: mapa athleteId → grupo do planejamento na data selecionada
let gruposByAthleta = {};

// Índice de performance por atleta da última partida: athleteId → performance (0–100)
let perfByAthleta = {};

// Contadores de ações por atleta da última partida: athleteId → acoes
let acoesByAthleta = {};

// Duelos por atleta: athleteId → { ganhos, perdidos }
let duelosByAthleta = {};

// Eventos da última partida (para análise xG / origem / game state)
let ultimaPartidaId = null;
let ultimaPartidaEventos = [];

// Aguarda auth antes de iniciar
onAuthStateChanged(auth, async (user) => {
  if (!user) { window.location.href = "/login.html"; return; }
  try {
    // 1. localStorage (rápido, salvo no login)
    const ctx = JSON.parse(localStorage.getItem("userContext") || "{}");
    CLUB_ID   = ctx?.clubId   ?? null;
    CLUB_NAME = ctx?.clubName ?? null;
    CLUB_LOGO = ctx?.clubLogoUrl ?? null;
    // 2. Fallback Firestore
    if (!CLUB_ID) {
      const snap = await getDoc(doc(db, "users", user.uid));
      CLUB_ID = snap.exists() ? snap.data().clubId : null;
    }
    if (!CLUB_ID) { console.error("Usuário sem clubId"); return; }
    init();
  } catch(e) { console.error(e); }
});

// ================= INIT =================
async function init(){
  await carregarAtletas();
  await Promise.all([
    carregarHistorico(),
    carregarAssessmentsMedical(),
    carregarRTPProgress(),
    carregarDaily(),
    carregarGruposPlanejamento(),
    carregarGruposAtletas(),
    carregarUltimaPartida(),
  ]);
  try { aplicarFiltros(); } catch(e) { console.error('aplicarFiltros:', e); }

  // Wire up grupo filter
  document.getElementById("filtroGrupo")?.addEventListener("change", () => {
    try { aplicarFiltros(); } catch(e) { console.error('aplicarFiltros:', e); }
  });

  document.dispatchEvent(new Event('prontidaoReady'));
}

// ================= FIRESTORE =================
async function carregarAtletas(){
  const snap = await getDocs(query(
    collection(db,"athletes"),
    where("clubId","==",CLUB_ID),
    where("ativo","!=",false)
  ));
  atletas = snap.docs.map(d=>({id:d.id,...d.data()}));
  preencherFiltros();
}

async function carregarAssessmentsMedical(){
  const snap = await getDocs(query(
    collection(db,"assessments_medical"),
    where("clubId","==",CLUB_ID)
  ));
  assessmentsMedical = snap.docs.map(d=>({id:d.id,...d.data()}));
}

async function carregarHistorico(){
  const d90 = new Date(); d90.setDate(d90.getDate() - 90);
  const desde = d90.toLocaleDateString('en-CA');
  const snap = await getDocs(query(
    collection(db,"daily_metrics"),
    where("clubId","==",CLUB_ID),
    where("date",">=",desde)
  ));
  historico = snap.docs.map(d=>d.data());
}

async function carregarRTPProgress() {
  try {
    const snap = await getDocs(query(
      collection(db, "rtp_progress"),
      where("clubId", "==", CLUB_ID)
    ));
    rtpProgressMap = {};
    snap.docs.forEach(d => {
      const data = d.data();
      if (data.athleteId) rtpProgressMap[data.athleteId] = data.fase ?? 0;
    });
  } catch(e) {
    console.warn("carregarRTPProgress:", e);
    rtpProgressMap = {};
  }
}

// Salva no Firestore apenas quando a fase avança (fire-and-forget)
function salvarRTPProgressFirestore(athleteId, fase) {
  const ref = doc(db, "rtp_progress", `${CLUB_ID}_${athleteId}`);
  setDoc(ref, {
    athleteId,
    clubId: CLUB_ID,
    fase,
    dataAvanco: new Date().toLocaleDateString('en-CA'),
    updatedAt: serverTimestamp()
  }, { merge: true }).catch(e => console.warn("salvarRTPProgress:", e));
}

async function carregarDaily(){
  const data = document.getElementById("filtroData")?.value || new Date().toLocaleDateString('en-CA');
  const snap = await getDocs(query(
    collection(db,"daily_metrics"),
    where("clubId","==",CLUB_ID),
    where("date","==",data)
  ));
  // Mescla múltiplos documentos do mesmo atleta no mesmo dia
  // Garante que campos de blocos distintos (pre, hrv, neuro, post) não se percam
  const byAthlete = {};
  snap.docs.forEach(d => {
    const doc = d.data();
    const aid = doc.athleteId;
    if (!aid) return;
    if (!byAthlete[aid]) {
      byAthlete[aid] = { ...doc };
    } else {
      // Mescla blocos: hrv, pre, neuro, post, meta — campos não-nulos têm prioridade
      ["hrv","pre","neuro","post"].forEach(block => {
        if (doc[block] && !byAthlete[aid][block]) {
          byAthlete[aid][block] = doc[block];
        } else if (doc[block] && byAthlete[aid][block]) {
          // Mescla subcampos — mantém valor existente se não-nulo
          Object.keys(doc[block]).forEach(k => {
            if (byAthlete[aid][block][k] == null && doc[block][k] != null) {
              byAthlete[aid][block][k] = doc[block][k];
            }
          });
        }
      });
    }
  });
  daily = Object.values(byAthlete);
}

async function carregarGruposAtletas() {
  try {
    const clubId = CLUB_ID || JSON.parse(localStorage.getItem('userContext') || '{}').clubId || '';
    const hoje = new Date();
    const t = new Date(Date.UTC(hoje.getFullYear(), hoje.getMonth(), hoje.getDate()));
    t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
    const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    const semana = `S${Math.ceil((((t - y) / 86400000) + 1) / 7)}-${hoje.getFullYear()}`;
    const snap = await getDoc(doc(db, 'assessments_planning', `${semana}_${clubId}`));
    if (!snap.exists()) return;
    const grupos = snap.data().gruposAtletas;
    if (!grupos) return;
    _gruposPront = {};
    Object.entries(grupos).forEach(([grupo, ids]) => {
      (ids || []).forEach(id => { _gruposPront[id] = grupo; });
    });
  } catch(e) {
    console.warn('carregarGruposAtletas:', e);
  }
}

// Carrega grupos do planejamento (athlete_sessions) para a data selecionada
async function carregarGruposPlanejamento(){
  gruposByAthleta = {};
  const data = document.getElementById("filtroData")?.value || new Date().toLocaleDateString('en-CA');
  try {
    const snap = await getDocs(query(
      collection(db, "athlete_sessions"),
      where("clubId", "==", CLUB_ID),
      where("date", "==", data)
    ));
    snap.docs.forEach(d => {
      const s = d.data();
      if (s.athleteId && s.grupo) gruposByAthleta[s.athleteId] = s.grupo;
    });
  } catch(e) {
    console.warn("carregarGruposPlanejamento:", e);
  }
}

// Metadados da última partida carregada
let ultimaPartidaMeta = null; // { adversario, data, placar, local }

// Busca a última partida registrada e carrega minutos jogados de cada atleta
async function carregarUltimaPartida(){
  minutosByAthleta = {};
  ultimaPartidaMeta = null;
  try {
    const snap = await getDocs(query(
      collection(db,"scout_partidas"),
      where("clubId","==",CLUB_ID)
    ));
    if(snap.empty) return;

    // Ordena pela data da partida (campo 'data') desc; tiebreaker: createdAt
    const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    docs.sort((a,b) => {
      const da = a.data || "";
      const db2 = b.data || "";
      if(db2 !== da) return db2.localeCompare(da); // YYYY-MM-DD compara corretamente como string
      const sa = a.createdAt?.seconds ?? 0;
      const sb = b.createdAt?.seconds ?? 0;
      return sb - sa;
    });
    const p = docs[0];

    ultimaPartidaMeta = {
      adversario: p.adversario || "Adversário",
      data: p.data || "",
      placar: p.placar || null,
      local: p.local || ""
    };

    const durSec = Math.min(p.duracaoSegundos || 5400, 7200); // cap 120 min (inclui prorrogação)
    if(p.playedSeconds){
      Object.entries(p.playedSeconds).forEach(([id, val]) => {
        const raw = typeof val === "object" ? (val.seconds ?? 0)
                  : typeof val === "number"  ? val : 0;
        const seg = Math.min(raw, durSec); // limita ao tempo total da partida
        if(seg > 0) minutosByAthleta[id] = seg;
      });
    }
    // Captura perfSnapshot por atleta
    perfByAthleta = {};
    acoesByAthleta = {};
    duelosByAthleta = {};
    if(p.perfSnapshot){
      Object.entries(p.perfSnapshot).forEach(([id, snap]) => {
        if(snap.performance != null) perfByAthleta[id] = snap.performance;
        if(snap.actions != null) acoesByAthleta[id] = Object.values(snap.actions).reduce((a,b) => a+b, 0);
        else if(snap.acoes != null) acoesByAthleta[id] = snap.acoes;
        if(snap.duelos_ganhos != null || snap.duelos_perdidos != null)
          duelosByAthleta[id] = { ganhos: snap.duelos_ganhos ?? 0, perdidos: snap.duelos_perdidos ?? 0 };
      });
    }
    // Carrega eventos para análise xG/origem/game-state
    ultimaPartidaId = p.id;
    ultimaPartidaEventos = [];
    if(Array.isArray(p.events) && p.events.length){
      ultimaPartidaEventos = p.events;
    } else {
      try {
        const evSnap = await getDocs(collection(db, 'scout_partidas', p.id, 'events'));
        ultimaPartidaEventos = evSnap.docs.map(d => d.data());
      } catch(evErr){ console.warn('[UltimaPartida] eventos não carregados:', evErr); }
    }
    console.log(`[UltimaPartida] ${ultimaPartidaMeta.data} x ${ultimaPartidaMeta.adversario} | Atletas: ${Object.keys(minutosByAthleta).length} | Eventos: ${ultimaPartidaEventos.length}`);
  } catch(e){
    console.warn("Erro ao carregar última partida:", e);
  }
}

// ================= UTIL =================
// Wrappers sobre stats.js — a lógica canônica vive lá (uma fonte de verdade).
// Estes wrappers injetam `historico` e `hoje` do contexto local do módulo.
function clamp(v, min, max)    { return _clamp(v, min, max); }
function mapNeuro(n)           { return _mapNeuro(n); }
function moduladorHooper(val)  { return _moduladorHooper(val); }
function cmjToScoreAbs(cm)     { return _cmjToScoreAbs(cm); }

// ── Indicadores: wrappers que injetam historico + hoje do DOM ────────────────
function _hoje() {
  return document.getElementById("filtroData")?.value || new Date().toLocaleDateString('en-CA');
}

function calcularIndicadorNeuro(athleteId, scoreAtual, sono) {
  return _calcularIndicadorNeuro(athleteId, scoreAtual, sono, historico, _hoje());
}

function calcularHooperScore(hooper) {
  return _calcularHooperScore(hooper);
}

// ── Início do microciclo atual: segunda-feira da semana ISO contendo dataRef ──
function getMicrocicloStart(dataRef) {
  const d = new Date(dataRef + 'T00:00:00');
  const dow = d.getDay(); // 0=Dom, 1=Seg, ..., 6=Sáb
  const diff = dow === 0 ? -6 : 1 - dow;
  const seg = new Date(d);
  seg.setDate(d.getDate() + diff);
  return seg.toLocaleDateString('en-CA');
}

// ── Fallbacks do microciclo: para cada sistema sem dados hoje, retorna o score
// e a data do registro mais recente dentro do microciclo atual ────────────────
function calcularFallbacksMicrociclo(athleteId, calcHoje, hojeStr, microcicloStart) {
  const result = { IH: null, IA: null, INM: null, IC: null };
  const micData = historico
    .filter(d => d.athleteId === athleteId && d.date >= microcicloStart && d.date < hojeStr)
    .sort((a, b) => b.date.localeCompare(a.date));

  if (calcHoje.IH == null) {
    const entry = micData.find(d => d.pre?.hooper != null);
    if (entry) result.IH = { score: calcularHooperScore(entry.pre.hooper), date: entry.date };
  }
  if (calcHoje.IA == null) {
    const entry = micData.find(d => d.hrv?.lnRR != null);
    if (entry) result.IA = { score: entry.hrv.score != null ? _clamp(entry.hrv.score, 0, 100) : calcularIndicadorVFC(athleteId, entry.hrv.lnRR, entry.pre?.estresse), date: entry.date };
  }
  if (calcHoje.INM == null) {
    const entry = micData.find(d => d.pre?.salto != null);
    if (entry) result.INM = { score: calcularZScoreCMJ(athleteId, entry.pre.salto, entry.pre?.dor), date: entry.date };
  }
  if (calcHoje.IC == null) {
    const entry = micData.find(d => d.neuro?.score != null);
    if (entry) result.IC = { score: calcularIndicadorNeuro(athleteId, entry.neuro.score, entry.pre?.sono), date: entry.date };
  }
  return result;
}

function calcularZScoreCMJ(athleteId, saltoAtual, dor) {
  return _calcularZScoreCMJ(athleteId, saltoAtual, dor, historico, _hoje());
}

function calcularIndicadorVFC(athleteId, lnRR, estresse) {
  return _calcularIndicadorVFC(athleteId, lnRR, estresse, historico, _hoje());
}

function calcularProntidao(dm, basalRef) {
  return _calcularProntidao(dm, historico, _hoje(), basalRef);
}

// ── Lógica de indicadores: retorna número de fase (1–4) para atleta em transição ─
function _calcularFaseIndicadores(prontidao) {
  const { global, inFadiga, inMuscular, inAutonomico, dor } = prontidao || {};
  const semDor = dor == null || dor < 4;
  if (global >= 70
    && (inFadiga     == null || inFadiga     >= 60)
    && inMuscular    != null && inMuscular   >= 60
    && (inAutonomico == null || inAutonomico >= 60)
    && semDor) return 4;
  if ((inFadiga     == null || inFadiga     >= 60)
    && inMuscular    != null && inMuscular   >= 60
    && (inAutonomico == null || inAutonomico >= 50)
    && semDor) return 3;
  // F2 automático: basta ter realizado o salto (CMJ coletado)
  if (inMuscular != null) return 2;
  return 1;  // Sem CMJ → Recondicionamento
}

// ── Constrói objeto de fase a partir do número ─────────────────────────────────
function _buildFaseObj(fase) {
  const fases = {
    4: { fase: 4, label: "Apto",              descricao: "Global ≥ 70, todos ≥ 60 e dor < 4", cor: "#15803d", bg: "#dcfce7" },
    3: { fase: 3, label: "Treino Coletivo",   descricao: "INM ≥ 60, Auton. ≥ 50 e dor < 4",  cor: "#0369a1", bg: "#e0f2fe" },
    2: { fase: 2, label: "Treino Adaptado",   descricao: "Neuromuscular ≥ 60 e Auton. ≥ 50",  cor: "#7c3aed", bg: "#ede9fe" },
    1: { fase: 1, label: "Recondicionamento", descricao: "Subjetivo ≥ 60 e Neuromuscular ≥ 50", cor: "#b45309", bg: "#fef9c3" },
    0: { fase: 0, label: "Afastado",          descricao: "Aguardando transição médica",         cor: "#b91c1c", bg: "#fee2e2" },
  };
  return fases[fase] ?? fases[1];
}

// ── Fase RTP pública: respeita faseSalva como piso (fase nunca regride) ────────
function calcularFaseRTP(statusMedico, prontidao, faseSalva = 0) {
  if (!statusMedico || statusMedico === "liberado") return null;
  if (statusMedico === "afastado") return _buildFaseObj(0);
  // transicao: calcula pelos indicadores e aplica piso histórico
  const faseCalculada = _calcularFaseIndicadores(prontidao);
  const faseEfetiva   = Math.max(faseCalculada, faseSalva ?? 0);
  return _buildFaseObj(faseEfetiva);
}

// ── Persistência de fase RTP via localStorage ─────────────────────────────────
// Salva a fase computada (com dados reais) para uso em dias sem coleta.
function _rtpCacheKey() { return `rtp_cache_${CLUB_ID}`; }
function _salvarFaseRTP(athleteId, fase) {
  if (!fase || !CLUB_ID) return;
  try {
    const cache = JSON.parse(localStorage.getItem(_rtpCacheKey()) || '{}');
    cache[athleteId] = { fase: fase.fase, label: fase.label, cor: fase.cor, bg: fase.bg };
    localStorage.setItem(_rtpCacheKey(), JSON.stringify(cache));
  } catch(e) {}
}
function _carregarFaseRTP(athleteId) {
  if (!CLUB_ID) return null;
  try {
    const cache = JSON.parse(localStorage.getItem(_rtpCacheKey()) || '{}');
    return cache[athleteId] || null;
  } catch(e) { return null; }
}

// ── Fase histórica usando escalas absolutas (sem z-score) ─────────────────────
// Evita distorção dos z-scores ao recalcular dados de dias passados.
function _calcularFaseRTPHistorica(statusMed, dm) {
  if (!dm) return calcularFaseRTP(statusMed, {});
  const hooper   = dm.pre?.hooper   ?? null;
  const salto    = dm.pre?.salto    ?? null;
  const lnRR     = dm.hrv?.lnRR     ?? null;
  const dor      = dm.pre?.dor      ?? null;
  const estresse = dm.pre?.estresse ?? null;
  const IH  = hooper != null ? calcularHooperScore(hooper) : null;
  const INM = salto  != null ? clamp(cmjToScoreAbs(salto)    + moduladorHooper(dor),      0, 100) : null;
  const IA  = lnRR   != null ? clamp(lnToScoreAbsVFC(lnRR), 0, 100) : null;
  const vals = [IH, INM, IA].filter(v => v != null);
  const global = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
  return calcularFaseRTP(statusMed, { global, inFadiga: IH, inMuscular: INM, inAutonomico: IA, dor });
}

// ── Data em que o atleta entrou em transição (registro mais recente com status transição) ──
function dataInicioTransicao(athleteId) {
  const registros = assessmentsMedical
    .filter(m => {
      const st = (m?.dados?.statusAtual || m?.dados?.status || m?.status || "").toLowerCase();
      return m.athleteId === athleteId && st.includes("transi");
    })
    .sort((a, b) => (b.data || b.date || "").localeCompare(a.data || a.date || ""));
  return registros[0]?.data || registros[0]?.date || null;
}

// ── Injeta o último salto registrado quando o dia atual não tem salto ─────────
// Para atletas em transição, só considera saltos registrados APÓS a data de
// início da transição — evita usar dados pré-lesão para liberar fases RTP.
function injetarUltimoSalto(athleteId, dm, dateCutoff, dataMinima = null) {
  if (!dm || dm?.pre?.salto != null) return dm;
  const lastSalto = historico
    .filter(d =>
      d.athleteId === athleteId &&
      d.date < dateCutoff &&
      (dataMinima == null || d.date >= dataMinima) &&
      d.pre?.salto != null
    )
    .sort((a, b) => b.date.localeCompare(a.date))[0]?.pre?.salto;
  if (lastSalto == null) return dm;
  return { ...dm, pre: { ...(dm.pre || {}), salto: lastSalto } };
}

// ── Injeta o último lnRR (VFC) registrado quando o dia atual não tem HRV ──────
// Assim como o CMJ, a VFC do último dia coletado é a melhor estimativa para RTP
// quando não houve coleta de HRV no dia corrente.
function injetarUltimaVFC(athleteId, dm, dateCutoff) {
  if (!dm || dm?.hrv?.lnRR != null) return dm;
  const lastHrv = historico
    .filter(d => d.athleteId === athleteId && d.date < dateCutoff && d.hrv?.lnRR != null)
    .sort((a, b) => b.date.localeCompare(a.date))[0]?.hrv;
  if (lastHrv == null) return dm;
  return { ...dm, hrv: { ...(dm.hrv || {}), lnRR: lastHrv.lnRR } };
}

// ── Resolve a fase RTP com persistência histórica ─────────────────────────────
// Com dados hoje: calcula (respeitando faseSalva como piso) e salva se avançou.
// Sem dados hoje: usa faseSalva do Firestore → localStorage → fallback abs.
function resolverFaseRTP(statusMed, athleteId, dmHoje, hoje) {
  if (!statusMed || statusMed === "liberado") return null;
  if (statusMed === "afastado") return _buildFaseObj(0);

  const dataTransicao = dataInicioTransicao(athleteId);
  const faseSalva = rtpProgressMap[athleteId] ?? 0;
  const temDadosHoje = !!(dmHoje?.pre || dmHoje?.hrv || dmHoje?.neuro);

  // Se a fase salva é de antes da transição, ignora — atleta começa do F1
  const faseSalvaValida = (() => {
    if (faseSalva <= 0 || !dataTransicao) return faseSalva;
    // Verifica se houve algum salto registrado após a transição
    const temSaltoPosTrans = historico.some(
      d => d.athleteId === athleteId && d.date >= dataTransicao && d.pre?.salto != null
    );
    // F2+ exige salto pós-transição; sem ele, teto é F1
    if (!temSaltoPosTrans && faseSalva >= 2) return 1;
    return faseSalva;
  })();

  if (!temDadosHoje) {
    // 1. Fase salva no Firestore (fonte de verdade, já validada)
    if (faseSalvaValida > 0) return _buildFaseObj(faseSalvaValida);
    // 2. Cache localStorage (sessão anterior com dados)
    const cached = _carregarFaseRTP(athleteId);
    if (cached) return cached;
    // 3. Fallback: escala absoluta no último dia com dados (sem z-score)
    const dataTransicaoFallback = statusMed === 'transicao' ? dataInicioTransicao(athleteId) : null;
    const lastDm = historico
      .filter(d => {
        if (d.athleteId !== athleteId || d.date >= hoje || !(d.pre || d.hrv || d.neuro)) return false;
        // Para transição: só considera dias após início da transição
        if (dataTransicaoFallback && d.date < dataTransicaoFallback) return false;
        return true;
      })
      .sort((a, b) => b.date.localeCompare(a.date))[0];
    const lastDmEf = injetarUltimaVFC(athleteId, injetarUltimoSalto(athleteId, lastDm, lastDm?.date || hoje, dataTransicaoFallback), lastDm?.date || hoje);
    return _calcularFaseRTPHistorica(statusMed, lastDmEf);
  }

  // Tem dados hoje — injeta último salto e última VFC se não coletados hoje
  // Para transição: só usa saltos registrados APÓS o início da transição
  const dmEfetivo = injetarUltimaVFC(athleteId, injetarUltimoSalto(athleteId, dmHoje, hoje, dataTransicao || null), hoje);
  const calc = calcularProntidao(dmEfetivo, calcularBasalAtleta(athleteId));
  const fase = calcularFaseRTP(statusMed, { ...calc, dor: dmEfetivo?.pre?.dor ?? null }, faseSalvaValida);

  // Persiste localmente e no Firestore se a fase avançou
  _salvarFaseRTP(athleteId, fase);
  if (fase && fase.fase > faseSalvaValida) {
    rtpProgressMap[athleteId] = fase.fase;  // atualiza cache em memória
    salvarRTPProgressFirestore(athleteId, fase.fase);
  }

  return fase;
}

// ── ACWR: razão aguda (7d) / crônica (28d) ──────────────────────────────────
function calcularACWR(athleteId) {
  return _calcularACWR(athleteId, historico, _hoje());
}

// ── Texto e estilo visual do ACWR ─────────────────────────────────────────────
function labelACWR(acwr) {
  if (acwr === null) return { texto: "—", cor: "#9ca3af", bg: "#f3f4f6" };
  if (acwr < 0.8)  return { texto: `${acwr} ↓ subcarga`,   cor: "#1d4ed8", bg: "#dbeafe" };
  if (acwr <= 1.3) return { texto: `${acwr} ✓`,            cor: "#15803d", bg: "#dcfce7" };
  if (acwr <= 1.5) return { texto: `${acwr} ⚠`,            cor: "#b45309", bg: "#fef9c3" };
  return               { texto: `${acwr} ✕ risco`,        cor: "#b91c1c", bg: "#fee2e2" };
}

// ── ISP / Tendência — wrappers ────────────────────────────────────────────────
// ISP_PESOS, _ispRegression, _ispDP, _ispR2, classificarTendencia,
// classificarTendenciaGlobal: importados de stats.js (usados pelo código de render abaixo)

function calcularISPTendencia(athleteId) {
  return _calcularISPTendencia(athleteId, historico, _hoje());
}

// ── ISP para uma data específica — retorna { valor, baixaConfiabilidade } ────────
// valor = IGP (prontidão global 0-100) do atleta naquela data, calculado com basal
// construído a partir dos 21 dias anteriores à data.
function calcularISPParaData(athleteId, dataRef) {
  if (!athleteId || !dataRef) return null;
  const dmDia = historico.find(d => d.athleteId === athleteId && d.date === dataRef) ?? null;
  if (!dmDia) return null;
  const hist = historico
    .filter(d => d.athleteId === athleteId && d.date < dataRef)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-21);
  const vals = hist.map(d => calcularProntidao(d).global).filter(v => v != null);
  const baixaConfiabilidade = vals.length < 5;
  const basalData = vals.length >= 5 ? vals.reduce((a, b) => a + b, 0) / vals.length : 70;
  const calc = calcularProntidao(dmDia, basalData);
  if (calc.global == null) return null;
  return { valor: calc.global, baixaConfiabilidade };
}

// ── Versão de calcularMinutosRecomendados com dm e data explícitos ─────────────
function calcularMinutosRecomendadosComDm(athleteId, dmRaw, dataRef) {
  if (!dataRef) return calcularMinutosRecomendados(athleteId);
  const basalData = (() => {
    const hist = historico
      .filter(d => d.athleteId === athleteId && d.date < dataRef)
      .sort((a,b) => new Date(a.date) - new Date(b.date))
      .slice(-21);
    const vals = hist.map(d => calcularProntidao(d).global).filter(v => v != null);
    return vals.length >= 5 ? vals.reduce((a,b) => a+b, 0) / vals.length : 70;
  })();
  const calc      = calcularProntidao(dmRaw, basalData);
  const global    = calc.global;
  const statusMed = statusMedicoAtleta(athleteId);
  const faseRTP   = resolverFaseRTP(statusMed, athleteId, dmRaw, dataRef);

  if (global == null) {
    return { minutos: null, faixa: "—", classificacao: "Sem dados", obs: "Sem dados de prontidao", cor: "#9ca3af" };
  }
  if (statusMed === "afastado") {
    return { minutos: 0, faixa: "0 min", classificacao: "Protecao", obs: "Afastado — nao expor", cor: "#b91c1c" };
  }

  let teto = 90;
  if (statusMed === "transicao") {
    teto = global != null ? (global >= 70 ? 60 : global >= 60 ? 55 : global >= 50 ? 50 : 45) : 45;
  }

  const { INM, IA, IH, IC } = calc;
  const zG = zScoreGlobal(athleteId);
  const cmjCritico  = INM != null && INM < 40;
  const hrvCritico  = IA  != null && IA  < 40;
  const fadCritico  = IH  != null && IH  < 40;
  const cogCritico  = IC  != null && IC  < 40;
  const algumCritico = cmjCritico || hrvCritico || fadCritico || cogCritico;
  const combinacaoRestritiva = cmjCritico && (global ?? 50) < 50;
  const estadoAtual = global ?? 50;

  let classificacao, cor, faixa, minutos, obs;

  if (statusMed === "transicao") {
    const teto2 = estadoAtual >= 70 ? 60 : estadoAtual >= 60 ? 55 : estadoAtual >= 50 ? 50 : 45;
    minutos = teto2;
    classificacao = "Transicao"; cor = "#c2410c";
    obs = "Em transicao — exposicao limitada";
    if (faseRTP != null) {
      const tetoRTP = [0, 0, 30, 45, Infinity][faseRTP.fase] ?? 0;
      if (isFinite(tetoRTP)) minutos = Math.min(minutos, tetoRTP);
    }
    faixa = minutos + " min";
    return { minutos, faixa, classificacao, obs, cor };
  }

  // Delega para a lógica original trocando o filtroData temporariamente
  const _elFiltro = document.getElementById("filtroData");
  const _filtroAtual = _elFiltro?.value ?? hoje;
  if (_elFiltro) _elFiltro.value = dataRef;
  const resultado = calcularMinutosRecomendados(athleteId);
  if (_elFiltro) _elFiltro.value = _filtroAtual;
  return resultado;
}


function labelISPTendencia(ispTend) {
  if (!ispTend || !ispTend.global) return { icon: '—', label: 'Dados insuficientes', cor: '#9ca3af', bg: '#f3f4f6' };
  return { icon: ispTend.global.icon, label: ispTend.global.label, cor: ispTend.global.cor, bg: ispTend.global.bg };
}

// ── Basal individual: média dos últimos 21 dias de prontidão global ──────────
function calcularBasalAtleta(athleteId) {
  const hoje = document.getElementById("filtroData")?.value || new Date().toLocaleDateString('en-CA');
  const hist = historico
    .filter(d => d.athleteId === athleteId && d.date < hoje)
    .sort((a,b) => new Date(a.date) - new Date(b.date))
    .slice(-21);
  const vals = hist.map(d => calcularProntidao(d).global).filter(v => v != null);
  if (vals.length < 5) return 70; // fallback quando histórico insuficiente
  return vals.reduce((a,b) => a+b,0) / vals.length;
}

function media(arr){
  const v=arr.filter(x=>x!=null);
  if(!v.length) return "—";
  return (v.reduce((a,b)=>a+b,0)/v.length).toFixed(1);
}

// ================= FILTROS =================
function preencherFiltros(){
  const cats=[...new Set(atletas.map(a=>a.categoria).filter(Boolean))];
  const poss=[...new Set(atletas.map(a=>a.posicao).filter(Boolean))];

  const optsCategoria = `<option value="">Todas</option>`+cats.map(c=>`<option>${c}</option>`).join("");

  const catEl = document.getElementById("filtroCategoria");
  if (catEl) catEl.innerHTML = optsCategoria;

  const catSemEl = document.getElementById("filtroCategoriaSemanal");
  if (catSemEl) catSemEl.innerHTML = optsCategoria;

  const posEl = document.getElementById("filtroPosicao");
  if (posEl) posEl.innerHTML=
    `<option value="">Todas</option>`+poss.map(p=>`<option>${p}</option>`).join("");
}

// ================= MICROCICLO — banner contextual =================
function _getMicrocicloCtx() {
  function getISOWeek(d) {
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
    const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    return Math.ceil((((t - y) / 86400000) + 1) / 7);
  }
  const d = new Date();
  const semana = `S${getISOWeek(d)}-${d.getFullYear()}`;
  const clubId = JSON.parse(localStorage.getItem('userContext') || '{}').clubId || '';
  const raw = localStorage.getItem(`microciclo_${semana}_${clubId}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function calcularDiaMicrociclo() {
  // Manual reference set on planning page takes priority over auto-calculation
  const _clubId = JSON.parse(localStorage.getItem('userContext') || '{}').clubId || '';
  const _manual = _getMicrocicloManualDia(new Date().toLocaleDateString('en-CA'), _clubId);
  if (_manual?.label) return _manual;

  const ctx = _getMicrocicloCtx();
  if (!ctx) return null;
  const hoje = new Date(); hoje.setHours(0,0,0,0);
  const periodo = ctx.periodo || 'Preparação';

  function parseLocal(str) {
    const [y,m,d] = str.split('-').map(Number);
    const dt = new Date(y,m-1,d); dt.setHours(0,0,0,0); return dt;
  }
  function diffDias(a,b){ return Math.round((a-b)/86400000); }

  const objs = {
    D1:{label:'D1',objetivo:'Reativação',   detalhe:'Fortalecimento neuromuscular — início do ciclo de carga',               cor:'#3b82f6'},
    D2:{label:'D2',objetivo:'Sobrecarga I', detalhe:'Desenvolvimento metabólico — resistência aeróbica e capacidade glicolítica',cor:'#f97316'},
    D3:{label:'D3',objetivo:'Sobrecarga II',detalhe:'Pico de carga — força, alta solicitação neuromuscular',                     cor:'#ef4444'},
    D4:{label:'D4',objetivo:'Dissipação',   detalhe:'Redução de carga — início da dissipação da fadiga acumulada',               cor:'#8b5cf6'},
    D5:{label:'D5',objetivo:'Potenciação',  detalhe:'Baixo volume — manutenção da excitabilidade neural',                        cor:'#10b981'},
    D6:{label:'D6',objetivo:'Manutenção',   detalhe:'Carga e exigências física-cognitiva semelhantes ao jogo competitivo',       cor:'#6b7280'},
    D7:{label:'D7',objetivo:'Folga',        detalhe:'Folga — recuperação espontânea',                                            cor:'#9ca3af'},
  };

  if (!ctx.jogoA) {
    if (periodo === 'Preparação' || periodo === 'Transição') {
      const diasSemana = ['D7','D1','D2','D3','D4','D5','D6'];
      const labelEfetivo = diasSemana[hoje.getDay()];
      return { periodo, ...(objs[labelEfetivo]||objs['D7']) };
    }
    return { periodo, label:'—', objetivo:'Sem jogo cadastrado', detalhe:'', cor:'#9ca3af' };
  }

  const jogoA = parseLocal(ctx.jogoA);
  const jogoB = ctx.jogoB ? parseLocal(ctx.jogoB) : null;

  if (jogoB) {
    const dA = diffDias(hoje,jogoA), dB = diffDias(hoje,jogoB);
    if (dA===0) return {periodo,label:'Jogo A',  objetivo:'Competição',           detalhe:'Jogo — mobilização máxima de todos os sistemas',                        cor:'#1d4ed8'};
    if (dB===0) return {periodo,label:'Jogo B',  objetivo:'Competição',           detalhe:'Jogo — mobilização máxima de todos os sistemas',                        cor:'#1d4ed8'};
    if (dA===1) return {periodo,label:'MD+1',    objetivo:'Repouso ou Recovery',         detalhe:'Pico de fadiga pós-jogo — repouso e início da ressíntese de glicogênio',cor:'#8b5cf6'};
    if (dB===-1) return {periodo,label:'MD-1 (B)',objetivo:'Ativação',            detalhe:'Ativação leve — mobilização neural sem acúmulo de fadiga',              cor:'#10b981'};
    if (dB===-2) return {periodo,label:'MD-2 (B)',objetivo:'Reativação',          detalhe:'Recuperação parcial — reestimulação neuromuscular controlada',          cor:'#f59e0b'};
    return {periodo,label:'Semana dupla',objetivo:'Recuperação',detalhe:'Semana comprimida',cor:'#6b7280'};
  }

  const diff = diffDias(hoje,jogoA);
  const mapa = {
     '0':{label:'MD0', objetivo:'Competição',           detalhe:'Jogo — mobilização máxima de todos os sistemas',                        cor:'#1d4ed8'},
     '1':{label:'MD+1',objetivo:'Repouso ou Recovery',              detalhe:'Pico de fadiga pós-jogo — repouso e início da ressíntese de glicogênio',cor:'#8b5cf6'},
     '2':{label:'MD+2',objetivo:'Regenerativo',  detalhe:'Recuperação ativa — redução de metabólitos',                             cor:'#7c3aed'},
     '3':{label:'MD+3',objetivo:'Adaptação',detalhe:'Estímulo aeróbio e neuromuscular',                                      cor:'#6366f1'},
    '-3':{label:'MD-3',objetivo:'Potenciação',          detalhe:'Última sessão de alta carga — força e demanda neuromuscular elevada',    cor:'#ef4444'},
    '-2':{label:'MD-2',objetivo:'Reconstrução',         detalhe:'Redução de volume — velocidade e qualidade de movimento em foco',        cor:'#f97316'},
    '-1':{label:'MD-1',objetivo:'Ativação',             detalhe:'Baixo volume — ativação neural e preservação do estado de prontidão',    cor:'#10b981'},
  };
  if (diff <= -4) {
    const dow = hoje.getDay();
    if (dow === 1) return { periodo, label:'D1', objetivo:'Reativação',    detalhe:'Fortalecimento neuromuscular — início do ciclo de carga',               cor:'#3b82f6' };
    if (dow === 2) return { periodo, label:'D2', objetivo:'Sobrecarga I',  detalhe:'Desenvolvimento metabólico — resistência aeróbica e capacidade glicolítica',cor:'#f97316' };
    if (dow === 3) return { periodo, label:'D3', objetivo:'Sobrecarga II', detalhe:'Pico de carga — força, alta solicitação neuromuscular',                    cor:'#ef4444' };
  }
  return { periodo, ...(mapa[String(diff)] || {label:'—',objetivo:'Fora do microciclo',detalhe:'',cor:'#9ca3af'}) };
}

function _getMicrocicloManualDia(dateStr, clubId) {
  const raw = localStorage.getItem(`microciclo_dia_${dateStr}_${clubId}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function obterContextoMicrocicloFinal() {
  // Manual reference set by coach on the planning page takes priority
  const clubId = JSON.parse(localStorage.getItem('userContext') || '{}').clubId || '';
  const hojStr = new Date().toLocaleDateString('en-CA');
  const manual = _getMicrocicloManualDia(hojStr, clubId);
  if (manual?.label) return manual;

  const mc = calcularDiaMicrociclo();
  const label = mc?.label || '';
  if (label.startsWith('MD') || label === 'Jogo A' || label === 'Jogo B') return mc;

  if (!clubId) return mc;

  try {
    const hoje = new Date(); hoje.setHours(0,0,0,0);
    const hojStr = hoje.toISOString().slice(0,10);
    const d4ago  = new Date(hoje.getTime() - 4 * 86400000).toISOString().slice(0,10);
    const d4fte  = new Date(hoje.getTime() + 4 * 86400000).toISOString().slice(0,10);

    const snap = await getDocs(query(
      collection(db, 'scout_partidas'),
      where('clubId', '==', clubId)
    ));
    const todasPartidas = [];
    snap.forEach(d => {
      const p = d.data();
      if (p.data?.toDate) p.data = p.data.toDate().toLocaleDateString('en-CA');
      todasPartidas.push(p);
    });
    const partidas = todasPartidas.filter(p => typeof p.data === 'string' && p.data >= d4ago && p.data <= d4fte);
    if (!partidas.length) return mc;

    const passadas = partidas.filter(p => p.data < hojStr).sort((a,b) => b.data.localeCompare(a.data));
    const futuras  = partidas.filter(p => p.data > hojStr).sort((a,b) => a.data.localeCompare(b.data));
    const hojeJogo = partidas.some(p => p.data === hojStr);
    const periodo  = mc?.periodo || 'Competição';

    const mapaMais = {
      1: { label:'MD+1', objetivo:'Repouso ou Recovery',              detalhe:'Pico de fadiga pós-jogo — repouso e início da ressíntese de glicogênio', cor:'#8b5cf6' },
      2: { label:'MD+2', objetivo:'Regenerativo',  detalhe:'Retomada leve — monitorar VFC e dor muscular',                          cor:'#7c3aed' },
      3: { label:'MD+3', objetivo:'Adaptação', detalhe:'Estímulo aeróbio e neuromuscular',                                      cor:'#6366f1' },
    };
    const mapaMenos = {
      1: { label:'MD-1', objetivo:'Ativação',     detalhe:'Baixo volume — ativação neural e preservação do estado de prontidão', cor:'#10b981' },
      2: { label:'MD-2', objetivo:'Reconstrução', detalhe:'Redução de volume — velocidade e qualidade de movimento em foco',     cor:'#f97316' },
      3: { label:'MD-3', objetivo:'Potenciação',  detalhe:'Última sessão de alta carga — força e demanda neuromuscular elevada', cor:'#ef4444' },
    };

    if (hojeJogo) return { periodo, label:'MD0', objetivo:'Competição', detalhe:'Jogo — mobilização máxima de todos os sistemas', cor:'#1d4ed8' };

    if (futuras.length) {
      const diasAte = Math.round((new Date(futuras[0].data + 'T00:00:00') - hoje) / 86400000);
      if (diasAte <= 3 && mapaMenos[diasAte]) return { periodo, ...mapaMenos[diasAte] };
    }
    if (passadas.length) {
      const diasDesde = Math.round((hoje - new Date(passadas[0].data + 'T00:00:00')) / 86400000);
      if (diasDesde <= 3 && mapaMais[diasDesde]) return { periodo, ...mapaMais[diasDesde] };
    }
  } catch(e) {
    console.warn('obterContextoMicrocicloFinal:', e);
  }
  return mc;
}

async function renderBannerMicrociclo(containerId = 'bannerMicrociclo') {
  const el = document.getElementById(containerId);
  if (!el) return;
  const mc = await obterContextoMicrocicloFinal();
  if (!mc) { el.style.display = 'none'; return; }
  if (mc.label === '—') {
    if (mc.objetivo === 'Sem jogo cadastrado') {
      el.style.display = 'flex';
      el.style.flexWrap = 'wrap';
      el.innerHTML = `<span style="font-size:12px;color:#93c5fd;font-style:italic;">⚽ Cadastre um jogo no Planejamento para ver o contexto do microciclo.</span>`;
      return;
    }
    el.style.display = 'none'; return;
  }
  el.style.display = 'flex';
  el.style.flexWrap = 'wrap';
  el.innerHTML = `
    <span style="background:${mc.cor};color:#fff;font-size:12px;font-weight:800;padding:5px 14px;border-radius:20px;white-space:nowrap;letter-spacing:.03em;">${mc.label}</span>
    <span style="font-size:13px;font-weight:700;color:#ffffff;">${mc.objetivo}</span>
    <span style="font-size:11px;color:#93c5fd;flex:1;min-width:80px;">${mc.detalhe}</span>
    <span style="font-size:11px;color:#64748b;background:#f1f5f9;padding:2px 10px;border-radius:20px;white-space:nowrap;">Período · ${mc.periodo}</span>
  `;
}

async function sincronizarMicrocicloFirestore() {
  try {
    const clubId = JSON.parse(localStorage.getItem('userContext') || '{}').clubId || '';
    if (!clubId) return;

    const hoje = new Date();
    function getISOWeek(d) {
      const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
      t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
      const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
      return Math.ceil((((t - y) / 86400000) + 1) / 7);
    }
    const semana = `S${getISOWeek(hoje)}-${hoje.getFullYear()}`;
    const chave  = `microciclo_${semana}_${clubId}`;

    const snap = await getDoc(doc(db, 'assessments_planning', `${semana}_${clubId}`));
    if (!snap.exists()) return;

    const data = snap.data();
    const sorted = [...(data.jogos || [])].sort((a, b) => a.data.localeCompare(b.data));

    localStorage.setItem(chave, JSON.stringify({
      jogoA:        sorted[0]?.data || null,
      jogoB:        sorted[1]?.data || null,
      periodo:      data.periodo    || 'Preparação',
      jogos:        data.jogos      || [],
      diasComTreino: Object.entries(data.sessions || {})
        .filter(([, v]) => v && v.length > 0)
        .map(([dia]) => dia),
    }));

    // Constrói mapa inverso athleteId → grupo
    if (data.gruposAtletas) {
      _gruposPront = {};
      Object.entries(data.gruposAtletas).forEach(([grupo, ids]) => {
        (ids || []).forEach(id => { _gruposPront[id] = grupo; });
      });
    }

    // Restaura rótulo manual do dia atual (microciclo_dias) se não estiver no localStorage
    const hojStr = hoje.toLocaleDateString('en-CA');
    const chaveManual = `microciclo_dia_${hojStr}_${clubId}`;
    if (!localStorage.getItem(chaveManual)) {
      const snapDia = await getDoc(doc(db, 'microciclo_dias', `${hojStr}_${clubId}`));
      if (snapDia.exists()) {
        const { label, objetivo, detalhe, cor, periodo } = snapDia.data();
        localStorage.setItem(chaveManual, JSON.stringify({ label, objetivo, detalhe, cor, periodo }));
      }
    }

    await renderBannerMicrociclo('bannerMicrociclo');
  } catch(e) {
    console.warn('sincronizarMicrocicloFirestore:', e);
  }
}

// ================= NOVOS HELPERS — RELATÓRIO DIÁRIO =================

function getSistemaMaisAfetadoSemana(athleteId, dataRef) {
  const dataRefDate = new Date(dataRef + "T00:00:00");
  // Janela = segunda-feira da semana que contém dataRef até dataRef (sem cruzar semanas)
  const dowRef = dataRefDate.getDay(); // 0=Dom, 1=Seg … 6=Sab
  const inicioSemana = new Date(dataRefDate);
  inicioSemana.setDate(dataRefDate.getDate() - (dowRef === 0 ? 6 : dowRef - 1));
  const inicioStr = inicioSemana.toLocaleDateString('en-CA');

  const sistemasDados = [
    { nome: "Subjetivo",     limiar: 70, key: "IH"  },
    { nome: "Autonômico",    limiar: 70, key: "IA"  },
    { nome: "Neuromuscular", limiar: 60, key: "INM" },
    { nome: "Cognitivo",     limiar: 70, key: "IC"  },
  ];

  const resultados = sistemasDados.map(({ nome, limiar, key }) => {
    const registrosNaJanela = historico
      .filter(d => {
        if (d.athleteId !== athleteId) return false;
        const diff = Math.round((dataRefDate - new Date(d.date + "T00:00:00")) / 86400000);
        return diff >= 0 && d.date >= inicioStr;
      })
      .sort((a, b) => b.date.localeCompare(a.date));

    let scoreVal = null;
    let diasDesde = null;

    for (const reg of registrosNaJanela) {
      const calc = calcularProntidao(reg);
      const val = calc[key];
      if (val != null) {
        scoreVal = val;
        diasDesde = Math.round((dataRefDate - new Date(reg.date + "T00:00:00")) / 86400000);
        break;
      }
    }

    if (scoreVal == null || diasDesde == null || diasDesde >= 5) return null;

    const scoreAjustado = Math.max(0, scoreVal - diasDesde * 2);
    const ratio = scoreAjustado / limiar;

    let confianca;
    if (diasDesde === 0)     confianca = "alta";
    else if (diasDesde <= 2) confianca = "moderada";
    else                     confianca = "baixa";

    return { nome, score: Math.round(scoreAjustado), diasDesde, confianca, ratio };
  }).filter(Boolean);

  if (!resultados.length) return null;
  const pior = resultados.reduce((a, b) => a.ratio <= b.ratio ? a : b);
  // Só retorna se estiver abaixo do limiar (ratio < 1)
  return pior.ratio < 1 ? pior : null;
}

function classificarResultadoDia({ global, custoEntrada, carga, sistemaSemana }) {
  if (global == null || carga == null) {
    return { classificacao: "Sem dados suficientes", labelChegada: "—" };
  }

  let labelChegada;
  if      (global >= 70) labelChegada = "Estável";
  else if (global >= 60) labelChegada = "Atenção Leve";
  else if (global >= 50) labelChegada = "Atenção";
  else                   labelChegada = "Crítico";

  let classificacao;
  if (global < 50 || (custoEntrada != null && custoEntrada >= 15 && carga >= 600)) {
    classificacao = "Sobrecarga do dia";
  } else if (global < 60 && carga >= 600) {
    classificacao = "Dia pesado";
  } else if (global >= 70 && carga >= 300 && (custoEntrada == null || custoEntrada <= 9)) {
    classificacao = "Boa tolerância";
  } else {
    classificacao = "Resposta compatível";
  }

  return { classificacao, labelChegada };
}

function calcularRespostaTreino(athleteId, dataRef) {
  const anterior = historico
    .filter(d => d.athleteId === athleteId && d.date < dataRef && (d.pre || d.hrv || d.neuro))
    .sort((a, b) => b.date.localeCompare(a.date))[0];

  if (!anterior) return null;

  const basal = calcularBasalAtleta(athleteId);
  const calcAnterior = calcularProntidao(anterior, basal);
  const igpOntem = calcAnterior.global;
  if (igpOntem == null) return null;

  const dmHoje = daily.find(d => d.athleteId === athleteId);
  const calcHoje = calcularProntidao(dmHoje, basal);
  const igpHoje = calcHoje.global;
  if (igpHoje == null) return null;

  const custoSessao = Math.max(0, +(igpOntem - igpHoje).toFixed(1));

  let classificacao;
  if (custoSessao <= 4)      classificacao = "Baixo custo";
  else if (custoSessao <= 8) classificacao = "Moderado";
  else                       classificacao = "Alto custo";

  return { igpOntem: +igpOntem.toFixed(1), igpHoje: +igpHoje.toFixed(1), custoSessao, classificacao, cargaOntem: anterior?.post?.carga ?? null };
}

function gerarFraseResultadoDia({ global, carga, sistemaSemana, leituraDia }) {
  let p1;
  if      (global == null) p1 = "Sem dado de chegada.";
  else if (global >= 70)   p1 = "Chegou dentro do seu padrão habitual.";
  else if (global >= 60)   p1 = "Chegou com leve queda em relação ao seu basal.";
  else if (global >= 50)   p1 = "Chegou abaixo do seu padrão habitual.";
  else                     p1 = "Chegou com queda importante de prontidão.";

  let p2;
  if      (carga == null) p2 = "Carga não registrada.";
  else if (carga < 300)   p2 = "Recebeu carga regenerativa.";
  else if (carga < 600)   p2 = "Recebeu carga moderada.";
  else if (carga < 800)   p2 = "Recebeu carga alta.";
  else                    p2 = "Recebeu carga muito alta.";

  const p3 = sistemaSemana?.nome
    ? `Sistema mais afetado na semana: ${sistemaSemana.nome.toLowerCase()}.`
    : "Sistema mais afetado na semana: não identificado.";

  const cl = leituraDia?.classificacao;
  let p4;
  if      (cl === "Boa tolerância")      p4 = "O dia foi bem tolerado.";
  else if (cl === "Resposta compatível") p4 = "A sessão gerou perturbação compatível com a condição inicial.";
  else if (cl === "Dia pesado")          p4 = "A sessão foi pesada para o estado em que o atleta iniciou o dia.";
  else if (cl === "Sobrecarga do dia")   p4 = "A exposição do dia foi elevada para um atleta já abaixo do seu padrão.";
  else                                   p4 = "Dados insuficientes para leitura do dia.";

  return [p1, p2, p3, p4].join(" ");
}

// ── Resumo coletivo para o PDF diário ────────────────────────────────────────
// Narra como o elenco chegou frente à carga recebida na sessão anterior.
function gerarResumoColetivo(rows) {
  function avg(arr) { const v = arr.filter(x => x != null); return v.length ? v.reduce((a,b)=>a+b,0)/v.length : null; }

  const mediaPront      = avg(rows.map(r => r.global));
  const mediaCusto      = avg(rows.map(r => r.custoEntrada));
  const mediaCargaOntem = avg(rows.map(r => r.respostaTreino?.cargaOntem));

  const sistemasGrupo = rows.map(r => r.sistemaSemana?.nome).filter(Boolean);
  const sistemaMaisFreq = sistemasGrupo.length
    ? Object.entries(sistemasGrupo.reduce((acc, s) => { acc[s]=(acc[s]||0)+1; return acc; }, {}))
        .sort((a,b)=>b[1]-a[1])[0][0]
    : "—";

  const comDado      = rows.filter(r => r.global != null);
  const nEstaveis    = comDado.filter(r => r.global >= 70).length;
  const nAtencaoLeve = comDado.filter(r => r.global >= 60 && r.global < 70).length;
  const nAtencao     = comDado.filter(r => r.global >= 50 && r.global < 60).length;
  const nCriticos    = comDado.filter(r => r.global < 50).length;

  const partes = [];
  if (nEstaveis > 0)    partes.push(`${nEstaveis} Estável${nEstaveis > 1 ? 'is' : ''}`);
  if (nAtencaoLeve > 0) partes.push(`${nAtencaoLeve} Atenção Leve`);
  if (nAtencao > 0)     partes.push(`${nAtencao} Atenção`);
  if (nCriticos > 0)    partes.push(`${nCriticos} Crítico${nCriticos > 1 ? 's' : ''}`);
  const distTxt = partes.length ? partes.join(', ') : 'Sem dados suficientes';

  let ctxFrase = '';
  if (mediaCargaOntem != null && mediaPront != null) {
    if (mediaCargaOntem >= 600) {
      if (mediaPront >= 70)
        ctxFrase = 'Apesar da carga elevada aplicada, o elenco apresentou boa recuperação e chegou em condição estável.';
      else if (mediaPront >= 60)
        ctxFrase = 'A carga elevada da sessão anterior gerou leve queda — monitorar individualmente os atletas em Atenção.';
      else
        ctxFrase = 'A carga elevada da sessão anterior impactou significativamente a chegada do elenco — atenção redobrada ao estado de recuperação.';
    } else if (mediaCargaOntem >= 300) {
      if (mediaPront >= 70)
        ctxFrase = 'O elenco tolerou bem a carga moderada e chegou dentro do padrão esperado.';
      else if (mediaPront >= 60)
        ctxFrase = 'Parte do elenco chegou abaixo do padrão mesmo com carga moderada — verificar qualidade do sono e da recuperação.';
      else
        ctxFrase = 'O elenco chegou abaixo do esperado frente à carga moderada aplicada — investigar fatores extracampo.';
    } else {
      if (mediaPront >= 70)
        ctxFrase = 'A carga leve/regenerativa da sessão anterior favoreceu a recuperação e o elenco chegou em boas condições.';
      else
        ctxFrase = 'Mesmo com carga leve, parte do elenco chegou abaixo do padrão — verificar outros fatores de recuperação.';
    }
  } else if (mediaCargaOntem == null && mediaPront != null) {
    if (mediaPront >= 70)
      ctxFrase = 'Carga da sessão anterior não registrada — elenco chegou em condição estável.';
    else
      ctxFrase = 'Carga da sessão anterior não registrada — considerar monitoramento individual.';
  }

  return (
    `O elenco chegou com prontidão média <strong>${mediaPront != null ? mediaPront.toFixed(1) : '—'}</strong>` +
    (mediaCargaOntem != null
      ? ` após carga média de <strong>${Math.round(mediaCargaOntem)} UA</strong> na sessão anterior`
      : '') +
    `. Distribuição de chegada: <strong>${distTxt}</strong>.` +
    (mediaCusto != null ? ` Custo médio de entrada: <strong>${mediaCusto.toFixed(1)} pts</strong>.` : '') +
    ` Sistema mais afetado na semana: <strong>${sistemaMaisFreq.toLowerCase()}</strong>.` +
    (ctxFrase ? ` ${ctxFrase}` : '')
  );
}

// ================= RENDER =================
function aplicarFiltros(){
  const categoria=document.getElementById("filtroCategoria")?.value ?? "";
  const posicao=document.getElementById("filtroPosicao")?.value ?? "";
  const filtroGrupo=document.getElementById("filtroGrupo")?.value ?? "";

  const temPartida = Object.keys(minutosByAthleta).length > 0;

  let lista=atletas;
  if(categoria) lista=lista.filter(a=>a.categoria===categoria);
  if(posicao) lista=lista.filter(a=>a.posicao===posicao);
  if(filtroGrupo) {
    lista=lista.filter(a => (gruposByAthleta[a.id] || _gruposPront[a.id]) === filtroGrupo);
  }

  const hoje = document.getElementById("filtroData")?.value || new Date().toLocaleDateString('en-CA');
  const microcicloStart = getMicrocicloStart(hoje);
  const rows=lista.map(a=>{
    const dm=daily.find(d=>d.athleteId===a.id);
    const calc=calcularProntidao(dm, calcularBasalAtleta(a.id));
    const acwr    = calcularACWR(a.id);
    const ispTend = calcularISPTendencia(a.id);
    const segJogados = minutosByAthleta[a.id] ?? null;

    const statusMed = statusMedicoAtleta(a.id);
    const faseRTP   = resolverFaseRTP(statusMed, a.id, dm, hoje);
    const fb = calcularFallbacksMicrociclo(a.id, calc, hoje, microcicloStart);

    return{
      id:a.id,
      nome:a.nome,
      posicao:a.posicao,
      fotoUrl:a.fotoUrl||'',
      global:calc.global,
      status:calc.status,
      acwr,
      ispTend,
      carga:dm?.post?.carga,
      volume:dm?.post?.tempo ?? null,
      pse:dm?.post?.pse ?? null,
      densidade:dm?.post?.densidade,
      indicadores:calc,
      IH: calc.IH, IA: calc.IA, INM: calc.INM, IC: calc.IC,
      IH_fb: fb.IH, IA_fb: fb.IA, INM_fb: fb.INM, IC_fb: fb.IC,
      humorEmocional: dm?.pre?.humorEmocional ?? null,
      fatorEmocional: dm?.scores?.fatorEmocional ?? null,
      fatorAplicado:  dm?.scores?.fatorAplicado  ?? false,
      maisPrejudicado: calc.maisPrejudicado,
      custoGlobal: calc.custoGlobal,
      sistemaSemana: getSistemaMaisAfetadoSemana(a.id, hoje),
      minJogados: segJogados != null ? Math.round(segJogados/60) : null,
      statusMed,
      faseRTP,
      afastadoAdmin:  !!(a.afastadoAdmin),
      motivoAdmin:    a.motivoAdmin || '',
    };
  });

  renderCards(rows);
  renderTabela(rows);
  renderBannerMicrociclo('bannerMicrociclo');
  sincronizarMicrocicloFirestore();
}

// ================= CARDS =================
function renderCards(rows){
  // Sistema mais afetado do grupo (semana)
  const sistemasGrupo = rows.map(r => r.sistemaSemana?.nome).filter(Boolean);
  const sistemaMaisFreq = sistemasGrupo.length
    ? Object.entries(sistemasGrupo.reduce((acc,s)=>{ acc[s]=(acc[s]||0)+1; return acc; }, {}))
        .sort((a,b)=>b[1]-a[1])[0][0]
    : null;
  const nSistema = sistemasGrupo.filter(s => s === sistemaMaisFreq).length;

  // Custo médio de entrada
  const mediaCusto = media(rows.map(r => r.custoGlobal));
  const mediaCustoNum = parseFloat(mediaCusto);
  const lCusto = labelCustoEntrada(isNaN(mediaCustoNum) ? null : mediaCustoNum);

  // Breakdown por classificação de CBT — todas as 4 sempre visíveis
  const custoCats = [
    { label: "CBT baixo",     range: "≤4",    color: "#15803d", count: rows.filter(r => r.custoGlobal != null && r.custoGlobal <= 4).length },
    { label: "CBT leve",      range: "5–9",   color: "#a16207", count: rows.filter(r => r.custoGlobal != null && r.custoGlobal > 4  && r.custoGlobal <= 9).length },
    { label: "CBT moderado",  range: "10–14", color: "#c2410c", count: rows.filter(r => r.custoGlobal != null && r.custoGlobal > 9  && r.custoGlobal <= 14).length },
    { label: "CBT alto",      range: ">14",   color: "#b91c1c", count: rows.filter(r => r.custoGlobal != null && r.custoGlobal > 14).length },
  ];

  // Cores discretas por sistema
  function corSistema(nome) {
    if (nome === "Neuromuscular") return { text:"#6d28d9", bg:"#ede9fe" };
    if (nome === "Subjetivo")     return { text:"#1d4ed8", bg:"#dbeafe" };
    if (nome === "Autonômico")    return { text:"#0f766e", bg:"#ccfbf1" };
    if (nome === "Cognitivo")     return { text:"#9d174d", bg:"#fce7f3" };
    return                               { text:"#6b7280", bg:"#f3f4f6" };
  }
  const cs = corSistema(sistemaMaisFreq);

  const _cardsMediosEl = document.getElementById("cardsMedios");
  if (!_cardsMediosEl) return;
  _cardsMediosEl.innerHTML=`
    ${cardHTML("prontidao","Prontidão Geral Média",
      "Índice Geral",
      media(rows.map(r=>r.global)), labelProntidao)}

    ${cardHTML("carga","Carga Média",
      "Carga interna diária (PSE × Volume)",
      media(rows.map(r=>r.carga)), labelCarga)}

    <div id="card-volume-pse"
         class="bg-white p-4 rounded border cursor-pointer hover:shadow-lg hover:-translate-y-1 transition transform duration-200 text-center">
      <div class="text-sm text-gray-500">Volume & PSE</div>
      <div class="text-xs text-gray-400 mb-2">Tempo médio (min) · PSE médio</div>
      <div class="flex justify-center gap-6 mt-1">
        <div>
          <div class="text-xl font-bold text-blue-600">${media(rows.map(r=>r.volume)) ?? "—"}</div>
          <div class="text-xs text-gray-400">min</div>
        </div>
        <div class="border-l border-gray-200"></div>
        <div>
          <div class="text-xl font-bold text-orange-500">${media(rows.map(r=>r.pse)) ?? "—"}</div>
          <div class="text-xs text-gray-400">PSE</div>
        </div>
      </div>
    </div>

    <div class="bg-gray-50 p-3 rounded border border-dashed border-gray-200 text-center flex flex-col justify-center gap-1">
      <div class="text-xs text-gray-400 font-semibold uppercase tracking-wide">Custo Biológico do Treino</div>
      <div class="text-xs text-gray-300 -mt-0.5">queda do IGP vs. basal individual</div>
      <div class="text-xl font-bold text-gray-700">${mediaCusto ?? "—"} <span class="text-sm font-normal text-gray-400">pts</span></div>
      ${lCusto ? `<span style="display:inline-block;margin:0 auto;padding:2px 9px;border-radius:999px;font-size:10px;font-weight:600;background:${lCusto.bg};color:${lCusto.color};">${lCusto.text}</span>` : ""}
      <div style="display:flex;flex-direction:column;gap:2px;margin-top:5px;text-align:left;">${custoCats.map(c=>`<div style="display:flex;justify-content:space-between;font-size:9px;"><span style="color:${c.color};font-weight:600;">● ${c.label} <span style="opacity:.6;">(${c.range})</span></span><span style="color:${c.color};font-weight:800;">${c.count} atleta${c.count !== 1 ? 's' : ''}</span></div>`).join("")}</div>
    </div>

    <div class="bg-gray-50 p-3 rounded border border-dashed border-gray-200 text-center flex flex-col justify-center gap-1">
      <div class="text-xs text-gray-400 font-semibold uppercase tracking-wide">Sistema + Afetado</div>
      ${sistemaMaisFreq
        ? `<div class="text-sm font-bold" style="color:${cs.text};">${sistemaMaisFreq}</div>
           <span style="display:inline-block;margin:0 auto;padding:2px 8px;border-radius:999px;font-size:10px;font-weight:600;background:${cs.bg};color:${cs.text};">${nSistema} atleta${nSistema !== 1 ? 's' : ''} · semana</span>`
        : `<div class="text-sm text-gray-300">—</div>`}
    </div>

    <div id="graficoCard"
         class="col-span-5 hidden bg-white p-4 border rounded-lg shadow-sm mt-2">
      <canvas id="graficoGeral" height="110"></canvas>
    </div>
  `;

  ativarCards();
}

function labelProntidao(v){
  if(v == null) return null;
  if(v >= 70) return { text: "Estável",       bg: "#dcfce7", color: "#15803d" };
  if(v >= 60) return { text: "Atenção Leve",  bg: "#fef9c3", color: "#a16207" };
  if(v >= 50) return { text: "Atenção",       bg: "#ffedd5", color: "#c2410c" };
  return              { text: "Crítico",       bg: "#fee2e2", color: "#b91c1c" };
}

function labelCarga(v){
  if(v == null) return null;
  if(v >= 800) return { text: "Muito Alta",   bg: "#fee2e2", color: "#b91c1c" };
  if(v >= 600) return { text: "Alta",         bg: "#ffedd5", color: "#c2410c" };
  if(v >= 300) return { text: "Moderada",     bg: "#dcfce7", color: "#15803d" };
  return              { text: "Regenerativa", bg: "#dbeafe", color: "#1d4ed8" };
}

function labelCustoEntrada(v){
  if(v == null) return null;
  if(v <= 4)  return { text: "CBT baixo",    bg: "#dcfce7", color: "#15803d" };
  if(v <= 9)  return { text: "CBT leve",     bg: "#fef9c3", color: "#a16207" };
  if(v <= 14) return { text: "CBT moderado", bg: "#ffedd5", color: "#c2410c" };
  return              { text: "CBT alto",    bg: "#fee2e2", color: "#b91c1c" };
}

function labelDensidade(v){
  if(v == null) return null;
  if(v >= 5)   return { text: "Muito Alta", bg: "#fee2e2", color: "#b91c1c" };
  if(v >= 3.5) return { text: "Alta",       bg: "#ffedd5", color: "#c2410c" };
  if(v >= 2)   return { text: "Moderada",   bg: "#fef9c3", color: "#a16207" };
  return              { text: "Baixa",      bg: "#dcfce7", color: "#15803d" };
}

function tagHTML(label){
  if(!label) return "";
  return `<span style="display:inline-block;margin-top:6px;padding:2px 10px;border-radius:999px;font-size:11px;font-weight:600;background:${label.bg};color:${label.color};">${label.text}</span>`;
}

function cardHTML(id,titulo,legenda,valor,labelFn){
  return `
    <div id="card-${id}"
         class="bg-white p-4 rounded border cursor-pointer
                hover:shadow-lg hover:-translate-y-1
                transition transform duration-200 text-center">

      <div class="text-sm text-gray-500">${titulo}</div>
      <div class="text-xs text-gray-400 mb-2">${legenda}</div>
      <div class="text-2xl font-bold">${valor ?? "—"}</div>
      ${(()=>{ const n = typeof valor === "string" ? parseFloat(valor) : valor; return (labelFn && n != null && !isNaN(n)) ? tagHTML(labelFn(n)) : ""; })()}
    </div>
  `;
}

function ativarCards(){
  ["prontidao","carga"].forEach(tipo=>{
    document.getElementById("card-"+tipo)
      ?.addEventListener("click",()=>toggleGraficoCard(tipo));
  });
  // Card Volume+PSE abre gráfico combinado
  document.getElementById("card-volume-pse")
    ?.addEventListener("click",()=>toggleGraficoCard("volume-pse"));
}

function toggleGraficoCard(tipo){

  const container=document.getElementById("graficoCard");

  if(container.dataset.tipo===tipo && !container.classList.contains("hidden")){
    container.classList.add("hidden");
    container.dataset.tipo="";
    if(graficoCardAtual) graficoCardAtual.destroy();
    return;
  }

  container.classList.remove("hidden");
  container.dataset.tipo=tipo;

  // Filtra historico pelos atletas atualmente visíveis (respeita filtro de posição/categoria)
  const categoria = document.getElementById("filtroCategoria")?.value || "";
  const posicao   = document.getElementById("filtroPosicao")?.value   || "";
  const atletasFiltrados = atletas.filter(a =>
    (!categoria || a.categoria === categoria) &&
    (!posicao   || a.posicao   === posicao)
  );
  const idsVisiveis = new Set(atletasFiltrados.map(a => a.id));

  // Agrupar por data e calcular média dos atletas filtrados
  const porData = {};
  historico.forEach(d => {
    const dt = d.date;
    if(!dt || !idsVisiveis.has(d.athleteId)) return;
    if(!porData[dt]) porData[dt] = [];
    if(tipo==="prontidao"){
      const calc = calcularProntidao(d);
      if(calc.global != null) porData[dt].push(calc.global);
    } else if(tipo==="carga" && d?.post?.carga != null){
      porData[dt].push(d.post.carga);
    } else if(tipo==="volume-pse"){
      // Guardamos [volume, pse] como par
      if(d?.post?.tempo != null || d?.post?.pse != null)
        porData[dt].push({ volume: d?.post?.tempo ?? null, pse: d?.post?.pse ?? null });
    }
  });

  const dataSelecionada = document.getElementById("filtroData")?.value || "";
  const datas = Object.keys(porData)
    .filter(dt => porData[dt].length > 0)
    .sort()
    .slice(-14);

  const labelTipo = tipo==="prontidao" ? "Prontidão Média" : tipo==="carga" ? "Carga Média" : tipo==="volume-pse" ? "Volume & PSE" : tipo;

  if(graficoCardAtual) graficoCardAtual.destroy();

  // ── Gráfico Volume + PSE (combinado: barra volume + linha PSE) ───────────────
  if(tipo === "volume-pse") {
    const volVals = datas.map(dt => {
      const arr = porData[dt];
      const vols = arr.map(p => p.volume).filter(v => v != null);
      return vols.length ? vols.reduce((a,b) => a+b,0)/vols.length : null;
    });
    const pseVals = datas.map(dt => {
      const arr = porData[dt];
      const pses = arr.map(p => p.pse).filter(v => v != null);
      return pses.length ? pses.reduce((a,b) => a+b,0)/pses.length : null;
    });
    const bgColors = datas.map(dt => dt === dataSelecionada ? "rgba(99,102,241,0.8)" : "rgba(59,130,246,0.6)");
    graficoCardAtual = new Chart(document.getElementById("graficoGeral"), {
      type: "bar",
      data: {
        labels: datas,
        datasets: [
          {
            type: "bar",
            data: volVals,
            backgroundColor: bgColors,
            borderRadius: 4,
            label: "Volume (min)",
            yAxisID: "yVol",
            order: 2
          },
          {
            type: "line",
            data: pseVals,
            borderColor: "rgba(249,115,22,1)",
            backgroundColor: "transparent",
            borderWidth: 2.5,
            pointRadius: datas.map(dt => dt === dataSelecionada ? 7 : 4),
            pointBackgroundColor: datas.map(dt => dt === dataSelecionada ? "#6366f1" : "rgba(249,115,22,1)"),
            label: "PSE",
            yAxisID: "yPSE",
            tension: 0.3,
            order: 1
          },
          {
            type: "line",
            data: datas.map(() => VOLUME_JOGO_REF),
            borderColor: "rgba(234,179,8,0.9)",
            backgroundColor: "transparent",
            borderWidth: 1.5,
            borderDash: [6, 4],
            pointRadius: 0,
            label: `Ref. Jogo (${VOLUME_JOGO_REF} min)`,
            yAxisID: "yVol",
            tension: 0,
            order: 3
          }
        ]
      },
      options: {
        responsive: true,
        aspectRatio: 4,
        plugins: {
          legend: { display: true, labels: { font: { size: 11 } } },
          tooltip: { mode: "index", intersect: false,
            callbacks: { label: ctx => ctx.dataset.label+": "+( ctx.parsed.y?.toFixed(1) ?? "—") }
          }
        },
        scales: {
          yVol: { type: "linear", position: "left", beginAtZero: true, ticks: { font: { size: 11 } }, title: { display: true, text: "Minutos", font: { size: 10 } } },
          yPSE: { type: "linear", position: "right", min: 0, max: 10, grid: { drawOnChartArea: false }, ticks: { font: { size: 11 } }, title: { display: true, text: "PSE (0–10)", font: { size: 10 } } },
          x: { ticks: { font: { size: 11 }, color: ctx => datas[ctx.index] === dataSelecionada ? "#6366f1" : "#666" } }
        }
      }
    });
    return;
  }

  // ── Gráficos padrão (prontidão linha / carga barra) ──────────────────────────
  const valores = datas.map(dt => {
    const arr = porData[dt];
    return arr.reduce((a,b)=>a+b,0) / arr.length;
  });

  const mediaVal = valores.length ? valores.reduce((a,b)=>a+b,0) / valores.length : 0;
  const isBarra = tipo === "carga";

  const bgColors = datas.map(dt =>
    dt === dataSelecionada
      ? (isBarra ? "rgba(99,102,241,0.85)" : "rgba(99,102,241,0.85)")
      : (isBarra ? "rgba(59,130,246,0.65)" : "rgba(59,130,246,0.12)")
  );
  const borderColors = datas.map(dt =>
    dt === dataSelecionada ? "rgba(99,102,241,1)" : "rgba(59,130,246,1)"
  );
  const pointColors = datas.map(dt =>
    dt === dataSelecionada ? "rgba(99,102,241,1)" : "rgba(59,130,246,1)"
  );
  const pointRadii = datas.map(dt => dt === dataSelecionada ? 7 : 4);

  graficoCardAtual = new Chart(document.getElementById("graficoGeral"),{
    type: isBarra ? "bar" : "line",
    data:{
      labels: datas,
      datasets:[
        {
          data: valores,
          borderColor: isBarra ? borderColors : "rgba(59,130,246,1)",
          backgroundColor: bgColors,
          borderWidth: isBarra ? 1 : 2,
          fill: !isBarra,
          tension:0.3,
          pointRadius: isBarra ? 0 : pointRadii,
          pointHoverRadius: isBarra ? 0 : 8,
          pointBackgroundColor: pointColors,
          label: labelTipo,
          borderRadius: isBarra ? 4 : 0
        },
        {
          data: datas.map(()=>mediaVal),
          borderColor:"rgba(239,68,68,0.8)",
          backgroundColor:"transparent",
          borderWidth:2,
          borderDash:[6,4],
          pointRadius:0,
          label:"Média do período",
          tension:0,
          type: "line"
        },
        ...(isBarra ? [{
          data: datas.map(() => CARGA_JOGO_REF),
          borderColor: "rgba(234,179,8,0.9)",
          backgroundColor: "transparent",
          borderWidth: 1.5,
          borderDash: [6, 4],
          pointRadius: 0,
          label: `Ref. Jogo (${CARGA_JOGO_REF} u.a.)`,
          tension: 0,
          type: "line"
        }] : [])
      ]
    },
    options:{
      responsive:true,
      aspectRatio: 4,
      plugins:{
        legend:{display:true, labels:{font:{size:11}}},
        tooltip:{mode:"index", intersect:false,
          callbacks:{ label: ctx => ctx.dataset.label+": "+ctx.parsed.y.toFixed(1) }
        }
      },
      scales:{
        y:Object.assign({min:0, ticks:{font:{size:11}}}, !isBarra ? {max:100} : {beginAtZero:true}),
        x:{ticks:{font:{size:11},
          color: ctx => datas[ctx.index] === dataSelecionada ? "#6366f1" : "#666"
        }}
      }
    }
  });
}

// ================= TABELA =================
function corLinha(status, ispTend, global) {
  if (global == null || !ispTend?.global) return "";
  if (ispTend.global.label === 'Piorando') return "bg-red-50";
  if (ispTend.global.label === 'Estável')  return "bg-yellow-50";
  return "";
}

function renderTabela(rows){

  // Ordena: afastados → transição → liberados por IGP crescente; admin (restrito) no final
  rows.sort((a,b)=>{
    if (a.afastadoAdmin && !b.afastadoAdmin) return 1;
    if (!a.afastadoAdmin && b.afastadoAdmin) return -1;
    if (a.afastadoAdmin && b.afastadoAdmin) return (a.nome||'').localeCompare(b.nome||'', 'pt-BR');
    const medPrio = s => s === "afastado" ? 0 : s === "transicao" ? 1 : 2;
    const gA = medPrio(a.statusMed ?? "liberado");
    const gB = medPrio(b.statusMed ?? "liberado");
    if(gA !== gB) return gA - gB;
    // Dentro do mesmo grupo: pior IGP primeiro, sem dados no final
    if(a.global == null && b.global == null) return 0;
    if(a.global == null) return 1;
    if(b.global == null) return -1;
    return a.global - b.global;
  });

  const tbody=document.getElementById("tabelaAtletas");
  if (!tbody) return;

  // Legenda acima da tabela
  const tabelaWrapper = tbody.closest("div.bg-white");
  if(tabelaWrapper && !tabelaWrapper.querySelector(".legenda-tabela")){
    const legenda = document.createElement("div");
    legenda.className = "legenda-tabela flex flex-wrap gap-x-6 gap-y-1 px-4 pt-3 pb-2 text-xs text-gray-500 border-b";
    legenda.innerHTML = `
      <span><strong class="text-gray-700">Sistemas:</strong> Subjetivo · Autonômico · Cognitivo: <span class="text-green-600 font-semibold">Verde ≥70</span> · <span class="text-yellow-600 font-semibold">Amarelo 60–69 (Atenção Leve)</span> · <span class="text-orange-600 font-semibold">Laranja 50–59 (Atenção)</span> · <span class="text-red-600 font-semibold">Vermelho &lt;50 (Crítico)</span>. Neuromuscular (CMJ): <span class="text-green-600 font-semibold">Verde ≥60</span> · <span class="text-yellow-600 font-semibold">50–59</span> · <span class="text-orange-600 font-semibold">40–49</span> · <span class="text-red-600 font-semibold">&lt;40</span>. — = não coletado.</span>
      <span><strong class="text-gray-700">Carga (PSE × Tempo):</strong> UA = unidades arbitrárias. <span class="text-green-600 font-semibold">&lt;300 Leve</span> · <span class="text-yellow-600 font-semibold">300–599 Moderada</span> · <span class="text-orange-600 font-semibold">600–799 Alta</span> · <span class="text-red-600 font-semibold">≥800 Muito alta</span>.</span>
      <span><strong class="text-gray-700">Impacto de Carga (ACWR):</strong> &lt;0.8 = subcarga · 0.8–1.3 = zona segura ✓ · 1.3–1.5 = atenção ⚠ · &gt;1.5 = risco ✕</span>
      <span><strong class="text-gray-700">ISP Tendência:</strong> Direção dos indicadores nas últimas 4 semanas (regressão ponderada intraindividual). <span class="font-semibold" style="color:#1d4ed8;">↑ Melhorando</span> · <span class="font-semibold" style="color:#15803d;">→ Estável</span> · <span class="text-red-600 font-semibold">↓ Piorando</span>.</span>
    `;
    tabelaWrapper.insertBefore(legenda, tabelaWrapper.firstElementChild);
  }

  const temRTP = rows.some(r => r.faseRTP != null);
  const thRtp = document.getElementById('th-rtp');
  if (thRtp) thRtp.style.display = temRTP ? '' : 'none';

  tbody.innerHTML="";

  // ── Separar por grupos se grupos configurados ────────────────────────────
  const ORDEM_GRUPOS = ['Geral', 'G1', 'G2', 'G3', 'G4', 'Transição - RTP'];
  const hasGrupos = Object.keys(_gruposPront).length > 0;
  const NUM_COLS = 11; // colunas da tabela (Atleta, Pos, IGP, ISP, Subj, Auton, Neuro, Cogn, Emoc, Carga, RTP)

  function appendGroupHeader(label, isFirst) {
    const trH = document.createElement('tr');
    trH.innerHTML = `<td colspan="${NUM_COLS}" style="background:#f8fafc;${isFirst ? '' : 'border-top:2px solid #e5e7eb;'}padding:5px 12px 4px;">
      <span style="font-size:10px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.08em;">${label}</span>
    </td>`;
    tbody.appendChild(trH);
  }

  function appendRow(r) {

    const tr=document.createElement("tr");
    tr.className="border-b "+corLinha(r.status,r.ispTend,r.global);

  const colspanDetalhe = temRTP ? 12 : 11;

  // Helper: célula colorida por valor 0–100; fallback = { score, date } do microciclo
  function _fbDate(dateStr) {
    const [,m,d] = dateStr.split('-');
    return `${d}/${m}`;
  }
  function celulaSistema(val, fb) {
    if (val != null) {
      const cor = val >= 70 ? "#15803d" : val >= 60 ? "#a16207" : val >= 50 ? "#c2410c" : "#b91c1c";
      const bg  = val >= 70 ? "#dcfce7" : val >= 60 ? "#fef9c3" : val >= 50 ? "#ffedd5" : "#fee2e2";
      return `<td class="p-3 text-center"><span style="display:inline-block;padding:2px 8px;border-radius:6px;font-weight:700;font-size:12px;background:${bg};color:${cor};">${val.toFixed(1)}</span></td>`;
    }
    if (fb?.score != null) {
      return `<td class="p-3 text-center"><div style="display:inline-flex;flex-direction:column;align-items:center;gap:1px;"><span style="display:inline-block;padding:2px 8px;border-radius:6px;font-weight:700;font-size:12px;background:#f3f4f6;color:#9ca3af;">${fb.score.toFixed(1)}</span><span style="font-size:9px;color:#9ca3af;">${_fbDate(fb.date)}</span></div></td>`;
    }
    return `<td class="p-3 text-center text-gray-300 text-xs">—</td>`;
  }
  // CMJ usa limiares próprios: < 40 = crítico, < 50 = atenção, < 60 = atenção leve
  function celulaCMJ(val, fb) {
    if (val != null) {
      const cor = val >= 60 ? "#15803d" : val >= 50 ? "#a16207" : val >= 40 ? "#c2410c" : "#b91c1c";
      const bg  = val >= 60 ? "#dcfce7" : val >= 50 ? "#fef9c3" : val >= 40 ? "#ffedd5" : "#fee2e2";
      return `<td class="p-3 text-center"><span style="display:inline-block;padding:2px 8px;border-radius:6px;font-weight:700;font-size:12px;background:${bg};color:${cor};">${val.toFixed(1)}</span></td>`;
    }
    if (fb?.score != null) {
      return `<td class="p-3 text-center"><div style="display:inline-flex;flex-direction:column;align-items:center;gap:1px;"><span style="display:inline-block;padding:2px 8px;border-radius:6px;font-weight:700;font-size:12px;background:#f3f4f6;color:#9ca3af;">${fb.score.toFixed(1)}</span><span style="font-size:9px;color:#9ca3af;">${_fbDate(fb.date)}</span></div></td>`;
    }
    return `<td class="p-3 text-center text-gray-300 text-xs">—</td>`;
  }

    tr.innerHTML=`
      <td class="p-3 cursor-pointer">
        <div style="display:flex;align-items:center;gap:8px;">
          ${r.fotoUrl
            ? `<img src="${r.fotoUrl}" style="width:32px;height:32px;border-radius:50%;object-fit:cover;flex-shrink:0;">`
            : `<div style="width:32px;height:32px;border-radius:50%;background:#3b82f6;color:#fff;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;flex-shrink:0;">${((r.nome||'?').trim().split(/\s+/).filter(Boolean).reduce((acc,p,i,arr)=>i===0||(i===arr.length-1&&arr.length>1)?acc+p[0]:acc,'').toUpperCase()||'?')}</div>`}
          <div>
            <div style="font-size:13px;font-weight:700;color:#2563eb;">${r.nome}</div>
            ${r.afastadoAdmin ? `<span style="font-size:9px;font-weight:700;padding:1px 6px;border-radius:4px;background:#ede9fe;color:#7c3aed;display:inline-block;">Admin${r.motivoAdmin ? ' · ' + r.motivoAdmin : ''}</span>` : ''}
          </div>
        </div>
      </td>
      <td class="p-3 text-center">${r.posicao||"—"}</td>
      <td class="p-3">
        <div style="display:flex;align-items:center;justify-content:center;gap:5px;">
          <span style="font-weight:700;color:#374151;">${r.global?.toFixed(1)||"—"}</span>
          ${r.global != null ? (() => { const s = statusAbrev(r.status); return `<span style="display:inline-block;padding:1px 6px;border-radius:20px;font-size:10px;font-weight:800;background:${s.bg};color:${s.cor};">${s.label}</span>`; })() : ""}
        </div>
      </td>
      <td class="p-3 text-center">
        ${(() => {
          const t = r.global != null ? r.ispTend?.global : null;
          if (!t) return '<span class="text-gray-300 text-xs">—</span>';
          return `<div style="display:inline-flex;flex-direction:column;align-items:center;gap:1px;">
            <span style="display:inline-block;padding:2px 8px;border-radius:6px;font-weight:800;font-size:13px;background:${t.bg};color:${t.cor};">${t.icon}</span>
            <span style="font-size:9px;color:${t.cor};font-weight:600;">${t.label}</span>
          </div>`;
        })()}
      </td>
      ${celulaSistema(r.IH, r.IH_fb)}
      ${celulaSistema(r.IA, r.IA_fb)}
      ${celulaCMJ(r.INM, r.INM_fb)}
      ${celulaSistema(r.IC, r.IC_fb)}
      <td class="p-3 text-center">
        ${r.humorEmocional != null
          ? `<span style="display:inline-block;padding:2px 8px;border-radius:6px;font-weight:700;font-size:12px;background:#f3f4f6;color:#374151;">${["Excelente","Muito bom","Bom","Regular","Ruim","Muito ruim","Péssimo"][r.humorEmocional-1]}</span>`
          : '<span class="text-gray-300 text-xs">—</span>'}
      </td>
      <td class="p-3 text-center">
        ${(() => {
          const carga = (r.pse != null && r.volume != null) ? Math.round(r.pse * r.volume) : (r.carga ?? null);
          if (carga == null) return '<span class="text-gray-300 text-xs">—</span>';
          const cor = carga >= 800 ? "#b91c1c" : carga >= 600 ? "#c2410c" : carga >= 300 ? "#a16207" : "#15803d";
          const bg  = carga >= 800 ? "#fee2e2" : carga >= 600 ? "#ffedd5" : carga >= 300 ? "#fef9c3" : "#dcfce7";
          return `<span style="display:inline-block;padding:2px 8px;border-radius:6px;font-weight:700;font-size:11px;background:${bg};color:${cor};">${carga} UA</span>`;
        })()}
      </td>
      ${temRTP ? `<td class="p-3 text-center" style="white-space:nowrap;">
        ${r.faseRTP ? `<span style="display:inline-block;padding:2px 8px;border-radius:999px;font-size:10px;font-weight:800;background:${r.faseRTP.bg};color:${r.faseRTP.cor};">F${r.faseRTP.fase} · ${r.faseRTP.label}</span>` : '<span class="text-gray-300 text-xs">—</span>'}
      </td>` : ''}
    `;

    const detalhe=document.createElement("tr");
    detalhe.className="hidden bg-gray-50";

    (()=>{
      const hojeD = document.getElementById("filtroData")?.value || new Date().toLocaleDateString('en-CA');
      const dmHoje = historico.find(d => d.athleteId === r.id && d.date === hojeD);

      const _corScore = (v, isCMJ) => {
        if (v == null) return { text: '#9ca3af', bg: '#f3f4f6' };
        if (isCMJ) return v >= 60 ? { text:'#15803d',bg:'#dcfce7' } : v >= 50 ? { text:'#a16207',bg:'#fef9c3' } : v >= 40 ? { text:'#c2410c',bg:'#ffedd5' } : { text:'#b91c1c',bg:'#fee2e2' };
        return v >= 70 ? { text:'#15803d',bg:'#dcfce7' } : v >= 60 ? { text:'#a16207',bg:'#fef9c3' } : v >= 50 ? { text:'#c2410c',bg:'#ffedd5' } : { text:'#b91c1c',bg:'#fee2e2' };
      };
      const _tendHtml = t => t
        ? `<span style="font-weight:800;font-size:12px;color:${t.cor};">${t.icon}</span>&nbsp;<span style="font-size:10px;color:${t.cor};font-weight:600;">${t.label}</span>`
        : `<span style="font-size:10px;color:#9ca3af;">—</span>`;
      const _row = (label, valor) => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;border-bottom:1px solid #f1f5f9;">
          <span style="font-size:10px;color:#94a3b8;">${label}</span>
          <span style="font-size:11px;font-weight:600;color:#374151;">${valor}</span>
        </div>`;

      const _card = (titulo, score, media7, tend, brutoHtml, isCMJ=false, mediaRutoHtml=null) => {
        const tendEfetiva = score != null ? tend : null;
        const cs = _corScore(score, isCMJ);
        const cm = _corScore(media7, isCMJ);
        return `
          <div style="background:#fff;border-radius:8px;border:1px solid #e5e7eb;padding:12px 14px;">
            <div style="font-size:10px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px;">${titulo}</div>
            <div style="margin-bottom:8px;">
              <div style="font-size:9px;color:#94a3b8;margin-bottom:1px;">Score hoje / Média 7d</div>
              <div style="display:flex;align-items:baseline;gap:6px;">
                <span style="font-size:20px;font-weight:800;color:${cs.text};">Score ${score != null ? score.toFixed(1) : '—'}</span>
                ${media7 != null ? `<span style="font-size:11px;color:${cm.text};opacity:.8;">/ ${media7.toFixed(1)}</span>` : ''}
              </div>
            </div>
            <div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-top:1px solid #f1f5f9;">
              <span style="font-size:10px;color:#94a3b8;">Tendência</span>
              <span>${_tendHtml(tendEfetiva)}</span>
            </div>
            <div style="padding:4px 0;border-top:1px solid #f1f5f9;">
              <div style="display:flex;justify-content:space-between;align-items:baseline;gap:4px;margin-bottom:2px;">
                <span style="font-size:10px;color:#94a3b8;white-space:nowrap;">Bruto hoje</span>
                <span style="font-size:10px;color:#64748b;font-weight:600;text-align:right;line-height:1.4;">${brutoHtml ?? '—'}</span>
              </div>
              <div style="display:flex;justify-content:space-between;align-items:baseline;gap:4px;">
                <span style="font-size:10px;color:#94a3b8;white-space:nowrap;">Média 7d</span>
                <span style="font-size:10px;color:#64748b;font-weight:600;text-align:right;">${mediaRutoHtml ?? '—'}</span>
              </div>
            </div>
          </div>`;
      };

      // Bruto IH: sub-itens do Hooper (cada 1–7)
      const _fmt7 = v => v != null ? `${v}/7` : null;
      const brutoIH = (() => {
        const p = dmHoje?.pre;
        if (!p) return null;
        const partes = [
          p.fadiga   != null ? `Fadiga ${_fmt7(p.fadiga)}`   : null,
          p.sono     != null ? `Sono ${_fmt7(p.sono)}`       : null,
          p.estresse != null ? `Estresse ${_fmt7(p.estresse)}`: null,
          p.dor      != null ? `Dor ${_fmt7(p.dor)}`         : null,
        ].filter(Boolean);
        if (!partes.length && p.hooper != null) return `Hooper ${p.hooper}`;
        return partes.join(' · ') || null;
      })();
      const brutoIA  = dmHoje?.hrv?.lnRR    != null ? `lnRR ${dmHoje.hrv.lnRR.toFixed(2)}` : null;
      const brutoINM = dmHoje?.pre?.salto   != null ? `${dmHoje.pre.salto} cm` : null;
      const brutoIC  = dmHoje?.neuro?.score != null ? `${dmHoje.neuro.score}%` : null;

      // Médias brutas 7d
      const _mIH  = mediaRutaAtleta(r.id, 'hooper');
      const _mIA  = mediaRutaAtleta(r.id, 'lnRR');
      const _mINM = mediaRutaAtleta(r.id, 'salto');
      const _mIC  = mediaRutaAtleta(r.id, 'neuroScore');
      const mediaRutaIH  = _mIH  != null ? `Hooper ${_mIH.toFixed(1)}`   : null;
      const mediaRutaIA  = _mIA  != null ? `lnRR ${_mIA.toFixed(2)}`     : null;
      const mediaRutaINM = _mINM != null ? `${_mINM.toFixed(1)} cm`      : null;
      const mediaRutaIC  = _mIC  != null ? `${_mIC.toFixed(1)}%`         : null;

      // Carga
      const _cargaHoje = (r.pse != null && r.volume != null) ? Math.round(r.pse * r.volume) : (r.carga ?? null);
      const _cargaM7   = media7Atleta(r.id, 'carga');
      const _acwrLabel = (() => { const l = labelACWR(r.acwr); return { icon: l.texto, cor: l.cor, bg: l.bg }; })();
      const _brutoCarga = [
        dmHoje?.post?.pse    != null ? `PSE ${dmHoje.post.pse}`      : (r.pse  != null ? `PSE ${r.pse}`    : null),
        dmHoje?.post?.tempo  != null ? `${dmHoje.post.tempo} min`    : (r.volume!= null ? `${r.volume} min` : null),
      ].filter(Boolean).join(' · ') || null;
      const _corCarga = v => v == null ? { text:'#9ca3af',bg:'#f3f4f6' } : v > 600 ? { text:'#b91c1c',bg:'#fee2e2' } : v > 400 ? { text:'#c2410c',bg:'#ffedd5' } : v > 200 ? { text:'#a16207',bg:'#fef9c3' } : { text:'#15803d',bg:'#dcfce7' };
      const _cardCarga = () => {
        const cs = _corCarga(_cargaHoje);
        const cm = _corCarga(_cargaM7);
        const acwrHtml = r.acwr != null
          ? `<span style="font-weight:800;font-size:11px;color:${_acwrLabel.cor};">${_acwrLabel.icon}</span>`
          : `<span style="font-size:10px;color:#9ca3af;">—</span>`;
        const _mPse   = mediaRutaAtleta(r.id, 'pse');
        const _mTempo = mediaRutaAtleta(r.id, 'tempo');
        const mediaRutaCarga = [
          _mPse   != null ? `PSE ${_mPse.toFixed(1)}`      : null,
          _mTempo != null ? `${Math.round(_mTempo)} min`   : null,
        ].filter(Boolean).join(' · ') || null;
        return `
          <div style="background:#fff;border-radius:8px;border:1px solid #e5e7eb;padding:12px 14px;">
            <div style="font-size:10px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px;">Carga · UA</div>
            <div style="margin-bottom:8px;">
              <div style="font-size:9px;color:#94a3b8;margin-bottom:1px;">Score hoje / Média 7d</div>
              <div style="display:flex;align-items:baseline;gap:6px;">
                <span style="font-size:20px;font-weight:800;color:${cs.text};">Score ${_cargaHoje != null ? Math.round(_cargaHoje) : '—'}</span>
                ${_cargaM7 != null ? `<span style="font-size:11px;color:${cm.text};opacity:.8;">/ ${Math.round(_cargaM7)}</span>` : ''}
              </div>
            </div>
            <div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-top:1px solid #f1f5f9;">
              <span style="font-size:10px;color:#94a3b8;">ACWR</span>
              ${acwrHtml}
            </div>
            <div style="padding:4px 0;border-top:1px solid #f1f5f9;">
              <div style="display:flex;justify-content:space-between;align-items:baseline;gap:4px;margin-bottom:2px;">
                <span style="font-size:10px;color:#94a3b8;white-space:nowrap;">Bruto hoje</span>
                <span style="font-size:10px;color:#64748b;font-weight:600;text-align:right;">${_brutoCarga ?? '—'}</span>
              </div>
              <div style="display:flex;justify-content:space-between;align-items:baseline;gap:4px;">
                <span style="font-size:10px;color:#94a3b8;white-space:nowrap;">Média 7d</span>
                <span style="font-size:10px;color:#64748b;font-weight:600;text-align:right;">${mediaRutaCarga ?? '—'}</span>
              </div>
            </div>
          </div>`;
      };

      detalhe.innerHTML=`
        <td colspan="${colspanDetalhe}" style="padding:12px 16px;background:#f8fafc;border-bottom:1px solid #e5e7eb;">
          <div style="display:flex;justify-content:flex-end;margin-bottom:8px;">
            <a href="/staff/atleta_perfil.html?id=${r.id}" onclick="event.stopPropagation();" style="display:inline-flex;align-items:center;gap:5px;padding:5px 12px;border-radius:6px;background:#2563eb;color:#fff;font-size:11px;font-weight:700;text-decoration:none;" title="Ver perfil completo do atleta">
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
              Ver Perfil
            </a>
          </div>
          <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:10px;">
            ${_card('Subjetivo · IH',    r.IH,  media7Atleta(r.id,'fadiga'),     r.ispTend?.IH,  brutoIH,  false, mediaRutaIH)}
            ${_card('Autonômico · IA',   r.IA,  media7Atleta(r.id,'autonomico'), r.ispTend?.IA,  brutoIA,  false, mediaRutaIA)}
            ${_card('Neuromuscular · INM',r.INM, media7Atleta(r.id,'muscular'),   r.ispTend?.INM, brutoINM, true,  mediaRutaINM)}
            ${_card('Cognitivo · IC',    r.IC,  media7Atleta(r.id,'cognitivo'),  r.ispTend?.IC,  brutoIC,  false, mediaRutaIC)}
            ${_cardCarga()}
          </div>
        </td>
      `;
    })();


    tr.addEventListener("click",()=>{ detalhe.classList.toggle("hidden"); });

    tbody.appendChild(tr);
    tbody.appendChild(detalhe);
  }

  if (!hasGrupos) {
    // Sem grupos: comportamento original
    rows.forEach(r => appendRow(r));
  } else {
    // Com grupos: afastados/transição primeiro (sem label de grupo), depois liberados por grupo, depois admin
    const restritos = rows.filter(r => r.statusMed === 'afastado' || r.statusMed === 'transicao');
    const liberados = rows.filter(r => !r.afastadoAdmin && r.statusMed !== 'afastado' && r.statusMed !== 'transicao');
    const admin     = rows.filter(r => r.afastadoAdmin);

    restritos.forEach(r => appendRow(r));

    // Agrupar liberados
    const grupoMap = {};
    liberados.forEach(r => {
      const g = _gruposPront[r.id] || '__sem_grupo__';
      if (!grupoMap[g]) grupoMap[g] = [];
      grupoMap[g].push(r);
    });

    let firstGroup = restritos.length === 0;
    ORDEM_GRUPOS.forEach(g => {
      const membros = grupoMap[g] || [];
      if (!membros.length) return;
      appendGroupHeader(g, firstGroup);
      firstGroup = false;
      membros.forEach(r => appendRow(r));
    });
    // Atletas sem grupo
    const semGrupo = grupoMap['__sem_grupo__'] || [];
    if (semGrupo.length) {
      appendGroupHeader('Sem grupo', firstGroup);
      semGrupo.forEach(r => appendRow(r));
    }

    // Admin no final
    if (admin.length) {
      const trH = document.createElement('tr');
      trH.innerHTML = `<td colspan="${NUM_COLS}" style="background:#f5f3ff;border-top:2px solid #ddd6fe;padding:5px 12px 4px;">
        <span style="font-size:10px;font-weight:700;color:#7c3aed;text-transform:uppercase;letter-spacing:.08em;">Administrativo</span>
      </td>`;
      tbody.appendChild(trH);
      admin.forEach(r => appendRow(r));
    }
  }
}

function corIndice(v){
  if(v == null) return "#9ca3af";
  if(v >= 70) return "#15803d";
  if(v >= 60) return "#a16207";
  if(v >= 50) return "#ea580c";
  return "#dc2626";  // crítico: < 50
}

function statusAbrev(status) {
  if (status === "Crítico")     return { label: "C",  cor: "#b91c1c", bg: "#fee2e2" };
  if (status === "Atenção")     return { label: "A",  cor: "#c2410c", bg: "#ffedd5" };
  if (status === "Atenção Leve")return { label: "AL", cor: "#b45309", bg: "#fef9c3" };
  if (status === "Estável")     return { label: "E",  cor: "#15803d", bg: "#dcfce7" };
  return { label: "—", cor: "#9ca3af", bg: "#f3f4f6" };
}

function barraHorizontal(valor, max, cor) {
  // Barra horizontal colorida 0–max com largura proporcional
  if (valor == null) return `<div class="w-full h-3 rounded bg-gray-100 flex items-center"><span class="text-xs text-gray-300 ml-1">—</span></div>`;
  const pct   = Math.min(Math.max(valor / max * 100, 0), 100).toFixed(1);
  const bgBar = cor === "green" ? "#16a34a" : cor === "yellow" ? "#ca8a04" : cor === "orange" ? "#ea580c" : cor === "red" ? "#dc2626" : "#3b82f6";
  const bgTrack = cor === "green" ? "#dcfce7" : cor === "yellow" ? "#fef9c3" : cor === "orange" ? "#ffedd5" : cor === "red" ? "#fee2e2" : "#dbeafe";
  return `
    <div class="w-full rounded overflow-hidden" style="background:${bgTrack};height:10px;">
      <div style="width:${pct}%;background:${bgBar};height:100%;border-radius:4px;transition:width .4s;"></div>
    </div>`;
}

function corBarra(val) {
  if (val == null) return "gray";
  if (val >= 70) return "green";
  if (val >= 60) return "yellow";
  if (val >= 50) return "orange";
  return "red";
}

function zScoreAtleta(athleteId, tipo) {
  // Calcula z-score do valor de hoje em relação aos últimos 7 dias (excluindo hoje)
  const hoje = document.getElementById("filtroData")?.value || new Date().toLocaleDateString('en-CA');
  const hist = historico
    .filter(d => d.athleteId === athleteId && d.date < hoje)
    .sort((a,b) => new Date(a.date) - new Date(b.date))
    .slice(-7);
  if (hist.length < 3) return null;
  const vals = hist.map(d => {
    const c = calcularProntidao(d);
    if (tipo === "muscular")   return c.inMuscular;
    if (tipo === "autonomico") return c.inAutonomico;
    if (tipo === "cognitivo")  return c.inCognitivo;
    return null;
  }).filter(v => v != null);
  if (vals.length < 3) return null;
  const m = vals.reduce((a,b) => a+b, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((s,x) => s+(x-m)**2, 0) / vals.length);
  if (sd === 0) return null;
  // Valor de hoje
  const dm = historico.find(d => d.athleteId === athleteId && d.date === hoje);
  if (!dm) return null;
  const c = calcularProntidao(dm);
  let vHoje = null;
  if (tipo === "muscular")   vHoje = c.inMuscular;
  if (tipo === "autonomico") vHoje = c.inAutonomico;
  if (tipo === "cognitivo")  vHoje = c.inCognitivo;
  if (vHoje == null) return null;
  return ((vHoje - m) / sd).toFixed(2);
}

function media7Atleta(athleteId, tipo) {
  const hist = historico
    .filter(d => d.athleteId === athleteId)
    .sort((a,b) => new Date(a.date) - new Date(b.date))
    .slice(-7);
  const vals = hist.map(d => {
    const c = calcularProntidao(d);
    if (tipo === "fadiga")     return c.inFadiga;
    if (tipo === "muscular")   return c.inMuscular;
    if (tipo === "autonomico") return c.inAutonomico;
    if (tipo === "cognitivo")  return c.inCognitivo;
    if (tipo === "carga")      return d?.post?.carga ?? null;
    return null;
  }).filter(v => v != null);
  if (!vals.length) return null;
  return vals.reduce((a,b) => a+b, 0) / vals.length;
}

function mediaRutaAtleta(athleteId, tipo) {
  const hist = historico
    .filter(d => d.athleteId === athleteId)
    .sort((a,b) => new Date(a.date) - new Date(b.date))
    .slice(-7);
  const _avg = vals => vals.length ? vals.reduce((a,b)=>a+b,0)/vals.length : null;
  if (tipo === 'hooper') {
    const vals = hist.map(d => {
      const p = d.pre;
      if (!p) return null;
      if (p.hooper != null) return p.hooper;
      const comps = [p.fadiga, p.sono, p.estresse, p.dor];
      return comps.every(v => v != null) ? comps.reduce((a,b)=>a+b,0) : null;
    }).filter(v => v != null);
    return _avg(vals);
  }
  if (tipo === 'lnRR')       return _avg(hist.map(d => d.hrv?.lnRR       ?? null).filter(v => v != null));
  if (tipo === 'salto')      return _avg(hist.map(d => d.pre?.salto      ?? null).filter(v => v != null));
  if (tipo === 'neuroScore') return _avg(hist.map(d => d.neuro?.score    ?? null).filter(v => v != null));
  if (tipo === 'pse')        return _avg(hist.map(d => d.post?.pse       ?? null).filter(v => v != null));
  if (tipo === 'tempo')      return _avg(hist.map(d => d.post?.tempo     ?? null).filter(v => v != null));
  return null;
}

function detalheIndicador(titulo, legenda, valor, id, tipo) {
  const numVal  = typeof valor === "number" ? valor : null;
  const isCarga = tipo === "carga";
  const hoje = document.getElementById("filtroData")?.value || new Date().toLocaleDateString('en-CA');
  const dm   = historico.find(d => d.athleteId === id && d.date === hoje);
  const dataFmt = dm?.date ? dm.date.slice(8)+'/'+dm.date.slice(5,7) : null;

  // Raw tag por tipo
  let rawTag = '';
  if (dm && dataFmt) {
    if (tipo === 'muscular') {
      const salto = dm?.pre?.salto ?? null;
      if (salto != null) rawTag = `<span style="font-size:10px;color:#64748b;background:#f1f5f9;border-radius:6px;padding:1px 7px;margin-left:6px;font-weight:600;">${salto} cm · ${dataFmt}</span>`;
    } else if (tipo === 'autonomico') {
      const lnRR = dm?.hrv?.lnRR ?? null;
      if (lnRR != null) rawTag = `<span style="font-size:10px;color:#64748b;background:#f1f5f9;border-radius:6px;padding:1px 7px;margin-left:6px;font-weight:600;">lnRR ${lnRR.toFixed(2)} · ${dataFmt}</span>`;
    } else if (tipo === 'cognitivo') {
      const score = dm?.neuro?.score ?? null;
      if (score != null) rawTag = `<span style="font-size:10px;color:#64748b;background:#f1f5f9;border-radius:6px;padding:1px 7px;margin-left:6px;font-weight:600;">${score}% · ${dataFmt}</span>`;
    } else if (isCarga) {
      const carga = dm?.post?.carga ?? null;
      const pse   = dm?.post?.pse   ?? null;
      const tempo = dm?.post?.tempo  ?? null;
      const partes = [
        carga != null ? `${Math.round(carga)} UA` : null,
        pse   != null ? `PSE ${pse}` : null,
        tempo != null ? `${tempo} min` : null,
      ].filter(Boolean);
      if (partes.length) rawTag = `<span style="font-size:10px;color:#64748b;background:#f1f5f9;border-radius:6px;padding:1px 7px;margin-left:6px;font-weight:600;">${partes.join(' · ')} · ${dataFmt}</span>`;
    }
  }

  // Sem dados
  if (numVal == null && !isCarga) {
    const m7sem  = media7Atleta(id, tipo);
    const corM7s = corBarra(m7sem);
    return `
      <div class="bg-white rounded-lg border border-gray-100 p-3 text-left">
        <div class="font-semibold text-blue-600 text-sm flex items-center flex-wrap gap-1">${titulo}${rawTag}</div>
        <div class="text-xs text-gray-400 mb-3">${legenda}</div>
        <div class="space-y-2 text-xs">
          <div>
            <div class="flex justify-between mb-0.5">
              <span class="text-gray-500 font-medium">Índice hoje</span>
              <span class="text-gray-300 font-bold">—</span>
            </div>
            <div class="w-full rounded overflow-hidden bg-gray-100" style="height:10px;"></div>
          </div>
          <div>
            <div class="flex justify-between mb-0.5">
              <span class="text-gray-500 font-medium">Média 7d</span>
              <span class="font-semibold text-gray-600">${m7sem != null ? m7sem.toFixed(1) : "—"}</span>
            </div>
            ${barraHorizontal(m7sem, 100, corM7s)}
          </div>
          <div>
            <div class="flex justify-between mb-0.5">
              <span class="text-gray-500 font-medium">Z-score</span>
              <span class="text-gray-300 font-semibold">—</span>
            </div>
            <div class="w-full rounded overflow-hidden bg-gray-100" style="height:10px;"></div>
          </div>
        </div>
      </div>`;
  }

  if (isCarga) {
    // Carga: mostra PSE, Tempo, Carga UA com barra
    const media7 = media7Atleta(id, "carga");
    const cargaVal = numVal;
    const corC = media7 && cargaVal > media7 * 1.3 ? "red" : media7 && cargaVal > media7 ? "yellow" : "green";
    const barC = barraHorizontal(cargaVal, Math.max(cargaVal ?? 0, media7 ?? 0, 800) * 1.1, corC);
    const barM = media7 != null ? barraHorizontal(media7, Math.max(cargaVal ?? 0, media7 ?? 0, 800) * 1.1, "blue") : "";
    return `
      <div class="bg-white rounded-lg border border-gray-100 p-3 text-left">
        <div class="font-semibold text-blue-600 text-sm flex items-center flex-wrap gap-1">${titulo}${rawTag}</div>
        <div class="text-xs text-gray-400 mb-3">${legenda}</div>
        <div class="space-y-2 text-xs">
          <div>
            <div class="flex justify-between mb-0.5"><span class="text-gray-500 font-medium">Carga hoje (UA)</span><span class="font-bold" style="color:${corC==="red"?"#dc2626":corC==="yellow"?"#ca8a04":"#16a34a"};">${cargaVal?.toFixed(0) ?? "—"}</span></div>
            ${barC}
          </div>
          <div>
            <div class="flex justify-between mb-0.5"><span class="text-gray-500 font-medium">Média 7d</span><span class="text-gray-600 font-semibold">${media7 != null ? media7.toFixed(0) : "—"}</span></div>
            ${barM}
          </div>
        </div>
      </div>`;
  }

  // Indicadores 0–100
  const m7   = media7Atleta(id, tipo);
  const z    = zScoreAtleta(id, tipo);
  // CMJ usa limiares próprios: ≥60 verde · 50–59 amarelo · 40–49 laranja · <40 vermelho
  function corBarraTipo(v) {
    if (v == null) return "gray";
    if (tipo === "muscular") return v >= 60 ? "green" : v >= 50 ? "yellow" : v >= 40 ? "orange" : "red";
    return v >= 70 ? "green" : v >= 60 ? "yellow" : v >= 50 ? "orange" : "red";
  }
  const corH = corBarraTipo(numVal);
  const corM = corBarraTipo(m7);

  // Z-score: mapeado em barra onde 0=50%, ±2=0/100%
  const zNum  = z != null ? parseFloat(z) : null;
  const zPct  = zNum != null ? Math.min(Math.max((zNum + 2) / 4 * 100, 0), 100) : null;
  const zCor  = zNum == null ? "gray" : zNum >= 0.5 ? "green" : zNum >= -0.5 ? "yellow" : "red";
  const zBgBar   = zCor === "green" ? "#16a34a" : zCor === "yellow" ? "#ca8a04" : zCor === "red" ? "#dc2626" : "#9ca3af";
  const zBgTrack = zCor === "green" ? "#dcfce7" : zCor === "yellow" ? "#fef9c3" : zCor === "red" ? "#fee2e2" : "#f3f4f6";

  return `
    <div class="bg-white rounded-lg border border-gray-100 p-3 text-left">
      <div class="font-semibold text-blue-600 text-sm flex items-center flex-wrap gap-1">${titulo}${rawTag}</div>
      <div class="text-xs text-gray-400 mb-3">${legenda}</div>
      <div class="space-y-2 text-xs">
        <div>
          <div class="flex justify-between mb-0.5">
            <span class="text-gray-500 font-medium">Índice hoje</span>
            <span class="font-bold" style="color:${corH==="green"?"#16a34a":corH==="yellow"?"#ca8a04":"#dc2626"};">${numVal.toFixed(1)}</span>
          </div>
          ${barraHorizontal(numVal, 100, corH)}
        </div>
        <div>
          <div class="flex justify-between mb-0.5">
            <span class="text-gray-500 font-medium">Média 7d</span>
            <span class="font-semibold text-gray-600">${m7 != null ? m7.toFixed(1) : "—"}</span>
          </div>
          ${barraHorizontal(m7, 100, corM)}
        </div>
        <div>
          <div class="flex justify-between mb-0.5">
            <span class="text-gray-500 font-medium">Z-score</span>
            <span class="font-semibold" style="color:${zBgBar};">${z != null ? (parseFloat(z) >= 0 ? "+" : "") + z : "—"}</span>
          </div>
          ${zPct != null ? `<div class="w-full rounded overflow-hidden" style="background:${zBgTrack};height:10px;"><div style="width:${zPct.toFixed(1)}%;background:${zBgBar};height:100%;border-radius:4px;transition:width .4s;"></div></div>` : `<div class="w-full h-3 rounded bg-gray-100"></div>`}
        </div>
      </div>
    </div>`;
}

function detalheACWR(titulo, legenda, acwr, id) {
  const la = labelACWR(acwr);
  // Barras de ACWR: aguda, crônica, ratio
  const hist = historico
    .filter(d => d.athleteId === id && d?.post?.carga != null)
    .sort((a,b) => new Date(a.date) - new Date(b.date));
  const aguda7  = hist.slice(-7).reduce((s,d)  => s + d.post.carga, 0);
  const hist28  = hist.slice(-28);
  const cronica = hist28.length >= 4
    ? hist28.reduce((s,d) => s + d.post.carga, 0) / Math.ceil(hist28.length / 7)
    : null;

  const max = Math.max(aguda7, cronica ?? aguda7, 100);
  const barAguda   = barraHorizontal(aguda7,  max * 1.1, acwr != null && acwr > 1.3 ? "red" : acwr != null && acwr < 0.8 ? "blue" : "green");
  const barCronica = cronica != null ? barraHorizontal(cronica, max * 1.1, "blue") : "";

  return `
    <div class="bg-white rounded-lg border border-gray-100 p-3 text-left">
      <div class="font-semibold text-blue-600 text-sm">${titulo}</div>
      <div class="text-xs text-gray-400 mb-3">${legenda}</div>
      <div class="space-y-2 text-xs">
        <div class="flex justify-between items-center mb-1">
          <span class="text-gray-500 font-medium">ACWR</span>
          <span style="background:${la.bg};color:${la.cor};font-weight:700;padding:1px 8px;border-radius:6px;font-size:11px;">${la.texto}</span>
        </div>
        <div>
          <div class="flex justify-between mb-0.5"><span class="text-gray-500">Carga aguda (7d)</span><span class="font-semibold text-gray-700">${aguda7.toFixed(0)} UA</span></div>
          ${barAguda}
        </div>
        <div>
          <div class="flex justify-between mb-0.5"><span class="text-gray-500">Carga crônica (28d)</span><span class="font-semibold text-gray-700">${cronica != null ? cronica.toFixed(0) + " UA" : "—"}</span></div>
          ${barCronica}
        </div>
      </div>
    </div>`;
}

function detalheIndicadorHooper(titulo, legenda, valor, id){
  const numVal = typeof valor === "number" ? valor : null;
  const hoje = document.getElementById("filtroData")?.value || new Date().toLocaleDateString('en-CA');
  const dm   = historico.find(d => d.athleteId === id && d.date === hoje);
  const hooperTotal = dm?.pre?.hooper ?? null;
  const dataFmt = dm?.date ? dm.date.slice(8)+'/'+dm.date.slice(5,7) : null;
  const rawTag = (hooperTotal != null && dataFmt)
    ? `<span style="font-size:10px;color:#64748b;background:#f1f5f9;border-radius:6px;padding:1px 7px;margin-left:6px;font-weight:600;">Hooper ${hooperTotal} · ${dataFmt}</span>`
    : '';

  if (numVal == null) {
    return `
      <div class="bg-white rounded-lg border border-gray-100 p-3 text-left">
        <div class="font-semibold text-blue-600 text-sm flex items-center flex-wrap gap-1">${titulo}${rawTag}</div>
        <div class="text-xs text-gray-400 mb-3">${legenda}</div>
        <div class="text-gray-300 text-lg font-bold">—</div>
        <div class="text-xs text-gray-300 mt-1">Sem dados hoje</div>
      </div>`;
  }

  // Hooper global como barra (0–100 invertido)
  const corH = corBarra(numVal);

  // Subescalas do Hooper
  const campos = [
    { key:"sono",     label:"Sono",        icon:"😴" },
    { key:"fadiga",   label:"Fadiga",      icon:"🔋" },
    { key:"estresse", label:"Estresse",    icon:"🧠" },
    { key:"dor",      label:"Dor",         icon:"💪" }
  ];
  function corSub(v){ return v==null?"#9ca3af":v<=2?"#16a34a":v<=3?"#ca8a04":"#dc2626"; }

  const subHtml = campos.map(c => {
    const v = dm?.pre?.[c.key] ?? null;
    const pct = v != null ? Math.min((v - 1) / 6 * 100, 100).toFixed(1) : null;
    const corV = corSub(v);
    // Para o campo dor: exibe regiões ou "sem localização"
    const regioesDorHtml = c.key === "dor" ? (() => {
      const regioes = dm?.pre?.regioes_dor;
      const semLocal = dm?.pre?.sem_dor_localizada;
      if (regioes?.length)
        return `<div class="text-[10px] text-gray-400 mt-0.5 leading-tight">${(regioes.length > 2 ? regioes.slice(0,2).join(" · ") + "…" : regioes.join(" · "))}</div>`;
      if (semLocal)
        return `<div class="text-[10px] text-gray-400 mt-0.5 italic">Sem dor localizada</div>`;
      return "";
    })() : "";
    return `
      <div>
        <div class="flex justify-between mb-0.5">
          <span class="text-gray-500">${c.icon} ${c.label}</span>
          <span style="color:${corV};font-weight:700;">${v ?? "—"}/7</span>
        </div>
        ${pct != null
          ? `<div class="w-full rounded overflow-hidden" style="background:#f3f4f6;height:8px;"><div style="width:${pct}%;background:${corV};height:100%;border-radius:4px;"></div></div>`
          : `<div class="w-full h-2 rounded bg-gray-100"></div>`}
        ${regioesDorHtml}
      </div>`;
  }).join("");

  return `
    <div class="bg-white rounded-lg border border-gray-100 p-3 text-left">
      <div class="font-semibold text-blue-600 text-sm cursor-pointer hover:underline flex items-center flex-wrap gap-1" onclick="toggleHooper('${id}')">${titulo}${rawTag}</div>
      <div class="text-xs text-gray-400 mb-3">${legenda}</div>
      ${(()=>{
        const m7h = media7Atleta(id, "fadiga");
        const corM7 = corBarra(m7h);
        return `<div class="space-y-2 text-xs">
          <div>
            <div class="flex justify-between mb-0.5">
              <span class="text-gray-500 font-medium">Índice hoje</span>
              <span class="font-bold" style="color:${corH==="green"?"#16a34a":corH==="yellow"?"#ca8a04":"#dc2626"};">${numVal.toFixed(1)}</span>
            </div>
            ${barraHorizontal(numVal, 100, corH)}
          </div>
          <div>
            <div class="flex justify-between mb-0.5">
              <span class="text-gray-500 font-medium">Média 7d</span>
              <span class="font-semibold text-gray-600">${m7h != null ? m7h.toFixed(1) : "—"}</span>
            </div>
            ${barraHorizontal(m7h, 100, corM7)}
          </div>
        </div>`;
      })()}
      <div id="hooper-painel-${id}" class="hidden mt-3 text-left w-full">
        <div class="mt-2 space-y-1.5 text-xs">${subHtml}</div>
      </div>
      <div class="text-xs text-gray-400 mt-2 cursor-pointer hover:text-blue-500" onclick="toggleHooper('${id}')">▸ ver subescalas</div>
    </div>`;
}

window.toggleHooper = function(id){
  const painel = document.getElementById(`hooper-painel-${id}`);
  if (!painel) return;
  painel.classList.toggle("hidden");
};

function inicializarGraficoDetalhe(id, tipo, canvas) {
  const somenteMedia = canvas.closest("[data-somente-media]") != null;
  const isIndicador = ["muscular","autonomico","cognitivo"].includes(tipo);

  const dados = historico
    .filter(d => d.athleteId === id)
    .sort((a,b) => new Date(a.date) - new Date(b.date))
    .slice(-14);

  const valores = dados.map(d => {
    const calc = calcularProntidao(d);
    if(tipo === "muscular")   return calc.inMuscular;
    if(tipo === "autonomico") return calc.inAutonomico;
    if(tipo === "cognitivo")  return calc.inCognitivo;
    if(tipo === "carga")      return d?.post?.carga ?? null;
    return null;
  });

  const validos = valores.filter(v => v != null);
  if(!validos.length) return;
  const mediaVal = validos.reduce((a,b) => a+b, 0) / validos.length;

  if(canvas._chartInstance) canvas._chartInstance.destroy();

  const datasets = [];

  // Série principal — omite se "somente média"
  if(!somenteMedia) {
    datasets.push({
      data: valores,
      borderColor: "rgba(59,130,246,1)",
      backgroundColor: "rgba(59,130,246,0.12)",
      borderWidth: 2,
      fill: true,
      tension: 0.3,
      pointRadius: 3,
      label: tipo.charAt(0).toUpperCase() + tipo.slice(1),
    });
  }

  // Série média — sempre presente
  datasets.push({
    data: valores.map(() => mediaVal),
    borderColor: "rgba(239,68,68,0.75)",
    backgroundColor: "transparent",
    borderWidth: somenteMedia ? 2 : 1.5,
    borderDash: [5,4],
    pointRadius: 0,
    label: `Média ${mediaVal.toFixed(1)}`,
    tension: 0,
    type: "line"
  });

  canvas._chartInstance = new Chart(canvas, {
    type: "line",
    data: {
      labels: dados.map(d => d.date.slice(5)),
      datasets
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: somenteMedia, labels: { font: { size: 10 }, boxWidth: 14 } },
        tooltip: { mode: "index", intersect: false }
      },
      scales: {
        y: {
          min: isIndicador ? 0 : undefined,
          max: isIndicador ? 100 : undefined,
          ticks: { font: { size: 10 } }
        },
        x: { ticks: { font: { size: 9 }, maxRotation: 45 } }
      }
    }
  });
}

window.toggleGraficoAtleta=function(id,tipo){

  const container=document.getElementById(`grafico-${id}-${tipo}`);
  const canvas=container.querySelector("canvas");

  if(!container.classList.contains("hidden")){
    container.classList.add("hidden");
    if(canvas._chartInstance){ canvas._chartInstance.destroy(); canvas._chartInstance=null; }
    return;
  }

  container.classList.remove("hidden");

  const dados=historico
    .filter(d=>d.athleteId===id)
    .sort((a,b)=>new Date(a.date)-new Date(b.date))
    .slice(-7);

  const valores=dados.map(d=>{
    const calc=calcularProntidao(d);
    if(tipo==="fadiga") return calc.inFadiga;
    if(tipo==="muscular") return calc.inMuscular;
    if(tipo==="autonomico") return calc.inAutonomico;
    if(tipo==="cognitivo") return calc.inCognitivo;
    if(tipo==="carga") return d?.post?.carga;
    if(tipo==="densidade") return d?.post?.densidade;
  });

  const mediaVal = valores.filter(v=>v!=null).reduce((a,b)=>a+b,0) / (valores.filter(v=>v!=null).length||1);

  // Painel info acima do gráfico (valor do dia + média 7d)
  const painelAnterior = container.querySelector(".painel-indicador-info");
  if(painelAnterior) painelAnterior.remove();

  const painel = document.createElement("div");
  painel.className = "painel-indicador-info flex gap-6 mb-2 text-xs text-gray-500 bg-gray-50 rounded px-3 py-1.5 border border-gray-100";

  if(tipo==="carga"){
    const ultimoDado = dados[dados.length - 1];
    const pseHoje = ultimoDado?.post?.pse ?? null;
    const volHoje = ultimoDado?.post?.tempo ?? null;
    const todosDados = historico.filter(d=>d.athleteId===id && d?.post?.carga != null);
    const pseArr = todosDados.map(d=>d?.post?.pse).filter(v=>v!=null);
    const volArr = todosDados.map(d=>d?.post?.tempo).filter(v=>v!=null);
    const mediaPSE = pseArr.length ? (pseArr.reduce((a,b)=>a+b,0)/pseArr.length).toFixed(1) : "—";
    const mediaVol = volArr.length ? (volArr.reduce((a,b)=>a+b,0)/volArr.length).toFixed(0) : "—";
    painel.innerHTML = `
      <span><strong class="text-gray-700">PSE</strong> ${pseHoje ?? "—"} &nbsp;·&nbsp; Média: ${mediaPSE}</span>
      <span><strong class="text-gray-700">Tempo (min)</strong> ${volHoje ?? "—"} &nbsp;·&nbsp; Média: ${mediaVol}</span>
    `;
  } else {
    const ultimoDado = dados[dados.length - 1];
    const ultimoValor = valores.filter(v=>v!=null).slice(-1)[0] ?? null;
    const valorHoje = ultimoValor != null ? ultimoValor.toFixed(1) : "—";
    const mediaStr = mediaVal != null ? mediaVal.toFixed(1) : "—";

    let brutoHoje = null, brutoLabel = "";
    if(tipo === "muscular"){
      brutoHoje = ultimoDado?.pre?.salto ?? null;
      brutoLabel = "CMJ";
    } else if(tipo === "autonomico"){
      brutoHoje = ultimoDado?.hrv?.lnRR ?? null;
      brutoLabel = "lnRMSSD";
    } else if(tipo === "cognitivo"){
      brutoHoje = ultimoDado?.neuro?.score ?? null;
      brutoLabel = "Score bruto";
    }
    const brutoStr = brutoHoje != null ? (tipo === "muscular" ? brutoHoje + "cm" : brutoHoje.toFixed(1)) : "—";
    const brutoSpan = brutoLabel ? `<span><strong class="text-gray-700">${brutoLabel}</strong> ${brutoStr}</span>` : "";

    painel.innerHTML = `
      ${brutoSpan}
      <span><strong class="text-gray-700">Índice (z-score)</strong> ${valorHoje}</span>
      <span><strong class="text-gray-700">Média 7d</strong> ${mediaStr}</span>
    `;
  }

  container.insertBefore(painel, canvas);

  if(canvas._chartInstance) canvas._chartInstance.destroy();

  const isBarra = tipo === "carga" || tipo === "densidade";

  canvas._chartInstance = new Chart(canvas,{
    type: isBarra ? "bar" : "line",
    data:{
      labels:dados.map(d=>d.date),
      datasets:[
        {
          data:valores,
          borderColor:"rgba(59,130,246,1)",
          backgroundColor: isBarra ? "rgba(59,130,246,0.7)" : "rgba(59,130,246,0.12)",
          borderWidth: isBarra ? 0 : 2,
          fill: !isBarra,
          tension:0.3,
          pointRadius: isBarra ? 0 : 4,
          pointHoverRadius: isBarra ? 0 : 6,
          label: tipo.charAt(0).toUpperCase()+tipo.slice(1),
          borderRadius: isBarra ? 4 : 0
        },
        {
          data:valores.map(()=>mediaVal),
          borderColor:"rgba(239,68,68,0.8)",
          backgroundColor:"transparent",
          borderWidth:2,
          borderDash:[6,4],
          pointRadius:0,
          label:"Média",
          tension:0,
          type:"line"
        }
      ]
    },
    options:{
      responsive:true,
      plugins:{
        legend:{display:true, labels:{font:{size:11}}},
        tooltip:{mode:"index", intersect:false,
          callbacks:{ label: ctx => ctx.dataset.label+": "+ctx.parsed.y.toFixed(1) }
        }
      },
      scales:{
        y:{beginAtZero:true, ticks:{font:{size:11}}},
        x:{ticks:{font:{size:10}, maxRotation:45}}
      }
    }
  });
};

// listeners (guardados com ?. pois o módulo pode ser importado por outras páginas)
document.getElementById("filtroCategoria")?.addEventListener("change",aplicarFiltros);
document.getElementById("filtroPosicao")?.addEventListener("change",aplicarFiltros);
document.getElementById("filtroData")?.addEventListener("change",async()=>{
  await carregarDaily();
  await carregarGruposPlanejamento();
  aplicarFiltros();
});

// ================= PDF EXPORT =================

// ---- HELPER: renderizar HTML como página de PDF ----
async function htmlParaPDF(pdf, htmlStr, orientacao, primeira){
  if(!htmlStr){ console.warn("htmlParaPDF: vazio, pulando."); return; }
  const wrapper = document.createElement("div");
  wrapper.style.cssText = "position:fixed;left:-9999px;top:-9999px;background:#ffffff;";
  wrapper.innerHTML = htmlStr;
  document.body.appendChild(wrapper);
  try {
    const imgs = Array.from(wrapper.querySelectorAll("img"));
    if(imgs.length > 0){
      await Promise.all(imgs.map(img =>
        img.complete ? Promise.resolve() : new Promise(r => { img.onload = r; img.onerror = r; })
      ));
    }
    await new Promise(r => setTimeout(r, 350));

    const [pdfW, pdfH] = orientacao === "landscape" ? [297,210] : [210,297];
    const margem = 5;
    const areaW  = pdfW - margem * 2;
    const areaH  = pdfH - margem * 2;

    // Limita altura da captura a 1 pagina A4 para evitar pagina extra com so rodape
    const escala   = 1.5;
    const maxPxH   = Math.round((wrapper.scrollWidth / areaW) * areaH * escala);
    const capturaH = Math.min(wrapper.scrollHeight, maxPxH);

    const canvas = await html2canvas(wrapper, {
      scale: escala,
      useCORS: true,
      backgroundColor: "#ffffff",
      logging: false,
      width:        wrapper.scrollWidth,
      height:       capturaH,
      windowWidth:  wrapper.scrollWidth,
      windowHeight: capturaH,
    });

    const imgData = canvas.toDataURL("image/jpeg", 0.85);
    const ratio   = canvas.width / canvas.height;
    const imgW    = areaW;
    const imgH    = Math.min(imgW / ratio, areaH);

    if(!primeira) pdf.addPage();
    pdf.addImage(imgData, "JPEG", margem, margem, imgW, imgH);

    // Rodape via jsPDF — nunca estoura a pagina
    const rodapeY = pdfH - 4;
    pdf.setFontSize(7);
    pdf.setTextColor(150, 150, 150);
    pdf.text("DEPTO. DE INTELIGÊNCIA ESPORTIVA - CIENTE IE", margem, rodapeY);
    pdf.text("Gerado em " + new Date().toLocaleString("pt-BR"), pdfW - margem, rodapeY, { align: "right" });
    pdf.setTextColor(0, 0, 0);

  } finally {
    if(wrapper.parentNode) document.body.removeChild(wrapper);
  }
}

// ---- PALETA DE CORES SEMÂNTICAS (compartilhada pelos dois relatórios) ----
function corProntidao(v){
  if(v==null) return {bg:"#f3f4f6", text:"#9ca3af", border:"#e5e7eb"};
  if(v>=70)   return {bg:"#dcfce7", text:"#15803d", border:"#86efac"};
  if(v>=60)   return {bg:"#fef9c3", text:"#a16207", border:"#fde047"};
  if(v>=50)   return {bg:"#ffedd5", text:"#c2410c", border:"#fdba74"};
  return           {bg:"#fee2e2", text:"#b91c1c", border:"#fca5a5"};
}
function corStatus(s){
  if(s==="Estável")      return {bg:"#dcfce7", text:"#15803d", border:"#86efac"};
  if(s==="Atenção Leve") return {bg:"#fef9c3", text:"#a16207", border:"#fde047"};
  if(s==="Atenção")      return {bg:"#ffedd5", text:"#c2410c", border:"#fdba74"};
  if(s==="Crítico")      return {bg:"#fee2e2", text:"#b91c1c", border:"#fca5a5"};
  return                        {bg:"#f3f4f6", text:"#6b7280", border:"#e5e7eb"};
}
function corImpacto(i){
  if(i==="Alto")     return {bg:"#fee2e2", text:"#b91c1c"};
  if(i==="Moderado") return {bg:"#fef9c3", text:"#a16207"};
  if(i==="Baixo")    return {bg:"#dcfce7", text:"#15803d"};
  return                    {bg:"#f3f4f6", text:"#9ca3af"};
}
function pill(label, cor){
  return `<span style="background:${cor.bg};color:${cor.text};border:1px solid ${cor.border||cor.bg};
                        font-size:10px;font-weight:700;padding:2px 8px;border-radius:20px;white-space:nowrap;">${label}</span>`;
}
function valorColorido(v, fontSize="11px"){
  const c = corProntidao(v);
  const display = v!=null ? Number(v).toFixed(1) : "—";
  return `<span style="color:${c.text};font-weight:700;font-size:${fontSize};">${display}</span>`;
}
function corCarga(v){
  if(v==null) return {bg:"#f3f4f6", text:"#9ca3af", border:"#e5e7eb"};
  if(v<300)   return {bg:"#dbeafe", text:"#1d4ed8", border:"#93c5fd"};
  if(v<600)   return {bg:"#dcfce7", text:"#15803d", border:"#86efac"};
  if(v<800)   return {bg:"#ffedd5", text:"#c2410c", border:"#fdba74"};
  return           {bg:"#fee2e2", text:"#b91c1c", border:"#fca5a5"};
}
function corDensidade(v){
  if(v==null) return {bg:"#f3f4f6", text:"#9ca3af", border:"#e5e7eb"};
  if(v<=40)   return {bg:"#e0f2fe", text:"#0369a1", border:"#7dd3fc"};
  if(v<=60)   return {bg:"#dcfce7", text:"#15803d", border:"#86efac"};
  if(v<=80)   return {bg:"#ffedd5", text:"#c2410c", border:"#fdba74"};
  return           {bg:"#fee2e2", text:"#b91c1c", border:"#fca5a5"};
}

// ================= PDF DIÁRIO =================

function cardPDF(titulo, valor, legenda, accentColor){
  const left = accentColor||"#1e40af";
  return `<div style="background:#f8faff;border-radius:8px;padding:14px 16px;border:1px solid #e5e7eb;border-left:4px solid ${left};">
    <div style="font-size:10px;color:#6b7280;font-weight:600;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.5px;">${titulo}</div>
    <div style="font-size:26px;font-weight:800;color:#1e293b;line-height:1;">${valor}</div>
    <div style="font-size:10px;color:#9ca3af;margin-top:4px;">${legenda}</div>
  </div>`;
}

function cardPDFSm(titulo, valor, numVal){
  const c = corProntidao(numVal);
  return `<div style="background:${c.bg};border-radius:8px;padding:10px 12px;text-align:center;border:1px solid ${c.border};">
    <div style="font-size:10px;color:${c.text};font-weight:600;margin-bottom:2px;text-transform:uppercase;">${titulo}</div>
    <div style="font-size:20px;font-weight:800;color:${c.text};">${valor}</div>
  </div>`;
}
// Variante para CMJ: limiares ≥60 Estável · 50–59 Atenção Leve · 40–49 Atenção · <40 Crítico
function cardPDFSmCMJ(titulo, valor, numVal){
  const bg  = numVal == null ? "#f3f4f6" : numVal >= 60 ? "#dcfce7" : numVal >= 50 ? "#fef9c3" : numVal >= 40 ? "#ffedd5" : "#fee2e2";
  const text = numVal == null ? "#9ca3af" : numVal >= 60 ? "#15803d" : numVal >= 50 ? "#a16207" : numVal >= 40 ? "#c2410c" : "#b91c1c";
  const border = numVal == null ? "#e5e7eb" : numVal >= 60 ? "#86efac" : numVal >= 50 ? "#fde047" : numVal >= 40 ? "#fdba74" : "#fca5a5";
  return `<div style="background:${bg};border-radius:8px;padding:10px 12px;text-align:center;border:1px solid ${border};">
    <div style="font-size:10px;color:${text};font-weight:600;margin-bottom:2px;text-transform:uppercase;">${titulo}</div>
    <div style="font-size:20px;font-weight:800;color:${text};">${valor}</div>
  </div>`;
}

function gerarPaginaPosicao(pos, rows, data){
  const mediaGlobal   = media(rows.map(r=>r.global));
  const mediaCarga    = media(rows.map(r=>r.carga));
  const mediaDens     = media(rows.map(r=>r.densidade));
  const mediaFadiga   = media(rows.map(r=>r.fadiga));
  const mediaMuscular = media(rows.map(r=>r.muscular));
  const mediaAuto     = media(rows.map(r=>r.autonomico));
  const mediaCog      = media(rows.map(r=>r.cognitivo));
  const totalAtletas  = rows.length;
  const criticos     = rows.filter(r=>r.status==="Crítico").length;
  const atencao      = rows.filter(r=>r.status==="Atenção").length;
  const atencaoLeve  = rows.filter(r=>r.status==="Atenção Leve").length;
  const estaveis     = rows.filter(r=>r.status==="Estável").length;

  const linhasTabela = rows.map((r,i)=>{
    const cs = corStatus(r.status);
    const lacwr = labelACWR(r.acwr);
    const _tIspPos = r.ispTend?.global;
    const bg = i%2===0?"#ffffff":"#f9fafb";
    return `<tr style="background:${bg};">
      <td style="padding:7px 8px;border-bottom:1px solid #e5e7eb;font-weight:600;border-left:3px solid ${cs.border};">${r.nome}</td>
      <td style="padding:7px 8px;border-bottom:1px solid #e5e7eb;text-align:center;">${valorColorido(r.global,"12px")}</td>
      <td style="padding:7px 8px;border-bottom:1px solid #e5e7eb;text-align:center;">${pill(r.status, cs)}</td>
      <td style="padding:7px 8px;border-bottom:1px solid #e5e7eb;text-align:center;">${valorColorido(r.fadiga)}</td>
      <td style="padding:7px 8px;border-bottom:1px solid #e5e7eb;text-align:center;">${valorColorido(r.muscular)}</td>
      <td style="padding:7px 8px;border-bottom:1px solid #e5e7eb;text-align:center;">${valorColorido(r.autonomico)}</td>
      <td style="padding:7px 8px;border-bottom:1px solid #e5e7eb;text-align:center;">${valorColorido(r.cognitivo)}</td>
      <td style="padding:7px 8px;border-bottom:1px solid #e5e7eb;text-align:center;font-size:11px;">${r.carga??"—"}</td>
      <td style="padding:7px 8px;border-bottom:1px solid #e5e7eb;text-align:center;font-size:11px;">${r.densidade??"—"}</td>
      <td style="padding:7px 8px;border-bottom:1px solid #e5e7eb;text-align:center;">
        ${r.global != null ? `<span style="background:${lacwr.bg};color:${lacwr.cor};font-size:10px;font-weight:700;padding:2px 7px;border-radius:20px;">${lacwr.texto}</span>` : '<span style="color:#d1d5db;font-size:10px;">—</span>'}
      </td>
      <td style="padding:7px 8px;border-bottom:1px solid #e5e7eb;text-align:center;">
        ${_tIspPos ? `<span style="background:${_tIspPos.bg};color:${_tIspPos.cor};font-size:10px;font-weight:700;padding:2px 7px;border-radius:20px;">${_tIspPos.icon} ${_tIspPos.label}</span>` : '<span style="color:#d1d5db;font-size:10px;">—</span>'}
      </td>
    </tr>`;
  }).join("");

  const mgNum = parseFloat(mediaGlobal);
  const cgPront = corProntidao(isNaN(mgNum)?null:mgNum);

  return `
    <div style="font-family:'Segoe UI',Arial,sans-serif;background:#ffffff;width:900px;padding:30px;box-sizing:border-box;">
      <!-- CABEÇALHO -->
      <div style="display:flex;justify-content:space-between;align-items:flex-end;border-bottom:3px solid #1e40af;padding-bottom:12px;margin-bottom:20px;">
        <div>
          <div style="font-size:10px;color:#6b7280;letter-spacing:2px;text-transform:uppercase;margin-bottom:4px;">Relatório de Prontidão & Carga</div>
          <div style="font-size:28px;font-weight:900;color:#1e293b;">${pos.toUpperCase()}</div>
        </div>
        <div style="text-align:right;font-size:11px;color:#6b7280;">
          <div>Data: <strong style="color:#1e293b;">${data}</strong></div>
          <div>${totalAtletas} atletas</div>
        </div>
      </div>

      <!-- CARDS PRINCIPAIS -->
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:16px;">
        ${cardPDF("Prontidão Média", `<span style="color:${cgPront.text};">${mediaGlobal}</span>`, "Índice geral integrado", cgPront.border)}
        ${cardPDF("Carga Média", mediaCarga, "PSE × Volume", "#f97316")}
        ${cardPDF("Densidade Média", mediaDens, "Carga relativa ao tempo", "#8b5cf6")}
      </div>

      <!-- CARDS INDICADORES -->
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px;">
        ${cardPDFSm("Fadiga (Hooper)", mediaFadiga, parseFloat(mediaFadiga))}
        ${cardPDFSmCMJ("Neuromuscular CMJ", mediaMuscular, parseFloat(mediaMuscular))}
        ${cardPDFSm("VFC Autonômico", mediaAuto, parseFloat(mediaAuto))}
        ${cardPDFSm("Cognitivo", mediaCog, parseFloat(mediaCog))}
      </div>

      <!-- CONTAGEM STATUS -->
      <div style="display:flex;gap:10px;margin-bottom:20px;">
        <div style="background:#fee2e2;border:1px solid #fca5a5;border-radius:8px;padding:8px 18px;text-align:center;flex:1;">
          <div style="font-size:22px;font-weight:900;color:#b91c1c;">${criticos}</div>
          <div style="font-size:11px;color:#b91c1c;font-weight:700;">Crítico</div>
        </div>
        <div style="background:#ffedd5;border:1px solid #fdba74;border-radius:8px;padding:8px 18px;text-align:center;flex:1;">
          <div style="font-size:22px;font-weight:900;color:#c2410c;">${atencao}</div>
          <div style="font-size:11px;color:#c2410c;font-weight:700;">Atenção</div>
        </div>
        <div style="background:#fef9c3;border:1px solid #fde047;border-radius:8px;padding:8px 18px;text-align:center;flex:1;">
          <div style="font-size:22px;font-weight:900;color:#a16207;">${atencaoLeve}</div>
          <div style="font-size:11px;color:#a16207;font-weight:700;">Atenção Leve</div>
        </div>
        <div style="background:#dcfce7;border:1px solid #86efac;border-radius:8px;padding:8px 18px;text-align:center;flex:1;">
          <div style="font-size:22px;font-weight:900;color:#15803d;">${estaveis}</div>
          <div style="font-size:11px;color:#15803d;font-weight:700;">Estável</div>
        </div>
      </div>

      <!-- TABELA -->
      <div style="font-size:10px;font-weight:700;color:#6b7280;letter-spacing:1px;text-transform:uppercase;margin-bottom:8px;">Dados Individuais</div>
      <table style="width:100%;border-collapse:collapse;font-size:11px;">
        <thead>
          <tr style="background:#1e40af;color:#ffffff;">
            <th style="padding:9px 8px;text-align:left;border-radius:6px 0 0 0;">Atleta</th>
            <th style="padding:9px 8px;text-align:center;">Prontidão</th>
            <th style="padding:9px 8px;text-align:center;">Status</th>
            <th style="padding:9px 8px;text-align:center;">Fadiga</th>
            <th style="padding:9px 8px;text-align:center;">Muscular</th>
            <th style="padding:9px 8px;text-align:center;">Autonômico</th>
            <th style="padding:9px 8px;text-align:center;">Cognitivo</th>
            <th style="padding:9px 8px;text-align:center;">Carga</th>
            <th style="padding:9px 8px;text-align:center;">Densidade</th>
            <th style="padding:9px 8px;text-align:center;">ACWR</th>
      <th style="padding:9px 8px;text-align:center;border-radius:0 6px 0 0;">ISP</th>
          </tr>
        </thead>
        <tbody>${linhasTabela}</tbody>
      </table>

      <!-- LEGENDA -->
      <div style="margin-top:14px;display:flex;gap:12px;font-size:10px;align-items:center;flex-wrap:wrap;">
        <span style="color:#6b7280;font-weight:600;">Indicadores (0–100):</span>
        <span style="color:#15803d;">■ ≥70 Estável</span>
        <span style="color:#a16207;">■ 60–69 Atenção Leve</span>
        <span style="color:#c2410c;">■ 50–59 Atenção</span>
        <span style="color:#b91c1c;">■ &lt;50 Crítico</span>
        <span style="color:#6b7280;margin-left:6px;">· CMJ: ≥60 Estável · 50–59 Atenção Leve · 40–49 Atenção · &lt;40 Crítico</span>
      </div>

      <!-- RODAPÉ -->
      <div style="margin-top:12px;border-top:2px solid #e5e7eb;padding-top:8px;display:flex;justify-content:space-between;align-items:center;font-size:10px;color:#64748b;">
        <span style="font-weight:700;color:#1e293b;">DEPTO. DE INTELIGÊNCIA ESPORTIVA - CIENTE IE</span>
        <span>Gerado em ${new Date().toLocaleString("pt-BR")}</span>
      </div>
    </div>`;
}


// ── PDF Diário — página com as duas tabelas de resultado do dia ───────────────
async function gerarPaginaPDFDiario(rows, data, dataFmt, categoria) {
  const fmt = (v, dec=1) => v != null ? Number(v).toFixed(dec) : "—";

  // Cores de badge inline para PDF
  function bdg(text, bg, color) {
    return `<span style="display:inline-block;padding:2px 8px;border-radius:20px;font-size:9px;font-weight:700;background:${bg};color:${color};white-space:nowrap;">${text}</span>`;
  }
  function bdgChegada(global) {
    if (global == null) return bdg("Sem dado",    "#f3f4f6", "#9ca3af");
    if (global >= 70)   return bdg("Estável",     "#dcfce7", "#15803d");
    if (global >= 60)   return bdg("Atenção Leve","#fef9c3", "#a16207");
    if (global >= 50)   return bdg("Atenção",     "#ffedd5", "#c2410c");
    return                     bdg("Crítico",     "#fee2e2", "#b91c1c");
  }
  function bdgResposta(r) {
    if (!r) return bdg("Sem dado", "#f3f4f6", "#9ca3af");
    if (r.custoSessao <= 4) return bdg("Baixo custo", "#dcfce7", "#15803d");
    if (r.custoSessao <= 8) return bdg("Moderado",    "#fef9c3", "#a16207");
    return                         bdg("Alto custo",  "#fee2e2", "#b91c1c");
  }
  function bdgCusto(v) {
    if (v == null) return bdg("—",           "#f3f4f6", "#9ca3af");
    if (v <= 4)    return bdg("CBT baixo",   "#dcfce7", "#15803d");
    if (v <= 9)    return bdg("CBT leve",    "#fef9c3", "#a16207");
    if (v <= 14)   return bdg("CBT moderado","#ffedd5", "#c2410c");
    return                bdg("CBT alto",   "#fee2e2", "#b91c1c");
  }
  function bdgSistema(nome) {
    if (!nome) return bdg("—", "#f3f4f6", "#9ca3af");
    const mapa = {
      "Neuromuscular": ["#ede9fe","#6d28d9"],
      "Subjetivo":     ["#dbeafe","#1d4ed8"],
      "Autonômico":    ["#ccfbf1","#0f766e"],
      "Cognitivo":     ["#fce7f3","#9d174d"],
    };
    const c = mapa[nome] || ["#f3f4f6","#9ca3af"];
    return bdg(nome, c[0], c[1]);
  }
  function bdgCargaPDF(v) {
    if (v == null) return bdg("—", "#f3f4f6", "#9ca3af");
    if (v < 300)  return bdg("Regenerativa", "#dbeafe", "#1d4ed8");
    if (v < 600)  return bdg("Moderada",     "#dcfce7", "#15803d");
    if (v < 800)  return bdg("Alta",         "#fef9c3", "#a16207");
    return               bdg("Muito alta",   "#fee2e2", "#b91c1c");
  }
  function bdgLeitura(cl) {
    if (!cl || cl === "Sem dados suficientes") return bdg("Sem dados", "#f3f4f6", "#9ca3af");
    if (cl === "Boa tolerância")      return bdg("Boa tolerância",      "#dcfce7", "#15803d");
    if (cl === "Resposta compatível") return bdg("Resposta compatível", "#fef9c3", "#a16207");
    if (cl === "Dia pesado")          return bdg("Dia pesado",          "#ffedd5", "#c2410c");
    return                                   bdg("Sobrecarga do dia",   "#fee2e2", "#b91c1c");
  }

  // Métricas coletivas
  function avg(arr) { const v = arr.filter(x => x != null); return v.length ? v.reduce((a,b)=>a+b,0)/v.length : null; }
  const mediaPront  = avg(rows.map(r => r.global));
  const mediaCargaV = avg(rows.map(r => r.carga));
  const mediaCusto  = avg(rows.map(r => r.custoEntrada));

  const sistemasGrupo = rows.map(r => r.sistemaSemana?.nome).filter(Boolean);
  const sistemaMaisFreq = sistemasGrupo.length
    ? Object.entries(sistemasGrupo.reduce((acc, s) => { acc[s]=(acc[s]||0)+1; return acc; }, {}))
        .sort((a,b)=>b[1]-a[1])[0][0]
    : "—";

  const resumoParagrafo = gerarResumoColetivo(rows);

  // ── Métricas de referência de jogo ─────────────────────────────────────────
  const mediaDuracao = avg(rows.map(r => r.volume));
  const pctCarga  = mediaCargaV  != null ? Math.round(mediaCargaV  / CARGA_JOGO_REF  * 100) : null;
  const pctVolume = mediaDuracao != null ? Math.round(mediaDuracao / VOLUME_JOGO_REF * 100) : null;

  // ── Gráfico A — Carga da Sessão vs Referência do Jogo ────────────────────
  function mkCanvasDiario(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.style.position = 'absolute'; c.style.left = '-9999px';
    document.body.appendChild(c);
    return c;
  }
  function toImgDiario(chart, canvas) {
    return new Promise(resolve => setTimeout(() => {
      const url = canvas.toDataURL('image/png');
      chart.destroy(); canvas.remove(); resolve(url);
    }, 400));
  }

  const cA = mkCanvasDiario(340, 180);
  const corBarraA = mediaCargaV == null ? '#e2e8f0' : mediaCargaV >= CARGA_JOGO_REF ? '#ef4444' : mediaCargaV >= 600 ? '#f97316' : mediaCargaV >= 300 ? '#22c55e' : '#3b82f6';
  const gA = new Chart(cA, {
    type: 'bar',
    data: {
      labels: ['Sessão'],
      datasets: [
        { data: [mediaCargaV ?? 0], backgroundColor: corBarraA, borderRadius: 6, borderSkipped: false, label: 'Carga (UA)', order: 2 },
        { type:'line', data: [CARGA_JOGO_REF, CARGA_JOGO_REF], borderColor:'rgba(234,179,8,0.9)', backgroundColor:'transparent', borderWidth:1.5, borderDash:[6,4], pointRadius:0, label:`Ref. Jogo (${CARGA_JOGO_REF} u.a.)`, order:1 }
      ]
    },
    options: {
      animation: false, responsive: false,
      plugins: {
        legend: { display: true, position: 'bottom', labels: { font: { size: 9 }, boxWidth: 10 } },
        title: { display: true, text: 'Carga da Sessão vs Referência do Jogo', font: { size: 10, weight: '700' }, color: '#1e293b', padding: { bottom: 8 } },
        tooltip: { callbacks: { label: ctx => ctx.dataset.label + ': ' + (ctx.parsed.y?.toFixed(0) ?? '—') } }
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 9 } } },
        y: { beginAtZero: true, grid: { color: '#f1f5f9' }, ticks: { font: { size: 9 } },
             title: { display: true, text: 'Carga (UA)', font: { size: 9 } } }
      }
    }
  });
  // Desenha o % sobre a barra
  if (mediaCargaV != null) {
    const pluginPct = {
      id: 'pctLabel',
      afterDatasetsDraw(chart) {
        const { ctx, scales: { y }, data } = chart;
        const meta = chart.getDatasetMeta(0);
        meta.data.forEach((bar, i) => {
          const val = data.datasets[0].data[i];
          if (val == null) return;
          const pct = Math.round(val / CARGA_JOGO_REF * 100);
          ctx.save();
          ctx.font = 'bold 12px Segoe UI, Arial';
          ctx.fillStyle = '#1e293b';
          ctx.textAlign = 'center';
          ctx.fillText(`${pct}% do jogo`, bar.x, bar.y - 6);
          ctx.restore();
        });
      }
    };
    gA.config.plugins = gA.config.plugins || [];
    gA.config.plugins.push(pluginPct);
    gA.update();
  }
  const imgA = await toImgDiario(gA, cA);

  // ── Gráfico B — IGP do Grupo (últimos 7 dias até a data selecionada) ────────
  const dataObj = new Date(data + 'T12:00:00');
  const igpDias = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(dataObj);
    d.setDate(d.getDate() - (6 - i));
    return d.toISOString().slice(0, 10);
  });
  const idsRows = new Set(rows.map(r => r.id));
  const igpVals = igpDias.map(dt => {
    const vals = historico
      .filter(h => h.date === dt && idsRows.has(h.athleteId))
      .map(h => calcularProntidao(h).global)
      .filter(v => v != null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  });
  const igpLabels = igpDias.map(dt => {
    const [, m, d2] = dt.split('-');
    return `${d2}/${m}`;
  });
  const igpBgColors = igpDias.map(dt =>
    dt === data ? 'rgba(99,102,241,0.85)' : 'rgba(59,130,246,0.55)'
  );

  const cB = mkCanvasDiario(340, 180);
  const gB = new Chart(cB, {
    type: 'bar',
    data: {
      labels: igpLabels,
      datasets: [{ data: igpVals, backgroundColor: igpBgColors, borderRadius: 4, borderSkipped: false, label: 'IGP Grupo' }]
    },
    options: {
      animation: false, responsive: false,
      plugins: {
        legend: { display: false },
        title: { display: true, text: 'IGP do Grupo — últimos 7 dias', font: { size: 10, weight: '700' }, color: '#1e293b', padding: { bottom: 8 } },
        tooltip: { callbacks: { label: ctx => 'IGP: ' + (ctx.parsed.y?.toFixed(1) ?? '—') } }
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 9 }, color: igpDias.map(dt => dt === data ? '#6366f1' : '#666') } },
        y: { min: 0, max: 100, grid: { color: '#f1f5f9' }, ticks: { font: { size: 9 } },
             title: { display: true, text: 'IGP (0–100)', font: { size: 9 } } }
      }
    }
  });
  const imgB = await toImgDiario(gB, cB);

  // Linhas Bloco 1
  const linhasBloco1 = rows.map((r, i) => {
    const ss = r.sistemaSemana;
    const bg = i % 2 === 0 ? "#ffffff" : "#f9fafb";
    const corGlobal = r.global != null ? (r.global>=70?"#15803d":r.global>=60?"#a16207":r.global>=50?"#c2410c":"#b91c1c") : "#9ca3af";
    return `<tr style="background:${bg};">
      <td style="padding:7px 8px;border-bottom:1px solid #e5e7eb;font-weight:700;font-size:11px;">${r.nome}<br><span style="font-weight:400;font-size:9px;color:#9ca3af;">${r.posicao||""}</span>${r.faseRTP ? `<br><span style="display:inline-block;margin-top:2px;padding:1px 6px;border-radius:999px;font-size:9px;font-weight:800;background:${r.faseRTP.bg};color:${r.faseRTP.cor};">F${r.faseRTP.fase} · ${r.faseRTP.label}</span>` : ''}</td>
      <td style="padding:7px 8px;border-bottom:1px solid #e5e7eb;text-align:center;">
        <span style="font-size:14px;font-weight:800;color:${corGlobal};">${fmt(r.global)}</span><br>
        <span style="font-size:9px;color:#9ca3af;">basal ${fmt(r.basal)}</span><br>
        ${bdgChegada(r.global)}
      </td>
      <td style="padding:7px 8px;border-bottom:1px solid #e5e7eb;text-align:center;">
        <span style="font-size:11px;font-weight:700;color:#374151;">${r.custoEntrada != null ? r.custoEntrada.toFixed(1) + ' pts' : '—'}</span><br>
        ${bdgCusto(r.custoEntrada)}
      </td>
      <td style="padding:7px 8px;border-bottom:1px solid #e5e7eb;text-align:center;">
        ${ss ? `${bdgSistema(ss.nome)}<br><span style="font-size:9px;color:#9ca3af;">${ss.score} pts · ${ss.diasDesde === 0 ? 'hoje' : ss.diasDesde+'d'} · ${ss.confianca}</span>` : '<span style="color:#d1d5db;font-size:10px;">—</span>'}
      </td>
    </tr>`;
  }).join("");

  // Linhas Bloco 2
  const linhasBloco2 = rows.map((r, i) => {
    const bg = i % 2 === 0 ? "#ffffff" : "#f9fafb";
    return `<tr style="background:${bg};">
      <td style="padding:7px 8px;border-bottom:1px solid #e5e7eb;font-weight:700;font-size:11px;">${r.nome}<br><span style="font-weight:400;font-size:9px;color:#9ca3af;">${r.posicao||""}</span>${r.faseRTP ? `<br><span style="display:inline-block;margin-top:2px;padding:1px 6px;border-radius:999px;font-size:9px;font-weight:800;background:${r.faseRTP.bg};color:${r.faseRTP.cor};">F${r.faseRTP.fase} · ${r.faseRTP.label}</span>` : ''}</td>
      <td style="padding:7px 8px;border-bottom:1px solid #e5e7eb;text-align:center;">
        <span style="font-size:12px;font-weight:700;color:#1e293b;">${r.carga != null ? Math.round(r.carga) + ' UA' : '—'}</span><br>
        <span style="font-size:9px;color:#9ca3af;">${[r.pse != null ? 'PSE '+r.pse : null, r.volume != null ? r.volume+'min' : null].filter(Boolean).join(' · ')||'—'}</span><br>
        ${bdgCargaPDF(r.carga)}
      </td>
      <td style="padding:7px 8px;border-bottom:1px solid #e5e7eb;text-align:center;">${bdgLeitura(r.leituraDia?.classificacao)}</td>
      <td style="padding:7px 8px;border-bottom:1px solid #e5e7eb;font-size:9px;color:#64748b;line-height:1.55;max-width:200px;">${r.fraseResultadoDia ?? "—"}</td>
    </tr>`;
  }).join("");

  return `
    <div style="font-family:'Segoe UI',Arial,sans-serif;background:#ffffff;width:860px;padding:28px 30px;box-sizing:border-box;color:#1e293b;">

      <!-- CABEÇALHO -->
      <div style="border-bottom:3px solid #1e40af;padding-bottom:12px;margin-bottom:18px;">
        <div style="font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#94a3b8;margin-bottom:4px;">Relatório do Dia · Prontidão e CBT</div>
        <div style="display:flex;justify-content:space-between;align-items:flex-end;">
          <div style="font-size:22px;font-weight:900;color:#1e293b;">Resultado do Dia</div>
          <div style="text-align:right;font-size:11px;color:#6b7280;">
            <div>Data: <strong style="color:#1e293b;">${dataFmt}</strong>${categoria ? ' · ' + categoria : ''}</div>
            <div style="margin-top:3px;">
              Prontidão média: <strong>${mediaPront != null ? mediaPront.toFixed(1) : "—"}</strong> &nbsp;·&nbsp;
              Carga média: <strong>${mediaCargaV != null ? Math.round(mediaCargaV) : "—"}</strong> &nbsp;·&nbsp;
              Custo médio de entrada: <strong>${mediaCusto != null ? mediaCusto.toFixed(1) : "—"}</strong> &nbsp;·&nbsp;
              Sistema mais afetado: <strong>${sistemaMaisFreq}</strong>
            </div>
          </div>
        </div>
      </div>

      <!-- RESUMO COLETIVO -->
      <div style="background:#f0f9ff;border-left:4px solid #0ea5e9;border-radius:0 8px 8px 0;padding:10px 14px;margin-bottom:12px;font-size:11px;color:#0c4a6e;line-height:1.6;">
        <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#0369a1;margin-bottom:5px;">Resumo coletivo</div>
        ${resumoParagrafo}
      </div>

      <!-- KPIs REFERÊNCIA DE JOGO -->
      <div style="display:flex;gap:12px;margin-bottom:12px;align-items:center;flex-wrap:wrap;">
        <span style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#64748b;">Ref. Jogo:</span>
        ${pctCarga != null ? `<span style="background:${pctCarga>=100?'#fee2e2':pctCarga>=75?'#ffedd5':pctCarga>=50?'#fef9c3':'#dbeafe'};color:${pctCarga>=100?'#b91c1c':pctCarga>=75?'#c2410c':pctCarga>=50?'#a16207':'#1d4ed8'};font-weight:700;font-size:11px;padding:3px 12px;border-radius:20px;">⚡ ${pctCarga}% da carga do jogo</span>` : `<span style="background:#f3f4f6;color:#9ca3af;font-size:11px;padding:3px 12px;border-radius:20px;font-weight:700;">⚡ Carga: sem dado</span>`}
        ${pctVolume != null ? `<span style="background:${pctVolume>=100?'#fee2e2':pctVolume>=75?'#ffedd5':pctVolume>=50?'#fef9c3':'#dbeafe'};color:${pctVolume>=100?'#b91c1c':pctVolume>=75?'#c2410c':pctVolume>=50?'#a16207':'#1d4ed8'};font-weight:700;font-size:11px;padding:3px 12px;border-radius:20px;">⏱ ${pctVolume}% do volume do jogo</span>` : `<span style="background:#f3f4f6;color:#9ca3af;font-size:11px;padding:3px 12px;border-radius:20px;font-weight:700;">⏱ Volume: sem dado</span>`}
        <span style="font-size:9px;color:#94a3b8;margin-left:4px;">Ref: ${CARGA_JOGO_REF} u.a. / ${VOLUME_JOGO_REF} min</span>
      </div>

      <!-- GRÁFICOS A e B -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:16px;">
        <div style="border:1.5px solid #e2e8f0;border-radius:8px;padding:10px;">
          <img src="${imgA}" style="width:100%;height:auto;display:block;" />
        </div>
        <div style="border:1.5px solid #e2e8f0;border-radius:8px;padding:10px;">
          <img src="${imgB}" style="width:100%;height:auto;display:block;" />
        </div>
      </div>

      <!-- BLOCO 1 — Como chegou -->
      <div style="margin-bottom:20px;">
        <div style="font-size:11px;font-weight:800;color:#1e293b;margin-bottom:3px;text-transform:uppercase;letter-spacing:.5px;">Como o atleta chegou hoje</div>
        <div style="font-size:9px;color:#94a3b8;margin-bottom:8px;">Estado de entrada registrado nesta manhã.</div>
        <table style="width:100%;border-collapse:collapse;font-size:10px;">
          <thead>
            <tr style="background:#1e293b;color:#fff;">
              <th style="padding:7px 8px;text-align:left;border-radius:6px 0 0 0;">Atleta</th>
              <th style="padding:7px 8px;text-align:center;">Prontidão de entrada</th>
              <th style="padding:7px 8px;text-align:center;">CBT</th>
              <th style="padding:7px 8px;text-align:center;border-radius:0 6px 0 0;">Sistema afetado (semana)</th>
            </tr>
          </thead>
          <tbody>${linhasBloco1}</tbody>
        </table>
      </div>

      <!-- BLOCO 2 — Como respondeu -->
      <div style="margin-bottom:20px;">
        <div style="font-size:11px;font-weight:800;color:#1e293b;margin-bottom:3px;text-transform:uppercase;letter-spacing:.5px;">Como o atleta respondeu hoje</div>
        <div style="font-size:9px;color:#94a3b8;margin-bottom:8px;">Carga aplicada, leitura do dia e síntese automática.</div>
        <table style="width:100%;border-collapse:collapse;font-size:10px;">
          <thead>
            <tr style="background:#1e293b;color:#fff;">
              <th style="padding:7px 8px;text-align:left;border-radius:6px 0 0 0;">Atleta</th>
              <th style="padding:7px 8px;text-align:center;">Carga</th>
              <th style="padding:7px 8px;text-align:center;">Leitura do dia</th>
              <th style="padding:7px 8px;text-align:left;border-radius:0 6px 0 0;">Frase automática</th>
            </tr>
          </thead>
          <tbody>${linhasBloco2}</tbody>
        </table>
      </div>

      <!-- OBSERVAÇÃO FINAL -->
      <div style="background:#fefce8;border:1px solid #fde047;border-radius:8px;padding:10px 14px;font-size:10px;color:#713f12;margin-bottom:14px;">
        <strong>Observação:</strong> Os dados de prontidão referem-se à coleta do dia. A carga e leitura do dia serão confirmadas com o registro pós-treino.
      </div>

      <!-- RODAPÉ -->
      <div style="border-top:1px solid #e5e7eb;padding-top:8px;display:flex;justify-content:space-between;font-size:9px;color:#94a3b8;">
        <span style="font-weight:700;color:#64748b;">DEPTO. DE INTELIGÊNCIA ESPORTIVA - CIENTE IE</span>
        <span>Gerado em ${new Date().toLocaleString("pt-BR")}</span>
      </div>

    </div>`;
}

// ── PDF Diário — página com cards detalhados por atleta (3 por página) ────────
function gerarPaginaDetalheAtletas(rows, data, dataFmt, posLabel, pag, totalPags) {

  function corV(v) {
    if (v == null) return "#9ca3af";
    return v >= 70 ? "#15803d" : v >= 60 ? "#a16207" : v >= 50 ? "#ea580c" : "#b91c1c";
  }
  function fmt(v, dec=1) { return v != null ? Number(v).toFixed(dec) : "—"; }
  function fmtZ(z) {
    if (z == null) return "—";
    const n = parseFloat(z);
    return (n >= 0 ? "+" : "") + n.toFixed(2);
  }
  function corZ(z) {
    if (z == null) return "#9ca3af";
    const n = parseFloat(z);
    return n >= 0.5 ? "#15803d" : n >= -0.5 ? "#ca8a04" : "#b91c1c";
  }
  function corH(v) { return v == null ? "#9ca3af" : v <= 2 ? "#15803d" : v <= 4 ? "#ca8a04" : "#b91c1c"; }

  function barra(val, max, cor) {
    if (val == null) return `<div style="height:6px;background:#f1f5f9;border-radius:3px;"></div>`;
    const pct = Math.min(Math.max(val / max * 100, 0), 100).toFixed(1);
    const tr = cor === "#15803d" ? "#dcfce7" : cor === "#a16207" ? "#fef9c3" : cor === "#ea580c" ? "#ffedd5" : cor === "#b91c1c" ? "#fee2e2" : "#dbeafe";
    return `<div style="height:6px;background:${tr};border-radius:3px;overflow:hidden;"><div style="height:100%;width:${pct}%;background:${cor};border-radius:3px;"></div></div>`;
  }
  function barraZ(z) {
    if (z == null) return `<div style="height:6px;background:#f1f5f9;border-radius:3px;"></div>`;
    const n = parseFloat(z);
    const pct = Math.min(Math.max((n + 2) / 4 * 100, 0), 100).toFixed(1);
    const cor = n >= 0.5 ? "#15803d" : n >= -0.5 ? "#ca8a04" : "#b91c1c";
    const tr  = n >= 0.5 ? "#dcfce7" : n >= -0.5 ? "#fef9c3" : "#fee2e2";
    return `<div style="height:6px;background:${tr};border-radius:3px;overflow:hidden;"><div style="height:100%;width:${pct}%;background:${cor};border-radius:3px;"></div></div>`;
  }

  // Um bloco de indicador: hoje / média / z-score
  function bloco(label, val, med, z) {
    return `
      <div style="flex:1;min-width:0;">
        <div style="font-size:8px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px;">${label}</div>
        <div style="display:flex;justify-content:space-between;font-size:8px;margin-bottom:1px;">
          <span style="color:#64748b;">Hoje</span><span style="font-weight:700;color:${corV(val)};">${fmt(val)}</span>
        </div>
        ${barra(val, 100, corV(val))}
        <div style="display:flex;justify-content:space-between;font-size:8px;margin-top:3px;margin-bottom:1px;">
          <span style="color:#64748b;">Média 7d</span><span style="font-weight:600;color:${corV(med)};">${fmt(med)}</span>
        </div>
        ${barra(med, 100, corV(med))}
        <div style="display:flex;justify-content:space-between;font-size:8px;margin-top:3px;margin-bottom:1px;">
          <span style="color:#64748b;">Z-score</span><span style="font-weight:600;color:${corZ(z)};">${fmtZ(z)}</span>
        </div>
        ${barraZ(z)}
      </div>`;
  }
  // Variante para Neuromuscular (CMJ): ≥60 verde · 50–59 amarelo · 40–49 laranja · <40 vermelho
  function corVNM(v) {
    if (v == null) return "#9ca3af";
    return v >= 60 ? "#15803d" : v >= 50 ? "#a16207" : v >= 40 ? "#ea580c" : "#b91c1c";
  }
  function blocoNM(label, val, med, z) {
    return `
      <div style="flex:1;min-width:0;">
        <div style="font-size:8px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px;">${label}</div>
        <div style="display:flex;justify-content:space-between;font-size:8px;margin-bottom:1px;">
          <span style="color:#64748b;">Hoje</span><span style="font-weight:700;color:${corVNM(val)};">${fmt(val)}</span>
        </div>
        ${barra(val, 100, corVNM(val))}
        <div style="display:flex;justify-content:space-between;font-size:8px;margin-top:3px;margin-bottom:1px;">
          <span style="color:#64748b;">Média 7d</span><span style="font-weight:600;color:${corVNM(med)};">${fmt(med)}</span>
        </div>
        ${barra(med, 100, corVNM(med))}
        <div style="display:flex;justify-content:space-between;font-size:8px;margin-top:3px;margin-bottom:1px;">
          <span style="color:#64748b;">Z-score</span><span style="font-weight:600;color:${corZ(z)};">${fmtZ(z)}</span>
        </div>
        ${barraZ(z)}
      </div>`;
  }

  // Gera texto interpretativo automático baseado nos dados do atleta
  function gerarTextoInterpretativo(r) {
    if (r.global == null) return null;
    const partes = [];

    // Sistemas abaixo do limiar de atenção — só menciona se realmente comprometido
    const sistemasAlerta = [
      { nome: "Subjetivo",     val: r.IH  },
      { nome: "Neuromuscular", val: r.INM },
      { nome: "Autonômico",    val: r.IA  },
      { nome: "Cognitivo",     val: r.IC  },
    ].filter(s => s.val != null && (
      s.nome === "Neuromuscular" ? s.val < 60 : s.val < 70
    ));

    if (sistemasAlerta.length) {
      const desc = sistemasAlerta.map(s => {
        let nivel;
        if (s.nome === "Neuromuscular") {
          nivel = s.val < 40 ? "em estado crítico" : s.val < 50 ? "comprometido" : "em atenção leve";
        } else {
          nivel = s.val < 50 ? "em estado crítico" : s.val < 60 ? "comprometido" : "em atenção leve";
        }
        return `${s.nome} ${nivel} (${s.val.toFixed(0)}/100)`;
      });
      partes.push(`Sistema ${desc.join("; sistema ")}.`);
    }

    // Queixas subjetivas relevantes (>= 5/7)
    const subj = [];
    if (r.fadiga_raw != null && r.fadiga_raw >= 5) subj.push("fadiga acentuada");
    if (r.dor        != null && r.dor        >= 5) subj.push("dor muscular");
    if (r.estresse   != null && r.estresse   >= 5) subj.push("estresse elevado");
    if (r.sono       != null && r.sono       >= 5) subj.push("qualidade de sono ruim");
    if (subj.length) partes.push(`Relatos: ${subj.join(", ")}.`);

    // Carga / ACWR — só menciona se fora da zona segura
    if (r.acwr != null) {
      if      (r.acwr > 1.5) partes.push(`Razão aguda:crônica muito elevada (ACWR ${r.acwr.toFixed(2)}) — risco de overreaching.`);
      else if (r.acwr > 1.3) partes.push(`Razão aguda:crônica elevada (ACWR ${r.acwr.toFixed(2)}) — acompanhar sinais de fadiga.`);
      else if (r.acwr < 0.8) partes.push(`Carga abaixo da média crônica (ACWR ${r.acwr.toFixed(2)}) — estímulo reduzido na semana.`);
    }

    // ISP Tendência — menciona quando piorando
    if (r.ispTend?.global?.label === 'Piorando') partes.push("ISP Tendência ↓ Piorando — indicadores em queda nas últimas 4 semanas. Monitorar fadiga acumulada.");

    // Sem alertas: frase positiva só para Estável; silêncio para outros sem dados suficientes
    if (!partes.length) {
      if (r.status === "Estável") return "Todos os indicadores dentro dos parâmetros esperados.";
      return null;
    }
    return partes.join(" ");
  }

  function cardAtleta(r) {
    const stCor = r.status === "Crítico" ? "#b91c1c" : r.status === "Atenção" ? "#c2410c" : r.status === "Atenção Leve" ? "#b45309" : r.status === "Estável" ? "#15803d" : "#9ca3af";
    const stBg  = r.status === "Crítico" ? "#fee2e2" : r.status === "Atenção" ? "#ffedd5" : r.status === "Atenção Leve" ? "#fef9c3" : r.status === "Estável" ? "#dcfce7" : "#f3f4f6";
    const bord  = r.status === "Crítico" ? "#dc2626" : r.status === "Atenção" ? "#ea580c" : r.status === "Atenção Leve" ? "#ca8a04" : r.status === "Estável" ? "#16a34a" : "#d1d5db";
    const la = labelACWR(r.acwr);
    const li = labelISPTendencia(r.ispTend);
    const textoInterp = gerarTextoInterpretativo(r);

    return `
      <div style="background:#fff;border:1px solid #e5e7eb;border-left:4px solid ${bord};border-radius:8px;padding:11px 13px;box-sizing:border-box;margin-bottom:9px;">

        <!-- Cabeçalho -->
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;padding-bottom:7px;border-bottom:1px solid #f1f5f9;">
          <div>
            <span style="font-size:13px;font-weight:800;color:#1e293b;">${r.nome}</span>
            ${r.maisPrejudicado ? `<span style="font-size:9px;color:#94a3b8;margin-left:8px;">${r.maisPrejudicado}</span>` : ""}
          </div>
          <div style="display:flex;align-items:center;gap:10px;">
            ${r.global != null ? `<div style="display:flex;align-items:center;gap:4px;">
              <span style="font-size:18px;font-weight:900;color:${corV(r.global)};">${fmt(r.global)}</span>
              ${r.global != null && r.ispTend?.global ? `<span style="font-size:10px;font-weight:800;padding:1px 5px;border-radius:4px;background:${r.ispTend.global.bg};color:${r.ispTend.global.cor};">ISP ${r.ispTend.global.icon} ${r.ispTend.global.label}</span>` : ""}
            </div>` : ""}
            <span style="background:${stBg};color:${stCor};font-size:10px;font-weight:700;padding:2px 10px;border-radius:20px;">${r.status}</span>
          </div>
        </div>

        <!-- 4 indicadores em linha -->
        <div style="display:flex;gap:10px;margin-bottom:8px;">
          ${bloco("Subjetivo (Hooper)", r.IH,  r.m7f,  r.zf)}
          ${blocoNM("Neuromuscular (CMJ)", r.INM, r.m7m,  r.zm)}
          ${bloco("Autonômico (VFC)",   r.IA,  r.m7au, r.zau)}
          ${bloco("Cognitivo",          r.IC,  r.m7cg, r.zcg)}
        </div>

        <!-- Subescalas Hooper + dados brutos -->
        <div style="background:#f8fafc;border-radius:5px;padding:4px 10px;display:flex;flex-wrap:wrap;gap:8px;font-size:9px;margin-bottom:7px;">
          ${r.sono       != null ? `<span>😴 Sono <strong style="color:${corH(r.sono)};">${r.sono}/7</strong></span>` : ""}
          ${r.fadiga_raw != null ? `<span>🔋 Fadiga <strong style="color:${corH(r.fadiga_raw)};">${r.fadiga_raw}/7</strong></span>` : ""}
          ${r.estresse   != null ? `<span>🧠 Estresse <strong style="color:${corH(r.estresse)};">${r.estresse}/7</strong></span>` : ""}
          ${r.dor        != null ? `<span>💪 Dor <strong style="color:${corH(r.dor)};">${r.dor}/7</strong>${r.regioes_dor?.length ? `<span style="color:#64748b;font-size:8px;margin-left:3px;">(${r.regioes_dor.join(", ")})</span>` : r.sem_dor_localizada ? `<span style="color:#94a3b8;font-size:8px;margin-left:3px;">(sem local.)</span>` : ""}</span>` : ""}
          ${r.lnRR       != null ? `<span>❤ lnRMSSD <strong style="color:#1d4ed8;">${fmt(r.lnRR,2)}</strong></span>` : ""}
          ${r.salto      != null ? `<span>⬆ CMJ <strong style="color:#7c3aed;">${fmt(r.salto,1)} cm</strong></span>` : ""}
          ${(r.sono == null && r.fadiga_raw == null && r.estresse == null && r.dor == null && r.lnRR == null && r.salto == null) ? `<span style="color:#cbd5e1;">Sem subescalas coletadas hoje</span>` : ""}
        </div>

        <!-- Carga + ACWR + ISP -->
        <div style="display:flex;gap:7px;flex-wrap:wrap;align-items:center;font-size:9px;margin-bottom:${textoInterp ? "7px" : "0"};">
          ${r.carga  != null ? `<span style="background:#f1f5f9;border-radius:4px;padding:2px 7px;"><strong>Carga</strong> ${fmt(r.carga,0)} UA</span>` : ""}
          ${r.volume != null ? `<span style="background:#f1f5f9;border-radius:4px;padding:2px 7px;"><strong>Volume</strong> ${fmt(r.volume,0)} min</span>` : ""}
          ${r.pse    != null ? `<span style="background:#f1f5f9;border-radius:4px;padding:2px 7px;"><strong>PSE</strong> ${fmt(r.pse,1)}</span>` : ""}
          ${r.global != null ? `<span style="background:${la.bg};color:${la.cor};border-radius:4px;padding:2px 7px;font-weight:700;">ACWR ${la.texto}</span>` : ""}
          ${r.ispTend?.global ? `<span style="background:${li.bg};color:${li.cor};border-radius:4px;padding:2px 7px;font-weight:700;">ISP ${li.icon} ${li.label}</span>` : ""}
        </div>

        <!-- Texto interpretativo -->
        ${textoInterp ? `<div style="border-top:1px solid #f1f5f9;padding-top:6px;font-size:9px;color:#475569;line-height:1.5;">${textoInterp}</div>` : ""}

      </div>`;
  }

  const cardsHTML = rows.map(r => cardAtleta(r)).join("");

  return `
    <div style="font-family:'Segoe UI',Arial,sans-serif;background:#f8fafc;width:720px;padding:16px 18px;box-sizing:border-box;">

      <!-- Cabeçalho -->
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;padding-bottom:8px;border-bottom:3px solid #1e40af;">
        <div>
          <div style="font-size:9px;color:#6b7280;letter-spacing:2px;text-transform:uppercase;">Relatório Detalhado · Prontidão & Carga</div>
          <div style="font-size:18px;font-weight:900;color:#1e293b;">${CLUB_NAME||"Clube"}</div>
        </div>
        <div style="text-align:right;font-size:10px;color:#6b7280;">
          <div>Data: <strong style="color:#1e293b;">${dataFmt}</strong></div>
          <div style="margin-top:2px;">pág. ${pag+1}/${totalPags}</div>
        </div>
      </div>

      <!-- Separador de posição -->
      <div style="background:#1e293b;color:#fff;font-size:10px;font-weight:800;letter-spacing:2px;text-transform:uppercase;padding:5px 10px;border-radius:5px;margin-bottom:12px;">${posLabel.toUpperCase()}</div>

      <!-- Cards dos atletas (1 por linha) -->
      ${cardsHTML}

      <!-- Rodapé -->
      <div style="margin-top:10px;border-top:1px solid #e5e7eb;padding-top:5px;display:flex;justify-content:space-between;font-size:8px;color:#94a3b8;">
        <span>DEPTO. DE INTELIGÊNCIA ESPORTIVA - CIENTE IE</span>
        <span>Gerado em ${new Date().toLocaleString("pt-BR")}</span>
      </div>

    </div>`;
}


async function exportarPDFDiario(){
  // Redireciona para o novo relatório de janela de impressão
  await abrirModalConfirmacaoPDF();
}

async function _exportarPDFDiarioLegado(){
  const btn = document.getElementById("btnExportarPDF");
  btn.disabled = true; btn.textContent = "Gerando...";
  try {
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ orientation:"landscape", unit:"mm", format:"a4" });
    const data = document.getElementById("filtroData")?.value || hoje;
    const dataFmt = data.split("-").reverse().join("/");
    const categoria = document.getElementById("filtroCategoria")?.value || "";

    // Monta rows com os mesmos helpers do relatório na tela
    const rowsPDF = atletas.map(a => {
      const dm            = daily.find(d => d.athleteId === a.id);
      const basal         = calcularBasalAtleta(a.id);
      const calc          = calcularProntidao(dm, basal);
      const custoEntrada  = calc.custoGlobal;
      const sistemaSemana = getSistemaMaisAfetadoSemana(a.id, data);
      const leituraDia    = classificarResultadoDia({
        global: calc.global, custoEntrada, carga: dm?.post?.carga ?? null, sistemaSemana
      });
      const respostaTreino    = calcularRespostaTreino(a.id, data);
      const fraseResultadoDia = gerarFraseResultadoDia({
        global: calc.global, carga: dm?.post?.carga ?? null, sistemaSemana, leituraDia
      });
      const statusMed = statusMedicoAtleta(a.id);
      const faseRTP   = resolverFaseRTP(statusMed, a.id, dm, data);
      return {
        id: a.id, nome: a.nome, posicao: a.posicao || "—",
        global: calc.global, basal, custoEntrada,
        carga: dm?.post?.carga ?? null, volume: dm?.post?.tempo ?? null, pse: dm?.post?.pse ?? null,
        IH: calc.IH, IA: calc.IA, INM: calc.INM, IC: calc.IC,
        sistemaSemana, leituraDia, respostaTreino, fraseResultadoDia,
        statusMed, faseRTP,
      };
    }).sort((a, b) => {
      if (a.global == null && b.global == null) return 0;
      if (a.global == null) return 1;
      if (b.global == null) return -1;
      return a.global - b.global;
    });

    // Gera uma página por bloco de até 20 atletas (landscape A4 comporta bem)
    const ATLETAS_POR_PAG = 20;
    let primeira = true;
    for (let i = 0; i < rowsPDF.length; i += ATLETAS_POR_PAG) {
      const grupo = rowsPDF.slice(i, i + ATLETAS_POR_PAG);
      const html = await gerarPaginaPDFDiario(grupo, data, dataFmt, categoria);
      await htmlParaPDF(pdf, html, "landscape", primeira);
      primeira = false;
    }

    pdf.save(`RelDiario_RespostaTreino_${data}.pdf`);
    if (new URLSearchParams(window.location.search).get('from') === 'relatorios') setTimeout(() => { window.location.href = '/staff/relatorios.html'; }, 800);
  } catch(err){ console.error(err); alert("Erro ao gerar PDF. Verifique o console."); }
  finally { btn.disabled=false; btn.textContent="Relatório Diário"; }
}  // fim _exportarPDFDiarioLegado

// ================= DICIONÁRIO DE SISTEMAS (reportPhrases) =================
// Mapa de nomes capitalizados → função no desempenho
const SISTEMAS_FUNCAO_MAP = {
  'Neuromuscular': 'potência e ações explosivas',
  'Subjetivo':     'percepção de fadiga e estado geral',
  'Autonômico':    'recuperação fisiológica',
  'Cognitivo':     'tomada de decisão e tempo de reação',
  'Metabólico':    'capacidade de sustentar intensidade',
};

// ================= RELATÓRIO SEMANAL — REFORMULADO =================

// --- helpers de tendência ---
// Regressão linear sobre uma série temporal de valores (últimos N dias).
// vals: array de números (nulls ignorados), índices implícitos como x.
// Retorna { seta, cor, title } ou null se dados insuficientes (mínimo 5 pontos).
function tendencia(vals){
  const pontos = vals
    .map((y, x) => y != null ? { x, y } : null)
    .filter(Boolean);
  if(pontos.length < 5) return null;
  const n   = pontos.length;
  const sx  = pontos.reduce((s, p) => s + p.x, 0);
  const sy  = pontos.reduce((s, p) => s + p.y, 0);
  const sx2 = pontos.reduce((s, p) => s + p.x * p.x, 0);
  const sxy = pontos.reduce((s, p) => s + p.x * p.y, 0);
  const denom = n * sx2 - sx * sx;
  if(denom === 0) return null;
  const slope = (n * sxy - sx * sy) / denom;
  if(slope >  0.3) return { seta: "↑", cor: "#15803d", title: `Melhora (${slope.toFixed(2)}/dia)` };
  if(slope < -0.3) return { seta: "↓", cor: "#b91c1c", title: `Queda (${slope.toFixed(2)}/dia)` };
  return                  { seta: "→", cor: "#92400e", title: `Estável (${slope.toFixed(2)}/dia)` };
}

function pilulaTendencia(t){
  if(!t) return "<span style='color:#9ca3af;font-size:9px;'>—</span>";
  return `<span style="font-size:10px;font-weight:900;color:${t.cor};">${t.seta}</span>`;
}

function cellVal(val, colorFn, unit=''){
  if(val == null) return `<span style="color:#9ca3af;">—</span>`;
  const c = colorFn ? colorFn(val) : {text:'#1e293b'};
  return `<span style="color:${c.text};font-weight:700;">${typeof val==='number'?val.toFixed(1):val}${unit}</span>`;
}

// ================= HELPERS COMUNS DO RELATÓRIO =================

function corProntidaoRel(v){
  if(v==null) return {bg:'#f1f5f9',text:'#94a3b8',border:'#e2e8f0'};
  if(v>=70)  return {bg:'#dcfce7',text:'#15803d',border:'#86efac'};  // Estável
  if(v>=60)  return {bg:'#fef9c3',text:'#a16207',border:'#fde047'};  // Atenção Leve
  if(v>=50)  return {bg:'#ffedd5',text:'#c2410c',border:'#fdba74'};  // Atenção
  return            {bg:'#fee2e2',text:'#b91c1c',border:'#fca5a5'};  // Crítico
}

function corHooperRel(v){
  if(v==null) return {bg:'#f1f5f9',text:'#94a3b8',border:'#e2e8f0'};
  if(v<=10)  return {bg:'#dcfce7',text:'#15803d',border:'#86efac'};
  if(v<=16)  return {bg:'#fef9c3',text:'#a16207',border:'#fde047'};
  return            {bg:'#fee2e2',text:'#b91c1c',border:'#fca5a5'};
}

function rodapeSemanal(){
  return `<div style="margin-top:8px;padding-top:6px;border-top:1px solid #e5e7eb;display:flex;justify-content:space-between;align-items:center;font-size:9px;color:#94a3b8;">
    <span style="font-weight:700;color:#64748b;">DEPTO. DE INTELIGÊNCIA ESPORTIVA - CIENTE IE</span>
    <span>Gerado em ${new Date().toLocaleString("pt-BR")}</span>
  </div>`;
}

function cabecalhoSemanal(subtitulo, titulo, semLabel, info=''){
  return `
  <div style="margin-bottom:20px;">
    <div style="font-size:8px;letter-spacing:3px;text-transform:uppercase;color:#94a3b8;margin-bottom:4px;">${subtitulo}</div>
    <div style="display:flex;justify-content:space-between;align-items:flex-end;border-bottom:3px solid #1e293b;padding-bottom:10px;">
      <div style="font-size:26px;font-weight:900;color:#1e293b;letter-spacing:-0.5px;">${titulo}</div>
      <div style="text-align:right;">
        <div style="font-size:12px;font-weight:700;color:#1e293b;">Semana: ${semLabel}</div>
        ${info ? `<div style="font-size:10px;color:#94a3b8;margin-top:2px;">${info}</div>` : ''}
        <div style="font-size:9px;color:#94a3b8;margin-top:4px;">DEPTO. DE INTELIGÊNCIA ESPORTIVA - CIENTE IE</div>
      </div>
    </div>
  </div>`;
}

function tdNeutro(val, dec=1, bold=false, extra=''){
  const display = val!=null ? Number(val).toFixed(dec) : '—';
  const fw = bold ? '900' : '700';
  return `<td style="padding:7px 8px;text-align:center;border-bottom:1px solid #e5e7eb;${extra}">
    <span style="font-size:13px;font-weight:${fw};color:#1e293b;">${display}</span>
  </td>`;
}

// ================= HELPERS COLETIVOS (usados por múltiplas páginas) =================

function classificarPorISPTendencia(ispTend, global) {
  if (!ispTend?.global) return global != null && global < 60 ? 'controle' : 'apto';
  if (ispTend.global.label === 'Piorando') return 'controle';
  if (ispTend.global.label === 'Estável')  return 'monitorar';
  return 'apto'; // Melhorando
}

function gerarStatusElenco(rows) {
  const aptos     = rows.filter(r => classificarPorISPTendencia(r.ispTend, r.global) === 'apto').length;
  const monitorar = rows.filter(r => classificarPorISPTendencia(r.ispTend, r.global) === 'monitorar').length;
  const controle  = rows.filter(r => classificarPorISPTendencia(r.ispTend, r.global) === 'controle').length;
  return { aptos, monitorar, controle };
}

function gerarLeituraSemanal(mg, mhist, sistemaMaisAfetado, rows) {
  const bullets = [];
  const p = mg.pront;
  if (p == null) bullets.push('Dados de prontidão insuficientes para a semana.');
  else if (p >= 70) bullets.push(`Prontidão estável (~${Math.round(p)}) — elenco dentro do padrão da semana.`);
  else if (p >= 60) bullets.push(`Prontidão com leve atenção (~${Math.round(p)}) — monitorar tendência.`);
  else              bullets.push(`Prontidão em atenção (~${Math.round(p)}) — acompanhamento individual recomendado.`);
  const c = mg.carga;
  if (c != null) {
    if (c >= 800)      bullets.push(`Carga semanal muito elevada (≈ ${Math.round(c)} UA) — estímulo intenso.`);
    else if (c >= 600) bullets.push(`Carga semanal elevada (≈ ${Math.round(c)} UA) — estímulo consistente.`);
    else if (c >= 300) bullets.push(`Carga semanal moderada (≈ ${Math.round(c)} UA).`);
    else               bullets.push(`Carga reduzida (≈ ${Math.round(c)} UA) — semana regenerativa.`);
  }
  if (sistemaMaisAfetado) {
    const funcao = SISTEMAS_FUNCAO_MAP[sistemaMaisAfetado];
    bullets.push(`Sistema mais afetado: ${sistemaMaisAfetado}${funcao ? ` (${funcao})` : ''}.`);
  }
  const emControle = rows.filter(r => classificarPorISPTendencia(r.ispTend, r.global) === 'controle').length;
  if (emControle > 0)
    bullets.push(`${emControle} atleta${emControle > 1 ? 's' : ''} com disponibilidade reduzida na semana.`);
  return bullets;
}

function gerarImpactoJogo(sistemaMaisAfetado) {
  const mapa = {
    'Neuromuscular': [
      'Potência e ações explosivas.',
      'Acelerações e mudanças de direção.',
    ],
    'Subjetivo': [
      'Percepção de fadiga e estado geral.',
      'Tolerância ao esforço ao longo do jogo.',
    ],
    'Autonômico': [
      'Recuperação entre esforços intensos reduzida.',
      'Manutenção da intensidade comprometida.',
    ],
    'Cognitivo': [
      'Tomada de decisão e tempo de reação.',
      'Leitura de jogo em situações de pressão.',
    ],
  };
  return mapa[sistemaMaisAfetado] ?? ['Avaliar coleta dos sistemas de monitoramento.'];
}

function gerarInterpretacaoColetiva(mg, mhist, sistemaMaisAfetado) {
  const cargaAlta     = mg.carga != null && mg.carga >= 600;
  const cargaMuitoAlta = mg.carga != null && mg.carga >= 800;
  const thr = mhist.pront != null ? mhist.pront * 0.03 : 2;
  const tendPront = mg.pront == null || mhist.pront == null ? 'desconhecida'
    : mg.pront > mhist.pront + thr ? 'subindo'
    : mg.pront < mhist.pront - thr ? 'caindo'
    : 'estavel';
  if (cargaMuitoAlta && tendPront === 'estavel') return 'Carga muito elevada com manutenção da prontidão — adaptação positiva à semana.';
  if (cargaAlta && tendPront === 'estavel')      return 'Carga elevada com prontidão estável — adaptação positiva à semana.';
  if (cargaAlta && tendPront === 'subindo')      return 'Carga elevada com prontidão em alta — elenco respondeu bem ao estímulo da semana.';
  if (cargaAlta && tendPront === 'caindo')       return 'Semana de alta exigência com prontidão em atenção — monitoramento individual recomendado.';
  if (!cargaAlta && tendPront === 'caindo')      return 'Carga moderada com prontidão em atenção — acompanhamento da semana.';
  if (!cargaAlta && tendPront === 'subindo')     return 'Carga moderada com resposta positiva — prontidão em alta.';
  return 'Carga moderada com prontidão estável — resposta consistente da semana.';
}

function calcularDadosColetivos(todosAtletas, semana) {
  const avg = arr => { const v = arr.filter(x => x != null); return v.length ? v.reduce((a,b)=>a+b,0)/v.length : null; };
  const ultimoDiaSem = [...semana].reverse().find(dt =>
    todosAtletas.some(a => historico.find(d => d.athleteId === a.id && d.date === dt))
  );
  const sistemasColetivos = todosAtletas.map(a => {
    return ultimoDiaSem ? getSistemaMaisAfetadoSemana(a.id, ultimoDiaSem)?.nome : null;
  }).filter(Boolean);
  const sistemaMaisAfetado = sistemasColetivos.length
    ? Object.entries(sistemasColetivos.reduce((acc, s) => { acc[s] = (acc[s] || 0) + 1; return acc; }, {}))
        .sort((a, b) => b[1] - a[1])[0][0]
    : null;
  const rowsSemanal = todosAtletas.map(a => {
    const dms = semana.map(dt => historico.find(d => d.athleteId === a.id && d.date === dt) || null).filter(Boolean);
    const calc = dms.length ? calcularProntidao(dms[dms.length - 1]) : {};
    const acwr = calcularACWR(a.id);
    const dor  = avg(dms.map(dm => dm?.pre?.dor ?? null));
    return {
      id: a.id, nome: a.nome, posicao: a.posicao || '—',
      ispTend: calcularISPTendencia(a.id),
      global: avg(semana.map(dt => {
        const dm = historico.find(d => d.athleteId === a.id && d.date === dt);
        return dm ? calcularProntidao(dm).global : null;
      })),
      INM: calc.INM ?? null, IC: calc.IC ?? null, IA: calc.IA ?? null,
      acwr, dor,
    };
  });
  return { sistemaMaisAfetado, rowsSemanal };
}

function gerarDestaquesPosicao(dadosPos) {
  const comDados = dadosPos.filter(d => d.pront != null);
  if (comDados.length < 2) return '';
  const sorted  = [...comDados].sort((a, b) => a.pront - b.pront);
  const critica = sorted[0];
  const estavel = sorted[sorted.length - 1];

  function interpretarPos(d) {
    const funcao = d.modaSistema ? (SISTEMAS_FUNCAO_MAP[d.modaSistema] || d.modaSistema.toLowerCase()) : null;
    if (d.carga >= 600)
      return `Alta exigência com destaque para ${funcao || 'o sistema mais demandado'}.`;
    if (d.pront >= 70)
      return 'Carga controlada com prontidão preservada.';
    if (d.pront < 60)
      return `Acompanhamento da resposta semanal${funcao ? ` — atenção em ${funcao}` : ''}.`;
    return `Monitoramento da semana${funcao ? ` com ênfase em ${funcao}` : ''}.`;
  }

  // "Posição em atenção" só aparece se prontidão < 70 (atenção leve, atenção ou crítico)
  const criticaHTML = critica.pront < 70 ? `
    <div style="flex:1;background:#fee2e2;border:1px solid #fca5a5;border-radius:8px;padding:10px 12px;">
      <div style="font-size:10px;font-weight:700;color:#b91c1c;margin-bottom:4px;">${critica.pront < 50 ? 'Posição crítica' : critica.pront < 60 ? 'Posição em atenção' : 'Posição em atenção leve'}</div>
      <div style="font-size:13px;font-weight:800;color:#1e293b;">${critica.pos} <span style="font-size:11px;font-weight:400;color:#b91c1c;">(${critica.pront.toFixed(1)})</span></div>
      <div style="font-size:10px;color:#7f1d1d;margin-top:3px;">${interpretarPos(critica)}</div>
    </div>` : '';

  // "Posição mais estável" só aparece se for diferente da posição em atenção (ou se não há crítica)
  const mostrarEstavel = critica.pront >= 70 || estavel.pos !== critica.pos;
  const ravelHTML = mostrarEstavel ? `
    <div style="flex:1;background:#dcfce7;border:1px solid #86efac;border-radius:8px;padding:10px 12px;">
      <div style="font-size:10px;font-weight:700;color:#15803d;margin-bottom:4px;">Posição mais estável</div>
      <div style="font-size:13px;font-weight:800;color:#1e293b;">${estavel.pos} <span style="font-size:11px;font-weight:400;color:#15803d;">(${estavel.pront.toFixed(1)})</span></div>
      <div style="font-size:10px;color:#14532d;margin-top:3px;">${interpretarPos(estavel)}</div>
    </div>` : '';

  if (!criticaHTML && !ravelHTML) return '';
  return `<div style="display:flex;gap:10px;margin-top:14px;">${criticaHTML}${ravelHTML}</div>`;
}

function gerarLeituraMedica(todasRegSem, sistemaMaisAfetado, rowsSemanal) {
  const partes = [];
  const contagem = todasRegSem.reduce((acc, r) => { acc[r] = (acc[r] || 0) + 1; return acc; }, {});
  const top = Object.entries(contagem).sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (top.length) {
    const nomes = top.map(([r]) => r).join(', ');
    partes.push({ txt: `Maior concentração de queixas em ${nomes}.`, alerta: false });
    if (sistemaMaisAfetado)
      partes.push({ txt: `Distribuição compatível com carga ${sistemaMaisAfetado.toLowerCase()} da semana.`, alerta: false });
  }
  const comDorAlta = rowsSemanal.filter(r => r.dor != null && r.dor >= 5).length;
  if (comDorAlta > 0)
    partes.push({ txt: `${comDorAlta} atleta${comDorAlta > 1 ? 's' : ''} com dor ≥ 5/7 — controle individual recomendado.`, alerta: false });
  const alertaForte = rowsSemanal.filter(r => r.dor != null && r.dor >= 5 && classificarPorISPTendencia(r.ispTend, r.global) === 'controle').length;
  if (alertaForte > 0)
    partes.push({ txt: `${alertaForte} atleta${alertaForte > 1 ? 's com' : ' com'} dor elevada e ISP limitado — integração medical + performance obrigatória.`, alerta: true });
  if (!partes.length) return '';
  return `
    <div style="background:#fff7ed;border-left:4px solid #f97316;border-radius:0 8px 8px 0;padding:10px 14px;margin-bottom:14px;">
      <div style="font-size:10px;font-weight:700;color:#c2410c;margin-bottom:5px;text-transform:uppercase;letter-spacing:.5px;">Leitura médica da semana</div>
      ${partes.map(p => `
        <div style="font-size:11px;color:${p.alerta ? '#b91c1c' : '#7c2d12'};${p.alerta ? 'font-weight:700;' : ''}line-height:1.7;padding-left:12px;position:relative;">
          <span style="position:absolute;left:2px;font-weight:900;">·</span>${p.txt}
        </div>`).join('')}
    </div>`;
}

// ================= PÁGINA 1 — ANÁLISE COLETIVA =================

async function gerarPagina1Semanal(todosAtletas, semana){
  const avg = arr => { const v=arr.filter(x=>x!=null); return v.length?v.reduce((a,b)=>a+b,0)/v.length:null; };
  const semSet = new Set(semana);
  const semLabel = `${semana[0].split("-").slice(1).reverse().join("/")} – ${semana[6].split("-").slice(1).reverse().join("/")}/${semana[0].split("-")[0]}`;

  const allDmsSem = todosAtletas.flatMap(a =>
    semana.map(dt => historico.find(d=>d.athleteId===a.id && d.date===dt) || null)
  ).filter(Boolean);

  // Médias da equipe na semana — todos os scores em 0-100
  const mg = {
    pront:  avg(allDmsSem.map(dm => calcularProntidao(dm).global)),
    hooper: avg(allDmsSem.map(dm => dm?.pre?.hooper ?? null)),
    salto:  avg(allDmsSem.map(dm => calcularProntidao(dm).inMuscular)),
    vfc:    avg(allDmsSem.map(dm => calcularProntidao(dm).inAutonomico)),
    neuro:  avg(allDmsSem.map(dm => calcularProntidao(dm).inCognitivo)),
    carga:  avg(allDmsSem.map(dm => dm?.post?.carga ?? null)),
  };

  // Histórico 4 semanas anteriores para tendência
  const limite28 = new Date(new Date(semana[0]+'T12:00:00').getTime() - 28*86400000).toISOString().slice(0,10);
  const dmsHist = historico.filter(d => d.date >= limite28 && d.date < semana[0]);
  const dmsRef = dmsHist.length > 0 ? dmsHist : historico.filter(d => d.date < semana[0]);
  function avgHist(fn){ const vals=dmsRef.map(fn).filter(v=>v!=null); return vals.length?vals.reduce((a,b)=>a+b,0)/vals.length:null; }
  const mhist = {
    pront:  avgHist(dm => calcularProntidao(dm).global),
    hooper: avgHist(dm => dm?.pre?.hooper ?? null),
    salto:  avgHist(dm => calcularProntidao(dm).inMuscular),
    vfc:    avgHist(dm => calcularProntidao(dm).inAutonomico),
    neuro:  avgHist(dm => calcularProntidao(dm).inCognitivo),
    carga:  avgHist(dm => dm?.post?.carga ?? null),
  };

  function setaTend(valSem, valHist, invertido=false){
    if(valSem==null || valHist==null) return {seta:'', cor:'#94a3b8'};
    const diff = valSem - valHist;
    const thr = Math.abs(valHist)*0.03;
    // invertido=true: maior = pior (ex: carga — subiu = vermelho, desceu = verde)
    const melhorou = invertido ? diff < -thr : diff > thr;
    const piorou   = invertido ? diff > thr  : diff < -thr;
    // invertido=false (indicadores): subiu = ▲ verde, desceu = ▼ vermelho
    // invertido=true  (carga):       subiu = ▲ vermelho, desceu = ▼ verde
    if(melhorou) return {seta: invertido ? '↓' : '↑', cor:'#15803d'};
    if(piorou)   return {seta: invertido ? '↑' : '↓', cor:'#b91c1c'};
    return {seta:'→', cor:'#92400e'};
  }

  // ── Resumo executivo ──────────────────────────────────────────────────────────
  const { sistemaMaisAfetado, rowsSemanal } = calcularDadosColetivos(todosAtletas, semana);
  const statusElenco  = gerarStatusElenco(rowsSemanal);
  const bulletsSemana = gerarLeituraSemanal(mg, mhist, sistemaMaisAfetado, rowsSemanal);
  const impactos      = gerarImpactoJogo(sistemaMaisAfetado);
  const interpretacao = gerarInterpretacaoColetiva(mg, mhist, sistemaMaisAfetado);
  const tendGeral     = setaTend(mg.pront, mhist.pront);
  const tendCarga     = setaTend(mg.carga, mhist.carga, true);

  const resumoHTML = `
<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:18px;">

  <!-- Coluna esquerda: leitura + impacto -->
  <div>
    <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#64748b;margin-bottom:6px;">Leitura da semana</div>
    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 14px;margin-bottom:10px;">
      ${bulletsSemana.map(b => `
        <div style="font-size:11px;color:#334155;line-height:1.6;padding:2px 0 2px 14px;position:relative;">
          <span style="position:absolute;left:0;color:#94a3b8;">—</span>${b}
        </div>`).join('')}
    </div>
    <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#64748b;margin-bottom:6px;">Impacto no jogo</div>
    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 14px;">
      ${impactos.map(i => `
        <div style="font-size:11px;color:#334155;line-height:1.6;padding:2px 0 2px 16px;position:relative;">
          <span style="position:absolute;left:0;color:#6366f1;font-weight:700;">→</span>${i}
        </div>`).join('')}
    </div>
  </div>

  <!-- Coluna direita: status do elenco + cards -->
  <div>
    <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#64748b;margin-bottom:4px;">Status do elenco · ISP Tendência</div>
    <div style="font-size:9px;color:#94a3b8;margin-bottom:8px;line-height:1.5;">ISP Tendência — direção dos indicadores de prontidão nas últimas 4 semanas (regressão ponderada intraindividual).</div>
    <div style="display:flex;gap:10px;margin-bottom:12px;">
      <div style="flex:1;background:#dcfce7;border-radius:8px;padding:10px 8px;text-align:center;">
        <div style="font-size:24px;font-weight:900;color:#22c55e;line-height:1;">${statusElenco.aptos}</div>
        <div style="font-size:10px;font-weight:700;color:#22c55e;margin-top:2px;">↑ Melhorando</div>
      </div>
      <div style="flex:1;background:#fef9c3;border-radius:8px;padding:10px 8px;text-align:center;">
        <div style="font-size:24px;font-weight:900;color:#f59e0b;line-height:1;">${statusElenco.monitorar}</div>
        <div style="font-size:10px;font-weight:700;color:#f59e0b;margin-top:2px;">→ Estável</div>
      </div>
      <div style="flex:1;background:#fee2e2;border-radius:8px;padding:10px 8px;text-align:center;">
        <div style="font-size:24px;font-weight:900;color:#ef4444;line-height:1;">${statusElenco.controle}</div>
        <div style="font-size:10px;font-weight:700;color:#ef4444;margin-top:2px;">↓ Piorando</div>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 14px;">
        <div style="font-size:9px;font-weight:700;text-transform:uppercase;color:#94a3b8;margin-bottom:3px;">Prontidão geral</div>
        <div style="font-size:22px;font-weight:900;color:${mg.pront >= 70 ? '#15803d' : mg.pront >= 60 ? '#a16207' : '#b91c1c'};">${mg.pront != null ? mg.pront.toFixed(1) : '—'}</div>
        <div style="font-size:10px;color:#94a3b8;">vs histórico <span style="font-weight:900;color:${tendGeral.cor};">${tendGeral.seta || '—'}</span></div>
      </div>
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 14px;">
        <div style="font-size:9px;font-weight:700;text-transform:uppercase;color:#94a3b8;margin-bottom:3px;">Carga média</div>
        <div style="font-size:22px;font-weight:900;color:${mg.carga >= 800 ? '#b91c1c' : mg.carga >= 600 ? '#c2410c' : '#15803d'};">${mg.carga != null ? Math.round(mg.carga) : '—'}</div>
        <div style="font-size:10px;color:#94a3b8;">UA <span style="font-weight:900;color:${tendCarga.cor};">${tendCarga.seta || '—'}</span></div>
      </div>
    </div>
  </div>
</div>

<!-- Interpretação cruzada -->
<div style="background:#eff6ff;border-left:4px solid #3b82f6;border-radius:0 8px 8px 0;padding:10px 14px;margin-bottom:18px;">
  <div style="font-size:10px;font-weight:700;color:#1d4ed8;margin-bottom:3px;">Análise carga × prontidão</div>
  <div style="font-size:11px;color:#1e40af;line-height:1.5;">${interpretacao}</div>
</div>`;


  return `
  <div style="font-family:'Segoe UI',Arial,sans-serif;background:#fff;width:800px;padding:28px 30px 12px 30px;box-sizing:border-box;color:#1e293b;">
    ${cabecalhoSemanal('Relatório Semanal · Resumo Executivo','RESUMO EXECUTIVO', semLabel, `${todosAtletas.length} atletas`)}

    ${resumoHTML}

    <!-- MICROCICLO DA SEMANA — descritivo com carga real -->
    ${(() => {
      const ctx = (() => {
        try {
          function getISOWeek(d) {
            const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
            t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
            const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
            return Math.ceil((((t - y) / 86400000) + 1) / 7);
          }
          const sem = `S${getISOWeek(new Date(semana[0]+'T12:00:00'))}-${semana[0].split('-')[0]}`;
          const clubId = JSON.parse(localStorage.getItem('userContext') || '{}').clubId || '';
          const raw = localStorage.getItem(`microciclo_${sem}_${clubId}`);
          return raw ? JSON.parse(raw) : null;
        } catch { return null; }
      })();

      const periodo = ctx?.periodo || 'Período Preparatório';
      const nomesDias = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
      const labelsDias = ['D7','D1','D2','D3','D4','D5','D6'];

      function parseLocal(str) {
        const [y,m,d] = str.split('-').map(Number);
        return new Date(y,m-1,d);
      }
      function diffDias(a,b) { return Math.round((a-b)/86400000); }

      // ── Carga média real por dia (PSE × volume) ──────────
      const cargaPorDia = {};
      semana.forEach(dateStr => {
        const registros = historico.filter(d => d.date === dateStr && d?.post?.carga != null);
        if (registros.length === 0) { cargaPorDia[dateStr] = null; return; }
        cargaPorDia[dateStr] = registros.reduce((s,d) => s + d.post.carga, 0) / registros.length;
      });

      // Maior carga da semana para normalização da barra
      const cargas = Object.values(cargaPorDia).filter(v => v != null);
      const maxCarga = cargas.length ? Math.max(...cargas) : 0;

      // ── Classificação descritiva por carga real ───────────
      function classifCarga(carga) {
        if (carga == null) return { texto: 'Sem dados',    cor: '#9ca3af', bg: '#f3f4f6' };
        if (carga >= 800)  return { texto: 'Muito Alta',   cor: '#b91c1c', bg: '#fee2e2' };
        if (carga >= 600)  return { texto: 'Alta',         cor: '#c2410c', bg: '#ffedd5' };
        if (carga >= 300)  return { texto: 'Moderada',     cor: '#15803d', bg: '#dcfce7' };
        return                    { texto: 'Regenerativa', cor: '#1d4ed8', bg: '#dbeafe' };
      }

      // ── Label de contexto do microciclo (secundário) ──────
      const coresMC = {
        D1:'#3b82f6', D2:'#f97316', D3:'#ef4444', D4:'#8b5cf6',
        D5:'#10b981', D6:'#6b7280', D7:'#9ca3af',
        'MD0':'#1d4ed8','MD+1':'#8b5cf6','MD+2':'#7c3aed','MD+3':'#6366f1',
        'MD-3':'#ef4444','MD-2':'#f97316','MD-1':'#10b981',
        'Jogo A':'#1d4ed8','Jogo B':'#1d4ed8',
      };

      const diasComTreino = ctx?.diasComTreino || [];
      const jogoA = ctx?.jogoA ? parseLocal(ctx.jogoA) : null;
      const jogoB = ctx?.jogoB ? parseLocal(ctx.jogoB) : null;

      function getLabelMC(dt) {
        if (periodo === 'Preparação' || periodo === 'Transição') {
          return labelsDias[dt.getDay()];
        }
        if (!jogoA) return '—';
        if (jogoB) {
          const dA = diffDias(dt,jogoA), dB = diffDias(dt,jogoB);
          if (dA===0) return 'Jogo A';
          if (dB===0) return 'Jogo B';
          if (dA===1) return 'MD+1';
          if (dB===-1) return 'MD-1';
          if (dB===-2) return 'MD-2';
          return '—';
        }
        const diff = diffDias(dt,jogoA);
        if (diff <= -4) {
          const dow = dt.getDay();
          if (dow === 1) return 'D1';
          if (dow === 2) return 'D2';
        }
        return ({'0':'MD0','1':'MD+1','2':'MD+2','3':'MD+3','-3':'MD-3','-2':'MD-2','-1':'MD-1'})[String(diff)] || '—';
      }

      const cells = semana.map(dateStr => {
        const dt = parseLocal(dateStr);
        dt.setHours(0,0,0,0);
        const nomeDia = nomesDias[dt.getDay()];
        const dataFmt = dateStr.slice(8)+'/'+dateStr.slice(5,7);
        const carga = cargaPorDia[dateStr];
        const classif = classifCarga(carga);
        const mcLabel = getLabelMC(dt);
        const mcCor = coresMC[mcLabel] || '#9ca3af';

        // Barra de carga relativa
        const pctBarra = (maxCarga > 0 && carga != null) ? Math.round((carga / maxCarga) * 100) : 0;
        const barraHTML = carga != null ? `
          <div style="margin:3px 4px 0;height:3px;background:#e5e7eb;border-radius:2px;">
            <div style="width:${pctBarra}%;height:100%;background:${classif.cor};border-radius:2px;"></div>
          </div>` : '';

        const cargaFmt = carga != null ? Math.round(carga) + ' UA' : '';

        const isHoje = dateStr === new Date().toLocaleDateString('en-CA');
        const border = isHoje ? '2px solid #1e3a5f' : '1px solid #e5e7eb';
        const bgHeader = isHoje ? '#1e3a5f' : '#f8fafc';
        const txtHeader = isHoje ? '#fff' : '#64748b';
        const txtSub = isHoje ? '#93c5fd' : '#94a3b8';

        return `
          <div style="flex:1;border:${border};border-radius:6px;overflow:hidden;min-width:0;">
            <div style="background:${bgHeader};padding:3px 4px;text-align:center;">
              <div style="font-size:8px;font-weight:700;color:${txtHeader};">${nomeDia}</div>
              <div style="font-size:7px;color:${txtSub};">${dataFmt}</div>
            </div>
            <div style="padding:4px 3px 3px;text-align:center;">
              <div style="font-size:11px;font-weight:900;color:${classif.cor};line-height:1.1;">${carga != null ? Math.round(carga) : '—'}</div>
              ${carga != null ? `<div style="font-size:6px;color:#9ca3af;margin-bottom:1px;">UA</div>` : ''}
              <div style="display:inline-block;background:${classif.bg};color:${classif.cor};font-size:6px;font-weight:700;padding:1px 4px;border-radius:8px;line-height:1.4;">${classif.texto}</div>
              ${barraHTML}
              <div style="display:inline-block;background:${mcCor}22;color:${mcCor};font-size:6px;font-weight:700;padding:1px 4px;border-radius:8px;margin-top:3px;line-height:1.4;">${mcLabel}</div>
            </div>
          </div>`;
      });

      return `
        <div style="margin-bottom:16px;">
          <div style="font-size:9px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px;">
            📅 Semana em Números · ${periodo}
          </div>
          <div style="display:flex;gap:4px;">${cells.join('')}</div>
          <div style="margin-top:4px;font-size:8px;color:#94a3b8;">
            Carga média do elenco por dia (PSE × volume) · barra relativa ao dia de maior carga · label = contexto do microciclo planejado
          </div>
        </div>`;
    })()}

    ${rodapeSemanal()}
  </div>`;
}


// ================= PÁGINA 2 — INDICADORES POR POSIÇÃO =================

async function gerarPagina2Semanal(todosAtletas, semana){
  const avg = arr => { const v=arr.filter(x=>x!=null); return v.length?v.reduce((a,b)=>a+b,0)/v.length:null; };
  const semLabel = `${semana[0].split("-").slice(1).reverse().join("/")} – ${semana[6].split("-").slice(1).reverse().join("/")}/${semana[0].split("-")[0]}`;

  // Usar posições reais dos atletas, na ordem preferencial
  const ordemPos = ['Goleiro','Lateral','Zagueiro','Volante','Meia','Ponta','Centro-avante'];
  const posReal = [...new Set(todosAtletas.map(a=>a.posicao).filter(Boolean))];
  const posicoes = [...ordemPos.filter(p=>posReal.includes(p)), ...posReal.filter(p=>!ordemPos.includes(p))];

  // Histórico 4 semanas anteriores por posição para tendência
  const limite28 = new Date(new Date(semana[0]+'T12:00:00').getTime() - 28*86400000).toISOString().slice(0,10);
  function avgHistPos(pos, fn){
    const ats = todosAtletas.filter(a=>a.posicao===pos);
    const vals = historico.filter(d => d.date >= limite28 && d.date < semana[0] && ats.some(a=>a.id===d.athleteId)).map(fn).filter(v=>v!=null);
    return vals.length ? vals.reduce((a,b)=>a+b,0)/vals.length : null;
  }

  function setaTend(valSem, valHist, invertido=false){
    if(valSem==null || valHist==null) return {seta:'', cor:'#94a3b8'};
    const diff = valSem - valHist;
    const thr = Math.abs(valHist)*0.03;
    // invertido=true: maior = pior (ex: carga — subiu = vermelho, desceu = verde)
    const melhorou = invertido ? diff < -thr : diff > thr;
    const piorou   = invertido ? diff > thr  : diff < -thr;
    // invertido=false (indicadores): subiu = ▲ verde, desceu = ▼ vermelho
    // invertido=true  (carga):       subiu = ▲ vermelho, desceu = ▼ verde
    if(melhorou) return {seta: invertido ? '↓' : '↑', cor:'#15803d'};
    if(piorou)   return {seta: invertido ? '↑' : '↓', cor:'#b91c1c'};
    return {seta:'→', cor:'#92400e'};
  }

  const dadosPos = posicoes.map(pos => {
    const ats = todosAtletas.filter(a => a.posicao === pos);
    if(!ats.length) return null;
    const dms = ats.flatMap(a => semana.map(dt => historico.find(d=>d.athleteId===a.id&&d.date===dt)||null)).filter(Boolean);
    if(!dms.length) return null;
    const pront  = avg(dms.map(dm => calcularProntidao(dm).global));
    const carga  = avg(dms.map(dm => dm?.post?.carga ?? null));
    const volume = avg(dms.map(dm => dm?.post?.tempo ?? null));
    const histPront = avgHistPos(pos, dm => calcularProntidao(dm).global);
    const histCarga = avgHistPos(pos, dm => dm?.post?.carga ?? null);

    // Sistema mais afetado na posição: moda entre os atletas com dado hoje
    const ultimoDia = semana.slice().reverse().find(dt => ats.some(a => historico.find(d=>d.athleteId===a.id&&d.date===dt)));
    const sistemasPos = ats.map(a => {
      return ultimoDia ? getSistemaMaisAfetadoSemana(a.id, ultimoDia)?.nome : null;
    }).filter(Boolean);
    const modaSistema = sistemasPos.length
      ? Object.entries(sistemasPos.reduce((acc, s) => { acc[s]=(acc[s]||0)+1; return acc; }, {}))
          .sort((a,b)=>b[1]-a[1])[0][0]
      : null;

    return { pos, n: ats.length, pront, carga, volume, histPront, histCarga, modaSistema };
  }).filter(Boolean);

  function interpretarPosicao(d) {
    if (d.pront == null) return '—';
    const funcao = d.modaSistema ? (SISTEMAS_FUNCAO_MAP[d.modaSistema] || d.modaSistema.toLowerCase()) : null;
    if (d.carga != null && d.carga >= 600)
      return `Alta exigência com destaque para ${funcao || 'o sistema mais demandado'}.`;
    if (d.pront >= 70)
      return 'Prontidão estável ao longo da semana.';
    if (d.pront >= 60)
      return `Monitoramento da semana${funcao ? ` com ênfase em ${funcao}` : ''}.`;
    return `Acompanhamento da resposta semanal${funcao ? ` — atenção em ${funcao}` : ''}.`;
  }

  function linhaPos(d){
    const tp = setaTend(d.pront, d.histPront);
    const tc = setaTend(d.carga, d.histCarga, true);
    const cpP = corProntidaoRel(d.pront);
    const corSistema = { "Subjetivo": "#ea580c", "Autonômico": "#2563eb", "Neuromuscular": "#7c3aed", "Cognitivo": "#0d9488" };
    const bgSistema  = { "Subjetivo": "#fff7ed", "Autonômico": "#eff6ff", "Neuromuscular": "#f5f3ff", "Cognitivo": "#f0fdfa" };
    const sistemaBadge = d.modaSistema
      ? `<span style="background:${bgSistema[d.modaSistema]||'#f1f5f9'};color:${corSistema[d.modaSistema]||'#64748b'};font-size:10px;font-weight:700;padding:3px 8px;border-radius:20px;">${d.modaSistema}</span>`
      : '<span style="color:#94a3b8;font-size:11px;">—</span>';
    return `<tr>
      <td style="padding:10px 14px;font-size:13px;font-weight:700;color:#1e293b;border-bottom:1px solid #e5e7eb;">
        ${d.pos} <span style="font-size:9px;color:#94a3b8;font-weight:400;">(${d.n})</span>
      </td>
      <td style="padding:10px 14px;text-align:center;border-bottom:1px solid #e5e7eb;">
        ${d.pront!=null ? `<span style="display:inline-block;background:${cpP.bg};color:${cpP.text};font-size:14px;font-weight:900;padding:3px 10px;border-radius:6px;">${d.pront.toFixed(1)}</span>${tp.seta ? `<span style="font-size:13px;font-weight:900;color:${tp.cor};margin-left:6px;">${tp.seta}</span>` : ''}` : '<span style="color:#94a3b8;">—</span>'}
      </td>
      <td style="padding:10px 14px;text-align:center;border-bottom:1px solid #e5e7eb;">
        ${d.carga!=null ? `<span style="font-size:14px;font-weight:900;color:#1e293b;">${Math.round(d.carga)}</span>${tc.seta ? `<span style="font-size:13px;font-weight:900;color:${tc.cor};margin-left:6px;">${tc.seta}</span>` : ''}` : '<span style="color:#94a3b8;">—</span>'}
      </td>
      <td style="padding:10px 14px;text-align:center;border-bottom:1px solid #e5e7eb;">
        <span style="font-size:14px;font-weight:700;color:#1e293b;">${d.volume!=null ? Math.round(d.volume)+' min' : '—'}</span>
      </td>
      <td style="padding:10px 14px;text-align:center;border-bottom:1px solid #e5e7eb;">${sistemaBadge}</td>
      <td style="padding:10px 14px;font-size:10px;color:#475569;border-bottom:1px solid #e5e7eb;line-height:1.4;">${interpretarPosicao(d)}</td>
    </tr>`;
  }

  return `
  <div style="font-family:'Segoe UI',Arial,sans-serif;background:#fff;width:800px;padding:28px 30px 12px 30px;box-sizing:border-box;color:#1e293b;">
    ${cabecalhoSemanal('Relatório Semanal · Análise por Posição','INDICADORES POR POSIÇÃO', semLabel)}

    <table style="width:100%;border-collapse:collapse;margin-bottom:16px;">
      <thead>
        <tr style="background:#1e293b;color:#fff;">
          <th style="padding:10px 14px;text-align:left;font-size:11px;font-weight:700;">POSIÇÃO</th>
          <th style="padding:10px 14px;text-align:center;font-size:11px;font-weight:700;">PRONTIDÃO GERAL MÉDIA<br><span style="font-weight:400;opacity:.7;font-size:9px;">0–100 · tendência vs 4 sem.</span></th>
          <th style="padding:10px 14px;text-align:center;font-size:11px;font-weight:700;">CARGA MÉDIA<br><span style="font-weight:400;opacity:.7;font-size:9px;">PSE × Volume (UA)</span></th>
          <th style="padding:10px 14px;text-align:center;font-size:11px;font-weight:700;">VOLUME MÉDIO<br><span style="font-weight:400;opacity:.7;font-size:9px;">Treino / Jogo (min)</span></th>
          <th style="padding:10px 14px;text-align:center;font-size:11px;font-weight:700;">SISTEMA<br>+ AFETADO</th>
          <th style="padding:10px 14px;text-align:left;font-size:11px;font-weight:700;">INTERPRETAÇÃO</th>
        </tr>
      </thead>
      <tbody>
        ${dadosPos.length ? dadosPos.map(linhaPos).join('') : `<tr><td colspan="6" style="padding:20px;text-align:center;color:#94a3b8;font-size:12px;">Nenhum dado disponível para esta semana</td></tr>`}
      </tbody>
    </table>

    <!-- LEGENDAS -->
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:6px;font-size:9px;">
      <span style="font-weight:700;color:#64748b;">Prontidão (geral):</span>
      <span style="background:#dcfce7;color:#15803d;padding:2px 8px;border-radius:4px;font-weight:700;">≥70 Estável</span>
      <span style="background:#fef9c3;color:#a16207;padding:2px 8px;border-radius:4px;font-weight:700;">60–69 At. Leve</span>
      <span style="background:#ffedd5;color:#c2410c;padding:2px 8px;border-radius:4px;font-weight:700;">50–59 Atenção</span>
      <span style="background:#fee2e2;color:#b91c1c;padding:2px 8px;border-radius:4px;font-weight:700;">&lt;50 Crítico</span>
      <span style="color:#64748b;margin-left:4px;">· CMJ: ≥60 / 50–59 / 40–49 / &lt;40</span>
      <span style="color:#94a3b8;margin-left:8px;">▲▼→ tendência em relação às 4 semanas anteriores</span>
    </div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:6px;font-size:9px;">
      <span style="font-weight:700;color:#64748b;">Carga (UA = PSE × tempo):</span>
      <span style="background:#dbeafe;color:#1d4ed8;padding:2px 8px;border-radius:4px;font-weight:700;">&lt;300 Regenerativa</span>
      <span style="background:#dcfce7;color:#15803d;padding:2px 8px;border-radius:4px;font-weight:700;">300–599 Moderada</span>
      <span style="background:#ffedd5;color:#c2410c;padding:2px 8px;border-radius:4px;font-weight:700;">600–799 Alta</span>
      <span style="background:#fee2e2;color:#b91c1c;padding:2px 8px;border-radius:4px;font-weight:700;">≥800 Muito Alta</span>
    </div>
    <div style="font-size:9px;color:#64748b;margin-bottom:20px;line-height:1.6;">
      <span style="font-weight:700;">Sistema + Afetado:</span> domínio biológico com maior comprometimento no último dia da semana com coleta —
      <span style="color:#ea580c;font-weight:700;">Subjetivo</span> (Hooper) ·
      <span style="color:#2563eb;font-weight:700;">Autonômico</span> (VFC) ·
      <span style="color:#7c3aed;font-weight:700;">Neuromuscular</span> (CMJ) ·
      <span style="color:#0d9488;font-weight:700;">Cognitivo</span> (NeuroScore).
      Exibe o sistema mais frequente entre os atletas da posição.
    </div>

    ${gerarDestaquesPosicao(dadosPos)}
    ${rodapeSemanal()}
  </div>`;
}


// ================= PÁGINA 3a — ANÁLISE INDIVIDUAL PARTE 1 =================

function gerarFraseAtleta(r) {
  const partes = [];
  // Linha 1: ISP Tendência
  if (r.ispTend?.global) {
    const t = r.ispTend.global;
    if (t.label === 'Piorando')   partes.push(`ISP ${t.icon} Piorando — indicadores em queda nas últimas 4 semanas.`);
    else if (t.label === 'Estável') partes.push(`ISP ${t.icon} Estável — indicadores mantidos nas últimas 4 semanas.`);
    else                           partes.push(`ISP ${t.icon} Melhorando — indicadores em alta nas últimas 4 semanas.`);
  }
  // Linha 2: leitura da carga (ACWR)
  if (r.acwr != null) {
    if (r.acwr > 1.5)       partes.push(`ACWR ${r.acwr.toFixed(2)} — exposição semanal muito elevada.`);
    else if (r.acwr > 1.3)  partes.push(`ACWR ${r.acwr.toFixed(2)} — exposição semanal elevada.`);
    else if (r.acwr >= 0.8) partes.push(`ACWR ${r.acwr.toFixed(2)} — exposição semanal equilibrada.`);
    else                    partes.push(`ACWR ${r.acwr.toFixed(2)} — exposição semanal reduzida.`);
  }
  // Linha 3: sistema mais afetado
  if (r.maisPrejudicado) {
    const funcao = SISTEMAS_FUNCAO_MAP[r.maisPrejudicado];
    partes.push(`${r.maisPrejudicado}${funcao ? ` — ${funcao}` : ''}.`);
  }
  return partes.join('<br>') || '—';
}

function gerarPagina3Semanal(todosAtletas, semana){
  const avg = arr => { const v=arr.filter(x=>x!=null); return v.length?v.reduce((a,b)=>a+b,0)/v.length:null; };
  const semLabel = `${semana[0].split("-").slice(1).reverse().join("/")} – ${semana[6].split("-").slice(1).reverse().join("/")}/${semana[0].split("-")[0]}`;

  // ── Dados por atleta ──────────────────────────────────────────────────────────
  const ordemPos = ['Goleiro','Lateral','Zagueiro','Volante','Meia','Ponta','Centro-avante'];
  const normPos  = p => (p||'').trim().toLowerCase();
  const posIdx   = p => { const i = ordemPos.findIndex(x => normPos(x) === normPos(p)); return i === -1 ? 99 : i; };

  const rowsDecisao = todosAtletas.map(a => {
    const dms  = semana.map(dt => historico.find(d => d.athleteId === a.id && d.date === dt) || null).filter(Boolean);
    const ultDm = dms.length ? dms[dms.length - 1] : null;
    const calc  = ultDm ? calcularProntidao(ultDm) : {};
    const ispTend = calcularISPTendencia(a.id);
    const acwr  = calcularACWR(a.id);
    const prontMedia = avg(dms.map(dm => calcularProntidao(dm).global));
    const cargaMedia = avg(dms.map(dm => dm?.post?.carga ?? null));
    const dorMedia   = avg(dms.map(dm => dm?.pre?.dor ?? null));
    const custoMed   = avg(dms.map(dm => calcularProntidao(dm, calcularBasalAtleta(a.id)).custoGlobal));
    const sistSemana = getSistemaMaisAfetadoSemana(a.id, semana[semana.length - 1]);
    return {
      id: a.id, nome: a.nome, posicao: a.posicao || '—',
      ispTend,
      global: prontMedia,
      INM: calc.INM ?? null, IC: calc.IC ?? null, IA: calc.IA ?? null, IH: calc.IH ?? null,
      maisPrejudicado: (sistSemana?.ratio < 1 ? sistSemana?.nome : null) ?? calc.maisPrejudicado?.nome ?? null,
      acwr, cargaMedia, dorMedia, custoMed,
    };
  }).sort((a, b) => {
    const ga = classificarPorISPTendencia(a.ispTend, a.global) === 'controle' ? 0 : classificarPorISPTendencia(a.ispTend, a.global) === 'monitorar' ? 1 : 2;
    const gb = classificarPorISPTendencia(b.ispTend, b.global) === 'controle' ? 0 : classificarPorISPTendencia(b.ispTend, b.global) === 'monitorar' ? 1 : 2;
    if (ga !== gb) return ga - gb;
    return (a.ispTend?._score ?? 999) - (b.ispTend?._score ?? 999) || posIdx(a.posicao) - posIdx(b.posicao);
  });

  const grupoControle  = rowsDecisao.filter(r => classificarPorISPTendencia(r.ispTend, r.global) === 'controle');
  const grupoMonitorar = rowsDecisao.filter(r => classificarPorISPTendencia(r.ispTend, r.global) === 'monitorar');
  const grupoApto      = rowsDecisao.filter(r => classificarPorISPTendencia(r.ispTend, r.global) === 'apto');

  // ── Linha de decisão ─────────────────────────────────────────────────────────
  function linhaDecisao(r, corFrase) {
    const t    = r.ispTend?.global;
    const corSistema = { 'Subjetivo':'#ea580c','Autonômico':'#2563eb','Neuromuscular':'#7c3aed','Cognitivo':'#0d9488' };
    const bgSistema  = { 'Subjetivo':'#fff7ed','Autonômico':'#eff6ff','Neuromuscular':'#f5f3ff','Cognitivo':'#f0fdfa' };
    const sistBadge  = r.maisPrejudicado
      ? `<span style="background:${bgSistema[r.maisPrejudicado]||'#f1f5f9'};color:${corSistema[r.maisPrejudicado]||'#64748b'};font-size:9px;font-weight:700;padding:1px 7px;border-radius:20px;">${r.maisPrejudicado}</span>`
      : '';
    return `
      <div style="display:flex;align-items:flex-start;gap:10px;padding:10px 14px;border-bottom:1px solid #f1f5f9;">
        <div style="min-width:130px;padding-top:2px;">
          <div style="font-size:12px;font-weight:800;color:#1e293b;">${r.nome}</div>
          <div style="font-size:9px;color:#94a3b8;margin-top:1px;">${r.posicao}</div>
        </div>
        <div style="flex:1;font-size:10px;color:${corFrase};line-height:1.7;">${gerarFraseAtleta(r)}</div>
        <div style="display:flex;flex-direction:column;gap:4px;align-items:flex-end;flex-shrink:0;padding-top:2px;">
          ${sistBadge ? `<div>${sistBadge}</div>` : ''}
          ${t ? `<span style="background:${t.bg};color:${t.cor};font-size:10px;font-weight:800;padding:2px 10px;border-radius:20px;white-space:nowrap;">ISP ${t.icon} ${t.label}</span>` : ''}
          ${r.acwr != null ? (() => { const la = labelACWR(r.acwr); return `<span style="background:${la.bg};color:${la.cor};font-size:9px;font-weight:700;padding:2px 7px;border-radius:20px;white-space:nowrap;">ACWR ${la.texto}</span>`; })() : ''}
        </div>
      </div>`;
  }

  function grupoHTML(lista, label, bgHeader, corLabel, corFrase, isList) {
    if (!lista.length) return '';
    const corpo = isList
      ? `<div style="padding:10px 14px;font-size:11px;color:#475569;line-height:1.9;">
          ${lista.map(r => `<span style="font-weight:600;color:#1e293b;">${r.nome}</span> <span style="font-size:9px;color:#94a3b8;">(${r.posicao})</span>`).join(' &nbsp;·&nbsp; ')}
         </div>`
      : lista.map(r => linhaDecisao(r, corFrase)).join('');
    return `
      <div style="margin-bottom:14px;">
        <div style="display:flex;align-items:center;gap:8px;padding:7px 14px;background:${bgHeader};border-radius:6px 6px 0 0;">
          <span style="font-size:11px;font-weight:800;color:${corLabel};">${label}</span>
          <span style="font-size:10px;color:${corLabel};opacity:.7;margin-left:auto;">${lista.length} atleta${lista.length !== 1 ? 's' : ''}</span>
        </div>
        <div style="border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;overflow:hidden;">${corpo}</div>
      </div>`;
  }

  const legendaISP = `
    <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;font-size:9px;align-items:center;">
      <span style="font-weight:700;color:#64748b;">ISP Tendência — direção dos indicadores nas últimas 4 semanas:</span>
      <span style="background:#dcfce7;color:#22c55e;padding:1px 7px;border-radius:4px;font-weight:700;">↑ Melhorando</span>
      <span style="background:#fef9c3;color:#f59e0b;padding:1px 7px;border-radius:4px;font-weight:700;">→ Estável</span>
      <span style="background:#fee2e2;color:#ef4444;padding:1px 7px;border-radius:4px;font-weight:700;">↓ Piorando</span>
      <span style="color:#64748b;margin-left:6px;">· Sistema + Afetado: domínio com maior comprometimento no último dia com coleta</span>
      <span style="color:#64748b;">· Custo Biológico: queda em relação ao basal individual (≥20 alto · 10–19 moderado · &lt;10 baixo)</span>
    </div>`;

  // ── Divisão por grupos de treino ─────────────────────────────────────────────
  const ORDEM_GRUPOS = ['Geral', 'G1', 'G2', 'G3', 'G4', 'Transição - RTP', 'Restrição'];
  const COR_GRUPO = {
    'Geral':           { bg: '#eff6ff', cor: '#1d4ed8', border: '#bfdbfe' },
    'G1':              { bg: '#f0fdf4', cor: '#15803d', border: '#bbf7d0' },
    'G2':              { bg: '#fefce8', cor: '#a16207', border: '#fde68a' },
    'G3':              { bg: '#fff7ed', cor: '#c2410c', border: '#fed7aa' },
    'G4':              { bg: '#f0f9ff', cor: '#0369a1', border: '#bae6fd' },
    'Transição - RTP': { bg: '#fff1f2', cor: '#be123c', border: '#fecdd3' },
    'Restrição':       { bg: '#fdf4ff', cor: '#7e22ce', border: '#e9d5ff' },
  };
  const atletasPorGrupo = { 'Geral': [], 'G1': [], 'G2': [], 'G3': [], 'G4': [], 'Transição - RTP': [], 'Restrição': [] };
  todosAtletas.forEach(a => {
    const g = _gruposPront[a.id] || null;
    if (g && atletasPorGrupo[g] !== undefined) {
      atletasPorGrupo[g].push(a);
    }
    // Sem grupo atribuído → não aparece em nenhuma coluna
  });
  function grupoTreinoHTML(grupo) {
    const lista = atletasPorGrupo[grupo] || [];
    const c = COR_GRUPO[grupo] || { bg: '#f8fafc', cor: '#64748b', border: '#e2e8f0' };
    const itens = lista.length
      ? lista.map(a => `<div style="padding:5px 10px;border-bottom:1px solid #f1f5f9;font-size:11px;">
          <div style="font-weight:700;color:#1e293b;line-height:1.3;">${a.nome}</div>
          <div style="font-size:9px;color:#94a3b8;">${a.posicao || '—'}</div>
        </div>`).join('')
      : `<div style="padding:10px;font-size:10px;color:#cbd5e1;text-align:center;">—</div>`;
    return `<div style="border:1px solid ${c.border};border-radius:8px;overflow:hidden;">
      <div style="padding:7px 10px;background:${c.bg};border-bottom:1px solid ${c.border};">
        <span style="font-size:11px;font-weight:800;color:${c.cor};">${grupo}</span>
        <span style="font-size:9px;color:${c.cor};opacity:.7;margin-left:6px;">${lista.length}</span>
      </div>
      ${itens}
    </div>`;
  }

  const paginas = [];

  // Página 3a — Decisão por atleta
  paginas.push(`
  <div style="font-family:'Segoe UI',Arial,sans-serif;background:#fff;width:800px;padding:28px 30px 12px;box-sizing:border-box;color:#1e293b;">
    ${cabecalhoSemanal('Relatório Semanal · Análise Individual','ANÁLISE INDIVIDUAL', semLabel, 'top 5 melhores e atenção por indicador · apenas atletas com dados na semana')}

    <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#64748b;margin-bottom:10px;">Decisão por atleta · ISP Tendência (últimas 4 semanas)</div>
    ${grupoHTML(grupoControle, 'Atenção — tendência piorando', '#fee2e2', '#b91c1c', '#b91c1c', false)}
    ${grupoHTML(grupoApto,     'Melhorando — disponíveis',     '#dcfce7', '#15803d', '#15803d', true)}

    ${legendaISP}

    <div style="margin-top:20px;border-top:2px solid #e2e8f0;padding-top:16px;">
      <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#64748b;margin-bottom:10px;">Divisão por grupos de treino</div>
      <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:8px;">
        ${ORDEM_GRUPOS.map(g => grupoTreinoHTML(g)).join('')}
      </div>
    </div>

    ${rodapeSemanal()}
  </div>`);

  return paginas;
}


// ================= PÁGINA 4 — DEPARTAMENTO MÉDICO =================

function gerarPagina4Semanal(todosAtletas, semana){
  const semLabel = `${semana[0].split('-').slice(1).reverse().join('/')} – ${semana[6].split('-').slice(1).reverse().join('/')}/${semana[0].split('-')[0]}`;

  // ── Dados coletivos ───────────────────────────────────────────────────────────
  const { sistemaMaisAfetado, rowsSemanal } = calcularDadosColetivos(todosAtletas, semana);

  // ── Regiões de dor ────────────────────────────────────────────────────────────
  const totalElenco = todosAtletas.length || 1;
  const todasRegSem = todosAtletas.flatMap(a =>
    semana.flatMap(dt => {
      const dm = historico.find(d => d.athleteId === a.id && d.date === dt);
      return dm?.pre?.regioes_dor ?? [];
    })
  );
  const freqReg = {};
  todasRegSem.forEach(r => { freqReg[r] = (freqReg[r]||0)+1; });
  const regOrdenadas = Object.entries(freqReg).sort((a,b) => b[1]-a[1]);

  // ── Registros médicos da semana ───────────────────────────────────────────────
  const medSemana = assessmentsMedical.filter(m => {
    const d = m.data || m.date || '';
    return d >= semana[0] && d <= semana[6];
  }).sort((a,b) => (a.data||a.date||'').localeCompare(b.data||b.date||''));

  const atletaMap = Object.fromEntries(atletas.map(a => [a.id, a]));

  function isLesao(m){
    const t = (m.tipo||'').toLowerCase().replace(/ã/g,'a').replace(/ç/g,'c');
    const st = (m?.dados?.statusAtual||m?.dados?.status||m?.status||'').toLowerCase();
    return t==='lesao'||t==='lesão'||st.includes('afast')||st.includes('lesion')||st.includes('transi');
  }

  // Lesões ativas na semana atual
  const medLesoesSemana = medSemana.filter(m => {
    if (!isLesao(m)) return false;
    const stRegistro = (
      m?.dados?.statusAtual || m?.dados?.status ||
      m?.dados?.situacao || m?.status || m?.statusAtual || ''
    ).toLowerCase();
    if (stRegistro.includes('liberado')) return false;
    if (statusMedicoAtleta(m.athleteId, semana[6]) === 'liberado') return false;
    return true;
  });

  // Atletas afastados/transição com registro ANTERIOR à semana (ainda ativos esta semana)
  const idsLesoesSemana = new Set(medLesoesSemana.map(m => m.athleteId));
  const medLesoesPrevias = todosAtletas
    .filter(a => !idsLesoesSemana.has(a.id) && ['afastado','transicao'].includes(statusMedicoAtleta(a.id, semana[6])))
    .map(a => assessmentsMedical
      .filter(m => m.athleteId === a.id && isLesao(m))
      .sort((x,y) => (y.data||y.date||'').localeCompare(x.data||x.date||''))[0] || null)
    .filter(Boolean);

  // Lesões ativas = da semana + anteriores ainda não liberadas
  const medLesoes = [...medLesoesSemana, ...medLesoesPrevias];
  const medAtendimentos = medSemana.filter(m => !isLesao(m));

  // ── Atletas em RTP ────────────────────────────────────────────────────────────
  const atletasRTP = todosAtletas.map(a => {
    const medico = assessmentsMedical
      .filter(m => {
        const st = (m?.dados?.statusAtual||m?.dados?.status||m?.status||'').toLowerCase();
        return m.athleteId === a.id && (st.includes('afast')||st.includes('lesion')||m.tipo==='lesao'||m.tipo==='lesão'||st.includes('transi'));
      })
      .sort((x,y) => (y.date||y.data||'').localeCompare(x.date||x.data||''))[0];
    if (!medico) return null;
    const statusMed = statusMedicoAtleta(a.id, semana[6]);
    // RTP só para atletas em transição — afastados e liberados não aparecem
    if (statusMed !== 'transicao') return null;
    const hoje = document.getElementById('filtroData')?.value || new Date().toLocaleDateString('en-CA');
    const dm = historico.find(d => d.athleteId===a.id && d.date===hoje) || null;
    const faseRTP = resolverFaseRTP(statusMed, a.id, dm, hoje);
    const pront = dm ? calcularProntidao(dm) : {};
    const dataInicio = medico.date || medico.data || null;
    return {
      nome: a.nome, posicao: a.posicao||'—',
      tipoLesao: medico?.dados?.tipoLesao||medico?.dados?.tipo||'—',
      diasAfastado: dataInicio ? Math.floor((new Date()-new Date(dataInicio))/86400000) : null,
      faseRTP,
      inFadiga:     pront.inFadiga    != null ? Math.round(pront.inFadiga)    : null,
      inMuscular:   pront.inMuscular  != null ? Math.round(pront.inMuscular)  : null,
      inAutonomico: pront.inAutonomico!= null ? Math.round(pront.inAutonomico): null,
    };
  }).filter(Boolean).sort((a,b) => (a.faseRTP?.fase??0)-(b.faseRTP?.fase??0));

  // ── Cards de regiões ──────────────────────────────────────────────────────────
  const regCards = regOrdenadas.slice(0,12).map(([reg,cnt]) => {
    const pct = Math.round(cnt/totalElenco*100);
    const cor = pct>=40?'#b91c1c':pct>=20?'#d97706':'#64748b';
    const bg  = pct>=40?'#fee2e2':pct>=20?'#ffedd5':'#f1f5f9';
    return `<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:${bg};border-radius:6px;">
      <div style="flex:1;font-size:11px;font-weight:600;color:#1e293b;line-height:1.2;">${reg}</div>
      <span style="font-size:12px;font-weight:900;color:${cor};white-space:nowrap;">${pct}%</span>
    </div>`;
  }).join('');

  // ── Tabelas médicas ───────────────────────────────────────────────────────────
  function tipoLabel(t){
    if(!t) return '<span style="color:#94a3b8;">—</span>';
    const m = {'lesao':'Lesão','lesão':'Lesão','consulta':'Atendimento','fisio':'Fisioterapia','fisioterapia':'Fisioterapia','avaliacao':'Avaliação','retorno':'Retorno','exame':'Exame','atendimento':'Atendimento'};
    const chave = t.toLowerCase().replace(/ã/g,'a').replace(/ç/g,'c');
    const label = m[chave]||t;
    const cor = label==='Lesão'?'#b91c1c':label==='Fisioterapia'?'#7c3aed':label==='Retorno'?'#15803d':'#1d4ed8';
    const bg  = label==='Lesão'?'#fee2e2':label==='Fisioterapia'?'#f5f3ff':label==='Retorno'?'#dcfce7':'#dbeafe';
    return `<span style="background:${bg};color:${cor};font-size:9px;font-weight:700;padding:2px 7px;border-radius:20px;">${label}</span>`;
  }
  function _linhaBase(m){
    const at = atletaMap[m.athleteId];
    const nome = at?.nome||m.athleteId||'—';
    const pos  = at?.posicao||'—';
    const data = (m.data||m.date||'').slice(5).split('-').reverse().join('/');
    const diag = [m?.dados?.diagnostico,m?.dados?.queixa,m?.dados?.descricao,m?.dados?.regiao,m?.diagnostico,m?.queixa,m?.descricao].filter(v=>v&&String(v).trim()!=='')[0]||'—';
    const diagDisplay = diag==='—'?'<span style="color:#94a3b8;font-size:10px;">—</span>':`<span style="font-size:10px;color:#374151;">${diag}</span>`;
    return { nome, pos, data, diagDisplay };
  }
  const thS = 'padding:5px 8px;font-size:9px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid #e5e7eb;';
  function linhaLesao(m){
    const { nome, pos, data, diagDisplay } = _linhaBase(m);
    const tipoLR = [m?.dados?.tipo_lesao,m?.dados?.tipoLesao,m?.dados?.tipo,m?.dados?.lesao,m?.dados?.diagnostico,m?.tipo_lesao,m?.tipoLesao,m?.lesao].filter(v=>v&&String(v).trim()!==''&&!['lesao','lesão','atendimento'].includes(String(v).toLowerCase()))[0]||'';
    const tipoLD = tipoLR?`<span style="font-size:10px;font-weight:600;color:#b91c1c;">${tipoLR}</span>`:'<span style="color:#94a3b8;font-size:10px;">—</span>';
    const st = [m?.dados?.statusAtual,m?.dados?.status,m?.dados?.situacao,m?.dados?.evolucao,m?.status,m?.statusAtual,m?.situacao,m?.evolucao].filter(v=>v&&String(v).trim()!=='')[0]||'';
    const stD = !st?'<span style="color:#94a3b8;font-size:10px;">—</span>':`<span style="font-size:10px;font-weight:600;color:#475569;">${st}</span>`;
    return `<tr style="border-bottom:1px solid #f1f5f9;">
      <td style="padding:5px 8px;font-size:11px;font-weight:700;color:#1e293b;">${nome}</td>
      <td style="padding:5px 6px;font-size:10px;color:#64748b;text-align:center;">${pos}</td>
      <td style="padding:5px 6px;font-size:10px;color:#475569;text-align:center;">${data}</td>
      <td style="padding:5px 6px;text-align:center;">${tipoLabel(m.tipo)}</td>
      <td style="padding:5px 6px;">${tipoLD}</td>
      <td style="padding:5px 6px;">${diagDisplay}</td>
      <td style="padding:5px 6px;">${stD}</td>
    </tr>`;
  }
  function linhaAtend(m){
    const { nome, pos, data, diagDisplay } = _linhaBase(m);
    return `<tr style="border-bottom:1px solid #f1f5f9;">
      <td style="padding:5px 8px;font-size:11px;font-weight:700;color:#1e293b;">${nome}</td>
      <td style="padding:5px 6px;font-size:10px;color:#64748b;text-align:center;">${pos}</td>
      <td style="padding:5px 6px;font-size:10px;color:#475569;text-align:center;">${data}</td>
      <td style="padding:5px 6px;text-align:center;">${tipoLabel(m.tipo)}</td>
      <td style="padding:5px 6px;">${diagDisplay}</td>
    </tr>`;
  }
  function tabelaSecao(titulo, lista, corBorda, ehLesao){
    if(!lista.length) return '';
    const thLesao  = `<thead><tr style="background:#f8fafc;"><th style="${thS}text-align:left;padding-left:8px;">Atleta</th><th style="${thS}text-align:center;">Pos.</th><th style="${thS}text-align:center;">Data</th><th style="${thS}text-align:center;">Tipo</th><th style="${thS}text-align:left;">Tipo de Lesão</th><th style="${thS}text-align:left;">Diagnóstico / Queixa</th><th style="${thS}text-align:left;">Status</th></tr></thead>`;
    const thAtend  = `<thead><tr style="background:#f8fafc;"><th style="${thS}text-align:left;padding-left:8px;">Atleta</th><th style="${thS}text-align:center;">Pos.</th><th style="${thS}text-align:center;">Data</th><th style="${thS}text-align:center;">Tipo</th><th style="${thS}text-align:left;">Diagnóstico / Queixa</th></tr></thead>`;
    return `<div style="border:1.5px solid ${corBorda};border-radius:8px;overflow:hidden;margin-bottom:10px;">
      <div style="background:#1e293b;padding:6px 12px;display:flex;justify-content:space-between;align-items:center;">
        <div style="color:#fff;font-size:11px;font-weight:800;">${titulo}</div>
        <div style="color:#94a3b8;font-size:10px;">${lista.length} registro${lista.length!==1?'s':''}</div>
      </div>
      <table style="width:100%;border-collapse:collapse;">
        ${ehLesao?thLesao:thAtend}
        <tbody>${ehLesao?lista.map(linhaLesao).join(''):lista.map(linhaAtend).join('')}</tbody>
      </table>
    </div>`;
  }

  const tabelaMedicaHTML = (medLesoes.length || medAtendimentos.length)
    ? tabelaSecao('Lesões', medLesoes, '#fca5a5', true) + tabelaSecao('Atendimentos de Rotina', medAtendimentos, '#e2e8f0', false)
    : `<div style="padding:16px;text-align:center;color:#94a3b8;font-size:12px;border:1.5px solid #e2e8f0;border-radius:8px;">Nenhum atendimento registrado nesta semana.</div>`;

  return [`
  <div style="font-family:'Segoe UI',Arial,sans-serif;background:#fff;width:800px;padding:28px 30px 12px;box-sizing:border-box;color:#1e293b;">
    ${cabecalhoSemanal('Relatório Semanal · Departamento Médico','DEPARTAMENTO MÉDICO', semLabel, 'queixas · lesões · return to play')}

    ${gerarLeituraMedica(todasRegSem, sistemaMaisAfetado, rowsSemanal)}

    <!-- Cards de resumo -->
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:16px;">
      <div style="background:#fee2e2;border:1px solid #fca5a5;border-radius:8px;padding:12px 14px;text-align:center;">
        <div style="font-size:28px;font-weight:900;color:#b91c1c;line-height:1;">${medLesoes.length}</div>
        <div style="font-size:10px;font-weight:700;color:#b91c1c;margin-top:3px;">Lesões Ativas</div>
      </div>
      <div style="background:#dbeafe;border:1px solid #93c5fd;border-radius:8px;padding:12px 14px;text-align:center;">
        <div style="font-size:28px;font-weight:900;color:#1d4ed8;line-height:1;">${medAtendimentos.length}</div>
        <div style="font-size:10px;font-weight:700;color:#1d4ed8;margin-top:3px;">Atendimentos</div>
      </div>
      <div style="background:#f5f3ff;border:1px solid #c4b5fd;border-radius:8px;padding:12px 14px;text-align:center;">
        <div style="font-size:28px;font-weight:900;color:#7c3aed;line-height:1;">${atletasRTP.length}</div>
        <div style="font-size:10px;font-weight:700;color:#7c3aed;margin-top:3px;">Em RTP</div>
      </div>
    </div>

    <!-- Regiões de dor -->
    ${regOrdenadas.length ? `
    <div style="margin-bottom:16px;">
      <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#64748b;margin-bottom:8px;">Regiões relatadas · frequência no elenco</div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;">
        ${regCards}
      </div>
      <div style="margin-top:5px;font-size:9px;color:#94a3b8;">
        Total: ${todasRegSem.length} registros · ${[...new Set(todasRegSem)].length} regiões distintas ·
        <span style="color:#b91c1c;font-weight:700;">≥40% alto</span> ·
        <span style="color:#d97706;font-weight:700;">20–39% moderado</span> ·
        <span style="color:#64748b;">abaixo de 20%</span>
      </div>
    </div>` : ''}

    <!-- Tabelas médicas -->
    ${tabelaMedicaHTML}

    <!-- Return to Play -->
    ${atletasRTP.length ? `
    <div style="margin-top:14px;">
      <div style="font-size:11px;font-weight:800;color:#1e293b;margin-bottom:8px;padding-bottom:4px;border-bottom:2px solid #e2e8f0;letter-spacing:.05em;">
        RETURN TO PLAY · ${atletasRTP.length} atleta${atletasRTP.length!==1?'s':''}
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:10px;">
        <thead>
          <tr style="background:#f8fafc;color:#64748b;font-size:9px;font-weight:700;">
            <th style="padding:5px 8px;text-align:left;">ATLETA</th>
            <th style="padding:5px 6px;text-align:center;">POS.</th>
            <th style="padding:5px 6px;text-align:center;">LESÃO</th>
            <th style="padding:5px 6px;text-align:center;">DIAS</th>
            <th style="padding:5px 6px;text-align:center;">FASE RTP</th>
            <th style="padding:5px 6px;text-align:center;">SUBJETIVO</th>
            <th style="padding:5px 6px;text-align:center;">NEUROMUSCULAR</th>
            <th style="padding:5px 6px;text-align:left;">PRÓXIMO CRITÉRIO</th>
          </tr>
        </thead>
        <tbody>
          ${atletasRTP.map((a,i) => `
            <tr style="border-bottom:1px solid #f1f5f9;background:${i%2===0?'#fff':'#fafafa'};">
              <td style="padding:5px 8px;font-weight:600;color:#1e293b;">${a.nome}</td>
              <td style="padding:5px 6px;text-align:center;color:#64748b;">${a.posicao}</td>
              <td style="padding:5px 6px;text-align:center;color:#64748b;">${a.tipoLesao}</td>
              <td style="padding:5px 6px;text-align:center;font-weight:700;color:#64748b;">${a.diasAfastado!=null?a.diasAfastado+'d':'—'}</td>
              <td style="padding:5px 6px;text-align:center;">
                ${a.faseRTP?`<span style="display:inline-block;padding:2px 6px;border-radius:999px;font-size:9px;font-weight:800;background:${a.faseRTP.bg};color:${a.faseRTP.cor};">F${a.faseRTP.fase} · ${a.faseRTP.label}</span>`:'—'}
              </td>
              <td style="padding:5px 6px;text-align:center;">${a.inFadiga!=null?`<span style="color:${a.inFadiga>=60?'#15803d':a.inFadiga>=50?'#b45309':'#b91c1c'};font-weight:700;">${a.inFadiga}</span>`:'<span style="color:#cbd5e1;">—</span>'}</td>
              <td style="padding:5px 6px;text-align:center;">${a.inMuscular!=null?`<span style="color:${a.inMuscular>=60?'#15803d':a.inMuscular>=50?'#b45309':'#b91c1c'};font-weight:700;">${a.inMuscular}</span>`:'<span style="color:#cbd5e1;">—</span>'}</td>
              <td style="padding:5px 6px;color:#94a3b8;font-size:9px;">${a.faseRTP?.fase===4?'✓ Liberado para jogo':(a.faseRTP?.descricao||'—')}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>` : ''}

    ${rodapeSemanal()}
  </div>`];
}

// ================= PÁGINA 5 — GRÁFICOS CARGA & PRONTIDÃO =================
async function gerarPagina5Semanal(todosAtletas, semana) {
  const avg = arr => { const v = arr.filter(x => x != null); return v.length ? v.reduce((a,b)=>a+b,0)/v.length : null; };
  const semLabel = `${semana[0].split("-").slice(1).reverse().join("/")} – ${semana[6].split("-").slice(1).reverse().join("/")}/${semana[0].split("-")[0]}`;

  const diasLabels = semana.map(d => {
    const dt = new Date(d + 'T12:00:00');
    const dia = dt.toLocaleDateString('pt-BR', { weekday: 'short' });
    return `${dia.charAt(0).toUpperCase() + dia.slice(1,-1)} ${dt.getDate().toString().padStart(2,'0')}`;
  });
  const prontDiarios = semana.map(dt => {
    const vals = todosAtletas.map(a => {
      const dm = historico.find(d => d.athleteId === a.id && d.date === dt);
      return dm ? calcularProntidao(dm).global : null;
    }).filter(v => v != null);
    return vals.length ? avg(vals) : null;
  });
  const cargaDiaria = semana.map(dt => {
    const vals = todosAtletas.map(a =>
      historico.find(d => d.athleteId === a.id && d.date === dt)?.post?.carga ?? null
    ).filter(v => v != null);
    return vals.length ? avg(vals) : null;
  });

  const inicioAtual = new Date(semana[0] + 'T12:00:00');
  const datasHistorico = historico.map(d => d.date).filter(Boolean).sort();
  const dataMaisAntiga = datasHistorico.length ? datasHistorico[0] : semana[0];
  const dtAntiga = new Date(dataMaisAntiga + 'T12:00:00');
  const diffSegP5 = dtAntiga.getDay() === 0 ? -6 : 1 - dtAntiga.getDay();
  const primeiraSegundaP5 = new Date(dtAntiga);
  primeiraSegundaP5.setDate(primeiraSegundaP5.getDate() + diffSegP5);
  const semanasHistP5 = [];
  for (let ini = new Date(primeiraSegundaP5); ini <= inicioAtual; ini.setDate(ini.getDate() + 7)) {
    const iniCopy = new Date(ini);
    const dias = Array.from({length:7}, (_,k) => {
      const d = new Date(iniCopy); d.setDate(d.getDate() + k);
      return d.toISOString().slice(0,10);
    });
    const isSemAtual = dias[0] === semana[0];
    semanasHistP5.push({ dias, label: `${iniCopy.getDate().toString().padStart(2,'0')}/${(iniCopy.getMonth()+1).toString().padStart(2,'0')}${isSemAtual ? ' ★' : ''}`, isSemAtual });
  }
  const labelsSemanais = semanasHistP5.map(s => s.label);
  const prontSemanais  = semanasHistP5.map(s => avg(
    todosAtletas.flatMap(a => s.dias.map(dt => {
      const dm = historico.find(d => d.athleteId === a.id && d.date === dt);
      return dm ? calcularProntidao(dm).global : null;
    }))
  ));
  const cargaSemanais = semanasHistP5.map(s => avg(
    todosAtletas.flatMap(a => s.dias.map(dt =>
      historico.find(d => d.athleteId === a.id && d.date === dt)?.post?.carga ?? null
    ))
  ));

  const ordemPos = ['Goleiro','Lateral','Zagueiro','Volante','Meia','Ponta','Centro-avante'];
  const posReal  = [...new Set(todosAtletas.map(a => a.posicao).filter(Boolean))];
  const posicoes = [...ordemPos.filter(p => posReal.includes(p)), ...posReal.filter(p => !ordemPos.includes(p))];
  const prontPos = posicoes.map(pos => {
    const ats = todosAtletas.filter(a => a.posicao === pos);
    return avg(ats.flatMap(a => semana.map(dt => {
      const dm = historico.find(d => d.athleteId === a.id && d.date === dt);
      return dm ? calcularProntidao(dm).global : null;
    })));
  });
  const cargaPos = posicoes.map(pos => {
    const ats = todosAtletas.filter(a => a.posicao === pos);
    return avg(ats.flatMap(a => semana.map(dt =>
      historico.find(d => d.athleteId === a.id && d.date === dt)?.post?.carga ?? null
    )));
  });

  function mkCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    document.body.appendChild(c);
    return c;
  }
  function toImg(chart, canvas) {
    return new Promise(resolve => setTimeout(() => {
      const url = canvas.toDataURL('image/png');
      chart.destroy(); canvas.remove(); resolve(url);
    }, 500));
  }
  const corBarra = v => v == null ? '#e2e8f0' : v >= 70 ? '#22c55e' : v >= 60 ? '#eab308' : v >= 50 ? '#f97316' : '#ef4444';
  const corCarga = v => v == null ? '#e2e8f0' : v >= 800 ? '#ef4444' : v >= 600 ? '#f97316' : v >= 300 ? '#22c55e' : '#3b82f6';
  const baseOpts = { animation: false, responsive: false, plugins: { legend: { display: false } } };

  const c1 = mkCanvas(720, 160);
  const g1 = new Chart(c1, {
    type: 'bar',
    data: { labels: diasLabels, datasets: [
      { type:'bar',  data: cargaDiaria,  backgroundColor:'rgba(245,158,11,0.45)', borderColor:'#f59e0b', borderWidth:1.5, borderRadius:4, yAxisID:'y1', order:2, label:'Carga (UA)' },
      { type:'line', data: prontDiarios, borderColor:'#3b82f6', backgroundColor:'rgba(59,130,246,0.07)', fill:true, tension:0.35, pointRadius:5, borderWidth:2.5, yAxisID:'y', order:1, label:'Prontidão' },
      { type:'line', data: diasLabels.map(()=>CARGA_JOGO_REF), borderColor:'rgba(234,179,8,0.9)', backgroundColor:'transparent', borderWidth:1.5, borderDash:[6,4], pointRadius:0, yAxisID:'y1', order:3, label:`Ref. Jogo (${CARGA_JOGO_REF} u.a.)` }
    ]},
    options: { ...baseOpts, plugins: { legend:{ display:true, position:'right', labels:{ font:{size:9}, boxWidth:10 } } },
      scales: {
        x:  { grid:{ display:false }, ticks:{ font:{size:9} } },
        y:  { position:'left',  min:0, max:100, grid:{ color:'#f1f5f9' }, ticks:{ font:{size:9} }, title:{ display:true, text:'Prontidão', font:{size:9}, color:'#3b82f6' } },
        y1: { position:'right', beginAtZero:true, grid:{ drawOnChartArea:false }, ticks:{ font:{size:9} }, title:{ display:true, text:'Carga (UA)', font:{size:9}, color:'#f59e0b' } }
      }
    }
  });
  const img1 = await toImg(g1, c1);

  const c2 = mkCanvas(720, 160);
  const g2 = new Chart(c2, {
    type: 'bar',
    data: { labels: labelsSemanais, datasets: [
      { type:'bar',  data: cargaSemanais, backgroundColor: semanasHistP5.map(s => s.isSemAtual ? 'rgba(99,102,241,0.55)' : 'rgba(245,158,11,0.45)'), borderColor: semanasHistP5.map(s => s.isSemAtual ? '#6366f1' : '#f59e0b'), borderWidth:1.5, borderRadius:4, yAxisID:'y1', order:2, label:'Carga (UA)' },
      { type:'line', data: prontSemanais, borderColor:'#3b82f6', backgroundColor:'rgba(59,130,246,0.07)', fill:true, tension:0.35, pointRadius: semanasHistP5.map(s => s.isSemAtual ? 7 : 4), pointBackgroundColor: semanasHistP5.map(s => s.isSemAtual ? '#6366f1' : '#3b82f6'), borderWidth:2.5, yAxisID:'y', order:1, label:'Prontidão' },
      { type:'line', data: labelsSemanais.map(()=>CARGA_JOGO_REF), borderColor:'rgba(234,179,8,0.9)', backgroundColor:'transparent', borderWidth:1.5, borderDash:[6,4], pointRadius:0, yAxisID:'y1', order:3, label:`Ref. Jogo (${CARGA_JOGO_REF} u.a.)` }
    ]},
    options: { ...baseOpts, plugins: { legend:{ display:true, position:'right', labels:{ font:{size:9}, boxWidth:10 } } },
      scales: {
        x:  { grid:{ display:false }, ticks:{ font:{size:9} } },
        y:  { position:'left',  min:0, max:100, grid:{ color:'#f1f5f9' }, ticks:{ font:{size:9} }, title:{ display:true, text:'Prontidão', font:{size:9}, color:'#3b82f6' } },
        y1: { position:'right', beginAtZero:true, grid:{ drawOnChartArea:false }, ticks:{ font:{size:9} }, title:{ display:true, text:'Carga (UA)', font:{size:9}, color:'#f59e0b' } }
      }
    }
  });
  const img2 = await toImg(g2, c2);

  const c3 = mkCanvas(340, 230);
  const g3 = new Chart(c3, {
    type: 'bar',
    data: { labels: posicoes, datasets: [{ data: prontPos, backgroundColor: prontPos.map(corBarra), borderRadius:4, borderSkipped:false }] },
    options: { ...baseOpts, indexAxis:'y',
      plugins: { legend:{ display:false }, title:{ display:true, text:'Prontidão por posição (0–100)', font:{size:10,weight:'700'}, color:'#1e293b', padding:{ bottom:8 } } },
      scales: { x:{ min:0, max:100, grid:{ color:'#f1f5f9' }, ticks:{ font:{size:9} } }, y:{ grid:{ display:false }, ticks:{ font:{size:9}, color:'#1e293b' } } }
    }
  });
  const img3 = await toImg(g3, c3);

  const c4 = mkCanvas(340, 230);
  const g4 = new Chart(c4, {
    type: 'bar',
    data: { labels: posicoes, datasets: [{ data: cargaPos, backgroundColor: cargaPos.map(corCarga), borderRadius:4, borderSkipped:false }] },
    options: { ...baseOpts, indexAxis:'y',
      plugins: { legend:{ display:false }, title:{ display:true, text:'Carga por posição (UA)', font:{size:10,weight:'700'}, color:'#1e293b', padding:{ bottom:8 } } },
      scales: { x:{ min:0, beginAtZero:true, grid:{ color:'#f1f5f9' }, ticks:{ font:{size:9} } }, y:{ grid:{ display:false }, ticks:{ font:{size:9}, color:'#1e293b' } } }
    }
  });
  const img4 = await toImg(g4, c4);

  return `
  <div style="font-family:'Segoe UI',Arial,sans-serif;background:#fff;width:800px;padding:28px 30px 12px;box-sizing:border-box;color:#1e293b;">
    ${cabecalhoSemanal('Relatório Semanal · Análise Gráfica', 'CARGA & PRONTIDÃO', semLabel)}

    <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:#64748b;margin-bottom:6px;">Prontidão média × Carga média por dia — semana atual</div>
    <div style="border:1.5px solid #e2e8f0;border-radius:8px;padding:12px;margin-bottom:18px;">
      <img src="${img1}" style="width:100%;height:auto;display:block;" />
    </div>

    <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:#64748b;margin-bottom:6px;">
      Prontidão média × Carga média por semana — histórico
      <span style="font-size:8px;font-weight:400;color:#94a3b8;text-transform:none;letter-spacing:0;margin-left:8px;">★ semana atual · barra roxa = semana atual</span>
    </div>
    <div style="border:1.5px solid #e2e8f0;border-radius:8px;padding:12px;margin-bottom:18px;">
      <img src="${img2}" style="width:100%;height:auto;display:block;" />
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:4px;">
      <div style="border:1.5px solid #e2e8f0;border-radius:8px;padding:12px;">
        <img src="${img3}" style="width:100%;height:auto;display:block;" />
      </div>
      <div style="border:1.5px solid #e2e8f0;border-radius:8px;padding:12px;">
        <img src="${img4}" style="width:100%;height:auto;display:block;" />
      </div>
    </div>

    <div style="margin-top:8px;display:flex;gap:10px;flex-wrap:wrap;font-size:9px;align-items:center;">
      <span style="font-weight:700;color:#64748b;">Prontidão:</span>
      <span style="background:#dcfce7;color:#15803d;padding:1px 7px;border-radius:4px;font-weight:700;">≥70 Estável</span>
      <span style="background:#fef9c3;color:#a16207;padding:1px 7px;border-radius:4px;font-weight:700;">60–69 At. Leve</span>
      <span style="background:#ffedd5;color:#c2410c;padding:1px 7px;border-radius:4px;font-weight:700;">50–59 Atenção</span>
      <span style="background:#fee2e2;color:#b91c1c;padding:1px 7px;border-radius:4px;font-weight:700;">&lt;50 Crítico</span>
      <span style="font-weight:700;color:#64748b;margin-left:8px;">Carga:</span>
      <span style="background:#dbeafe;color:#1d4ed8;padding:1px 7px;border-radius:4px;font-weight:700;">&lt;300 Regen.</span>
      <span style="background:#dcfce7;color:#15803d;padding:1px 7px;border-radius:4px;font-weight:700;">300–599 Mod.</span>
      <span style="background:#ffedd5;color:#c2410c;padding:1px 7px;border-radius:4px;font-weight:700;">600–799 Alta</span>
      <span style="background:#fee2e2;color:#b91c1c;padding:1px 7px;border-radius:4px;font-weight:700;">≥800 Muito Alta</span>
      <span style="font-weight:700;color:#64748b;margin-left:8px;">— — —</span>
      <span style="color:#ca8a04;font-weight:700;">Ref. Jogo (${CARGA_JOGO_REF} u.a.)</span>
    </div>

    ${rodapeSemanal()}
  </div>`;
}

function _getCategoriaSemanal() {
  return (document.getElementById("filtroCategoriaSemanal")?.value
       || document.getElementById("filtroCategoria")?.value
       || "");
}

function _atletasFiltradosSemanal() {
  const cat = _getCategoriaSemanal();
  return cat ? atletas.filter(a => a.categoria === cat) : atletas;
}

async function exportarRelatorioSemanalPDF(pdf_only = false){
  const hoje = document.getElementById("filtroData")?.value || new Date().toLocaleDateString('en-CA');
  const dataSel = new Date(hoje + "T12:00:00");
  const dow = dataSel.getDay();
  const diffSeg = dow === 0 ? -6 : 1 - dow;
  const segunda = new Date(dataSel);
  segunda.setDate(segunda.getDate() + diffSeg);
  const semana = Array.from({length:7}, (_,i)=>{
    const d = new Date(segunda); d.setDate(d.getDate()+i);
    return d.toISOString().slice(0,10);
  });

  const atletasSel = _atletasFiltradosSemanal();

  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ orientation:"portrait", unit:"mm", format:"a4" });

  await htmlParaPDF(pdf, await gerarPagina1Semanal(atletasSel, semana), "portrait", true);
  await htmlParaPDF(pdf, await gerarPagina2Semanal(atletasSel, semana), "portrait", false);
  const pags3 = gerarPagina3Semanal(atletasSel, semana);
  for(const p of (Array.isArray(pags3) ? pags3 : [pags3]).filter(Boolean)){
    await htmlParaPDF(pdf, p, "portrait", false);
  }
  const pags4 = gerarPagina4Semanal(atletasSel, semana);
  for(const p of (Array.isArray(pags4) ? pags4 : [pags4]).filter(Boolean)){
    await htmlParaPDF(pdf, p, "portrait", false);
  }
  await htmlParaPDF(pdf, await gerarPagina5Semanal(atletasSel, semana), "portrait", false);

  pdf.save(`Relatorio_Semanal_${semana[0]}_${semana[6]}.pdf`);
  if (new URLSearchParams(window.location.search).get('from') === 'relatorios') setTimeout(() => { window.location.href = '/staff/relatorios.html'; }, 800);
}

async function abrirModalRelatorioSemanal(){
  const hoje = document.getElementById("filtroData")?.value || new Date().toLocaleDateString('en-CA');
  const dataSel = new Date(hoje + "T12:00:00");
  const dow = dataSel.getDay();
  const diffSeg = dow === 0 ? -6 : 1 - dow;
  const segunda = new Date(dataSel);
  segunda.setDate(segunda.getDate() + diffSeg);
  const semana = Array.from({length:7}, (_,i)=>{
    const d = new Date(segunda); d.setDate(d.getDate()+i);
    return d.toISOString().slice(0,10);
  });
  const semLabel = `${semana[0].split("-").slice(1).reverse().join("/")} – ${semana[6].split("-").slice(1).reverse().join("/")}/${semana[0].split("-")[0]}`;

  document.getElementById("modalRelatorioSemanal")?.remove();

  const atletasSel = _atletasFiltradosSemanal();

  const pag1Html  = await gerarPagina1Semanal(atletasSel, semana);
  const pag2Html  = await gerarPagina2Semanal(atletasSel, semana);
  const pags3     = gerarPagina3Semanal(atletasSel, semana);
  const pags3Arr  = (Array.isArray(pags3) ? pags3 : [pags3]).filter(Boolean);
  const pags4     = gerarPagina4Semanal(atletasSel, semana);
  const pags4Arr  = (Array.isArray(pags4) ? pags4 : [pags4]).filter(Boolean);
  const pag5Html  = await gerarPagina5Semanal(atletasSel, semana);

  const todasPags = [pag1Html, pag2Html, ...pags3Arr, ...pags4Arr, pag5Html];
  const totalPags = todasPags.length;

  // Envolve cada página num container de preview com sombra e numeração
  const paginasHTML = todasPags.map((html, idx) => `
    <div style="margin-bottom:24px;">
      <div style="font-size:10px;font-weight:700;color:#64748b;letter-spacing:.08em;text-transform:uppercase;margin-bottom:6px;display:flex;align-items:center;gap:8px;">
        <span>Página ${idx+1} de ${totalPags}</span>
        <span style="flex:1;height:1px;background:#e2e8f0;"></span>
      </div>
      <div style="box-shadow:0 2px 12px rgba(0,0,0,.12);border-radius:4px;overflow:hidden;background:#fff;">
        ${html}
      </div>
    </div>
  `).join("");

  const modalHTML = `
    <div id="modalRelatorioSemanal" style="position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;overflow-y:auto;padding:24px 16px;">
      <div style="background:#f8fafc;border-radius:12px;max-width:900px;margin:0 auto;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.3);">

        <!-- Header -->
        <div style="background:#1e293b;color:#fff;padding:18px 24px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:10;">
          <div>
            <div style="display:flex;align-items:center;gap:10px;">
              ${CLUB_LOGO ? `<img src="${CLUB_LOGO}" style="width:36px;height:36px;object-fit:contain;flex-shrink:0;">` : ''}
              <div style="font-size:17px;font-weight:900;">${CLUB_NAME||'Clube'} · Relatório Semanal</div>
            </div>
            <div style="font-size:11px;opacity:.7;margin-top:2px;">${semLabel} · ${totalPags} página${totalPags!==1?'s':''}</div>
          </div>
          <div style="display:flex;gap:10px;align-items:center;">
            <button id="btnExportSemanalModal"
              style="background:#6366f1;color:#fff;border:none;padding:8px 18px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;">
              ⬇ Exportar PDF
            </button>
            <button onclick="document.getElementById('modalRelatorioSemanal').remove()"
              style="background:rgba(255,255,255,.15);color:#fff;border:none;width:32px;height:32px;border-radius:8px;font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;">✕</button>
          </div>
        </div>

        <!-- Corpo com preview -->
        <div style="padding:24px;overflow-x:auto;">
          ${paginasHTML}
        </div>

      </div>
    </div>`;

  document.body.insertAdjacentHTML("beforeend", modalHTML);

  // Fecha ao clicar fora
  document.getElementById("modalRelatorioSemanal").addEventListener("click", function(e){
    if(e.target === this) this.remove();
  });

  // Botão exportar dentro do modal
  document.getElementById("btnExportSemanalModal").addEventListener("click", async function(){
    this.disabled = true; this.textContent = "Gerando...";
    try {
      await exportarRelatorioSemanalPDF();
    } catch(err){ console.error(err); alert("Erro ao gerar PDF."); }
    finally { this.disabled=false; this.textContent="⬇ Exportar PDF"; }
  });
}

async function exportarRelatorioSemanal(){
  const btn = document.getElementById("btnRelatorioSemanal");
  btn.disabled = true; btn.textContent = "Gerando...";
  try {
    await exportarRelatorioSemanalPDF();
  } catch(err){ console.error(err); alert("Erro ao gerar PDF. Verifique o console."); }
  finally { btn.disabled=false; btn.textContent="Relatório Semanal"; }
}


document.getElementById("btnExportarPDF")?.addEventListener("click", abrirModalConfirmacaoPDF);
document.getElementById("btnRelatorioSemanal")?.addEventListener("click", abrirModalRelatorioSemanal);

// ================= RELATÓRIO DIÁRIO — MINUTOS =================

function zScoreGlobal(athleteId) {
  const hoje = document.getElementById("filtroData")?.value || new Date().toLocaleDateString('en-CA');
  const hist = historico
    .filter(d => d.athleteId === athleteId && d.date < hoje)
    .sort((a,b) => new Date(a.date) - new Date(b.date))
    .slice(-7);
  if (hist.length < 3) return null;
  const vals = hist.map(d => calcularProntidao(d).global).filter(v => v != null);
  if (vals.length < 3) return null;
  const m  = vals.reduce((a,b) => a+b,0) / vals.length;
  const sd = Math.sqrt(vals.reduce((s,x) => s+(x-m)**2,0) / vals.length);
  if (sd === 0) return null;
  const dm = daily.find(d => d.athleteId === athleteId)
          ?? historico.find(d => d.athleteId === athleteId && d.date === hoje);
  if (!dm) return null;
  const global = calcularProntidao(dm).global;
  if (global == null) return null;
  return parseFloat(((global - m) / sd).toFixed(2));
}

function statusMedicoAtleta(athleteId, dataLimite) {
  const hoje = dataLimite || document.getElementById("filtroData")?.value || new Date().toLocaleDateString('en-CA');

  // Pega todos os registros até hoje, ordenados do mais recente ao mais antigo
  const todos = assessmentsMedical
    .filter(m => {
      const d = m.data || m.date || "";
      return m.athleteId === athleteId && d <= hoje;
    })
    .sort((a,b) => (b.data||b.date||"").localeCompare(a.data||a.date||""));

  if (!todos.length) return "liberado";

  // Percorre do mais recente: o primeiro registro com status de afastamento/transição/alta define
  for (const m of todos) {
    const st = (m?.dados?.statusAtual || m?.dados?.status || m?.status || "").toLowerCase();
    const ehLesao = m.tipo === "lesao" || m.tipo === "lesão";

    // Alta/liberado explícito → para aqui, atleta está liberado
    if (st.includes("alta") || st.includes("liberado") || st.includes("apto")) return "liberado";
    // Afastado: só por status explícito (não pelo tipo do registro)
    if (st.includes("afast") || st.includes("lesion")) return "afastado";
    // Transição
    if (st.includes("transi")) return "transicao";
    // Registro sem status relevante (ex: lesao sem status preenchido) → continua buscando
  }

  return "liberado";
}

function calcularMinutosRecomendados(athleteId) {
  const hoje = document.getElementById("filtroData")?.value || new Date().toLocaleDateString('en-CA');
  const dmRaw = daily.find(d => d.athleteId === athleteId)
             ?? historico.find(d => d.athleteId === athleteId && d.date === hoje);
  const calc      = calcularProntidao(dmRaw, calcularBasalAtleta(athleteId));
  const ispTend   = calcularISPTendencia(athleteId);
  const global    = calc.global;
  const statusMed = statusMedicoAtleta(athleteId);
  const faseRTP   = resolverFaseRTP(statusMed, athleteId, dmRaw, hoje);

  if (global == null) {
    return { minutos: null, faixa: "—", classificacao: "Sem dados", obs: "Sem dados de prontidao", cor: "#9ca3af" };
  }
  if (statusMed === "afastado") {
    return { minutos: 0, faixa: "0 min", classificacao: "Protecao", obs: "Afastado — nao expor", cor: "#b91c1c" };
  }

  let teto = 90;
  if (statusMed === "transicao") {
    teto = global != null ? (global >= 70 ? 60 : global >= 60 ? 55 : global >= 50 ? 50 : 45) : 45;
  }

  const { INM, IA, IH, IC } = calc;
  const zG = zScoreGlobal(athleteId);

  // ── Classificação em 3 níveis reais ─────────────────────────────────────
  // PRINCÍPIO: sistema serve para orientar uso, não para tirar jogador
  // Restrição só quando há risco real — atenção é informação, não limitação

  // Crítico: valor < 40 em qualquer sistema
  const cmjCritico  = INM != null && INM < 40;
  const hrvCritico  = IA  != null && IA  < 40;
  const fadCritico  = IH  != null && IH  < 40;
  const cogCritico  = IC  != null && IC  < 40;
  const algumCritico = cmjCritico || hrvCritico || fadCritico || cogCritico;

  // ISP Tendência piorando: contexto semanal em queda
  const ispPiorando = ispTend?.global?.label === 'Piorando';

  // Combinação restritiva: CMJ crítico + ISP Tendência piorando
  const combinacaoRestritiva = cmjCritico && ispPiorando;

  // IGP (prontidão do dia)
  const estadoAtual = global ?? 50;

  // ── Decisão ──────────────────────────────────────────────────────────────
  let classificacao, cor, faixa, minutos, obs;

  if (statusMed === "afastado") {
    return { minutos: 0, faixa: "0 min", classificacao: "Protecao", obs: "Afastado", cor: "#b91c1c" };
  }

  if (statusMed === "transicao") {
    // Transição: teto 45-60 conforme IGP
    const teto2 = estadoAtual >= 70 ? 60 : estadoAtual >= 60 ? 55 : estadoAtual >= 50 ? 50 : 45;
    minutos = teto2;
    classificacao = "Transicao"; cor = "#c2410c";
    obs = "Em transicao — exposicao limitada";
    // Teto por fase RTP
    if (faseRTP != null) {
      const tetoRTP = [0, 0, 30, 45, Infinity][faseRTP.fase] ?? 0;
      if (isFinite(tetoRTP)) minutos = Math.min(minutos, tetoRTP);
    }
    faixa = minutos + " min";
    return { minutos, faixa, classificacao, obs, cor };
  }

  // 🔴 RESTRITO: IGP < 50, OU sistema crítico, OU combinação crítica, OU ISP muito baixo
  if (estadoAtual < 50 || algumCritico || combinacaoRestritiva || ispPiorando) {
    // Calcula minutos restritos baseado em IGP
    let base = Math.max(20, Math.round(teto * (Math.max(estadoAtual, 30) / 100)));
    if (algumCritico) base = Math.min(base, 45);
    minutos = Math.max(0, Math.min(teto, base));
    faixa   = minutos < 20 ? "<20 min" : minutos <= 45 ? "20-45 min" : "45-60 min";
    classificacao = minutos < 20 ? "Protecao" : "Uso reduzido"; cor = "#b91c1c";
    const motivos = [];
    if (estadoAtual < 50) motivos.push("IGP abaixo do limiar");
    if (algumCritico)      motivos.push("sistema critico");
    if (ispPiorando)       motivos.push("tendência em queda");
    obs = motivos.join(" · ");

  // 🟡 MONITORADO: IGP 50–69 ou sistema moderado (40–59) ou ISP Tendência Estável
  } else if (estadoAtual < 70 || [INM,IA,IH,IC].some(v => v != null && v < 60) || ispTend?.global?.label === 'Estável') {
    // Joga normal — faixa informativa
    minutos = teto; // sem restrição de minutos
    faixa   = "Normal c/ atenção";
    classificacao = "Monitorado"; cor = "#a16207";
    // Tendência como contexto
    if (zG != null && zG <= -0.5) obs = "Tendencia de queda — acompanhar";
    else obs = "Dentro dos parametros — monitorar";

  // 🟢 LIBERADO: IGP ≥ 70, sem sistema crítico, ISP ≥ 60
  } else {
    minutos = teto;
    faixa   = "Normal";
    classificacao = "Liberado"; cor = "#15803d";
    obs = zG != null && zG >= 0.5 ? "Boa evolucao na semana" : "Dentro dos parametros";
  }

  return { minutos, faixa, classificacao, obs, cor };
}

// ── Mensagem contextual por sistema prejudicado ──────────────────────────────
// Regras: gatilho de relevância + intensidade + contexto de tendência
// Princípio: se todo mundo tem alerta, ninguém tem alerta
function gerarMensagemSistema(sistemaNome, valor, tendSeta) {
  if (valor == null || sistemaNome == null) return null;

  // Gatilho de relevância — limiares por sistema (alinhados com novos thresholds)
  const limiar = sistemaNome === "Neuromuscular" ? 60 : 70;
  if (valor >= limiar) return null; // dentro do aceitável — sem mensagem

  // Níveis: leve = Atenção Leve | moderado = Atenção | alto = Crítico
  const nivel = sistemaNome === "Neuromuscular"
    ? (valor < 40 ? "alto" : valor < 50 ? "moderado" : "leve")
    : (valor < 50 ? "alto" : valor < 60 ? "moderado" : "leve");

  const base = {
    "Cognitivo": {
      leve:     "Atenção levemente reduzida — erros pontuais sob pressão",
      moderado: "Risco de erro decisional no segundo tempo",
      alto:     "Alta chance de erro sob pressão — evitar sobrecarga tática"
    },
    "Neuromuscular": {
      leve:     "Leve queda de potência em sprints e saltos",
      moderado: "Queda de potência em ações explosivas — tende a acentuar no segundo tempo",
      alto:     "Fadiga neuromuscular elevada — perda expressiva de potência no decorrer do jogo"
    },
    "Autonômico": {
      leve:     "Recuperação entre esforços levemente mais lenta",
      moderado: "Maior custo fisiológico — rendimento cai no segundo tempo",
      alto:     "Recuperação comprometida — alto risco de queda de performance"
    },
    "Subjetivo": {
      leve:     "Leve sensação de fadiga — monitorar durante o jogo",
      moderado: "Fadiga percebida pode impactar concentração e consistência",
      alto:     "Fadiga elevada — risco de queda técnica e motivacional"
    },
  };

  let msg = base[sistemaNome]?.[nivel];
  if (!msg) return null;

  // Contexto de tendência — muda a interpretação
  if (tendSeta === "▲") msg += " (em melhora)";
  if (tendSeta === "▼") msg += " (atenção: piorando)";

  return msg;
}

async function abrirModalConfirmacaoPDF() {
  await carregarDaily();

  const data      = document.getElementById("filtroData")?.value || hoje;
  const dataObj   = new Date(data + 'T12:00:00');

  // ── treinos do planejamento para o dia ────────────────────────────────────
  const _diasSemana = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
  const _diaDaSemana = _diasSemana[dataObj.getDay()];
  const _getISOWeek = d => {
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
    const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    return Math.ceil((((t - y) / 86400000) + 1) / 7);
  };
  const _semana = `S${_getISOWeek(dataObj)}-${dataObj.getFullYear()}`;
  let sessoesPlano = [];
  try {
    const _planDocId = `${_semana}_${CLUB_ID}`;
    const _snapPlan = await getDoc(doc(db, 'assessments_planning', _planDocId));
    if (_snapPlan.exists()) sessoesPlano = _snapPlan.data().sessions?.[_diaDaSemana] || [];
  } catch(e) { console.warn('planejamento fetch:', e); }
  const dataFmt   = dataObj.toLocaleDateString('pt-BR', { weekday:'long', day:'2-digit', month:'short', year:'numeric' });
  const categoria = document.getElementById("filtroCategoria")?.value || "";
  const _uctx     = JSON.parse(localStorage.getItem('userContext') || '{}');
  const nomeClube = _uctx.clubName || _uctx.clubId || 'Elenco';

  // Microciclo label para a data do relatório (não necessariamente hoje)
  let mc = _getMicrocicloManualDia(data, CLUB_ID);
  if (!mc?.label) {
    try {
      const _snapMC = await getDoc(doc(db, 'microciclo_dias', `${data}_${CLUB_ID}`));
      if (_snapMC.exists()) mc = _snapMC.data();
    } catch(e) { /* silencioso */ }
  }
  if (!mc?.label) mc = calcularDiaMicrociclo();
  const mcLabel = mc?.label || null;
  const mcCor   = mc?.cor   || '#6b7280';

  // ── helpers locais ─────────────────────────────────────────────────────────
  const _posAbrev = p => ({'Goleiro':'GOL','Lateral':'LAT','Zagueiro':'ZAG','Volante':'VOL','Meia':'MEI','Ponta':'PON','Centro-Avante':'CA','Centro-avante':'CA','Atacante':'ATA'})[p] || (p||'').slice(0,3).toUpperCase() || '—';
  const _iniciais = n => (n||'').trim().split(/\s+/).filter(Boolean).slice(0,2).map(p=>p[0].toUpperCase()).join('');
  const _med = arr => { const s=[...arr].filter(x=>x!=null).sort((a,b)=>a-b); if(!s.length)return null; const m=Math.floor(s.length/2); return s.length%2===0?(s[m-1]+s[m])/2:s[m]; };
  const _avg = arr => { const v=arr.filter(x=>x!=null); return v.length?v.reduce((a,b)=>a+b,0)/v.length:null; };
  const _corIGP  = v => v==null?'#9ca3af':v>=70?'#15803d':v>=60?'#a16207':v>=50?'#ea580c':'#b91c1c';
  const _bgIGP   = v => v==null?'#f3f4f6':v>=70?'#dcfce7':v>=60?'#fef9c3':v>=50?'#ffedd5':'#fee2e2';
  const _lblIGP  = v => v==null?'Sem dado':v>=70?'Prontidão ok':v>=60?'Prontidão regular':'Prontidão baixa';
  const _acwrLbl = v => v==null?'—':v<0.8?'Baixa carga':v<=1.3?'Zona segura':v<=1.5?'Atenção':'Risco';
  const _acwrCor = v => v==null?'#9ca3af':v<0.8?'#3b82f6':v<=1.3?'#15803d':v<=1.5?'#d97706':'#dc2626';
  const _avatar  = (nome, cor) => `<div style="width:28px;height:28px;border-radius:50%;background:${cor};display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:800;color:#fff;flex-shrink:0;">${_iniciais(nome)}</div>`;

  // ── dados dos atletas ──────────────────────────────────────────────────────
  const _pdfFiltroGrupo = document.getElementById("filtroGrupo")?.value ?? "";

  // Deriva IDs do grupo a partir do campo atletasPresentes nas sessões planejadas.
  // Isso cobre casos em que athlete_sessions não foi populado por atribuição manual.
  let _idsGrupoPDF = null;
  if (_pdfFiltroGrupo) {
    const sessoesGrupo = sessoesPlano.filter(s => (s.grupo || '').trim() === _pdfFiltroGrupo);
    const idsPresentes = new Set(sessoesGrupo.flatMap(s => (s.atletasPresentes || []).map(a => a.id || a)));
    if (idsPresentes.size > 0) {
      _idsGrupoPDF = idsPresentes;
    } else {
      // Fallback: tenta gruposByAthleta
      const idsGBA = new Set(Object.entries(gruposByAthleta).filter(([,g]) => g === _pdfFiltroGrupo).map(([id]) => id));
      if (idsGBA.size > 0) _idsGrupoPDF = idsGBA;
      // Se ambos vazios, _idsGrupoPDF fica null e nenhum filtro de atleta é aplicado
    }
  }

  const atletasFiltrados = atletas.filter(a => {
    if (document.getElementById("filtroCategoria")?.value && a.categoria !== document.getElementById("filtroCategoria").value) return false;
    if (document.getElementById("filtroPosicao")?.value   && a.posicao   !== document.getElementById("filtroPosicao").value)   return false;
    if (_idsGrupoPDF && !_idsGrupoPDF.has(a.id)) return false;
    return true;
  });

  const rows = atletasFiltrados.map(a => {
    const dm   = daily.find(d => d.athleteId === a.id);
    const calc = calcularProntidao(dm, calcularBasalAtleta(a.id));
    return {
      id: a.id, nome: a.nome, posicao: a.posicao || '—',
      global:    calc.global,
      IH:        calc.IH,
      IA:        calc.IA,
      INM:       calc.INM,
      IC:        calc.IC,
      pse:       dm?.post?.pse       ?? null,
      carga:     dm?.post?.carga     ?? null,
      qualidade: dm?.post?.qualidade ?? null,
      sessoes:   dm?.post?.sessoes   ?? [],
      dor:       dm?.pre?.dor        ?? null,
      regioesDor:dm?.pre?.regioes_dor?? [],
      acwr:      calcularACWR(a.id),
      ispTend:   calcularISPTendencia(a.id),
      sistemaSemana: getSistemaMaisAfetadoSemana(a.id, data),
    };
  });

  // ── Motor: lê daily_recommendations em paralelo (sem bloquear) ──────────────
  const _motorMap = new Map(); // athleteId → motor output
  try {
    const _motorSnaps = await Promise.all(
      atletasFiltrados.map(a => getDoc(doc(db, 'daily_recommendations', `${a.id}_${data}`)).catch(() => null))
    );
    _motorSnaps.forEach((snap, i) => {
      if (snap?.exists()) _motorMap.set(atletasFiltrados[i].id, snap.data());
    });
  } catch(e) { console.warn('[Motor] leitura daily_recommendations:', e); }

  // ── estatísticas PSE ──────────────────────────────────────────────────────
  const comPse        = rows.filter(r => r.pse != null);
  const medianaGrupo  = _med(comPse.map(r => r.pse));
  const mediaGrupo    = _avg(comPse.map(r => r.pse));
  const mediaACWR     = _avg(rows.map(r=>r.acwr).filter(v=>v!=null&&isFinite(v)));
  const mediaQual     = _avg(rows.map(r=>r.qualidade).filter(v=>v!=null));
  const mediaCargaPDF = _avg(rows.map(r=>r.carga).filter(v=>v!=null));
  const pctCargaPDF   = mediaCargaPDF != null ? Math.round(mediaCargaPDF / CARGA_JOGO_REF * 100) : null;
  const presentes     = comPse.length;

  // ── sessões do planejamento (Bloco 2 esq) ────────────────────────────────
  const _corTipo = tipo => {
    const t = (tipo||'').toLowerCase();
    if (t.includes('campo'))  return '#378ADD';
    if (t.includes('físic')||t.includes('fisic')) return '#BA7517';
    return '#888780'; // Complementar
  };
  const _corIntensidade = int => {
    const t = (int||'').toLowerCase();
    if (t.includes('muito alta')||t.includes('máxima')||t.includes('maxima')) return {bg:'#fee2e2',text:'#b91c1c'};
    if (t.includes('alta'))     return {bg:'#ffedd5',text:'#c2410c'};
    if (t.includes('modera')||t.includes('média')||t.includes('media'))       return {bg:'#dcfce7',text:'#15803d'};
    return {bg:'#dbeafe',text:'#1d4ed8'}; // Regenerativa / Baixa / default
  };
  sessoesPlano.sort((a, b) => {
    const ha = a.horario || '99:99';
    const hb = b.horario || '99:99';
    return ha.localeCompare(hb);
  });
  const tempoTotal = sessoesPlano.reduce((s,se) => s + (Number(se.volume)||0), 0);

  // ── por posição (Bloco 2 dir) ─────────────────────────────────────────────
  const _ordemPos = ['Goleiro','Lateral','Zagueiro','Volante','Meia','Ponta','Centro-Avante','Centro-avante','Atacante'];
  const posicoesPresentes = [...new Set(rows.map(r=>r.posicao))].sort((a,b) => {
    const ia = _ordemPos.findIndex(x=>x.toLowerCase()===a.toLowerCase());
    const ib = _ordemPos.findIndex(x=>x.toLowerCase()===b.toLowerCase());
    return (ia<0?99:ia)-(ib<0?99:ib);
  });
  const porPosicao = posicoesPresentes.map(pos => {
    const g = rows.filter(r=>r.posicao.toLowerCase()===pos.toLowerCase());
    return { pos, abrev: _posAbrev(pos), prontMedia: _avg(g.map(r=>r.global)), cargaMedia: _avg(g.filter(r=>r.carga!=null).map(r=>r.carga)), n: g.length };
  });
  const maxCargaPos = 1500;

  // ── deltas PSE (Bloco 3) ──────────────────────────────────────────────────
  const withDelta  = comPse.map(r => ({ ...r, delta: r.pse - (medianaGrupo??0) }));
  const incomp     = withDelta.filter(r=>r.delta>2.5).sort((a,b)=>b.delta-a.delta);
  const elev       = withDelta.filter(r=>r.delta>=1.5&&r.delta<=2.5).sort((a,b)=>b.delta-a.delta);
  const bx         = withDelta.filter(r=>r.delta<-1.5).sort((a,b)=>a.delta-b.delta);
  const pseDist    = Array.from({length:10},(_,i)=>i+1).map(v=>({v,n:comPse.filter(r=>Math.round(r.pse)===v).length}));
  const maxDist    = Math.max(...pseDist.map(d=>d.n),1);

  // ── Bloco 4 ───────────────────────────────────────────────────────────────
  const comDor = rows.filter(r=>r.dor!=null&&r.dor>=5).sort((a,b)=>b.dor-a.dor);

  // ── Atletas com indicador crítico (qualquer sistema) ──────────────────────
  const atletasCriticos = rows.filter(r =>
    (r.global != null && r.global < 50) ||
    (r.IH  != null && r.IH  < 50) ||
    (r.IA  != null && r.IA  < 50) ||
    (r.INM != null && r.INM < 40) ||  // CMJ: limiar crítico < 40
    (r.IC  != null && r.IC  < 50)
  ).map(r => {
    const alertas = [];
    if (r.global != null && r.global < 50) alertas.push(`IGP ${Math.round(r.global)}/100`);
    if (r.IH  != null && r.IH  < 50) alertas.push(`Hooper ${Math.round(r.IH)}/100`);
    if (r.IA  != null && r.IA  < 50) alertas.push(`HRV ${Math.round(r.IA)}/100`);
    if (r.INM != null && r.INM < 40) alertas.push(`CMJ ${Math.round(r.INM)}/100`);
    if (r.IC  != null && r.IC  < 50) alertas.push(`NeuroScore ${Math.round(r.IC)}/100`);
    return { ...r, alertas };
  }).sort((a,b) => (a.global??100)-(b.global??100));

  // ── helper: atleta passa no filtro de grupo do planejamento ─────────────────
  const _passaGrupo = athleteId => {
    if (!_pdfFiltroGrupo) return true;
    if (_idsGrupoPDF) return _idsGrupoPDF.has(athleteId);
    return true;
  };

  const atletaMap   = Object.fromEntries(atletas.map(a=>[a.id,a]));

  const atendHoje = assessmentsMedical.filter(m => {
    const dt = m.data || m.date || '';
    const tipoDoc = (m.tipo||'').toLowerCase();
    if (!(dt === data && (tipoDoc === 'atendimento' || !!(m.tipoAtendimento||m.dados?.tipoAtendimento)))) return false;
    return _passaGrupo(m.athleteId);
  });
  const _quandoOrdem = quando => {
    const w = (quando||'').toLowerCase();
    if (w.includes('pré') || w.includes('pre')) return 0;
    if (w.includes('concentr') || w.includes('jogo')) return 1;
    if (w.includes('pós') || w.includes('pos')) return 2;
    return 3;
  };
  const atendInfos  = atendHoje.map(m => ({
    nome:    atletaMap[m.athleteId]?.nome    || '—',
    posicao: atletaMap[m.athleteId]?.posicao || '—',
    tipo:    m.tipoAtendimento || m.dados?.tipoAtendimento || '—',
    conduta: m.dados?.conduta || '',
    queixa:  m.dados?.queixa  || '',
    quando:  m.dados?.quandoOcorreu || m.quandoOcorreu || '',
  })).sort((a,b) => _quandoOrdem(a.quando) - _quandoOrdem(b.quando));

  // ── Atendimentos de ontem → Reavaliação hoje ────────────────────────────────
  const dataOntemObj = new Date(dataObj); dataOntemObj.setDate(dataOntemObj.getDate() - 1);
  const dataOntem = dataOntemObj.toLocaleDateString('en-CA');
  const atendOntem = assessmentsMedical.filter(m => {
    const dt = m.data || m.date || '';
    const tipoDoc = (m.tipo||'').toLowerCase();
    if (!(dt === dataOntem && (tipoDoc === 'atendimento' || !!(m.tipoAtendimento||m.dados?.tipoAtendimento)))) return false;
    return _passaGrupo(m.athleteId);
  });
  const reavInfos = atendOntem.map(m => ({
    nome:    atletaMap[m.athleteId]?.nome    || '—',
    posicao: atletaMap[m.athleteId]?.posicao || '—',
    tipo:    m.tipoAtendimento || m.dados?.tipoAtendimento || '—',
  }));

  // ── Atletas Afastados ────────────────────────────────────────────────────
  const _isLesaoReg = r => r.tipo === 'lesao' || r.tipo === 'lesão'
    || r.tipo === 'status_clinico'
    || r.dados?.tipoRegistro === 'lesao'
    || (!r.tipoAtendimento && (r.tipoLesao || r.dados?.tipoLesao));
  const afastadosInfos = atletas
    .filter(a => statusMedicoAtleta(a.id) === 'afastado')
    .map(a => {
      // Registro de lesão mais recente com status afastado
      const reg = assessmentsMedical
        .filter(m => {
          if (m.athleteId !== a.id) return false;
          if ((m.data || m.date || '') > data) return false;
          const st = (m?.dados?.statusAtual || m?.dados?.status || m?.status || '').toLowerCase();
          return _isLesaoReg(m) && (st.includes('afast') || st.includes('lesion') || st === '');
        })
        .sort((x,y) => (y.data||y.date||'').localeCompare(x.data||x.date||''))[0];
      const lesao = reg?.dados?.tipoLesao || reg?.dados?.localLesao || reg?.dados?.diagnostico || reg?.dados?.queixa || reg?.tipoLesao || '';
      const dataLesao = reg?.data || reg?.date || null;
      const diasAf = dataLesao ? Math.max(0, Math.round((new Date(data + 'T12:00:00') - new Date(dataLesao + 'T00:00:00')) / 86400000)) : null;
      return { nome: a.nome, posicao: a.posicao || '—', lesao, diasAf };
    })
    .sort((a,b) => a.nome.localeCompare(b.nome));

  // ── Atletas em Transição ─────────────────────────────────────────────────
  const transicaoInfos = atletas
    .filter(a => statusMedicoAtleta(a.id) === 'transicao')
    .map(a => {
      const faseSalva = _carregarFaseRTP(a.id);
      const dm = daily.find(d => d.athleteId === a.id);
      const calc = calcularProntidao(dm, calcularBasalAtleta(a.id));
      const fase = calcularFaseRTP('transicao', calc, faseSalva?.fase ?? 0);
      const dataTransicao = dataInicioTransicao(a.id);
      const diasTrans = dataTransicao ? Math.max(0, Math.round((new Date(data + 'T12:00:00') - new Date(dataTransicao + 'T00:00:00')) / 86400000)) : null;
      return { nome: a.nome, posicao: a.posicao || '—', faseLabel: fase?.label || 'Transição', faseCor: fase?.cor || '#b45309', diasTrans };
    })
    .sort((a,b) => a.nome.localeCompare(b.nome));



  // ── Bloco 5: monitorar amanhã — critérios clínicos ────────────────────────
  const _atendByAtleta = id => atendHoje.find(m=>m.athleteId===id);
  const _isMedico = atend => {
    const t = (atend?.tipoAtendimento||atend?.dados?.tipoAtendimento||'').toLowerCase();
    return t.includes('médi')||t.includes('medic')||t.includes('avali')||t.includes('proced');
  };
  const _DOSES_MON = ['manter', 'leve', 'moderado', 'forte'];
  const _PR_MON    = ['carga_mecanica', 'volume', 'intensidade', 'densidade'];
  function _criterioMonitorar(r) {
    const mot   = _motorMap.get(r.id);
    const atend = _atendByAtleta(r.id);
    const eixos = mot?.eixos || {};
    const maxDoseIdx = Math.max(-1, ..._PR_MON.map(e => _DOSES_MON.indexOf(eixos[e]?.dose_final ?? 'manter')));
    // P1 — ACWR Risco
    if (r.acwr != null && r.acwr > 1.5)
      return { label: 'ACWR Risco', cor: '#b91c1c', bg: '#fee2e2',
               motivo: `ACWR ${r.acwr} — sobrecarga aguda elevada` };
    // P2 — Encaminhamento DM ou restrição Forte
    if (mot?.encaminhamento)
      return { label: 'Encaminhar DM', cor: '#b91c1c', bg: '#fee2e2',
               motivo: 'Motor recomenda encaminhamento médico' };
    if (maxDoseIdx >= 3)
      return { label: 'Restrição Alta', cor: '#c2410c', bg: '#ffedd5',
               motivo: 'Restrição alta em pelo menos um eixo de carga' };
    // P3 — IGP comprometido + carga recebida
    if (r.global != null && r.global < 60 && r.carga != null)
      return { label: 'IGP + Carga', cor: '#c2410c', bg: '#ffedd5',
               motivo: `Prontidão ${Math.round(r.global)} com carga recebida hoje` };
    // P4 — ACWR Atenção
    if (r.acwr != null && r.acwr > 1.3)
      return { label: 'ACWR Atenção', cor: '#b45309', bg: '#fef9c3',
               motivo: `ACWR ${r.acwr} — monitorar acúmulo de carga` };
    // P5 — ISP Limitado/Insuficiente
    const ispLabel = r.ispTend?.global?.label;
    if (ispLabel === 'Limitado' || ispLabel === 'Insuficiente')
      return { label: `ISP ${ispLabel}`, cor: '#b45309', bg: '#fef9c3',
               motivo: 'Tendência de adaptação fraca na semana' };
    // P6 — Dor + Atendimento DM
    if (r.dor != null && r.dor >= 5 && atend)
      return { label: `Dor ${r.dor}/7`, cor: '#d97706', bg: '#fef3c7',
               motivo: 'Dor relatada com atendimento no DM' };
    if (_isMedico(atend))
      return { label: 'Avaliação Médica', cor: '#7c3aed', bg: '#ede9fe',
               motivo: 'Avaliação médica registrada hoje' };
    if (atend)
      return { label: 'Reavaliação DM', cor: '#7c3aed', bg: '#ede9fe',
               motivo: 'Reavaliação com Depto. Médico amanhã' };
    return null;
  }
  const _ordBg = ['#fee2e2', '#ffedd5', '#fef9c3', '#ede9fe', '#fef3c7'];
  const todosMonitorar = rows
    .map(r => ({ r, crit: _criterioMonitorar(r) }))
    .filter(({ crit }) => crit !== null)
    .sort((a, b) => _ordBg.indexOf(a.crit.bg) - _ordBg.indexOf(b.crit.bg));

  // ── render helpers ────────────────────────────────────────────────────────
  const _pillTipo = tipo => {
    const t=(tipo||'').toLowerCase();
    if(t.includes('fisio'))                              return ['Fisio','#1d4ed8','#dbeafe'];
    if(t.includes('médi')||t.includes('avali')||t.includes('proced')) return ['Médico','#b91c1c','#fee2e2'];
    if(t.includes('massa'))                              return ['Massagem','#7c3aed','#ede9fe'];
    if(t.includes('nutri'))                              return ['Nutri','#15803d','#dcfce7'];
    if(t.includes('psico'))                              return ['Psico','#d97706','#fef3c7'];
    return ['Outro','#6b7280','#f3f4f6'];
  };

  const _rowDor = r => {
    const cor = r.dor>=7?'#b91c1c':r.dor>=6?'#c2410c':'#d97706';
    return `<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:#faeeda;border:1px solid #fac775;border-radius:6px;margin-bottom:5px;">
      ${_avatar(r.nome,cor)}
      <div style="flex:1;min-width:0;">
        <div style="font-size:11px;font-weight:700;color:#1e293b;">${r.nome}</div>
        <div style="font-size:9px;color:#92400e;">${_posAbrev(r.posicao)} · ${r.regioesDor.length?r.regioesDor.join(' · '):'Região não informada'}</div>
      </div>
      <div style="display:flex;align-items:center;gap:3px;flex-shrink:0;">
        <span style="width:8px;height:8px;border-radius:50%;background:${cor};display:inline-block;"></span>
        <span style="font-size:13px;font-weight:900;color:${cor};">${r.dor}/7</span>
      </div>
    </div>`;
  };

  const _pillQuando = quando => {
    const w = (quando||'').toLowerCase();
    if (w.includes('pré') || w.includes('pre')) return { lbl: quando||'Pré-treino', cor:'#1d4ed8', bg:'#dbeafe' };
    if (w.includes('pós') || w.includes('pos')) return { lbl: quando||'Pós-treino', cor:'#c2410c', bg:'#ffedd5' };
    if (w.includes('concentr') || w.includes('jogo')) return { lbl: quando||'Pré-jogo', cor:'#7c3aed', bg:'#ede9fe' };
    return { lbl: quando||'—', cor:'#6b7280', bg:'#f3f4f6' };
  };

  const _rowAtend = info => {
    const pw = _pillQuando(info.quando);
    return `<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:#eeedfe;border:1px solid #afa9ec;border-radius:6px;margin-bottom:5px;">
      ${_avatar(info.nome,'#7c3aed')}
      <div style="flex:1;min-width:0;">
        <div style="font-size:11px;font-weight:700;color:#1e293b;">${info.nome}</div>
        <div style="font-size:9px;color:#5b21b6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${_posAbrev(info.posicao)} · ${info.conduta||info.queixa||'—'}</div>
      </div>
      <span style="padding:2px 7px;border-radius:999px;font-size:9px;font-weight:800;background:${pw.bg};color:${pw.cor};white-space:nowrap;">${pw.lbl}</span>
    </div>`;
  };

  const _rowReav = info => `<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:#fef3c7;border:1px solid #fde68a;border-radius:6px;margin-bottom:5px;">
    ${_avatar(info.nome,'#d97706')}
    <div style="flex:1;min-width:0;">
      <div style="font-size:11px;font-weight:700;color:#1e293b;">${info.nome}</div>
      <div style="font-size:9px;color:#92400e;">${_posAbrev(info.posicao)} · Atendimento ontem: ${info.tipo}</div>
    </div>
    <span style="padding:2px 7px;border-radius:999px;font-size:9px;font-weight:800;background:#fef3c7;color:#92400e;border:1px solid #fde68a;white-space:nowrap;">Reavaliação</span>
  </div>`;

  const _deltaBar = delta => {
    const pct = Math.min(Math.abs(delta)/5,1)*50;
    const isPos = delta>0;
    const cor = delta>2.5?'#dc2626':delta>=1.5?'#f59e0b':'#3b82f6';
    return `<div style="position:relative;height:10px;background:#f3f4f6;border-radius:5px;width:100px;border:1px solid #d1d5db;">
      <div style="position:absolute;left:50%;top:0;width:2px;height:10px;background:#9ca3af;transform:translateX(-50%);"></div>
      <div style="position:absolute;${isPos?'left:50%':'right:50%'};top:1px;height:8px;width:${pct}%;background:${cor};border-radius:${isPos?'0 4px 4px 0':'4px 0 0 4px'};"></div>
    </div>`;
  };

  const _rowResposta = (r, cat) => {
    const corCat = cat==='incomp'?'#dc2626':cat==='elev'?'#f59e0b':'#3b82f6';
    const lbl    = cat==='incomp'?'Incompatível':cat==='elev'?'Elevada':'Baixa';
    return `<div style="display:flex;align-items:center;gap:6px;padding:5px 10px;border-bottom:1px solid #f1f5f9;">
      ${_avatar(r.nome,corCat)}
      <div style="min-width:0;flex:1;">
        <div style="font-size:10px;font-weight:700;color:#1e293b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${r.nome}</div>
        <div style="font-size:8px;color:#9ca3af;">${_posAbrev(r.posicao)}</div>
      </div>
      <div style="width:24px;text-align:center;font-size:12px;font-weight:900;color:#1e293b;flex-shrink:0;">${r.pse}</div>
      <div style="flex:1;display:flex;justify-content:center;">${_deltaBar(r.delta)}</div>
      <div style="width:34px;text-align:right;font-size:11px;font-weight:800;color:${corCat};flex-shrink:0;">${r.delta>0?'+':''}${r.delta.toFixed(1)}</div>
      <span style="padding:2px 6px;border-radius:999px;font-size:8px;font-weight:700;background:${_bgIGP(r.global)};color:${_corIGP(r.global)};white-space:nowrap;">${_lblIGP(r.global)}</span>
    </div>`;
  };

  const _secaoResposta = (titulo, cor, rows, cat) => !rows.length?'': `
    <div style="background:${cor}12;border-left:3px solid ${cor};border-radius:0 6px 6px 0;margin-bottom:10px;">
      <div style="padding:6px 12px;font-size:10px;font-weight:800;color:${cor};text-transform:uppercase;letter-spacing:.05em;">${titulo} · ${rows.length} atleta${rows.length!==1?'s':''}</div>
      ${rows.map(r=>_rowResposta(r,cat)).join('')}
    </div>`;

  const _pillsMonit = r => {
    const delta = r.pse!=null&&medianaGrupo!=null?r.pse-medianaGrupo:null;
    const atend = _atendByAtleta(r.id);
    const ps = [];
    if (delta!=null&&delta>0)  ps.push(`<span style="padding:2px 8px;border-radius:999px;font-size:9px;font-weight:700;background:#fee2e2;color:#b91c1c;">PSE +${delta.toFixed(1)}</span>`);
    if (delta!=null&&delta<-1.5) ps.push(`<span style="padding:2px 8px;border-radius:999px;font-size:9px;font-weight:700;background:#dbeafe;color:#1d4ed8;">PSE ${delta.toFixed(1)}</span>`);
    if (r.global!=null) ps.push(`<span style="padding:2px 8px;border-radius:999px;font-size:9px;font-weight:700;background:${_bgIGP(r.global)};color:${_corIGP(r.global)};">IGP ${Math.round(r.global)} · ${_lblIGP(r.global).replace('IGP ','')}</span>`);
    if (r.dor!=null&&r.dor>=5)  ps.push(`<span style="padding:2px 8px;border-radius:999px;font-size:9px;font-weight:700;background:#ffedd5;color:#c2410c;">Dor ${r.dor}/7</span>`);
    if (atend)                   ps.push(`<span style="padding:2px 8px;border-radius:999px;font-size:9px;font-weight:700;background:#fef3c7;color:#92400e;">Reavaliação</span>`);
    return ps.join(' ');
  };

  const _motivoMonit = r => {
    const delta = r.pse!=null&&medianaGrupo!=null?r.pse-medianaGrupo:null;
    const atend = _atendByAtleta(r.id);
    const ps = [];
    if (delta!=null&&delta>2.5)                     ps.push('Resposta incompatível com o grupo');
    if (delta!=null&&delta>=1.5&&delta<=2.5)         ps.push('Resposta elevada');
    if (delta!=null&&delta<-1.5&&r.global>=70)       ps.push('Resposta abaixo do esperado');
    if (r.dor!=null&&r.dor>=5&&atend)               ps.push(`Dor ${r.dor}/7 com atendimento DM`);
    if (_isMedico(atend))                            ps.push('Avaliação médica registrada');
    if (atend&&!_isMedico(atend))                    ps.push('Reavaliação DM amanhã');
    if (r.global!=null&&r.global<60)                 ps.push('IGP abaixo do limiar de atenção');
    return ps.join(' · ') || 'Sinalizado para monitoramento';
  };

  // ── HTML dos blocos ────────────────────────────────────────────────────────

  // Bloco 2 esq — sessões do planejamento (agrupadas por grupo quando "Todos")
  const _renderSessao = s => {
    const cor = _corTipo(s.tipo);
    const vol = Number(s.volume)||null;
    return `
      <div style="display:flex;align-items:flex-start;gap:0;margin-bottom:6px;border-radius:0 6px 6px 0;overflow:hidden;">
        <div style="width:4px;background:${cor};flex-shrink:0;align-self:stretch;"></div>
        <div style="flex:1;background:#f8fafc;padding:8px 12px;">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:2px;">
            ${s.horario?`<span style="font-size:10px;font-weight:800;color:#1e293b;background:#e2e8f0;padding:1px 7px;border-radius:4px;letter-spacing:.02em;">⏰ ${s.horario}</span>`:''}
            <span style="font-size:10px;font-weight:800;color:${cor};text-transform:uppercase;letter-spacing:.04em;">${s.tipo||'—'}</span>
            ${s.intensidade?`<span style="font-size:9px;padding:1px 6px;border-radius:999px;background:${_corIntensidade(s.intensidade).bg};color:${_corIntensidade(s.intensidade).text};font-weight:700;">${s.intensidade}</span>`:''}
          </div>
          <div style="font-size:12px;font-weight:600;color:#1e293b;line-height:1.4;">${s.atividade||'—'}</div>
          ${s.obs?`<div style="font-size:10px;color:#9ca3af;margin-top:2px;">${s.obs}</div>`:''}
        </div>
        ${vol?`<div style="background:#f8fafc;padding:8px 12px;text-align:right;flex-shrink:0;border-left:1px solid #e5e7eb;">
          <div style="font-size:14px;font-weight:900;color:#1e293b;">${vol}<span style="font-size:9px;font-weight:400;color:#9ca3af;">min</span></div>
        </div>`:''}
      </div>`;
  };
  const _renderGrupoSessoes = (label, sessoes) => {
    const tempo = sessoes.reduce((s, se) => s + (Number(se.volume)||0), 0);
    return `<div style="margin-bottom:12px;">
      <div style="font-size:9px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px;padding:3px 8px;background:#f1f5f9;border-radius:4px;display:inline-block;">${label}</div>
      ${sessoes.map(_renderSessao).join('')}
      <div style="margin-top:4px;padding:5px 10px;background:#f0f9ff;border-radius:6px;font-size:11px;font-weight:700;color:#0369a1;">Total: ${tempo>0?tempo+' min':'—'}</div>
    </div>`;
  };

  let _sessoesHTML;
  if (!_pdfFiltroGrupo) {
    // "Todos" → agrupa todas as sessões pelo campo grupo e exibe cada grupo separadamente
    const gruposMap = new Map();
    sessoesPlano.forEach(s => {
      const chave = (s.grupo || 'Geral').trim() || 'Geral';
      if (!gruposMap.has(chave)) gruposMap.set(chave, []);
      gruposMap.get(chave).push(s);
    });
    if (!gruposMap.size) {
      _sessoesHTML = `<div style="font-size:11px;color:#d1d5db;text-align:center;padding:24px 0;">Nenhum treino cadastrado para ${_diaDaSemana}.</div>`;
    } else {
      _sessoesHTML = [...gruposMap.entries()].map(([chave, sessoes]) => _renderGrupoSessoes(chave, sessoes)).join('');
    }
  } else {
    const sessoesFiltradas = sessoesPlano.filter(s => (s.grupo || '').trim() === _pdfFiltroGrupo);
    if (sessoesFiltradas.length) {
      _sessoesHTML = _renderGrupoSessoes(_pdfFiltroGrupo, sessoesFiltradas);
    } else if (sessoesPlano.length) {
      // Nenhuma sessão com esse grupo — exibe todas
      const gruposMap = new Map();
      sessoesPlano.forEach(s => {
        const chave = (s.grupo || 'Geral').trim() || 'Geral';
        if (!gruposMap.has(chave)) gruposMap.set(chave, []);
        gruposMap.get(chave).push(s);
      });
      _sessoesHTML = [...gruposMap.entries()].map(([chave, sessoes]) => _renderGrupoSessoes(chave, sessoes)).join('');
    } else {
      _sessoesHTML = `<div style="font-size:11px;color:#d1d5db;text-align:center;padding:24px 0;">Nenhum treino cadastrado para ${_diaDaSemana}.</div>`;
    }
  }

  const _afastadosMiniHTML = (afastadosInfos.length || transicaoInfos.length) ? `
    <div style="margin-top:10px;border-top:1px solid #fee2e2;padding-top:8px;">
      ${afastadosInfos.length ? `
        <div style="font-size:8px;font-weight:700;color:#b91c1c;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px;">Atletas Afastados</div>
        ${afastadosInfos.map(a=>`
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
            <span style="width:6px;height:6px;border-radius:50%;background:#b91c1c;flex-shrink:0;display:inline-block;"></span>
            <span style="font-size:10px;font-weight:600;color:#1e293b;">${a.nome}</span>
            <span style="font-size:9px;color:#9ca3af;">${a.posicao}${a.lesao?' · '+a.lesao:''}</span>
            ${a.diasAf!=null?`<span style="margin-left:auto;font-size:9px;color:#b91c1c;font-weight:700;white-space:nowrap;">${a.diasAf}d</span>`:''}
          </div>`).join('')}
      ` : ''}
      ${transicaoInfos.length ? `
        <div style="font-size:8px;font-weight:700;color:#b45309;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px;${afastadosInfos.length?'margin-top:8px;':''}">Em Transição (RTP)</div>
        ${transicaoInfos.map(a=>`
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
            <span style="width:6px;height:6px;border-radius:50%;background:#b45309;flex-shrink:0;display:inline-block;"></span>
            <span style="font-size:10px;font-weight:600;color:#1e293b;">${a.nome}</span>
            <span style="font-size:9px;color:#9ca3af;">${a.posicao}</span>
            <span style="margin-left:auto;font-size:8px;font-weight:700;padding:1px 5px;border-radius:4px;background:#fef9c3;color:${a.faseCor};white-space:nowrap;">${a.faseLabel}</span>
            ${a.diasTrans!=null?`<span style="font-size:9px;color:#b45309;font-weight:700;white-space:nowrap;">${a.diasTrans}d</span>`:''}
          </div>`).join('')}
      ` : ''}
    </div>` : '';

  // Bloco 2 dir — gráfico de evolução de carga semanal (SVG)
  const _atletaIds7 = new Set(atletasFiltrados.map(a => a.id));
  // Semana atual: segunda a domingo da semana que contém dataObj
  const _dowData = dataObj.getDay(); // 0=Dom, 1=Seg...6=Sáb
  const _daysToMon = _dowData === 0 ? 6 : _dowData - 1;
  const _weekMon = new Date(dataObj); _weekMon.setDate(_weekMon.getDate() - _daysToMon);
  const _last7Dates = Array.from({length:7}, (_,i) => {
    const d = new Date(_weekMon); d.setDate(d.getDate() + i);
    return d.toLocaleDateString('en-CA');
  });
  const _dayAbbr7 = dt => ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'][new Date(dt+'T12:00:00').getDay()];
  const _cargaMedia7 = _last7Dates.map(dt => {
    const recs = historico.filter(h => h.date===dt && _atletaIds7.has(h.athleteId) && h.post?.carga!=null);
    return recs.length ? recs.reduce((s,h)=>s+h.post.carga,0)/recs.length : null;
  });
  // Média dos últimos 28 dias (linha horizontal de referência)
  const _hist28Start = new Date(_weekMon); _hist28Start.setDate(_hist28Start.getDate() - 28);
  const _hist28ISO = _hist28Start.toLocaleDateString('en-CA');
  const _hist28Recs = historico.filter(h => h.date >= _hist28ISO && h.date < _last7Dates[0] && _atletaIds7.has(h.athleteId) && h.post?.carga != null);
  // Agrupa por data para calcular média diária, depois média das médias
  const _hist28ByDate = {};
  _hist28Recs.forEach(h => { (_hist28ByDate[h.date] = _hist28ByDate[h.date]||[]).push(h.post.carga); });
  const _hist28DayAvgs = Object.values(_hist28ByDate).map(arr => arr.reduce((s,v)=>s+v,0)/arr.length);
  const _hist28Avg = _hist28DayAvgs.length ? _hist28DayAvgs.reduce((s,v)=>s+v,0)/_hist28DayAvgs.length : null;

  // SVG dimensions
  const _svgW7=460, _svgH7=100, _svgL7=34, _svgR7=8, _svgT7=10, _svgB7=22;
  const _svgPW7=_svgW7-_svgL7-_svgR7, _svgPH7=_svgH7-_svgT7-_svgB7;
  const _allV7=[..._cargaMedia7,_hist28Avg,CARGA_JOGO_REF].filter(v=>v!=null);
  const _yMax7=Math.max(Math.ceil(Math.max(..._allV7,400)/200)*200,400);
  const _xp7=(i)=>(_svgL7+i*(_svgPW7/6)).toFixed(1);
  const _yp7=(v)=>(_svgT7+_svgPH7*(1-v/_yMax7)).toFixed(1);
  const _seg7=(pts)=>{let p='',s=false;pts.forEach(x=>{if(x){p+=s?` L ${x}`:`M ${x}`;s=true;}else s=false;});return p;};
  const _pts1_7=_cargaMedia7.map((v,i)=>v!=null?`${_xp7(i)} ${_yp7(v)}`:null);
  const _yRef7=parseFloat(_yp7(CARGA_JOGO_REF));
  const _yHist7=_hist28Avg!=null?parseFloat(_yp7(_hist28Avg)):null;
  const _yTicks7=[0,Math.round(_yMax7/2),_yMax7];
  const _barW7 = Math.floor((_svgPW7/6) * 0.62);
  const _yBase7 = parseFloat(_yp7(0));
  const _cargaBarsHTML7 = _cargaMedia7.map((v,i) => {
    if (v == null) return '';
    const cx = parseFloat(_xp7(i));
    const bx = (cx - _barW7/2).toFixed(1);
    const by = parseFloat(_yp7(v));
    const bh = Math.max(_yBase7 - by, 2).toFixed(1);
    const isToday = _last7Dates[i] === data;
    const corBar = v>=800?'#b91c1c':v>=600?'#c2410c':v>=300?'#15803d':'#3b82f6';
    const corLabel = isToday ? '#1d4ed8' : corBar;
    return `<rect x="${bx}" y="${by.toFixed(1)}" width="${_barW7}" height="${bh}" fill="${corBar}" rx="2" ${isToday?`stroke="#1d4ed8" stroke-width="1.5"`:''}/>
    <text x="${cx.toFixed(1)}" y="${(by-2.5).toFixed(1)}" text-anchor="middle" font-size="7" fill="${corLabel}" font-weight="${isToday?'800':'600'}">${Math.round(v)}</text>`;
  }).join('');
  const _cargaLineHTML = `<div style="margin-top:12px;">
  <div style="font-size:8px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px;">Evolução da carga — semana atual</div>
  <svg viewBox="0 0 ${_svgW7} ${_svgH7}" style="width:100%;height:auto;display:block;">
    ${_yTicks7.map(v=>`<line x1="${_svgL7}" y1="${_yp7(v)}" x2="${_svgW7-_svgR7}" y2="${_yp7(v)}" stroke="#e5e7eb" stroke-width="1"/>`).join('')}
    ${_yTicks7.map(v=>`<text x="${(_svgL7-3)}" y="${(parseFloat(_yp7(v))+3).toFixed(1)}" text-anchor="end" font-size="7" fill="#9ca3af">${v}</text>`).join('')}
    ${_last7Dates.map((dt,i)=>`<text x="${_xp7(i)}" y="${_svgH7-6}" text-anchor="middle" font-size="7" fill="${dt===data?'#1d4ed8':'#9ca3af'}" font-weight="${dt===data?'700':'400'}">${_dayAbbr7(dt)}</text>`).join('')}
    <line x1="${_svgL7}" y1="${_yRef7}" x2="${_svgW7-_svgR7}" y2="${_yRef7}" stroke="#f59e0b" stroke-width="1.2" stroke-dasharray="4,3"/>
    ${_yHist7!=null?`<line x1="${_svgL7}" y1="${_yHist7}" x2="${_svgW7-_svgR7}" y2="${_yHist7}" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="4,3"/><text x="${_svgW7-_svgR7-2}" y="${(_yHist7-3).toFixed(1)}" text-anchor="end" font-size="6.5" fill="#94a3b8">${Math.round(_hist28Avg)}</text>`:''}
    ${_cargaBarsHTML7}
  </svg>
  <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:3px;">
    <span style="display:inline-flex;align-items:center;gap:3px;font-size:7.5px;color:#3b82f6;font-weight:700;"><svg width="10" height="8" viewBox="0 0 10 8"><rect x="0" y="0" width="10" height="8" fill="#3b82f6" rx="1"/></svg>Carga média</span>
    <span style="display:inline-flex;align-items:center;gap:3px;font-size:7.5px;color:#94a3b8;font-weight:700;"><svg width="14" height="4" viewBox="0 0 14 4"><line x1="0" y1="2" x2="14" y2="2" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="4,3"/></svg>Média 28 dias</span>
    <span style="display:inline-flex;align-items:center;gap:3px;font-size:7.5px;color:#d97706;font-weight:700;"><svg width="14" height="4" viewBox="0 0 14 4"><line x1="0" y1="2" x2="14" y2="2" stroke="#f59e0b" stroke-width="1.5" stroke-dasharray="4,3"/></svg>Ref. jogo (${CARGA_JOGO_REF})</span>
  </div>
</div>`;

  // Bloco 2 dir — barras por posição
  const _posBarHTML = porPosicao.map(p=>{
    // barra = carga (PSE × tempo), relativa ao máximo do grupo
    const pct    = p.cargaMedia!=null ? Math.round(p.cargaMedia/maxCargaPos*100) : 0;
    const corBar = p.cargaMedia==null?'#d1d5db':p.cargaMedia>=800?'#b91c1c':p.cargaMedia>=600?'#c2410c':p.cargaMedia>=300?'#15803d':'#3b82f6';
    // valor = IGP, colorido pelo limiar
    const corIGP = p.prontMedia==null?'#9ca3af':p.prontMedia>=70?'#15803d':p.prontMedia>=60?'#a16207':p.prontMedia>=50?'#ea580c':'#b91c1c';
    const igpVal = p.prontMedia!=null?Math.round(p.prontMedia):'—';
    return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:7px;">
      <span style="width:30px;font-size:10px;font-weight:700;color:#6b7280;flex-shrink:0;">${p.abrev}</span>
      <div style="flex:1;height:10px;background:#f3f4f6;border-radius:5px;border:1px solid #e5e7eb;overflow:hidden;">
        <div style="height:100%;width:${pct}%;background:${corBar};border-radius:4px;"></div>
      </div>
      <span style="font-size:10px;font-weight:900;color:${corIGP};width:24px;text-align:right;">${igpVal}</span>
    </div>`;
  }).join('');

  // Bloco 3 — distribuição
  const _distHTML = pseDist.map(d=>{
    const h = Math.round(d.n/maxDist*32);
    const cor = d.v<=4?'#3b82f6':d.v<=7?'#f59e0b':'#ef4444';
    return `<div style="display:flex;flex-direction:column;align-items:center;gap:1px;flex:1;">
      <div style="font-size:8px;color:#9ca3af;font-weight:700;min-height:12px;">${d.n||''}</div>
      <div style="height:32px;display:flex;align-items:flex-end;width:100%;">
        <div style="width:100%;height:${h}px;min-height:${d.n>0?3:0}px;background:${cor};border-radius:2px 2px 0 0;"></div>
      </div>
      <div style="border-top:1px solid #e5e7eb;width:100%;margin:2px 0 1px;"></div>
      <div style="font-size:9px;color:#6b7280;font-weight:600;">${d.v}</div>
    </div>`;
  }).join('');

  // Bloco 5 — linhas
  const _monitorarHTML = todosMonitorar.length
    ? todosMonitorar.map(({ r, crit }) => {
        const sistStr = r.sistemaSemana?.nome ? ` · ${r.sistemaSemana.nome}` : '';
        return `<div style="display:flex;align-items:center;gap:8px;padding:7px 10px;border:1px solid ${crit.bg};border-left:3px solid ${crit.cor};border-radius:0 6px 6px 0;margin-bottom:5px;background:${crit.bg}55;">
          ${_avatar(r.nome, crit.cor)}
          <div style="flex:1;min-width:0;">
            <div style="font-size:11px;font-weight:700;color:#1e293b;">${r.nome} <span style="font-weight:400;color:#9ca3af;">· ${_posAbrev(r.posicao)}${sistStr}</span></div>
            <div style="font-size:9px;color:#64748b;margin-top:1px;">${crit.motivo}</div>
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:3px;flex-shrink:0;">
            <span style="padding:2px 8px;border-radius:999px;font-size:9px;font-weight:700;background:${crit.bg};color:${crit.cor};border:1px solid ${crit.cor}44;">${crit.label}</span>
            ${r.global != null ? `<span style="font-size:11px;font-weight:800;color:${_corIGP(r.global)};">${Math.round(r.global)}</span>` : ''}
          </div>
        </div>`;
      }).join('')
    : `<div style="text-align:center;padding:20px;font-size:12px;color:#9ca3af;">Nenhum atleta sinalizado para monitoramento.</div>`;

  // ── HTML completo ─────────────────────────────────────────────────────────
  const _html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<title>Relatório do Dia · ${dataFmt}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box;}
  body{font-family:'Segoe UI',Arial,sans-serif;background:#f1f5f9;color:#1e293b;font-size:12px;}
  .pg{max-width:960px;margin:0 auto;padding:0 0 32px;}
  .blk{background:#fff;border-radius:8px;margin:8px;padding:14px 16px;box-shadow:0 1px 3px rgba(0,0,0,.06);}
  .blk-t{font-size:9px;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:.1em;margin-bottom:2px;}
  .blk-h{font-size:13px;font-weight:800;color:#1e293b;margin-bottom:11px;}
  .g2{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
  .pbt{position:fixed;bottom:20px;right:20px;background:#1e293b;color:#fff;border:none;padding:10px 20px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.25);z-index:999;}
  @media print{
    @page{size:A4 portrait;margin:4mm;}
    body{background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
    .pbt{display:none;}
    .pg{max-width:100%;padding:0;}
    .blk{margin:2px 3px;padding:6px 9px;box-shadow:none;border:1px solid #e5e7eb;border-radius:4px;}
    .blk-t{margin-bottom:1px;}
    .blk-h{font-size:11px;margin-bottom:5px;}
  }
</style>
</head>
<body>
<div class="pg">

  <!-- B1 HEADER -->
  <div style="background:#1e293b;border-radius:8px;margin:8px 8px 0;padding:14px 20px;">
    <div style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:12px;">
      <div style="display:flex;align-items:center;gap:12px;">
        ${CLUB_LOGO ? `<img src="${CLUB_LOGO}" style="width:44px;height:44px;object-fit:contain;flex-shrink:0;">` : ''}
        <div>
          <div style="font-size:18px;font-weight:900;color:#fff;">${nomeClube}${categoria?' · '+categoria:''}</div>
          <div style="font-size:11px;color:#94a3b8;margin-top:2px;text-transform:capitalize;">${dataFmt}</div>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;">
        ${mcLabel?`<span style="background:${mcCor};color:#fff;font-size:13px;font-weight:800;padding:6px 18px;border-radius:20px;">${mcLabel}</span>`:''}
        <div style="font-size:9px;color:#94a3b8;text-align:right;line-height:1.4;">DEPTO. DE INTELIGÊNCIA ESPORTIVA - CIENTE IE</div>
      </div>
    </div>
  </div>

  <!-- B2 SESSÃO + CARGA POR POSIÇÃO -->
  <div style="margin:0 8px;display:grid;grid-template-columns:1fr 1fr;gap:0;">
    <div class="blk" style="border-radius:0 0 0 8px;border-right:1px solid #f1f5f9;margin:0;padding:12px 14px;">
      <div class="blk-t">Sessão do dia</div>
      <div class="blk-h">Estrutura da sessão</div>
      ${_sessoesHTML}
      ${_afastadosMiniHTML}
    </div>
    <div class="blk" style="border-radius:0 0 8px 0;margin:0;padding:12px 14px;">
      <div class="blk-t">Carga e prontidão por posição</div>
      <div style="display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap;">
        <div style="flex:1;min-width:64px;background:#f8fafc;border-radius:6px;padding:7px 8px;text-align:center;border:1px solid #e5e7eb;">
          <div style="font-size:16px;font-weight:900;color:#1e293b;">${medianaGrupo!=null?medianaGrupo.toFixed(1):'—'}</div>
          <div style="font-size:8px;color:#9ca3af;font-weight:700;text-transform:uppercase;margin-top:1px;">PSE mediana</div>
        </div>
        <div style="flex:1;min-width:64px;background:#f8fafc;border-radius:6px;padding:7px 8px;text-align:center;border:1px solid #e5e7eb;">
          <div style="font-size:16px;font-weight:900;color:${_acwrCor(mediaACWR)};">${mediaACWR!=null?mediaACWR.toFixed(2):'—'}</div>
          <div style="font-size:8px;color:#9ca3af;font-weight:700;text-transform:uppercase;margin-top:1px;">ACWR grupo</div>
          <div style="font-size:8px;color:${_acwrCor(mediaACWR)};font-weight:700;">${_acwrLbl(mediaACWR)}</div>
        </div>
        <div style="flex:1;min-width:64px;background:#f8fafc;border-radius:6px;padding:7px 8px;text-align:center;border:1px solid #e5e7eb;">
          <div style="font-size:16px;font-weight:900;color:#1e293b;">${mediaQual!=null?mediaQual.toFixed(1):'—'}</div>
          <div style="font-size:8px;color:#9ca3af;font-weight:700;text-transform:uppercase;margin-top:1px;">Qualidade / 5</div>
          <div style="font-size:8px;font-weight:700;margin-top:1px;color:${mediaQual==null?'#9ca3af':mediaQual>=4.5?'#15803d':mediaQual>=3.5?'#16a34a':mediaQual>=2.5?'#a16207':mediaQual>=1.5?'#c2410c':'#b91c1c'};">${mediaQual==null?'':mediaQual>=4.5?'Excelente':mediaQual>=3.5?'Boa':mediaQual>=2.5?'Regular':mediaQual>=1.5?'Ruim':'Muito ruim'}</div>
        </div>
        <div style="flex:1;min-width:64px;background:#f8fafc;border-radius:6px;padding:7px 8px;text-align:center;border:1px solid #e5e7eb;">
          <div style="font-size:16px;font-weight:900;color:${pctCargaPDF==null?'#9ca3af':pctCargaPDF>=100?'#b91c1c':pctCargaPDF>=75?'#c2410c':pctCargaPDF>=50?'#a16207':'#1d4ed8'};">${pctCargaPDF!=null?pctCargaPDF+'%':'—'}</div>
          <div style="font-size:8px;color:#9ca3af;font-weight:700;text-transform:uppercase;margin-top:1px;">Carga / Jogo</div>
          <div style="font-size:8px;font-weight:700;margin-top:1px;color:${pctCargaPDF==null?'#9ca3af':pctCargaPDF>=100?'#b91c1c':pctCargaPDF>=75?'#c2410c':pctCargaPDF>=50?'#a16207':'#1d4ed8'};">${pctCargaPDF==null?'':pctCargaPDF>=100?'Igual/Acima':pctCargaPDF>=75?'Alta':pctCargaPDF>=50?'Moderada':'Baixa'}</div>
        </div>
      </div>
      <div style="margin-bottom:10px;background:#f8fafc;border:1px solid #e5e7eb;border-radius:6px;padding:7px 10px;">
        <div style="font-size:8px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.04em;margin-bottom:5px;">Legenda</div>
        <div style="font-size:8.5px;color:#475569;margin-bottom:3px;font-weight:600;">Barra — Carga (UA)</div>
        <div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:6px;">
          <span style="display:inline-flex;align-items:center;gap:3px;padding:2px 6px;border-radius:4px;background:#dbeafe;color:#1d4ed8;font-size:8px;font-weight:700;border:1px solid #93c5fd;">Regen &lt;300</span>
          <span style="display:inline-flex;align-items:center;gap:3px;padding:2px 6px;border-radius:4px;background:#dcfce7;color:#15803d;font-size:8px;font-weight:700;border:1px solid #86efac;">Mod 300–599</span>
          <span style="display:inline-flex;align-items:center;gap:3px;padding:2px 6px;border-radius:4px;background:#ffedd5;color:#c2410c;font-size:8px;font-weight:700;border:1px solid #fdba74;">Alta 600–799</span>
          <span style="display:inline-flex;align-items:center;gap:3px;padding:2px 6px;border-radius:4px;background:#fee2e2;color:#b91c1c;font-size:8px;font-weight:700;border:1px solid #fca5a5;">M.Alta ≥800</span>
        </div>
        <div style="font-size:8.5px;color:#475569;margin-bottom:3px;font-weight:600;">Número — IGP (Índice de Prontidão)</div>
        <div style="display:flex;gap:5px;flex-wrap:wrap;">
          <span style="display:inline-flex;align-items:center;gap:3px;padding:2px 6px;border-radius:4px;background:#dcfce7;color:#15803d;font-size:8px;font-weight:700;border:1px solid #86efac;">Estável ≥70</span>
          <span style="display:inline-flex;align-items:center;gap:3px;padding:2px 6px;border-radius:4px;background:#fef9c3;color:#a16207;font-size:8px;font-weight:700;border:1px solid #fde047;">At.Leve 60–69</span>
          <span style="display:inline-flex;align-items:center;gap:3px;padding:2px 6px;border-radius:4px;background:#ffedd5;color:#ea580c;font-size:8px;font-weight:700;border:1px solid #fdba74;">Atenção 50–59</span>
          <span style="display:inline-flex;align-items:center;gap:3px;padding:2px 6px;border-radius:4px;background:#fee2e2;color:#b91c1c;font-size:8px;font-weight:700;border:1px solid #fca5a5;">Crítico &lt;50</span>
        </div>
      </div>
      ${_posBarHTML||'<div style="font-size:11px;color:#d1d5db;text-align:center;padding:12px;">Sem dados de posição.</div>'}
      ${_cargaLineHTML}
    </div>
  </div>

  <!-- B3 RESPOSTA AO ESTÍMULO -->
  <div class="blk">
    <div class="blk-t">Resposta ao estímulo</div>
    <div class="blk-h">Desvio individual em relação ao grupo — Percepção de Esforço (PSE)</div>
    <div style="display:flex;align-items:center;gap:14px;background:#f8fafc;border-radius:6px;padding:8px 12px;margin-bottom:10px;border:1px solid #e5e7eb;flex-wrap:wrap;">
      <div>
        <div style="font-size:8px;color:#9ca3af;font-weight:700;text-transform:uppercase;margin-bottom:1px;">Referência do grupo</div>
        <div style="font-size:18px;font-weight:900;color:#1e293b;">${medianaGrupo!=null?medianaGrupo.toFixed(1):'—'} <span style="font-size:10px;font-weight:400;color:#9ca3af;">mediana</span></div>
        <div style="font-size:10px;color:#64748b;">Média: ${mediaGrupo!=null?mediaGrupo.toFixed(1):'—'} · ${presentes} atleta${presentes!==1?'s':''}</div>
      </div>
      <div style="flex:1;min-width:140px;">
        <div style="display:flex;align-items:flex-end;gap:2px;height:40px;">${_distHTML}</div>
      </div>
    </div>
    ${!medianaGrupo&&comPse.length===0
      ? `<div style="text-align:center;padding:20px;font-size:12px;color:#9ca3af;">Sem dados de PSE para esta data.</div>`
      : incomp.length+elev.length+bx.length===0
        ? `<div style="text-align:center;padding:20px;font-size:12px;color:#059669;background:#f0fdf4;border-radius:8px;border:1px solid #bbf7d0;">✓ Todos os atletas responderam dentro do esperado nesta sessão.</div>`
        : `${_secaoResposta('Resposta incompatível · delta > +2.5','#dc2626',incomp,'incomp')}
           ${_secaoResposta('Resposta elevada · delta +1.5 a +2.5','#f59e0b',elev,'elev')}
           ${_secaoResposta('Resposta baixa · delta < −1.5 · monitorar engajamento','#3b82f6',bx,'bx')}`
    }
  </div>

  <!-- B4 STATUS CLÍNICO -->
  <div class="blk">
    <div class="blk-t">Status clínico</div>
    <div class="blk-h">Ocorrências do dia</div>
    <div class="g2">
      <div>
        <div style="font-size:11px;font-weight:700;color:#92400e;margin-bottom:10px;display:flex;align-items:center;gap:6px;">
          <span style="width:8px;height:8px;border-radius:50%;background:#d97706;display:inline-block;"></span>
          Dor relatada · escala ≥ 5
        </div>
        ${comDor.length
          ? comDor.map(r=>_rowDor(r)).join('')
          : `<div style="font-size:11px;color:#9ca3af;background:#f9fafb;border-radius:8px;padding:16px;text-align:center;">Nenhum relato de dor significativa.</div>`}
        <div style="margin-top:12px;">
          <div style="font-size:11px;font-weight:700;color:#b91c1c;margin-bottom:10px;display:flex;align-items:center;gap:6px;">
            <span style="width:8px;height:8px;border-radius:50%;background:#dc2626;display:inline-block;"></span>
            Nível crítico em indicador
          </div>
          ${atletasCriticos.length
            ? atletasCriticos.map(r => `<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:#fff1f2;border:1px solid #fecaca;border-radius:6px;margin-bottom:5px;">
                ${_avatar(r.nome,'#b91c1c')}
                <div style="flex:1;min-width:0;">
                  <div style="font-size:11px;font-weight:700;color:#1e293b;">${r.nome}</div>
                  <div style="font-size:9px;color:#991b1b;">${_posAbrev(r.posicao)} · ${r.alertas.join(' · ')}</div>
                </div>
              </div>`).join('')
            : `<div style="font-size:11px;color:#9ca3af;background:#f9fafb;border-radius:8px;padding:16px;text-align:center;">Nenhum indicador crítico.</div>`}
        </div>
      </div>
      <div>
        <div style="font-size:11px;font-weight:700;color:#5b21b6;margin-bottom:10px;display:flex;align-items:center;gap:6px;">
          <span style="width:8px;height:8px;border-radius:50%;background:#7c3aed;display:inline-block;"></span>
          Atendimento DM · hoje
        </div>
        ${atendInfos.length
          ? atendInfos.map(a=>_rowAtend(a)).join('')
          : `<div style="font-size:11px;color:#9ca3af;background:#f9fafb;border-radius:8px;padding:16px;text-align:center;">Sem atendimentos registrados.</div>`}
      </div>
    </div>
  </div>

  <!-- B5 MONITORAR AMANHÃ -->
  <div class="blk">
    <div class="blk-t">Atenção redobrada</div>
    <div class="blk-h">Monitorar amanhã</div>
    ${_monitorarHTML}
  </div>


  <!-- rodapé -->
  <div style="margin:0 8px;padding:6px 4px;font-size:8px;color:#94a3b8;border-top:1px solid #e2e8f0;">
    Gerado em ${new Date().toLocaleString('pt-BR')} · Ciente IE · Relatório automatizado — análise complementa avaliação profissional
  </div>

</div>
<button class="pbt" onclick="window.print()">Imprimir / Salvar PDF</button>
<script>
(function(){
  var pg;
  window.addEventListener('beforeprint', function(){
    pg = document.querySelector('.pg');
    if(!pg) return;
    var pageH = (297 - 8) * 3.7795;
    var ratio = pageH / pg.scrollHeight;
    if(ratio < 1) document.documentElement.style.zoom = ratio;
  });
  window.addEventListener('afterprint', function(){
    document.documentElement.style.zoom = '';
  });
})();
</script>
</body>
</html>`;

  const _w = window.open('', '_blank', 'width=1060,height=920');
  if (!_w) { alert('Permita pop-ups no navegador para gerar o relatório.'); return; }
  _w.document.write(_html);
  _w.document.close();
}

// ── BLOCO REMOVIDO: abrirModalRelatorioDiario / exportarPDFDisponibilidade ──
// Substituído por abrirModalConfirmacaoPDF + exportarPDFDiario
function abrirModalRelatorioDiario() {
  const data    = document.getElementById("filtroData")?.value || hoje;
  const dataFmt = data.split("-").reverse().join("/");

  const ordemPos = ["Goleiro","Lateral","Zagueiro","Volante","Meia","Ponta","Centro-Avante","Centro-avante","Atacante"];
  const posIdx   = p => { const i = ordemPos.findIndex(x => x.toLowerCase() === (p||"").toLowerCase()); return i === -1 ? 99 : i; };
  const ordemSt  = { "Protecao":0,"Afastado":0,"Uso reduzido":1,"Transicao":2,"Monitorado":3,"Liberado":4,"Sem dados":5 };

  const rows = atletas.map(a => {
    const dm   = daily.find(d => d.athleteId === a.id);
    const calc = calcularProntidao(dm, calcularBasalAtleta(a.id));
    const ispTend = calcularISPTendencia(a.id);
    const zG   = zScoreGlobal(a.id);
    const rec  = calcularMinutosRecomendados(a.id);

    const tend    = zG == null ? "—" : zG >= 0.5 ? "↑" : zG <= -0.5 ? "↓" : "→";
    const tendCor = zG == null ? "#9ca3af" : zG >= 0.5 ? "#15803d" : zG <= -0.5 ? "#b91c1c" : "#92400e";

    // Mensagem contextual:
    // - só para atletas que jogam (minutos > 0)
    // - Liberado recebe alerta apenas se houver sistema comprometido (Atenção Leve ou pior)
    const _podeJogar = rec.minutos != null && rec.minutos > 0;
    const _precisaAlerta = rec.classificacao === "Monitorado"
      || rec.classificacao === "Uso reduzido"
      || rec.classificacao === "Transicao"
      || (rec.classificacao === "Liberado" && calc.maisPrejudicado != null);
    const sist  = (_podeJogar && _precisaAlerta) ? calc.maisPrejudicado : null;
    const sistV = sist ? (sist.nome === "Neuromuscular" ? calc.INM
                        : sist.nome === "Autonômico"    ? calc.IA
                        : sist.nome === "Cognitivo"     ? calc.IC
                        : calc.IH) : null;
    const mensagem = gerarMensagemSistema(sist?.nome, sistV, tend);

    const statusMed = statusMedicoAtleta(a.id);
    const faseRTP   = calcularFaseRTP(statusMed, calc, rtpProgressMap[a.id] ?? 0);

    return {
      nome: a.nome, posicao: a.posicao || "—",
      global: calc.global, ispTend, tend, tendCor,
      classificacao: rec.classificacao, faixa: rec.faixa, minutos: rec.minutos, obs: rec.obs, cor: rec.cor,
      sistemaNome: sist?.nome ?? null, mensagem,
      statusMed, faseRTP,
    };
  }).sort((a,b) => {
    // 1. Afastados → Transição → Liberados
    const medPrio = s => s === "afastado" ? 0 : s === "transicao" ? 1 : 2;
    const mA = medPrio(a.statusMed ?? "liberado");
    const mB = medPrio(b.statusMed ?? "liberado");
    if (mA !== mB) return mA - mB;
    // 2. Dentro de transição: fase RTP crescente (F0 → F1 → F2 → F3 → F4)
    const fA = a.faseRTP?.fase ?? 99;
    const fB = b.faseRTP?.fase ?? 99;
    if (fA !== fB) return fA - fB;
    // 3. Dentro da mesma fase (ou liberados): minutos sugeridos crescente
    const minsA = a.minutos ?? 999;
    const minsB = b.minutos ?? 999;
    if (minsA !== minsB) return minsA - minsB;
    // 4. Desempate por classificação (mais restritivo primeiro)
    const ordClas = { "Protecao":0,"Uso reduzido":1,"Transicao":2,"Monitorado":3,"Normal c/ atenção":4,"Normal":5,"Liberado":6,"Sem dados":7 };
    const cA = ordClas[a.classificacao] ?? 7;
    const cB = ordClas[b.classificacao] ?? 7;
    if (cA !== cB) return cA - cB;
    // 5. Nome
    return a.nome.localeCompare(b.nome,"pt-BR");
  });

  const corVal = v => v == null ? "#9ca3af" : v >= 70 ? "#15803d" : v >= 60 ? "#a16207" : v >= 50 ? "#ea580c" : "#b91c1c";
  const fmtV   = v => v == null ? "—" : v.toFixed(1);

  const corSist = { "Subjetivo":"#ea580c","Autonômico":"#2563eb","Neuromuscular":"#7c3aed","Cognitivo":"#0d9488" };

  const temRTPmodal = rows.some(r => r.faseRTP != null);

  const linhas = rows.map((r,i) => `
    <tr style="background:${i%2===0?"#fff":"#f9fafb"};">
      <td style="padding:8px 10px;font-weight:700;font-size:12px;white-space:nowrap;">${r.nome}</td>
      <td style="padding:8px 6px;font-size:11px;color:#64748b;text-align:center;">${r.posicao}</td>
      <td style="padding:8px 6px;text-align:center;font-weight:800;font-size:13px;color:${corVal(r.global)};">${fmtV(r.global)}</td>
      <td style="padding:8px 6px;text-align:center;">
        ${ (() => { const t = r.ispTend?.global; return t
          ? `<span style="background:${t.bg};color:${t.cor};font-size:10px;font-weight:800;padding:2px 8px;border-radius:6px;">${t.icon} ${t.label}</span>`
          : '<span style="color:#94a3b8;font-size:10px;">—</span>'; })() }
      </td>
      <td style="padding:8px 6px;text-align:center;font-size:14px;font-weight:900;color:${r.tendCor};">${r.tend}</td>
      <td style="padding:8px 6px;text-align:center;">
        <span style="background:${r.cor}22;color:${r.cor};font-size:10px;font-weight:800;padding:3px 10px;border-radius:999px;white-space:nowrap;">${r.classificacao}</span>
      </td>
      <td style="padding:8px 6px;text-align:center;font-weight:800;font-size:12px;color:${r.cor};">${r.faseRTP != null && r.faseRTP.fase <= 1 ? '—' : r.faixa}</td>
      ${temRTPmodal ? `<td style="padding:8px 6px;text-align:center;">
        ${r.faseRTP
          ? `<span style="display:inline-block;padding:2px 8px;border-radius:999px;font-size:10px;font-weight:800;background:${r.faseRTP.bg};color:${r.faseRTP.cor};">F${r.faseRTP.fase} · ${r.faseRTP.label}</span>`
          : '<span style="color:#d1d5db;font-size:10px;">—</span>'}
      </td>` : ''}
      <td style="padding:8px 10px;font-size:10px;color:#64748b;">
        ${r.mensagem
          ? `<span style="color:${corSist[r.sistemaNome]||"#64748b"};font-weight:600;">⚠ ${r.mensagem}</span>`
          : `<span style="color:#d1d5db;">—</span>`}
      </td>
    </tr>`).join("");

  const modalHtml = `
    <div id="modalRelatorioDiario" style="position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;overflow-y:auto;padding:20px;display:flex;align-items:flex-start;justify-content:center;">
      <div style="background:#fff;border-radius:14px;max-width:1050px;width:100%;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.3);margin:auto;">
        <div style="background:#1e293b;color:#fff;padding:18px 24px;display:flex;align-items:center;justify-content:space-between;">
          <div>
            <div style="font-size:10px;letter-spacing:.1em;opacity:.6;text-transform:uppercase;margin-bottom:3px;">Relatorio Diario · Ciente IE</div>
            <div style="font-size:18px;font-weight:900;">Disponibilidade do Elenco</div>
            <div style="font-size:12px;opacity:.65;margin-top:2px;">${dataFmt}</div>
          </div>
          <div style="display:flex;gap:10px;align-items:center;">
            <button id="btnExportarPDFModal" style="background:#6366f1;color:#fff;border:none;padding:8px 18px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;">⬇ Exportar PDF</button>
            <button onclick="document.getElementById('modalRelatorioDiario').remove()" style="background:rgba(255,255,255,.15);color:#fff;border:none;width:32px;height:32px;border-radius:8px;font-size:18px;cursor:pointer;">✕</button>
          </div>
        </div>
        <div style="padding:10px 24px;background:#f8fafc;border-bottom:1px solid #e5e7eb;display:flex;flex-wrap:wrap;gap:10px;font-size:10px;">
          <span style="color:#15803d;font-weight:700;">🟢 Liberado — joga normal · IGP ≥70 sem crítico</span>
          <span style="color:#a16207;font-weight:700;">🟡 Monitorado — joga normal · acompanhar</span>
          <span style="color:#b91c1c;font-weight:700;">🔴 Uso reduzido — IGP &lt;50 ou sistema &lt;40</span>
          <span style="color:#c2410c;font-weight:700;">⚠ Transicao · teto 45–60 min</span>
          <span style="color:#94a3b8;">ISP TEND.: tendência de adaptação nas últimas 4 semanas</span>
        </div>
        <div style="overflow-x:auto;padding:16px 24px;">
          <table style="width:100%;border-collapse:collapse;font-family:Segoe UI,Arial,sans-serif;">
            <thead>
              <tr style="background:#1e293b;color:#fff;font-size:10px;">
                <th style="padding:9px 10px;text-align:left;">ATLETA</th>
                <th style="padding:9px 6px;text-align:center;">POS.</th>
                <th style="padding:9px 6px;text-align:center;">PRONTIDAO<br><span style="font-weight:400;opacity:.7;">hoje</span></th>
                <th style="padding:9px 6px;text-align:center;">ISP TEND.<br><span style="font-weight:400;opacity:.7;">tendência</span></th>
                <th style="padding:9px 6px;text-align:center;">TEND.</th>
                <th style="padding:9px 6px;text-align:center;">CLASSIFICACAO</th>
                <th style="padding:9px 6px;text-align:center;">USO<br><span style="font-weight:400;opacity:.7;">orientação</span></th>
                ${temRTPmodal ? '<th style="padding:9px 6px;text-align:center;">RTP<br><span style=\'font-weight:400;opacity:.7;\'>fase</span></th>' : ''}
                <th style="padding:9px 10px;text-align:left;">ALERTA DO DIA</th>
              </tr>
            </thead>
            <tbody>${linhas}</tbody>
          </table>
        </div>
        <div style="padding:10px 24px 16px;font-size:9px;color:#94a3b8;border-top:1px solid #f1f5f9;">
          Gerado em ${new Date().toLocaleString("pt-BR")} · Ciente IE · ISP Tendência: regressão ponderada 4 semanas, normalizada por DP individual
        </div>
      </div>
    </div>`;

  document.body.insertAdjacentHTML("beforeend", modalHtml);
  document.getElementById("modalRelatorioDiario").addEventListener("click", function(e){
    if (e.target === this) this.remove();
  });
  document.getElementById("btnExportarPDFModal").addEventListener("click", () => exportarPDFDisponibilidade(rows, dataFmt, data));
}

async function exportarPDFDisponibilidade(rows, dataFmt, data) {
  const btn = document.getElementById("btnExportarPDFModal");
  btn.disabled = true; btn.textContent = "Gerando...";
  try {
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ orientation:"portrait", unit:"mm", format:"a4" });
    const mX = 14, pW = 210, pH = 297;

    pdf.setFillColor(30,41,59);
    pdf.rect(0,0,pW,28,"F");
    pdf.setFont("helvetica","normal"); pdf.setFontSize(8); pdf.setTextColor(148,163,184);
    pdf.text(CLUB_NAME||"Clube", mX, 14);
    pdf.setFont("helvetica","bold"); pdf.setFontSize(15); pdf.setTextColor(255,255,255);
    pdf.text("Disponibilidade do Elenco", mX, 22);
    pdf.setFont("helvetica","normal"); pdf.setFontSize(9); pdf.setTextColor(148,163,184);
    pdf.text(dataFmt, pW - mX, 22, { align:"right" });

    let y = 34;
    pdf.setFontSize(7); pdf.setTextColor(100,116,139);
    pdf.text("IGP = Indice Global de Prontidao  |  Liberado: IGP>=70 sem critico  ·  Monitorado: joga normal, acompanhar  ·  Uso reduzido: IGP<50 ou sistema<40  ·  * ISP<3 dias", mX, y);
    y += 7;

    const wL  = pW - mX*2;
    const temRTPpdf = rows.some(r => r.faseRTP != null);
    const cW  = temRTPpdf
      ? { nome:0.25, pos:0.07, pront:0.09, isp:0.08, tend:0.06, clas:0.16, min:0.10, rtp:0.09, obs:0.10 }
      : { nome:0.25, pos:0.07, pront:0.09, isp:0.08, tend:0.06, clas:0.16, min:0.11, obs:0.18 };
    const cWv = k => wL * cW[k];
    const heads = temRTPpdf
      ? ["ATLETA","POS.","PRONT.","ISP","TEND.","CLASSIFICACAO","MINUTOS","RTP","ALERTA DO DIA"]
      : ["ATLETA","POS.","PRONT.","ISP","TEND.","CLASSIFICACAO","MINUTOS","ALERTA DO DIA"];

    const desenharCabTab = (yy) => {
      pdf.setFillColor(30,41,59); pdf.rect(mX,yy,wL,6,"F");
      pdf.setFont("helvetica","bold"); pdf.setFontSize(6.5); pdf.setTextColor(255,255,255);
      let cx = mX;
      Object.keys(cW).forEach((k,i) => { pdf.text(heads[i], cx+2, yy+4.2); cx += cWv(k); });
      return yy + 6;
    };
    y = desenharCabTab(y);

    const hexRGB = hex => { const n = parseInt(hex.replace("#",""),16); return [n>>16,(n>>8)&255,n&255]; };
    const cvRGB  = v => v == null ? [156,163,175] : v >= 70 ? [21,128,61] : v >= 60 ? [161,98,7] : v >= 50 ? [194,65,12] : [185,28,28];

    rows.forEach((r, i) => {
      const rowH = 8;
      if (y + rowH > pH - 14) {
        pdf.addPage([pW,pH]); y = 14;
        y = desenharCabTab(y);
      }
      pdf.setFillColor(...(i%2===0?[249,250,251]:[255,255,255]));
      pdf.rect(mX,y,wL,rowH,"F");
      pdf.setDrawColor(229,231,235); pdf.setLineWidth(0.2);
      pdf.line(mX,y+rowH,mX+wL,y+rowH);

      const cy = y + 5.5; let cx = mX;

      pdf.setFont("helvetica","bold"); pdf.setFontSize(8); pdf.setTextColor(17,24,39);
      pdf.text(pdf.splitTextToSize(r.nome, cWv("nome")-3)[0], cx+2, cy); cx += cWv("nome");

      pdf.setFont("helvetica","normal"); pdf.setFontSize(7); pdf.setTextColor(100,116,139);
      pdf.text(r.posicao, cx+2, cy); cx += cWv("pos");

      pdf.setFont("helvetica","bold"); pdf.setFontSize(8.5); pdf.setTextColor(...cvRGB(r.global));
      pdf.text(r.global != null ? r.global.toFixed(1) : "—", cx+2, cy); cx += cWv("pront");

      const _tIsp = r.ispTend?.global;
      const ispRGB = !_tIsp ? [156,163,175] : _tIsp.label === 'Melhorando' ? [21,128,61] : _tIsp.label === 'Estável' ? [180,83,9] : [185,28,28];
      pdf.setFont("helvetica","bold"); pdf.setFontSize(7); pdf.setTextColor(...ispRGB);
      const ispTxt = _tIsp ? (_tIsp.icon + ' ' + _tIsp.label) : "—";
      pdf.text(ispTxt, cx+2, cy); cx += cWv("isp");

      pdf.setFont("helvetica","bold"); pdf.setFontSize(10); pdf.setTextColor(...hexRGB(r.tendCor));
      pdf.text(r.tend === "↑" ? "^" : r.tend === "↓" ? "v" : "-", cx+3, cy); cx += cWv("tend");

      const [cr,cg,cb] = hexRGB(r.cor);
      pdf.setFillColor(cr,cg,cb);
      pdf.roundedRect(cx+1,y+1.5,cWv("clas")-3,rowH-3,2,2,"F");
      pdf.setFont("helvetica","bold"); pdf.setFontSize(6.5); pdf.setTextColor(255,255,255);
      pdf.text(r.classificacao, cx+3, cy); cx += cWv("clas");

      pdf.setFont("helvetica","bold"); pdf.setFontSize(8); pdf.setTextColor(...hexRGB(r.cor));
      const faixaDisplayPDF = r.faseRTP != null && r.faseRTP.fase <= 1 ? "\u2014" : r.faixa;
      pdf.text(faixaDisplayPDF, cx+2, cy); cx += cWv("min");

      // RTP — só se houver atletas com fase RTP neste relatório
      if (temRTPpdf) {
        if (r.faseRTP) {
          pdf.setFillColor(...hexRGB(r.faseRTP.bg));
          const rtpLabelPDF = `F${r.faseRTP.fase} \u00b7 ${r.faseRTP.label}`;
          const rtpWpdf = Math.min(pdf.getTextWidth(rtpLabelPDF) + 4, cWv("rtp") - 2);
          pdf.roundedRect(cx + 1, y + 1.5, rtpWpdf, rowH - 3, 1.5, 1.5, "F");
          pdf.setFont("helvetica","bold"); pdf.setFontSize(6.5);
          pdf.setTextColor(...hexRGB(r.faseRTP.cor));
          pdf.text(rtpLabelPDF, cx + 3, cy);
        } else {
          pdf.setFont("helvetica","normal"); pdf.setFontSize(6.5); pdf.setTextColor(156,163,175);
          pdf.text("—", cx + 2, cy);
        }
        cx += cWv("rtp");
      }

      if (r.mensagem) {
        const corSistPDF = { "Subjetivo":[234,88,12],"Autonômico":[37,99,235],"Neuromuscular":[124,58,237],"Cognitivo":[13,148,136] };
        pdf.setFont("helvetica","bold"); pdf.setFontSize(6.5);
        pdf.setTextColor(...(corSistPDF[r.sistemaNome] || [100,116,139]));
        pdf.text(pdf.splitTextToSize("! " + r.mensagem, cWv("obs")-3)[0], cx+2, cy);
      } else {
        pdf.setFont("helvetica","normal"); pdf.setFontSize(6.5); pdf.setTextColor(156,163,175);
        pdf.text("—", cx+2, cy);
      }

      y += rowH;
    });

    // ── Legenda RTP (se houver atletas com fase RTP) ─────────────────────────
    if (temRTPpdf) {
      const legY = pH - 20;
      pdf.setFillColor(240, 249, 255);
      pdf.setDrawColor(186, 230, 253);
      pdf.setLineWidth(0.3);
      pdf.roundedRect(mX, legY, wL, 10, 1.5, 1.5, "FD");
      pdf.setFont("helvetica","bold"); pdf.setFontSize(6.5); pdf.setTextColor(3,105,161);
      pdf.text("RTP:", mX + 3, legY + 4.5);
      pdf.setFont("helvetica","normal"); pdf.setFontSize(6.5); pdf.setTextColor(30,64,175);
      pdf.text(
        "F0 Afastado / Repouso  ·  F1 Recondicionamento  ·  F2 Treino Adaptado  ·  F3 Treino Coletivo  ·  F4 Apto para jogo",
        mX + 18, legY + 4.5
      );
      pdf.setFont("helvetica","normal"); pdf.setFontSize(6); pdf.setTextColor(100,116,139);
      pdf.text(
        "F4 = global ≥65 e todos ≥50  |  F3 = subjetivo e neuromuscular ≥60, autonômico ≥50  |  F2 = subjetivo ≥60, neuromuscular ≥50  |  F1 = subjetivo ≥50",
        mX + 3, legY + 9
      );
    }

    pdf.setFont("helvetica","normal"); pdf.setFontSize(7.5); pdf.setTextColor(148,163,184);
    pdf.text("Gerado em " + new Date().toLocaleString("pt-BR") + " · Ciente IE", mX, pH - (temRTPpdf ? 3 : 5));

    pdf.save("Disponibilidade_" + data + ".pdf");
    if (new URLSearchParams(window.location.search).get('from') === 'relatorios') setTimeout(() => { window.location.href = '/staff/relatorios.html'; }, 800);
  } catch(err){ console.error(err); alert("Erro ao gerar PDF."); }
  finally { if(btn){ btn.disabled=false; btn.textContent="⬇ Exportar PDF"; } }
}

// ================= MODAL PÓS-JOGO =================
async function abrirModalPosJogo(){
  const btn = document.getElementById("btnPosJogo");
  btn.disabled = true;
  btn.textContent = "Buscando...";
  try {
    await carregarUltimaPartida();
    if(!ultimaPartidaMeta){
      alert("Nenhuma partida encontrada no scout.");
      return;
    }
    aplicarFiltros(); // atualiza botão e coluna na tabela principal
    renderModalPosJogo();
  } finally {
    btn.disabled = false;
    btn.textContent = "⚽ Relatório Pós-Jogo";
  }
}

// ── Funções de classificação — Resposta Competitiva ──────────────────────────
// Comparação por CATEGORIA, não por delta bruto.
// IP parte de 50 (neutro) enquanto ISP pode ser 60–80 → delta direto penalizaria
// atletas com jogos normais. Comparar zonas evita esse viés estrutural.
// Zonas: Alto ≥70 (3) · Regular 50–69 (2) · Limitado 35–49 (1) · Insuficiente <35 (0)
function _classResposta(isp, ip) {
  if (isp == null || ip == null) return { label: 'Sem dados', cor: '#94a3b8', bg: '#f1f5f9' };
  function cat(v) {
    if (v >= 70) return 3;
    if (v >= 50) return 2;
    if (v >= 35) return 1;
    return 0;
  }
  const diff = cat(ip) - cat(isp);
  if (diff >= 1)  return { label: 'Acima da condição pré-jogo',     cor: '#15803d', bg: '#dcfce7' };
  if (diff >= -1) return { label: 'Dentro da condição pré-jogo',    cor: '#1d4ed8', bg: '#dbeafe' };
  if (diff >= -2) return { label: 'Abaixo da condição pré-jogo',    cor: '#c2410c', bg: '#ffedd5' };
  return              { label: 'Bem abaixo da condição pré-jogo',   cor: '#b91c1c', bg: '#fee2e2' };
}

// Matriz: Resposta ao jogo × Estado atual → Direcionamento operacional + D+1/D+2
function _direcionamentoPosJogo(respostaLabel, status) {
  const estadoRuim = status === 'Atenção' || status === 'Crítico';

  if (respostaLabel === 'Bem abaixo da condição pré-jogo') {
    if (estadoRuim) return {
      nivel: 'critico', rotulo: 'Recuperação prioritária',
      texto: 'Desempenho bem abaixo da condição pré-jogo, associado a estado atual comprometido. Necessita recuperação prioritária e controle de carga.',
      cor: '#b91c1c', bg: '#fee2e2',
      d1: 'Recuperação ativa', d2: 'Progressão condicionada'
    };
    return {
      nivel: 'critico', rotulo: 'Controle de entrada',
      texto: 'Desempenho bem abaixo da condição pré-jogo, com impacto relevante do jogo. Entrada com controle e progressão condicionada.',
      cor: '#b91c1c', bg: '#fee2e2',
      d1: 'Controle de carga', d2: 'Progressão controlada'
    };
  }
  if (respostaLabel === 'Abaixo da condição pré-jogo') {
    if (estadoRuim) return {
      nivel: 'atencao', rotulo: 'Priorizar recuperação',
      texto: 'Desempenho abaixo da condição pré-jogo, associado a baixa prontidão atual. Priorizar recuperação e controle na entrada do ciclo.',
      cor: '#c2410c', bg: '#ffedd5',
      d1: 'Recuperação ativa', d2: 'Progressão controlada'
    };
    return {
      nivel: 'atencao', rotulo: 'Controle inicial',
      texto: 'Desempenho abaixo da condição pré-jogo, porém com boa prontidão atual. Pode evoluir com controle inicial.',
      cor: '#a16207', bg: '#fef9c3',
      d1: 'Controle inicial', d2: 'Fluxo controlado'
    };
  }
  if (respostaLabel === 'Dentro da condição pré-jogo') {
    if (estadoRuim) return {
      nivel: 'atencao', rotulo: 'Requer ajuste',
      texto: 'Desempenho dentro da condição pré-jogo, porém com baixa prontidão atual. Requer ajuste na entrada do ciclo.',
      cor: '#a16207', bg: '#fef9c3',
      d1: 'Ajuste de entrada', d2: 'Progressão controlada'
    };
    return {
      nivel: 'ok', rotulo: 'Fluxo normal',
      texto: 'Desempenho dentro da condição pré-jogo e boa prontidão atual. Segue fluxo normal de treino.',
      cor: '#1d4ed8', bg: '#dbeafe',
      d1: 'Fluxo normal', d2: 'Fluxo normal'
    };
  }
  if (respostaLabel === 'Acima da condição pré-jogo') {
    if (estadoRuim) return {
      nivel: 'atencao', rotulo: 'Priorizar recuperação',
      texto: 'Desempenho acima da condição pré-jogo, com alta exigência competitiva e queda na prontidão atual. Priorizar recuperação.',
      cor: '#c2410c', bg: '#ffedd5',
      d1: 'Recuperação ativa', d2: 'Progressão condicionada'
    };
    return {
      nivel: 'bom', rotulo: 'Apto para desenvolvimento',
      texto: 'Desempenho acima da condição pré-jogo e boa prontidão atual. Atleta apto para desenvolvimento.',
      cor: '#15803d', bg: '#dcfce7',
      d1: 'Desenvolvimento', d2: 'Desenvolvimento'
    };
  }
  return {
    nivel: 'nd', rotulo: 'Sem dados',
    texto: 'ISP ou IP não disponível — direcionamento não calculado.',
    cor: '#94a3b8', bg: '#f1f5f9',
    d1: '—', d2: '—'
  };
}

function _corDirecao(label) {
  if (label.includes('prioritária') || label.includes('condicionada') || label.includes('somente'))
    return { cor: '#b91c1c', bg: '#fee2e2' };
  if (label.includes('rotina') || label.includes('controlada') || label.includes('Ajuste'))
    return { cor: '#c2410c', bg: '#ffedd5' };
  if (label.includes('Fluxo normal') || label.includes('Compensação'))
    return { cor: '#1d4ed8', bg: '#dbeafe' };
  return { cor: '#15803d', bg: '#dcfce7' };
}

function renderModalPosJogo(){
  // Remove modal anterior se existir
  document.getElementById("modalPosJogo")?.remove();

  const dataSelecionada = document.getElementById("filtroData")?.value || hoje;

  // Monta dados de cada atleta
  const dadosAtletas = atletas.map(a => {
    const seg = minutosByAthleta[a.id] ?? null;
    const minJogados = seg != null ? Math.round(seg / 60) : null;

    // Último registro de daily_metrics disponível (preferência: data selecionada, senão mais recente)
    const dmsAtleta = historico
      .filter(d => d.athleteId === a.id)
      .sort((x,y) => new Date(y.date) - new Date(x.date));
    const dmDia = dmsAtleta.find(d => d.date === dataSelecionada) || dmsAtleta[0] || null;
    const dataRegistro = dmDia?.date || null;

    // Subcomponentes Hooper
    const hooperRaw = dmDia?.pre?.hooper ?? null;
    const sono    = dmDia?.pre?.sono    ?? null;
    const fadiga  = dmDia?.pre?.fadiga  ?? null;
    const estresse= dmDia?.pre?.estresse?? null;
    const dor     = dmDia?.pre?.dor     ?? null;
    const regioes_dor      = dmDia?.pre?.regioes_dor      ?? [];
    const sem_dor_localizada = dmDia?.pre?.sem_dor_localizada ?? false;

    const calc = calcularProntidao(dmDia, calcularBasalAtleta(a.id));

    // Minutos previstos + ISP de jogo: usa dados de prontidão do dia da partida
    const dataJogo = ultimaPartidaMeta?.data;
    const dmsJogo = dataJogo
      ? historico.filter(d => d.athleteId === a.id && d.date === dataJogo)
          .sort((x,y) => new Date(y.date) - new Date(x.date))
      : [];
    const dmJogo = dmsJogo[0] ?? null;
    const recJogo = calcularMinutosRecomendadosComDm(a.id, dmJogo, dataJogo);
    const _ispJogo = calcularISPParaData(a.id, dataJogo);

    return {
      id: a.id,
      nome: a.nome,
      posicao: a.posicao || "—",
      minJogados,
      seg,
      dataRegistro,
      sono, fadiga, estresse, dor, regioes_dor, sem_dor_localizada,
      hooperScore: hooperRaw != null ? calcularHooperScore(hooperRaw) : null,
      inMuscular:  calc.inMuscular,
      inAutonomico:calc.inAutonomico,
      inCognitivo: calc.inCognitivo,
      IH: calc.IH, IA: calc.IA, INM: calc.INM, IC: calc.IC,
      maisPrejudicado: calc.maisPrejudicado,
      global:      calc.global,
      status:      calc.status,
      faixaPrevista: recJogo.faixa,
      corPrevista:   recJogo.cor,
      ispJogo:       _ispJogo?.valor ?? null,
      ispJogoBaixaConf: _ispJogo?.baixaConfiabilidade ?? false,
      ip: perfByAthleta[a.id] ?? null,
    };
  }).map(a => {
    // Resposta competitiva + direcionamento integrado
    const respostaComp = _classResposta(a.ispJogo, a.ip);
    const statusMed    = statusMedicoAtleta(a.id);
    let direcionamento = _direcionamentoPosJogo(respostaComp.label, a.status);

    // Atletas afastados ou em transição não seguem fluxo normal de D+1/D+2
    if (statusMed === 'afastado') {
      direcionamento = {
        nivel: 'critico',
        rotulo: 'Afastado — Protocolo médico',
        texto: 'Atleta afastado por lesão. Não segue fluxo de treino. Reabilitação conduzida exclusivamente pelo departamento médico.',
        cor: '#b91c1c', bg: '#fee2e2',
        d1: 'Reabilitação', d2: 'Reabilitação'
      };
    } else if (statusMed === 'transicao') {
      direcionamento = {
        nivel: 'atencao',
        rotulo: 'Transição — Retorno gradual',
        texto: 'Atleta em fase de transição (retorno de lesão). Carga e exposição limitadas conforme protocolo de retorno ao jogo. Não segue fluxo normal do grupo.',
        cor: '#c2410c', bg: '#ffedd5',
        d1: 'Trabalho individualizado', d2: 'Progressão supervisionada'
      };
    }

    return { ...a, statusMed, respostaComp, direcionamento };
  });

  // Apenas atletas que entraram em campo
  const grupo60mais  = dadosAtletas.filter(a => a.minJogados != null && a.minJogados >= 60).sort((a,b) => (b.seg??0)-(a.seg??0));
  const grupo60menos = dadosAtletas.filter(a => a.minJogados != null && a.minJogados > 0 && a.minJogados < 60).sort((a,b) => (b.seg??0)-(a.seg??0));

  const meta = ultimaPartidaMeta;
  const pl = meta.placar;
  const placarStr = pl ? `${pl.pro}–${pl.contra}` : "—";
  const resultadoStr = pl
    ? (pl.pro > pl.contra ? "Vitória" : pl.pro === pl.contra ? "Empate" : "Derrota")
    : "";
  const corResultado = pl
    ? (pl.pro > pl.contra ? "#15803d" : pl.pro === pl.contra ? "#a16207" : "#b91c1c")
    : "#64748b";

  function corVal(v){
    if(v == null) return "#94a3b8";
    if(v >= 70)  return "#15803d";
    if(v >= 60)  return "#a16207";
    if(v >= 50)  return "#ea580c";
    return "#b91c1c";
  }
  // CMJ: ≥60 Estável · 50–59 Atenção Leve · 40–49 Atenção · <40 Crítico
  function corCMJ(v){
    if(v == null) return "#94a3b8";
    if(v >= 60)  return "#15803d";
    if(v >= 50)  return "#a16207";
    if(v >= 40)  return "#ea580c";
    return "#b91c1c";
  }
  function fmtVal(v){ return v != null ? v.toFixed(0) : "—"; }
  function fmtHooper(v, label){
    // Hooper subitem: 1=ótimo → 7=péssimo
    if(v == null) return `<span style="color:#94a3b8;">—</span>`;
    const cor = v <= 2 ? "#15803d" : v <= 4 ? "#a16207" : "#b91c1c";
    return `<span style="color:${cor};font-weight:700;">${v}</span>`;
  }

  function fmtDor(v){
    // Dor: 1–3 sem cor (neutro), 4–5 amarelo, 6–7 vermelho
    if(v == null) return `<span style="color:#94a3b8;">—</span>`;
    if(v <= 3) return `<span style="color:#374151;font-weight:700;">${v}</span>`;
    const cor = v <= 5 ? "#a16207" : "#b91c1c";
    return `<span style="color:${cor};font-weight:700;">${v}</span>`;
  }

  function linhaAtleta(a){
    const corMin = a.minJogados != null
      ? (a.minJogados >= 60 ? "#15803d" : "#a16207")
      : "#94a3b8";
    const minStr = a.minJogados != null ? `${a.minJogados}′` : "—";
    const dataStr = a.dataRegistro ? a.dataRegistro.slice(5).split("-").reverse().join("/") : "—";
    const corSistema = { "Subjetivo":"#ea580c","Autonômico":"#2563eb","Neuromuscular":"#7c3aed","Cognitivo":"#0d9488" };
    const bgSistema  = { "Subjetivo":"#fff7ed","Autonômico":"#eff6ff","Neuromuscular":"#f5f3ff","Cognitivo":"#f0fdfa" };
    const snome = a.status !== 'Estável' ? a.maisPrejudicado?.nome : null;
    const sistemaBadge = snome
      ? `<span style="background:${bgSistema[snome]||'#f1f5f9'};color:${corSistema[snome]||'#64748b'};font-size:9px;font-weight:700;padding:2px 7px;border-radius:20px;">${snome}</span>`
      : '<span style="color:#94a3b8;font-size:10px;">—</span>';
    return `<tr style="border-bottom:1px solid #f1f5f9;">
      <td style="padding:7px 10px;font-weight:700;font-size:12px;white-space:nowrap;">${a.nome}</td>
      <td style="padding:7px 6px;font-size:11px;color:#64748b;text-align:center;">${a.posicao}</td>
      <td style="padding:7px 6px;text-align:center;font-size:13px;font-weight:800;color:${corMin};">${minStr}</td>
      <td style="padding:7px 6px;text-align:center;font-size:11px;color:#475569;">${dataStr}</td>
      <td style="padding:7px 6px;text-align:center;">${fmtHooper(a.fadiga)}</td>
      <td style="padding:7px 6px;text-align:center;">${fmtHooper(a.sono)}</td>
      <td style="padding:7px 6px;text-align:center;">${fmtHooper(a.estresse)}</td>
      <td style="padding:7px 6px;text-align:center;max-width:110px;word-break:break-word;white-space:normal;">${fmtDor(a.dor)}${a.regioes_dor?.length ? `<div style="font-size:8px;color:#64748b;margin-top:1px;line-height:1.2;">${(a.regioes_dor.length > 2 ? a.regioes_dor.slice(0,2).join(", ") + "…" : a.regioes_dor.join(", "))}</div>` : a.sem_dor_localizada ? `<div style="font-size:8px;color:#94a3b8;margin-top:1px;font-style:italic;">sem local.</div>` : ""}</td>
      <td style="padding:7px 6px;text-align:center;font-weight:800;font-size:13px;color:${corVal(a.global)}">${fmtVal(a.global)}</td>
      <td style="padding:7px 6px;text-align:center;">
        <span style="display:inline-block;padding:2px 8px;border-radius:999px;font-size:10px;font-weight:800;
          background:${a.status==='Estável'?'#dcfce7':a.status==='Atenção Leve'?'#fef9c3':a.status==='Atenção'?'#ffedd5':a.status==='Crítico'?'#fee2e2':'#f1f5f9'};
          color:${a.status==='Estável'?'#15803d':a.status==='Atenção Leve'?'#a16207':a.status==='Atenção'?'#c2410c':a.status==='Crítico'?'#b91c1c':'#94a3b8'};">
          ${a.status}
        </span>
      </td>
    </tr>`;
  }

  const theadHTML = `
    <thead>
      <tr style="background:#1e293b;color:#fff;font-size:10px;">
        <th style="padding:8px 10px;text-align:left;white-space:nowrap;">ATLETA</th>
        <th style="padding:8px 6px;text-align:center;">POS.</th>
        <th style="padding:8px 6px;text-align:center;">MIN.<br><span style="font-weight:400;opacity:.7;">jogados</span></th>
        <th style="padding:8px 6px;text-align:center;">DATA REG.</th>
        <th style="padding:8px 6px;text-align:center;white-space:nowrap;">FADIGA<br><span style="font-weight:400;opacity:.7;">1–7</span></th>
        <th style="padding:8px 6px;text-align:center;white-space:nowrap;">SONO<br><span style="font-weight:400;opacity:.7;">1–7</span></th>
        <th style="padding:8px 6px;text-align:center;white-space:nowrap;">ESTRESSE<br><span style="font-weight:400;opacity:.7;">1–7</span></th>
        <th style="padding:8px 6px;text-align:center;white-space:nowrap;">DOR<br><span style="font-weight:400;opacity:.7;">1–7</span></th>
        <th style="padding:8px 6px;text-align:center;white-space:nowrap;">IGP<br><span style="font-weight:400;opacity:.7;">0–100</span></th>
        <th style="padding:8px 6px;text-align:center;">STATUS</th>
      </tr>
    </thead>`;

  function tabelaGrupo(lista, titulo, corTitulo, icone){
    if(!lista.length) return "";
    const mediaPront = lista.map(a=>a.global).filter(v=>v!=null);
    const mediaStr = mediaPront.length
      ? (mediaPront.reduce((s,v)=>s+v,0)/mediaPront.length).toFixed(1)
      : "—";
    return `
      <div style="margin-bottom:20px;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
          <span style="font-size:13px;font-weight:800;color:${corTitulo};">${icone} ${titulo}</span>
          <span style="font-size:11px;color:#64748b;">${lista.length} atleta${lista.length!==1?'s':''}</span>
          <span style="margin-left:auto;font-size:11px;color:#64748b;">Prontidão média: <strong style="color:${corVal(parseFloat(mediaStr))};">${mediaStr}</strong></span>
        </div>
        <div style="overflow-x:auto;">
          <table style="width:100%;border-collapse:collapse;font-family:'Segoe UI',Arial,sans-serif;">
            ${theadHTML}
            <tbody>${lista.map(linhaAtleta).join("")}</tbody>
          </table>
        </div>
      </div>`;
  }

  const legenda = `
    <div style="margin-top:14px;padding:10px 14px;background:#f8fafc;border-radius:8px;font-size:10px;color:#64748b;display:flex;flex-wrap:wrap;gap:12px;">
      <span><strong style="color:#1e293b;">Hooper subítens (Sono · Fadiga · Estresse):</strong> 1=ótimo · 7=péssimo · <span style="color:#15803d;">■</span> 1–2 · <span style="color:#a16207;">■</span> 3–4 · <span style="color:#b91c1c;">■</span> 5–7 &nbsp;|&nbsp; <strong>Dor:</strong> <span style="color:#374151;">■</span> 1–3 normal · <span style="color:#a16207;">■</span> 4–5 atenção · <span style="color:#b91c1c;">■</span> 6–7 elevada</span>
      <span><strong style="color:#1e293b;">Indicadores (0–100):</strong> <span style="color:#15803d;">■</span> ≥70 Estável · <span style="color:#a16207;">■</span> 60–69 Atenção Leve · <span style="color:#c2410c;">■</span> 50–59 Atenção · <span style="color:#b91c1c;">■</span> &lt;50 Crítico · <strong>CMJ:</strong> ≥60 / 50–59 / 40–49 / &lt;40</span>
      <span><strong style="color:#1e293b;">Data Reg.:</strong> último registro disponível do atleta</span>
      <span><strong style="color:#1e293b;">IP:</strong> Índice de Performance — score 0–100 calculado pelo scout a partir das ações do atleta no jogo (gols, assistências, decisões, erros). <span style="color:#15803d;font-weight:700;">≥70 alto</span> · <span style="color:#b45309;font-weight:700;">50–69 estável</span> · <span style="color:#c2410c;font-weight:700;">35–49 limitado</span> · <span style="color:#b91c1c;font-weight:700;">&lt;35 insuficiente</span>. Disponível apenas quando o scout da partida foi registrado.</span>
<span style="width:100%;"><strong style="color:#1e293b;">ISP Jogo:</strong> Índice Semanal de Adaptação calculado com a semana que antecedeu a partida. <span style="color:#15803d;font-weight:700;">≥70 Alto</span> — Alto nível de performance · <span style="color:#b45309;font-weight:700;">50–69 Regular</span> — Performance estável · <span style="color:#c2410c;font-weight:700;">35–49 Limitado</span> — Performance limitada · <span style="color:#b91c1c;font-weight:700;">&lt;35 Insuficiente</span> — Performance insuficiente.</span>
    </div>`;

  // ── Cards de resumo para a segunda aba ─────────────────────────────────────
  const todosComMin = [...grupo60mais, ...grupo60menos];

  const nConfirmaram = todosComMin.filter(a => a.respostaComp.label === 'Dentro da condição pré-jogo' || a.respostaComp.label === 'Acima da condição pré-jogo').length;
  const nAbaixo      = todosComMin.filter(a => a.respostaComp.label === 'Abaixo da condição pré-jogo' || a.respostaComp.label === 'Bem abaixo da condição pré-jogo').length;
  const nControlados = todosComMin.filter(a => a.direcionamento.nivel === 'critico').length;

  function _badgeDir(label) {
    const map = {
      'Recuperação ativa':            ['#b91c1c','#fee2e2'],
      'Progressão condicionada':      ['#b91c1c','#fee2e2'],
      'Reabilitação':                 ['#b91c1c','#fee2e2'],
      'Controle de carga':            ['#c2410c','#ffedd5'],
      'Progressão controlada':        ['#c2410c','#ffedd5'],
      'Trabalho individualizado':     ['#c2410c','#ffedd5'],
      'Progressão supervisionada':    ['#c2410c','#ffedd5'],
      'Controle inicial':             ['#a16207','#fef9c3'],
      'Fluxo controlado':             ['#a16207','#fef9c3'],
      'Ajuste de entrada':            ['#a16207','#fef9c3'],
      'Fluxo normal':                 ['#1d4ed8','#dbeafe'],
      'Desenvolvimento':              ['#15803d','#dcfce7'],
    };
    const [cor, bg] = map[label] || ['#94a3b8','#f1f5f9'];
    return `<span style="display:inline-block;padding:2px 8px;border-radius:999px;font-size:9px;font-weight:700;background:${bg};color:${cor};white-space:nowrap;">${label}</span>`;
  }

  function linhaResposta(a) {
    const minStr = a.minJogados != null ? `${a.minJogados}′` : '—';
    const corMin = a.minJogados >= 60 ? '#15803d' : '#c2410c';
    const ispStr = a.ispJogo != null ? a.ispJogo : '—';
    const ipStr  = a.ip != null ? a.ip : '—';
    const corIsp = a.ispJogo != null ? (a.ispJogo >= 70 ? '#15803d' : a.ispJogo >= 50 ? '#a16207' : '#b91c1c') : '#94a3b8';
    const corIp  = a.ip != null ? (a.ip >= 70 ? '#15803d' : a.ip >= 50 ? '#a16207' : '#b91c1c') : '#94a3b8';
    const d = a.direcionamento;
    const badgeMed = a.statusMed === 'afastado'
      ? `<span style="display:inline-block;margin-left:4px;padding:1px 6px;border-radius:999px;font-size:8px;font-weight:800;background:#fee2e2;color:#b91c1c;">Afastado</span>`
      : a.statusMed === 'transicao'
      ? `<span style="display:inline-block;margin-left:4px;padding:1px 6px;border-radius:999px;font-size:8px;font-weight:800;background:#ffedd5;color:#c2410c;">Transição</span>`
      : '';
    return `<tr style="border-bottom:1px solid #f1f5f9;">
      <td style="padding:8px 10px;font-weight:700;font-size:12px;white-space:nowrap;">${a.nome}${badgeMed}</td>
      <td style="padding:8px 6px;text-align:center;font-size:13px;font-weight:800;color:${corMin};">${minStr}</td>
      <td style="padding:8px 6px;text-align:center;font-size:13px;font-weight:800;color:${corIsp};">${ispStr}</td>
      <td style="padding:8px 6px;text-align:center;font-size:13px;font-weight:800;color:${corIp};">${ipStr}</td>
      <td style="padding:8px 10px;">
        <div style="background:${d.bg};border-radius:6px;padding:6px 10px;">
          <div style="font-size:9px;font-weight:800;color:${d.cor};text-transform:uppercase;letter-spacing:.04em;margin-bottom:3px;">${d.rotulo}</div>
          <div style="font-size:10px;color:#374151;line-height:1.45;">${d.texto}</div>
        </div>
      </td>
      <td style="padding:8px 6px;">${_badgeDir(d.d1)}</td>
      <td style="padding:8px 6px;">${_badgeDir(d.d2)}</td>
    </tr>`;
  }

  const theadResposta = `
    <thead>
      <tr style="background:#1e293b;color:#fff;font-size:10px;">
        <th style="padding:8px 10px;text-align:left;white-space:nowrap;">ATLETA</th>
        <th style="padding:8px 6px;text-align:center;">MIN.</th>
        <th style="padding:8px 6px;text-align:center;">ISP</th>
        <th style="padding:8px 6px;text-align:center;">IP</th>
        <th style="padding:8px 10px;text-align:left;">DIRECIONAMENTO PÓS-JOGO</th>
        <th style="padding:8px 6px;text-align:left;">D+1</th>
        <th style="padding:8px 6px;text-align:left;">D+2</th>
      </tr>
    </thead>`;

  const tabelaRespostaHTML = `
    <table style="width:100%;border-collapse:collapse;font-family:'Segoe UI',Arial,sans-serif;">
      ${theadResposta}
      <tbody>${todosComMin.sort((a,b) => (b.minJogados??0)-(a.minJogados??0)).map(linhaResposta).join('')}</tbody>
    </table>`;

  const cardsResumo = `
    <div style="display:flex;gap:14px;margin-bottom:20px;flex-wrap:wrap;">
      <div style="flex:1;min-width:160px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:14px 18px;">
        <div style="font-size:26px;font-weight:900;color:#15803d;">${nConfirmaram}</div>
        <div style="font-size:11px;color:#166534;font-weight:600;margin-top:2px;">Desempenho dentro/acima da condição pré-jogo</div>
      </div>
      <div style="flex:1;min-width:160px;background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;padding:14px 18px;">
        <div style="font-size:26px;font-weight:900;color:#c2410c;">${nAbaixo}</div>
        <div style="font-size:11px;color:#9a3412;font-weight:600;margin-top:2px;">Desempenho abaixo da condição pré-jogo</div>
      </div>
      <div style="flex:1;min-width:160px;background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:14px 18px;">
        <div style="font-size:26px;font-weight:900;color:#b91c1c;">${nControlados}</div>
        <div style="font-size:11px;color:#991b1b;font-weight:600;margin-top:2px;">Necessitam recuperação prioritária</div>
      </div>
      <div style="flex:1;min-width:160px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px 18px;">
        <div style="font-size:26px;font-weight:900;color:#334155;">${todosComMin.length}</div>
        <div style="font-size:11px;color:#475569;font-weight:600;margin-top:2px;">Atletas com minutos registrados</div>
      </div>
    </div>`;

  const legendaResposta = `
    <div style="margin-top:14px;padding:10px 14px;background:#f8fafc;border-radius:8px;font-size:10px;color:#64748b;display:flex;flex-wrap:wrap;gap:10px;">
      <span><strong style="color:#1e293b;">ISP:</strong> Índice Semanal de Adaptação pré-jogo (semana anterior à partida).</span>
      <span><strong style="color:#1e293b;">IP:</strong> Índice de Performance no jogo (ações scout). Disponível apenas quando o scout foi registrado.</span>
      <span><strong style="color:#1e293b;">Resposta ao jogo:</strong> comparação por zona (Alto ≥70 · Regular 50–69 · Limitado 35–49 · Insuficiente &lt;35). IP na mesma zona ou uma abaixo = Dentro da condição pré-jogo. Duas zonas abaixo = Abaixo. Três = Bem abaixo. IP acima da zona do ISP = Acima.</span>
      <span><strong style="color:#1e293b;">Direcionamento:</strong> cruza resposta ao jogo com prontidão atual — decisão operacional para D+1 e D+2.</span>
    </div>`;

  const conteudoModal = `
    <div id="modalPosJogo" style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;overflow-y:auto;padding:20px;">
      <div id="modalPosJogoInner" style="background:#fff;border-radius:12px;max-width:1200px;margin:0 auto;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.3);">

        <!-- Header do modal -->
        <div style="background:#1e293b;color:#fff;padding:18px 24px;display:flex;align-items:center;justify-content:space-between;">
          <div style="display:flex;align-items:center;gap:12px;">
            ${CLUB_LOGO ? `<img src="${CLUB_LOGO}" style="width:44px;height:44px;object-fit:contain;flex-shrink:0;">` : ''}
            <div>
              <div style="font-size:18px;font-weight:900;">${CLUB_NAME||"Clube"} vs ${meta.adversario}</div>
              <div style="font-size:12px;opacity:.7;margin-top:2px;">${meta.data ? meta.data.split("-").reverse().join("/") : ""} ${meta.local ? "· "+meta.local : ""} · <span style="color:${corResultado};font-weight:800;">${resultadoStr} ${placarStr}</span></div>
              <div style="font-size:9px;opacity:.5;margin-top:4px;">DEPTO. DE INTELIGÊNCIA ESPORTIVA - CIENTE IE</div>
            </div>
          </div>
          <div style="display:flex;gap:10px;align-items:center;">
            <button id="btnExportPosJogo"
              style="background:#6366f1;color:#fff;border:none;padding:8px 16px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;">
              ⬇ Exportar PDF
            </button>
            <button onclick="document.getElementById('modalPosJogo').remove()"
              style="background:rgba(255,255,255,.15);color:#fff;border:none;width:32px;height:32px;border-radius:8px;font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;">✕</button>
          </div>
        </div>

        <!-- Tabs -->
        <div style="display:flex;border-bottom:2px solid #e2e8f0;background:#f8fafc;">
          <button id="tabBtn1" onclick="_posJogoTab(1)"
            style="padding:12px 22px;font-size:12px;font-weight:700;border:none;background:transparent;cursor:pointer;border-bottom:2px solid #1e293b;color:#1e293b;margin-bottom:-2px;">
            Situação Pós-Jogo
          </button>
          <button id="tabBtn2" onclick="_posJogoTab(2)"
            style="padding:12px 22px;font-size:12px;font-weight:600;border:none;background:transparent;cursor:pointer;border-bottom:2px solid transparent;color:#64748b;margin-bottom:-2px;">
            Resposta Competitiva e Direcionamento
          </button>
        </div>

        <!-- Tab 1 -->
        <div id="posJogoTab1" style="padding:20px 24px;">
          <div id="posJogoBody">
            ${tabelaGrupo(grupo60mais,  "≥ 60 minutos · Titulares / Longos", "#15803d", "🟢")}
            ${tabelaGrupo(grupo60menos, "< 60 minutos · Reservas / Substituídos", "#c2410c", "🟡")}
            ${legenda}
          </div>
        </div>

        <!-- Tab 2 -->
        <div id="posJogoTab2" style="padding:20px 24px;display:none;">
          <div id="posJogoRespostaBody">
            <div style="margin-bottom:16px;">
              <div style="font-size:15px;font-weight:800;color:#1e293b;">Resposta Competitiva e Direcionamento Pós-Jogo</div>
              <div style="font-size:11px;color:#64748b;margin-top:2px;">Comparação entre condição pré-jogo (ISP), performance (IP) e estado pós-jogo — com orientação de entrada em D+1 e D+2.</div>
            </div>
            ${cardsResumo}
            <div style="overflow-x:auto;">${tabelaRespostaHTML}</div>
            ${legendaResposta}
          </div>
        </div>

      </div>
    </div>`;

  document.body.insertAdjacentHTML("beforeend", conteudoModal);

  // Troca de tabs
  window._posJogoTab = function(n) {
    document.getElementById("posJogoTab1").style.display = n === 1 ? "block" : "none";
    document.getElementById("posJogoTab2").style.display = n === 2 ? "block" : "none";
    document.getElementById("tabBtn1").style.borderBottomColor = n === 1 ? "#1e293b" : "transparent";
    document.getElementById("tabBtn1").style.color = n === 1 ? "#1e293b" : "#64748b";
    document.getElementById("tabBtn2").style.borderBottomColor = n === 2 ? "#1e293b" : "transparent";
    document.getElementById("tabBtn2").style.color = n === 2 ? "#1e293b" : "#64748b";
  };

  // Fecha ao clicar fora
  document.getElementById("modalPosJogo").addEventListener("click", function(e){
    if(e.target === this) this.remove();
  });

  // Exportar PDF
  document.getElementById("btnExportPosJogo").addEventListener("click", exportarPosJogoPDF);
}

async function exportarPosJogoPDF(){
  const btn = document.getElementById("btnExportPosJogo");
  btn.disabled = true; btn.textContent = "Gerando...";
  try {
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ orientation:"landscape", unit:"mm", format:"a4" });
    const meta = ultimaPartidaMeta;

    async function capturarElemento(el) {
      return html2canvas(el, {
        scale: 1.8, useCORS: true, backgroundColor: "#ffffff",
        width: el.scrollWidth, height: el.scrollHeight
      });
    }

    async function adicionarPaginasCanvas(canvas, isFirst) {
      const pW = pdf.internal.pageSize.getWidth();
      const pH = pdf.internal.pageSize.getHeight();
      const pageH = pH - 10;
      const imgH = pW * (canvas.height / canvas.width);
      const totalPags = Math.ceil(imgH / pageH);
      for (let i = 0; i < totalPags; i++) {
        if (!isFirst || i > 0) pdf.addPage();
        isFirst = false;
        const srcY = (canvas.height / totalPags) * i;
        const sliceH = canvas.height / totalPags;
        const slice = document.createElement("canvas");
        slice.width = canvas.width; slice.height = sliceH;
        slice.getContext("2d").drawImage(canvas, 0, -srcY);
        pdf.addImage(slice.toDataURL("image/jpeg", 0.92), "JPEG", 5, 5, pW - 10, pageH);
      }
    }

    // Página 1 — Situação Pós-Jogo (tab 1 visível ou não)
    const el1 = document.getElementById("posJogoBody");
    if (el1) {
      const c1 = await capturarElemento(el1);
      await adicionarPaginasCanvas(c1, true);
    }

    // Página 2 — Resposta Competitiva (garante que a tab2 está renderizada)
    const el2 = document.getElementById("posJogoRespostaBody");
    if (el2) {
      const prevDisplay = document.getElementById("posJogoTab2").style.display;
      document.getElementById("posJogoTab2").style.display = "block";
      await new Promise(r => setTimeout(r, 60));
      const c2 = await capturarElemento(el2);
      document.getElementById("posJogoTab2").style.display = prevDisplay;
      await adicionarPaginasCanvas(c2, false);
    }

    pdf.save(`PosJogo_${meta.data}_${meta.adversario.replace(/\s+/g,"_")}.pdf`);
    if (new URLSearchParams(window.location.search).get('from') === 'relatorios') setTimeout(() => { window.location.href = '/staff/relatorios.html'; }, 800);
  } catch(err){ console.error(err); alert("Erro ao gerar PDF."); }
  finally { btn.disabled=false; btn.textContent="⬇ Exportar PDF"; }
}

if (window.location.pathname.includes('prontidao')) {
  document.getElementById("btnPosJogo")?.addEventListener("click", abrirModalPosJogo);
}

// ================= RELATÓRIO PÓS-JOGO PDF (window.open) =================
/* ═══════════════════════════════════════════════════════════════════════════
   PÁGINA xG — PERIGO, ORIGEM E CONTEXTO
   Constantes calibráveis no topo — ajustar à base real quando disponível.
═══════════════════════════════════════════════════════════════════════════ */
const XG_PENALTI    = 0.76;
const XG_ZONE_Z1    = 0.30;  // dentro da área, frente central
const XG_ZONE_Z2    = 0.10;  // dentro da área, lateral
const XG_ZONE_Z4    = 0.06;  // borda/entrada da área
const XG_ZONE_Z5    = 0.03;  // fora da área
const XG_MOD_HEADER = 0.60;  // multiplicador cabeceio
const XG_MOD_PARADA = 0.50;  // multiplicador bola parada

function _xgZone(x, y) {
  // x/y em % (0–100). Attack direction: x=100 = gol line.
  if(x == null) return 'Z5';
  if(x >= 96) return y >= 42 && y <= 58 ? 'Z1' : 'Z2';
  if(x >= 90) return y >= 36 && y <= 64 ? 'Z1' : 'Z2';
  if(x >= 68) return 'Z4';
  return 'Z5';
}

function _xgBase(zone) {
  return { Z1: XG_ZONE_Z1, Z2: XG_ZONE_Z2, Z4: XG_ZONE_Z4, Z5: XG_ZONE_Z5 }[zone] ?? XG_ZONE_Z5;
}

function _calcXG(meta, isAdv = false) {
  if(!meta) return XG_ZONE_Z5;
  // Pênalti: valor fixo
  if(meta.origem === 'penalti') return XG_PENALTI;
  // Se tiver x/y, usa; senão usa zona texto
  let zone;
  if(meta.x != null && meta.y != null){
    // Para adversário, x é espelhado: (100 - meta.x)
    const xEfetivo = isAdv ? (100 - (meta.x ?? 50)) : (meta.x ?? 50);
    zone = _xgZone(xEfetivo, meta.y);
  } else {
    zone = meta.zona === 'dentro' ? 'Z1' : 'Z5';
  }
  let xg = _xgBase(zone);
  if(meta.header)                xg *= XG_MOD_HEADER;
  if(meta.origem === 'parada')   xg *= XG_MOD_PARADA;
  return Math.round(xg * 1000) / 1000;
}

// Reconstrói gameState a partir da sequência de gols (fallback para dados antigos)
function _reconstructGameStates(events) {
  let pro = 0, contra = 0;
  return events.map(ev => {
    const gs = ev.gameState ?? (pro > contra ? 'vencendo' : pro < contra ? 'perdendo' : 'empatando');
    if(ev.action === 'Gol Pró')          pro++;
    if(ev.action === 'Gol Contra (adv)') contra++;
    return { ...ev, _gs: gs };
  });
}

function _buildPaginaXG(events, meta, clubName) {
  if(!events || !events.length){
    return `<div style="padding:32px;color:#667085;font-size:13px;border:1px solid #eaecf0;border-radius:12px;margin-top:24px;">
      <strong>PERIGO, ORIGEM E CONTEXTO</strong><br>
      Eventos de jogo não disponíveis para esta partida.
    </div>`;
  }

  const evs = _reconstructGameStates(events);

  // ── Separar eventos relevantes ────────────────────────────────────────────
  const finAmerica = evs.filter(e => e.action === 'Finalização');
  const finAdv     = evs.filter(e => e.action === 'Finalização adversária');
  const golsPro    = evs.filter(e => e.action === 'Gol Pró');
  const golsContra = evs.filter(e => e.action === 'Gol Contra (adv)');

  // Gols dentro das finalizações (resultado === 'no_gol' = marcou)
  const golsFinAmerica = finAmerica.filter(e => e.meta?.resultado === 'no_gol');

  // ── xG por finalização ────────────────────────────────────────────────────
  const xgCriado    = finAmerica.reduce((s, e) => s + _calcXG(e.meta, false), 0);
  const xgConcedido = finAdv.reduce((s, e) => s + _calcXG(e.meta, true), 0);
  const xgSaldo     = xgCriado - xgConcedido;
  const xgPorFin    = finAmerica.length ? xgCriado / finAmerica.length : 0;
  const golsReais   = golsPro.length;
  const golsConc    = golsContra.length;

  const fmt1 = v => v.toFixed(2);
  const fmt2 = v => v.toFixed(2);
  const corSaldo = xgSaldo >= 0 ? '#067647' : '#b42318';

  // ── xG por zona (América) ─────────────────────────────────────────────────
  const zonaStats = { Z1:{label:'Central (área)',fins:0,xg:0,gols:0}, Z2:{label:'Lateral (área)',fins:0,xg:0,gols:0}, Z4:{label:'Borda da área',fins:0,xg:0,gols:0}, Z5:{label:'Fora da área',fins:0,xg:0,gols:0} };
  finAmerica.forEach(e => {
    const m = e.meta || {};
    const zone = m.x != null ? _xgZone(m.x, m.y) : (m.zona === 'dentro' ? 'Z1' : 'Z5');
    const xg = _calcXG(m, false);
    zonaStats[zone].fins++;
    zonaStats[zone].xg += xg;
    if(m.resultado === 'no_gol') zonaStats[zone].gols++;
  });

  // ── Game state (América) ──────────────────────────────────────────────────
  const gsMap = { vencendo:{fins:0,xg:0,gols:0,label:'Vencendo',cor:'#067647',bg:'#e9f9ef'}, empatando:{fins:0,xg:0,gols:0,label:'Empatando',cor:'#a15c07',bg:'#fff7d6'}, perdendo:{fins:0,xg:0,gols:0,label:'Perdendo',cor:'#b42318',bg:'#ffecec'} };
  finAmerica.forEach(e => {
    const gs = e._gs || 'empatando';
    if(gsMap[gs]){
      gsMap[gs].fins++;
      gsMap[gs].xg += _calcXG(e.meta, false);
      if(e.meta?.resultado === 'no_gol') gsMap[gs].gols++;
    }
  });
  const totalXGGs = Object.values(gsMap).reduce((s,g)=>s+g.xg,0);

  // ── Origem dos gols (Gol Pró tem campo origem) ────────────────────────────
  const origemMap = { rolando:{label:'Bola Rolando',gols:0}, parada:{label:'Bola Parada',gols:0}, penalti:{label:'Pênalti',gols:0} };
  golsPro.forEach(e => { const o = e.meta?.origem || 'rolando'; if(origemMap[o]) origemMap[o].gols++; });
  // Finalizações por setorOrigem
  const setorMap = {};
  finAmerica.forEach(e => { const s = e.meta?.setorOrigem || 'N/D'; setorMap[s] = (setorMap[s]||0)+1; });
  const setorEntries = Object.entries(setorMap).sort((a,b)=>b[1]-a[1]).slice(0,5);

  // ── SVG: Mapa de chutes (campo ofensivo, ataque p/ direita) ──────────────
  // Viewport: x ∈ [55,100], y ∈ [0,100] → SVG 320×180
  const SVG_W = 320, SVG_H = 180;
  function toSvgX(fx){ return Math.round(((fx - 55) / 45) * SVG_W); }
  function toSvgY(fy){ return Math.round((fy / 100) * SVG_H); }

  // Linhas do campo
  const fieldLines = `
    <rect x="0" y="0" width="${SVG_W}" height="${SVG_H}" fill="#1a6b3a" rx="4"/>
    <!-- Grande área: x=90–100, y=22–78 no campo → SVG -->
    <rect x="${toSvgX(90)}" y="${toSvgY(22)}" width="${SVG_W - toSvgX(90)}" height="${toSvgY(78)-toSvgY(22)}" fill="none" stroke="rgba(255,255,255,.5)" stroke-width="1.2"/>
    <!-- Pequena área: x=96–100, y=36–64 -->
    <rect x="${toSvgX(96)}" y="${toSvgY(36)}" width="${SVG_W - toSvgX(96)}" height="${toSvgY(64)-toSvgY(36)}" fill="none" stroke="rgba(255,255,255,.4)" stroke-width="1"/>
    <!-- Meia lua: aprox x=85, y=42-58 -->
    <!-- Gol: y=44–56 na linha x=100 -->
    <rect x="${SVG_W-3}" y="${toSvgY(44)}" width="3" height="${toSvgY(56)-toSvgY(44)}" fill="rgba(255,255,255,.8)"/>
    <!-- Linha do mapa (esquerda) -->
    <line x1="0" y1="0" x2="0" y2="${SVG_H}" stroke="rgba(255,255,255,.3)" stroke-width="1"/>
    <line x1="0" y1="0" x2="${SVG_W}" y2="0" stroke="rgba(255,255,255,.3)" stroke-width="1"/>
    <line x1="0" y1="${SVG_H}" x2="${SVG_W}" y2="${SVG_H}" stroke="rgba(255,255,255,.3)" stroke-width="1"/>
  `;

  // Pontos de chute
  function shotDot(ev, isAdvMirror){
    const m = ev.meta || {};
    let fx = m.x != null ? (isAdvMirror ? 100 - m.x : m.x) : (m.zona === 'dentro' ? 93 : 73);
    let fy = m.y != null ? m.y : 50;
    if(fx < 55) fx = 60; // garante que fica no viewport
    const sx = toSvgX(fx), sy = toSvgY(fy);
    const xg = _calcXG(m, isAdvMirror);
    const r = Math.max(3, Math.min(12, Math.round(xg * 25)));
    const isGol = !isAdvMirror && m.resultado === 'no_gol';
    const fill = isAdvMirror ? 'rgba(180,35,24,.7)' : isGol ? '#facc15' : 'rgba(59,130,246,.75)';
    const stroke = isAdvMirror ? '#b42318' : isGol ? '#ca8a04' : '#1d4ed8';
    return `<circle cx="${sx}" cy="${sy}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="1.2" opacity=".85"/>`;
  }

  const dotsAmerica = finAmerica.map(e => shotDot(e, false)).join('');
  const dotsAdv     = finAdv.map(e => shotDot(e, true)).join('');

  const legendaSVG = `
    <div style="display:flex;gap:12px;margin-top:5px;font-size:9px;color:#475467;">
      <span><svg width="10" height="10"><circle cx="5" cy="5" r="4" fill="rgba(59,130,246,.75)" stroke="#1d4ed8" stroke-width="1"/></svg> Finalização (${clubName||'Clube'})</span>
      <span><svg width="10" height="10"><circle cx="5" cy="5" r="4" fill="#facc15" stroke="#ca8a04" stroke-width="1"/></svg> Gol</span>
      <span><svg width="10" height="10"><circle cx="5" cy="5" r="4" fill="rgba(180,35,24,.7)" stroke="#b42318" stroke-width="1"/></svg> Finalização adversária</span>
      <span style="color:#94a3b8;">Raio ∝ xG do chute</span>
    </div>`;

  // ── Tabela de zonas ────────────────────────────────────────────────────────
  const zonaRows = Object.entries(zonaStats).map(([z,s]) => {
    const over = s.gols - s.xg;
    const overStr = over >= 0 ? `+${fmt1(over)}` : fmt1(over);
    const overCor = over >= 0 ? '#067647' : '#b42318';
    return `<tr>
      <td style="padding:5px 8px;font-size:10px;color:#344054;">${s.label}</td>
      <td style="padding:5px 8px;font-size:10px;text-align:center;">${s.fins}</td>
      <td style="padding:5px 8px;font-size:10px;text-align:center;">${fmt1(s.xg)}</td>
      <td style="padding:5px 8px;font-size:10px;text-align:center;">${s.gols}</td>
      <td style="padding:5px 8px;font-size:10px;text-align:center;color:${overCor};font-weight:700;">${overStr}</td>
    </tr>`;
  }).join('');

  // ── Game state bars ───────────────────────────────────────────────────────
  const gsBars = ['vencendo','empatando','perdendo'].map(k => {
    const g = gsMap[k];
    const pct = totalXGGs > 0 ? Math.round((g.xg/totalXGGs)*100) : 0;
    return `<div style="margin-bottom:10px;">
      <div style="display:flex;justify-content:space-between;font-size:10px;margin-bottom:3px;">
        <span style="font-weight:700;color:${g.cor};">${g.label}</span>
        <span style="color:#475467;">${g.fins} fin · xG ${fmt1(g.xg)} · ${g.gols} gol${g.gols!==1?'s':''}</span>
      </div>
      <div style="background:#f2f4f7;border-radius:999px;height:8px;overflow:hidden;">
        <div style="width:${pct}%;background:${g.cor};height:100%;border-radius:999px;"></div>
      </div>
      <div style="font-size:9px;color:#94a3b8;margin-top:2px;text-align:right;">${pct}% do xG criado</div>
    </div>`;
  }).join('');

  // ── Origem dos gols ───────────────────────────────────────────────────────
  const origemRows = Object.entries(origemMap).map(([k,o]) => {
    const xgGolOri = golsPro.filter(e=>(e.meta?.origem||'rolando')===k).length > 0 ? XG_PENALTI * (k==='penalti'?1:0) + o.gols * (k==='rolando'?XG_ZONE_Z1:k==='parada'?XG_ZONE_Z1*XG_MOD_PARADA:0) : 0;
    return `<tr>
      <td style="padding:5px 8px;font-size:10px;color:#344054;">${o.label}</td>
      <td style="padding:5px 8px;font-size:10px;text-align:center;font-weight:700;">${o.gols}</td>
      <td style="padding:5px 8px;font-size:10px;text-align:center;color:#94a3b8;">—</td>
    </tr>`;
  }).join('');

  // ── Mensagem game state ───────────────────────────────────────────────────
  const gsMax = Object.entries(gsMap).sort((a,b)=>b[1].xg-a[1].xg)[0];
  const pctGsMax = totalXGGs > 0 ? Math.round((gsMax[1].xg/totalXGGs)*100) : 0;
  const gsMsg = finAmerica.length
    ? `${pctGsMax}% do xG criado surgiu com o placar ${gsMax[1].label.toLowerCase()}${gsMap['empatando'].fins > gsMap['vencendo'].fins && gsMap['empatando'].fins > gsMap['perdendo'].fins ? ' — padrão consistente com equipes que buscam o jogo desde cedo' : ''}. Nota: xG de uma única partida é indicativo, não estável.`
    : 'Sem finalizações registradas para esta partida.';

  // ── HTML da página ────────────────────────────────────────────────────────
  return `
  <div style="font-family:'Segoe UI',Arial,sans-serif;color:#101828;padding-top:16px;">

    <!-- Título da página -->
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;border-bottom:2px solid #1e3a5f;padding-bottom:8px;">
      <div>
        <div style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:#1e3a5f;">Análise de Jogo</div>
        <div style="font-size:18px;font-weight:900;color:#101828;margin-top:2px;">PERIGO, ORIGEM E CONTEXTO</div>
      </div>
      <div style="font-size:11px;color:#475467;text-align:right;">
        ${clubName||'Clube'} vs ${meta?.adversario||'Adversário'}<br>
        <span style="font-size:9px;color:#94a3b8;">xG = modelo simplificado por zona · valores indicativos</span>
      </div>
    </div>

    <!-- 4 cartões resumo -->
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px;">
      <div style="border-radius:12px;padding:12px 14px;background:#eaf2ff;border:1px solid #c7ddff;">
        <div style="font-size:28px;font-weight:900;color:#175cd3;line-height:1;">${fmt1(xgCriado)}</div>
        <div style="font-size:11px;font-weight:800;color:#175cd3;margin-top:4px;">xG Criado</div>
        <div style="font-size:10px;color:#667085;margin-top:2px;">${finAmerica.length} finalizações · ${golsReais} gol${golsReais!==1?'s':''} reais</div>
      </div>
      <div style="border-radius:12px;padding:12px 14px;background:#ffecec;border:1px solid #ffc9c9;">
        <div style="font-size:28px;font-weight:900;color:#b42318;line-height:1;">${fmt1(xgConcedido)}</div>
        <div style="font-size:11px;font-weight:800;color:#b42318;margin-top:4px;">xG Concedido</div>
        <div style="font-size:10px;color:#667085;margin-top:2px;">${finAdv.length} finalizações · ${golsConc} gol${golsConc!==1?'s':''} sofridos</div>
      </div>
      <div style="border-radius:12px;padding:12px 14px;background:${xgSaldo>=0?'#e9f9ef':'#ffecec'};border:1px solid ${xgSaldo>=0?'#bceacb':'#ffc9c9'};">
        <div style="font-size:28px;font-weight:900;color:${corSaldo};line-height:1;">${xgSaldo>=0?'+':''}${fmt1(xgSaldo)}</div>
        <div style="font-size:11px;font-weight:800;color:${corSaldo};margin-top:4px;">Saldo de xG</div>
        <div style="font-size:10px;color:#667085;margin-top:2px;">Criado − Concedido</div>
      </div>
      <div style="border-radius:12px;padding:12px 14px;background:#f9f5ff;border:1px solid #d9d0fa;">
        <div style="font-size:28px;font-weight:900;color:#6941c6;line-height:1;">${fmt2(xgPorFin)}</div>
        <div style="font-size:11px;font-weight:800;color:#6941c6;margin-top:4px;">xG / Finalização</div>
        <div style="font-size:10px;color:#667085;margin-top:2px;">Qualidade média do chute</div>
      </div>
    </div>

    <!-- 3 blocos -->
    <div style="display:grid;grid-template-columns:2fr 1fr 1fr;gap:12px;">

      <!-- Bloco 1: Mapa + tabela de zonas -->
      <div style="border:1px solid #eaecf0;border-radius:12px;padding:12px;background:#fff;">
        <div style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:#475467;margin-bottom:8px;">Mapa de Perigo (xG por chute)</div>
        <svg width="${SVG_W}" height="${SVG_H}" viewBox="0 0 ${SVG_W} ${SVG_H}" style="display:block;border-radius:6px;width:100%;max-width:${SVG_W}px;">
          ${fieldLines}
          ${dotsAdv}
          ${dotsAmerica}
        </svg>
        ${legendaSVG}
        <div style="margin-top:10px;">
          <div style="font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;color:#475467;margin-bottom:4px;">xG por zona — ${clubName||'Clube'}</div>
          <table style="width:100%;border-collapse:collapse;">
            <thead>
              <tr style="background:#f8fafc;">
                <th style="padding:5px 8px;font-size:9px;text-transform:uppercase;letter-spacing:.04em;color:#667085;text-align:left;font-weight:700;">Zona</th>
                <th style="padding:5px 8px;font-size:9px;text-align:center;color:#667085;font-weight:700;">Fin.</th>
                <th style="padding:5px 8px;font-size:9px;text-align:center;color:#667085;font-weight:700;">xG</th>
                <th style="padding:5px 8px;font-size:9px;text-align:center;color:#667085;font-weight:700;">Gols</th>
                <th style="padding:5px 8px;font-size:9px;text-align:center;color:#667085;font-weight:700;">G−xG</th>
              </tr>
            </thead>
            <tbody style="border-top:1px solid #f0f2f5;">${zonaRows}</tbody>
          </table>
        </div>
      </div>

      <!-- Bloco 2: Origem -->
      <div style="border:1px solid #eaecf0;border-radius:12px;padding:12px;background:#fff;">
        <div style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:#475467;margin-bottom:10px;">Origem dos Gols</div>
        <table style="width:100%;border-collapse:collapse;margin-bottom:14px;">
          <thead>
            <tr style="background:#f8fafc;">
              <th style="padding:5px 8px;font-size:9px;color:#667085;text-align:left;font-weight:700;">Origem</th>
              <th style="padding:5px 8px;font-size:9px;color:#667085;text-align:center;font-weight:700;">Gols</th>
              <th style="padding:5px 8px;font-size:9px;color:#667085;text-align:center;font-weight:700;">%</th>
            </tr>
          </thead>
          <tbody>
            ${Object.entries(origemMap).map(([k,o])=>{
              const pctO = golsReais > 0 ? Math.round((o.gols/golsReais)*100) : 0;
              return `<tr>
                <td style="padding:5px 8px;font-size:10px;color:#344054;">${o.label}</td>
                <td style="padding:5px 8px;font-size:10px;text-align:center;font-weight:700;">${o.gols}</td>
                <td style="padding:5px 8px;font-size:10px;text-align:center;color:#667085;">${golsReais>0?pctO+'%':'—'}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
        <div style="font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;color:#475467;margin-bottom:8px;">Origem dos Ataques (finalizações)</div>
        ${setorEntries.length ? setorEntries.map(([s,n])=>{
          const pctS = finAmerica.length > 0 ? Math.round((n/finAmerica.length)*100) : 0;
          return `<div style="margin-bottom:7px;">
            <div style="display:flex;justify-content:space-between;font-size:9px;margin-bottom:2px;">
              <span style="color:#344054;">${s}</span><span style="color:#667085;">${n} fin · ${pctS}%</span>
            </div>
            <div style="background:#f2f4f7;border-radius:999px;height:6px;overflow:hidden;">
              <div style="width:${pctS}%;background:#1e3a5f;height:100%;border-radius:999px;"></div>
            </div>
          </div>`;
        }).join('') : '<p style="font-size:10px;color:#94a3b8;">Sem setor de origem registrado.</p>'}
      </div>

      <!-- Bloco 3: Game State -->
      <div style="border:1px solid #eaecf0;border-radius:12px;padding:12px;background:#fff;">
        <div style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:#475467;margin-bottom:10px;">Contexto de Jogo (Game State)</div>
        ${gsBars}
        <div style="margin-top:10px;padding:10px;background:#f8fafc;border-radius:8px;border:1px solid #eaecf0;">
          <div style="font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;color:#475467;margin-bottom:4px;">Leitura</div>
          <p style="font-size:10px;color:#344054;line-height:1.5;margin:0;">${gsMsg}</p>
        </div>
        <!-- Funil -->
        <div style="margin-top:12px;">
          <div style="font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;color:#475467;margin-bottom:6px;">Funil Ofensivo</div>
          ${[
            {label:'Finalizações', val:finAmerica.length, cor:'#1e3a5f'},
            {label:'Gols', val:golsReais, cor:'#067647'},
          ].map((f,i,arr)=>{
            const pctF = i > 0 && arr[i-1].val > 0 ? Math.round((f.val/arr[i-1].val)*100) : 100;
            return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:5px;">
              <div style="width:${Math.max(20,pctF)}%;background:${f.cor};border-radius:4px;padding:4px 6px;color:#fff;font-size:9px;font-weight:700;white-space:nowrap;">${f.val} ${f.label}</div>
              ${i>0?`<span style="font-size:9px;color:#94a3b8;">conv. ${pctF}%</span>`:''}
            </div>`;
          }).join('')}
        </div>
      </div>

    </div>
  </div>`;
}

async function abrirRelatorioPosJogoPDF(categoria = '') {
  await carregarUltimaPartida();
  if (!ultimaPartidaMeta) { alert("Nenhuma partida encontrada no scout."); return; }

  const dataSelecionada = document.getElementById("filtroData")?.value || hoje;
  const meta = ultimaPartidaMeta;

  // ── Helpers visuais ────────────────────────────────────────────────────────
  const BG_PAGE = '#f1efe8';
  const BG_SEC  = '#f8f7f3';

  function badgeIGP(v) {
    if (v == null) return `<span style="font-size:11px;color:#9ca3af;">—</span>`;
    const [bg, cor] = v >= 70 ? ['#dcfce7','#15803d'] : v >= 60 ? ['#fef9c3','#a16207'] : v >= 50 ? ['#ffedd5','#c2410c'] : ['#fee2e2','#b91c1c'];
    return `<span style="display:inline-flex;align-items:center;gap:4px;">
      <span style="font-size:13px;font-weight:900;color:${cor};">${Math.round(v)}</span>
      <span style="background:${bg};color:${cor};padding:2px 6px;border-radius:999px;font-size:8px;font-weight:800;text-transform:uppercase;letter-spacing:.03em;">${v>=70?'Estável':v>=60?'At. Leve':v>=50?'Atenção':'Crítico'}</span>
    </span>`;
  }

  function badgeISP(v) {
    if (v == null) return `<span style="color:#9ca3af;font-size:11px;">—</span>`;
    const [bg, cor, lbl] = v >= 75 ? ['#dcfce7','#15803d','Alto'] : v >= 55 ? ['#fef9c3','#a16207','Regular'] : v >= 35 ? ['#ffedd5','#c2410c','Limitado'] : ['#fee2e2','#b91c1c','Insuf.'];
    return `<span style="background:${bg};color:${cor};padding:2px 7px;border-radius:999px;font-size:8px;font-weight:800;text-transform:uppercase;">${lbl} ${Math.round(v)}</span>`;
  }

  function badgeQuadrante(q) {
    const cfg = {
      normal:      { lbl: 'Normal',      bg: '#dcfce7', cor: '#15803d' },
      controle:    { lbl: 'Controle',    bg: '#fef9c3', cor: '#a16207' },
      recuperacao: { lbl: 'Recuperação', bg: '#fee2e2', cor: '#b91c1c' },
      avaliacao:   { lbl: 'Avaliação',   bg: '#dbeafe', cor: '#1d4ed8' },
    };
    const c = cfg[q] || { lbl: q, bg: '#f3f4f6', cor: '#6b7280' };
    return `<span style="background:${c.bg};color:${c.cor};padding:3px 8px;border-radius:999px;font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.03em;">${c.lbl}</span>`;
  }

  function avatarEl(nome, fotoUrl) {
    const cor = (() => { const p=['#64748b','#3b82f6','#14b8a6','#f97316']; let h=0; for(const c of (nome||'')) h=(h*31+c.charCodeAt(0))&0xffff; return p[h%p.length]; })();
    const ini = (() => { const p=(nome||'').trim().split(/\s+/).filter(Boolean); if(!p.length) return '?'; if(p.length===1) return p[0].slice(0,2).toUpperCase(); return (p[0][0]+p[p.length-1][0]).toUpperCase(); })();
    if (fotoUrl) return `<img src="${fotoUrl}" style="width:32px;height:32px;border-radius:50%;object-fit:cover;flex-shrink:0;">`;
    return `<div style="width:32px;height:32px;border-radius:50%;background:${cor};display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;color:#fff;flex-shrink:0;">${ini}</div>`;
  }

  function abrevNome(nome) {
    const p = (nome||'').trim().split(/\s+/);
    if (p.length <= 1 || p[0].length > 10) return p[0] || '—';
    return `${p[0]} ${p[p.length-1][0]}.`;
  }

  // ── Dados ──────────────────────────────────────────────────────────────────
  const atletasFiltradosPosJogo = categoria ? atletas.filter(a => a.categoria === categoria) : atletas;
  const dadosAtletas = atletasFiltradosPosJogo.map(a => {
    const seg = minutosByAthleta[a.id] ?? null;
    const minJogados = seg != null ? Math.round(seg / 60) : null;
    if (!minJogados) return null;

    const dmsAtleta = historico.filter(d => d.athleteId === a.id).sort((x,y) => new Date(y.date)-new Date(x.date));
    const dmDia     = dmsAtleta.find(d => d.date === dataSelecionada) || dmsAtleta[0] || null;
    const dmJogo    = dmsAtleta.find(d => d.date === meta?.data) || null;
    const calc      = calcularProntidao(dmDia, calcularBasalAtleta(a.id));
    const statusMed = statusMedicoAtleta(a.id);

    const igp        = calc.global;
    const ip         = perfByAthleta[a.id] ?? null;
    const dor        = dmDia?.pre?.regioes_dor ?? [];
    const acoes      = acoesByAthleta[a.id] ?? null;
    const duelos     = duelosByAthleta[a.id] ?? null;
    const cargaPos   = dmJogo?.post?.carga ?? null;

    const temIndicadorCritico =
      (calc.IH  != null && calc.IH  < 50) ||
      (calc.IA  != null && calc.IA  < 50) ||
      (calc.INM != null && calc.INM < 40) ||
      (calc.IC  != null && calc.IC  < 50) ||
      ((dmDia?.pre?.dor ?? 0) >= 5);

    let quadrante;
    if (statusMed === 'afastado' || temIndicadorCritico) quadrante = 'avaliacao';
    else if (igp != null && igp < 50 && minJogados >= 60) quadrante = 'recuperacao';
    else if (minJogados >= 60) quadrante = 'controle';
    else quadrante = 'normal';

    return {
      id: a.id, nome: a.nome, posicao: a.posicao||'—', fotoUrl: a.fotoUrl||'',
      minJogados, igp, ip, dor, acoes, duelos, cargaPos, quadrante, statusMed,
    };
  }).filter(Boolean).sort((a, b) => (b.minJogados ?? 0) - (a.minJogados ?? 0));

  // ── KPI cards ──────────────────────────────────────────────────────────────
  const qCounts = { normal: 0, controle: 0, recuperacao: 0, avaliacao: 0 };
  dadosAtletas.forEach(a => qCounts[a.quadrante]++);

  const igpsValidos = dadosAtletas.map(a => a.igp).filter(v => v != null);
  const igpMedio = igpsValidos.length ? igpsValidos.reduce((s,v)=>s+v,0)/igpsValidos.length : null;

  const acoesTotaisGrupo = dadosAtletas.reduce((s,a) => s + (a.acoes ?? 0), 0);

  function kpiCard(value, label, desc, bgColor, textColor) {
    return `<div style="background:${bgColor};border-radius:8px;padding:14px 16px;display:flex;flex-direction:column;justify-content:space-between;">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:${textColor};opacity:.75;margin-bottom:6px;">${label}</div>
      <div style="font-size:26px;font-weight:900;color:${textColor};line-height:1;">${value}</div>
      <div style="font-size:10px;color:${textColor};opacity:.65;margin-top:4px;">${desc}</div>
    </div>`;
  }

  const igpMedioStr = igpMedio != null ? Math.round(igpMedio) : '—';
  const [igpBg, igpCor] = igpMedio == null ? ['#f3f4f6','#6b7280'] : igpMedio >= 70 ? ['#dcfce7','#15803d'] : igpMedio >= 60 ? ['#fef9c3','#a16207'] : igpMedio >= 50 ? ['#ffedd5','#c2410c'] : ['#fee2e2','#b91c1c'];

  const kpiRow = `<div style="display:grid;grid-template-columns:repeat(6,1fr);gap:10px;margin-bottom:18px;">
    ${kpiCard(dadosAtletas.length, 'Atletas', 'com minutagem', BG_SEC, '#374151')}
    ${kpiCard(qCounts.normal,      'Normal',  'rotina planejada', '#dcfce7', '#15803d')}
    ${kpiCard(qCounts.controle,    'Controle','ajustar carga',   '#fef9c3', '#a16207')}
    ${kpiCard(qCounts.recuperacao, 'Recuperação','regenerativo', '#fee2e2', '#b91c1c')}
    ${kpiCard(qCounts.avaliacao,   'Avaliação','caso especial',  '#dbeafe', '#1d4ed8')}
    ${kpiCard(igpMedioStr, 'IGP médio', 'pré-jogo do grupo', igpBg, igpCor)}
  </div>`;

  // ── Linha por atleta ───────────────────────────────────────────────────────
  function rowAtleta(a) {
    const minBar = Math.round((a.minJogados / 90) * 100);
    const minBarCor = a.minJogados >= 75 ? '#15803d' : a.minJogados >= 45 ? '#a16207' : '#9ca3af';
    const cargaStr = a.cargaPos != null ? `${Math.round(a.cargaPos)} ua` : '—';
    const acoesStr = a.acoes != null ? `${a.acoes}` : '—';
    const dorStr   = a.dor?.length ? a.dor.join(', ') : null;

    function badgeIP(v) {
      if (v == null) return `<span style="color:#9ca3af;font-size:11px;">—</span>`;
      const [bg, cor, lbl] = v >= 80 ? ['#dcfce7','#15803d','Excelente']
        : v >= 65 ? ['#fef9c3','#a16207','Bom']
        : v >= 50 ? ['#ffedd5','#c2410c','Regular']
        : ['#fee2e2','#b91c1c','Baixo'];
      return `<span style="display:inline-flex;align-items:center;gap:4px;">
        <span style="font-size:13px;font-weight:900;color:${cor};">${Math.round(v)}</span>
        <span style="background:${bg};color:${cor};padding:2px 6px;border-radius:999px;font-size:8px;font-weight:800;text-transform:uppercase;letter-spacing:.03em;">${lbl}</span>
      </span>`;
    }

    const duelosEl = a.duelos != null
      ? `<span style="font-size:12px;font-weight:800;color:#15803d;">${a.duelos.ganhos}G</span><span style="font-size:11px;color:#9ca3af;margin:0 2px;">/</span><span style="font-size:12px;font-weight:800;color:#b91c1c;">${a.duelos.perdidos}P</span>`
      : `<span style="color:#9ca3af;font-size:11px;">—</span>`;

    return `<tr style="border-top:1px solid #e9e7e0;">
      <!-- Atleta -->
      <td style="padding:10px 12px;vertical-align:middle;">
        <div style="display:flex;align-items:center;gap:8px;">
          ${avatarEl(a.nome, a.fotoUrl)}
          <div>
            <div style="font-size:12px;font-weight:800;color:#1a1a18;">${abrevNome(a.nome)}</div>
            <div style="font-size:9px;color:#9ca3af;text-transform:uppercase;letter-spacing:.04em;">${a.posicao}</div>
          </div>
        </div>
      </td>
      <!-- IGP pré -->
      <td style="padding:10px 8px;vertical-align:middle;text-align:center;">${badgeIGP(a.igp)}</td>
      <!-- Minutos -->
      <td style="padding:10px 8px;vertical-align:middle;text-align:center;">
        <div style="font-size:14px;font-weight:900;color:#1a1a18;">${a.minJogados}'</div>
        <div style="width:40px;height:4px;background:#e9e7e0;border-radius:2px;margin:4px auto 0;">
          <div style="width:${minBar}%;height:100%;background:${minBarCor};border-radius:2px;"></div>
        </div>
      </td>
      <!-- Ações -->
      <td style="padding:10px 8px;vertical-align:middle;text-align:center;">
        <span style="font-size:14px;font-weight:800;color:#374151;">${acoesStr}</span>
      </td>
      <!-- Duelos -->
      <td style="padding:10px 8px;vertical-align:middle;text-align:center;">
        <div style="display:flex;align-items:center;justify-content:center;gap:2px;">${duelosEl}</div>
      </td>
      <!-- Performance -->
      <td style="padding:10px 8px;vertical-align:middle;text-align:center;">${badgeIP(a.ip)}</td>
      <!-- Carga pós -->
      <td style="padding:10px 8px;vertical-align:middle;text-align:center;">
        <span style="font-size:12px;font-weight:700;color:#374151;">${cargaStr}</span>
      </td>
      <!-- Quadrante -->
      <td style="padding:10px 12px;vertical-align:middle;text-align:right;">
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:3px;">
          ${badgeQuadrante(a.quadrante)}
          ${dorStr ? `<span style="font-size:8px;color:#b91c1c;font-weight:700;">Dor: ${dorStr}</span>` : ''}
        </div>
      </td>
    </tr>`;
  }

  // ── Bloco DM ───────────────────────────────────────────────────────────────
  const encDM = dadosAtletas.filter(a =>
    a.quadrante === 'recuperacao' || a.quadrante === 'avaliacao' || a.dor?.length
  );

  // ── Cabeçalho ──────────────────────────────────────────────────────────────
  const pl = meta.placar;
  const placarStr    = pl ? `${pl.pro}–${pl.contra}` : '—';
  const resultadoStr = pl ? (pl.pro > pl.contra ? 'Vitória' : pl.pro === pl.contra ? 'Empate' : 'Derrota') : '';
  const corRes = pl ? (pl.pro > pl.contra ? '#15803d' : pl.pro === pl.contra ? '#a16207' : '#b91c1c') : '#6b7280';
  const dataFmt = meta.data ? meta.data.split('-').reverse().join('/') : '';

  // ── HTML ────────────────────────────────────────────────────────────────────
  const _html = `<!DOCTYPE html><html lang="pt-BR"><head>
  <meta charset="UTF-8">
  <title>Relatório Pós-Jogo · ${meta.adversario}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:'Segoe UI',Arial,sans-serif;background:${BG_PAGE};color:#1a1a18;min-height:100vh;}
    @media print{
      @page{size:A4 landscape;margin:7mm;}
      body{background:#fff!important;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
      .no-print{display:none!important;}
    }
  </style>
  </head><body>
  <div style="max-width:1060px;margin:0 auto;padding:28px 20px;">

    <!-- Header -->
    <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:12px;">
      <div>
        <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:#9a7b4b;margin-bottom:4px;">RELATÓRIO PÓS-JOGO${categoria ? ' · ' + categoria : ''}</div>
        <h1 style="font-size:23px;font-weight:500;color:#1a1a18;">${CLUB_NAME||'Clube'} vs ${meta.adversario}</h1>
        <div style="font-size:13px;color:#6b7280;margin-top:2px;">${dataFmt}${meta.local ? ' · ' + meta.local : ''} · <span style="color:${corRes};font-weight:700;">${resultadoStr} ${placarStr}</span></div>
        <div style="font-size:12px;color:#9ca3af;margin-top:4px;">Gerado em ${new Date().toLocaleDateString('pt-BR')}</div>
        <div style="font-size:10px;color:#9ca3af;margin-top:3px;">DEPTO. DE INTELIGÊNCIA ESPORTIVA - CIENTE IE</div>
      </div>
      <button class="no-print" onclick="window.print()"
        style="padding:8px 20px;background:#1a1a18;color:#fff;border:none;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;flex-shrink:0;">
        Imprimir / PDF
      </button>
    </div>

    <!-- KPI -->
    ${kpiRow}

    <!-- Tabela principal -->
    <div style="background:#fff;border:0.5px solid #e5e7eb;border-radius:8px;overflow:hidden;margin-bottom:16px;">
      <table style="width:100%;border-collapse:collapse;font-size:11px;">
        <thead>
          <tr style="background:${BG_SEC};">
            <th style="padding:9px 12px;text-align:left;font-size:9px;text-transform:uppercase;letter-spacing:.05em;color:#6b7280;font-weight:700;width:17%;">Atleta</th>
            <th style="padding:9px 8px;text-align:center;font-size:9px;text-transform:uppercase;letter-spacing:.05em;color:#6b7280;font-weight:700;width:13%;">IGP Pré</th>
            <th style="padding:9px 8px;text-align:center;font-size:9px;text-transform:uppercase;letter-spacing:.05em;color:#6b7280;font-weight:700;width:7%;">Min</th>
            <th style="padding:9px 8px;text-align:center;font-size:9px;text-transform:uppercase;letter-spacing:.05em;color:#6b7280;font-weight:700;width:8%;">Ações</th>
            <th style="padding:9px 8px;text-align:center;font-size:9px;text-transform:uppercase;letter-spacing:.05em;color:#6b7280;font-weight:700;width:10%;">Duelos G/P</th>
            <th style="padding:9px 8px;text-align:center;font-size:9px;text-transform:uppercase;letter-spacing:.05em;color:#6b7280;font-weight:700;width:15%;">Performance</th>
            <th style="padding:9px 8px;text-align:center;font-size:9px;text-transform:uppercase;letter-spacing:.05em;color:#6b7280;font-weight:700;width:10%;">Carga Pós</th>
            <th style="padding:9px 12px;text-align:right;font-size:9px;text-transform:uppercase;letter-spacing:.05em;color:#6b7280;font-weight:700;width:20%;">D+1/D+2</th>
          </tr>
        </thead>
        <tbody>
          ${dadosAtletas.map(rowAtleta).join('')}
        </tbody>
      </table>
    </div>

    <!-- Legenda -->
    <div style="display:flex;flex-wrap:wrap;gap:14px;margin-bottom:16px;padding:10px 14px;background:${BG_SEC};border-radius:8px;font-size:9px;color:#6b7280;">
      <span><strong>IGP Pré:</strong> prontidão antes do jogo</span>
      <span><strong>Ações:</strong> total de ações no scout</span>
      <span><strong>Duelos G/P:</strong> ganhos (verde) / perdidos (vermelho)</span>
      <span><strong>Performance:</strong> 0–100 · ≥80 Excelente · ≥65 Bom · ≥50 Regular · &lt;50 Baixo</span>
      <span><strong>Carga Pós:</strong> PSE × tempo (u.a.)</span>
      <span><strong>D+1/D+2:</strong> direcionamento de recuperação</span>
      <span>IGP ≥70 Estável · 60–69 At. Leve · 50–59 Atenção · &lt;50 Crítico</span>
    </div>

    ${encDM.length ? `
    <!-- Bloco DM -->
    <div style="border-radius:8px;border:1px solid #fca5a5;background:#fff8f8;overflow:hidden;">
      <div style="display:flex;align-items:center;gap:8px;padding:11px 16px;border-bottom:1px solid #fca5a5;background:#fee2e2;">
        <span style="font-size:14px;">⚕</span>
        <span style="font-size:13px;font-weight:900;color:#b91c1c;">Atenção DM — acompanhamento D+1</span>
        <span style="font-size:11px;color:#b91c1c;opacity:.75;margin-left:auto;">${encDM.length} atleta${encDM.length!==1?'s':''}</span>
      </div>
      <div style="padding:10px 16px;display:flex;flex-wrap:wrap;gap:8px;">
        ${encDM.map(a => `
          <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:8px;background:#fff;border:1px solid #fde8e8;min-width:200px;">
            ${avatarEl(a.nome, a.fotoUrl)}
            <div>
              <div style="font-size:12px;font-weight:800;color:#1a1a18;">${abrevNome(a.nome)}</div>
              <div style="display:flex;gap:4px;margin-top:3px;flex-wrap:wrap;">
                ${badgeQuadrante(a.quadrante)}
                ${a.dor?.length ? `<span style="background:#fee2e2;color:#b91c1c;padding:2px 6px;border-radius:999px;font-size:8px;font-weight:800;">Dor: ${a.dor.join(', ')}</span>` : ''}
              </div>
            </div>
          </div>`).join('')}
      </div>
    </div>` : ''}

  </div>
  </body></html>`;

  const _w = window.open('', '_blank', 'width=1200,height=900');
  if (!_w) { alert('Permita pop-ups no navegador para gerar o relatório.'); return; }
  _w.document.write(_html);
  _w.document.close();
}

// ── Auto-trigger via query param (ex: prontidao.html?relatorio=semanal) ───────
document.addEventListener('prontidaoReady', () => {
  const params = new URLSearchParams(window.location.search);
  const rel = params.get('relatorio');
  if (!rel) return;
  const fnMap = {
    diario:   abrirModalConfirmacaoPDF,
    semanal:  abrirModalRelatorioSemanal,
    posjogo:  abrirModalPosJogo,
  };
  const fn = fnMap[rel];
  if (fn) fn().catch(err => console.error('[auto-trigger] erro:', err));
});

export { abrirModalConfirmacaoPDF, abrirModalRelatorioSemanal, abrirModalPosJogo, abrirRelatorioPosJogoPDF };