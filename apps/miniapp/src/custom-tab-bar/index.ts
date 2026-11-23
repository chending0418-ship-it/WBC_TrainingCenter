let pendingPath = '';

Component({
  data: {
    activePath: '',
    tabs: [
      { path: 'pages/schedule/index', label: '课表' },
      { path: 'pages/bookings/index', label: '我的预约' },
      { path: 'pages/account/index', label: '我的账户' }
    ]
  },
  lifetimes: {
    ready() {
      const pages = getCurrentPages();
      const page = pages[pages.length - 1];
      if (page?.data.authorized && this.data.activePath !== page.route && this.data.tabs.some(tab => tab.path === page.route)) {
        this.setData({ activePath: page.route });
      }
    }
  },
  methods: {
    selectTab(event: WechatMiniprogram.TouchEvent) {
      const path = String(event.currentTarget.dataset.path);
      if (!this.data.activePath || path === this.data.activePath || path === pendingPath) return;
      pendingPath = path;
      wx.switchTab({ url: '/' + path, complete: () => { if (pendingPath === path) pendingPath = ''; } });
    }
  }
});
