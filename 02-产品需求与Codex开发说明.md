# 线下训练预约微信小程序｜PRD + Codex 开发说明（Draft v0.2）

> 更新：2026-11-13 | 当前阶段：先在本机开发和验证 MVP。正式上线时，API 和数据库部署到自有上海服务器。  
> 产品范围参考 `01-产品规划.md`。`03-交互设计参考.html` 为 v0.1 视觉演示，管理端布局、孩子资料与积分流程以本 PRD 为准。

## 0. 给 Codex 的执行指令

1. **先检查本机环境，不要假定微信开发者工具、Node、Git、AppID 或后端已存在。** 输出检查结果和缺失项；不修改现有其他项目，不覆盖已有配置。
2. **先实现 P0**。管理端在同一小程序内，管理员录入线下充值积分，预约成功时按该预约所需积分扣减。首版排除微信支付、用户在线充值、购买课程、多商户、订阅会员、分销和候补。
3. 参考 `03-交互设计参考.html` 的视觉风格，使用 WXML/WXSS/TypeScript 开发原生小程序页面。
4. 本地使用假数据和开发登录验证。正式微信登录、管理员密码和各角色权限由服务端验证。
5. 对预约和取消截止时间、退积分、积分换算与定价、私教积分算法、孩子资料扩展字段等待定细节标注 `TODO: product decision`。本地验收可使用种子数据中的示例积分配置。
6. 完成每个阶段后运行 lint、typecheck、测试，提供变更文件清单与可复现的启动步骤。

## 1. 角色与权限

| 能力 | 用户 | 教练 | 管理员 |
|---|---:|---:|---:|
| 浏览未来30天公开排课 | ✓ | ✓ | ✓ |
| 团课与私教预约 | ✓ | 按用户身份另行支持 | 管理员可代约 |
| 看自己的预约 | ✓ | ✓ | ✓ |
| 看授课日程 | - | 仅自己 | 全部 |
| 创建课程与教练 | - | - | ✓ |
| 设置教练开放时段 | - | 只读 | ✓ |
| 填写及编辑孩子资料 | 本账户的一名孩子 | - | 按管理权限查看 |
| 管理用户/预约 | 查看和取消自己的预约 | 所授课程的预约人数和孩子姓名 | ✓ |
| 录入线下充值积分 | - | - | ✓ |
| 调整用户积分 | - | - | 新增调整或冲正流水 |

服务端依据会话识别角色并校验数据归属。教练端在学员个人信息中只返回姓名，联系方式、其他孩子资料及账户数据均不下发。课程和开放时段由管理员统一维护。

## 2. 页面需求

### 2.1 用户端

| 页面 | 功能与字段 | 优先级 |
|---|---|---|
| 排课首页 | 默认展示今天起30天；周切换、日期选择；切换「团课」「私教」 | P0 |
| 团课列表/详情 | 开课时间、名称、教练、场地、容量、已预约数、剩余名额、状态、所需积分 | P0 |
| 私教预约 | 选择教练、日期和可约起止时间，显示可约状态和所需积分，确认后预约 | P0 |
| 我的预约 | 即将上课、历史、详情和取消入口，异常情况提示联系管理员 | P0 |
| 我的账户 | 积分余额及充值、扣减、人工调整等流水 | P0 |
| 用户中心 | 微信头像昵称（如有授权）、联系人基本资料、孩子资料和协议入口 | P0 |
| 孩子资料 | 填写及编辑本账户唯一的孩子资料，姓名必填，其余字段待确认 | P0 |

### 2.2 小程序管理端

| 页面 | 功能与字段 | 优先级 |
|---|---|---|
| 管理员登录 | 在小程序内输入管理员登录凭据，服务端验证密码后建立管理员会话 | P0 |
| 仪表盘 | 今天课程数、预约数、待处理事项；**不强制财务统计** | P0 |
| 教练管理 | 新增/启停、姓名、简介、专长、关联登录身份 | P0 |
| 团课模板 | 名称、时长、容量、默认教练/场地、所需积分、固定重复规则与多个开课时段 | P0 |
| 排课实例 | 按天/周管理真实实例；停开、修改、容量调整、查看名单 | P0 |
| 私教开放时段 | 按教练维护每周开放段、例外停用、可预约时长和积分配置，并检查冲突 | P0 |
| 用户管理 | 搜索家长账户，查看所绑定的孩子、预约和积分流水 | P0 |
| 积分管理 | 录入线下收款对应的积分，支持调整和冲正，保存原因、凭证或备注以及操作日志 | P0 |
| 预约管理 | 查看、取消、管理员代约（需要记录操作来源） | P0 |

### 2.3 教练端

- 今日 / 本周日程（团课 + 私教统一时间轴）。
- 日程显示时间、地点、类型、预约人数和所授课程的孩子姓名。
- 教练端为只读工作台，管理员修改排课后刷新可见。

## 3. 业务规则与验收标准

### BR-01 未来一个月排课
- 定义：从用户当前本地日历日期起 30 个自然日，使用场馆统一时区（默认 `Asia/Shanghai`，在配置中修改）。
- 以周为分组，跨月正确显示；按日期展示团课实例；不把团课模板直接当成具体预约对象。
- 只有已发布、未取消的实例对用户可预约；历史日期不可预约。

### BR-02 团课预约
- 预约一个团课实例后 `bookedCount` 增加 1，`availableCount = capacity - bookedCount`。
- 同一用户同一实例最多一个有效预约；满员不可预约。
- 并发下通过数据库事务和条件更新保证容量约束。预约确认与积分扣减按 BR-06 一起提交。
- 取消后名额归还；重复取消需幂等。
- 容量缩小至低于当前有效预约数时，拒绝变更并提示管理员处理。

### BR-03 团课周期规则
- 支持每天、每周指定星期几（周一至周日多选）等固定重复方式。一天可配置多个固定开课时段，每个时段生成独立实例。
- 周期模板生成未来至少30天班次，使用「模板+实例」模型，避免重复生成；需唯一约束。
- 编辑规则只作用于未来未开始的班次；如何处理已有预约必须显式确认并形成变更通知（V1 可拒绝危险修改）。

### BR-04 私教开放与独占
- 管理员为教练设置每周开放时间、例外不可用时间和可预约时长。私教时长可配置。
- 用户在场馆同一自然日内选择开始和结束时间，可覆盖多个相邻时段，完整区间须连续开放。后端按完整区间校验，拒绝跨天或有空档的申请。
- 同一教练团课与私教、请假与私教之间必须互斥；同一场地若有限制也要检查资源冲突。
- 预约成功后锁定完整区间，所有与其重叠的可选时间不可约。同一教练的重叠请求并发时只允许其中一个成功，其他教练和未重叠的可约时间独立处理。
- 取消后释放预约占用，仍符合开放条件的时间恢复可约。

### BR-05 教练工作台
- 教练只能读取与其身份绑定的个人日程；今日/本周按开始时间排序。
- 日程显示预约人数及该教练所授课程的孩子姓名。管理员变更后刷新可见。

### BR-06 线下充值、积分台账和预约扣减
- 线下收款后，管理员在小程序管理端录入应记积分及原因、凭证或备注。家长端只读查询积分余额和流水。
- 确认预约前显示服务端计算的所需积分。团课及私教使用服务端配置的积分规则，实际定价及私教跨时段的计算方式待确认。
- 服务端在同一事务内校验余额与可约状态、创建预约、占用名额或时段、扣除积分并写入流水。余额不足、预约失败或事务回滚时，积分和排期占用均无变化。
- 每笔成功预约只扣一次，网络重试返回已确认结果。并发预约共享同一账户余额，余额始终大于或等于零。
- 流水追加写入，记录变动值、来源、原因、操作者、时间及关联凭证或预约。以流水聚合或可核对的缓存得到余额。错误录入通过关联原流水的冲正纠错。

### BR-07 登录/隐私
- 生产环境使用 `wx.login` 获取临时 `code`，后端向微信换取用户唯一标识及生成自身 session；不得在小程序端放 AppSecret。
- 管理端使用服务端密码校验和管理员会话。密码以安全哈希存储，管理员 API 按会话校验权限。
- 家长只可查看自己的预约和积分账户、管理本账户的孩子资料。教练只读自己的日程和所授课程的孩子姓名。
- 数据传输 HTTPS，敏感配置在服务端环境变量，日志不记录令牌、完整手机号或身份证号。

### BR-08 取消与异常处理
- 家长可取消自己的预约。取消须幂等，成功后释放对应团课名额或私教时段。
- 未到课、教练请假等异常情况由家长联系管理员处理。管理员可在小程序内处理相关预约并记录操作。
- 预约和取消的具体截止时间、取消后的积分退回规则为 `TODO: product decision`。积分需人工调整时使用管理端台账并关联预约。

### BR-09 孩子资料
- 「孩子资料」页面支持新建及编辑。本账户只保存一份孩子资料，姓名为预约所需字段。
- 预约关联当前家长账户的孩子。缺少孩子资料时引导填写，服务端从会话对应账户读取孩子档案并验证归属。

## 4. 数据模型（建议初版）

```text
users(id, wxOpenId, displayName, phoneMasked, status, createdAt)
roles(userId, role)                    # USER / COACH / ADMIN
admin_credentials(userId, passwordHash)
children(id, guardianUserId, name, createdAt, updatedAt)
coaches(id, userId?, name, specialty, bio, enabled)
private_booking_settings(coachId, durationRules, pointsRules)
venues(id, name, locationLabel)
course_templates(id, title, durationMin, capacity, coachId, venueId, recurrence, pointsCost, enabled)
class_sessions(id, templateId, coachId, venueId, startsAt, endsAt, capacity, pointsCost, status)
coach_availability(id, coachId, weekday, startTime, endTime, effectiveFrom, effectiveTo)
coach_exceptions(id, coachId, startsAt, endsAt, reason)
private_slots(id, coachId, venueId?, startsAt, endsAt, status) # 已占用的完整预约区间
bookings(id, userId, childId, type, classSessionId?, privateSlotId?, pointsCharged, requestKey, status, createdAt, cancelledAt?)
accounts(id, userId, unit)             # POINT
account_ledger(id, accountId, delta, reason, source, bookingId?, externalReference?, reversalOfId?, operatorId, createdAt)
audit_logs(id, actorId, action, entityType, entityId, metadata, createdAt)
```

- `users.wxOpenId`、`children.guardianUserId` 和 `accounts.userId` 各自唯一。预约的孩子必须属于该预约账户。
- 同一用户对同一团课实例最多有一笔有效预约。团课实例按模板和开课时间唯一，预约按账户和请求标识去重，每笔预约最多有一条扣减流水。
- 私教可约起止时间由开放规则和已占用区间计算。数据库事务和服务端共同校验同一教练的占用冲突，覆盖团课、私教和例外时间。
- 统一时间存储 UTC，UI 按场馆时区展示；所有主键建议 UUID/CUID。
- 数据库初期可选 SQLite（仅本地演示）；准备部署时建议 PostgreSQL。**禁止把本地 SQLite 当成多实例生产数据库**。
- API 返回统一错误码 `FULL`、`SLOT_TAKEN`、`SCHEDULE_CONFLICT`、`ALREADY_BOOKED`、`INSUFFICIENT_POINTS`、`CHILD_PROFILE_REQUIRED`、`NOT_AUTHORIZED`、`CANCEL_NOT_ALLOWED`、`VALIDATION_ERROR`。

## 5. 建议的技术选型（可由 Codex 结合现有环境调整）

| 部分 | 建议 | 理由 |
|---|---|---|
| 微信小程序 | **原生小程序 + TypeScript**（WXML/WXSS） | 家长、教练和管理员共用同一小程序，按角色进入对应页面 |
| 后端 API | Node.js LTS + TypeScript（如 Fastify） | 与前端共用类型，简单可维护 |
| ORM/数据库 | Prisma 或 Drizzle + PostgreSQL | 事务和审计有保障，需团队最终确认 |
| 本地 MVP | Mock 登录、SQLite、种子数据 | 可先验证预约、扣减、取消与权限流程 |
| 代码管理 | Git，单仓库 `apps/miniapp`、`apps/api`、`packages/shared` | 小程序与 API 共享业务类型 |

**不要把设计稿 HTML 嵌进 `web-view` 充当最终小程序**：`web-view` 存在域名、身份与交互限制；请把 UI 组件转译成原生小程序结构。

## 6. Mac 开发环境自检（Codex 必须先执行）

2026-11-13 已验证当前 Apple Silicon Mac 的本地环境。微信开发者工具 `2.02.2609250 Stable` 已安装到 `/Applications/wechatwebdevtools.app`，游客模式可以导入临时原生小程序。工具自带编译器已通过最小 WXML 编译检查，模拟器渲染需在测试窗口选择「信任并运行」后验证。Node.js `24.12.0`、npm、pnpm、Git 和 Xcode 已就绪，本机 HTTP 和 SQLite 测试通过。原生小程序方案无需 HBuilderX。

在 Mac 终端执行以下**只读检查**（不需要管理员权限）：

```bash
sw_vers
uname -m                  # arm64 = Apple Silicon, x86_64 = Intel
xcode-select -p || true  # 如后续编译或安装依赖需要再配置
command -v git && git --version || true
command -v node && node --version || true
command -v npm && npm --version || true
command -v pnpm && pnpm --version || true
command -v code || true
ls -d /Applications/wechatwebdevtools.app /Applications/微信开发者工具.app 2>/dev/null || true
find /Applications -maxdepth 2 -iname '*wechat*dev*' -print 2>/dev/null | head -20
```

**检查结果判读**：
- 若已有微信开发者工具，优先打开现有版本确认可用，不重复安装；上述 App 路径仅供探测，实际安装名可能不同。
- 若缺少开发者工具，从官方地址安装对应 `macOS ARM64` / `macOS x64` **稳定版**：https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html
- 若 Node/npm 缺失，建议用版本管理器安装当时受支持的 Node.js LTS；不要未经确认强制升级系统 Node 或覆盖其他项目配置。
- `pnpm`、Git、VS Code/Codex 可根据实际缺失情况补齐。
- Codex 可以编写、检查、测试代码；**微信小程序模拟器、真机预览、上传及发布仍需微信开发者工具、微信管理员授权及 AppID**。

### 6.1 微信小程序主体与项目配置

- [ ] 已拥有 **小程序账号**（公众号/视频号不等于自动拥有可开发的小程序）。
- [ ] 从微信公众平台取得正式 AppID；未取得时可先用开发者工具测试号/本地 Mock 探索可行性，但不视为正式发布能力。
- [ ] `project.config.json` 中正确填写 `appid`、`miniprogramRoot`，不要提交个人私密配置 `project.private.config.json`。
- [ ] 使用 `app.json` 配置页面路径与 TabBar；WXML/WXSS 用于原生 UI，TypeScript 编译方案须由开发工具实际验证。
- [ ] 后端 HTTPS 与小程序 request 合法域名，必要时在小程序平台配置。
- [ ] 小程序业务类目、备案和隐私指引按发布流程单独处理。场馆经营事项在本次开发范围外。

### 6.2 可选 CI（先不强制）

后续若要 Codex 自动上传体验版，可考虑 `miniprogram-ci`，但需要管理员提供的小程序代码上传密钥、IP 白名单及适当安全保管。**不要提交密钥到仓库**。官方示例：https://github.com/wechat-miniprogram/miniprogram-demo ，官方 CI 项目：https://github.com/wechat-miniprogram/miniprogram-ci-dist 。

## 7. 目录目标

```text
training-booking/
  README.md
  docs/
    01-产品规划.md
    02-产品需求与Codex开发说明.md
    03-交互设计参考.html
  apps/
    miniapp/               # 家长端、教练端和密码登录的管理端
    api/                   # 服务端 API
  packages/
    shared/                # 类型/常量/校验
  .env.example             # 示例变量，不含秘钥
```

## 8. 最小 API 草案

```text
GET    /api/schedule?from=&to=&type=GROUP|PRIVATE
GET    /api/classes/:id
POST   /api/bookings                   # groupSessionId 或 coachId + startsAt + endsAt，附幂等键
GET    /api/me/bookings
DELETE /api/me/bookings/:id           # 取消，幂等
GET    /api/me/child
PUT    /api/me/child                   # 新建或编辑本账户唯一的孩子资料
GET    /api/coaches
GET    /api/coaches/:id/slots?from=&to=  # 返回可约时间与积分报价所需信息
POST   /api/bookings/quote              # 校验所选时间并返回预约所需积分
GET    /api/me/account
GET    /api/me/account/ledger
GET    /api/coach/me/schedule?from=&to=
# 管理端
POST   /api/admin/session              # 密码验证，创建管理员会话
DELETE /api/admin/session
POST   /api/admin/coaches
POST   /api/admin/course-templates
PATCH  /api/admin/class-sessions/:id
PUT    /api/admin/coaches/:id/availability
GET    /api/admin/users
POST   /api/admin/accounts/:id/ledger  # 线下充值入账、人工调整及冲正
GET    /api/admin/bookings
POST   /api/admin/bookings             # 代约，使用该家长账户及孩子资料
DELETE /api/admin/bookings/:id         # 管理员处理取消，记录操作来源
```

## 9. 必测的验收场景

1. 今天起30天：任一周可切换；跨年/跨月日期显示准确。
2. 10个容量的团课已有6人，显示 `6/10，剩余4`；第10人成功后剩余0；第11人被拒绝。
3. 20 个余额充足的请求并发抢最后一个团课名额，恰好成功并扣分一次。
4. 两个用户并发预约同一教练的重叠私教区间，恰好成功并扣分一次。其他教练和不重叠时段仍可预约。
5. 同一教练已经安排团课时，不允许该时间段私教被预约。
6. 重试同一请求只创建一笔预约及一条扣减流水。重复取消只释放一次占用。
7. 教练只能读取自己的日程，学员个人信息只返回姓名。家长只能读取本账户的预约、积分流水和孩子资料。
8. 管理员线下手工录入 +100 积分后，用户端能看到增量和流水；教练无权变更。
9. 账户错误入账后通过 -100 冲正；历史入账仍保留、可查操作者。
10. 家长端账户页面只读。线下充值入账和积分调整需通过管理员密码会话调用。
11. 断网/接口超时后预约状态可以重新查询，不把未确认请求误显示为成功。
12. 管理端停止某个课程实例后不可再约，其他同模板班次不受影响。
13. 预约前展示所需积分。余额不足时预约失败，余额和排期占用无变化。并发预约也无法把同一账户余额扣成负数。
14. 每天重复和每周指定星期几的规则均可配置多个开课时段，重复生成时不会创建相同班次。
15. 私教可跨同一天内连续开放的相邻时段。跨天或包含未开放时间时拒绝预约。
16. 家长可新建及编辑孩子资料，无法添加第二名孩子或为他人孩子预约。缺少资料时引导填写。
17. 管理员输入正确密码后可以进入小程序管理端。错误密码、普通用户会话和教练会话均无法访问管理 API。
18. 家长取消后可看到更新后的预约状态。未到课、教练请假等异常情况可联系管理员处理，相关管理操作可查。

## 10. 开发任务拆分建议

- **Phase 0：** 环境核查、技术栈确认、项目骨架、Mock、基础组件/主题与 Git 初始化。
- **Phase 1：** 孩子资料、排课、团课和私教预约、积分扣减流水、我的预约与取消，先用种子积分验证。
- **Phase 2：** 小程序管理端密码登录、课程模板、排课实例、教练开放时段、用户、预约和线下积分入账。
- **Phase 3：** 教练日程、人工积分调整、权限审计和并发测试。
- **Phase 4：** 微信登录、真实 AppID、真机调试和上海服务器部署联调。

### Codex 启动提示词（可复制）

> 请阅读产品规划、PRD 和交互参考。先执行第 6 节的只读环境检查并报告结果。按 P0 搭建原生微信小程序与 API 的可运行 monorepo，使用 Mock 和种子数据验证。小程序采用勃艮第红主题，包含家长端、教练端和密码登录的管理端。实现一账户一名孩子、团课容量并发安全、私教完整时段独占、教练日程只读、线下充值积分入账和预约成功时原子扣减积分。积分退款等待定规则按 PRD 标注。各阶段结束后运行检查并提供变更摘要与启动步骤。不得影响电脑上现有项目。

## 11. 官方参考入口

- 微信开发者工具：https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html
- 小程序开发文档：https://developers.weixin.qq.com/miniprogram/dev/framework/
- 官方小程序示例：https://github.com/wechat-miniprogram/miniprogram-demo
- 小程序自动化上传（可选）：https://github.com/wechat-miniprogram/miniprogram-ci-dist
- 微信公众平台：https://mp.weixin.qq.com/
