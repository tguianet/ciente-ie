import {
  getAuth,
  signInWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  signOut
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js";

import {
  doc,
  getDoc
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";

import { auth, db } from "./core/firebase.js";

const form  = document.getElementById("loginForm");
const erro  = document.getElementById("erro");

async function finalizarLogin(cred) {
    const snap = await getDoc(doc(db, "users", cred.user.uid));
    if (!snap.exists()) throw new Error("Usuário sem perfil");

    const userData = snap.data();

    let clubExtra = {};
    if (userData.clubId) {
      try {
        const clubSnap = await getDoc(doc(db, "clubs", userData.clubId));
        if (clubSnap.exists()) {
          const cd = clubSnap.data();
          clubExtra = {
            clubName:    cd.name         ?? null,
            clubLogoUrl: cd.logoUrl      ?? null,
            clubColor:   cd.primaryColor ?? null,
          };
        }
      } catch(_) {}
    }

    localStorage.setItem("userContext", JSON.stringify({
      ...userData,
      ...clubExtra,
      uid: cred.user.uid
    }));

    if (userData.role === "admin" && !userData.clubId) {
      window.location.href = "staff/admin_clubes.html";
    } else if (userData.role === "staff" || userData.role === "admin") {
      window.location.href = "staff/index.html";
    } else {
      window.location.href = "selecionar_atleta.html";
    }
}

document.getElementById("btnGoogle").addEventListener("click", async () => {
  erro.classList.add("hidden");
  try {
    await signOut(auth);
    const cred = await signInWithPopup(auth, new GoogleAuthProvider());
    await finalizarLogin(cred);
  } catch (err) {
    erro.textContent = err.message === "Usuário sem perfil"
      ? "Conta Google não autorizada na plataforma."
      : "Erro ao entrar com Google.";
    erro.classList.remove("hidden");
  }
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  erro.classList.add("hidden");

  const email = document.getElementById("email").value;
  const senha = document.getElementById("senha").value;

  try {
    await signOut(auth);
    const cred = await signInWithEmailAndPassword(auth, email, senha);
    await finalizarLogin(cred);
  } catch (err) {
    erro.textContent = "Login inválido ou usuário não autorizado.";
    erro.classList.remove("hidden");
  }
});
