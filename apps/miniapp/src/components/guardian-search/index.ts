import type { GuardianChoice } from '../../../../../packages/shared/contracts.js';
import { staffApi } from '../../lib/staff';
import { errorMessage } from '../../lib/client';

Component({
  options: { styleIsolation: 'apply-shared', pureDataPattern: /^_/ },
  properties: { disabled: Boolean },
  data: { _sequence: 0, query: '', rows: [] as GuardianChoice[], selected: null as GuardianChoice | null, busy: false, searched: false, error: '' },
  lifetimes: { detached() { this.data._sequence++; } },
  methods: {
    input(event: WechatMiniprogram.Input) {
      this.data._sequence++;
      this.setData({ query: event.detail.value, rows: [], selected: null, busy: false, searched: false, error: '' });
      this.triggerEvent('pick', { guardian: null });
    },
    reset() {
      this.data._sequence++;
      this.setData({ query: '', selected: null, rows: [], searched: false, busy: false, error: '' });
      this.triggerEvent('pick', { guardian: null });
    },
    async search() {
      const query = this.data.query.trim();
      if (!query || this.data.busy || this.data.disabled) return;
      const seq = ++this.data._sequence;
      this.setData({ busy: true, error: '' });
      try {
        const rows = await staffApi<GuardianChoice[]>('/guardian-search?q=' + encodeURIComponent(query));
        if (seq === this.data._sequence) this.setData({ rows, searched: true });
      } catch (error) { if (seq === this.data._sequence) this.setData({ error: errorMessage(error) }); }
      finally { if (seq === this.data._sequence) this.setData({ busy: false }); }
    },
    choose(event: WechatMiniprogram.TouchEvent) {
      if (this.data.disabled) return;
      const guardian = this.data.rows[Number(event.currentTarget.dataset.index)];
      if (!guardian) return;
      this.setData({ selected: guardian, rows: [], searched: false });
      this.triggerEvent('pick', { guardian });
    }
  }
});
