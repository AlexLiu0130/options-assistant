# Paper Trade 云端存储修复与部署检查单

**日期：** 2026-07-17
**对象：** `options.qveris.cloud` 的 `#/paper` 页面
**给：** 海涛哥（部署 / 数据库）
**结论：** 当前生产库缺少 `001_paper_trade_strategy_snapshots.sql` 迁移；最新版镜像已携带迁移程序，并会在服务启动前自动执行迁移。请按本文重新构建并部署。

## 线上现象

已登录用户访问 `#/paper` 后，页面返回：

```text
Paper trade storage is unavailable.
```

这意味着用户无法加载模拟账户、持仓、订单或重置账户；创建模拟订单也不能被视为已保存。

## 代码检查结果

### 已确认正常

- `/api/health` 在线返回 `200 {"ok":true}`。
- 未登录访问 `/api/paper/account` 返回 `401 Authentication required`，鉴权边界正常。
- 本地文件模式的完整冒烟检查通过：创建订单、费用、余额、持仓估值、平仓、重置、盘后拒绝均通过。
- 开发 PostgreSQL schema `options_assistant_dev` 的完整冒烟检查通过：用户隔离、账户创建、开仓、平仓、重置和产品事件写入均通过。

### 已确认失败根因

前端这句错误来自 `server/paperTradeRuntime.mjs` 的 `publicDbError()`。只有 PostgreSQL 操作抛错后，`withPostgres()` 才会返回这个 `500`。

服务器诊断已确认容器能连接 RDS，且 `DATABASE_SCHEMA=options_assistant` 正确。实际错误是生产表结构落后：

- `paper_positions` 缺少 `status` 列。
- `paper_orders` 缺少 `strategy_id` 列。
- `options_assistant.schema_migrations` 不存在，说明仓库迁移从未在生产 schema 执行。

根因不在白名单、密码、端口、SSL 或 schema 名，而在旧运行镜像未包含 `scripts/` 和 `db/migrations/`，部署流程也没有执行迁移。

这与下列规则无关：

- 美股期权仅在 `09:30–16:00 ET` 创建或平仓模拟订单。
- 合约腿缺少报价、到期日或标的现价时拒绝下单。

即使盘后不能创建订单，`#/paper` 账户页本身也应能正常读取；现在读取阶段已经失败。

## 本次代码修复

最新版代码已做以下变更：

1. `deploy/Dockerfile.service` 会将 `scripts/` 与 `db/` 复制进最终运行镜像。
2. 容器启动命令会先执行 `node scripts/dbMigrate.mjs`，成功后才启动 API；迁移失败时容器不会以不完整 schema 提供服务。
3. 迁移是幂等的，已执行过的版本会被 `schema_migrations` 跳过。
4. 上游 QVeris/DeepSeek 请求已增加默认 20 秒超时，JSON 请求体上限为 1 MB。
5. 交易时段判断已覆盖常规 NYSE 节假日与 13:00 ET 提前收市；盘后、休市和提前收市后均不能创建或平仓模拟订单。

## 海涛哥部署操作

1. 在服务器部署目录拉取包含本修复的最新 `main`。
2. 确认实际运行的 Compose 配置仍通过 `env_file: service.env` 或等价方式把以下变量注入 **app 容器**：

```text
DATABASE_URL
DATABASE_SCHEMA
```

其中 `DATABASE_SCHEMA` 必须为：

```text
options_assistant
```

3. 从包含最新仓库的部署目录重新构建并启动：

```bash
docker compose up -d --build app
```

4. 观察启动日志。首次修复应看到 `applied 001_paper_trade_strategy_snapshots.sql`，随后 API 才会开始监听：

```bash
docker logs -f options-assistant-app
```

如果日志显示数据库连接或迁移错误，不要绕过迁移强行启动；先保留日志并处理对应的 RDS/权限问题。

## 建议执行的无敏感信息检查

以下命令不会打印数据库密码：

```bash
docker compose exec app sh -lc '
  test -n "$DATABASE_URL" && echo "DATABASE_URL=set" || echo "DATABASE_URL=missing"
  echo "DATABASE_SCHEMA=${DATABASE_SCHEMA:-<default>}"
'
```

如果 `DATABASE_URL=set`，继续从容器直接验证连接与当前 schema：

```bash
docker compose exec app node --input-type=module -e '
  import("./server/database.mjs")
    .then(async ({ query, closeDatabase }) => {
      const result = await query("select current_schema() as schema, current_user as db_user")
      console.log(result.rows[0])
      await closeDatabase()
    })
    .catch((error) => {
      console.error({ code: error.code, message: error.message })
      process.exit(1)
    })
'
```

同时查看最近应用日志中数据库错误码：

```bash
docker logs options-assistant-app --tail=250 2>&1 | grep -E '\[paper-trade-db\]|DATABASE|relation|permission|connect'
```

常见错误含义：

| 错误码 / 信息 | 含义 | 优先处理 |
| --- | --- | --- |
| `28P01` | 用户名或密码错误 | 更新 `DATABASE_URL` |
| `3F000` / `schema does not exist` | schema 名错误或未创建 | 使用 `options_assistant` 并创建 schema |
| `42P01` / `relation does not exist` | 表或迁移缺失 | 执行生产迁移 |
| `42501` / `permission denied` | 应用账号缺少权限 | 补 schema / 表权限 |
| `ECONNREFUSED` / timeout | 网络、白名单、地址或端口问题 | 检查 RDS 白名单与网络路径 |

## 迁移回退与补救

生产 schema 是：

```text
options_assistant
```

新镜像会自动运行迁移。只有自动迁移失败后，才用下列命令在**新镜像**中单独复跑：

```bash
docker compose run --rm app node scripts/dbMigrate.mjs
```

需要至少存在以下业务表：

```text
users
paper_accounts
paper_orders
paper_positions
paper_account_resets
product_events
```

`DATABASE_URL` 只能保存在服务器 secret / `deploy/service.env`，不得提交 Git、发送到群聊或写入前端代码。可选设置 `QVERIS_UPSTREAM_TIMEOUT_MS=20000`；未设置时服务使用同一默认值。

## 验收标准

完成修复后，请按顺序验证：

1. 已登录用户打开 `https://options.qveris.cloud/#/paper`，不再显示 storage unavailable。
2. 页面显示默认 `$1,000,000` 模拟账户，且刷新后账户仍可读取。
3. 美东交易时段内创建一笔定义风险策略的模拟订单。
4. 刷新页面后，该订单和持仓仍存在，并仅对当前 OAuth 用户可见。
5. 平仓和重置账户成功，且管理员后台可看到对应聚合事件。
6. 盘后创建订单仍被正常拒绝，但页面显示明确的美东交易时段提示，而不是 storage error。

## 代码定位

- `server/paperTradeRuntime.mjs`：数据库失败转换为前端通用错误的路径。
- `server/database.mjs`：PostgreSQL 连接与 schema search path。
- `server/qverisServer.mjs`：`/api/paper/*` 路由。
- `scripts/paperTradePostgresSmoke.mjs`：开发 schema 的端到端验证脚本。
- `deploy/docker-compose.yml`：当前容器环境变量注入位置。
