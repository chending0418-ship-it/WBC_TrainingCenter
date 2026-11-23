import { allowPage } from '../../lib/session';
import { config } from '../../lib/config';

Page({
  data: { authorized: false, demo: config.mode === 'demo' },
  onShow() {
    this.setData({ authorized: allowPage('SIGNED_IN') });
  }
});
