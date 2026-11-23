export const noticeTypes = {
  REGISTRATION_SUBMITTED: { role: 'ADMIN', page: 'admin-registrations' },
  BOOKING_SUBMITTED: { role: 'ADMIN', page: 'admin-bookings' },
  REGISTRATION_APPROVED: { role: 'PARENT', page: 'child' },
  REGISTRATION_RETURNED: { role: 'PARENT', page: 'child' },
  BOOKING_CONFIRMED: { role: 'PARENT', page: 'bookings' },
  BOOKING_REJECTED: { role: 'PARENT', page: 'bookings' },
  BOOKING_CANCELLED: { role: 'PARENT', page: 'bookings' }
} as const;

export type NoticeKind = keyof typeof noticeTypes;
export type NoticeRole = 'ADMIN' | 'PARENT';
type Field = 'childName' | 'title' | 'status' | 'remark' | 'time' | 'venue';
export type Templates = Partial<Record<NoticeKind, { templateId: string; fields: Record<string, Field> }>>;
export type MessageState = 'formal' | 'trial' | 'developer';

function dictionary(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function subscriptionConfig(json?: string, state = 'formal'): { templates: Templates; state: MessageState } {
  if (!['formal', 'trial', 'developer'].includes(state)) throw Error('Invalid WBC_WECHAT_MESSAGE_STATE.');
  let input: unknown;
  try { input = JSON.parse(json || '{}'); } catch { throw Error('Invalid WBC_WECHAT_SUBSCRIPTIONS JSON.'); }
  if (!dictionary(input)) throw Error('WBC_WECHAT_SUBSCRIPTIONS must be an object.');
  const templates: Templates = {};
  for (const [kind, template] of Object.entries(input)) {
    if (!Object.hasOwn(noticeTypes, kind) || !dictionary(template) || typeof template.templateId !== 'string'
        || !/^[\w-]{1,128}$/.test(template.templateId) || !dictionary(template.fields) || !Object.keys(template.fields).length) {
      throw Error('Invalid WeChat notification template for ' + kind);
    }
    const fields: Record<string, Field> = {};
    for (const [keyword, field] of Object.entries(template.fields)) {
      if (!/^(thing|phrase|name|time|date)[1-9]\d*$/.test(keyword)
          || typeof field !== 'string' || !['childName', 'title', 'status', 'remark', 'time', 'venue'].includes(field)
          || (/^(time|date)/.test(keyword) && field !== 'time')) throw Error('Invalid template field ' + kind + '.' + keyword);
      fields[keyword] = field as Field;
    }
    templates[kind as NoticeKind] = { templateId: template.templateId, fields };
  }
  return { templates, state: state as MessageState };
}

export function templateList(templates: Templates, role: NoticeRole) {
  return (Object.keys(noticeTypes) as NoticeKind[]).filter(kind => noticeTypes[kind].role === role && templates[kind])
    .map(kind => ({ kind, templateId: templates[kind]!.templateId }));
}

export function messageBody(kind: NoticeKind, config: NonNullable<Templates[NoticeKind]>, state: MessageState,
  openId: string, json: string) {
  const payload: unknown = JSON.parse(json);
  if (!dictionary(payload)) throw Error('Invalid notification payload');
  const data: Record<string, { value: string }> = {};
  for (const [key, field] of Object.entries(config.fields)) {
    const raw = payload[field];
    if (typeof raw !== 'string' || !raw.trim()) throw Error('Missing notification field ' + field);
    let value = raw.trim().replace(/\s+/gu, ' ');
    if (field === 'time') {
      const shanghai = new Date(new Date(value).getTime() + 8 * 3_600_000).toISOString();
      value = key.startsWith('date') ? shanghai.slice(0, 10) : shanghai.slice(0, 16).replace('T', ' ');
    }
    const limit = key.startsWith('phrase') ? 5 : key.startsWith('name') ? 10 : 20;
    data[key] = { value: Array.from(value).slice(0, limit).join('') };
  }
  return { touser: openId, template_id: config.templateId, page: 'pages/entry/index?notice=' + noticeTypes[kind].page,
    miniprogram_state: state, lang: 'zh_CN', data };
}
