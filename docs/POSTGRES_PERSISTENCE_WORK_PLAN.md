# PostgreSQL 持久化与产品监测工作计划

## 目标

将当前仅保存在本地 JSON 文件中的模拟交易迁移到 PostgreSQL，并记录内测用户的关键产品行为。前端继续使用现有 `/api/paper/*` 接口，不改变模拟交易计算规则。

## 已确认条件

- 开发 schema：`options_assistant_dev`。
- 生产 schema：`options_assistant`。
- 本机已验证可连接开发 schema，且可在事务内读写后回滚。
- OAuth 登录用户的 `sub` 是唯一可信的外部用户标识。
- 当前数据库基础表已创建，但期权组合持仓所需的快照字段尚未齐全。

## 非目标

- 不做支付、订阅、管理员后台页面或完整 7 天试用权限流程。
- 不改变策略推荐、定价、盈亏、费用或交易时段计算引擎。
- 不保存完整 AI 对话、密钥、Cookie 或用户原始投资提示。
- 不在本阶段迁移已有本地 JSON 历史数据。

## 工作流

```text
QVeris OAuth session
  -> users.oauth_sub 映射为内部 user_id
  -> PostgreSQL 事务写入账户、订单、持仓
  -> 原有确定性 Paper Trade Engine 计算标记与盈亏
  -> 白名单产品事件写入 product_events
```

## 阶段一：数据库基础

### 配置

- `DATABASE_URL`：仅存在于本地 `.env.local` 和云端密钥配置。
- `DATABASE_SCHEMA`：本地为 `options_assistant_dev`，生产为 `options_assistant`。
- 后端必须验证 schema 名，只允许安全 PostgreSQL 标识符。

### 迁移

新增版本化 SQL 迁移与迁移记录表。迁移按文件名排序，每个文件在独立事务中执行；已记录的版本不重复执行。

需对齐的字段：

- `paper_orders`：策略标识/名称、策略快照、成交快照、拒绝原因。
- `paper_positions`：策略标识/名称、状态、开平仓时间、腿快照、开仓与平仓快照。
- 删除 `paper_positions(account_id, ticker)` 的唯一限制，允许同一标的持有多个策略。

保留现有表、主键和审计字段；不重建 schema。

## 阶段二：模拟交易持久化

### 改造原则

- `src/core/paperTradeEngine.ts` 保持唯一的计算来源。
- 后端从登录会话取得 OAuth `sub`，浏览器不能传入用户 ID。
- 开仓、平仓、余额更新必须同一数据库事务完成。
- 开仓、平仓都写入订单审计记录。
- 重置账户写入 `paper_account_resets`，随后清空当前账簿，保持现有用户可理解的重置语义。

### 兼容性

保持如下 API 路径与响应主体兼容：

```text
POST /api/paper/orders
GET  /api/paper/orders
GET  /api/paper/account
POST /api/paper/account/mark
POST /api/paper/account/reset
GET  /api/paper/positions
POST /api/paper/positions/:id/close
```

无 `DATABASE_URL` 时保留现有本地文件模式，仅用于旧的离线开发与现有 smoke test；配置数据库的服务必须使用 PostgreSQL。

## 阶段三：产品监测

新增受登录保护的 `POST /api/events`。新增只读 `npm run report:events -- --days=7`，输出事件量、关注标的和策略关注度的聚合 JSON，供内测运营读取；不输出聊天内容或用户原始输入。

只接受以下事件：

- `ticker_searched`
- `strategy_opened`
- `simulator_used`
- `assistant_used`
- `paper_order_created`
- `paper_position_closed`
- `paper_account_reset`
- `education_viewed`
- `data_request_failed`

字段限制：`event_name`、可选 ticker、可选错误分类、少量 JSON 属性、发生时间。服务端校验事件白名单、Ticker 格式和属性大小；不接受聊天原文或任意未验证 JSON。

模拟交易成功后的事件由服务端记录；纯界面行为由前端调用该接口。事件失败不得回滚已完成的模拟交易。

## 阶段四：验证

### 自动检查

- 现有 `npm run check` 必须继续通过。
- 新增 `npm run db:migrate`。
- 新增 `npm run check:db`，仅在明确传入开发数据库配置时运行。

### 数据库冒烟场景

1. 同一 OAuth `sub` 重复请求只映射为一个内部用户。
2. 两个用户的账户、订单和持仓互不可见。
3. 同一 ticker 可建立两个不同策略持仓。
4. 开仓、平仓、重置后账户余额与现有引擎计算一致。
5. 失败订单不创建持仓，不扣余额。
6. 重置记录可追溯。
7. 非白名单事件和过大属性被拒绝。

## 阶段五：审查与交付

- 主 Agent 审查迁移可重复性、事务边界、用户隔离、敏感数据边界和 API 兼容性。
- 独立审查交易计算与数据库映射，不接受“测试通过”代替逻辑审查。
- 整理变更、验证结果和已知边界供用户验收。
- 用户明确确认后才提交 Git；不自动 push 或部署。

## 当前边界

`options` 账号目前同时拥有开发和生产 schema 权限。应用会显式使用 `DATABASE_SCHEMA` 避免误写，但这不是账号级隔离。生产前应改为独立开发账号或限制本地凭据。
