import { roleRequest, wechatIdentity } from '../../lib/session';
import { askSubscription, templateIdsFor } from '../../lib/subscription-request';
import type { ReminderResult, ReminderTemplate, ReminderTopic } from '../../lib/subscription-request';
import { recordGrant, retryGrants, subscriptionPath } from '../../lib/subscription-receipts';

const labels = { registration: '订阅审核结果', booking: '订阅预约提醒', admin: '订阅待办提醒' };
const messages: Record<ReminderResult, string> = {
  accepted: '已订阅，可再次点击补充提醒次数。',
  partial: '已订阅部分提醒，可再次选择。',
  declined: '此次未订阅。可在小程序设置中调整订阅权限。',
  disabled: '订阅通知已关闭，可前往小程序设置开启。',
  failed: '此次订阅未成功，请重试。',
  unrecorded: '微信已授权，提醒暂未登记成功。',
  unavailable: ''
};

Component({
  properties: {
    topic: { type: String, value: 'booking' as ReminderTopic },
    manual: { type: Boolean, value: true }
  },
  data: { ids: [] as string[], accountId: '', label: '', message: '', showSettings: false, busy: false, loadFailed: false },
  lifetimes: { attached() { void this.load(); } },
  pageLifetimes: { show() { void this.load(); } },
  methods: {
    async load() {
      const identity = wechatIdentity();
      if (!identity || typeof wx.requestSubscribeMessage !== 'function') {
        if (this.data.accountId) this.setData({ accountId: '', ids: [], message: '', showSettings: false, loadFailed: false });
        return;
      }
      const topic = this.data.topic as ReminderTopic;
      const role = topic === 'admin' ? 'ADMIN' : 'PARENT';
      if (identity.accountId !== this.data.accountId) {
        this.setData({ accountId: identity.accountId, ids: [], message: '', showSettings: false, loadFailed: false });
      }
      retryGrants(role, identity.accountId);
      try {
        const response = await roleRequest<{ templates: ReminderTemplate[] }>(role, subscriptionPath(role));
        if (wechatIdentity() !== identity) return;
        const ids = templateIdsFor(topic, response.templates);
        let label = labels[topic];
        if (topic === 'admin') {
          const tasks = response.templates.filter(t => ids.includes(t.templateId)).map(t => t.kind);
          const names = [tasks.includes('REGISTRATION_SUBMITTED') ? '注册' : '', tasks.includes('BOOKING_SUBMITTED') ? '预约' : ''];
          label = '订阅' + names.filter(Boolean).join('与') + '待办提醒';
        }
        this.setData({ ids, label, loadFailed: false });
      } catch {
        if (wechatIdentity() === identity) this.setData({ ids: [], loadFailed: true });
      }
    },
    async request(): Promise<void> {
      const { accountId, ids, busy, topic } = this.data;
      if (busy || !accountId || wechatIdentity()?.accountId !== accountId || !ids.length) return;
      const role = topic === 'admin' ? 'ADMIN' : 'PARENT';
      this.setData({ busy: true, message: '', showSettings: false });
      try {
        const result = await askSubscription(ids, accepted => recordGrant(role, accountId, accepted));
        if (wechatIdentity()?.accountId === accountId) {
          this.setData({ message: messages[result], showSettings: result === 'disabled' || result === 'declined' });
        }
      } finally { this.setData({ busy: false }); }
    },
    tap() {
      if (this.data.loadFailed && !this.data.ids.length) void this.load();
      else void this.request();
    },
    settings() {
      wx.openSetting({ withSubscriptions: true, success: () => this.setData({ message: '', showSettings: false }) });
    }
  }
});
