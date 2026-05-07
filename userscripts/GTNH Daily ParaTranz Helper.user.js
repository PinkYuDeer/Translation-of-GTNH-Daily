// ==UserScript==
// @name         GTNH Daily ParaTranz Helper
// @namespace    paratranz-auto-100
// @version      5.14
// @description  1) 悬浮总控分区折叠; 2) files 页未翻译数量增强; 3) 纯 lang 发布包与单文件词库回填; 4) TM 自动复制与数字/电压迁移
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
        enableLangFill: true,         // A 文件原文全字匹配时回填
        preferSingleFileFill: false,  // A 子选项:单文件词库优先,否则发布包优先
        enableTmPerfect: true,        // B 参考 PT 历史翻译 100%+ 词条
        enableTmInText: true,         // C "在文本中" 全字相等仅复制
        enableTokenDiffTransfer: true,// D 顶部 TM 原文仅数字/电压差异时自动迁移
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

    function convertHalfwidthChinesePunctuation(text) {
        let quoteOpen = true;
        let singleQuoteOpen = true;
        const source = String(text || '');
        let out = '';
        for (let i = 0; i < source.length; i++) {
            const code = source.charCodeAt(i);
            if (code === 44 || code === 46) {
                const nextCode = source.charCodeAt(i + 1);
                if (nextCode === 32 || nextCode === 10 || nextCode === 13)
                    out += code === 44 ? '\uFF0C' : '\u3002';
                else
                    out += source.charAt(i);
                continue;
            }
            if (code === 39) {
                out += singleQuoteOpen ? '\u2018' : '\u2019';
                singleQuoteOpen = !singleQuoteOpen;
                continue;
            }
            if (code === 34) {
                out += quoteOpen ? '\u201C' : '\u201D';
                quoteOpen = !quoteOpen;
                continue;
            }
            if (code === 63) out += '\uFF1F';
            else if (code === 33) out += '\uFF01';
            else if (code === 58) out += '\uFF1A';
            else if (code === 59) out += '\uFF1B';
            else if (code === 40) out += '\uFF08';
            else if (code === 41) out += '\uFF09';
            else if (code === 91) out += '\u3010';
            else if (code === 93) out += '\u3011';
            else if (code === 123) out += '\uFF5B';
            else if (code === 125) out += '\uFF5D';
            else out += source.charAt(i);
        }
        return out;
    }

    function convertTextareaChinesePunctuation() {
        const ta = getTextarea();
        if (!ta) {
            showToast('E', '未找到输入区');
            return false;
        }
        const before = ta.value;
        const after = convertHalfwidthChinesePunctuation(before);
        if (after === before) {
            showToast('E', '输入区没有可转换的半角标点');
            return false;
        }
        setTextareaValue(after);
        showToast('E', '已转换输入区半角标点');
        log('已转换输入区半角标点:', before, '→', after);
        return true;
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

    function mergeSingleEntries(oldEntries, newEntries) {
        const list = [];
        const byOriginal = new Map();
        const valid = (e) => !!(e && e.original && String(e.translation || '').trim());
        const add = (e) => {
            const idx = list.length;
            list.push(e);
            byOriginal.set(String(e.original), idx);
        };
        for (const e of oldEntries || []) {
            if (!valid(e)) continue;
            add(e);
        }
        for (const e of newEntries || []) {
            if (!valid(e)) continue;
            const original = String(e.original);
            const originalHit = byOriginal.get(original);
            if (originalHit !== undefined) {
                list[originalHit] = e;
                continue;
            }
            add(e);
        }
        return list;
    }

    async function importSingleFilePair(originalFile, translationFile) {
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
        const mergedEntries = mergeSingleEntries(oldEntries, entries);
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
        };
        const files = [...oldFiles, fileMeta];
        saveSingleFileIndexFiles(files);
        showImportProgress(`单文件导入完成:${entries.length} 条原文匹配词条 / 当前 ${mergedEntries.length} 条`);
        showToast('A', `单文件词库导入完成 · ${mergedEntries.length} 条`);
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
                showToast('A', `已选择原文 · ${file.name}`, { ttl: 2800 });
            } else {
                pendingSingleTranslationFile = file;
                showToast('A', `已选择译文 · ${file.name}`, { ttl: 2800 });
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
            const meta = await importSingleFilePair(pendingSingleOriginalFile, pendingSingleTranslationFile);
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
        showToast('A', '请在总控里分别选择原文和译文,再点击导入/合并', { ttl: 4200 });
        if (onDone) onDone(null);
    }

    // ============ files 页未翻译数量增强 ============
    const UNTRANSLATED_COUNT_CLASS = 'ptz-untranslated-count';

    function isFilesPage() {
        return (document.body && document.body.dataset && document.body.dataset.page === 'project.files')
            || /^\/projects\/\d+\/files\/?$/.test(location.pathname);
    }

    function parseStatNumber(value) {
        const normalized = String(value || '').replace(/,/g, '').trim();
        const n = Number(normalized);
        return Number.isFinite(n) ? n : NaN;
    }

    function parseTotalEntries(text) {
        const m = String(text || '').match(/总条数\s*([\d,]+)(?:\s*词条)?|共\s*([\d,]+)\s*词条/);
        return m ? parseStatNumber(m[1] || m[2]) : NaN;
    }

    function parseTranslatedPercent(text) {
        const m = String(text || '').match(/(?:已翻译\s*)?(\d+(?:\.\d+)?)\s*%/);
        return m ? parseStatNumber(m[1]) : NaN;
    }

    function calcUntranslatedCount(total, translatedPercent) {
        if (!Number.isFinite(total) || !Number.isFinite(translatedPercent)) return NaN;
        const ratio = Math.max(0, Math.min(1, 1 - translatedPercent / 100));
        return Math.max(0, Math.round(total * ratio));
    }

    function findTextNodeContaining(root, needle) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode: function (node) {
                if (node.parentElement
                    && node.parentElement.classList
                    && node.parentElement.classList.contains(UNTRANSLATED_COUNT_CLASS)) {
                    return NodeFilter.FILTER_REJECT;
                }
                return node.nodeValue && node.nodeValue.includes(needle)
                    ? NodeFilter.FILTER_ACCEPT
                    : NodeFilter.FILTER_REJECT;
            },
        });
        return walker.nextNode();
    }

    function ensureGroupUntranslatedBadge(groupTitle) {
        const translated = groupTitle.querySelector('.badge[title="已翻译"]');
        if (!translated) return;
        const total = parseTotalEntries(groupTitle.textContent);
        const percent = parseTranslatedPercent(translated.textContent);
        const untranslated = calcUntranslatedCount(total, percent);
        if (!Number.isFinite(untranslated)) return;
        const sig = String(total) + '|' + String(percent) + '|' + String(untranslated);

        let badge = groupTitle.querySelector('.' + UNTRANSLATED_COUNT_CLASS + '.badge');
        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'badge badge-warning ' + UNTRANSLATED_COUNT_CLASS;
            badge.title = '未翻译';
            badge.style.marginRight = '4px';
            translated.parentNode.insertBefore(badge, translated);
        }
        if (badge.getAttribute('data-sig') === sig) return;
        badge.setAttribute('data-sig', sig);
        badge.textContent = '未翻译 ' + untranslated;
    }

    function ensureFileItemUntranslatedText(statsEl) {
        const total = parseTotalEntries(statsEl.textContent);
        const percentMatch = String(statsEl.textContent || '').match(/已翻译\s*(\d+(?:\.\d+)?)\s*%/);
        const percent = percentMatch ? parseStatNumber(percentMatch[1]) : NaN;
        const untranslated = calcUntranslatedCount(total, percent);
        if (!Number.isFinite(untranslated)) return;
        const sig = String(total) + '|' + String(percent) + '|' + String(untranslated);

        let marker = statsEl.querySelector('.' + UNTRANSLATED_COUNT_CLASS);
        if (!marker) {
            const node = findTextNodeContaining(statsEl, '已翻译');
            if (!node || !node.parentNode) return;
            const idx = node.nodeValue.indexOf('已翻译');
            const afterText = node.nodeValue.slice(idx);
            node.nodeValue = node.nodeValue.slice(0, idx);
            marker = document.createElement('span');
            marker.className = UNTRANSLATED_COUNT_CLASS + ' text-warning';
            marker.title = '未翻译';
            const afterNode = document.createTextNode(afterText);
            node.parentNode.insertBefore(marker, node.nextSibling);
            node.parentNode.insertBefore(afterNode, marker.nextSibling);
        }
        if (marker.getAttribute('data-sig') === sig) return;
        marker.setAttribute('data-sig', sig);
        marker.textContent = '未翻译 ' + untranslated + ' / ';
    }

    function enhanceFilesPageStats() {
        if (!isFilesPage()) return;
        document.querySelectorAll('.files .group-title').forEach(ensureGroupUntranslatedBadge);
        document.querySelectorAll('.files .group-list-item .text-muted.medium').forEach(ensureFileItemUntranslatedText);
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
            el.innerHTML =
                '<div style="display:flex;flex-direction:column;gap:7px;align-items:flex-end;">' +
                '<button data-act="punctuate" title="转换输入区半角标点" style="width:46px;height:32px;border:0;border-radius:999px;cursor:pointer;background:#dc2626;color:#fff;font-weight:700;box-shadow:none;font-size:12px;">标点</button>' +
                '<button data-act="expand" title="展开 ParaTranz 辅助总控" style="width:46px;height:46px;border:0;border-radius:999px;cursor:pointer;background:#2563eb;color:#fff;font-weight:800;box-shadow:none;">PT</button>' +
                '</div>';
            el.addEventListener('click', (ev) => {
                const b = ev.target.closest('button[data-act]');
                if (!b) return;
                if (b.dataset.act === 'punctuate') {
                    convertTextareaChinesePunctuation();
                } else if (b.dataset.act === 'expand') {
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

            '<div style="font-size:12px;font-weight:700;opacity:.9;margin-bottom:5px;">处理顺序</div>' +
            '<div style="display:grid;grid-template-columns:1fr;gap:5px;margin-bottom:10px;">' +
            switchRow('enableLangFill', 'A · 文件原文全字匹配时回填(填入 + Ctrl+S)') +
            switchRow('preferSingleFileFill', 'A · 单文件词库优先(未勾选发布包优先)', { disabled: !config.enableLangFill, indent: true }) +
            switchRow('enableTmPerfect', 'B · 参考PT历史翻译100%+词条(复制 + Ctrl+S)') +
            switchRow('enableTmInText', 'C · “在文本中”原文全字相等(仅复制)') +
            switchRow('enableTokenDiffTransfer', 'D · 顶部 TM 仅数字/电压差异迁移(仅填入)') +
            switchRow('enableAutoFillOriginal', 'E · 原文即译文危险开关') +
            armRow() +
            '</div>' +

            '<div style="height:1px;background:rgba(255,255,255,.12);margin:8px 0;"></div>' +
            '<div style="font-weight:700;margin-bottom:5px;">输入区按钮</div>' +
            '<div style="display:grid;grid-template-columns:1fr;gap:6px;margin:7px 0 8px;">' +
            btn('punctuate', '输入区半角标点转全角', '#dc2626') +
            '</div>' +
            '<details style="margin-top:8px;">' +
            '<summary style="cursor:pointer;font-weight:700;opacity:.92;">导入</summary>' +
            '<div style="font-weight:700;font-size:12px;opacity:.9;margin:7px 0 4px;">发布压缩包</div>' +
            `<div style="opacity:.82;font-size:12px;margin-bottom:6px;word-break:break-all;">${escapeHtml(formatPkgLine(st.pkg))}</div>` +
            '<div style="display:grid;grid-template-columns:1fr;gap:6px;margin:0 0 8px;">' +
            btn('up-pkg', '导入 / 更新发布包(.zip)', '#059669') +
            '</div>' +
            '<div style="height:1px;background:rgba(255,255,255,.1);margin:8px 0;"></div>' +
            '<div style="font-weight:700;font-size:12px;opacity:.9;margin:7px 0 4px;">单文件词库(归入 A)</div>' +
            `<div style="opacity:.82;font-size:12px;margin:6px 0;word-break:break-all;">${escapeHtml(formatSingleLine(st.single))}</div>` +
            `<div style="opacity:.72;font-size:12px;margin-bottom:6px;word-break:break-all;">${escapeHtml(singlePendingLine())}</div>` +
            '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:7px 0 6px;align-items:center;">' +
            btn('pick-single-original', '选择原文', '#2563eb') +
            btn('pick-single-translation', '选择译文', '#2563eb') +
            '</div>' +
            '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:0 0 8px;">' +
            btn('import-single-pending', '导入 / 合并', '#1d4ed8') +
            btn('clear-current-single', '清除当前', '#b45309') +
            btn('clear-single', '清除全部', '#7c2d12') +
            '</div>' +
            '<div style="font-size:11px;opacity:.66;">只按原文匹配替换; 同 key 但原文不同会保留为独立候选。</div>' +
            '</details>' +
            '<details style="margin-top:8px;">' +
            '<summary style="cursor:pointer;font-weight:700;opacity:.92;">其他</summary>' +
            '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:7px 0;">' +
            btn('diag-pkg', '诊断当前词条命中', '#4b5563') +
            btn('clear-pkg', '清除发布包', '#b45309') +
            '</div>' +
            '<div style="display:grid;grid-template-columns:1fr;gap:5px;margin:7px 0;">' +
            switchRow('convertParens', '回填时半角括号转全角括号') +
            '</div>' +
            '<div style="display:grid;grid-template-columns:1fr;gap:6px;margin-top:6px;">' +
            btn('reset', '恢复默认开关', '#374151') +
            '</div>' +
            '<div style="font-size:11px;opacity:.66;margin-top:6px;">提示: 单文件词库绑定当前 ParaTranz 面包屑文件路径。请先进入具体文件页再导入。</div>' +
            '</details>';

        function switchRow(key, label, opts) {
            opts = opts || {};
            const checked = config[key] ? 'checked' : '';
            const disabled = opts.disabled ? 'disabled' : '';
            const opacity = opts.disabled ? '.45' : '1';
            const indent = opts.indent ? 'padding-left:22px;' : '';
            return `<label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin:0;min-height:22px;opacity:${opacity};${indent}">` +
                `<input type="checkbox" data-cfg="${key}" ${checked} ${disabled} style="cursor:pointer;">` +
                `<span style="min-width:0;line-height:1.3;">${escapeHtml(label)}</span></label>`;
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
            return `<button data-act="${act}" style="padding:6px 8px;border:0;border-radius:6px;cursor:pointer;background:${bg};color:#fff;white-space:normal;line-height:1.25;min-height:30px;">${escapeHtml(label)}</button>`;
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
            } else if (act === 'punctuate') {
                convertTextareaChinesePunctuation();
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
                    showToast('A', ok ? '已清除当前文件词条' : '当前文件没有可清除的单文件词库');
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
        A: '#2563eb', // 蓝 - 文件原文匹配回填
        B: '#059669', // 绿 - PT 历史翻译 100%+
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
    const TRADITIONAL_CHINESE_CHARS = [
        '萬與專業叢東絲丟兩嚴喪個豐臨為麗舉麼義烏樂喬習鄉書買亂爭於虧雲亞產畝親',
        '來侖侶俠倀倆倉個們倫偉側偵傑傖傘備傢傭債傾僅僉僑僕僞儀儂億儈儉儐儔儕',
        '儘償優儲儷兇兌兒內兩冊凈凍凜凱別刪剄則剋剎剛剝剮創劃劇劉劊劌劍劑勁勞',
        '勢勛勝勵勸勻匭匯匱區協卻厭厲參叢吳呂咼員唄問啟啞啣喚喪喬單喲嗆嗇嗎',
        '嗚嗶嘆嘍嘔嘖嘗嘜嘩嘮嘯嘰嘵嘸嘽噁噓噠噥噦噯噲噴噸噹嚀嚇嚌嚐嚕嚙嚥',
        '嚦嚨嚮嚳嚴囂囑圇國圍園圓圖團執堅堊堖堯報場塊塋塗塚塢塤塵塹墊墜墮',
        '墳牆壇壓壘壙壚壞壟壢壩壯壺壽夠夢夾奐奧奩奪奮妝姍姦婁婦婭媧媯媽嫗',
        '嫵嫻嬈嬋嬌嬙嬡嬤嬪嬰嬸孌孫學孿寢實寧審寫寬寵將專尋對導尷屆屍屜屢層',
        '屬岡峴島峽崍崗崢嵐嶁嶄嶇嶔嶗嶧嶺嶼巋巒巔巖帥師帳帶幀幃幗幘幟幣幫',
        '幹幾庫廁廂廄廈廚廝廟廠廡廢廣廩廬廳弒弔張強彈彌彎彙彥後徑從徠復徵',
        '徹恆恥悅悶惡惱惲惻愛愜愨愴愷愾態慍慘慚慟慣慪慫慮慳慶憂憊憐憑憒憚',
        '憤憫憮憲憶懇應懌懟懣懨懲懶懷懸懺懼懾戀戇戔戧戰戲戶拋挾捨捫掃掄掙',
        '掛採揀揚換揮損搖搗搶摑摜摟摯摳摶摻撈撏撐撓撟撣撥撫撲撳撻撾撿擁擄',
        '擇擊擋擔據擠擬擯擰擱擲擴擷擺擻擾攄攆攏攔攙攛攜攝攢攣攤攪攬敗敘',
        '敵數斂斃斕斬斷於昇時晉晝暈暉暘暢暫曄曆曇曉曖曠曨曬會朧東棖棗棟棧',
        '棲楊楓楨業極榮構槍槓槤槳樁樂樅樑樓標樞樣樸樹橈橋機橢橫檁檔檜檢檣',
        '檯檳檸檻櫃櫓櫚櫛櫝櫞櫟櫥櫧櫨櫪櫬櫳櫸櫻欄權欒欖歎歐歟歡歲歷歸歿',
        '殘殞殤殫殮殯殲殺殼毀毆氈氣氫氬氳汙決沒況洩洶浹涇涼淒淚淥淨淪淵',
        '淶淺渙減渦測渾湊湞湯溈準溝溫滄滅滌滬滯滲滷滸滾滿漁漚漢漣漬漲漸',
        '漿潁潑潔潛潤潯潰澀澆澇澗澤澱濁濃濕濘濟濤濫濰濱濺濾瀅瀆瀉瀋瀏',
        '瀕瀘瀝瀟瀠瀦瀧瀨瀰瀲瀾灑灘灣灤災為烏無煉煒煙煥煩煬熱熾燁燈燉燒',
        '燙燜營燦燭燴燻燼爍爐爛爭爺爾牽犖犢犧狀狹狽猙猶猻獄獅獎獨獪獫獰',
        '獲獵獷獸獺獻獼現瑋瑣瑤瑩瑪璉璣璦環璽瓊瓏瓔甌產畝畢畫異當疇疊痙',
        '瘂瘋瘍瘓瘞瘡瘧療癆癇癉癘癟癡癢癤癥癧癩癬癭癮癰癱癲發皚皰皸盃',
        '盜盞盡監盤盧眾睜睞瞞瞭瞶瞼矇矓矚矯硜硤硨硯碩碭確碼磚磧磯礎礙',
        '礦礪礫礬祿禍禎禕禦禪禮禱禿秈稅稈稟種稱穀積穎穠穡穢穩穫窩窪窮',
        '窯窺竄竅竇竊競筆筍筧箋箏節範築篋篤篩篳簀簍簞簡簣簫簽簾籃籌籜',
        '籟籠籤籩籪籬籮糞糧糰糲糾紀紂約紅紆紇紈紉紋納紐紓純紕紗紙級紛',
        '紜紡紮細紱紲紳紹紺終組絆結絕絛絞絡絢給絨統絲絳絹綁綃綆綈綉綏',
        '經綜綞綠綢綬維綱網綴綵綸綹綺綻綽綾綿緊緒線緝緞締緣編緩緬緯練',
        '縈縉縊縋縐縑縛縝縞縟縣縧縫縮縱縲縵縷縹總績繃繅繆繒織繕繚繞繡',
        '繢繩繪繫繭繳繼繽續纏纓纖纘纜缽罈罌罰罷羅羈義習翹聖聞聯聰聲聳',
        '職聽聾肅脅脈脫脹腎腦腫腳腸膚膠膩膽膾膿臉臍臘臚臟臠臥臨臺與興',
        '舉艙艦艱艷芻莊莖莢萊萬葉葦葷蒔蒞蒼蓋蓮蓽蔔蔞蔣蔥蔦蔭蕁蕎蕒蕓',
        '蕕蕘蕢蕩蕪蕭蕷薈薊薌薑薔薘薦薩薰薺藍藝藥藪藴藶藹藺蘆蘇蘊蘋蘚',
        '蘭處虛虜號虧蛺蛻蜆蝕蝟蝦蝸螄螞螢螻蟄蟈蟎蟬蟯蟲蟻蠅蠍蠐蠟蠣',
        '蠱蠶蠻衆衊術衕袞裊補裝裡製複褲褻襖襠襤襪襯襲見規覓視覘覡覦親',
        '覬覲覷覺覽觀觴觸訂訃計訊訌討訐訓訖託記訛訝訟訣訥訪設許訴診註',
        '詁詆詎詐詔評詛詞詠詡詢試詩詫詬詭詮話該詳詼誄誅誆誇誌認誑誕誘',
        '語誠誡誣誤誥誦誨說誰課誹誼調談請諍諏諒論諗諜諞諢諤諦諧諫諮諱',
        '諳諷諸諺諾謀謁謂謊謎謐謔謗謙講謝謠謨謫謬謳謹謾譁證譎譏識譙譚',
        '譜譟譫譯議譴護譽讀變讓讕讖讚讜豈豎豐豔貝貞負財貢貧貨販貪貫責',
        '貯貳貴貶買貸費貼貽貿賀賁賂賃賄資賈賊賑賒賓賜賞賠賢賣賤賦質賬',
        '賭賴賺購賽贈贊贍贏贓贖贗贛趕趙趨跡踐踴蹌蹕蹣蹤蹺躂躉躊躋躍躑',
        '躒躓躚軀車軋軌軍軒軔軟軫軸軹軺軻軼較輅輇載輊輔輕輒輓輛輜輝輞',
        '輟輥輦輩輪輯輸輻輾輿轄轅轆轉轍轎轟轢轤辦辭辮辯農迴逕這連週進',
        '遊運過達違遙遜遞遠適遲遷選遺遼邁還邇邊邏鄉鄒鄔鄖鄧鄭鄰鄲鄴郵',
        '醞醬醫釀釁釋鈀鈉鈍鈐鈑鈔鈕鈞鈣鈥鈦鈴鈷鈸鈺鈾鉀鉅鉑鉗鉚鉛鉤鉬',
        '鉭鉶鉸鉻銀銅銑銓銖銘銜銠銣銥銦銨銩銫銬銳銷銹銻銼鋁鋅鋇鋒鋤鋪',
        '鋯鋰鋼錄錐錘錠錢錦錫錮錯錳錶鍊鍋鍍鍛鍥鍬鍵鍾鎂鎊鎖鎢鎮鎳鎵鏃鏈',
        '鏍鏟鏡鏽鐘鐃鐐鐓鐔鐙鐠鐥鐦鐧鐨鐫鐮鐲鐳鐵鐶鐸鐺鑄鑑鑒鑲鑰鑽鑾',
        '鑿長門閂閃閉開閏閑間閔閘閡閣閤閥閨閩閫閬閭閱閶閹閻閼闆闈闊闋',
        '闌闍闔闖關闞闡闢阜陘陝陣陰陳陸陽隉隊階隕際隨險隱隴隸隻雋雖雙',
        '雛雜雞離難雲電霧霽靂靄靈靚靜靦鞀鞏韁韃韆韋韌韓韙韜韻響頁頂頃',
        '項順須頊頌預頑頒頓頗領頜頡頤頦頭頰頷頸頹頻顆題額顎顏顒顓願顛',
        '類顧顫顯顰顱風颯颱颳颶颼飄飆飛饑飯飲飴飼飽飾餃餄餅餉養餌餓餒',
        '餘餚餛餞餡館餬餵餽餾饃饅饈饉饋饌饒饗饞饢馬馭馮馱馳馴駁駐駑駒',
        '駔駕駘駙駛駝駟駢駭駰駱駸駿騁騅騎騍騏騖騙騫騰騶騷騾驀驁驂驃驅',
        '驊驍驏驕驗驚驛驟驢驥驪骯髏髒體髕髖鬆鬍鬚鬥鬧鬨鬩鬱魎魘魚魛魟',
        '魨魯魷鮁鮃鮑鮓鮚鮜鮞鮟鮣鯁鯉鯊鯒鯛鯡鯤鯨鯪鯫鯰鯽鰂鰍鰓鰨鰭',
        '鰱鰲鰳鰻鰾鱈鱉鱒鱔鱖鱗鱘鱟鱠鱣鱧鱷鱸鳥鳧鳩鳳鳴鳶鴆鴇鴉鴒鴕',
        '鴛鴝鴞鴟鴣鴦鴨鴯鴰鴻鴿鵂鵑鵒鵓鵜鵝鵠鵡鵪鵬鵯鵰鵲鵾鶇鶉鶘鶚',
        '鶯鶴鶹鶺鶻鷂鷓鷗鷙鷚鷥鷦鷯鷲鷸鷺鸚鸛鹵鹹鹼鹽麗麥麩黃黌點黨',
        '黲黴黶黷黽黿鼉鼴齊齋齒齔齕齗齙齜齟齠齡齦齧齪齬齲齶齷龍龐龔龕龜'
    ].join('');
    const TRADITIONAL_CHINESE_RE = new RegExp('[' + TRADITIONAL_CHINESE_CHARS + ']');
    function containsTraditionalChinese(text) {
        return TRADITIONAL_CHINESE_RE.test(String(text || ''));
    }
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
    function getTmText(item, kind) {
        const root = item && item.querySelector('.' + kind);
        if (!root) return '';
        const el = root.querySelector('.text-pre-wrap') || root;
        return el ? el.textContent.trim() : '';
    }
    function findPerfectMatchItem() {
        const tm = document.querySelector('.translation-memory');
        if (!tm) return null;
        for (const item of tm.querySelectorAll('.string-item')) {
            const header = item.querySelector('header');
            if (!header) continue;
            const m = header.textContent.replace(/\s+/g, '').match(/匹配率(\d+(?:\.\d+)?)%/);
            if (m && parseFloat(m[1]) >= 100) {
                const zh = getTmText(item, 'translation');
                if (containsTraditionalChinese(zh)) {
                    log('跳过参考PT历史翻译100%+:译文包含繁体字符:', zh);
                    continue;
                }
                return item;
            }
        }
        return null;
    }
    function findInTextItem() {
        const tm = document.querySelector('.translation-memory');
        if (!tm) return null;
        for (const item of tm.querySelectorAll('.string-item')) {
            const header = item.querySelector('header');
            if (header && header.textContent.replace(/\s+/g, '').includes('在文本中')) {
                const zh = getTmText(item, 'translation');
                if (containsTraditionalChinese(zh)) {
                    log('跳过"在文本中":译文包含繁体字符:', zh);
                    continue;
                }
                return item;
            }
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
            // A. 文件原文全字匹配时回填:发布包或单文件词库
            if (config.enableLangFill) {
                const sourceOrder = config.preferSingleFileFill ? ['single', 'package'] : ['package', 'single'];
                for (const sourceType of sourceOrder) {
                    const hit = sourceType === 'single'
                        ? (singleFileIndex ? findSingleFileTranslation(mainOri) : null)
                        : (packageIndex ? findPackageTranslation(mainOri) : null);
                    if (hit && hit.translation && hit.translation.trim() !== '') {
                        const zhFinal = transformForFill(hit.translation);
                        const sourceName = sourceType === 'single' ? '单文件词库' : '发布包';
                        lastSig = sig;
                        if (ta.value.trim() === zhFinal.trim()) {
                            log(`${sourceName}命中且内容已一致,仅保存:`, hit.source, hit.key);
                            showToast('A', `${sourceName}内容已一致,仅保存 · ${hit.key}`);
                            pressCtrlS();
                            return;
                        }
                        log(`${sourceName}命中:`, hit.source, hit.key, '→', zhFinal);
                        showToast('A', `${sourceName}回填 · ${hit.key}`);
                        setTextareaValue(zhFinal);
                        await delay(FILL_TO_SAVE_DELAY);
                        pressCtrlS();
                        return;
                    }
                }
            }

            // B. 参考 PT 历史翻译 100%+ 词条
            if (config.enableTmPerfect) {
                const perfect = findPerfectMatchItem();
                if (perfect) {
                    const copyBtn = perfect.querySelector('button[title="复制当前文本至翻译框"]');
                    if (copyBtn) {
                        lastSig = sig;
                        log('≥100% 匹配命中,复制 + 保存');
                        showToast('B', '参考PT历史翻译100%+ → 复制并保存');
                        copyBtn.click();
                        await delay(COPY_TO_SAVE_DELAY);
                        normalizeTextareaValue();
                        pressCtrlS();
                        return;
                    }
                }
            }

            // C. "在文本中" + 翻译框为空 + 原文全字相等 → 仅复制
            if (config.enableTmInText && isTextareaEmpty()) {
                const item = findInTextItem();
                if (item) {
                    const tmOri = getTmText(item, 'original');
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

            // D. 顶部 TM 匹配 <100%,原文差异仅限数字/电压代码 → 迁移译文
            if (config.enableTokenDiffTransfer && isTextareaEmpty()) {
                const top = getTopTmItem();
                if (top && top.ratio > 0 && top.ratio < 100) {
                    if (containsTraditionalChinese(top.zh)) {
                        log('跳过顶部 TM 数字/电压迁移:译文包含繁体字符:', top.zh);
                    } else {
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
            }

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
            enhanceFilesPageStats();
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
        enhanceFilesPageStats();
        setTimeout(tryProcess, 1200);
        log('脚本已启动,配置:', config);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }
})();
