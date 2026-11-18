import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.ts';
import { openDatabase } from './database.ts';
import { wechatLoginConfig } from './wechat-login.ts';

const demo = process.env.NODE_ENV !== 'production';
if (!demo && !process.env.WBC_DB_PATH) throw new Error('WBC_DB_PATH is required in production.');

const { WBC_WECHAT_APP_ID: appId, WBC_WECHAT_APP_SECRET: appSecret } = process.env;
if (!demo && Boolean(appId) !== Boolean(appSecret)) throw new Error('Configure both WBC_WECHAT_APP_ID and WBC_WECHAT_APP_SECRET.');
const wechat = !demo && appId && appSecret ? wechatLoginConfig(appId, appSecret) : undefined;

const path = process.env.WBC_DB_PATH
  ? resolve(process.env.WBC_DB_PATH)
  : fileURLToPath(new URL('../data/wbc.sqlite', import.meta.url));
mkdirSync(dirname(path), { recursive: true });
const app = createApp(openDatabase(path), undefined, { demo, wechat });
console.log(await app.listen({ host: '127.0.0.1', port: Number(process.env.WBC_PORT ?? 3000) }));
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close();
  });
}
