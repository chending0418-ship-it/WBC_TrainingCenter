import { allowPage, signOut } from '../../lib/session';
import type { Account, Child } from '../../../../../packages/shared/contracts.js';
import { api, errorMessage } from '../../lib/client';
import { datetime } from '../../lib/display';

Page({
  data: {
    authorized: false,
    balance: 0,
    reservedPoints: 0,
    ledger: [] as { id: number; reason: string; change: string; date: string }[],
    childName: '',
    loading: true,
    error: ''
  },

  onShow() {
    const authorized = allowPage('PARENT', true);
    this.setData({ authorized });
    if (authorized) void this.refresh();
  },

  signOut,

  async refresh() {
    this.setData({ loading: true, error: '' });
    try {
      const [account, profile] = await Promise.all([
        api<Account>('/api/me/account'), api<{ child: Child | null }>('/api/me/child')
      ]);
      const ledger = account.ledger.map(entry => ({
        id: entry.id,
        reason: entry.reason,
        change: (entry.delta > 0 ? '+' : '') + entry.delta,
        date: datetime(entry.createdAt)
      }));
      this.setData({ balance: account.balance - account.reservedPoints, reservedPoints: account.reservedPoints,
        ledger, childName: profile.child?.name ?? '' });
    } catch (error) {
      this.setData({ error: errorMessage(error) });
    } finally {
      this.setData({ loading: false });
    }
  }
});
