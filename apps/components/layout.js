// Inject mobile sidebar CSS immediately (before DOMContentLoaded / before sidebar HTML is fetched)
// This prevents any flash where the w-64 aside appears in the flex layout before JS sets position:fixed
!function(){
  var s = document.createElement('style');
  s.textContent = '@media (max-width:767px){#sidebar-container{width:0!important;overflow:visible;flex-shrink:0}#sidebarDrawer{position:fixed!important;top:0;left:0;bottom:0;width:min(85vw,260px)!important;transform:translateX(-100%);z-index:60;overflow-y:auto}}';
  document.head.appendChild(s);
}();

document.addEventListener("DOMContentLoaded", async () => {

  const container = document.getElementById("sidebar-container");
  if (!container) return;

  try {
    const response = await fetch("/components/sidebar.html");
    const html = await response.text();
    container.innerHTML = html;

    destacarPaginaAtiva();
    inicializarSidebar();
    inicializarAcordeon();
    inicializarMobileDrawer(container);

  } catch (error) {
    console.error("Erro ao carregar sidebar:", error);
  }

});

function inicializarAcordeon() {
  const currentPath = window.location.pathname;

  let state = {};
  try { state = JSON.parse(localStorage.getItem("sidebarAccordion") || "{}"); } catch(e) {}

  document.querySelectorAll(".acc-section").forEach(section => {
    const key     = section.dataset.section;
    const toggle  = section.querySelector(".acc-toggle");
    const content = section.querySelector(".acc-content");
    const chevron = section.querySelector(".acc-chevron");
    if (!toggle || !content) return;

    // Auto-open if any link in this section matches the current page
    const links = Array.from(section.querySelectorAll("a.menu-link"));
    const isActive = links.some(l => {
      const href = l.getAttribute("href");
      return href && currentPath.includes(href);
    });

    const shouldOpen = isActive || state[key] === true;

    function setOpen(open) {
      content.style.display = open ? "block" : "none";
      if (chevron) chevron.style.transform = open ? "rotate(180deg)" : "rotate(0deg)";
    }

    setOpen(shouldOpen);

    toggle.addEventListener("click", () => {
      const isOpen = content.style.display !== "none";
      setOpen(!isOpen);
      state[key] = !isOpen;
      try { localStorage.setItem("sidebarAccordion", JSON.stringify(state)); } catch(e) {}
    });
  });
}

function inicializarMobileDrawer(container) {
  const drawer   = document.getElementById("sidebarDrawer");
  const closeBtn = document.getElementById("sidebarClose");
  if (!drawer) return;

  // ── Overlay ──────────────────────────────────────────────
  const overlay = document.createElement("div");
  overlay.id = "sidebarOverlay";
  Object.assign(overlay.style, {
    position: "fixed", inset: "0", zIndex: "59",
    background: "rgba(0,0,0,0.5)", display: "none"
  });
  document.body.appendChild(overlay);

  // ── Botão hambúrguer ─────────────────────────────────────
  const hamburger = document.createElement("button");
  hamburger.id = "sidebarToggle";
  hamburger.setAttribute("aria-label", "Abrir menu");
  hamburger.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="white" stroke-width="2.5">
    <path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h16"/>
  </svg>`;
  Object.assign(hamburger.style, {
    position: "fixed", top: "12px", left: "12px", zIndex: "70",
    width: "40px", height: "40px", background: "#1e293b",
    border: "none", borderRadius: "8px", cursor: "pointer",
    display: "none",
    alignItems: "center", justifyContent: "center",
    boxShadow: "0 2px 8px rgba(0,0,0,0.3)"
  });
  document.body.appendChild(hamburger);

  // ── Posicionamento responsivo ─────────────────────────────
  function applyLayout() {
    const mobile = window.innerWidth < 768;

    if (mobile) {
      Object.assign(drawer.style, {
        position: "fixed", top: "0", left: "0", bottom: "0",
        zIndex: "60", height: "100vh",
        width: "min(85vw, 260px)",
        transform: "translateX(-100%)",
        transition: "transform 0.22s ease",
        overflowY: "auto"
      });
      if (closeBtn) closeBtn.style.display = "flex";
      container.style.width = "0";
      container.style.flexShrink = "0";
      container.style.overflow = "visible";
      hamburger.style.display = "flex";
    } else {
      Object.assign(drawer.style, {
        position: "static", height: "auto",
        transform: "none", transition: "none",
        zIndex: "auto"
      });
      if (closeBtn) closeBtn.style.display = "none";
      container.style.width = "";
      container.style.flexShrink = "";
      hamburger.style.display = "none";
      overlay.style.display = "none";
      document.body.style.overflow = "";
    }
  }

  applyLayout();
  window.addEventListener("resize", applyLayout);

  // ── Abrir / fechar ────────────────────────────────────────
  function openSidebar() {
    drawer.style.transform = "translateX(0)";
    overlay.style.display  = "block";
    document.body.style.overflow = "hidden";
  }

  function closeSidebar() {
    drawer.style.transform = "translateX(-100%)";
    overlay.style.display  = "none";
    document.body.style.overflow = "";
  }

  hamburger.addEventListener("click", openSidebar);
  overlay.addEventListener("click", closeSidebar);
  if (closeBtn) closeBtn.addEventListener("click", closeSidebar);

  // Fechar ao navegar (mobile)
  drawer.querySelectorAll("a.menu-link").forEach(link => {
    link.addEventListener("click", () => {
      if (window.innerWidth < 768) closeSidebar();
    });
  });
}

function inicializarSidebar() {
  try {
    const ctx = JSON.parse(localStorage.getItem("userContext") || "{}");
    const el  = document.getElementById("sidebarClubName");
    if (el && ctx?.clubId) {
      el.textContent = ctx.clubId.replace(/_/g, " ").toUpperCase();
    }
    const logoEl = document.getElementById("sidebarClubLogo");
    if (logoEl && ctx?.clubLogoUrl) {
      logoEl.src = ctx.clubLogoUrl;
      logoEl.style.display = "block";
    }
    if (ctx?.role === "admin") {
      const adminSection = document.getElementById("adminSection");
      if (adminSection) adminSection.style.display = "block";
    }

    // Módulo GPS (Polar/Catapult): disponível para todos os clubes
    if (ctx?.clubId) {
      document.querySelectorAll('.gps-feature').forEach(el => el.style.display = '');
    }
    // Importar Planilha GPS personalizada: exclusivo para ponte_preta
    if (ctx?.clubId === 'ponte_preta') {
      document.querySelectorAll('.gps-planilha-feature').forEach(el => el.style.display = '');
    }
  } catch(e) {}

  const btnLogout = document.getElementById("btnLogout");
  if (!btnLogout) return;

  btnLogout.addEventListener("click", async () => {
    try {
      const { signOut } = await import("https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js");
      const { auth }    = await import("/core/firebase.js");
      await signOut(auth);
    } catch(e) {
      console.warn("signOut erro:", e);
    } finally {
      localStorage.removeItem("userContext");
      localStorage.removeItem("athleteContext");
      window.location.href = "/login.html";
    }
  });
}

function destacarPaginaAtiva() {
  const currentPath = window.location.pathname;
  document.querySelectorAll(".menu-link").forEach(link => {
    const href = link.getAttribute("href");
    if (href && currentPath.includes(href)) {
      link.classList.add("bg-slate-700", "text-white");
    }
  });
}
