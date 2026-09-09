// assets/js/hrv_save.js
import { upsertDailyMetrics } from "./dailyMetrics.service.js";

/**
 * Salva HRV no daily_metrics
 */
export async function salvarHRV({
  athleteId,
  date,
  lnRR,
  rmssd = null,
  rr_medio = null,
  fc_media = null,
  score = null,
  status = null,
  protocolo = null,
  duracao = null,
  qualidade_sinal = null,
  artefatos_pct = null
}) {

  const hora = new Date().getHours();
  const horario =
    hora < 12 ? "manha" : hora < 18 ? "tarde" : "noite";

  await upsertDailyMetrics({
    athleteId,
    date,
    block: "hrv",
    data: {
      lnRR,
      rmssd,
      rr_medio,
      fc_media,
      score,
      status,
      protocolo,
      duracao,
      horario,
      origem: "polar_h10",
      qualidade_sinal,
      artefatos_pct,
      features: {
        z_lnRR: null,
        tendencia_7d: null,
        delta_pre: null
      }
    }
  });
}
