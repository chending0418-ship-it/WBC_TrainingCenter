import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const project = fileURLToPath(new URL('../', import.meta.url));
const source = join(project, 'src');
const output = join(project, 'dist');
const args = process.argv.slice(2);
if (args.length && (args.length !== 1 || args[0] !== '--production')) {
  throw new Error('Usage: npm run build:miniapp -- [--production]');
}

execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', project], { stdio: 'inherit' });
const files = readdirSync(source, { recursive: true });
const scripts = files.filter(name => name.endsWith('.ts')).map(name => name.replace(/\.ts$/, '.js'));
const assets = files.filter(name => /\.(json|wxml|wxss|svg|jpg|png)$/.test(name));
for (const name of assets) {
  const destination = join(output, name);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(join(source, name), destination);
}
const expected = new Set([...scripts, ...assets]);
for (const name of readdirSync(output, { recursive: true, withFileTypes: true })) {
  if (!name.isFile()) continue;
  const path = join(name.parentPath, name.name);
  if (!expected.has(path.slice(output.length + 1))) rmSync(path);
}

if (args[0] === '--production') {
  const config = { mode: 'wechat', apiBase: 'https://baseballmaster.cc/wbc/training-miniapp' };
  writeFileSync(join(output, 'lib/config.js'), 'exports.config = ' + JSON.stringify(config) + ';\n');
}
