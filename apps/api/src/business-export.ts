import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import PDFDocument from 'pdfkit';
import { ApiError, bookingStatus } from './booking.ts';

const reports = {
  players: { title: '队员档案', headers: ['队员姓名', '球衣号码', '出生年月', '性别', '联系人', '联系电话', '注册状态'],
    query: `SELECT c.name, c.jersey_number, c.birth_month, CASE c.gender WHEN 'MALE' THEN '男' WHEN 'FEMALE' THEN '女' END,
      p.name AS contact, p.phone, CASE r.status WHEN 'APPROVED' THEN '已通过' WHEN 'PENDING' THEN '待审核' WHEN 'RETURNED' THEN '已退回' ELSE '未注册' END
      FROM children c LEFT JOIN parent_contacts p ON p.user_id = c.guardian_id LEFT JOIN registrations r ON r.user_id = c.guardian_id
      ORDER BY c.name, c.guardian_id` },
  bookings: { title: '预约历史', headers: ['队员姓名', '课程名称', '开始时间', '结束时间', '预约状态'],
    query: `SELECT c.name, b.title, strftime('%Y-%m-%d %H:%M', b.starts_at, '+8 hours'),
      strftime('%Y-%m-%d %H:%M', b.ends_at, '+8 hours'), CASE (${bookingStatus}) WHEN 'PENDING' THEN '待确认'
      WHEN 'CONFIRMED' THEN '已确认' WHEN 'REJECTED' THEN '已拒绝' ELSE '已取消' END
      FROM bookings b JOIN children c ON c.guardian_id = b.user_id ORDER BY b.starts_at DESC, b.id` },
  deductions: { title: '积分扣减明细', headers: ['队员姓名或账户', '扣减时间', '扣减积分', '原因', '课程名称', '训练开始时间'],
    query: `SELECT coalesce(c.name,l.user_id), strftime('%Y-%m-%d %H:%M', l.created_at, '+8 hours'), -l.delta, l.reason,
      coalesce(l.training_title,b.title), strftime('%Y-%m-%d %H:%M', coalesce(l.training_start,b.starts_at), '+8 hours')
      FROM ledger l LEFT JOIN children c ON c.guardian_id = l.user_id LEFT JOIN bookings b ON b.id = l.booking_id
      WHERE l.delta < 0 ORDER BY l.id DESC` }
};

function csvCell(value: string) {
  const safe = /^[\s]*[=+@-]/.test(value) ? "'" + value : value;
  return '"' + safe.replaceAll('"', '""') + '"';
}

export function businessExport(db: DatabaseSync, category: unknown, format: unknown) {
  if (typeof category !== 'string' || !Object.hasOwn(reports, category) || (format !== 'csv' && format !== 'pdf'))
    throw new ApiError(400, 'VALIDATION_ERROR', '请选择导出类别和文件格式');
  const report = reports[category as keyof typeof reports];
  const statement = db.prepare(report.query);
  statement.setReturnArrays(true);
  const rows = (statement.all() as unknown as unknown[][]).map(row => row.map(value => String(value ?? '')));
  const filename = report.title + '.' + format;
  if (format === 'csv') return { filename, type: 'text/csv; charset=utf-8',
    body: Buffer.from('\uFEFF' + [report.headers, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n') };
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 32, info: { Title: report.title } });
  doc.font(fileURLToPath(new URL('../assets/NotoSansSC-Regular.ttf', import.meta.url)));
  const width = (doc.page.width - 64) / report.headers.length;
  function drawRow(cells: string[], y: number, height: number, header = false) {
    if (header) doc.rect(32, y, width * cells.length, height).fill('#f1e8ea');
    cells.forEach((cell, i) => doc.fillColor('#30272a').text(cell, 37 + width * i, y + 5, { width: width - 10 }));
    doc.moveTo(32, y + height).lineTo(32 + width * cells.length, y + height).strokeColor('#ded6d8').stroke();
    return y + height;
  }
  function pageHeading() {
    doc.fontSize(18).text('WBC 俱乐部 · ' + report.title, 32, 28);
    doc.fontSize(10).text('共 ' + rows.length + ' 条记录', 32, 58);
    return drawRow(report.headers, 83, 28, true);
  }
  let y = pageHeading();
  for (const row of rows) {
    const height = Math.max(25, ...row.map(cell => doc.heightOfString(cell, { width: width - 10 }) + 12));
    if (y + height > doc.page.height - 32) {
      doc.addPage();
      y = pageHeading();
    }
    y = drawRow(row, y, height);
  }
  doc.end();
  return { filename, type: 'application/pdf', body: doc };
}
