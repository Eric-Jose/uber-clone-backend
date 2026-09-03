const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCAN_DIRS = ['routes', 'scripts'];

// Proteção contra uma alteração futura que substitua/remova a coleção inteira de usuários.
// Operações em /users/{uid} continuam permitidas.
const FORBIDDEN = [
  /\.ref\(\s*['"`]users['"`]\s*\)\s*\.\s*(set|update|remove)\s*\(/g,
  /ref\(\s*['"`]users['"`]\s*\)\s*\.\s*(set|update|remove)\s*\(/g,
];

function collectJavaScriptFiles(dir) {
  const result = [];
  if (!fs.existsSync(dir)) return result;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...collectJavaScriptFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.js')) result.push(full);
  }
  return result;
}

const files = SCAN_DIRS.flatMap((dir) => collectJavaScriptFiles(path.join(ROOT, dir)));
const violations = [];

for (const file of files) {
  const content = fs.readFileSync(file, 'utf8');
  for (const pattern of FORBIDDEN) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const line = content.slice(0, match.index).split('\n').length;
      violations.push(`${path.relative(ROOT, file)}:${line}: ${match[0]}`);
    }
  }
}

if (violations.length) {
  console.error('ERRO DE SEGURANÇA DE DADOS: não é permitido alterar/remover a coleção inteira /users.');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(`Proteção de dados OK: ${files.length} arquivos JavaScript verificados.`);
console.log('Operações devem atingir usuários individualmente em /users/{uid}.');
