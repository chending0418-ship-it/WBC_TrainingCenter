import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.ts';
import { openDatabase } from './database.ts';

if (process.env.NODE_ENV === 'production') {
  throw new Error('The MVP API uses mock login and is available for local development only.');
}

const path = process.env.WBC_DB_PATH
  ? resolve(process.env.WBC_DB_PATH)
  : fileURLToPath(new URL('../data/wbc.sqlite', import.meta.url));
mkdirSync(dirname(path), { recursive: true });
const app = createApp(openDatabase(path));
console.log(await app.listen({ host: '127.0.0.1', port: Number(process.env.WBC_PORT ?? 3000) }));
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close();
  });
}
