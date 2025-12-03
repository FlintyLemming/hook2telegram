# hook2telegram

一个极简的 Webhook 转发器：你的业务服务器只需要把 JSON POST 到本服务，它会替你把消息送达指定的 Telegram Bot 对话。适合那些自己无法直接访问 Telegram API 的工作流/服务器。

## 功能速览
- `POST /webhook` 收到 `{ "message": "..." }` 即转发到 Telegram。
- API Key 校验：`API_KEYS` 环境变量配置，支持 `key:chatId` 绑定到不同的聊天。
- 自动重试：向 Telegram 发送失败会最多重试 3 次，带指数退避。
- 健康检查：`GET /health` 返回运行状态与最近一小时的推送数量。
- 文本拼接：可设置 `MESSAGE_PREFIX`，额外字段自动附在消息尾部的 JSON 片段中。

## 快速开始
1. 复制环境变量模板  
   ```bash
   cp .env.example .env
   ```
   填写：
   - `TELEGRAM_BOT_TOKEN`：你的 Bot Token。
   - `TELEGRAM_CHAT_ID`：目标聊天/频道/群的 chat id。
   - `API_KEYS`：用逗号分隔。只需一个 key 时填 `my-key`，若想把不同 key 绑定到不同聊天，可写 `foo:123,bar:456`。
2. 启动服务（Node.js >=18，无额外依赖；自动读取当前目录的 `.env`）：  
   ```bash
   npm start
   # 或 NODE_ENV=development node server.js
   ```
3. 发送测试请求（带 source/subject/message）  
   ```bash
   curl -X POST "http://localhost:3000/webhook/my-key" \
     -H "Content-Type: application/json" \
     -d '{ "source": "demo", "subject": "hello", "message": "hello from webhook", "silence": false }'
   ```
   返回 `{"ok":true,"deliveryId":"..."}` 即表示已转发。

## 端点说明
- `POST /webhook[:key]`  
  - 认证：在查询参数 `?api_key=` 或路径段 `/webhook/{key}` 提供 key（无需 `X-API-Key` 头）。若未配置 `API_KEYS`，服务将不校验（不建议生产环境）。
  - 请求头：`Content-Type: application/json`
  - 必填字段：`message`（或 `text`），会被转换成字符串并去掉首尾空格。
  - 可选字段：`source`（显示为 `[source]`）、`subject`（显示在同一行 source 后）、`silence`（布尔，true 时静默发送，无通知/无声音）、`parse_mode`, `thread_id/topic_id/message_thread_id`（覆盖环境变量里的线程 ID），其他字段会作为 JSON 片段附在消息末尾。
  - 发送格式示例：  
    ```
    [<source>] <subject>
    <message>
    ```
- `GET /health`：返回 `{ ok, uptimeSeconds, recentDeliveries }`。
- `GET /`：简单欢迎信息。

## 环境变量
- 必填
  - `TELEGRAM_BOT_TOKEN`
  - `TELEGRAM_CHAT_ID`（或在 `API_KEYS` 中为每个 key 配置 `key:chatId`）
- 可选
  - `API_KEYS=dev-key`（逗号分隔。`key:chatId` 可让不同 key 发往不同聊天）
  - `PORT=3000`
  - `TELEGRAM_THREAD_ID`：群组话题/线程 ID（可被 payload 中的 thread_id/topic_id/message_thread_id 覆盖）
  - `DISABLE_WEB_PAGE_PREVIEW=true`：是否屏蔽链接预览，设为 `false` 可开启。

## 工作原理与可靠性
- 纯 Node.js `http` 服务器，无第三方依赖，便于在限制环境中部署。
- 向 Telegram 调用 `sendMessage`。失败时指数退避（500ms 起，最多 3 次），仍失败会返回 502 并记录到内存的 `recentDeliveries`。
- 消息超过 3900 字符时自动截断并标记 `[truncated]`，避免 Telegram 的 4096 字符限制。

## 部署小贴士
- 建议放在能访问 Telegram API 的中转机上，对外只开放 80/443 或代理后的路径。
- 用 systemd/pm2/docker 守护运行，确保 `.env` 不随代码仓库提交。
- 如果需要多租户/多聊天通道，直接在 `API_KEYS` 配置多组 `key:chatId` 即可复用同一个服务实例。

## Docker 打包运行
1. 构建镜像（在代码根目录）：  
   ```bash
   docker build -t hook2telegram .
   ```
2. 运行容器，传入环境变量或挂载 `.env`：  
   ```bash
   docker run -d --name hook2telegram \
     -p 3000:3000 \
     --env-file ./.env \
     hook2telegram
   ```
   如需换端口：`-p 8080:3000`，或设置 `PORT=8080`。
