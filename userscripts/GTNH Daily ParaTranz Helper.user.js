// ==UserScript==
// @name         GTNH Daily ParaTranz Helper
// @namespace    paratranz-auto-100
// @version      5.10
// @description  1) 悬浮总控所有功能开关; 2) 单文件原文/译文分开选择并导入回填; 3) 纯 lang 发布包导入回填; 4) TM 自动复制与数字/电压迁移
// @match        https://paratranz.cn/*
// @run-at       document-idle
// @require      https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js
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
    const STORE_PKG_INDEX = 'lang_pkg_index_v2';
    const STORE_PKG_META = 'lang_pkg_meta_v2';
    const STORE_PKG_FILE_PREFIX = 'lang_pkg_file_v2:';
    const STORE_SINGLE_INDEX = 'single_lang_index_v1';
    const STORE_SINGLE_FILE_PREFIX = 'single_lang_file_v1:';
    const STORE_CONFIG = 'config_v1';
    const STORE_FLOAT_COLLAPSED = 'float_panel_collapsed_v1';

    const DEFAULT_CONFIG = {
        enableSingleFileFill: true,   // F 当前单文件原文/译文回填
        enableLangFill: true,         // A 逐文件发布包回填
        enableTmPerfect: true,        // B 翻译记忆 ≥100% 匹配
        enableTokenDiffTransfer: true,// D 顶部 TM 原文仅数字/电压差异时自动迁移
        enableTmInText: true,         // C "在文本中" 全字相等仅复制
        convertParens: true,          // 回填时 () → ()
        enableAutoFillOriginal: false,// E 显示"自动填充原文"浮动面板(用于颜表情等原文即译文的情况)
        singleFileOverwriteConflicts: false, // 单文件导入时,新文件词条覆盖旧冲突
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

    // ============ 发布包解析 ============
    let packageIndex = null;
    const packageFileCache = new Map();

    function normalizePtPath(path) {
        let out = String(path || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
        try { out = decodeURIComponent(out); } catch (_) {}
        if (out.startsWith('files/')) out = out.slice('files/'.length);
        // 浏览器下载重名文件时可能变成 xxx(2).lang, 导入时先消掉这个副本后缀。
        out = out.replace(/\(\d+\)(?=\.[^/.]+$)/, '');
        if (out.endsWith('.json')) out = out.slice(0, -'.json'.length);
        if (/^GregTech(?:_zh_CN|_US|_en_US)?\.lang$/i.test(out)) out = 'GregTech.lang';
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

    function langNeutralPath(path) {
        let p = normalizePtPath(path);
        if (!p) return '';
        // 根目录下的 GregTech_US.lang / GregTech_zh_CN.lang 已在 normalizePtPath 里统一为 GregTech.lang。
        // 这里再处理普通 Forge lang 路径：resources/mod/lang/en_US.lang 与 zh_CN.lang 归到同一个中性别名。
        p = p.replace(/(^|\/)(?:en_us|en_us|zh_cn|zh_tw|zh_hans_cn|zh_hant_tw|zh_hans|zh_hant)\.lang$/i, '$1locale.lang');
        p = p.replace(/(?:[_\.-]?(?:en_us|zh_cn|zh_tw|zh_hans_cn|zh_hant_tw|us|cn))(?=\.lang$)/i, '');
        p = p.replace(/(?:[_\.-]?(?:en_us|zh_cn|zh_tw|zh_hans_cn|zh_hant_tw|us|cn))(?=\.json$)/i, '');
        return p;
    }

    function aliasesForPath(path) {
        const p = normalizePtPath(path);
        const aliases = new Set();
        if (p) {
            aliases.add(p.toLowerCase());
            aliases.add(`${p}.json`.toLowerCase());
            aliases.add(p.replace(/zh_CN\.lang$/i, 'en_US.lang').toLowerCase());
            aliases.add(p.replace(/en_US\.lang$/i, 'zh_CN.lang').toLowerCase());
            const neutral = langNeutralPath(p);
            if (neutral) {
                aliases.add(neutral.toLowerCase());
                aliases.add(`${neutral}.json`.toLowerCase());
            }
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

    function zipText(zipFiles, name) {
        const bytes = zipFiles[name];
        if (!bytes) return '';
        return fflate.strFromU8 ? fflate.strFromU8(bytes) : new TextDecoder('utf-8').decode(bytes);
    }

    function normalizeZipName(name) {
        return String(name || '').replace(/\\/g, '/').replace(/^\/+/, '');
    }

    function findZipName(zipFiles, candidates) {
        const names = Object.keys(zipFiles || {});
        const normalized = names.map(n => [n, normalizeZipName(n).toLowerCase()]);
        for (const raw of candidates || []) {
            if (!raw) continue;
            const want = normalizeZipName(raw).toLowerCase();
            const exact = normalized.find(([, n]) => n === want);
            if (exact) return exact[0];
            const suffix = normalized.find(([, n]) => n.endsWith('/' + want));
            if (suffix) return suffix[0];
        }
        return '';
    }

    function entriesFromOriginalTranslationMaps(originalMap, translationMap) {
        const entries = [];
        for (const [key, original] of originalMap || []) {
            if (!translationMap || !translationMap.has(key)) continue;
            const translation = translationMap.get(key);
            if (!String(original || '').trim() || !String(translation || '').trim()) continue;
            entries.push({ key: String(key), original: String(original), translation: String(translation), stage: 0 });
        }
        return entries;
    }

    function guessLocalizedKind(name) {
        const base = normalizeZipName(name).split('/').pop().toLowerCase();
        if (/(zh[_-]?cn|zh[_-]?hans|zh|cn|translation|translated|target|dst)/i.test(base)) return 'translation';
        if (/(en[_-]?us|en|us|original|source|src)/i.test(base)) return 'original';
        return 'unknown';
    }

    function looseZipGroupKey(name) {
        const p = langNeutralPath(name) || normalizePtPath(name);
        return p.toLowerCase();
    }

    function isPackageLangZipName(name) {
        const n = normalizeZipName(name);
        if (/\/$/.test(n)) return false;
        // 发布包里可能仍然带 pt-lang-package.json；这里故意完全忽略它。
        return /\.lang$/i.test(n);
    }

    function pickBestPackageLangPair(list) {
        const originals = list.filter(n => guessLocalizedKind(n) === 'original');
        const translations = list.filter(n => guessLocalizedKind(n) === 'translation');
        const score = (name, kind) => {
            const base = normalizeZipName(name).split('/').pop().toLowerCase();
            let s = 0;
            if (kind === 'original') {
                if (/en[_-]?us\.lang$/i.test(base)) s += 100;
                if (/us\.lang$/i.test(base)) s += 60;
                if (/en\.lang$/i.test(base)) s += 40;
            } else {
                if (/zh[_-]?cn\.lang$/i.test(base)) s += 100;
                if (/cn\.lang$/i.test(base)) s += 60;
                if (/zh\.lang$/i.test(base)) s += 40;
            }
            // 越短越像主文件，避免同组里意外文件抢位。
            s -= normalizeZipName(name).length / 10000;
            return s;
        };
        originals.sort((a, b) => score(b, 'original') - score(a, 'original'));
        translations.sort((a, b) => score(b, 'translation') - score(a, 'translation'));
        const oriName = originals[0] || '';
        const zhName = translations[0] || '';
        if (!oriName || !zhName || oriName === zhName) return null;
        return { oriName, zhName };
    }

    function buildPackageFilesFromLangZip(zipFiles) {
        const names = Object.keys(zipFiles || {}).filter(isPackageLangZipName);
        const groups = new Map();
        for (const name of names) {
            const key = looseZipGroupKey(name);
            if (!key) continue;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(name);
        }

        const files = [];
        let pairIndex = 0;
        for (const [groupKey, list] of groups) {
            const pair = pickBestPackageLangPair(list);
            if (!pair) continue;

            const originalMap = parseLangText(zipText(zipFiles, pair.oriName));
            const translationMap = parseLangText(zipText(zipFiles, pair.zhName));
            const entries = entriesFromOriginalTranslationMaps(originalMap, translationMap);
            if (!entries.length) continue;

            const ptPath = normalizePtPath(pair.zhName || pair.oriName || groupKey || `lang-pair-${pairIndex}.lang`);
            const aliases = new Set([
                ...aliasesForPath(ptPath),
                ...aliasesForPath(pair.oriName),
                ...aliasesForPath(pair.zhName),
                String(groupKey).toLowerCase(),
            ]);
            files.push({
                ptPath,
                aliases: [...aliases].map(a => String(a).toLowerCase()).filter(Boolean),
                entries,
                packEnPath: pair.oriName,
                packZhPath: pair.zhName,
            });
            pairIndex++;
        }
        return files;
    }

    function diagnoseCurrentPackageHit() {
        const original = getMainOriginal();
        const idxOk = packageIndex || loadPackageIndex();
        if (!idxOk) {
            alert('发布包未加载。');
            return;
        }
        const aliases = aliasesForPath(currentPtPath());
        const ids = new Set();
        for (const alias of aliases) {
            const hit = packageIndex.byAlias[alias.toLowerCase()];
            if (Array.isArray(hit)) hit.forEach(id => ids.add(id));
        }
        let lines = [];
        lines.push(`当前路径: ${currentPtPath() || '(空)'}`);
        lines.push(`当前原文: ${original ? original.slice(0, 180) : '(未识别)'}`);
        lines.push(`路径别名: ${aliases.join(' | ') || '(无)'}`);
        lines.push(`发布包模式: ${packageIndex.sourceMode || '(旧索引)'}`);
        lines.push(`候选文件数: ${ids.size}`);
        const hit = original ? findPackageTranslation(original) : null;
        lines.push(hit ? `命中: ${hit.source} / ${hit.key}` : '命中: 无');
        for (const id of [...ids].slice(0, 6)) {
            const meta = (packageIndex.files || []).find(f => f.id === id);
            const file = loadPackageFile(id);
            lines.push(`候选: ${meta?.ptPath || id} · ${file?.entries?.length || 0} 条`);
        }
        alert(lines.join('\n'));
    }

    async function importPackageZip(file) {
        if (typeof fflate === 'undefined' || !fflate.unzipSync)
            throw new Error('fflate 未加载,无法解析 zip');
        showImportProgress(`读取 ${file.name}...`);
        await delay(0);
        const bytes = new Uint8Array(await file.arrayBuffer());
        showImportProgress('解压发布包...');
        await delay(0);
        const zipFiles = fflate.unzipSync(bytes);

        // 5.10 起：发布包导入只读取压缩包里的 lang 文件对。
        // pt-lang-package.json 即使存在也会被忽略；新的导出包根目录应直接是 .lang 文件结构。
        showImportProgress('扫描纯 lang 原文/译文文件对...');
        await delay(0);
        const files = buildPackageFilesFromLangZip(zipFiles);

        if (files.length === 0) {
            throw new Error('压缩包内没有识别到可配对的原文/译文 .lang 文件。需要类似 resources/.../lang/en_US.lang + resources/.../lang/zh_CN.lang，或 GregTech_US.lang + GregTech_zh_CN.lang。');
        }

        showImportProgress('清理旧发布包...');
        await delay(0);
        clearPackageStore();
        const byAlias = {};
        const summaries = [];
        let entryCount = 0;
        for (let i = 0; i < files.length; i++) {
            const f = files[i];
            const id = packageStorageId(i, f);
            const entries = (f.entries || []).filter(e => e.original && e.translation && String(e.translation).trim());
            entryCount += entries.length;
            GM_setValue(STORE_PKG_FILE_PREFIX + id, { ptPath: f.ptPath, entries });
            for (const alias of f.aliases || aliasesForPath(f.ptPath)) {
                const key = String(alias).toLowerCase();
                (byAlias[key] ||= []).push(id);
            }
            summaries.push({
                id,
                ptPath: f.ptPath,
                aliases: f.aliases || aliasesForPath(f.ptPath),
                entryCount: entries.length,
                packEnPath: f.packEnPath || '',
                packZhPath: f.packZhPath || '',
            });
            if (i === 0 || i + 1 === files.length || (i + 1) % 25 === 0) {
                showImportProgress(`写入油猴存储 ${i + 1}/${files.length} 文件...`);
                await delay(0);
            }
        }
        if (entryCount === 0) {
            clearPackageStore();
            throw new Error('压缩包内 lang 文件已配对,但 0 条可回填译文。通常是原文/译文 key 不一致，或 lang 文件格式没有被正确解析。');
        }
        const idx = {
            version: 4,
            importedAt: Date.now(),
            packageName: file.name,
            createdAt: '',
            projectId: '',
            sourceMode: 'pure-lang-pairs',
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
            sourceMode: 'pure-lang-pairs',
            createdAt: '',
        });
        packageIndex = idx;
        packageFileCache.clear();
        log(`已从纯 lang 文件对导入发布包:${file.name} (${summaries.length} 文件, ${entryCount} 条可回填译文)`);
        showImportProgress(`导入完成:${summaries.length} 对 lang / ${entryCount} 条译文`);
        return idx;
    }


    // ============ 单文件原文/译文成对导入 ============
    let singleFileIndex = null;
    const singleFileCache = new Map();

    function hashString(s) {
        let h = 2166136261;
        for (const ch of String(s || '')) {
            h ^= ch.charCodeAt(0);
            h = Math.imul(h, 16777619);
        }
        return (h >>> 0).toString(36);
    }

    function singleFileStorageId(path) {
        return `s_${hashString(normalizePtPath(path) || 'unknown')}`;
    }

    function loadSingleFileIndex() {
        singleFileIndex = GM_getValue(STORE_SINGLE_INDEX, null);
        return !!(singleFileIndex && singleFileIndex.byAlias);
    }

    function rebuildSingleFileAliasIndex(files) {
        const byAlias = {};
        for (const f of files || []) {
            for (const alias of f.aliases || []) {
                const key = String(alias).toLowerCase();
                (byAlias[key] ||= []).push(f.id);
            }
        }
        return byAlias;
    }

    function saveSingleFileIndexFiles(files) {
        if (!files || files.length === 0) {
            GM_deleteValue(STORE_SINGLE_INDEX);
            singleFileIndex = null;
            singleFileCache.clear();
            return null;
        }
        singleFileIndex = { version: 1, files, byAlias: rebuildSingleFileAliasIndex(files) };
        GM_setValue(STORE_SINGLE_INDEX, singleFileIndex);
        singleFileCache.clear();
        return singleFileIndex;
    }

    function clearSingleFileStore() {
        const idx = GM_getValue(STORE_SINGLE_INDEX, null);
        if (idx && Array.isArray(idx.files)) {
            for (const f of idx.files)
                GM_deleteValue(STORE_SINGLE_FILE_PREFIX + f.id);
        }
        GM_deleteValue(STORE_SINGLE_INDEX);
        singleFileIndex = null;
        singleFileCache.clear();
    }

    function clearCurrentSingleFileStore() {
        if (!singleFileIndex && !loadSingleFileIndex()) return false;
        const idx = GM_getValue(STORE_SINGLE_INDEX, null);
        if (!idx || !Array.isArray(idx.files)) return false;
        const meta = currentSingleFileMeta();
        const targetId = meta?.id || singleFileStorageId(currentPtPath());
        if (!targetId) return false;
        const before = idx.files.length;
        const files = idx.files.filter(f => f.id !== targetId);
        if (files.length === before) return false;
        GM_deleteValue(STORE_SINGLE_FILE_PREFIX + targetId);
        saveSingleFileIndexFiles(files);
        return true;
    }

    function loadSingleFile(id) {
        if (singleFileCache.has(id)) return singleFileCache.get(id);
        const data = GM_getValue(STORE_SINGLE_FILE_PREFIX + id, null);
        if (!data) return null;
        const loaded = { ...data, ...buildOriginalMap(data.entries) };
        singleFileCache.set(id, loaded);
        return loaded;
    }

    function findSingleFileTranslation(original) {
        if (!singleFileIndex && !loadSingleFileIndex()) return null;
        const aliases = aliasesForPath(currentPtPath());
        const ids = new Set();
        for (const alias of aliases) {
            const hit = singleFileIndex.byAlias[alias.toLowerCase()];
            if (Array.isArray(hit)) hit.forEach(id => ids.add(id));
        }
        if (ids.size === 0) return null;
        for (const id of ids) {
            const file = loadSingleFile(id);
            if (!file) continue;
            const hit = file.byOriginal.get(original) || file.byOriginalTrim.get(String(original).trim());
            if (hit) return { ...hit, source: file.ptPath };
        }
        return null;
    }

    function currentSingleFileMeta() {
        if (!singleFileIndex && !loadSingleFileIndex()) return null;
        const aliases = aliasesForPath(currentPtPath());
        for (const alias of aliases) {
            const ids = singleFileIndex.byAlias[alias.toLowerCase()];
            if (Array.isArray(ids) && ids.length) {
                const id = ids[0];
                return (singleFileIndex.files || []).find(f => f.id === id) || null;
            }
        }
        return null;
    }

    function unescapeLangValue(s) {
        return String(s || '')
            .replace(/\\n/g, '\n')
            .replace(/\\r/g, '\r')
            .replace(/\\t/g, '\t')
            .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
            .replace(/\\([:=#! ])/g, '$1')
            .replace(/\\\\/g, '\\');
    }

    function unescapeLangQuotedKey(s) {
        return unescapeLangValue(String(s || '').replace(/\\"/g, '"'));
    }

    function findUnescapedChar(text, target) {
        let escaped = false;
        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            if (!escaped && ch === target) return i;
            if (ch === '\\') escaped = !escaped;
            else escaped = false;
        }
        return -1;
    }

    function parseLangText(text) {
        const map = new Map();
        const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
        for (let line of lines) {
            if (!line) continue;
            line = line.replace(/\r$/, '');
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!') || trimmed.startsWith('//')) continue;

            // GT/GregTech/Forge config-style lang 常见格式:
            //   S:"some.key"=value
            // 旧版解析器把 S 后面的冒号误判为 key/value 分隔符,导致全文件只剩一个 key: S。
            const typed = line.match(/^\s*[A-Za-z]\s*:\s*"((?:\\.|[^"\\])*)"\s*=([\s\S]*)$/);
            if (typed) {
                const key = unescapeLangQuotedKey(typed[1]);
                const value = unescapeLangValue(typed[2]);
                if (key) map.set(key, value);
                continue;
            }

            // 普通 .lang/.properties: 优先用 =。只有没有 = 时才把 : 当分隔符。
            // 这样 key 里含冒号,比如 Book.How to: Modular Baubles.Name, 不会被误切。
            let sep = findUnescapedChar(line, '=');
            if (sep < 0) sep = findUnescapedChar(line, ':');
            if (sep < 0) continue;
            const key = unescapeLangValue(line.slice(0, sep).trim());
            const value = unescapeLangValue(line.slice(sep + 1));
            if (key) map.set(key, value);
        }
        return map;
    }

    function parseJsonText(text, prefer) {
        const map = new Map();
        const data = JSON.parse(text);
        const pick = (obj) => {
            if (!obj || typeof obj !== 'object') return '';
            if (prefer === 'original') return obj.original ?? obj.value ?? obj.text ?? obj.translation ?? '';
            return obj.translation ?? obj.value ?? obj.text ?? obj.original ?? '';
        };
        if (Array.isArray(data)) {
            for (const item of data) {
                if (!item || typeof item !== 'object') continue;
                const key = String(item.key ?? item.name ?? item.id ?? '');
                const value = String(pick(item));
                if (key) map.set(key, value);
            }
        } else if (data && typeof data === 'object') {
            const arr = Array.isArray(data.entries) ? data.entries
                : Array.isArray(data.strings) ? data.strings
                : Array.isArray(data.data) ? data.data
                : null;
            if (arr) {
                for (const item of arr) {
                    if (!item || typeof item !== 'object') continue;
                    const key = String(item.key ?? item.name ?? item.id ?? '');
                    const value = String(pick(item));
                    if (key) map.set(key, value);
                }
            } else {
                for (const [key, value] of Object.entries(data)) {
                    if (value == null) continue;
                    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
                        map.set(String(key), String(value));
                    } else if (typeof value === 'object') {
                        map.set(String(key), String(pick(value)));
                    }
                }
            }
        }
        return map;
    }

    async function parseLocalizedFile(file, prefer) {
        const text = await file.text();
        const trimmed = text.trim();
        if (/\.json$/i.test(file.name) || trimmed.startsWith('{') || trimmed.startsWith('[')) {
            try { return parseJsonText(text, prefer); }
            catch (err) { log('JSON 解析失败,按 lang/properties 尝试:', file.name, err); }
        }
        return parseLangText(text);
    }

    function mergeSingleEntries(oldEntries, newEntries, overwriteConflicts) {
        const list = [];
        const byOriginal = new Map();
        const byKey = new Map();
        const valid = (e) => !!(e && e.original && String(e.translation || '').trim());
        const removeAt = (idx) => {
            if (idx < 0 || idx >= list.length) return;
            const old = list[idx];
            if (old) {
                byOriginal.delete(String(old.original));
                if (old.key) byKey.delete(String(old.key));
            }
            list.splice(idx, 1);
            for (let i = idx; i < list.length; i++) {
                byOriginal.set(String(list[i].original), i);
                if (list[i].key) byKey.set(String(list[i].key), i);
            }
        };
        const add = (e) => {
            const idx = list.length;
            list.push(e);
            byOriginal.set(String(e.original), idx);
            if (e.key) byKey.set(String(e.key), idx);
        };
        for (const e of oldEntries || []) {
            if (!valid(e)) continue;
            add(e);
        }
        for (const e of newEntries || []) {
            if (!valid(e)) continue;
            const keyHit = e.key ? byKey.get(String(e.key)) : undefined;
            const originalHit = byOriginal.get(String(e.original));
            const hasConflict = keyHit !== undefined || originalHit !== undefined;
            if (hasConflict && !overwriteConflicts) continue;
            if (overwriteConflicts) {
                const toRemove = [...new Set([keyHit, originalHit].filter(i => i !== undefined))]
                    .sort((a, b) => b - a);
                for (const idx of toRemove) removeAt(idx);
            }
            add(e);
        }
        return list;
    }

    async function importSingleFilePair(originalFile, translationFile, overwriteConflicts) {
        const ptPath = normalizePtPath(currentPtPath() || translationFile.name || originalFile.name);
        if (!ptPath) throw new Error('无法识别当前 ParaTranz 文件路径,请先进入具体文件页面再导入');
        showImportProgress(`读取单文件原文/译文...`);
        await delay(0);
        const [originalMap, translationMap] = await Promise.all([
            parseLocalizedFile(originalFile, 'original'),
            parseLocalizedFile(translationFile, 'translation'),
        ]);
        const entries = [];
        for (const [key, original] of originalMap) {
            if (!translationMap.has(key)) continue;
            const translation = translationMap.get(key);
            if (!String(original || '').trim() || !String(translation || '').trim()) continue;
            entries.push({ key, original: String(original), translation: String(translation), stage: 0 });
        }
        if (!entries.length) {
            throw new Error('没有找到可导入的词条。请确认两个文件 key 一致,且译文非空');
        }

        const id = singleFileStorageId(ptPath);
        const old = GM_getValue(STORE_SINGLE_FILE_PREFIX + id, null);
        let oldEntries = old?.entries || [];
        // 兼容 5.5 的 GT 解析 bug: S:"key"=value 曾被误解析成唯一 key "S"。
        // 重新导入时自动丢掉这类残留,避免旧的 1 条脏数据混进新词库。
        if (oldEntries.length <= 3 && oldEntries.some(e => e && e.key === 'S')) {
            oldEntries = [];
        }
        const mergedEntries = mergeSingleEntries(oldEntries, entries, overwriteConflicts);
        const aliases = aliasesForPath(ptPath).map(a => String(a).toLowerCase());
        const stored = { ptPath, entries: mergedEntries };
        GM_setValue(STORE_SINGLE_FILE_PREFIX + id, stored);

        const oldIdx = GM_getValue(STORE_SINGLE_INDEX, null);
        const oldFiles = (oldIdx && Array.isArray(oldIdx.files)) ? oldIdx.files.filter(f => f.id !== id) : [];
        const fileMeta = {
            id,
            ptPath,
            aliases,
            entryCount: mergedEntries.length,
            addedEntries: entries.length,
            originalName: originalFile.name,
            translationName: translationFile.name,
            importedAt: Date.now(),
            overwriteConflicts: !!overwriteConflicts,
        };
        const files = [...oldFiles, fileMeta];
        saveSingleFileIndexFiles(files);
        showImportProgress(`单文件导入完成:${entries.length} 条新词条 / 当前 ${mergedEntries.length} 条`);
        showToast('F', `单文件导入完成 · ${mergedEntries.length} 条`);
        log('单文件原文/译文导入完成:', fileMeta);
        return fileMeta;
    }

    function loadFromStore() {
        const pkgOk = loadPackageIndex();
        const singleOk = loadSingleFileIndex();
        return pkgOk || singleOk;
    }

    function purgeLegacyLangStore() {
        [
            'lang_en_raw_v1',
            'lang_zh_raw_v1',
            'lang_en_meta_v1',
            'lang_zh_meta_v1',
        ].forEach(GM_deleteValue);
    }

    const storeStatus = () => ({
        pkg: GM_getValue(STORE_PKG_META, null),
        single: currentSingleFileMeta(),
    });

    // ============ 上传 ============
    let importProgressEl = null;
    function showImportProgress(message) {
        if (!importProgressEl) {
            importProgressEl = document.createElement('div');
            importProgressEl.style.cssText = [
                'position:fixed', 'top:10px', 'right:10px', 'z-index:100000',
                'background:#111827', 'color:#fff', 'padding:12px 14px',
                'border-radius:8px', 'box-shadow:0 4px 16px rgba(0,0,0,.35)',
                'font:13px/1.5 system-ui,sans-serif', 'max-width:360px',
            ].join(';');
            document.body.appendChild(importProgressEl);
        }
        importProgressEl.textContent = message;
    }

    function hideImportProgress(ms = 1800) {
        const el = importProgressEl;
        if (!el) return;
        setTimeout(() => {
            if (importProgressEl === el) importProgressEl = null;
            el.remove();
        }, ms);
    }

    function promptUpload(onDone) {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.zip,application/zip';
        input.style.display = 'none';
        input.addEventListener('change', async () => {
            const file = input.files && input.files[0];
            input.remove();
            if (!file) return;
            try {
                if (!/\.zip$/i.test(file.name))
                    throw new Error('请导入 GitHub Release 发布的 .zip 包');
                const idx = await importPackageZip(file);
                loadFromStore();
                showToast('A', `发布包导入完成 · ${idx.files.length} 对 lang / ${idx.files.reduce((n, f) => n + (f.entryCount || 0), 0)} 条`);
                hideImportProgress();
                renderControlPanel();
                lastSig = '';
                tryProcess();
                if (onDone) onDone(file);
            } catch (err) {
                const msg = err && err.message ? err.message : String(err);
                showImportProgress(`导入失败:${msg}`);
                alert('导入发布包失败:' + msg);
                hideImportProgress(5000);
            }
        });
        document.body.appendChild(input);
        input.click();
    }


    let pendingSingleOriginalFile = null;
    let pendingSingleTranslationFile = null;

    function singlePendingLine() {
        const ori = pendingSingleOriginalFile ? pendingSingleOriginalFile.name : '未选择原文';
        const zh = pendingSingleTranslationFile ? pendingSingleTranslationFile.name : '未选择译文';
        return `待导入: 原文 ${ori} / 译文 ${zh}`;
    }

    function selectSingleLocalizedFile(kind) {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.lang,.properties,.txt,.json,application/json,text/plain';
        input.style.display = 'none';
        input.addEventListener('change', () => {
            const file = input.files && input.files[0];
            input.remove();
            if (!file) return;
            if (kind === 'original') {
                pendingSingleOriginalFile = file;
                showToast('F', `已选择原文 · ${file.name}`, { ttl: 2800 });
            } else {
                pendingSingleTranslationFile = file;
                showToast('F', `已选择译文 · ${file.name}`, { ttl: 2800 });
            }
            renderControlPanel();
        });
        document.body.appendChild(input);
        input.click();
    }

    async function importPendingSingleFiles(onDone) {
        if (!pendingSingleOriginalFile || !pendingSingleTranslationFile) {
            alert('请先分别选择原文文件和译文文件。');
            return;
        }
        try {
            const overwrite = !!config.singleFileOverwriteConflicts;
            const meta = await importSingleFilePair(pendingSingleOriginalFile, pendingSingleTranslationFile, overwrite);
            pendingSingleOriginalFile = null;
            pendingSingleTranslationFile = null;
            hideImportProgress();
            renderControlPanel();
            lastSig = '';
            tryProcess();
            if (onDone) onDone(meta);
        } catch (err) {
            const msg = err && err.message ? err.message : String(err);
            showImportProgress(`单文件导入失败:${msg}`);
            alert('单文件导入失败:' + msg);
            hideImportProgress(5000);
        }
    }

    function promptSingleFileUpload(onDone) {
        // 兼容旧入口:菜单或外部调用时,打开面板并提示用户按新流程分别选择。
        renderControlPanel(true);
        showToast('F', '请在总控里分别选择原文和译文,再点击导入/合并', { ttl: 4200 });
        if (onDone) onDone(null);
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
            '<div style="font-weight:600;margin-bottom:6px;">发布包未导入</div>' +
            '<div style="margin-bottom:8px;opacity:.85;">请导入 GitHub Release 发布的逐文件 .zip 包，将从其中的原文/译文 lang 文件对读取。</div>' +
            '<div style="display:grid;gap:6px;">' +
            '<button data-act="pkg" style="padding:5px 8px;border:0;border-radius:5px;cursor:pointer;background:#059669;color:#fff;">' +
            (st.pkg ? '✓ 发布包已存(重新导入)' : '导入发布压缩包(.zip)') + '</button>' +
            '<button data-act="close" style="padding:5px 8px;border:0;border-radius:5px;cursor:pointer;background:#374151;color:#ddd;">稍后</button>' +
            '</div>';
        bar.addEventListener('click', (ev) => {
            const btn = ev.target.closest('button');
            if (!btn) return;
            const act = btn.dataset.act;
            if (act === 'close') { bar.remove(); bannerEl = null; return; }
            promptUpload(() => {
                bar.remove();
                bannerEl = null;
                const s = storeStatus();
                if (s.pkg) log('回填数据已就绪');
                else showUploadBanner();
            });
        });
        document.body.appendChild(bar);
    }

    // ============ 悬浮总控台 ============
    let configEl = null;
    const FLOAT_ID = 'ptz-control-float';

    function showConfigPanel() {
        GM_setValue(STORE_FLOAT_COLLAPSED, false);
        renderControlPanel(true);
    }

    function formatPkgLine(m) {
        return m
            ? `${m.name} · ${m.files || 0} 文件 · ${m.entries || 0} 条 · ${((m.size || 0)/1024/1024).toFixed(1)} MB`
            : '未导入';
    }

    function formatSingleLine(m) {
        return m
            ? `${m.ptPath} · ${m.entryCount || 0} 条 · 原文:${m.originalName || '-'} · 译文:${m.translationName || '-'}`
            : `当前文件未导入单文件词库`;
    }

    function renderControlPanel(forceOpen = false) {
        document.getElementById(FLOAT_ID)?.remove();
        if (forceOpen) GM_setValue(STORE_FLOAT_COLLAPSED, false);
        const collapsed = !!GM_getValue(STORE_FLOAT_COLLAPSED, false);
        const st = storeStatus();
        const el = document.createElement('div');
        el.id = FLOAT_ID;
        el.style.cssText = [
            'position:fixed', 'bottom:20px', 'right:20px', 'z-index:99997',
            'background:#1f2937', 'color:#fff',
            collapsed ? 'padding:0' : 'padding:12px 14px',
            collapsed ? 'border-radius:999px' : 'border-radius:10px',
            'box-shadow:0 4px 18px rgba(0,0,0,.42)',
            'font:13px/1.45 system-ui,sans-serif',
            'user-select:none', 'max-width:min(430px, calc(100vw - 32px))',
        ].join(';');

        if (collapsed) {
            el.innerHTML = `<button data-act="expand" title="展开 ParaTranz 辅助总控" style="width:46px;height:46px;border:0;border-radius:999px;cursor:pointer;background:#2563eb;color:#fff;font-weight:800;box-shadow:none;">PT</button>`;
            el.addEventListener('click', (ev) => {
                if (ev.target.closest('[data-act="expand"]')) {
                    GM_setValue(STORE_FLOAT_COLLAPSED, false);
                    renderControlPanel(true);
                }
            });
            document.body.appendChild(el);
            configEl = el;
            return;
        }

        el.innerHTML =
            '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px;">' +
            '<div style="font-size:14px;font-weight:700;">ParaTranz 辅助总控</div>' +
            '<button data-act="collapse" title="缩小成按钮" style="border:0;border-radius:6px;background:#374151;color:#fff;cursor:pointer;padding:3px 8px;">缩小</button>' +
            '</div>' +

            '<div style="display:grid;grid-template-columns:1fr;gap:5px;margin-bottom:10px;">' +
            switchRow('enableSingleFileFill', 'F · 当前单文件词库回填(填入 + Ctrl+S)') +
            switchRow('enableLangFill', 'A · 逐文件发布包回填(填入 + Ctrl+S)') +
            switchRow('enableTmPerfect', 'B · 翻译记忆 ≥100% 匹配(复制 + Ctrl+S)') +
            switchRow('enableTokenDiffTransfer', 'D · 顶部 TM 仅数字/电压差异迁移(仅填入)') +
            switchRow('enableTmInText', 'C · “在文本中”原文全字相等(仅复制)') +
            switchRow('convertParens', '回填时半角括号转全角括号') +
            switchRow('enableAutoFillOriginal', 'E · 启用“原文即译文”危险开关') +
            armRow() +
            '</div>' +

            '<div style="height:1px;background:rgba(255,255,255,.12);margin:8px 0;"></div>' +
            '<div style="font-weight:700;margin-bottom:5px;">单文件原文/译文</div>' +
            `<div style="opacity:.82;font-size:12px;margin-bottom:6px;word-break:break-all;">${escapeHtml(formatSingleLine(st.single))}</div>` +
            `<div style="opacity:.72;font-size:12px;margin-bottom:6px;word-break:break-all;">${escapeHtml(singlePendingLine())}</div>` +
            switchRow('singleFileOverwriteConflicts', '导入冲突时由新文件词条覆盖旧词条') +
            '<div style="display:grid;grid-template-columns:1fr 1fr auto;gap:6px;margin:7px 0 6px;align-items:center;">' +
            btn('pick-single-original', '选择原文', '#2563eb') +
            btn('pick-single-translation', '选择译文', '#2563eb') +
            btn('clear-current-single', '清除当前文件词条', '#b45309') +
            '</div>' +
            '<div style="display:grid;grid-template-columns:1fr;gap:6px;margin:0 0 10px;">' +
            btn('import-single-pending', '导入 / 合并所选原文与译文', '#1d4ed8') +
            btn('clear-single', '清除所有单文件词库', '#7c2d12') +
            '</div>' +

            '<div style="height:1px;background:rgba(255,255,255,.12);margin:8px 0;"></div>' +
            '<div style="font-weight:700;margin-bottom:5px;">发布包</div>' +
            `<div style="opacity:.82;font-size:12px;margin-bottom:6px;word-break:break-all;">${escapeHtml(formatPkgLine(st.pkg))}</div>` +
            '<div style="display:flex;flex-wrap:wrap;gap:6px;margin:7px 0 10px;">' +
            btn('up-pkg', '导入 / 更新发布包(.zip)', '#059669') +
            btn('diag-pkg', '诊断当前词条命中', '#4b5563') +
            btn('clear-pkg', '清除发布包', '#b45309') +
            btn('reset', '恢复默认开关', '#374151') +
            '</div>' +
            '<div style="font-size:11px;opacity:.66;">提示: 单文件词库绑定当前 ParaTranz 面包屑文件路径。请先进入具体文件页再导入。</div>';

        function switchRow(key, label) {
            const checked = config[key] ? 'checked' : '';
            return `<label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin:0;min-height:22px;">` +
                `<input type="checkbox" data-cfg="${key}" ${checked} style="cursor:pointer;">` +
                `<span>${escapeHtml(label)}</span></label>`;
        }
        function armRow() {
            const disabled = config.enableAutoFillOriginal ? '' : 'disabled';
            const checked = autoFillArmed ? 'checked' : '';
            const opacity = config.enableAutoFillOriginal ? '1' : '.45';
            return `<label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin:0;min-height:22px;opacity:${opacity};">` +
                `<input type="checkbox" data-arm="auto-original" ${checked} ${disabled} style="cursor:pointer;">` +
                `<span style="color:${autoFillArmed ? '#fecaca' : '#fff'};">⚠ 立即激活: 自动填充原文 + 保存</span></label>`;
        }
        function btn(act, label, bg) {
            return `<button data-act="${act}" style="padding:6px 9px;border:0;border-radius:6px;cursor:pointer;background:${bg};color:#fff;">${escapeHtml(label)}</button>`;
        }

        el.addEventListener('change', (ev) => {
            const cb = ev.target.closest('input[type="checkbox"][data-cfg]');
            const arm = ev.target.closest('input[type="checkbox"][data-arm="auto-original"]');
            if (cb) {
                config[cb.dataset.cfg] = cb.checked;
                if (cb.dataset.cfg === 'enableAutoFillOriginal' && !cb.checked) autoFillArmed = false;
                saveConfig();
                log('配置已更新:', cb.dataset.cfg, '=', cb.checked);
                renderControlPanel();
                lastSig = '';
                tryProcess();
            } else if (arm) {
                autoFillArmed = arm.checked;
                log('自动填充原文开关:', autoFillArmed ? '已激活' : '已关闭');
                renderControlPanel();
                if (autoFillArmed) {
                    lastSig = '';
                    tryProcess();
                }
            }
        });

        el.addEventListener('click', (ev) => {
            const b = ev.target.closest('button[data-act]');
            if (!b) return;
            const act = b.dataset.act;
            if (act === 'collapse') {
                GM_setValue(STORE_FLOAT_COLLAPSED, true);
                renderControlPanel();
            } else if (act === 'up-pkg') {
                promptUpload(() => renderControlPanel());
            } else if (act === 'diag-pkg') {
                diagnoseCurrentPackageHit();
            } else if (act === 'clear-pkg') {
                if (confirm('确定要清除已保存的发布包吗?')) {
                    clearPackageStore();
                    renderControlPanel();
                }
            } else if (act === 'pick-single-original') {
                selectSingleLocalizedFile('original');
            } else if (act === 'pick-single-translation') {
                selectSingleLocalizedFile('translation');
            } else if (act === 'import-single-pending') {
                importPendingSingleFiles(() => renderControlPanel());
            } else if (act === 'clear-current-single') {
                const meta = currentSingleFileMeta();
                const label = meta ? `当前文件「${meta.ptPath}」的 ${meta.entryCount || 0} 条词条` : '当前文件词条';
                if (confirm(`确定要清除${label}吗?`)) {
                    const ok = clearCurrentSingleFileStore();
                    showToast('F', ok ? '已清除当前文件词条' : '当前文件没有可清除的单文件词库');
                    lastSig = '';
                    renderControlPanel();
                }
            } else if (act === 'clear-single') {
                if (confirm('确定要清除所有单文件原文/译文词库吗?')) {
                    clearSingleFileStore();
                    pendingSingleOriginalFile = null;
                    pendingSingleTranslationFile = null;
                    renderControlPanel();
                }
            } else if (act === 'reset') {
                if (confirm('恢复所有开关为默认?')) {
                    config = { ...DEFAULT_CONFIG };
                    autoFillArmed = false;
                    saveConfig();
                    renderControlPanel();
                }
            }
        });

        document.body.appendChild(el);
        configEl = el;
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
        F: '#2563eb', // 蓝 - 单文件词库回填
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

    // ============ 油猴菜单 ============
    try {
        GM_registerMenuCommand('展开悬浮总控台', showConfigPanel);
        GM_registerMenuCommand('导入发布压缩包', () => promptUpload());
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


            // F. 当前单文件原文/译文词库回填(优先级高于整包回填)
            if (config.enableSingleFileFill && singleFileIndex) {
                const hit = findSingleFileTranslation(mainOri);
                if (hit && hit.translation && hit.translation.trim() !== '') {
                    const zhFinal = transformForFill(hit.translation);
                    lastSig = sig;
                    if (ta.value.trim() === zhFinal.trim()) {
                        log('单文件词库命中且内容已一致,仅保存:', hit.source, hit.key);
                        showToast('F', `单文件内容已一致,仅保存 · ${hit.key}`);
                        pressCtrlS();
                        return;
                    }
                    log('单文件词库命中:', hit.source, hit.key, '→', zhFinal);
                    showToast('F', `单文件回填 · ${hit.key}`);
                    setTextareaValue(zhFinal);
                    await delay(FILL_TO_SAVE_DELAY);
                    pressCtrlS();
                    return;
                }
            }

            // A. 逐文件发布包回填
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
            if (!document.getElementById(FLOAT_ID)) {
                renderControlPanel();
            }
        });
    });

    function start() {
        obs.observe(document.documentElement, { childList: true, subtree: true });
        purgeLegacyLangStore();
        const ok = loadFromStore();
        if (!ok) {
            log('未检测到已导入的发布包,显示上传引导');
            setTimeout(showUploadBanner, 600);
        }
        renderControlPanel();
        setTimeout(tryProcess, 1200);
        log('脚本已启动,配置:', config);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }
})();
