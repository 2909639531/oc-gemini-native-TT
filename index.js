'use strict';

/**
 * OC Gemini Native — TauriTavern 版
 * v3.0.0（兼容性重构）
 *
 * 目的不变：让 OpenCode Go 的 gemini-4-argon-contributor 走 Gemini 原生
 * generateContent 协议。做法仍然是「借用宿主的 custom 通道」，但 v3 把
 * 「借用」的范围压到了最小，并且保证任何情况下都能干净还原。
 *
 * ── v2 为什么会把用户的「原生 API」搞坏 ────────────────────────────
 *   1. CHAT_COMPLETION_SETTINGS_READY 里只看 enabled，不看当前真正在用的源，
 *      enabled 一旦卡在 true，连 Google AI Studio / OpenAI 的请求都会被改写成
 *      opencode 的 custom 请求 → 原生连接直接报错。
 *   2. 把 x-opencode-session / 伪造的 user-agent 持久化进了
 *      custom_include_headers。这个字段是全局的：用户之后用回自己的
 *      「自定义（OpenAI 兼容）」源，也会带着这两个头去打第三方端点。
 *   3. 无条件写 api_key_custom secret，直接覆盖用户自己填的 custom 密钥。
 *   4. window.fetch 被全局打补丁，只要 URL 里含 chat-completions/models 就返回
 *      假数据，不区分是哪个源在请求 → 别的服务商的模型列表/连通性测试被污染。
 *   5. 启动时强制 selectOcgOption() + 1.5s 后再补一刀，用户切回原生源会被拨回来。
 *   6. 只做了「保存快照 / 点按钮还原」，卸载扩展、清缓存、换设备后残留的
 *      custom_url / custom_include_headers / chat_completion_source 没人收拾。
 *
 * ── v3 的兼容性策略 ──────────────────────────────────────────────
 *   A. 单一写入点：只在 CHAT_COMPLETION_SETTINGS_READY 里改「这一次请求」的
 *      payload，并且必须 generateData.chat_completion_source === 'custom' 才动手。
 *      不是 custom 的请求一律原样放行，绝不改源。
 *   B. 默认零落盘污染：请求头不写进 settings，secret 不写（除非用户手动打开）。
 *   C. 不留残骸：启动时自动修复 v1/v2 留下的痕迹（opencode 的 URL、x-opencode-session
 *      头、被改掉的 chat_completion_source），并提供「彻底清理」。
 *   D. fetch 补丁只拦「确实是 custom 源 + 目标是我们」的 status/models 请求，
 *      其余全部透传；并提供卸载函数。
 *   E. 所有宿主 API 都做存在性判断，宿主版本不认识的东西只降级、不抛错。
 */

const MODULE_NAME = 'oc-gemini-native';
const LOG_PREFIX = '[OC Gemini Native]';
const VERSION = '3.0.0';
const OCG_LABEL = 'OpenCodeGo G4A 专属';

/** 我们自己写进 settings 的痕迹标记，用于启动时自动修复 */
const MARK_HEADER = 'x-opencode-session';
const MARK_URL_RE = /opencode\.ai\/inference\/go/i;

const DEFAULT_SETTINGS = {
    enabled: false,
    // 不预置任何密钥。必须在面板里手动填写。
    apiKey: '',
    baseUrl: 'https://opencode.ai/inference/go/google/v1beta',
    model: 'gemini-4-argon-contributor',
    // 默认沿用 v2 的取值：这条路径在真机上是验证过能通的，没有理由改
    spoofUserAgent: true,
    userAgent: 'opencode/1.0 (oc-gemini-native)',
    // 宿主没有 Gemini 的模型列表接口，兜底返回一个假列表，避免「无可用模型」。
    fakeStatus: true,
    // 思考档位：'' = 不干预（保持宿主默认）。
    thinkingLevel: '',
    // 兼容开关（默认全关，都是「会把东西落盘」的危险操作）
    persistHeaders: false,   // 把我们的请求头写进 custom_include_headers
    writeSecret: false,      // 把密钥写进宿主的 api_key_custom secret
    // 运行时状态
    backup: null,            // 接管前的 custom 配置快照
    secretBackup: null,      // 接管前 api_key_custom 的值（仅 writeSecret 时）
    wroteSecret: false,
    backupSuspect: false,    // 快照是「事后补的」，可能已经是我们自己的值
};

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function ctx() {
    try {
        return (typeof SillyTavern !== 'undefined' && SillyTavern.getContext && SillyTavern.getContext()) || {};
    } catch {
        return {};
    }
}

function log(...args) {
    console.debug(LOG_PREFIX, ...args);
}

function warn(...args) {
    console.warn(LOG_PREFIX, ...args);
}

const warned = new Set();
function warnOnce(key, ...args) {
    if (warned.has(key)) return;
    warned.add(key);
    warn(...args);
}

function toast(kind, message) {
    try {
        if (typeof toastr !== 'undefined' && toastr && typeof toastr[kind] === 'function') {
            toastr[kind](message, OCG_LABEL);
            return;
        }
    } catch { /* ignore */ }
    log(`[${kind}] ${message}`);
}

/* ------------------------------------------------------------------ */
/* settings                                                            */
/* ------------------------------------------------------------------ */

function getSettings() {
    const c = ctx();
    const store = c.extensionSettings;
    if (!store || typeof store !== 'object') {
        // 极端情况：宿主还没准备好 extensionSettings，用内存兜底，不抛错。
        if (!getSettings.__mem) getSettings.__mem = { ...DEFAULT_SETTINGS };
        return getSettings.__mem;
    }
    if (!store[MODULE_NAME] || typeof store[MODULE_NAME] !== 'object') {
        store[MODULE_NAME] = { ...DEFAULT_SETTINGS };
    }
    const s = store[MODULE_NAME];
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (s[key] === undefined || s[key] === null) s[key] = DEFAULT_SETTINGS[key];
    }
    // 清理 2.x 遗留字段
    if ('inlineAuth' in s) delete s.inlineAuth;
    return s;
}

function persistSettings() {
    const c = ctx();
    try {
        if (typeof c.saveSettingsDebounced === 'function') c.saveSettingsDebounced();
    } catch (e) {
        warn('settings save failed', e);
    }
}

function getOai() {
    const c = ctx();
    return c.chatCompletionSettings || c.oai_settings || (typeof oai_settings !== 'undefined' ? oai_settings : null) || null;
}

/* ------------------------------------------------------------------ */
/* URL / header                                                        */
/* ------------------------------------------------------------------ */

/**
 * 把用户填的东西收拾成一个干净的 base URL。
 * 允许直接粘完整端点（.../models/xxx:generateContent），自动退回到 base。
 */
function normalizeBaseUrl(raw) {
    let url = String(raw || '').trim();
    if (!url) return DEFAULT_SETTINGS.baseUrl;
    url = url.replace(/\s+/g, '');
    url = url.replace(/\/models\/[^/:]+:(streamGenerateContent|generateContent)$/i, '');
    url = url.replace(/\/models\/?$/i, '');
    url = url.replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    return url;
}

function fnv32(str, seed) {
    let h = seed >>> 0;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}

function buildSessionId() {
    const c = ctx();
    const seed = [c.chatId || '', c.characterId ?? '', c.name2 || '', c.groupId || ''].join('|');
    const hex =
        fnv32(seed, 0x811c9dc5) +
        fnv32(seed, 0x01000193) +
        fnv32(seed + '#1', 0x9e3779b9) +
        fnv32(seed + '#2', 0x85ebca6b);
    return 'ses_' + hex.slice(0, 32);
}

function yamlScalar(value) {
    return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function toHeaderYaml(headers) {
    return Object.entries(headers)
        .map(([k, v]) => `${k}: ${yamlScalar(v)}`)
        .join('\n');
}

/**
 * @param {boolean} includeAuth 只有「这一次请求」的 payload 才带密钥。
 */
function buildHeaders(includeAuth) {
    const s = getSettings();
    const headers = {
        [MARK_HEADER]: buildSessionId(),
        'x-opencode-client': `oc-gemini-native/${VERSION}`,
    };
    if (includeAuth && s.apiKey) headers.Authorization = `Bearer ${s.apiKey}`;
    if (s.spoofUserAgent) headers['user-agent'] = s.userAgent;
    return headers;
}

/* ------------------------------------------------------------------ */
/* secret（默认不碰）                                                   */
/* ------------------------------------------------------------------ */

function requestHeaders() {
    try {
        if (typeof getRequestHeaders === 'function') return getRequestHeaders();
    } catch { /* ignore */ }
    return { 'Content-Type': 'application/json' };
}

async function readCustomSecret() {
    try {
        const res = await window.fetch('/api/secrets/view', {
            method: 'POST',
            headers: requestHeaders(),
            body: JSON.stringify({ key: 'api_key_custom' }),
        });
        if (!res || !res.ok) return null;
        const data = await res.json();
        return data && typeof data.value === 'string' ? data.value : null;
    } catch {
        return null;
    }
}

async function writeCustomSecret(key) {
    if (!key) return false;
    try {
        const res = await window.fetch('/api/secrets/write', {
            method: 'POST',
            headers: requestHeaders(),
            body: JSON.stringify({ key: 'api_key_custom', value: key }),
        });
        if (!res || !res.ok) {
            warn('secret write rejected', res && res.status);
            return false;
        }
        return true;
    } catch (e) {
        warn('secret write failed', e);
        return false;
    }
}

async function syncSecret() {
    const s = getSettings();
    if (!s.writeSecret || !s.apiKey) return false;
    if (!s.wroteSecret) {
        // 覆盖前先记下用户原来的 custom 密钥，退出时还原
        s.secretBackup = await readCustomSecret();
    }
    const ok = await writeCustomSecret(s.apiKey);
    if (ok) {
        s.wroteSecret = true;
        persistSettings();
    }
    return ok;
}

async function restoreSecret() {
    const s = getSettings();
    if (!s.wroteSecret) return;
    if (s.secretBackup) await writeCustomSecret(s.secretBackup);
    s.wroteSecret = false;
    s.secretBackup = null;
    persistSettings();
    log('api_key_custom restored');
}

/* ------------------------------------------------------------------ */
/* 快照 / 还原                                                          */
/* ------------------------------------------------------------------ */

const BACKUP_KEYS = [
    'chat_completion_source',
    'custom_api_format',
    'custom_url',
    'custom_model',
    'custom_include_headers',
];

/** 「彻底清理」之后本次会话不再自动注入任何东西，直到用户主动重新选中 */
let cleanedUp = false;

function snapshotCustomConfig(oai) {
    const snap = {};
    for (const k of BACKUP_KEYS) snap[k] = oai[k];
    return snap;
}

function restoreCustomConfig(oai, snap) {
    if (!oai || !snap || typeof snap !== 'object') return false;
    let touched = false;
    for (const k of BACKUP_KEYS) {
        if (snap[k] !== undefined) {
            oai[k] = snap[k];
            touched = true;
        }
    }
    return touched;
}

/**
 * 启动时修复 v1 / v2 留下的残骸。
 * 只在「扩展当前没启用」时跑，且只认我们自己的特征，绝不误伤用户的正常配置。
 */
function repairLegacyState() {
    const s = getSettings();
    const oai = getOai();
    if (!oai || s.enabled) return;

    const snap = s.backup;
    const headerLooksOurs = String(oai.custom_include_headers || '').includes(MARK_HEADER);
    const urlLooksOurs = MARK_URL_RE.test(String(oai.custom_url || ''));
    if (!headerLooksOurs && !urlLooksOurs) return;

    const fixed = [];
    if (headerLooksOurs) {
        oai.custom_include_headers = snap && snap.custom_include_headers !== undefined ? snap.custom_include_headers : '';
        fixed.push('custom_include_headers');
    }
    if (urlLooksOurs) {
        oai.custom_url = snap && snap.custom_url !== undefined ? snap.custom_url : '';
        fixed.push('custom_url');
    }
    if (snap && snap.chat_completion_source && oai.chat_completion_source !== snap.chat_completion_source) {
        oai.chat_completion_source = snap.chat_completion_source;
        fixed.push('chat_completion_source');
    }
    s.backup = null;
    s.backupSuspect = false;
    persistSettings();
    log('legacy state repaired:', fixed.join(', '));
}

/* ------------------------------------------------------------------ */
/* apply / release                                                     */
/* ------------------------------------------------------------------ */

function applyOcgConfig() {
    const s = getSettings();
    const oai = getOai();
    if (!oai) return false;

    // 只写「借用通道」必需的 4 个字段。
    oai.chat_completion_source = 'custom';
    oai.custom_api_format = 'gemini_generate_content';
    oai.custom_url = normalizeBaseUrl(s.baseUrl);
    oai.custom_model = s.model;

    // 默认不落盘请求头：这个字段是全局的，写进去会污染用户自己的 custom 源。
    if (s.persistHeaders) {
        oai.custom_include_headers = toHeaderYaml(buildHeaders(false));
    } else if (String(oai.custom_include_headers || '').includes(MARK_HEADER)) {
        // 之前开过开关、留下了我们的头 → 关掉时要把用户的原始值放回去
        oai.custom_include_headers = s.backup && s.backup.custom_include_headers !== undefined
            ? s.backup.custom_include_headers
            : '';
    }

    persistSettings();
    return true;
}

async function enterOcgMode() {
    const s = getSettings();
    const oai = getOai();
    if (!oai) {
        warn('host settings not available, cannot take over');
        return;
    }

    // 用户做过「彻底清理」后又主动选回来：把看门狗和 fetch 补丁一并恢复
    if (cleanedUp) {
        cleanedUp = false;
        installStatusFallback();
    }

    if (!s.enabled || !s.backup) {
        // 如果当前配置已经带着我们的特征，说明这份「原始快照」其实是我们自己写的，
        // 还原它等于什么都没做。标记出来，UI 上会提示。
        const looksOurs =
            MARK_URL_RE.test(String(oai.custom_url || '')) ||
            String(oai.custom_include_headers || '').includes(MARK_HEADER);
        s.backup = snapshotCustomConfig(oai);
        s.backupSuspect = looksOurs;
        if (looksOurs) warn('backup taken from an already-hijacked config, it may be useless');
    }
    s.enabled = true;
    applyOcgConfig();
    if (s.writeSecret) await syncSecret();
    persistSettings();
    updateOcgPanel(true);
    refreshHostCustomFields();
    renderStatus();
    log('entered OCG mode', { model: s.model, url: oai.custom_url });
}

async function leaveOcgMode() {
    const s = getSettings();
    const oai = getOai();
    s.enabled = false;

    if (oai && s.backup) {
        restoreCustomConfig(oai, s.backup);
        s.backup = null;
        s.backupSuspect = false;
        log('original custom config restored');
    }
    await restoreSecret();
    persistSettings();
    updateOcgPanel(false);
    refreshHostCustomFields();
    renderStatus();
}

async function restoreNow() {
    const s = getSettings();
    const hadBackup = !!s.backup;
    await leaveOcgMode();
    if (hadBackup) {
        toast('success', '已还原接管前的自定义配置，扩展已停用');
    } else {
        toast('info', '没有可还原的备份，扩展已停用');
    }
}

/**
 * 彻底清理：还原 + 删掉我们写过的 secret + 移除注入的下拉项 + 清空扩展设置。
 * 对应「让 agent 把相关内容删了就好」那一步，现在一个按钮搞定。
 */
async function hardReset() {
    const s = getSettings();
    const oai = getOai();

    if (oai && s.backup) restoreCustomConfig(oai, s.backup);
    await restoreSecret();

    // 只清「看起来是我们的」残留，不碰用户自己的 custom 配置
    if (oai) {
        if (String(oai.custom_include_headers || '').includes(MARK_HEADER)) oai.custom_include_headers = '';
        if (MARK_URL_RE.test(String(oai.custom_url || ''))) oai.custom_url = '';
    }

    s.enabled = false;
    s.backup = null;
    s.backupSuspect = false;
    s.apiKey = '';
    s.writeSecret = false;
    s.persistHeaders = false;
    s.secretBackup = null;
    s.wroteSecret = false;
    cleanedUp = true;

    removeSourceOption();
    selectRealCustomOption();
    try { $('#ocg_key_input').val(''); } catch { /* ignore */ }
    // 连 fetch 补丁也一起撤掉，做到「真的没留东西」
    try {
        if (typeof window.__ocGeminiNativeFetchRestore === 'function') window.__ocGeminiNativeFetchRestore();
    } catch { /* ignore */ }
    persistSettings();
    updateOcgPanel(false);
    refreshHostCustomFields();
    renderStatus();
    toast('success', '已彻底清理：配置、密钥、下拉项都已还原');
    log('hard reset done');
}

/** 让宿主的 custom 输入框显示真实值（先比对再写，避免无意义地刷 ST 的 change 事件）。 */
function refreshHostCustomFields() {
    const oai = getOai();
    if (!oai) return;
    const pairs = [
        ['#custom_api_url_text', oai.custom_url],
        ['#custom_model_id', oai.custom_model],
        ['#custom_api_format', oai.custom_api_format],
    ];
    for (const [sel, val] of pairs) {
        if (val === undefined) continue;
        const el = document.querySelector(sel);
        if (!el || el.value === val) continue;

        if (el.tagName === 'SELECT') {
            // 宿主的下拉里没有这个值时不要硬塞，否则 change 会把字段刷成空串
            const has = Array.prototype.some.call(el.options || [], (o) => o.value === val);
            if (!has) continue;
            el.value = val;
            try {
                el.dispatchEvent(new Event('change', { bubbles: true }));
            } catch { /* ignore */ }
        } else {
            el.value = val;
            try {
                el.dispatchEvent(new Event('input', { bubbles: true }));
            } catch { /* ignore */ }
        }
    }
}

/* ------------------------------------------------------------------ */
/* payload rewrite —— 唯一允许改请求的地方                               */
/* ------------------------------------------------------------------ */

function onChatCompletionSettingsReady(generateData) {
    const s = getSettings();
    if (!s.enabled) return;
    if (!generateData || typeof generateData !== 'object') return;

    // 【关键守卫】不是走 custom 通道的请求，一律原样放行。
    // v2 缺这一句，enabled 卡住时连 Google AI Studio 的请求都会被改写。
    // payload 里没这个字段的宿主版本，退回去看 settings 里记的源；
    // 两边都拿不到才按 custom 处理（保持对老宿主的兼容）。
    let source = generateData.chat_completion_source;
    if (source === undefined || source === null) {
        const oai = getOai();
        source = oai ? oai.chat_completion_source : undefined;
    }
    if (source !== undefined && source !== null && source !== 'custom') {
        warnOnce(
            'skip-non-custom',
            `skipped: active source is "${source}", not custom. `
            + 'Your native API connection is left untouched.',
        );
        return;
    }

    try {
        const baseUrl = normalizeBaseUrl(s.baseUrl);
        generateData.custom_api_format = 'gemini_generate_content';
        generateData.custom_url = baseUrl;
        generateData.custom_model = s.model;
        generateData.model = s.model;
        // 密钥只在这一次性 payload 里出现，不落盘
        generateData.custom_include_headers = toHeaderYaml(buildHeaders(true));

        // 宿主会把用户给 custom 源配的 body 注入 / 剔除规则一起带过来。
        // 那些规则是按 OpenAI 的 JSON 结构写的，套到 Gemini 原生 body 上会直接改坏请求。
        if (generateData.custom_include_body || generateData.custom_exclude_body) {
            warnOnce('strip-body-hooks', 'custom_include_body / custom_exclude_body cleared for this request');
        }
        generateData.custom_include_body = '';
        generateData.custom_exclude_body = '';

        if (s.thinkingLevel) generateData.reasoning_effort = s.thinkingLevel;
    } catch (e) {
        warn('rewrite failed', e);
    }
}

/* ------------------------------------------------------------------ */
/* status / model 兜底（严格限定作用域）                                 */
/* ------------------------------------------------------------------ */

function buildFakeModelsPayload() {
    const model = getSettings().model;
    return {
        models: [
            {
                name: `models/${model}`,
                displayName: model,
                description: 'opencode go',
                supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
                inputTokenLimit: 1048576,
                outputTokenLimit: 65535,
            },
        ],
        data: [{ id: model, object: 'model', owned_by: 'opencode' }],
    };
}

function readBodySource(input, init) {
    try {
        const body = init && init.body;
        if (typeof body === 'string') {
            const parsed = JSON.parse(body);
            return parsed && typeof parsed === 'object' ? parsed.chat_completion_source : undefined;
        }
    } catch { /* ignore */ }
    return undefined;
}

function shouldFakeStatus(input, init) {
    const s = getSettings();
    if (!s.enabled || !s.fakeStatus) return false;

    let url = '';
    try {
        url = typeof input === 'string' ? input : (input && input.url) || '';
    } catch {
        return false;
    }
    const isStatus =
        url.includes('chat-completions/status') ||
        url.includes('chat_completion_status') ||
        url.includes('chat-completions/models');
    if (!isStatus) return false;

    // 请求体里明确写了别的源 → 绝不插嘴
    const source = readBodySource(input, init);
    if (source !== undefined) return source === 'custom';

    // 没有请求体时，只在「界面确实选中了我们」的情况下兜底
    return isOcgSelected();
}

function installStatusFallback() {
    if (window.__ocGeminiNativeFetchPatched) return;
    const originalFetch = window.fetch;
    if (typeof originalFetch !== 'function') return;

    window.__ocGeminiNativeFetchPatched = true;
    window.__ocGeminiNativeFetchRestore = function () {
        window.fetch = originalFetch;
        window.__ocGeminiNativeFetchPatched = false;
        delete window.__ocGeminiNativeFetchRestore;
    };

    window.fetch = async function (input, init) {
        try {
            if (shouldFakeStatus(input, init)) {
                log('status request intercepted');
                return new Response(JSON.stringify(buildFakeModelsPayload()), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
        } catch (e) {
            warn('status hook error, passing through', e);
        }
        return originalFetch.apply(this, arguments);
    };
}

/* ------------------------------------------------------------------ */
/* 生成计时                                                            */
/* ------------------------------------------------------------------ */

let genTimer = null;
let genStart = 0;
// 生成失败时宿主不一定会发 GENERATION_ENDED，计时器会一直转，加个兜底上限
const GEN_TIMEOUT_MS = 15 * 60 * 1000;

function startGenTimer() {
    if (genTimer) return;
    genStart = Date.now();
    genTimer = setInterval(() => {
        if (Date.now() - genStart > GEN_TIMEOUT_MS) {
            stopGenTimer();
            return;
        }
        const sec = ((Date.now() - genStart) / 1000).toFixed(0);
        $('#ocg_status_line').text(`生成中… ${sec}s`);
    }, 500);
}

function stopGenTimer() {
    if (!genTimer) return;
    clearInterval(genTimer);
    genTimer = null;
    const sec = ((Date.now() - genStart) / 1000).toFixed(1);
    $('#ocg_status_line').text(`上次生成 ${sec}s`);
}

/* ------------------------------------------------------------------ */
/* 下拉框                                                              */
/* ------------------------------------------------------------------ */

function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * 注入同层选项。
 * value 仍然复用宿主已有的 'custom'：宿主内部有一堆按 source 值分支的逻辑，
 * 塞一个它不认识的值会直接走到 default 分支（面板全隐藏 / 抛 Invalid source）。
 */
function installSourceOption() {
    const select = document.getElementById('chat_completion_source');
    if (!select) return false;
    if (select.querySelector('option[data-ocg]')) return true;

    const opt = document.createElement('option');
    opt.value = 'custom';
    opt.dataset.ocg = '1';
    opt.textContent = OCG_LABEL;

    const original = select.querySelector('option[value="custom"]');
    if (original) original.before(opt);
    else select.appendChild(opt);
    log('source option installed');
    return true;
}

function removeSourceOption() {
    const select = document.getElementById('chat_completion_source');
    if (!select) return;
    const opt = select.querySelector('option[data-ocg]');
    if (opt) {
        opt.remove();
        log('source option removed');
    }
}

function isOcgSelected() {
    const el = document.getElementById('chat_completion_source');
    if (!el) return false;
    const opt = el.options[el.selectedIndex];
    return !!(opt && opt.dataset && opt.dataset.ocg);
}

/** 仅做「视觉对齐」：只在确实处于接管状态时拨回去，不再无脑抢焦点。 */
function selectOcgOption() {
    const el = document.getElementById('chat_completion_source');
    if (!el) return;
    for (let i = 0; i < el.options.length; i++) {
        if (el.options[i].dataset && el.options[i].dataset.ocg) {
            if (el.selectedIndex !== i) el.selectedIndex = i;
            return;
        }
    }
}

/**
 * 反过来：没接管时把选中项拨回真正的「自定义」选项。
 * 我们的选项和宿主原选项的 value 都是 'custom'，不拨回来的话界面会一直显示
 * 「OpenCodeGo G4A 专属」，而实际根本没接管 —— 纯视觉误导。
 */
function selectRealCustomOption() {
    const el = document.getElementById('chat_completion_source');
    if (!el) return;
    for (let i = 0; i < el.options.length; i++) {
        const o = el.options[i];
        if (o.value === 'custom' && !(o.dataset && o.dataset.ocg)) {
            if (el.selectedIndex !== i) el.selectedIndex = i;
            return;
        }
    }
}

/* ------------------------------------------------------------------ */
/* UI                                                                  */
/* ------------------------------------------------------------------ */

function renderOcgPanel() {
    if ($('#ocg_panel').length) return;
    const s = getSettings();
    const html = `
    <div id="ocg_panel" class="ocg-panel" style="display:none;">
      <div class="ocg-panel-title">${OCG_LABEL} <small class="ocg-version">v${VERSION}</small></div>
      <label for="ocg_key_input">OCG 密钥</label>
      <div class="ocg-key-row">
        <input type="text" id="ocg_key_input" class="text_pole" placeholder="oc_sk_..." value="${escapeHtml(s.apiKey)}">
        <div id="ocg_key_status" class="menu_button">保存</div>
      </div>
      <label for="ocg_model_input">模型 ID</label>
      <input type="text" id="ocg_model_input" class="text_pole" value="${escapeHtml(s.model)}">
      <label for="ocg_base_url">端点（base URL）</label>
      <input type="text" id="ocg_base_url" class="text_pole" value="${escapeHtml(s.baseUrl)}">
      <label for="ocg_thinking">思考档位</label>
      <select id="ocg_thinking" class="text_pole">
        <option value="">不干预（默认，推荐）</option>
        <option value="low">low — 省 token，最快</option>
        <option value="medium">medium — 折中</option>
        <option value="high">high — 想得最久，最贵</option>
      </select>
      <div class="ocg-actions">
        <div id="ocg_restore" class="menu_button">还原并停用</div>
        <div id="ocg_reset" class="menu_button ocg-danger">彻底清理</div>
        <div id="ocg_diag" class="menu_button">诊断</div>
      </div>
      <div class="ocg-advanced">
        <label class="checkbox_label"><input type="checkbox" id="ocg_write_secret" ${s.writeSecret ? 'checked' : ''}> 把密钥写进宿主的 custom secret（会覆盖你自己的 custom 密钥）</label>
        <label class="checkbox_label"><input type="checkbox" id="ocg_persist_headers" ${s.persistHeaders ? 'checked' : ''}> 把请求头写进 custom_include_headers（会污染你自己的 custom 源）</label>
        <label class="checkbox_label"><input type="checkbox" id="ocg_spoof_ua" ${s.spoofUserAgent ? 'checked' : ''}> 伪造 user-agent</label>
      </div>
      <div id="ocg_status_line" class="ocg-hint"></div>
      <small class="ocg-hint">只在「本次请求走 custom 通道」时改写 payload，不动你的其他 API 配置。切换回任何原生源都会自动还原。</small>
    </div>`;
    $('#chat_completion_source').closest('div').after(html);

    $('#ocg_key_input').on('input', function () {
        getSettings().apiKey = String(this.value).trim();
        persistSettings();
    });
    $('#ocg_model_input').on('input', function () {
        const s2 = getSettings();
        s2.model = String(this.value).trim() || DEFAULT_SETTINGS.model;
        persistSettings();
        if (s2.enabled) applyOcgConfig();
    });
    $('#ocg_base_url').on('change', function () {
        const s2 = getSettings();
        s2.baseUrl = normalizeBaseUrl(this.value);
        this.value = s2.baseUrl;
        persistSettings();
        if (s2.enabled) applyOcgConfig();
    });
    $('#ocg_thinking').val(s.thinkingLevel || '').on('change', function () {
        getSettings().thinkingLevel = String(this.value);
        persistSettings();
    });
    $('#ocg_write_secret').on('change', function () {
        const s2 = getSettings();
        s2.writeSecret = !!this.checked;
        persistSettings();
        // 关掉时要用户原来的 secret 放回去，别留个「我们的密钥还在里面」的状态
        if (!this.checked) restoreSecret();
        else if (s2.enabled && s2.apiKey) syncSecret();
    });
    $('#ocg_persist_headers').on('change', function () {
        const s2 = getSettings();
        s2.persistHeaders = !!this.checked;
        persistSettings();
        if (s2.enabled) applyOcgConfig();
    });
    $('#ocg_spoof_ua').on('change', function () {
        const s2 = getSettings();
        s2.spoofUserAgent = !!this.checked;
        persistSettings();
        if (s2.enabled) applyOcgConfig();
    });
    $('#ocg_restore').on('click', restoreNow);
    $('#ocg_reset').on('click', hardReset);
    $('#ocg_diag').on('click', () => {
        const report = buildDiagnostics();
        console.info(LOG_PREFIX, 'diagnostics\n' + report);
        toast('info', '诊断信息已输出到控制台');
    });
    $('#ocg_key_status').on('click', async function () {
        const s2 = getSettings();
        const key = String($('#ocg_key_input').val() || '').trim();
        s2.apiKey = key;
        persistSettings();
        if (!key) {
            toast('warning', '密钥为空');
            return;
        }
        let ok = true;
        if (s2.writeSecret) ok = await syncSecret();
        if (s2.enabled) applyOcgConfig();
        renderStatus();
        toast(ok ? 'success' : 'warning', ok ? '密钥已保存并生效' : '密钥已保存，但写入 secret 失败');
    });
}

function updateOcgPanel(on) {
    $('#ocg_panel').toggle(!!on);
}

function renderStatus() {
    const s = getSettings();
    const oai = getOai();
    const parts = [];
    parts.push(s.enabled ? '已接管' : '未接管');
    parts.push(`源=${(oai && oai.chat_completion_source) || '?'}`);
    parts.push(s.apiKey ? '有密钥' : '无密钥');
    parts.push(s.backup ? '有备份' : '无备份');
    if (s.backupSuspect) parts.push('⚠ 备份不可靠');
    // 宿主的 status 请求体里永远带 reverse_proxy，某些后端会因此直接拒绝
    if (oai && oai.reverse_proxy) parts.push('⚠ 反向代理已开');
    $('#ocg_status_line').text(parts.join(' · '));
}

function buildDiagnostics() {
    const s = getSettings();
    const oai = getOai() || {};
    const el = document.getElementById('chat_completion_source');
    return JSON.stringify(
        {
            version: VERSION,
            enabled: s.enabled,
            optionSelected: isOcgSelected(),
            selectValue: el ? el.value : null,
            hasKey: !!s.apiKey,
            hasBackup: !!s.backup,
            backupSuspect: s.backupSuspect,
            host: {
                chat_completion_source: oai.chat_completion_source,
                custom_api_format: oai.custom_api_format,
                custom_url: oai.custom_url,
                custom_model: oai.custom_model,
                custom_include_headers: String(oai.custom_include_headers || '').slice(0, 200),
                // 宿主侧会拦住「自定义端点 + 反向代理」的组合，排查时一眼能看到
                reverse_proxy: oai.reverse_proxy || '',
                has_include_body: !!oai.custom_include_body,
                has_exclude_body: !!oai.custom_exclude_body,
            },
            effectiveUrl: normalizeBaseUrl(s.baseUrl),
            model: s.model,
            thinkingLevel: s.thinkingLevel || '(不干预)',
            writeSecret: s.writeSecret,
            persistHeaders: s.persistHeaders,
            fetchPatched: !!window.__ocGeminiNativeFetchPatched,
        },
        null,
        2,
    );
}

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

function bindSourceSelect() {
    const $select = $('#chat_completion_source');
    if (!$select.length) return;

    $select.off('change.ocg').on('change.ocg', function () {
        // 等宿主自己的 change 处理完再动手，避免互相覆盖
        setTimeout(() => {
            if (isOcgSelected()) {
                enterOcgMode();
            } else if (getSettings().enabled) {
                // 用户切到任何别的源（包括真正的「自定义」）→ 立刻还原，不再纠缠
                leaveOcgMode();
            }
        }, 0);
    });
}

function hookEvents() {
    const c = ctx();
    const eventSource = c.eventSource;
    const types = c.event_types || {};
    if (!eventSource || typeof eventSource.on !== 'function') {
        warn('eventSource unavailable, generation hooks disabled');
        return;
    }
    const hook = (name, fn) => {
        const t = types[name];
        if (t) eventSource.on(t, fn);
    };
    hook('GENERATION_STARTED', startGenTimer);
    hook('GENERATION_ENDED', stopGenTimer);
    hook('GENERATION_STOPPED', stopGenTimer);

    const ready = types.CHAT_COMPLETION_SETTINGS_READY;
    if (!ready) {
        warn('CHAT_COMPLETION_SETTINGS_READY missing — this host version is not supported');
        return;
    }
    if (typeof eventSource.makeLast === 'function') eventSource.makeLast(ready, onChatCompletionSettingsReady);
    else eventSource.on(ready, onChatCompletionSettingsReady);
}

function boot() {
    installStatusFallback();
    repairLegacyState();
    renderOcgPanel();
    hookEvents();

    let tries = 0;
    const timer = setInterval(() => {
        tries += 1;
        const ok = installSourceOption();
        if (!ok && tries <= 40) return;
        clearInterval(timer);
        if (!ok) {
            warn('chat_completion_source not found, giving up');
            return;
        }
        // 宿主 UI 如果比扩展晚渲染，这里补一次面板
        if (!document.getElementById('ocg_panel')) renderOcgPanel();
        bindSourceSelect();

        const s = getSettings();
        // 没密钥就不算「已启用」：顺手把配置还原，别留个「已接管但用不了」的状态
        if (s.enabled && !s.apiKey) {
            warn('no key, releasing takeover');
            leaveOcgMode();
            return;
        }
        if (s.enabled) {
            const oai = getOai();
            // 自愈：宿主里记的源已经不是 custom，说明用户在别处切走了 → 别再抢
            if (oai && oai.chat_completion_source && oai.chat_completion_source !== 'custom') {
                warn(`stale takeover detected (source=${oai.chat_completion_source}), releasing`);
                leaveOcgMode();
            } else {
                selectOcgOption();      // 只做视觉对齐
                applyOcgConfig();
                if (s.writeSecret && s.apiKey) syncSecret();
                updateOcgPanel(true);
                refreshHostCustomFields();
                renderStatus();
            }
        } else if (isOcgSelected()) {
            // 没接管却显示着我们的选项 → 拨回真正的 custom，避免界面说谎
            selectRealCustomOption();
        }
        log(`v${VERSION} ready — enabled=${s.enabled} model=${s.model} hasKey=${!!s.apiKey}`);
    }, 250);

    // 看门狗：宿主重新渲染设置面板时，select 节点会被整个换掉，
    // 选项和 change 监听都会丢。低频轮询比 MutationObserver 更能扛这种重建。
    setInterval(() => {
        if (cleanedUp) return;
        const el = document.getElementById('chat_completion_source');
        if (!el) return;
        if (el.querySelector('option[data-ocg]')) return;
        installSourceOption();
        bindSourceSelect();
        if (getSettings().enabled) selectOcgOption();
        else selectRealCustomOption();
    }, 3000);
}

jQuery(() => {
    try {
        boot();
    } catch (e) {
        console.error(LOG_PREFIX, 'boot failed', e);
    }
});
