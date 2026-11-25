import { html, href, link, title, box, empty, field, datetime, confirmAction, buttons } from './ui.js';

export async function announcements(ctx) {
  const before = ctx.query.get('before');
  const { rows, next } = await ctx.api('/announcements' + (before ? '?before=' + encodeURIComponent(before) : ''));
  const id = ctx.query.get('id');
  const selected = rows.find((row) => String(row.id) === id);
  const edit = selected?.published || ctx.query.get('new');
  const list = rows.length
    ? html`<ul class="announcement-list">
        ${rows.map(
          (row) =>
            html`<li>
              <div>
                <b>${row.title}</b>
                <small>${datetime(row.publishedAt)} · ${row.published ? '已发布' : '已撤下'}</small>
              </div>
              ${row.published ? link('编辑公告', 'announcements', { before, id: row.id }) : ''}
            </li>`
        )}
      </ul>`
    : empty('暂无公告');
  const form = html`<form class="form-pad">
    ${field('公告标题', 'title', selected?.title || '', { maxLength: 60 })}
    <label class="w-field"
      ><span>公告正文</span
      ><textarea name="body" required maxlength="800" rows="6">${selected?.body || ''}</textarea>
    </label>
    <p class="quiet-text">发布后显示在家长课程表顶部。家长点「标为已读」后清除该条提醒。</p>
    ${buttons(
      html`<button class="wb" type="submit">${selected ? '更新公告' : '发布公告'}</button>`,
      link('取消', 'announcements', { before }),
      selected ? html`<button class="wb outline" type="button" data-withdraw>撤下公告</button>` : ''
    )}
  </form>`;
  const root = ctx.show(
    html`${title('公告管理', link('新建公告', 'announcements', { new: 1 }, 'wb'))}
      <div class="split">
        ${box(
          '俱乐部公告',
          list,
          html`${before ? link('最近公告', 'announcements') : ''}
          ${next ? link('更早公告', 'announcements', { before: next }) : ''}`
        )}
        ${edit ? box(selected ? '编辑公告' : '新建公告', form) : ''}
      </div>`
  );
  if (!root || !edit) return;
  const editor = root.querySelector('form');
  function submit(withdraw) {
    ctx.perform(async () => {
      const heading = editor.elements.title.value.trim(),
        body = editor.elements.body.value.trim();
      if (!withdraw && (!heading || !body)) {
        ctx.notice('请填写公告标题和正文');
        return;
      }
      const action = withdraw ? '撤下公告' : selected ? '更新公告' : '发布公告';
      const confirm = await confirmAction(
        action,
        withdraw ? '撤下后，家长将无法再查看这条公告。' : heading + '。所有登录家长都能看到这条公告。'
      );
      if (!confirm || !ctx.active()) return;
      const data = withdraw ? { withdraw: true } : { title: heading, body };
      if (selected)
        await ctx.write('/announcements/' + selected.id, 'PUT', { ...data, revision: selected.revision }, true);
      else await ctx.write('/announcements', 'POST', data, true);
      if (ctx.active()) {
        ctx.notice(withdraw ? '公告已撤下' : '公告已发布');
        location.hash = href('announcements');
      }
    });
  }
  editor.onsubmit = (e) => {
    e.preventDefault();
    submit(false);
  };
  const withdraw = editor.querySelector('[data-withdraw]');
  if (withdraw) withdraw.onclick = () => submit(true);
}
