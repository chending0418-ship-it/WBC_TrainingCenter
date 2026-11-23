import { showParentTab } from '../../lib/session';
import type { Account, Registration } from '../../../../../packages/shared/contracts.js';
import { api, errorMessage } from '../../lib/client';
import { registrationLabels } from '../../lib/registration';
import { datetime } from '../../lib/display';

Page({
  data: {
    authorized: false,
    balance: 0,
    reservedPoints: 0,
    ledger: [] as { id: number; reason: string; change: string; date: string }[],
    registrationLabel: '注册队员',
    loading: true,
    error: ''
  },

  onShow() {
    const authorized = showParentTab(this);
    this.setData({ authorized });
    if (authorized) void this.refresh();
  },


  async refresh() {
    this.setData({ loading: true, error: '' });
    try {
      const [account, profile] = await Promise.all([
        api<Account>('/api/me/account'), api<{ registration: Registration | null }>('/api/me/registration')
      ]);
      const ledger = account.ledger.map(entry => ({
        id: entry.id,
        reason: entry.reason,
        change: (entry.delta > 0 ? '+' : '') + entry.delta,
        date: datetime(entry.createdAt)
      }));
      this.setData({ balance: account.balance - account.reservedPoints, reservedPoints: account.reservedPoints,
        ledger, registrationLabel: profile.registration ? profile.registration.child.name + ' · ' + registrationLabels[profile.registration.status] : '注册队员' });
    } catch (error) {
      this.setData({ error: errorMessage(error) });
    } finally {
      this.setData({ loading: false });
    }
  }
});
