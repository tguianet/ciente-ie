/**
 * build.js — copia apps/ → dist/ e minifica todos os .js
 * Uso: npm run build
 */

const { minify } = require('terser');
const fs   = require('fs');
const path = require('path');

const SRC  = path.join(__dirname, 'apps');
const DIST = path.join(__dirname, 'dist');

// Copia recursiva de diretório
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src,  entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else                     fs.copyFileSync(s, d);
  }
}

// Coleta todos os .js recursivamente
function findJs(dir, list = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) findJs(p, list);
    else if (entry.name.endsWith('.js')) list.push(p);
  }
  return list;
}

async function build() {
  // 1. Limpa e recria dist/
  console.log('📦 Copiando apps/ → dist/...');
  if (fs.existsSync(DIST)) fs.rmSync(DIST, { recursive: true, force: true });
  copyDir(SRC, DIST);

  // 2. Minifica cada .js
  console.log('🔧 Minificando .js...\n');
  const files = findJs(DIST);
  let ok = 0, skip = 0;

  for (const file of files) {
    const rel  = path.relative(DIST, file);
    const code = fs.readFileSync(file, 'utf8');
    try {
      const result = await minify(code, {
        module:   true,           // suporte a import/export
        compress: { drop_console: false },
        mangle:   true,           // renomeia variáveis
        format:   { comments: false },
      });
      if (result.code) {
        fs.writeFileSync(file, result.code, 'utf8');
        console.log(`  ✓ ${rel}`);
        ok++;
      }
    } catch (e) {
      // Arquivo com sintaxe incompatível — mantém original sem minificar
      console.warn(`  ⚠ ${rel} (mantido original: ${e.message.split('\n')[0]})`);
      skip++;
    }
  }

  console.log(`\n✅ Build completo — ${ok} minificados, ${skip} mantidos`);
  console.log('👉 Rode agora: firebase deploy --only hosting\n');
}

build().catch(err => { console.error('❌ Erro no build:', err); process.exit(1); });
