# Options Assistant PostgreSQL 接入需求

## 目的

Options Assistant 将复用 QVeris 的 PostgreSQL，用于云端多用户数据持久化和内测行为监测。首批约 20 名体验用户。

应用通过后端连接数据库，浏览器不直接访问数据库。

## 请协助创建

### Schema

```text
options_assistant
```

### 应用账号

创建一个仅用于 Options Assistant 后端的数据库账号，并授予该账号：

- 仅能访问 `options_assistant` schema。
- 对该 schema 内的表、序列拥有建表、读写和迁移权限。
- 不拥有其他 QVeris schema 的查询或修改权限。
- 不使用超级管理员账号。

## 环境要求

请按测试与生产环境分别提供独立 schema 或独立数据库账号，避免测试数据进入生产环境。

交付给部署同事的信息：

```text
DATABASE_URL=postgresql://<user>:<password>@<host>:<port>/<database>?sslmode=require
```

如内网连接不需要 TLS，请说明连接方式、网络白名单和证书要求。账号密码请通过安全渠道交付，不写入 Git 仓库、文档或聊天群。

## 一期数据范围

### 用户映射

使用 QVeris OAuth 返回的稳定用户标识 `sub` 关联数据。

- 不保存 OAuth access token、refresh token 或密码。
- 可保存邮箱和显示名称，用于内测运营与管理员查看。

### 模拟交易

- 模拟账户初始资金与余额。
- 模拟订单、开平仓记录、持仓。
- 已实现和未实现盈亏。
- 账户重置记录。

### 产品使用监测

仅记录产品改进需要的低敏感事件：

- 搜索或打开的 ticker。
- 策略卡查看、参数调整、模拟器使用。
- AI 解释入口使用。
- 模拟下单、平仓、重置。
- 教学页面访问。
- 数据请求失败的错误分类。

不记录完整 AI 对话正文、API 密钥、登录凭据或用户完整投资偏好。

## 建议的最小表

应用后续会自行执行迁移；目前请只准备 schema 与账号。第一期预计需要：

```text
users
access_grants
paper_accounts
paper_orders
paper_positions
paper_account_resets
product_events
```

所有业务表需要有 `created_at`，涉及用户的数据需要有 `user_id`。`product_events` 需要可按 `user_id`、`event_name`、`ticker` 和时间筛选。

## 运维要求

- 生产库纳入现有备份与恢复策略。
- 开启连接数限制；应用会使用单一后端服务，不需要给每个用户单独数据库连接。
- 提供只读监测账号或既有 BI 查询方式，供产品团队查看聚合使用数据。
- 如已有迁移规范、命名规则、网络白名单或审计要求，请同步给项目组。

## 验收标准

1. 应用账号可连接对应环境的 PostgreSQL。
2. 账号能在 `options_assistant` schema 创建并读写表。
3. 账号无法读取其他业务 schema。
4. 测试与生产环境相互隔离。
5. 部署同事获得连接方式和必要网络配置。
