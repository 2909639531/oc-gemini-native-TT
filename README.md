# OC Gemini Native（TauriTavern 版）v3.0.0

让 **OpenCode Go** 的 `gemini-4-argon-contributor` 在 TauriTavern 里跑起来，走 **Gemini 原生 `generateContent` 协议**。

装完之后，「聊天补全来源」下拉框里会多一项 **OpenCodeGo G4A 专属**。选中它、填一个 OCG 密钥，就能直接聊天——不用配假 API，也不用动你自己的其他 API 设置。

> **只支持 TauriTavern**（含 Android / iOS / 鸿蒙）。原版 SillyTavern 请用 [oc-gemini-native-st](https://github.com/2909639531/oc-gemini-native-st)。

---

## v3 做了什么：只修兼容性

v2.0.2 之前的版本在「不接管的时候也会接管」，导致很多人**装完之后原生 API 就废了**：

| 症状 | v2 的真实原因 | v3 的处理 |
| --- | --- | --- |
| 切回 Google AI Studio 报 `Invalid Google Gemini models page: missing field 'models'` / `reverse_proxy_unsupported` | `window.fetch` 被全局打补丁，只要 URL 含 `chat-completions/models` 就返回假数据，**不区分是哪个源在请求** | 补丁只拦「请求体里 `chat_completion_source === 'custom'` 且确实是我们」的请求，其余全部透传 |
| 原生 API 一发就报错 / 请求被送到 opencode | `CHAT_COMPLETION_SETTINGS_READY` 只看 `enabled`，不看当前真正在用的源；`enabled` 卡在 true 就把所有请求改写掉 | 加硬守卫：`generateData.chat_completion_source !== 'custom'` 一律原样放行 |
| 自己的「自定义（OpenAI 兼容）」源开始带奇怪的请求头 | 把 `x-opencode-session`、伪造 UA 持久化进了全局字段 `custom_include_headers` | 默认不再落盘；只在这一次请求的 payload 里带 |
| 自己填的 custom 密钥没了 | 无条件写 `api_key_custom` secret | 默认不写；打开开关时会先备份、退出时还原 |
| 下拉框自己跳回「OpenCodeGo G4A 专属」 | 启动时强制 `selectOcgOption()`，1.5s 后再补一刀 | 只在「确实处于接管状态」时做视觉对齐；发现源已被切走就自动释放 |
| 删了扩展还是坏的，得手动清 settings | 残留的 `custom_url` / `custom_include_headers` / `chat_completion_source` 没人收拾 | 启动自动修复 v1/v2 残骸，另有一键「彻底清理」 |

结论：**它现在只在「这一次请求本来就发往 custom 通道」时动手，别的时候完全是透明人。**

---

## 已经坏了？先恢复

升级到 v3 后，第一次启动会自动清掉 v1/v2 留下的痕迹。如果还想手动兜底：

**方式 A（推荐）** 打开「API 连接」→ 选中「OpenCodeGo G4A 专属」→ 点 **彻底清理**。

**方式 B（手动）** 完全退出 TauriTavern，编辑
`%APPDATA%\com.tauritavern.client\data\default-user\settings.json`，把下面几项改回去：

```jsonc
{
  "chat_completion_source": "makersuite",   // 或你原本在用的源
  "custom_url": "",                          // 原来有值就填回原来的
  "custom_model": "",
  "custom_api_format": "openai",
  "custom_include_headers": ""               // 里面不该有 x-opencode-session
}
```

同时删掉 `settings.json` 里 `extensionSettings["oc-gemini-native"]` 这一整块。

---

## 安装

### 方式一：应用内 Git 安装（推荐，手机端唯一可行）

在 TauriTavern 的**扩展管理**里，安装地址填本仓库地址，装完重启应用。

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

- 改模型 ID、改端点（粘完整端点也行，会自动退回 base URL）
- 看每次生成的耗时
- 调「思考档位」
- **还原并停用** / **彻底清理** / **诊断**

### 思考档位

默认 **不干预**，不选就不改任何东西。

| 选项 | 行为 |
| --- | --- |
| 不干预（默认） | 完全交给宿主，扩展不碰 `reasoning_effort` |
| low | 思考最少，最省 token、最快 |
| medium | 折中 |
| high | 想得最久，最贵 |

实测 `high` 档下思考约占输出 token 的 **39%**（1655 / 4244）。切到 `low` 能明显省钱提速。

### 两个「危险开关」（默认关）

都在面板底部，默认关闭，只有排查问题才需要开：

- **把密钥写进宿主的 custom secret** —— 会覆盖你自己填的 `api_key_custom`。开启后扩展会先备份原值，停用时还原。
- **把请求头写进 `custom_include_headers`** —— 这个字段是全局的，写进去之后你用回自己的 custom 源也会带着 `x-opencode-session`。

---

## 它到底做了什么

选中这个来源后：

| 动作 | 说明 |
| --- | --- |
| `chat_completion_source = custom` | 借用「自定义」通道（宿主没有 Gemini 原生源） |
| `custom_api_format = gemini_generate_content` | 强制 Gemini 原生协议 |
| `custom_url` 指向 `https://opencode.ai/inference/go/google/v1beta` | 自动归一化，容忍手滑粘错 |
| 注入 `x-opencode-session` | OpenCode 强制要求，按对话稳定，用于路由与缓存 |
| 注入 `Authorization` | **只在每次请求的 payload 里**临时拼，不落盘 |
| 清空 `custom_include_body` / `custom_exclude_body` | 这两个字段是你给 custom 源配的 JSON 注入规则，按 OpenAI 结构写的，套到 Gemini 原生 body 上会改坏请求。只在这一次请求里清空，不动你的设置 |

每次生成前在 `CHAT_COMPLETION_SETTINGS_READY` 里改写 payload，且**必须** `generateData.chat_completion_source === 'custom'` 才动手。

---

## 安全

- **仓库里没有任何密钥**，装完必须自己填
- 密钥**不会写进** `settings.json` / `presets.json`
- 默认也不写进宿主 secret，不写进 `custom_include_headers`
- 分享预设、备份配置，都不会把密钥带出去

---

## 排错

控制台过滤 `[OC Gemini Native]`（手机上可用 TauriTavern 2.4.0 的应用内 Agent 读日志）。
面板上的 **诊断** 按钮会把当前状态打成一段 JSON 打到控制台，贴给 agent 就能定位问题。

| 日志 | 含义 |
| --- | --- |
| `source option installed` | 下拉框选项注入成功 |
| `entered OCG mode` | 已接管 |
| `original custom config restored` | 已还原 |
| `legacy state repaired: ...` | 清掉了 v1/v2 的残骸 |
| `stale takeover detected ... releasing` | 发现你已经在别处切走，自动释放 |
| `skipped: active source is "..."` | 当前请求不是 custom 通道，已原样放行（这是**正常**的） |
| `v3.0.0 ready — enabled=…` | 启动完成 |

常见报错：

| 报错 | 原因 | 怎么办 |
| --- | --- | --- |
| `Authentication error: ... Go requires a credential` | 请求没带 `Authorization` | 面板密钥是否为空 |
| `Invalid credential` | 密钥错了或被吊销 | 重新填 |
| `MissingSessionID` | 缺 `x-opencode-session` | 检查是否被其他扩展覆盖了 payload |
| `Model does not support this protocol.` | 模型和端点协议不匹配 | 确认模型 ID 是 Gemini 系列 |
| `llm_connection_reverse_proxy_unsupported: custom egress does not support reverse proxy routing` | 宿主的 status 请求体**永远**会带 `reverse_proxy`，某些后端会因此直接拒绝；另一种情况是「备用服务商 URL」和「反向代理」叠加 | v3 的 status 兜底已经绕开了这条路。如果仍出现，关掉反向代理（两者不能叠加） |

---

## 已知限制

- 只对 TauriTavern 有效。原版 SillyTavern 没有 `custom_api_format` 这个字段
- 模型 ID 是手填的，扩展不会去拉模型列表（OpenCode 没有可用的 Gemini 列表接口）
- `gemini-4-argon-contributor` 是 contributor 档位，**对话内容会被用于训练**，敏感内容别用
- 单次生成常见 60~150 秒（prompt 大、`maxOutputTokens` 拉满），面板会显示耗时

---

## 版本

- **3.0.0** —— 兼容性重构：原生源零干扰、不再污染全局配置、自动修复 v1/v2 残骸、一键彻底清理、URL 归一化、诊断输出
- 2.0.2 —— 新增「思考档位」开关（默认不干预）
- 2.0.1 —— 修 `Go requires a credential`
- 2.0.0 —— 双版本拆分；修掉 1.x 的 7 个问题
- 1.3.0 —— 移除硬编码密钥
- 1.2.0 —— 修 status 兜底
- 1.1.0 —— 同层下拉选项 + 自动写 secret
- 1.0.0 —— 初版
