/**
 * chat_widget.js — Botão flutuante do Analista IA
 * Usado em dashboard.html e prontidao.html
 * Redireciona para a página completa do chat ao clicar.
 */

function injectStyles() {
  if (document.getElementById('ai-widget-style')) return;
  const s = document.createElement('style');
  s.id = 'ai-widget-style';
  s.textContent = `
    #aiWidgetBtn { position:fixed;top:72px;right:18px;z-index:900;display:flex;align-items:center;gap:7px;padding:8px 20px;background:#1d4ed8;color:#fff;border:none;border-radius:999px;font-size:12px;font-weight:700;cursor:pointer;box-shadow:0 2px 12px rgba(29,78,216,.45);transition:background .15s;white-space:nowrap;text-decoration:none; }
    #aiWidgetBtn:hover { background:#2563eb; }
  `;
  document.head.appendChild(s);
}

function buildWidget() {
  injectStyles();
  const btn = document.createElement('a');
  btn.id = 'aiWidgetBtn';
  btn.href = '/staff/analista_ia.html';
  btn.innerHTML = '<span style="font-size:14px">🤖</span> Ciente IA — Assistente Inteligente';
  document.body.appendChild(btn);
}

buildWidget();
