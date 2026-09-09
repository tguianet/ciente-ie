import { auth, db } from "./firebase.js";
import { onAuthStateChanged } from
  "https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js";
import { doc, getDoc } from
  "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";

const isStaffPage = window.location.pathname.includes("/staff/")
                 || window.location.pathname.includes("/assessments/");

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.href = "/login.html";
    return;
  }

  // Lê role da fonte autoritativa (Firestore), não do localStorage
  let role = null;
  try {
    const userSnap = await getDoc(doc(db, "users", user.uid));
    if (userSnap.exists()) {
      role = userSnap.data().role ?? null;
      // Mantém localStorage sincronizado com a fonte autoritativa
      const ctx = JSON.parse(localStorage.getItem("userContext") || "{}");
      if (ctx.role !== role) {
        ctx.role = role;
        localStorage.setItem("userContext", JSON.stringify(ctx));
      }
    }
  } catch(e) {
    console.error("authGuard: falha ao verificar role", e);
  }

  if (isStaffPage && role !== "staff" && role !== "admin") {
    window.location.href = "/selecionar_atleta.html";
  }
});
