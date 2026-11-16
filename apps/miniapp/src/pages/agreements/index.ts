import { allowPage } from '../../lib/session';

Page({
  data: { authorized: false },
  onShow() {
    this.setData({ authorized: allowPage('PARENT') });
  }
});
