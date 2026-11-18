import { existsSync } from 'node:fs';
import { openDatabase } from './database.ts';
import { changeWechatRole } from './wechat-role-binding.ts';

function run() {
  const { WBC_DB_PATH: path, WBC_WECHAT_APP_ID: appId } = process.env;
  if (!path || !existsSync(path) || !appId) throw new Error('请指定现有数据库的 WBC_DB_PATH 和小程序 WBC_WECHAT_APP_ID');
  const [command, accountId, coachId, ...extra] = process.argv.slice(2);
  const db = openDatabase(path);
  try {
    if (command === 'list-coaches' && !accountId) {
      for (const coach of db.prepare('SELECT id, name FROM coaches WHERE enabled = 1 ORDER BY name').all()) {
        console.log(coach.id, coach.name);
      }
      return;
    }
    if ((command !== 'grant-admin' && command !== 'revoke-admin' && command !== 'bind-coach' && command !== 'unbind-coach') ||
        !accountId || (command === 'bind-coach' ? !coachId : !!coachId) || extra.length) {
      throw new Error('用法：list-coaches | grant-admin <账号ID> | revoke-admin <账号ID> | bind-coach <账号ID> <教练ID> | unbind-coach <账号ID>');
    }
    changeWechatRole(db, appId, accountId, command, coachId, new Date().toISOString());
    console.log('角色绑定已保存');
  } finally {
    db.close();
  }
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.message : '角色绑定失败');
  process.exitCode = 1;
}
