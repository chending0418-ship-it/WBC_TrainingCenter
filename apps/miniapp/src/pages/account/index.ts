import { familyContext, canSwitchRole, parentAccountId, switchRole, invalidateRead, readVersion, showParentTab } from '../../lib/session';
import type { Account, Registration } from '../../../../../packages/shared/contracts.js';
import { api, errorMessage, RequestError } from '../../lib/client';
import { registrationLabels } from '../../lib/registration';
import { datetime } from '../../lib/display';

const accountPath = '/api/me/account?limit=25';
const registrationPath = '/api/me/registration';

function ledgerRows(account: Account) {
  return account.ledger.map(entry => ({
    id: entry.id,
    reason: entry.reason, training: entry.trainingStart ? datetime(entry.trainingStart) + ' · ' + entry.trainingTitle : '',
    change: (entry.delta > 0 ? '+' : '') + entry.delta,
    date: datetime(entry.createdAt)
  }));
}

Page({
  data: {
    playerName: '', authorized: false, canSwitch: false,
    balance: 0,
    reservedPoints: 0, nextBefore: null as number | null, moreBusy: false,
    ledger: [] as { id: number; reason: string; change: string; date: string }[],
    registrationLabel: '注册队员',
    loaded: false, loading: true,
    error: ''
  },

  switchRole,
  copyAccountId() {
    const id = parentAccountId();
    if (id) wx.setClipboardData({ data: id });
  },
  accountVersion: 0,
  registrationVersion: 0,
  displayedPlayer: undefined as string | undefined,
  sequence: 0,
  onUnload() { this.sequence++; },
  onShow() {
    const authorized = showParentTab(this);
    if (authorized !== this.data.authorized) this.setData({ authorized, canSwitch: canSwitchRole() });
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

  async loadMore() {
    const before = this.data.nextBefore, seq = this.sequence;
    if (!before || this.data.moreBusy) return;
    this.setData({ moreBusy: true });
    try {
      const page = await api<Account>(accountPath + '&before=' + before);
      if (seq === this.sequence) this.setData({ ledger: [...this.data.ledger,...ledgerRows(page)],nextBefore: page.nextBefore ?? null });
    } catch (error) { wx.showToast({ title: errorMessage(error),icon: 'none' }); }
    finally { this.setData({ moreBusy: false }); }
  },
  async refresh() {
    const request = ++this.sequence;
    if (this.data.error) this.setData({ error: '', loading: !this.data.loaded });
    try {
      const { current } = await familyContext();
      if (request !== this.sequence) return;
      if (this.data.playerName !== (current?.name ?? '') || this.displayedPlayer !== current?.id) {
        this.displayedPlayer = current?.id;
        this.setData({ playerName: current?.name ?? '', loaded: false, loading: true });
      }
      const [account, profile] = await Promise.all([
        api<Account>(accountPath), api<{ registration: Registration | null }>(registrationPath)
      ]);
      if (request !== this.sequence) return;
      this.accountVersion = readVersion(accountPath);
      this.registrationVersion = readVersion(registrationPath);
      this.setData({ loaded: true, balance: account.balance - account.reservedPoints, reservedPoints: account.reservedPoints,
        ledger: ledgerRows(account),nextBefore: account.nextBefore ?? null, registrationLabel: profile.registration ? profile.registration.child.name + ' · ' + registrationLabels[profile.registration.status] : '注册队员' });
    } catch (error) {
      if (request === this.sequence) this.setData({ error: errorMessage(error),
        ...(error instanceof RequestError && error.code === 'PLAYER_ACCESS_DENIED' ? { loaded: false, playerName: '' } : {}) });
    } finally {
      if (request === this.sequence && this.data.loading) this.setData({ loading: false });
    }
  }
});
