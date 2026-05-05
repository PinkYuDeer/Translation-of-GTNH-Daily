// ==UserScript==
// @name         GTNH Daily ParaTranz Helper
// @namespace    paratranz-auto-100
// @version      5.1
// @description  1) 导入发布的逐文件 PT 压缩包,按当前文件回填旧汉化并 Ctrl+S; 2) 兼容旧 GregTech_US.lang / zh_CN.lang; 3) 翻译记忆 ≥100% 匹配复制保存; 4) "在文本中"全字相等仅复制; 5) 数字/电压差异迁移
// @match        https://paratranz.cn/*
// @run-at       document-idle
// @require      https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function () {
    'use strict';

    // ============ 常量 ============
    const COPY_TO_SAVE_DELAY = 450;
    const FILL_TO_SAVE_DELAY = 250;
    const LOG = true;
    const STORE_EN = 'lang_en_raw_v1';
    const STORE_ZH = 'lang_zh_raw_v1';
    const STORE_EN_META = 'lang_en_meta_v1';
    const STORE_ZH_META = 'lang_zh_meta_v1';
    const STORE_PKG_INDEX = 'lang_pkg_index_v2';
    const STORE_PKG_META = 'lang_pkg_meta_v2';
    const STORE_PKG_FILE_PREFIX = 'lang_pkg_file_v2:';
    const STORE_CONFIG = 'config_v1';

    const DEFAULT_CONFIG = {
        enableLangFill: true,         // A 旧 lang 回填
        enableTmPerfect: true,        // B 翻译记忆 ≥100% 匹配
        enableTokenDiffTransfer: true,// D 顶部 TM 原文仅数字/电压差异时自动迁移
        enableTmInText: true,         // C "在文本中" 全字相等仅复制
        convertParens: true,          // 回填时 () → ()
        enableAutoFillOriginal: false,// E 显示"自动填充原文"浮动面板(用于颜表情等原文即译文的情况)
    };

    // 浮动面板上的手动开关(不持久化,每次刷新默认关闭,避免误触)
    let autoFillArmed = false;

    const log = (...a) => LOG && console.log('%c[Auto100]', 'color:#00a6ff', ...a);
    const delay = (ms) => new Promise((r) => setTimeout(r, ms));

    // ============ 配置 ============
    let config = { ...DEFAULT_CONFIG, ...(GM_getValue(STORE_CONFIG, {}) || {}) };
    function saveConfig() { GM_setValue(STORE_CONFIG, config); }

    function transformForFill(text) {
        let out = text;
        if (config.convertParens) {
            // 半角 ( / ) → 全角 \uFF08 / \uFF09
            out = out.replace(/\(/g, '\uFF08').replace(/\)/g, '\uFF09');
        }
        return out;
    }

    /** 读当前翻译框的值,按配置转换后写回(若发生变化) */
    function normalizeTextareaValue() {
        const ta = getTextarea();
        if (!ta) return false;
        const before = ta.value;
        const after = transformForFill(before);
        if (after !== before) {
            setTextareaValue(after);
            log('已规范化翻译框标点:', before, '→', after);
            return true;
        }
        return false;
    }

    // ============ .lang / 发布包解析 ============
    function parseLang(text, { reverse }) {
        const map = new Map();
        const re = /^\s*(?:S:)?(?:"([^"]+)"|([^=\s]+))\s*=(.*)$/;
        for (const line of text.split(/\r?\n/)) {
            const trimmed = line.trimStart();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const m = line.match(re);
            if (!m) continue;
            const key = m[1] || m[2];
            const val = decodeLangValue(m[3]);
            if (reverse) {
                if (!map.has(val)) map.set(val, key);
            } else {
                map.set(key, val);
            }
        }
        return map;
    }

    let enToKey = null;
    let zhByKey = null;
    let packageIndex = null;
    const packageFileCache = new Map();

    function decodeLangValue(value) {
        return String(value).replace(/\\n/g, '\n');
    }

    function normalizePtPath(path) {
        let out = String(path || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
        try { out = decodeURIComponent(out); } catch (_) {}
        if (out.startsWith('files/')) out = out.slice('files/'.length);
        if (out.endsWith('.json')) out = out.slice(0, -'.json'.length);
        if (out === 'GregTech_zh_CN.lang' || out === 'GregTech_US.lang') out = 'GregTech.lang';
        return out;
    }

    function pathSegment(path) {
        const p = normalizePtPath(path);
        return (p.match(/(?:resources|config\/txloader\/(?:load|forceload))\/([^/]+)\/lang\//) || [])[1] || '';
    }

    function displayAndModId(path) {
        const seg = pathSegment(path);
        if (!seg) return [];
        const m = seg.match(/^(.*?)\[([^\]]+)\]$/);
        if (!m) return [seg];
        return [m[1], m[2]];
    }

    function isGregTechFamilyPath(path) {
        const p = normalizePtPath(path);
        if (p.toLowerCase() === 'gregtech.lang') return true;
        return /^(?:GregTech|GTNH|GT_)/i.test(pathSegment(p));
    }

    function aliasesForPath(path) {
        const p = normalizePtPath(path);
        const aliases = new Set();
        if (p) {
            aliases.add(p.toLowerCase());
            aliases.add(`${p}.json`.toLowerCase());
            aliases.add(p.replace(/zh_CN\.lang$/, 'en_US.lang').toLowerCase());
        }
        for (const part of displayAndModId(p)) {
            if (part && part.trim()) aliases.add(`module:${part.trim().toLowerCase()}`);
        }
        if (isGregTechFamilyPath(p)) aliases.add('gregtech:shared');
        return [...aliases];
    }

    function currentPtPath() {
        const el = document.querySelector('.breadcrumb-item.active span[aria-current="location"], .breadcrumb-item.active span');
        const text = el ? el.textContent.trim() : '';
        if (text) return normalizePtPath(text);
        return '';
    }

    function packageStorageId(i, file) {
        let h = 2166136261;
        for (const ch of file.ptPath) {
            h ^= ch.charCodeAt(0);
            h = Math.imul(h, 16777619);
        }
        return `f${i}_${(h >>> 0).toString(36)}`;
    }

    function packageStatus() {
        return GM_getValue(STORE_PKG_META, null);
    }

    function loadPackageIndex() {
        packageIndex = GM_getValue(STORE_PKG_INDEX, null);
        return !!(packageIndex && packageIndex.byAlias);
    }

    function clearPackageStore() {
        const idx = GM_getValue(STORE_PKG_INDEX, null);
        if (idx && Array.isArray(idx.files)) {
            for (const f of idx.files)
                GM_deleteValue(STORE_PKG_FILE_PREFIX + f.id);
        }
        GM_deleteValue(STORE_PKG_INDEX);
        GM_deleteValue(STORE_PKG_META);
        packageIndex = null;
        packageFileCache.clear();
    }

    function buildOriginalMap(entries) {
        const byOriginal = new Map();
        const byOriginalTrim = new Map();
        for (const e of entries || []) {
            if (!e || !e.translation || !String(e.translation).trim()) continue;
            const original = String(e.original || '');
            const hit = { key: e.key || '', translation: String(e.translation), source: e.source || '' };
            if (!byOriginal.has(original)) byOriginal.set(original, hit);
            const trimmed = original.trim();
            if (trimmed && !byOriginalTrim.has(trimmed)) byOriginalTrim.set(trimmed, hit);
        }
        return { byOriginal, byOriginalTrim };
    }

    function loadPackageFile(id) {
        if (packageFileCache.has(id)) return packageFileCache.get(id);
        const data = GM_getValue(STORE_PKG_FILE_PREFIX + id, null);
        if (!data) return null;
        const loaded = { ...data, ...buildOriginalMap(data.entries) };
        packageFileCache.set(id, loaded);
        return loaded;
    }

    function findPackageTranslation(original) {
        if (!packageIndex && !loadPackageIndex()) return null;
        const aliases = aliasesForPath(currentPtPath());
        const ids = new Set();
        for (const alias of aliases) {
            const hit = packageIndex.byAlias[alias.toLowerCase()];
            if (Array.isArray(hit)) hit.forEach(id => ids.add(id));
        }
        if (ids.size === 0) return null;
        for (const id of ids) {
            const file = loadPackageFile(id);
            if (!file) continue;
            const hit = file.byOriginal.get(original) || file.byOriginalTrim.get(String(original).trim());
            if (hit) return { ...hit, source: file.ptPath };
        }
        return null;
    }

    function normalizePackageFile(raw, i) {
        const ptPath = normalizePtPath(raw.ptPath || raw.packZhPath || raw.path || `file-${i}.lang`);
        const aliases = new Set([...(raw.aliases || []), ...aliasesForPath(ptPath)]);
        const entries = (raw.entries || []).map(e => ({
            key: String(e.key || ''),
            original: String(e.original || ''),
            translation: String(e.translation || ''),
            stage: Number(e.stage || 0),
        }));
        return { ptPath, aliases: [...aliases].map(a => String(a).toLowerCase()), entries };
    }

    function parseLangEntries(text) {
        const out = new Map();
        const re = /^\s*(?:S:)?(?:"([^"]+)"|([^=\s]+))\s*=(.*)$/;
        for (const line of text.split(/\r?\n/)) {
            const trimmed = line.trimStart();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const m = line.match(re);
            if (!m) continue;
            out.set(m[1] || m[2], decodeLangValue(m[3]));
        }
        return out;
    }

    function ptPathFromZhPackPath(path) {
        const p = normalizePtPath(path);
        if (p === 'GregTech_zh_CN.lang' || p === 'GregTech_US.lang') return 'GregTech.lang';
        return p.replace(/en_US\.lang$/, 'zh_CN.lang');
    }

    async function filesFromLangZip(zip) {
        const names = Object.keys(zip.files).filter(name => !zip.files[name].dir);
        const byName = new Map(names.map(name => [normalizePtPath(name).toLowerCase(), name]));
        const files = [];
        for (const name of names) {
            const norm = normalizePtPath(name);
            if (!/(?:^|\/|_)en_US\.lang$/i.test(norm) && norm !== 'GregTech_US.lang') continue;
            const zhNorm = norm === 'GregTech_US.lang'
                ? 'GregTech_zh_CN.lang'
                : norm.replace(/en_US\.lang$/i, 'zh_CN.lang');
            const zhName = byName.get(normalizePtPath(zhNorm).toLowerCase());
            if (!zhName) continue;
            const enText = await zip.files[name].async('string');
            const zhText = await zip.files[zhName].async('string');
            const en = parseLangEntries(enText);
            const zh = parseLangEntries(zhText);
            const entries = [];
            for (const [key, original] of en) {
                entries.push({
                    key,
                    original,
                    translation: zh.get(key) || '',
                    stage: zh.has(key) && zh.get(key) ? 1 : 0,
                });
            }
            files.push(normalizePackageFile({
                ptPath: ptPathFromZhPackPath(zhNorm),
                entries,
            }, files.length));
        }
        return files;
    }

    async function importPackageZip(file) {
        if (typeof JSZip === 'undefined') throw new Error('JSZip 未加载,无法解析 zip');
        const zip = await JSZip.loadAsync(await file.arrayBuffer());
        const manifestEntry = zip.file('pt-lang-package.json') || zip.file('manifest.json');
        let manifest = null;
        let files = [];
        if (manifestEntry) {
            manifest = JSON.parse(await manifestEntry.async('string'));
            files = (manifest.files || []).map(normalizePackageFile);
        } else {
            files = await filesFromLangZip(zip);
        }
        if (files.length === 0) throw new Error('压缩包内未找到 pt-lang-package.json 或可配对的 en_US/zh_CN.lang');

        clearPackageStore();
        const byAlias = {};
        const summaries = [];
        let entryCount = 0;
        files.forEach((f, i) => {
            const id = packageStorageId(i, f);
            const entries = f.entries.filter(e => e.original && e.translation && String(e.translation).trim());
            entryCount += entries.length;
            GM_setValue(STORE_PKG_FILE_PREFIX + id, { ptPath: f.ptPath, entries });
            for (const alias of f.aliases) {
                const key = alias.toLowerCase();
                (byAlias[key] ||= []).push(id);
            }
            summaries.push({ id, ptPath: f.ptPath, aliases: f.aliases, entryCount: entries.length });
        });
        const idx = {
            version: 2,
            importedAt: Date.now(),
            packageName: file.name,
            createdAt: manifest?.createdAt || '',
            projectId: manifest?.projectId || '',
            files: summaries,
            byAlias,
        };
        GM_setValue(STORE_PKG_INDEX, idx);
        GM_setValue(STORE_PKG_META, {
            name: file.name,
            size: file.size,
            mtime: Date.now(),
            files: summaries.length,
            entries: entryCount,
            createdAt: idx.createdAt,
        });
        packageIndex = idx;
        packageFileCache.clear();
        log(`已导入逐文件发布包:${file.name} (${summaries.length} 文件, ${entryCount} 条可回填译文)`);
        return idx;
    }

    function loadFromStore() {
        const hasPackage = loadPackageIndex();
        try {
            const us = GM_getValue(STORE_EN, '');
            const zh = GM_getValue(STORE_ZH, '');
            if (!us || !zh) return hasPackage;
            enToKey = parseLang(us, { reverse: true });
            zhByKey = parseLang(zh, { reverse: false });
            log(`已从油猴存储加载 .lang:US ${enToKey.size} 条, zh ${zhByKey.size} 条`);
            return true;
        } catch (e) {
            log('解析已存储的 .lang 失败:', e);
            return hasPackage;
        }
    }

    function saveToStore(which, fileName, text) {
        const meta = { name: fileName, size: text.length, mtime: Date.now() };
        if (which === 'en') {
            GM_setValue(STORE_EN, text);
            GM_setValue(STORE_EN_META, meta);
        } else {
            GM_setValue(STORE_ZH, text);
            GM_setValue(STORE_ZH_META, meta);
        }
    }

    function clearStore() {
        [STORE_EN, STORE_ZH, STORE_EN_META, STORE_ZH_META].forEach(GM_deleteValue);
        enToKey = null;
        zhByKey = null;
    }

    const storeStatus = () => ({
        en: GM_getValue(STORE_EN_META, null),
        zh: GM_getValue(STORE_ZH_META, null),
        pkg: GM_getValue(STORE_PKG_META, null),
    });

    // ============ 上传 ============
    function promptUpload(which, onDone) {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = which === 'pkg' ? '.zip,application/zip' : '.lang,.txt,text/plain';
        input.style.display = 'none';
        input.addEventListener('change', async () => {
            const file = input.files && input.files[0];
            input.remove();
            if (!file) return;
            try {
                if (which === 'pkg') {
                    if (!/\.zip$/i.test(file.name))
                        throw new Error('请导入 GitHub Release 发布的 .zip 包');
                    await importPackageZip(file);
                } else {
                    const text = await file.text();
                    saveToStore(which, file.name, text);
                    log(`已保存 ${which === 'en' ? 'US.lang' : 'zh_CN.lang'}:${file.name} (${file.size} 字节)`);
                }
                loadFromStore();
                if (onDone) onDone(file);
            } catch (err) {
                alert('读取文件失败:' + (err && err.message ? err.message : err));
            }
        });
        document.body.appendChild(input);
        input.click();
    }

    // ============ 页面弹窗(上传引导)============
    let bannerEl = null;
    function showUploadBanner() {
        if (bannerEl) return;
        const st = storeStatus();
        const bar = document.createElement('div');
        bannerEl = bar;
        bar.style.cssText = [
            'position:fixed', 'top:10px', 'right:10px', 'z-index:99999',
            'background:#1f2937', 'color:#fff', 'padding:12px 14px',
            'border-radius:8px', 'box-shadow:0 4px 16px rgba(0,0,0,.35)',
            'font:13px/1.5 system-ui,sans-serif', 'max-width:320px',
        ].join(';');
        bar.innerHTML =
            '<div style="font-weight:600;margin-bottom:6px;">旧汉化回填未就绪</div>' +
            '<div style="margin-bottom:8px;opacity:.85;">优先导入 GitHub Release 发布的逐文件 .zip 包；旧双 .lang 仍可兼容。</div>' +
            '<div style="display:grid;gap:6px;">' +
            '<button data-act="pkg" style="padding:5px 8px;border:0;border-radius:5px;cursor:pointer;background:#059669;color:#fff;">' +
            (st.pkg ? '✓ 发布包已存(重新导入)' : '导入发布压缩包(.zip)') + '</button>' +
            '<button data-act="en" style="padding:5px 8px;border:0;border-radius:5px;cursor:pointer;background:#2563eb;color:#fff;">' +
            (st.en ? '✓ US.lang 已存(重新上传)' : '① 上传 GregTech_US.lang') + '</button>' +
            '<button data-act="zh" style="padding:5px 8px;border:0;border-radius:5px;cursor:pointer;background:#2563eb;color:#fff;">' +
            (st.zh ? '✓ zh_CN.lang 已存(重新上传)' : '② 上传 GregTech_zh_CN.lang') + '</button>' +
            '<button data-act="close" style="padding:5px 8px;border:0;border-radius:5px;cursor:pointer;background:#374151;color:#ddd;">稍后</button>' +
            '</div>';
        bar.addEventListener('click', (ev) => {
            const btn = ev.target.closest('button');
            if (!btn) return;
            const act = btn.dataset.act;
            if (act === 'close') { bar.remove(); bannerEl = null; return; }
            promptUpload(act, () => {
                bar.remove();
                bannerEl = null;
                const s = storeStatus();
                if (s.pkg || (s.en && s.zh)) log('回填数据已就绪');
                else showUploadBanner();
            });
        });
        document.body.appendChild(bar);
    }

    // ============ 配置窗口 ============
    let configEl = null;
    function showConfigPanel() {
        if (configEl) { configEl.remove(); configEl = null; }

        const overlay = document.createElement('div');
        configEl = overlay;
        overlay.style.cssText = [
            'position:fixed', 'inset:0', 'z-index:99998',
            'background:rgba(0,0,0,.45)',
            'display:flex', 'align-items:center', 'justify-content:center',
            'font:13px/1.5 system-ui,sans-serif',
        ].join(';');

        const panel = document.createElement('div');
        panel.style.cssText = [
            'background:#1f2937', 'color:#fff', 'padding:18px 20px',
            'border-radius:10px', 'box-shadow:0 10px 40px rgba(0,0,0,.5)',
            'width:min(420px, 92vw)',
        ].join(';');
        overlay.appendChild(panel);

        const st = storeStatus();
        const metaLine = (m) => m
            ? `${m.name} · ${(m.size/1024).toFixed(1)} KB · ${new Date(m.mtime).toLocaleString()}`
            : '未上传';
        const pkgLine = (m) => m
            ? `${m.name} · ${m.files || 0} 文件 · ${m.entries || 0} 条 · ${(m.size/1024/1024).toFixed(1)} MB`
            : '未导入';

        panel.innerHTML =
            '<div style="font-size:15px;font-weight:600;margin-bottom:12px;">ParaTranz 辅助脚本 · 配置</div>' +

            '<div style="margin-bottom:10px;font-weight:600;opacity:.85;">功能开关</div>' +
            row('enableLangFill', 'A · 逐文件发布包 / 旧 .lang 回填(填入 + Ctrl+S)') +
            row('enableTmPerfect', 'B · 翻译记忆 ≥100% 匹配(复制 + Ctrl+S)') +
            row('enableTokenDiffTransfer', 'D · 顶部 TM 仅数字/电压差异时,迁移译文(仅填入,需手动确认)') +
            row('enableTmInText', 'C · "在文本中" 且原文全字相等(仅复制,不保存)') +
            row('enableAutoFillOriginal', 'E · 显示浮动面板(手动开关启用后自动填充原文 + 保存,用于颜表情)') +
            row('convertParens', '回填时 () → ()') +

            '<div style="margin:14px 0 8px;font-weight:600;opacity:.85;">逐文件发布包</div>' +
            `<div style="opacity:.8;margin-bottom:10px;">${escapeHtml(pkgLine(st.pkg))}</div>` +
            '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px;">' +
            btn('up-pkg', '导入 / 更新发布包(.zip)', '#059669') +
            btn('clear-pkg', '清除发布包', '#b45309') +
            '</div>' +

            '<div style="margin:14px 0 8px;font-weight:600;opacity:.85;">旧双 .lang 兼容</div>' +
            `<div style="opacity:.8;margin-bottom:4px;">US.lang:${escapeHtml(metaLine(st.en))}</div>` +
            `<div style="opacity:.8;margin-bottom:10px;">zh_CN.lang:${escapeHtml(metaLine(st.zh))}</div>` +
            '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px;">' +
            btn('up-en', '上传 / 更新 US.lang', '#2563eb') +
            btn('up-zh', '上传 / 更新 zh_CN.lang', '#2563eb') +
            btn('clear', '清除已保存的 .lang', '#b45309') +
            '</div>' +

            '<div style="display:flex;justify-content:flex-end;gap:8px;">' +
            btn('reset', '恢复默认', '#374151') +
            btn('close', '关闭', '#059669') +
            '</div>';

        function row(key, label) {
            const checked = config[key] ? 'checked' : '';
            return `<label style="display:flex;align-items:center;gap:8px;margin:6px 0;cursor:pointer;">` +
                `<input type="checkbox" data-cfg="${key}" ${checked}>` +
                `<span>${escapeHtml(label)}</span></label>`;
        }
        function btn(act, label, bg) {
            return `<button data-act="${act}" style="padding:6px 10px;border:0;border-radius:5px;cursor:pointer;background:${bg};color:#fff;">${escapeHtml(label)}</button>`;
        }

        panel.addEventListener('change', (ev) => {
            const cb = ev.target.closest('input[type="checkbox"][data-cfg]');
            if (!cb) return;
            config[cb.dataset.cfg] = cb.checked;
            saveConfig();
            log('配置已更新:', cb.dataset.cfg, '=', cb.checked);
            if (cb.dataset.cfg === 'enableAutoFillOriginal') {
                if (!cb.checked) autoFillArmed = false;
                renderAutoFillPanel();
            }
        });

        panel.addEventListener('click', (ev) => {
            const b = ev.target.closest('button[data-act]');
            if (!b) return;
            const act = b.dataset.act;
            if (act === 'close') {
                overlay.remove(); configEl = null;
            } else if (act === 'up-pkg') {
                promptUpload('pkg', () => { overlay.remove(); configEl = null; showConfigPanel(); });
            } else if (act === 'up-en') {
                promptUpload('en', () => { overlay.remove(); configEl = null; showConfigPanel(); });
            } else if (act === 'up-zh') {
                promptUpload('zh', () => { overlay.remove(); configEl = null; showConfigPanel(); });
            } else if (act === 'clear-pkg') {
                if (confirm('确定要清除已保存的发布包吗?')) {
                    clearPackageStore();
                    overlay.remove(); configEl = null; showConfigPanel();
                }
            } else if (act === 'clear') {
                if (confirm('确定要清除已保存的 US.lang 和 zh_CN.lang 吗?')) {
                    clearStore();
                    overlay.remove(); configEl = null; showConfigPanel();
                }
            } else if (act === 'reset') {
                if (confirm('恢复所有开关为默认?')) {
                    config = { ...DEFAULT_CONFIG };
                    saveConfig();
                    overlay.remove(); configEl = null; showConfigPanel();
                }
            }
        });

        // 点遮罩关闭
        overlay.addEventListener('click', (ev) => {
            if (ev.target === overlay) { overlay.remove(); configEl = null; }
        });

        document.body.appendChild(overlay);
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, (c) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        }[c]));
    }

    // ============ 浮动提示 (左下角 toast) ============
    const TOAST_STACK_ID = 'ptz-toast-stack';
    const TOAST_COLORS = {
        A: '#2563eb', // 蓝 - lang 回填
        B: '#059669', // 绿 - 100% TM
        C: '#0891b2', // 青 - 在文本中
        D: '#d97706', // 橙 - 数字/电压迁移
        E: '#dc2626', // 红 - 手动填充原文
    };
    function ensureToastStack() {
        let stack = document.getElementById(TOAST_STACK_ID);
        if (stack) return stack;
        stack = document.createElement('div');
        stack.id = TOAST_STACK_ID;
        stack.style.cssText = [
            'position:fixed', 'left:20px', 'bottom:20px', 'z-index:99996',
            'display:flex', 'flex-direction:column-reverse', 'gap:8px',
            'pointer-events:none',
        ].join(';');
        document.body.appendChild(stack);
        return stack;
    }
    function showToast(tag, msg, opts = {}) {
        const stack = ensureToastStack();
        const bg = opts.color || TOAST_COLORS[tag] || '#374151';
        const el = document.createElement('div');
        el.style.cssText = [
            `background:${bg}`, 'color:#fff',
            'padding:8px 12px', 'border-radius:6px',
            'box-shadow:0 4px 14px rgba(0,0,0,.35)',
            'font:12px/1.4 system-ui,sans-serif',
            'max-width:360px', 'word-break:break-all',
            'opacity:0', 'transform:translateY(6px)',
            'transition:opacity .15s, transform .15s',
        ].join(';');
        el.innerHTML =
            `<span style="font-weight:700;margin-right:6px;">[${escapeHtml(tag)}]</span>` +
            `<span>${escapeHtml(msg)}</span>`;
        stack.appendChild(el);
        requestAnimationFrame(() => {
            el.style.opacity = '1';
            el.style.transform = 'translateY(0)';
        });
        const ttl = opts.ttl || 2600;
        setTimeout(() => {
            el.style.opacity = '0';
            el.style.transform = 'translateY(6px)';
            setTimeout(() => el.remove(), 200);
        }, ttl);
    }

    // ============ 浮动面板: 自动填充原文 ============
    const FLOAT_ID = 'ptz-auto-fill-float';
    function renderAutoFillPanel() {
        document.getElementById(FLOAT_ID)?.remove();
        if (!config.enableAutoFillOriginal) return;

        const el = document.createElement('div');
        el.id = FLOAT_ID;
        el.style.cssText = [
            'position:fixed', 'bottom:20px', 'right:20px', 'z-index:99997',
            `background:${autoFillArmed ? '#dc2626' : '#1f2937'}`, 'color:#fff',
            'padding:10px 14px', 'border-radius:8px',
            'box-shadow:0 4px 14px rgba(0,0,0,.4)',
            'font:13px/1.4 system-ui,sans-serif',
            'user-select:none', 'transition:background .15s',
        ].join(';');
        el.innerHTML =
            `<label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin:0;">` +
            `<input type="checkbox" ${autoFillArmed ? 'checked' : ''} style="cursor:pointer;">` +
            `<span>自动填充原文 + 保存</span>` +
            `</label>` +
            `<div style="font-size:11px;opacity:.75;margin-top:4px;">` +
            (autoFillArmed ? '⚠ 已激活:将自动把原文当译文保存' : '关闭状态') +
            `</div>`;
        el.querySelector('input').addEventListener('change', (ev) => {
            autoFillArmed = ev.target.checked;
            log('自动填充原文开关:', autoFillArmed ? '已激活' : '已关闭');
            renderAutoFillPanel();
            if (autoFillArmed) {
                lastSig = '';
                tryProcess();
            }
        });
        document.body.appendChild(el);
    }

    // ============ 油猴菜单 ============
    try {
        GM_registerMenuCommand('打开配置窗口', showConfigPanel);
        GM_registerMenuCommand('导入发布压缩包', () => promptUpload('pkg'));
    } catch (e) {
        log('菜单注册失败:', e);
    }

    // ============ DOM 辅助 ============
    const getMainOriginal = () => {
        const el = document.querySelector('.original.well');
        return el ? el.textContent : '';
    };
    const getTextarea = () =>
        document.querySelector('.translation-area textarea.translation.form-control') ||
        document.querySelector('.translation-area textarea');
    const isTextareaEmpty = () => {
        const ta = getTextarea();
        return !!ta && ta.value.trim() === '';
    };
    function setTextareaValue(text) {
        const ta = getTextarea();
        if (!ta) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        setter.call(ta, text);
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.dispatchEvent(new Event('change', { bubbles: true }));
        ta.focus();
        return true;
    }
    function findPerfectMatchItem() {
        const tm = document.querySelector('.translation-memory');
        if (!tm) return null;
        for (const item of tm.querySelectorAll('.string-item')) {
            const header = item.querySelector('header');
            if (!header) continue;
            const m = header.textContent.replace(/\s+/g, '').match(/匹配率(\d+(?:\.\d+)?)%/);
            if (m && parseFloat(m[1]) >= 100) return item;
        }
        return null;
    }
    function findInTextItem() {
        const tm = document.querySelector('.translation-memory');
        if (!tm) return null;
        for (const item of tm.querySelectorAll('.string-item')) {
            const header = item.querySelector('header');
            if (header && header.textContent.replace(/\s+/g, '').includes('在文本中')) return item;
        }
        return null;
    }

    /** 返回"最高匹配率"的 TM 条目(不含 机器翻译/AI 参考 .mt-list,也不含"在文本中") */
    function getTopTmItem() {
        const tm = document.querySelector('.translation-memory');
        if (!tm) return null;
        for (const list of tm.querySelectorAll('.list')) {
            if (list.classList.contains('mt-list')) continue;
            const item = list.querySelector('.string-item');
            if (!item) continue;
            const header = item.querySelector('header');
            if (!header) return null;
            const mr = header.textContent.replace(/\s+/g, '').match(/匹配率(\d+(?:\.\d+)?)%/);
            if (!mr) return null; // 顶部是 "在文本中" 等,非数值匹配率
            const oriDiv = item.querySelector('.original');
            const zhDiv = item.querySelector('.translation');
            const oriEl = (oriDiv && oriDiv.querySelector('.text-pre-wrap')) || oriDiv;
            const zhEl = (zhDiv && zhDiv.querySelector('.text-pre-wrap')) || zhDiv;
            if (!oriEl || !zhEl) return null;
            return {
                item,
                ratio: parseFloat(mr[1]),
                ori: oriEl.textContent,
                zh: zhEl.textContent,
            };
        }
        return null;
    }

    /** GT 电压代码(含大小写混合:LuV、OpV、ZPM 等) */
    const VOLTAGE_CODES = new Set([
        'ULV','LV','MV','HV','EV','IV','LuV','ZPM','UV','UHV','UEV','UIV','UMV','UXV','OpV','MAX'
    ]);

    /**
     * 位置感知地抽取"简单值"(尺寸 / 时间戳 / 带单位数字 / GT 电压代码)。
     * 交替顺序即优先级:尺寸 > 时间戳 > 带单位数字 > 电压代码。
     */
    const VOLTAGE_ALT = [...VOLTAGE_CODES].sort((a,b) => b.length - a.length).join('|');
    const VALUE_RE = new RegExp(
        '(?:\\d+(?:[xX×]\\d+)+)' +
        '|(?:\\d{1,3}(?::\\d{1,2}){1,2}(?:\\.\\d+)?)' +
        '|(?:[+\\-]?\\d+(?:,\\d{3})*(?:\\.\\d+)?[a-zA-Z]{0,3})' +
        '|\\b(?:' + VOLTAGE_ALT + ')\\b',
        'g'
    );
    const SENTINEL = '\u0000';

    /**
     * 若 mainOri 与 tmOri 仅在"简单值"位置有差异(骨架完全相等),
     * 将 tmZh 中的 TM 侧值替换为 main 侧值,返回新译文;否则返回 null。
     *
     * 对每对差异值:
     *   1) 若 tm 值字面出现在 zh 中 → 字面替换(数字/单词边界,避免吃进更大 token)
     *   2) 否则若两侧值"非数字骨架"相同 → 数字级替换(适配 "2x"→"16x" 对应 zh "2倍"→"16倍")
     */
    function transferTokenDiff(mainOri, tmOri, tmZh) {
        const mainVals = mainOri.match(VALUE_RE) || [];
        const tmVals   = tmOri.match(VALUE_RE)   || [];
        const mainSkel = mainOri.replace(VALUE_RE, SENTINEL);
        const tmSkel   = tmOri.replace(VALUE_RE, SENTINEL);

        if (mainSkel !== tmSkel) return null;
        if (mainVals.length !== tmVals.length) return null;

        const pairs = [];
        for (let i = 0; i < mainVals.length; i++) {
            if (mainVals[i] !== tmVals[i]) pairs.push([tmVals[i], mainVals[i]]);
        }
        if (!pairs.length) return null;

        // 同一 from 只允许映射到唯一 to
        const uniq = new Map();
        for (const [f, t] of pairs) {
            if (uniq.has(f) && uniq.get(f) !== t) return null;
            uniq.set(f, t);
        }

        const ops = [];
        for (const [from, to] of uniq) {
            if (tmZh.includes(from)) {
                ops.push({ kind: 'lit', from, to });
                continue;
            }
            // 数字骨架 fallback
            const fd = from.match(/\d+(?:,\d{3})*/g);
            const td = to.match(/\d+(?:,\d{3})*/g);
            if (!fd || !td || fd.length !== td.length) return null;
            const fSkel = from.replace(/\d+(?:,\d{3})*/g, SENTINEL);
            const tSkel = to.replace(/\d+(?:,\d{3})*/g, SENTINEL);
            if (fSkel !== tSkel) return null;
            for (let i = 0; i < fd.length; i++) {
                if (fd[i] !== td[i]) ops.push({ kind: 'num', from: fd[i], to: td[i] });
            }
        }
        if (!ops.length) return null;

        // 去重 + 冲突检测
        const opMap = new Map();
        for (const o of ops) {
            const prev = opMap.get(o.from);
            if (prev && prev.to !== o.to) return null;
            if (!prev) opMap.set(o.from, o);
        }
        const sorted = [...opMap.values()].sort((a, b) => b.from.length - a.from.length);

        const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const alts = sorted.map((o) => {
            if (o.kind === 'num') return `(?<!\\d)${esc(o.from)}(?!\\d)`;
            if (/^[a-zA-Z]+$/.test(o.from)) return `\\b${esc(o.from)}\\b`;
            const pre  = /\d/.test(o.from[0])                ? '(?<!\\d)' : '';
            const post = /\d/.test(o.from[o.from.length - 1]) ? '(?!\\d)'  : '';
            return `${pre}${esc(o.from)}${post}`;
        });
        const re = new RegExp(alts.join('|'), 'g');
        const toMap = new Map(sorted.map(o => [o.from, o.to]));

        let changed = false;
        const result = tmZh.replace(re, (m) => {
            if (toMap.has(m)) { changed = true; return toMap.get(m); }
            return m;
        });
        return changed ? result : null;
    }
    function pressCtrlS() {
        const target = getTextarea() || document;
        const init = {
            key: 's', code: 'KeyS', keyCode: 83, which: 83,
            ctrlKey: true, bubbles: true, cancelable: true, composed: true,
        };
        ['keydown', 'keypress', 'keyup'].forEach((t) => {
            try { target.dispatchEvent(new KeyboardEvent(t, init)); } catch (_) {}
        });
        log('已模拟 Ctrl+S');
    }

    // ============ 主流程 ============
    let lastSig = '';
    let busy = false;

    /** 审核留言模式:URL 带 ref=message 时禁用所有自动行为 */
    function isReviewMode() {
        return /[?&]ref=message\b/.test(location.href);
    }

    /** 当前词条是否为"未翻译"状态(左侧列表 .row.string.active 的 data-stage="0") */
    function isUntranslatedEntry() {
        const active = document.querySelector('.row.string.active');
        if (!active) return false;
        const stageEl = active.querySelector('.stage-icon');
        return stageEl?.getAttribute('data-stage') === '0';
    }

    async function tryProcess() {
        if (busy) return;
        if (isReviewMode()) {
            if (lastSig !== '__review__') {
                log('检测到 ref=message(审核留言模式),已禁用所有自动操作');
                lastSig = '__review__';
            }
            return;
        }
        if (!isUntranslatedEntry()) {
            return;
        }
        const mainOri = getMainOriginal();
        if (!mainOri) return;
        const sig = mainOri;
        if (sig === lastSig) return;

        const ta = getTextarea();
        if (!ta) return;

        busy = true;
        try {
            // E. 手动开关已激活:直接点击"填充原文"+保存(颜表情等原文即译文)
            if (config.enableAutoFillOriginal && autoFillArmed && isTextareaEmpty()) {
                const fillBtn = document.querySelector('button[title="填充原文"]');
                if (fillBtn) {
                    lastSig = sig;
                    log('手动开关已激活 → 填充原文 + 保存');
                    showToast('E', '填充原文 + 保存');
                    fillBtn.click();
                    await delay(FILL_TO_SAVE_DELAY);
                    pressCtrlS();
                    return;
                }
            }

            // A. 逐文件发布包 / 旧 .lang 回填
            if (config.enableLangFill && packageIndex) {
                const hit = findPackageTranslation(mainOri);
                if (hit && hit.translation && hit.translation.trim() !== '') {
                    const zhFinal = transformForFill(hit.translation);
                    lastSig = sig;
                    if (ta.value.trim() === zhFinal.trim()) {
                        log('发布包命中且内容已一致,仅保存:', hit.source, hit.key);
                        showToast('A', `发布包内容已一致,仅保存 · ${hit.key}`);
                        pressCtrlS();
                        return;
                    }
                    log('发布包命中:', hit.source, hit.key, '→', zhFinal);
                    showToast('A', `发布包回填 · ${hit.key}`);
                    setTextareaValue(zhFinal);
                    await delay(FILL_TO_SAVE_DELAY);
                    pressCtrlS();
                    return;
                }
            }

            if (config.enableLangFill && enToKey && zhByKey) {
                const key = enToKey.get(mainOri) || enToKey.get(mainOri.trim());
                if (key) {
                    const zh = zhByKey.get(key);
                    if (zh && zh.trim() !== '') {
                        const zhFinal = transformForFill(zh);
                        lastSig = sig;
                        if (ta.value.trim() === zhFinal.trim()) {
                            log('旧 lang 命中且内容已一致,仅保存:', key);
                            showToast('A', `内容已一致,仅保存 · ${key}`);
                            pressCtrlS();
                            return;
                        }
                        log('旧 lang 命中:', key, '→', zhFinal);
                        showToast('A', `lang 回填 · ${key}`);
                        setTextareaValue(zhFinal);
                        await delay(FILL_TO_SAVE_DELAY);
                        pressCtrlS();
                        return;
                    }
                }
            }

            // B. 翻译记忆 ≥100% 匹配
            if (config.enableTmPerfect) {
                const perfect = findPerfectMatchItem();
                if (perfect) {
                    const copyBtn = perfect.querySelector('button[title="复制当前文本至翻译框"]');
                    if (copyBtn) {
                        lastSig = sig;
                        log('≥100% 匹配命中,复制 + 保存');
                        showToast('B', '翻译记忆 ≥100% → 复制并保存');
                        copyBtn.click();
                        await delay(COPY_TO_SAVE_DELAY);
                        normalizeTextareaValue();
                        pressCtrlS();
                        return;
                    }
                }
            }

            // D. 顶部 TM 匹配 <100%,原文差异仅限数字/电压代码 → 迁移译文
            if (config.enableTokenDiffTransfer && isTextareaEmpty()) {
                const top = getTopTmItem();
                if (top && top.ratio > 0 && top.ratio < 100) {
                    const transferred = transferTokenDiff(mainOri, top.ori, top.zh);
                    if (transferred) {
                        const zhFinal = transformForFill(transferred);
                        lastSig = sig;
                        log(`顶部匹配 ${top.ratio}% 仅数字/电压差异,仅填入不保存:`, zhFinal);
                        showToast('D', `${top.ratio}% 数字/电压差异 → 仅填入`);
                        setTextareaValue(zhFinal);
                        return;
                    }
                }
            }

            // C. "在文本中" + 翻译框为空 + 原文全字相等 → 仅复制
            if (config.enableTmInText && isTextareaEmpty()) {
                const item = findInTextItem();
                if (item) {
                    const tmOriEl = item.querySelector('.original .text-pre-wrap, .original');
                    const tmOri = tmOriEl ? tmOriEl.textContent.trim() : '';
                    if (tmOri && tmOri === mainOri.trim()) {
                        const btn = item.querySelector('button[title="复制当前文本至翻译框"]');
                        if (btn) {
                            lastSig = sig;
                            log('命中"在文本中"且原文全字相等,仅复制不保存');
                            showToast('C', '"在文本中" 全字相等 → 仅复制');
                            btn.click();
                            await delay(COPY_TO_SAVE_DELAY);
                            normalizeTextareaValue();
                            return;
                        }
                    } else {
                        log('跳过"在文本中":原文非全字相等 (TM=', tmOri, '当前=', mainOri.trim(), ')');
                    }
                }
            }
        } finally {
            busy = false;
        }
    }

    // ============ 启动 ============
    const obs = new MutationObserver(() => {
        if (obs._pending) return;
        obs._pending = true;
        requestAnimationFrame(() => {
            obs._pending = false;
            tryProcess();
            if (config.enableAutoFillOriginal && !document.getElementById(FLOAT_ID)) {
                renderAutoFillPanel();
            }
        });
    });

    function start() {
        obs.observe(document.documentElement, { childList: true, subtree: true });
        const ok = loadFromStore();
        if (!ok) {
            log('未检测到已上传的 .lang 文件,显示上传引导');
            setTimeout(showUploadBanner, 600);
        }
        renderAutoFillPanel();
        setTimeout(tryProcess, 1200);
        log('脚本已启动,配置:', config);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }
})();
