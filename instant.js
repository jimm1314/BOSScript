// ==UserScript==
// @name         BOSS直聘 批量沟通（受控版）
// @namespace    https://github.com/jimm1314/BOSScript
// @version      1.1.0
// @description  受控批量"立即沟通"：去重队列、并发上限、随机间隔、每日配额、自动翻页、可随时停止
// @author       solenya / jesslynwong (fork 优化版)
// @match        https://www.zhipin.com/web/geek/job*
// @match        https://www.zhipin.com/job_detail/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @noframes
// ==/UserScript==

/**
 * 架构说明
 * ---------------------------------------------------------------
 * 主控（列表页）                     执行器（详情页，1~N 个）
 *   采集 → 去重 → 过滤 → 队列          读任务 → 点一次 → 观察 → 上报
 *        ↓ window.open（并发 ≤ 2）           ↑
 *        └──────── GM 存储（任务状态通道）────┘
 *
 * 三条设计红线：
 * 1. 任何轮询回调都必须能走到 clearInterval（异常也要清）。
 * 2. 一个职位只点一次"立即沟通"（副作用动作，必须幂等）。
 * 3. 只有确认状态变化后才关闭页面，关闭前留出最小稳定期。
 *
 * 单写者约定：
 * - 执行器只写 Channel（任务状态）与 Quota（配额）。
 * - 主控是 Records（历史记录）的唯一写入方，避免多标签页并发写同一份记录。
 */

(function () {
    'use strict';

    /* ==========================================================
     * 1. 配置层：站点改版 / 策略调整只需改这里
     * ========================================================== */
    var CONFIG = {
        concurrency: 2,           // 同时打开的详情页数量，建议 1-2
        minGapMs: 1500,           // 两次开窗的最小间隔
        maxGapMs: 3000,           // 最大间隔，实际值在区间内随机
        dailyLimit: 20,           // 每日最多成功沟通次数（主动限流，远低于平台上限）
        maxTasksPerRun: 30,       // 单次最多处理任务数（跨页累计）
        taskTimeoutMs: 25000,     // 主控侧单任务超时
        workerDeadlineMs: 18000,  // 详情页侧整体超时
        minSettleMs: 1200,        // 点击后最小等待，避免中断飞行中的请求
        tickMs: 300,              // 状态机轮询间隔
        controllerTickMs: 800,    // 主控轮询间隔
        keywords: [],             // 职位关键词白名单，空数组 = 不过滤，例如 ['前端','React']
        skipCardText: ['已投递', '已沟通', '已结束', '停止招聘'],

        pagination: {
            enabled: true,        // 队列空时是否自动点"下一页"
            maxPages: 3,          // 最多翻几页（不含首页）
            waitMs: 6000          // 翻页后等待列表刷新的上限
        },

        // 接口级信号：默认关闭。开启后需填入抓包得到的沟通接口片段，
        // 命中 2xx 即判定成功，比 DOM 信号更可靠。
        network: {
            enabled: false,
            urlPattern: '',       // 例如 'chat/start'，留空则只记录不判定
            log: false            // 打开后把页面所有 xhr/fetch URL 打到控制台，便于抓包
        },

        sel: {
            listBox: '.job-list-box',
            card: 'li',
            jobLink: 'a[href*="/job_detail/"]',
            jobTitle: '.job-name',
            startBtn: '.btn-startchat',
            btnContainer: '.btn-container',
            dialog: '.dialog-container',
            risk: '.geetest_panel, #captcha, .verify-wrap',
            nextPage: ['.options-pages a:last-child', '.options-pages .ui-icon-arrow-right', 'a.ui-icon-arrow-right']
        }
    };

    var PREFIX = 'bos:v1:';
    var MAX_RECORDS = 500;

    var STATUS_LABEL = {
        success: '成功',
        already: '已沟通',
        failed: '失败',
        cancelled: '已取消'
    };

    /* ==========================================================
     * 2. 工具层：所有 DOM 取值都经过判空，永不抛错
     * ========================================================== */
    function log() {
        try {
            var args = Array.prototype.slice.call(arguments);
            args.unshift('[BOS]');
            console.log.apply(console, args);
        } catch (e) { /* 忽略 */ }
    }

    function safeQuery(sel, root) {
        try {
            return (root || document).querySelector(sel);
        } catch (e) {
            return null;
        }
    }

    function safeQueryAll(sel, root) {
        try {
            return Array.prototype.slice.call((root || document).querySelectorAll(sel));
        } catch (e) {
            return [];
        }
    }

    function textOf(el) {
        if (!el) return '';
        var t = typeof el.innerText === 'string' ? el.innerText : el.textContent;
        return (t || '').replace(/\s+/g, ' ').trim();
    }

    // 从详情页 URL 提取稳定的 jobId，用于去重与结果回写
    function extractJobId(url) {
        if (!url) return '';
        var s = String(url);
        var m = s.match(/\/job_detail\/([^\/?#]+?)\.html/) || s.match(/\/job_detail\/([^\/?#]+)/);
        return m ? m[1] : '';
    }

    // 纯函数：去重 → 过滤 → 截断。便于单测，不触碰 DOM
    function pickTasks(tasks, opts) {
        var o = opts || {};
        var seen = {};
        var exclude = o.exclude || {};
        var keywords = (o.keywords || []).filter(Boolean);
        var skipText = (o.skipText || []).filter(Boolean);
        var limit = typeof o.limit === 'number' ? o.limit : Infinity;
        var out = [];

        for (var i = 0; i < (tasks || []).length; i++) {
            if (out.length >= limit) break;
            var t = tasks[i];
            if (!t || !t.id) continue;
            if (seen[t.id]) continue;      // 同页重复卡位
            seen[t.id] = 1;
            if (exclude[t.id]) continue;   // 历史已处理 / 本轮已入队
            var blob = (t.title || '') + ' ' + (t.text || '');
            if (skipText.some(function (s) { return blob.indexOf(s) !== -1; })) continue;
            if (keywords.length && !keywords.some(function (k) { return blob.indexOf(k) !== -1; })) continue;
            out.push(t);
        }
        return out;
    }

    function randGap() {
        var min = CONFIG.minGapMs;
        var max = Math.max(min, CONFIG.maxGapMs);
        return Math.round(min + Math.random() * (max - min));
    }

    function isDetailPath(p) { return /\/job_detail\//.test(p || ''); }
    function isListPath(p) { return /^\/web\/geek\/job\/?$/.test(p || ''); }

    function todayKey() {
        var d = new Date();
        var p = function (n) { return n < 10 ? '0' + n : '' + n; };
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    }

    /* ---------- CSV 导出（纯函数 + 下载） ---------- */
    function csvCell(v) {
        var s = (v === null || v === undefined) ? '' : String(v);
        if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
        return s;
    }

    function recordsToCsv(records) {
        var all = records || {};
        var rows = [['jobId', '职位', '状态', '原因', '时间', '链接'].map(csvCell).join(',')];
        Object.keys(all)
            .sort(function (a, b) { return (all[b].ts || 0) - (all[a].ts || 0); })
            .forEach(function (id) {
                var r = all[id] || {};
                rows.push([
                    id,
                    r.title || '',
                    STATUS_LABEL[r.status] || r.status || '',
                    r.reason || '',
                    r.ts ? new Date(r.ts).toLocaleString('zh-CN') : '',
                    r.url || ''
                ].map(csvCell).join(','));
            });
        return rows.join('\r\n');
    }

    function downloadCsv() {
        var csv = '\uFEFF' + recordsToCsv(Records.all());
        var name = 'boss-records-' + todayKey() + '.csv';
        try {
            var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
            var a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = name;
            (document.body || document.documentElement).appendChild(a);
            a.click();
            setTimeout(function () {
                try { URL.revokeObjectURL(a.href); } catch (e) { /* 忽略 */ }
                if (a.parentNode) a.parentNode.removeChild(a);
            }, 1500);
            return true;
        } catch (e) {
            log('导出失败', e);
            return false;
        }
    }

    /* ---------- 接口探针（默认关闭，只做信号采集） ---------- */
    var NET = { hit: 0, ts: 0 };

    function onNetDone(status, url) {
        var cfg = CONFIG.network || {};
        if (cfg.log) log('net done', status, url);
        if (!cfg.enabled || !cfg.urlPattern) return;
        if (String(url).indexOf(cfg.urlPattern) === -1) return;
        if (status >= 200 && status < 300) {
            NET.hit += 1;
            NET.ts = Date.now();
        }
    }

    function installNetworkProbe() {
        var cfg = CONFIG.network || {};
        if (!cfg.enabled && !cfg.log) return;

        try {
            if (typeof XMLHttpRequest !== 'undefined' && XMLHttpRequest.prototype) {
                var rawOpen = XMLHttpRequest.prototype.open;
                var rawSend = XMLHttpRequest.prototype.send;

                XMLHttpRequest.prototype.open = function (method, url) {
                    try { this.__bosUrl = String(url); } catch (e) { /* 忽略 */ }
                    if (cfg.log) log('xhr open', method, url);
                    return rawOpen.apply(this, arguments);
                };

                XMLHttpRequest.prototype.send = function () {
                    try {
                        if (this.__bosUrl && !this.__bosHook) {
                            this.__bosHook = true;
                            this.addEventListener('load', function () {
                                onNetDone(this.status, this.__bosUrl);
                            });
                        }
                    } catch (e) { /* 忽略 */ }
                    return rawSend.apply(this, arguments);
                };
            }

            if (typeof window !== 'undefined' && typeof window.fetch === 'function') {
                var rawFetch = window.fetch;
                window.fetch = function (input) {
                    var url = (typeof input === 'string') ? input : ((input && input.url) || '');
                    if (cfg.log) log('fetch', url);
                    var p = rawFetch.apply(this, arguments);
                    try {
                        if (p && typeof p.then === 'function') {
                            p.then(function (res) { onNetDone(res && res.status, url); },
                                function () { /* 忽略失败请求 */ });
                        }
                    } catch (e) { /* 忽略 */ }
                    return p;
                };
            }
        } catch (e) {
            log('网络探针安装失败', e);
        }
    }

    /* ==========================================================
     * 3. 存储层：GM_* 优先，localStorage 兜底，全程 try/catch
     * ========================================================== */
    var hasGM = (typeof GM_getValue === 'function') && (typeof GM_setValue === 'function');

    var Store = {
        get: function (key, fallback) {
            try {
                if (hasGM) {
                    var v = GM_getValue(PREFIX + key, null);
                    return (v === null || v === undefined) ? fallback : v;
                }
                var raw = localStorage.getItem(PREFIX + key);
                return raw === null ? fallback : JSON.parse(raw);
            } catch (e) {
                return fallback;
            }
        },
        set: function (key, value) {
            try {
                if (hasGM) { GM_setValue(PREFIX + key, value); return true; }
                localStorage.setItem(PREFIX + key, JSON.stringify(value));
                return true;
            } catch (e) {
                return false;
            }
        },
        remove: function (key) {
            try {
                if (hasGM && typeof GM_deleteValue === 'function') { GM_deleteValue(PREFIX + key); return; }
                localStorage.removeItem(PREFIX + key);
            } catch (e) { /* 忽略 */ }
        }
    };

    var Records = {
        all: function () { return Store.get('records', {}) || {}; },
        mark: function (id, status, reason, meta) {
            if (!id) return;
            var m = meta || {};
            var all = this.all();
            all[id] = {
                status: status,
                reason: reason || '',
                title: m.title || '',
                url: m.url || '',
                ts: Date.now()
            };
            var keys = Object.keys(all);
            if (keys.length > MAX_RECORDS) {
                keys.sort(function (a, b) { return (all[a].ts || 0) - (all[b].ts || 0); });
                keys.slice(0, keys.length - MAX_RECORDS).forEach(function (k) { delete all[k]; });
            }
            Store.set('records', all);
        },
        // 只把"确定不用再投"的状态放入排除集
        excludeSet: function () {
            var all = this.all();
            var set = {};
            Object.keys(all).forEach(function (id) {
                var s = all[id] && all[id].status;
                if (s === 'success' || s === 'already') set[id] = 1;
            });
            return set;
        }
    };

    var Quota = {
        state: function () {
            var s = Store.get('quota', null);
            var t = todayKey();
            if (!s || s.date !== t || typeof s.used !== 'number') return { date: t, used: 0 };
            return s;
        },
        used: function () { return this.state().used; },
        remaining: function () { return Math.max(0, CONFIG.dailyLimit - this.used()); },
        inc: function () {
            var s = this.state();
            s.used += 1;
            Store.set('quota', s);
            return s.used;
        }
    };

    // 主控 ↔ 执行器 的任务状态通道
    var Channel = {
        key: function (runId, id) { return 'task:' + runId + ':' + id; },
        report: function (runId, id, status, reason) {
            if (!runId || !id) return;
            Store.set(this.key(runId, id), { status: status, reason: reason || '', ts: Date.now() });
        },
        read: function (runId, id) {
            if (!runId || !id) return null;
            return Store.get(this.key(runId, id), null);
        },
        clear: function (runId, id) {
            if (!runId || !id) return;
            Store.remove(this.key(runId, id));
        }
    };

    // 全局刹车：任一页面触发风控或用户点停止，所有页面都收到
    var Control = {
        stop: function () { Store.set('control', { stop: true, ts: Date.now() }); },
        reset: function () { Store.set('control', { stop: false, ts: Date.now() }); },
        isStopped: function () {
            var c = Store.get('control', null);
            return !!(c && c.stop);
        }
    };

    /* ==========================================================
     * 4. 执行器：详情页状态机
     *    LOOK → CLICK(仅一次) → VERIFY → DONE/ALREADY/FAILED → CLOSE
     * ========================================================== */
    function findStartButton() {
        var scope = safeQuery(CONFIG.sel.btnContainer);
        return safeQuery(CONFIG.sel.startBtn, scope || document);
    }

    function isButtonDisabled(btn) {
        if (!btn) return true;
        if (btn.disabled) return true;
        var cls = typeof btn.className === 'string' ? btn.className : '';
        return /(^|\s)(disabled|disable)(\s|$)/.test(cls);
    }

    function detectRiskPage() {
        if (safeQuery(CONFIG.sel.risk)) return true;
        var title = (document.title || '');
        return title.indexOf('验证') !== -1;
    }

    function showToast(msg) {
        try {
            var t = document.createElement('div');
            t.textContent = msg;
            t.style.cssText = 'position:fixed;left:50%;top:16px;transform:translateX(-50%);' +
                'z-index:2147483001;padding:8px 14px;border-radius:8px;font-size:13px;' +
                'background:rgba(24,26,30,.94);color:#e8e8e8;border:1px solid rgba(255,255,255,.14);';
            (document.body || document.documentElement).appendChild(t);
            setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 4000);
        } catch (e) { /* 忽略 */ }
    }

    function runWorker() {
        var jobId = extractJobId(location.pathname) || extractJobId(location.href);
        if (!jobId) return;

        var run = Store.get('run', null);
        // 只处理本次任务队列里的职位；手动浏览的页面一律不介入
        if (!run || !run.id || !run.startedAt || (Date.now() - run.startedAt) > 30 * 60 * 1000) return;
        if (!run.ids || run.ids.indexOf(jobId) === -1) return;

        var runId = run.id;
        var startedAt = Date.now();
        var clicked = false;
        var clickedAt = 0;
        var done = false;
        var timer = null;

        function finish(status, reason) {
            if (done) return;
            done = true;
            if (timer) clearInterval(timer);       // 任何退出路径都必须清定时器
            timer = null;

            // 执行器只写通道与配额，历史记录由主控统一写（单写者）
            Channel.report(runId, jobId, status, reason);
            if (status === 'success') Quota.inc();

            // 留一点时间让状态写入完成，再关自己，避免中断飞行中的请求
            setTimeout(function () {
                if (window.opener) {
                    try { window.close(); return; } catch (e) { /* 落到提示 */ }
                }
                showToast(status === 'success' ? '沟通已发送，本页可关闭'
                    : '本页处理结束：' + status + (reason ? '（' + reason + '）' : ''));
            }, 400);
        }

        function tick() {
            try {
                if (done) return;
                if (Control.isStopped()) return finish('cancelled', '全局停止');
                if (Date.now() - startedAt > CONFIG.workerDeadlineMs) return finish('failed', '超时未完成');
                if (detectRiskPage()) {
                    Control.stop();
                    return finish('failed', '触发安全验证，已全局暂停');
                }

                var btn = findStartButton();

                // 阶段一：等待按钮出现，只点击一次
                if (!clicked) {
                    if (!btn) return;                      // 页面还没渲染完，继续等
                    var t0 = textOf(btn);
                    if (t0.indexOf('继续沟通') !== -1) return finish('already', '此前已沟通');
                    if (isButtonDisabled(btn)) return finish('failed', '按钮不可用：' + (t0 || '未知'));
                    clicked = true;                        // 先置位，杜绝重复点击
                    clickedAt = Date.now();
                    btn.click();
                    return;
                }

                // 阶段二：点击后只观察，不再触发任何点击
                if (Date.now() - clickedAt < CONFIG.minSettleMs) return;

                // 接口信号优先级最高（需在 CONFIG.network 中开启并配置 urlPattern）
                if (CONFIG.network.enabled && NET.ts >= clickedAt) {
                    return finish('success', '接口确认');
                }

                var dialog = safeQuery(CONFIG.sel.dialog);
                var t1 = textOf(findStartButton());
                if (dialog || t1.indexOf('继续沟通') !== -1 || t1.indexOf('已发送') !== -1) {
                    return finish('success', '页面信号确认');
                }
            } catch (e) {
                finish('failed', '异常：' + ((e && e.message) || e));
            }
        }

        timer = setInterval(tick, CONFIG.tickMs);
        tick();
    }

    /* ==========================================================
     * 5. 主控：列表页队列 + 并发池 + 翻页 + 面板
     * ========================================================== */
    function collectTasks(exclude, limit) {
        var cards = safeQueryAll(CONFIG.sel.listBox + ' ' + CONFIG.sel.card);
        var raw = [];
        cards.forEach(function (card) {
            var a = safeQuery(CONFIG.sel.jobLink, card);
            if (!a) return;
            var url = a.href || a.getAttribute('href') || '';
            var id = extractJobId(url);
            if (!id) return;
            raw.push({
                id: id,
                url: url,
                title: textOf(safeQuery(CONFIG.sel.jobTitle, card)),
                text: textOf(card)
            });
        });

        return pickTasks(raw, {
            exclude: exclude || {},
            keywords: CONFIG.keywords,
            skipText: CONFIG.skipCardText,
            limit: typeof limit === 'number' ? limit : CONFIG.maxTasksPerRun
        });
    }

    function firstCardId() {
        var cards = safeQueryAll(CONFIG.sel.listBox + ' ' + CONFIG.sel.card);
        for (var i = 0; i < cards.length; i++) {
            var a = safeQuery(CONFIG.sel.jobLink, cards[i]);
            var id = a && extractJobId(a.href || a.getAttribute('href') || '');
            if (id) return id;
        }
        return '';
    }

    function findNextPageButton() {
        var list = CONFIG.sel.nextPage || [];
        for (var i = 0; i < list.length; i++) {
            var el = safeQuery(list[i]);
            if (el && !isButtonDisabled(el)) return el;
        }
        return null;
    }

    function createPanel() {
        var mk = function (text, bg, color) {
            var b = document.createElement('button');
            b.type = 'button';
            b.textContent = text;
            b.style.cssText = 'flex:1;padding:7px 0;border:0;border-radius:6px;font-size:12px;' +
                'cursor:pointer;font-family:inherit;background:' + bg + ';color:' + color + ';';
            return b;
        };

        var box = document.createElement('div');
        box.id = 'bos-panel';
        box.style.cssText = 'position:fixed;left:12px;top:45%;z-index:2147483000;width:236px;' +
            'padding:10px 12px;border-radius:10px;box-sizing:border-box;' +
            'background:rgba(24,26,30,.94);color:#e8e8e8;' +
            'font:13px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;' +
            'border:1px solid rgba(255,255,255,.12);box-shadow:0 6px 20px rgba(0,0,0,.35);';

        var title = document.createElement('div');
        title.textContent = 'BOSS 批量沟通';
        title.style.cssText = 'font-weight:500;margin-bottom:2px;';

        var status = document.createElement('div');
        status.textContent = '就绪';
        status.style.cssText = 'color:#9aa0a6;font-size:12px;min-height:18px;';

        var info = document.createElement('div');
        info.textContent = '';
        info.style.cssText = 'color:#9aa0a6;font-size:12px;margin-bottom:8px;min-height:18px;';

        var row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:8px;margin-bottom:6px;';

        var row2 = document.createElement('div');
        row2.style.cssText = 'display:flex;gap:8px;';

        var startBtn = mk('开始', '#c62828', '#fff');
        var stopBtn = mk('停止', 'rgba(255,255,255,.14)', '#e8e8e8');
        var exportBtn = mk('导出记录', 'rgba(255,255,255,.08)', '#c9ccd1');

        row.appendChild(startBtn);
        row.appendChild(stopBtn);
        row2.appendChild(exportBtn);
        box.appendChild(title);
        box.appendChild(status);
        box.appendChild(info);
        box.appendChild(row);
        box.appendChild(row2);

        var api = {
            el: box,
            onStart: null,
            onStop: null,
            onExport: null,
            update: function (s, i) {
                if (typeof s === 'string') status.textContent = s;
                if (typeof i === 'string') info.textContent = i;
            },
            disable: function (flag) {
                startBtn.disabled = !!flag;
                startBtn.style.opacity = flag ? '.5' : '1';
                startBtn.style.cursor = flag ? 'default' : 'pointer';
            },
            mount: function () {
                if (document.getElementById('bos-panel')) return;
                (document.body || document.documentElement).appendChild(box);
                startBtn.addEventListener('click', function () { if (api.onStart) api.onStart(); });
                stopBtn.addEventListener('click', function () { if (api.onStop) api.onStop(); });
                exportBtn.addEventListener('click', function () { if (api.onExport) api.onExport(); });
            }
        };
        return api;
    }

    function runController() {
        var queue = [];
        var active = {};            // jobId -> { win, task, startedAt }
        var activeCount = 0;
        var planned = {};           // 本轮已入队过的 jobId，跨页去重的关键
        var running = false;
        var runId = '';
        var timer = null;
        var nextOpenAt = 0;
        var phase = 'idle';         // idle | working | turning
        var turn = null;            // { startedAt, before }
        var pagesTurned = 0;
        var stats = { success: 0, already: 0, failed: 0, cancelled: 0 };

        var ui = createPanel();
        ui.onStart = start;
        ui.onStop = stop;
        ui.onExport = function () {
            var ok = downloadCsv();
            ui.update(ok ? '记录已导出' : '导出失败（浏览器不支持 Blob）', '');
        };
        ui.mount();

        function plannedCount() { return Object.keys(planned).length; }

        function buildExclude() {
            var ex = Records.excludeSet();
            Object.keys(planned).forEach(function (id) { ex[id] = 1; });
            return ex;
        }

        function syncRunIds() {
            var run = Store.get('run', null);
            if (!run || run.id !== runId) return;
            run.ids = Object.keys(planned);
            Store.set('run', run);
        }

        function enqueue(tasks) {
            if (!tasks || !tasks.length) return 0;
            tasks.forEach(function (t) {
                queue.push(t);
                planned[t.id] = 1;
            });
            syncRunIds();               // 新页的任务必须进白名单，否则执行器不会动手
            return tasks.length;
        }

        function render() {
            ui.update(
                running
                    ? '运行中 · 并发 ' + activeCount + '/' + CONFIG.concurrency + ' · 队列 ' + queue.length +
                      (pagesTurned ? ' · 第 ' + (pagesTurned + 1) + ' 页' : '')
                    : '就绪 · 今日剩余配额 ' + Quota.remaining(),
                '成功 ' + stats.success + ' · 已沟通 ' + stats.already +
                ' · 失败 ' + stats.failed + ' · 上限 ' + CONFIG.dailyLimit
            );
            ui.disable(running);
        }

        function finishRun(note) {
            running = false;
            phase = 'idle';
            turn = null;
            if (timer) clearInterval(timer);
            timer = null;
            ui.update(note || '本轮完成',
                '成功 ' + stats.success + ' · 已沟通 ' + stats.already +
                ' · 失败 ' + stats.failed + (pagesTurned ? ' · 翻页 ' + pagesTurned : ''));
            ui.disable(false);
        }

        function start() {
            if (running) return;

            var remain = Quota.remaining();
            if (remain <= 0) {
                ui.update('今日配额已用完（上限 ' + CONFIG.dailyLimit + '）', '');
                return;
            }

            var tasks = collectTasks(Records.excludeSet(), Math.min(remain, CONFIG.maxTasksPerRun));
            if (!tasks.length && !CONFIG.pagination.enabled) {
                ui.update('没有可处理的职位', '可能已全部去重 / 被过滤');
                return;
            }

            queue = tasks.slice();
            planned = {};
            queue.forEach(function (t) { planned[t.id] = 1; });
            runId = 'r' + Date.now();
            stats = { success: 0, already: 0, failed: 0, cancelled: 0 };
            pagesTurned = 0;
            phase = 'working';
            turn = null;
            nextOpenAt = 0;
            running = true;

            Store.set('run', {
                id: runId,
                startedAt: Date.now(),
                ids: Object.keys(planned)   // 白名单：只有这些页面的执行器会动手
            });
            Control.reset();

            timer = setInterval(controllerTick, CONFIG.controllerTickMs);
            render();                          // 先渲染，避免覆盖 tick 内产生的异常提示

            // 首页没有可用任务时，直接尝试翻页（可能只是本页都投过了）
            if (!queue.length && !tryNextPage()) {
                finishRun('没有可处理的职位');
                return;
            }
            controllerTick();
        }

        function stop() {
            if (!running) return;
            running = false;
            phase = 'idle';
            turn = null;
            if (timer) clearInterval(timer);
            timer = null;
            Control.stop();                    // 通知所有执行器自杀
            queue = [];

            Object.keys(active).forEach(function (id) {
                var item = active[id];
                try { if (item.win && !item.win.closed) item.win.close(); } catch (e) { /* 忽略 */ }
            });
            active = {};
            activeCount = 0;
            ui.update('已停止', '成功 ' + stats.success + ' · 失败 ' + stats.failed);
            ui.disable(false);
        }

        function openNext() {
            if (!queue.length) return;
            var task = queue.shift();
            var win = null;
            try { win = window.open(task.url, '_blank'); } catch (e) { win = null; }

            if (!win) {                        // 被浏览器拦截：不吞错，直接停下并告知
                queue.unshift(task);
                running = false;
                phase = 'idle';
                if (timer) clearInterval(timer);
                timer = null;
                Control.stop();
                ui.update('新标签页被浏览器拦截', '请允许本站弹窗后重新点开始');
                ui.disable(false);
                log('window.open 返回空，判定为弹窗拦截');
                return;
            }

            active[task.id] = { win: win, task: task, startedAt: Date.now() };
            activeCount += 1;
            nextOpenAt = Date.now() + randGap();
        }

        function settle(id, status, reason) {
            var item = active[id];
            if (!item) return;
            delete active[id];
            activeCount = Math.max(0, activeCount - 1);
            stats[status] = (stats[status] || 0) + 1;
            Channel.clear(runId, id);
            // 单写者：这里带 task 元信息落记录，供导出复盘
            Records.mark(id, status, reason, { title: item.task.title, url: item.task.url });
            try { if (item.win && !item.win.closed) item.win.close(); } catch (e) { /* 忽略 */ }
            nextOpenAt = Date.now() + randGap();
        }

        function tryNextPage() {
            var p = CONFIG.pagination || {};
            if (!p.enabled) return false;
            if (pagesTurned >= (p.maxPages || 0)) return false;
            if (plannedCount() >= CONFIG.maxTasksPerRun) return false;
            if (Quota.remaining() <= 0) return false;

            var btn = findNextPageButton();
            if (!btn) return false;

            var before = firstCardId();
            try { btn.click(); } catch (e) { return false; }

            pagesTurned += 1;
            phase = 'turning';
            turn = { startedAt: Date.now(), before: before };
            ui.update('翻页中 · 第 ' + (pagesTurned + 1) + ' 页', '');
            return true;
        }

        function controllerTick() {
            if (!running) return;
            try {
                // 翻页等待：列表首条变化即视为刷新完成
                if (phase === 'turning') {
                    var nowId = firstCardId();
                    if (nowId && nowId !== turn.before) {
                        turn = null;
                        phase = 'working';
                        var cap = Math.min(Quota.remaining(), CONFIG.maxTasksPerRun - plannedCount());
                        enqueue(collectTasks(buildExclude(), cap));
                        nextOpenAt = 0;
                    } else if (Date.now() - turn.startedAt > (CONFIG.pagination.waitMs || 6000)) {
                        finishRun('翻页无变化，本轮结束');
                        return;
                    }
                    render();
                    return;
                }

                Object.keys(active).forEach(function (id) {
                    var item = active[id];
                    var rep = Channel.read(runId, id);
                    if (rep && rep.ts >= item.startedAt) {
                        settle(id, rep.status || 'failed', rep.reason);
                        return;
                    }
                    if (Date.now() - item.startedAt > CONFIG.taskTimeoutMs) {
                        settle(id, 'failed', '主控超时');
                    }
                });

                if (!running) return;          // settle 中可能已停机

                if (queue.length && activeCount < CONFIG.concurrency && Date.now() >= nextOpenAt) {
                    openNext();
                    if (!running) return;      // openNext 可能因弹窗拦截已停机
                }

                if (!queue.length && activeCount === 0) {
                    if (tryNextPage()) { render(); return; }
                    finishRun();
                    return;
                }

                render();
            } catch (e) {
                log('主控轮询异常', e);
            }
        }
    }

    /* ==========================================================
     * 6. 入口：按路由分流，不再在全站注入
     * ========================================================== */
    function bootstrap() {
        if (!document || !document.body) return;
        installNetworkProbe();

        var path = location.pathname;
        if (isDetailPath(path)) { runWorker(); return; }
        if (isListPath(path)) { runController(); }
    }

    // 便于单测：暴露纯函数与入口，不影响页面逻辑
    try {
        globalThis.__BOS__ = {
            CONFIG: CONFIG,
            extractJobId: extractJobId,
            pickTasks: pickTasks,
            randGap: randGap,
            isDetailPath: isDetailPath,
            isListPath: isListPath,
            recordsToCsv: recordsToCsv,
            csvCell: csvCell,
            firstCardId: firstCardId,
            findNextPageButton: findNextPageButton,
            runWorker: runWorker,
            runController: runController,
            _store: Store,
            _channel: Channel,
            _control: Control,
            _quota: Quota,
            _records: Records,
            _net: NET,
            _netDone: onNetDone
        };
    } catch (e) { /* 忽略 */ }

    if (typeof window !== 'undefined' && typeof document !== 'undefined' &&
        !globalThis.__BOS_NO_AUTOBOOT__) {
        bootstrap();
    }
})();
