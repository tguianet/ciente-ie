'use strict';

const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { defineSecret } = require('firebase-functions/params');
const { HttpsError, onCall } = require('firebase-functions/v2/https');

initializeApp();

const anthropicApiKey = defineSecret('ANTHROPIC_API_KEY');
const geminiApiKey = defineSecret('GEMINI_API_KEY');
const DAILY_LIMIT = 20;
const MONTHLY_LIMIT = 100;

function requireString(value, field, maxLength) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpsError('invalid-argument', `${field} é obrigatório.`);
  }
  if (value.length > maxLength) {
    throw new HttpsError('invalid-argument', `${field} excede o tamanho permitido.`);
  }
  return value.trim();
}

function utcDateParts(now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  const month = day.slice(0, 7);
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { day, month, nextMonth };
}

async function authorizeAndReserve(uid) {
  const db = getFirestore();
  const userSnap = await db.doc(`users/${uid}`).get();
  if (!userSnap.exists) throw new HttpsError('permission-denied', 'Usuário sem perfil de acesso.');

  const user = userSnap.data();
  if (!['staff', 'admin'].includes(user.role) || typeof user.clubId !== 'string' || !user.clubId) {
    throw new HttpsError('permission-denied', 'Acesso à IA não autorizado.');
  }

  const usageRef = db.doc(`ai_usage/${user.clubId}`);
  await db.runTransaction(async transaction => {
    const snap = await transaction.get(usageRef);
    const usage = snap.exists ? snap.data() : {};
    const { day, month, nextMonth } = utcDateParts();
    const dailyCount = usage.ultima_pergunta === day ? Number(usage.perguntas_hoje || 0) : 0;
    const resetDate = usage.reset_em?.toDate?.();
    const legacyCurrentMonth = !usage.mes_referencia && resetDate instanceof Date && resetDate > new Date();
    const monthlyCount = (usage.mes_referencia === month || legacyCurrentMonth)
      ? Number(usage.perguntas_mes || 0) : 0;
    const dailyLimit = Number(usage.limite_dia || DAILY_LIMIT);
    const monthlyLimit = Number(usage.limite_mes || MONTHLY_LIMIT);

    if (dailyCount >= dailyLimit) throw new HttpsError('resource-exhausted', 'Limite diário de IA atingido.');
    if (monthlyCount >= monthlyLimit) throw new HttpsError('resource-exhausted', 'Limite mensal de IA atingido.');

    transaction.set(usageRef, {
      perguntas_hoje: dailyCount + 1,
      perguntas_mes: monthlyCount + 1,
      limite_dia: dailyLimit,
      limite_mes: monthlyLimit,
      ultima_pergunta: day,
      mes_referencia: month,
      reset_em: Timestamp.fromDate(nextMonth),
      atualizado_em: FieldValue.serverTimestamp()
    }, { merge: true });
  });
  return user.clubId;
}

async function releaseReservation(clubId) {
  const db = getFirestore();
  const usageRef = db.doc(`ai_usage/${clubId}`);
  await db.runTransaction(async transaction => {
    const snap = await transaction.get(usageRef);
    if (!snap.exists) return;
    const usage = snap.data();
    const { day, month } = utcDateParts();
    const updates = {};
    if (usage.ultima_pergunta === day) {
      updates.perguntas_hoje = Math.max(0, Number(usage.perguntas_hoje || 0) - 1);
    }
    if (usage.mes_referencia === month) {
      updates.perguntas_mes = Math.max(0, Number(usage.perguntas_mes || 0) - 1);
    }
    if (Object.keys(updates).length) transaction.update(usageRef, updates);
  });
}

async function callAnthropic({ context, question, systemPrompt, maxTokens }) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': anthropicApiKey.value(),
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: Math.min(maxTokens, 3500),
      system: systemPrompt,
      messages: [{ role: 'user', content: `DADOS DO ELENCO:\n${context}\n\nPERGUNTA: ${question}` }]
    })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message || `Anthropic HTTP ${response.status}`);
  return body.content?.[0]?.text || 'Sem resposta.';
}

async function callGemini({ context, question, systemPrompt, maxTokens }) {
  const endpoint = 'https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent';
  const response = await fetch(`${endpoint}?key=${encodeURIComponent(geminiApiKey.value())}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: `${systemPrompt}\n\n${context}\n\nPERGUNTA: ${question}` }] }],
      generationConfig: { temperature: 0.25, maxOutputTokens: Math.min(maxTokens, 400) }
    })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message || `Gemini HTTP ${response.status}`);
  return body?.candidates?.[0]?.content?.parts?.[0]?.text || 'Sem resposta.';
}

exports.askAi = onCall({
  region: 'us-central1',
  timeoutSeconds: 120,
  memory: '256MiB',
  secrets: [anthropicApiKey, geminiApiKey]
}, async request => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Faça login para usar a IA.');

  const data = request.data || {};
  if (!['anthropic', 'gemini'].includes(data.provider)) {
    throw new HttpsError('invalid-argument', 'Provedor de IA inválido.');
  }
  const payload = {
    context: requireString(data.context, 'context', 100000),
    question: requireString(data.question, 'question', 2000),
    systemPrompt: requireString(data.systemPrompt, 'systemPrompt', 30000),
    maxTokens: Number.isInteger(data.maxTokens) && data.maxTokens > 0 ? data.maxTokens : 2000
  };

  const clubId = await authorizeAndReserve(request.auth.uid);
  try {
    const text = data.provider === 'anthropic'
      ? await callAnthropic(payload)
      : await callGemini(payload);
    return { text };
  } catch (error) {
    await releaseReservation(clubId).catch(() => {});
    // Nunca registrar prompts, contexto de atletas ou segredos.
    console.error('Falha no provedor de IA:', error?.message || 'erro desconhecido');
    throw new HttpsError('internal', 'O provedor de IA não respondeu. Tente novamente.');
  }
});
