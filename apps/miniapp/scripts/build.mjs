import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const project = fileURLToPath(new URL('../', import.meta.url));
const source = join(project, 'src');
const output = join(project, 'dist');

execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', project], { stdio: 'inherit' });
const files = readdirSync(source, { recursive: true });
const scripts = files.filter(name => name.endsWith('.ts')).map(name => name.replace(/\.ts$/, '.js'));
const assets = files.filter(name => /\.(json|wxml|wxss)$/.test(name));
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
