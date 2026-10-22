'use strict';

/**
 * OC Gemini Native — TauriTavern 版
 * v2.0.2
 *
 * 在「聊天补全来源」下拉框里新增一个同层选项「OpenCodeGo G4A 专属」。
 * 选中后只需填 OCG 密钥，其余全部由扩展接管：
 *   - chat_completion_source = custom
 *   - custom_api_format = gemini_generate_content
 *   - custom_url / custom_model 自动写入
 *   - 密钥写入 ST 的 CUSTOM secret（api_key_custom）
 *   - 每次生成前再强制改写一次 payload 并注入 x-opencode-session
 *
 * 与 1.x 的关键区别（全部是修 bug）：
 *   1. 不再内置任何密钥，默认 apiKey 为空串。
 *   2. 默认 enabled = false：装上不会自动接管，必须手动选中本选项。
 *   3. 首次接管前备份用户原有的「自定义」配置，退出时还原。
 *   4. 密钥默认不写进 custom_include_headers（避免明文落到 presets.json）。
 *   5. 本选项插在原有 custom 选项之前，.val('custom') 会命中我们，不再视觉跳回。
 *   6. status / 模型列表兜底同时兼容 {models:[...]} 与 {data:[...]}。
 *   7. 生成计时，面板显示耗时。
 */

const MODULE_NAME = 'oc-gemini-native';
const LOG_PREFIX = '[OC Gemini Native]';
const OCG_LABEL = 'OpenCodeGo G4A 专属';

const DEFAULT_SETTINGS = {
    enabled: false,
    // 不预置任何密钥。必须在面板里手动填写，避免随扩展一起被分发出去。
    apiKey: '',
    baseUrl: 'https://opencode.ai/inference/go/google/v1beta',
    model: 'gemini-4-argon-contributor',
    spoofUserAgent: true,
    userAgent: 'opencode/1.0 (oc-gemini-native)',
    fakeStatus: true,
    // 思考档位：'' = 不干预（保持宿主默认，推荐）。可选 low / medium / high。
    // 非空时写进 payload 的 reasoning_effort，由宿主映射成 thinkingConfig.thinkingLevel。
    thinkingLevel: '',
    // 兼容开关：某些宿主版本不会自动从 secret 补 Authorization，这时打开它
    inlineAuth: false,
    // 接管前的原始自定义配置快照
    backup: null,
};

/* ------------------------------------------------------------------ */
/* settings                                                            */
/* ------------------------------------------------------------------ */

function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    if (!extensionSettings[MODULE_NAME] || typeof extensionSettings[MODULE_NAME] !== 'object') {
        extensionSettings[MODULE_NAME] = { ...DEFAULT_SETTINGS };
    }
    const s = extensionSettings[MODULE_NAME];
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (s[key] === undefined || s[key] === null) s[key] = DEFAULT_SETTINGS[key];
    }
    return s;
}

function persistSettings() {
    try {
        SillyTavern.getContext().saveSettingsDebounced();
    } catch (e) {
        console.warn(LOG_PREFIX, 'settings save failed', e);
    }
}

function getOai() {
    try {
        return SillyTavern.getContext().chatCompletionSettings || null;
    } catch {
        return null;
    }
}

/* ------------------------------------------------------------------ */
/* session id                                                          */
/* ------------------------------------------------------------------ */

function fnv32(str, seed) {
    let h = seed >>> 0;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}

function buildSessionId() {
    let ctx = {};
    try {
        ctx = SillyTavern.getContext();
    } catch {
        ctx = {};
    }
    const seed = [ctx.chatId || '', ctx.characterId ?? '', ctx.name2 || '', ctx.groupId || ''].join('|');
    const hex =
        fnv32(seed, 0x811c9dc5) +
        fnv32(seed, 0x01000193) +
        fnv32(seed + '#1', 0x9e3779b9) +
        fnv32(seed + '#2', 0x85ebca6b);
    return 'ses_' + hex.slice(0, 32);
}

/* ------------------------------------------------------------------ */
/* headers                                                             */
/* ------------------------------------------------------------------ */

function yamlScalar(value) {
    return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function toHeaderYaml(headers) {
    return Object.entries(headers)
        .map(([k, v]) => `${k}: ${yamlScalar(v)}`)
        .join('\n');
}

/**
 * 构造请求头。
 * @param {boolean} includeAuth 是否带上 Authorization。
 *   持久化到设置里的那份**必须**是 false（否则密钥明文落进 settings.json / presets.json）；
 *   每次生成前的请求 payload 里**必须**是 true —— TauriTavern 的 custom 源不会自己
 *   从 api_key_custom 补 Authorization，实测会报
 *   "Authentication error: Upstream request failed: Go requires a credential"。
 */
function buildHeaders(includeAuth) {
    const s = getSettings();
    const headers = {
        'x-opencode-session': buildSessionId(),
        'x-opencode-client': 'oc-gemini-native/2.0.1',
    };
    if (includeAuth && s.apiKey) headers.Authorization = `Bearer ${s.apiKey}`;
    if (s.spoofUserAgent) headers['user-agent'] = s.userAgent;
    return headers;
}

/* ------------------------------------------------------------------ */
/* secret                                                              */
/* ------------------------------------------------------------------ */

async function writeCustomSecret(key) {
    if (!key) return false;
    try {
        const headers =
            typeof getRequestHeaders === 'function'
                ? getRequestHeaders()
                : { 'Content-Type': 'application/json' };
        const res = await fetch('/api/secrets/write', {
            method: 'POST',
            headers,
            body: JSON.stringify({ key: 'api_key_custom', value: key }),
        });
        if (!res.ok) {
            console.warn(LOG_PREFIX, 'secret write rejected', res.status);
            return false;
        }
        return true;
    } catch (e) {
        console.warn(LOG_PREFIX, 'secret write failed', e);
        return false;
    }
}

/* ------------------------------------------------------------------ */
/* backup / restore                                                    */
/* ------------------------------------------------------------------ */

const BACKUP_KEYS = [
    'chat_completion_source',
    'custom_api_format',
    'custom_url',
    'custom_model',
    'custom_include_headers',
];

function snapshotCustomConfig(oai) {
    const snap = {};
    for (const k of BACKUP_KEYS) snap[k] = oai[k];
    return snap;
}

function restoreCustomConfig(oai, snap) {
    if (!oai || !snap) return;
    for (const k of BACKUP_KEYS) {
        if (snap[k] !== undefined) oai[k] = snap[k];
    }
}

/* ------------------------------------------------------------------ */
/* apply / release                                                     */
/* ------------------------------------------------------------------ */

function applyOcgConfig() {
    const s = getSettings();
    const oai = getOai();
    if (!oai) return;
    oai.chat_completion_source = 'custom';
    oai.custom_api_format = 'gemini_generate_content';
    oai.custom_url = s.baseUrl;
    oai.custom_model = s.model;
    // 落盘的那份默认不带密钥（inlineAuth 打开才带，仅供排查）
    oai.custom_include_headers = toHeaderYaml(buildHeaders(!!s.inlineAuth));
    persistSettings();
}

async function enterOcgMode() {
    const s = getSettings();
    const oai = getOai();
    if (!oai) return;

    if (!s.enabled) {
        // 只在「从关闭切到开启」时备份一次，避免重启后被自己的配置覆盖
        s.backup = snapshotCustomConfig(oai);
        s.enabled = true;
        console.debug(LOG_PREFIX, 'snapshot saved', s.backup);
    }

    applyOcgConfig();
    if (s.apiKey) await writeCustomSecret(s.apiKey);
    updateOcgPanel(true);
    setTimeout(syncUiFields, 50);
    console.debug(LOG_PREFIX, 'entered OCG mode', { model: s.model });
}

function leaveOcgMode() {
    const s = getSettings();
    const oai = getOai();
    s.enabled = false;
    if (oai && s.backup) {
        restoreCustomConfig(oai, s.backup);
        console.debug(LOG_PREFIX, 'original custom config restored');
        s.backup = null;
        persistSettings();
    }
    updateOcgPanel(false);
}

function restoreNow() {
    const s = getSettings();
    const oai = getOai();
    if (oai && s.backup) {
        restoreCustomConfig(oai, s.backup);
        s.backup = null;
        s.enabled = false;
        persistSettings();
        syncUiFields();
        updateOcgPanel(false);
        toastr.success('已还原接管前的自定义配置，扩展已停用', OCG_LABEL);
    } else {
        toastr.info('没有可还原的备份', OCG_LABEL);
    }
}

/** 让 ST 自己的输入框也显示正确的值，避免界面看起来是空的。 */
function syncUiFields() {
    const s = getSettings();
    const map = {
        '#custom_api_url_text': s.baseUrl,
        '#custom_model_id': s.model,
        '#custom_api_format': 'gemini_generate_content',
    };
    for (const [sel, val] of Object.entries(map)) {
        const $el = $(sel);
        if (!$el.length) {
            console.debug(LOG_PREFIX, 'ui field not found:', sel);
            continue;
        }
        $el.val(val);
    }
}

/* ------------------------------------------------------------------ */
/* payload rewrite                                                     */
/* ------------------------------------------------------------------ */

function onChatCompletionSettingsReady(generateData) {
    const settings = getSettings();
    if (!settings.enabled) return;
    if (!generateData || typeof generateData !== 'object') return;

    try {
        generateData.chat_completion_source = 'custom';
        generateData.custom_api_format = 'gemini_generate_content';
        generateData.custom_url = settings.baseUrl;
        generateData.model = settings.model;
        generateData.custom_model = settings.model;
        // 只在这个一次性 payload 里带密钥：不落盘，也不进请求日志（宿主只记 body 不记 header）
        generateData.custom_include_headers = toHeaderYaml(buildHeaders(true));

        // 思考档位：只有用户显式选了才动，默认完全交给宿主
        if (settings.thinkingLevel) {
            generateData.reasoning_effort = settings.thinkingLevel;
        }
    } catch (e) {
        console.error(LOG_PREFIX, 'rewrite failed', e);
    }
}

/* ------------------------------------------------------------------ */
/* status / model list fallback                                        */
/* ------------------------------------------------------------------ */

function buildFakeModelsPayload() {
    const model = getSettings().model;
    const entry = {
        name: `models/${model}`,
        displayName: model,
        description: 'opencode go',
        supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
        inputTokenLimit: 1048576,
        outputTokenLimit: 65535,
    };
    // 同时给 Gemini 与 OpenAI 两种形状，哪个解析器都能吃下
    return { models: [entry], data: [{ id: model, object: 'model', owned_by: 'opencode' }] };
}

function installStatusFallback() {
    if (window.__ocGeminiNativeFetchPatched) return;
    const originalFetch = window.fetch;
    if (typeof originalFetch !== 'function') return;
    window.__ocGeminiNativeFetchPatched = true;

    window.fetch = async function (input, init) {
        let url = '';
        try {
            url = typeof input === 'string' ? input : (input && input.url) || '';
        } catch {
            url = '';
        }

        const s = getSettings();
        const isStatus =
            url.includes('chat-completions/status') ||
            url.includes('chat_completion_status') ||
            url.includes('chat-completions/models');

        if (!isStatus || !s.enabled || !s.fakeStatus) {
            return originalFetch.apply(this, arguments);
        }

        console.debug(LOG_PREFIX, 'status request intercepted:', url);
        return new Response(JSON.stringify(buildFakeModelsPayload()), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    };
}

/* ------------------------------------------------------------------ */
/* generation timer                                                    */
/* ------------------------------------------------------------------ */

let genTimer = null;
let genStart = 0;

function startGenTimer() {
    if (genTimer) return;
    genStart = Date.now();
    genTimer = setInterval(() => {
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
/* UI                                                                  */
/* ------------------------------------------------------------------ */

function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** 在「聊天补全来源」下拉框里插入同层选项（插在原有 custom 之前）。 */
function installSourceOption() {
    const $select = $('#chat_completion_source');
    if (!$select.length) return false;
    if ($select.find('option[data-ocg]').length) return true;

    const $opt = $(`<option value="custom" data-ocg="1">${OCG_LABEL}</option>`);
    const $original = $select.find('option[value="custom"]').first();
    if ($original.length) {
        // 插在前面：任何 .val('custom') 都会命中我们，避免视觉跳回原选项
        $original.before($opt);
    } else {
        $select.append($opt);
    }
    console.debug(LOG_PREFIX, 'source option installed');
    return true;
}

function isOcgSelected() {
    const el = document.getElementById('chat_completion_source');
    if (!el) return false;
    const opt = el.options[el.selectedIndex];
    return !!(opt && opt.dataset && opt.dataset.ocg);
}

function selectOcgOption() {
    const el = document.getElementById('chat_completion_source');
    if (!el) return;
    for (let i = 0; i < el.options.length; i++) {
        if (el.options[i].dataset && el.options[i].dataset.ocg) {
            el.selectedIndex = i;
            return;
        }
    }
}

function renderOcgPanel() {
    if ($('#ocg_panel').length) return;
    const s = getSettings();
    const html = `
    <div id="ocg_panel" class="ocg-panel" style="display:none;">
      <div class="ocg-panel-title">${OCG_LABEL}</div>
      <label for="ocg_key_input">OCG 密钥</label>
      <div class="ocg-key-row">
        <input type="text" id="ocg_key_input" class="text_pole" placeholder="oc_sk_..." value="${escapeHtml(s.apiKey)}">
        <div id="ocg_key_status" class="menu_button">保存</div>
      </div>
      <label for="ocg_model_input">模型 ID</label>
      <input type="text" id="ocg_model_input" class="text_pole" value="${escapeHtml(s.model)}">
      <label for="ocg_thinking">思考档位</label>
      <select id="ocg_thinking" class="text_pole">
        <option value="">不干预（默认，推荐）</option>
        <option value="low">low — 省 token，最快</option>
        <option value="medium">medium — 折中</option>
        <option value="high">high — 想得最久，最贵</option>
      </select>
      <div class="ocg-actions">
        <div id="ocg_restore" class="menu_button">还原原始配置</div>
        <label class="checkbox_label"><input type="checkbox" id="ocg_inline_auth" ${s.inlineAuth ? 'checked' : ''}> 把密钥也写进配置（排查用，会落盘）</label>
      </div>
      <div id="ocg_status_line" class="ocg-hint"></div>
      <small class="ocg-hint">填好密钥即可直接聊天。协议、端点、请求头全部自动接管，不会改动你的其他 API 配置。</small>
    </div>`;
    $('#chat_completion_source').closest('div').after(html);

    $('#ocg_key_input').on('input', function () {
        getSettings().apiKey = String(this.value).trim();
        persistSettings();
    });
    $('#ocg_model_input').on('input', function () {
        getSettings().model = String(this.value).trim() || DEFAULT_SETTINGS.model;
        persistSettings();
        if (getSettings().enabled) applyOcgConfig();
    });
    $('#ocg_thinking').val(s.thinkingLevel || '').on('change', function () {
        getSettings().thinkingLevel = String(this.value);
        persistSettings();
        console.debug(LOG_PREFIX, 'thinkingLevel =', getSettings().thinkingLevel || '(不干预)');
    });
    $('#ocg_inline_auth').on('change', function () {
        getSettings().inlineAuth = !!this.checked;
        persistSettings();
        if (getSettings().enabled) applyOcgConfig();
    });
    $('#ocg_restore').on('click', restoreNow);
    $('#ocg_key_status').on('click', async function () {
        const key = String($('#ocg_key_input').val() || '').trim();
        getSettings().apiKey = key;
        persistSettings();
        if (!key) {
            toastr.warning('密钥为空', OCG_LABEL);
            return;
        }
        const ok = await writeCustomSecret(key);
        applyOcgConfig();
        toastr[ok ? 'success' : 'warning'](ok ? '密钥已写入并生效' : '密钥写入失败，看控制台', OCG_LABEL);
    });
}

function updateOcgPanel(on) {
    $('#ocg_panel').toggle(!!on);
}

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

function bindSourceSelect() {
    const $select = $('#chat_completion_source');
    if (!$select.length) return;

    $select.on('change.ocg', function () {
        const on = isOcgSelected();
        // 等 ST 自己的 change 处理完再接管，避免被它覆盖
        setTimeout(() => {
            if (on) enterOcgMode();
            else leaveOcgMode();
        }, 0);
    });
}

jQuery(async () => {
    const { eventSource, event_types } = SillyTavern.getContext();

    installStatusFallback();
    renderOcgPanel();

    if (event_types) {
        const hook = (name, fn) => {
            if (event_types[name]) eventSource.on(event_types[name], fn);
        };
        hook('GENERATION_STARTED', startGenTimer);
        hook('GENERATION_ENDED', stopGenTimer);
        hook('GENERATION_STOPPED', stopGenTimer);
    }

    let tries = 0;
    const timer = setInterval(() => {
        tries += 1;
        if (installSourceOption() || tries > 40) {
            clearInterval(timer);
            bindSourceSelect();

            const s = getSettings();
            // 没密钥就不算"已启用"，避免空密钥状态下悄悄接管配置
            if (s.enabled && !s.apiKey) {
                s.enabled = false;
                persistSettings();
            }
            if (s.enabled) {
                // 恢复上次的接管状态：把选中项拨回我们，再重放一次配置
                selectOcgOption();
                applyOcgConfig();
                if (s.apiKey) writeCustomSecret(s.apiKey);
                updateOcgPanel(true);
                setTimeout(syncUiFields, 100);
                // 宿主可能在我们之后再还原一次选中项，补一刀
                setTimeout(selectOcgOption, 1500);
            }
            console.log(`${LOG_PREFIX} v2.0.2 ready — enabled=${s.enabled} model=${s.model} hasKey=${!!s.apiKey}`);
        }
    }, 250);

    eventSource.makeLast(event_types.CHAT_COMPLETION_SETTINGS_READY, onChatCompletionSettingsReady);
});
