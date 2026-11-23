import { allowPage, fetchAdminFile } from '../../lib/session';
import { errorMessage } from '../../lib/request';

const categories = [{ key: 'players', label: '队员档案' }, { key: 'bookings', label: '预约历史' }, { key: 'deductions', label: '积分扣减明细' }];
// Exported CSV quotes every field. Embedded commas, quotes and line breaks belong to the cell.
function csvRows(text: string) {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  const csv = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i];
    if (ch === '"') {
      if (quoted && csv[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && ch === ',') { row.push(cell); cell = ''; }
    else if (!quoted && ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (quoted || ch !== '\r') cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

Page({
  filePath: '', rows: [] as string[][], alive: true,
  data: { authorized: false, categories, formats: ['CSV', 'PDF'], category: 0, format: 0, busy: false, error: '',
    headers: [] as string[], preview: [] as string[][], total: 0, offset: 0 },
  onShow() { this.setData({ authorized: allowPage('ADMIN') }); },
  onUnload() { this.alive = false; this.clearFile(); },
  clearFile() {
    if (this.filePath) wx.getFileSystemManager().unlink({ filePath: this.filePath });
    this.filePath = '';
    this.rows = [];
  },
  select(event: WechatMiniprogram.PickerChange) {
    this.clearFile();
    this.setData({ [event.currentTarget.dataset.field]: Number(event.detail.value), headers: [], preview: [], error: '' });
  },
  page(event: WechatMiniprogram.TouchEvent) {
    const offset = this.data.offset + Number(event.currentTarget.dataset.step) * 20;
    this.setData({ offset, preview: this.rows.slice(offset, offset + 20) });
  },
  async open() {
    if (this.data.busy) return;
    this.clearFile();
    this.setData({ busy: true, error: '', headers: [], preview: [] });
    try {
      const category = categories[this.data.category];
      const format = this.data.formats[this.data.format].toLowerCase();
      const data = await fetchAdminFile(category.key + '?format=' + format);
      if (!this.alive) return;
      const fs = wx.getFileSystemManager();
      this.filePath = wx.env.USER_DATA_PATH + '/WBC-' + category.key + '.' + format;
      fs.writeFileSync(this.filePath, data);
      if (format === 'pdf') { await wx.openDocument({ filePath: this.filePath, fileType: 'pdf', showMenu: true }); return; }
      const [headers, ...rows] = csvRows(String(fs.readFileSync(this.filePath, 'utf8')));
      this.rows = rows;
      this.setData({ headers, total: rows.length, offset: 0, preview: rows.slice(0, 20) });
    } catch (error) { if (this.alive) this.setData({ error: errorMessage(error) }); }
    finally { if (this.alive) this.setData({ busy: false }); }
  }
});
