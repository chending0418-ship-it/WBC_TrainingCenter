export type ReminderTopic = 'registration' | 'booking' | 'admin';
export type ReminderTemplate = { kind: string; templateId: string };
export type ReminderResult = 'accepted' | 'partial' | 'declined' | 'disabled' | 'failed' | 'unrecorded' | 'unavailable';

const events: Record<ReminderTopic, string[]> = {
  registration: ['REGISTRATION_APPROVED', 'REGISTRATION_RETURNED'],
  booking: ['BOOKING_CONFIRMED', 'BOOKING_REJECTED', 'BOOKING_CANCELLED'],
  admin: ['REGISTRATION_SUBMITTED', 'BOOKING_SUBMITTED']
};

export function templateIdsFor(topic: ReminderTopic, templates: ReminderTemplate[]) {
  return [...new Set(templates.filter(t => t.templateId && events[topic].includes(t.kind)).map(t => t.templateId))];
}

// Invoke the native API before yielding the tap. Fetching template IDs here loses the user gesture.
export async function askSubscription(ids: string[], record: (ids: string[]) => Promise<void>): Promise<ReminderResult> {
  if (!ids.length || typeof wx.requestSubscribeMessage !== 'function') return 'unavailable';
  try {
    const result = await new Promise<WechatMiniprogram.RequestSubscribeMessageSuccessCallbackResult>((resolve, reject) => {
      wx.requestSubscribeMessage({ tmplIds: ids, success: resolve, fail: reject });
    });
    const accepted = ids.filter(id => result[id] === 'accept');
    if (!accepted.length) return ids.some(id => result[id] === 'reject') ? 'declined' : 'failed';
    try {
      await record(accepted);
      return accepted.length === ids.length ? 'accepted' : 'partial';
    } catch {
      return 'unrecorded';
    }
  } catch (error) {
    return (error as { errCode?: number } | null)?.errCode === 20004 ? 'disabled' : 'failed';
  }
}

// A delayed permission sheet or grant receipt must not hold the training application indefinitely.
export function requestOnSubmit(page: Pick<WechatMiniprogram.Page.TrivialInstance, 'selectComponent'>): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, 8000);
    const finish = () => { clearTimeout(timer); resolve(); };
    try {
      const reminder = page.selectComponent('#resultReminder') as { request(): Promise<void> } | null;
      if (reminder) reminder.request().then(finish, finish);
      else finish();
    } catch { finish(); }
  });
}
