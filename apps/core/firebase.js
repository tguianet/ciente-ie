import { initializeApp } from
  "https://www.gstatic.com/firebasejs/11.0.1/firebase-app.js";

import {
  getFirestore
} from
  "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";

import {
  getAuth
} from
  "https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js";

import {
  getStorage
} from
  "https://www.gstatic.com/firebasejs/11.0.1/firebase-storage.js";

/* ============================
   CONFIG
============================ */

const firebaseConfig = {
  apiKey: "AIzaSyD9gvY2TtH_MFIqbotCiCse8UFL0V13peI",
  authDomain: "ciente-inteligencia-espo-cba43.firebaseapp.com",
  projectId: "ciente-inteligencia-espo-cba43",
  storageBucket: "ciente-inteligencia-espo-cba43.firebasestorage.app",
  messagingSenderId: "921319294892",
  appId: "1:921319294892:web:7a5ff0283abb7323c19c09"
};

/* ============================
   INIT
============================ */

const app = initializeApp(firebaseConfig);

export const db      = getFirestore(app);
export const auth    = getAuth(app);
export const storage = getStorage(app);
