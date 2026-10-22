# OC Gemini Native（TauriTavern 版）

让 **OpenCode Go** 的 `gemini-4-argon-contributor` 在 TauriTavern 里跑起来，走 **Gemini 原生 `generateContent` 协议**。

装完之后，「聊天补全来源」下拉框里会多一项 **OpenCodeGo G4A 专属**。选中它、填一个 OCG 密钥，就能直接聊天——不用配假 API，也不用动你自己的其他 API 设置。

> **只支持 TauriTavern**（含 Android / iOS / 鸿蒙）。
> 原版 SillyTavern 请用 [oc-gemini-native-st](https://github.com/2909639531/oc-gemini-native-st)。

---

## 为什么需要它

OpenCode Go 一个 key 背后挂了四套互不相通的协议端点，模型和端点是**强绑定**的：

| 端点 | 协议 | 模型 |
|---|---|---|
| `/v1/chat/completions` | OpenAI 兼容 | GLM、Kimi、DeepSeek、MiMo… |
| `/v1/messages` | Anthropic | Claude Haiku、MiniMax、Qwen |
| `/v1/responses` | OpenAI Responses | Grok、GPT Luna、Muse Spark |
| `/google/v1beta/models/{m}:generateContent` | **Google 原生** | **Gemini 4 Argon** |

拿 OpenAI 兼容端点去请求 Gemini，必然得到：

```
400 Model does not support this protocol.
```

而酒馆原生的「自定义」源默认只会说 OpenAI 兼容。本扩展的作用就是**把请求强制改写成 Google 原生协议**，并补上 OpenCode 强制要求的 `x-opencode-session` 头。

---

## 安装

### 方式一：应用内 Git 安装（推荐，手机端唯一可行方式）

在 TauriTavern 的**扩展管理**里，安装地址填：

```
https://github.com/2909639531/oc-gemini-native-TT
```

安装完重启应用。

> 仓库必须是公开的——TauriTavern 只接受匿名 http(s) 的 Git 地址，私有仓库装不了。

### 方式二：手动拷贝（仅桌面端）

1. 完全退出 TauriTavern
2. 把仓库文件放到：
   ```
   %APPDATA%\com.tauritavern.client\data\default-user\extensions\oc-gemini-native\
   ```
   放好后应该是 `...\extensions\oc-gemini-native\manifest.json` 这个层级
3. 重新打开 TauriTavern

---

## 使用

1. 打开「API 连接」→「聊天补全来源」，选 **OpenCodeGo G4A 专属**
2. 下方出现小面板，把 `oc_sk_...` 密钥粘进去，点「保存」
3. 直接聊天

面板里还能：

- 改模型 ID
- 看每次生成的耗时
- 调「思考档位」
- 一键还原你接管前的配置

### 思考档位

默认 **不干预**，不选就不改任何东西。

| 选项 | 行为 |
|---|---|
| 不干预（默认） | 完全交给宿主，扩展不碰 `reasoning_effort` |
| low | 思考最少，最省 token、最快 |
| medium | 折中 |
| high | 想得最久，最贵 |

实测 `high` 档下思考约占输出 token 的 **39%**（1655 / 4244）。切到 `low` 能明显省钱提速。

---

## 它到底做了什么

选中这个来源后：

| 动作 | 说明 |
|---|---|
| `chat_completion_source = custom` | 借用「自定义」通道 |
| `custom_api_format = gemini_generate_content` | 强制 Gemini 原生协议 |
| `custom_url` | 指向 `https://opencode.ai/inference/go/google/v1beta` |
| 注入 `x-opencode-session` | OpenCode 强制要求，按对话稳定，用于路由与缓存 |
| 注入 `Authorization` | 每次请求临时拼进 payload，不落盘 |

每次生成前还会在 `CHAT_COMPLETION_SETTINGS_READY` 里再改写一遍 payload，防止被其他扩展覆盖。

---

## 安全

- **仓库里没有任何密钥**，装完必须自己填
- 密钥**不会写进** `settings.json` / `presets.json`：
  - 落盘的那份 `custom_include_headers` 只有 `x-opencode-session` 和 `user-agent`
  - 带 `Authorization` 的那份只在每次生成时临时出现在 payload 里
- 所以分享预设、备份配置，都不会把密钥带出去

---

## 已知限制

- 只对 TauriTavern 有效。原版 SillyTavern 没有 `custom_api_format` 这个字段
- 模型 ID 是手填的，扩展不会去拉模型列表（OpenCode 没有可用的 Gemini 列表接口）
- `gemini-4-argon-contributor` 是 contributor 档位，**对话内容会被用于训练**，敏感内容别用
- 单次生成常见 60~150 秒（prompt 大、`maxOutputTokens` 拉满），面板会显示耗时

---

## 排错

控制台过滤 `[OC Gemini Native]`（手机上可用 TauriTavern 2.4.0 的应用内 Agent 读日志）：

| 日志 | 含义 |
|---|---|
| `source option installed` | 下拉框选项注入成功 |
| `entered OCG mode` | 已接管 |
| `snapshot saved` | 已备份你原来的配置 |
| `status request intercepted` | 模型列表兜底生效 |
| `v2.0.2 ready — enabled=… hasKey=…` | 启动完成；`hasKey=false` 说明还没填密钥 |

常见报错：

| 报错 | 原因 | 怎么办 |
|---|---|---|
| `Authentication error: ... Go requires a credential` | 请求没带 `Authorization` | 检查面板密钥是否为空 |
| `Invalid credential` | 密钥错了或被吊销 | 重新填 |
| `MissingSessionID` | 缺 `x-opencode-session` | 检查是否被其他扩展覆盖了 payload |
| `Model does not support this protocol.` | 模型和端点协议不匹配 | 确认模型 ID 是 Gemini 系列 |

---

## 版本

- 2.0.2 —— 新增「思考档位」开关（默认不干预）
- 2.0.1 —— 修 `Go requires a credential`：宿主不会自己补 `Authorization`，改为每次请求临时带上
- 2.0.0 —— 双版本拆分；修掉 1.x 的 7 个问题（内置密钥、默认接管、配置覆盖、预设泄露、下拉框冲突、status 兜底、无耗时反馈）
- 1.3.0 —— 移除硬编码密钥
- 1.2.0 —— 修 status 兜底
- 1.1.0 —— 同层下拉选项 + 自动写 secret
- 1.0.0 —— 初版
