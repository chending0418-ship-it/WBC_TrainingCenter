import { invalidateRead, readVersion, showParentTab } from '../../lib/session';
import type { Account, Registration } from '../../../../../packages/shared/contracts.js';
import { api, errorMessage } from '../../lib/client';
import { registrationLabels } from '../../lib/registration';
import { datetime } from '../../lib/display';

const accountPath = '/api/me/account';
const registrationPath = '/api/me/registration';

Page({
  data: {
    authorized: false,
    balance: 0,
    reservedPoints: 0,
    ledger: [] as { id: number; reason: string; change: string; date: string }[],
    registrationLabel: '注册队员',
    loaded: false, loading: true,
    error: ''
  },

  accountVersion: 0,
  registrationVersion: 0,
  sequence: 0,
  onUnload() { this.sequence++; },
  onShow() {
    const authorized = showParentTab(this);
    if (authorized !== this.data.authorized) this.setData({ authorized });
    if (!authorized) return;
    if (this.accountVersion && this.accountVersion === readVersion(accountPath) &&
        this.registrationVersion && this.registrationVersion === readVersion(registrationPath)) return;
    void this.refresh();
  },
  async onPullDownRefresh() {
    try {
      if (!this.data.authorized) return;
      invalidateRead(accountPath);
      invalidateRead(registrationPath);
      await this.refresh();
    } finally { wx.stopPullDownRefresh(); }
  },

  async refresh() {
    const request = ++this.sequence;
    if (this.data.error) this.setData({ error: '', loading: !this.data.loaded });
    try {
      const [account, profile] = await Promise.all([
        api<Account>(accountPath), api<{ registration: Registration | null }>(registrationPath)
      ]);
      if (request !== this.sequence) return;
      this.accountVersion = readVersion(accountPath);
      this.registrationVersion = readVersion(registrationPath);
      const ledger = account.ledger.map(entry => ({
        id: entry.id,
        reason: entry.reason,
        change: (entry.delta > 0 ? '+' : '') + entry.delta,
        date: datetime(entry.createdAt)
      }));
      this.setData({ loaded: true, balance: account.balance - account.reservedPoints, reservedPoints: account.reservedPoints,
        ledger, registrationLabel: profile.registration ? profile.registration.child.name + ' · ' + registrationLabels[profile.registration.status] : '注册队员' });
    } catch (error) {
      if (request === this.sequence) this.setData({ error: errorMessage(error) });
    } finally {
      if (request === this.sequence && this.data.loading) this.setData({ loading: false });
    }
  }
});
