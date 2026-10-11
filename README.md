# pi-codex-native-search

Pi 的 Codex 原生独立搜索插件。通过当前 Provider 的 `alpha/search` 端点执行官方 `web.run` 命令；不发起额外的 Responses 模型请求，不回退到 hosted `web_search`。

## Provider 选择

规则与本机 `openai-responses-instructions.ts` 一致：

```ts
model.api === "openai-responses" &&
(/^openai(?:[-_]|$)/i.test(model.provider) || model.provider === "responses-websocket")
```

- 例如：`openai`、`openai-proxy`、`openai_ws`、`responses-websocket`。
- 使用当前模型 ID，以及 `modelRegistry.getApiKeyAndHeaders(model)` 返回的凭据、headers 和 baseUrl；认证解析得到的 baseUrl 优先于模型 baseUrl。
- 模型不符合规则时，工具隐藏，手动调用也会被拒绝。
- 此规则要求 API 为 `openai-responses`；使用 `openai-codex-responses` API 的模型不会启用工具。
- 不读取 `~/.codex/auth.json`，不创建新的 Provider，不探测远程模型。

## 加载

需要 Node.js >= 22.19.0、Pi 1.1.0（已验证）。

单次加载，在项目目录执行：

```sh
pi -e ./src/index.ts
```

持久安装：

```sh
pi install git:github.com/MaShouo/pi-codex-native-search
```

安装后在已有 Pi 会话中执行 `/reload`，或重新启动 Pi。后续更新：

```sh
pi update git:github.com/MaShouo/pi-codex-native-search
```

**加载和切换模型不发起搜索或获取凭据。** 当模型或 codemode 实际调用 `web.run` 时，才解析当前 Provider 的认证并发送搜索请求；Pi 的认证解析可能刷新到期的 OAuth 凭据。

## 工具与官方行为

保留官方完整命令：

- `search_query`、`image_query`
- `open`、`click`、`find`、`screenshot`
- `finance`、`weather`、`sports`、`time`
- `response_length`：`short` / `medium` / `long`

搜索示例：

```json
{
  "search_query": [{ "q": "OpenAI Codex release notes", "recency": 7, "domains": ["github.com"] }],
  "response_length": "long"
}
```

后续在同一个 Pi 会话中使用返回的引用：

```json
{ "open": [{ "ref_id": "turn0search0" }] }
```

工具说明原文来自官方 `web_run_description.md`，包括每次最多 4 条搜索、4 条时使用 medium/long 的指导。与官方一样，该数量规则由工具说明表达，不额外改变 SearchCommands schema。

### 线协议

- `POST {baseUrl}/alpha/search`，JSON 请求、JSON 响应。
- `id` 使用 Pi session ID，不为每次请求重新生成。
- `model` 使用当前模型 ID。
- `commands` 按官方 schema 序列化；未知字段丢弃。
- `settings` 默认 `{allowed_callers:["direct"], external_web_access:false}`，对应官方 cached 模式。
- `max_output_tokens` 默认 10000，匹配已核对的 Codex 模型目录默认预算。
- `reasoning` 不发送，与官方 web.run 执行路径一致。
- 返回明文 `output`，不进行第二次模型总结；`results` 原样保存在工具结果的 `details`，不假定结果项类型。
- 不使用 `encrypted_output`，与官方搜索执行器一致。

**会话内容传输：** 按官方策略，搜索请求的 `input` 会携带当前用户文本、上一条用户文本及两者之间最多约 1000 token 的助手文本。计算采用官方 UTF-8 字节数 / 4 估算和中间截断算法。当前用户消息之后的助手 commentary 不发送；图片、thinking、工具输出、system prompt 和其他分支不发送。Pi 的 context edits 和 compaction 通过当前 session projection 生效。

Pi 内注册名为 `web.run`；在 Responses 请求中转为官方 `web` namespace 下的 `run` 函数，保留完整参数说明，`strict:false`。模型返回的命名空间调用在执行前映射回 Pi 工具名，后续历史重放恢复官方格式。工具被 codemode 隐藏时不强行重新注入声明。直接声明 `web.run` 时，移除同一次请求中已有的 hosted `web_search` / `web_search_preview`。

### 地址与认证

| Provider 地址 | 搜索地址 |
| --- | --- |
| https://api.openai.com/v1 | https://api.openai.com/v1/alpha/search |
| https://gateway.example/team/v1 | https://gateway.example/team/v1/alpha/search |
| https://gateway.example/v1/responses | https://gateway.example/v1/alpha/search |
| https://chatgpt.com/backend-api | https://chatgpt.com/backend-api/codex/alpha/search |

保留端口、路径前缀和 query。`ws/wss` 地址转为对应 `http/https`，搜索始终使用 HTTP。无 `/v1` 的自定义 baseUrl 不会被擅自追加 `/v1`。

先应用 API key 的 Bearer 认证，再按 Pi 规则合并 model headers 与 auth-resolved headers；`null` 表示删除。保留 Provider 提供的账号标识和 `x-codex-turn-metadata`，移除 Responses 专用头和传输长度等字段。不为 Pi 伪造 Codex 内部 turn metadata。默认客户端标识为 `pi-codex-native-search`，可由 Provider headers 覆盖。

不会将第三方网关凭据改发到官方主机，也不跟随 HTTP 重定向。

## 配置

使用 Pi extension flags；默认 cached，与官方默认搜索模式一致。要允许 live 外部访问：

```sh
pi -e ./src/index.ts --codex-search-mode live
```

| Flag | 默认 | 含义 |
| --- | --- | --- |
| --codex-search-mode | cached | disabled / cached / indexed / live |
| --codex-search-max-output-tokens | 10000 | 正整数，搜索输出预算 |
| --codex-search-settings | {} | 官方 SearchSettings JSON；覆盖 mode 派生的默认字段 |

SearchSettings 可包含：

```json
{
  "search_context_size": "high",
  "user_location": { "type": "approximate", "country": "US", "city": "San Francisco" },
  "filters": { "allowed_domains": ["openai.com"], "blocked_domains": ["example.com"] },
  "image_settings": { "max_results": 5, "caption": true },
  "allowed_callers": ["direct"],
  "external_web_access": true
}
```

`external_web_access` 接受 boolean 或 cached/indexed/live 字符串；模式映射为 cached → false，indexed → "indexed"，live → true。`disabled` 总是关闭工具。

## 与 Codex 的适配边界

以官方 commit [cc7ba33601286a751477832b01de7b6f8de0dd9c](https://github.com/openai/codex/tree/cc7ba33601286a751477832b01de7b6f8de0dd9c) 为基准，完整移植命令字段与官方工具说明，对齐 HTTP 契约、近期文本上下文、会话 ID、返回语义和重试策略。

Pi 的 Provider 筛选、认证存储、会话 ID、工具事件及模型目录与 Codex 不同，所以没有复制 Codex 的 feature gates、内部 telemetry、AgentIdentity 认证或工具事件 UI。输出预算通过 flag 配置，不读取 Codex 模型目录。客户端不伪装成 Codex CLI。

附加安全边界：整个请求及重试限时 60 秒，响应体限 8 MiB；不跟随重定向；超过 Pi 50 KiB / 2000 行限制的明文保存到临时文件并返回明确提示。未截断输出保持原样。服务端错误仅报告状态码，避免将任意错误体中的凭据写进会话。

重试与官方默认一致：首次请求 + 最多 4 次网络/5xx 重试，200ms 起指数退避并加抖动，遵循 Retry-After；429、其他 4xx、重定向、JSON/schema 错误和超大响应不重试。不自动切换端点或调用 Responses。

端点仍为 alpha。已通过本机 `OpenAI-WS / gpt-6-astra` 配置完成真实 API 冒烟测试：默认 cached 模式下 `search_query` 和同会话引用 `open` 均返回 HTTP 200；两次请求均直接执行插件工具，未发起额外的 Responses 模型调用。

## 开发与离线验证

```sh
npm ci --ignore-scripts
npm run check
npm test
```

测试启动时封锁全局 fetch、HTTP/HTTPS、TCP/TLS 连接。所有搜索响应和认证均为测试注入；没有集成真实 API 的测试开关。

从已存在的官方源码检出重新生成 schema 对照 fixture 和原版工具说明（仅本地读写，不下载源码）：

```sh
node scripts/sync-upstream.mjs C:/tmp/codex-search-reference
```

脚本检查固定 commit。fixture 由针对该组 Rust structs/unit enums 的有限提取器生成，不冒充运行完整 Schemars 编译器。上游来源与许可证见 THIRD_PARTY_NOTICES.md。
