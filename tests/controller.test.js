/**
 * 主控（列表页）仿真：验证并发池上限、任务回收后补位
 * 运行：node --test tests/controller.test.js
 */
const test = require('node:test');
const assert = require('node:assert');

/* ---------- 宿主环境桩 ---------- */
const mem = new Map();
global.GM_getValue = (k, d) => (mem.has(k) ? mem.get(k) : d);
global.GM_setValue = (k, v) => { mem.set(k, v); };
global.GM_deleteValue = (k) => { mem.delete(k); };
globalThis.__BOS_NO_AUTOBOOT__ = true;

const created = [];

function mkEl(text) {
    return {
        innerText: text || '',
        textContent: text || '',
        className: '',
        disabled: false,
        id: '',
        parentNode: null,
        style: {},
        _handlers: {},
        click() {},
        getAttribute() { return null; },
        appendChild(c) { c.parentNode = this; },
        removeChild() {},
        querySelector() { return null; },
        querySelectorAll() { return []; },
        addEventListener(evt, fn) { this._handlers[evt] = fn; }
    };
}

function mkCard(id) {
    const a = { href: 'https://www.zhipin.com/job_detail/' + id + '.html', getAttribute: () => null };
    const title = mkEl('职位' + id);
    return {
        innerText: '职位' + id + ' 20-30K',
        textContent: '职位' + id,
        querySelector(sel) {
            if (sel.indexOf('job_detail') !== -1) return a;
            if (sel === '.job-name') return title;
            return null;
        }
    };
}

const cards = ['a1', 'a2', 'a3', 'a4', 'a5'].map(mkCard);
const opened = [];

global.location = { pathname: '/web/geek/job', href: 'https://www.zhipin.com/web/geek/job' };
global.window = {
    opener: {},
    open(url) {
        opened.push(url);
        return { closed: false, close() { this.closed = true; } };
    }
};
global.document = {
    title: '',
    body: mkEl(''),
    documentElement: mkEl(''),
    querySelector() { return null; },
    querySelectorAll(sel) { return sel.indexOf('job-list-box') !== -1 ? cards : []; },
    getElementById() { return null; },
    createElement() { const el = mkEl(''); created.push(el); return el; }
};

const BOS = require('../instant.js') && globalThis.__BOS__;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const byText = (t) => created.find((e) => e.textContent === t);

test('并发池：同时打开的窗口不超过 concurrency，任务回收后自动补位', async () => {
    BOS.CONFIG.concurrency = 2;
    BOS.CONFIG.minGapMs = 10;
    BOS.CONFIG.maxGapMs = 20;
    BOS.CONFIG.controllerTickMs = 20;
    BOS.CONFIG.taskTimeoutMs = 5000;

    BOS.runController();
    const startBtn = byText('开始');
    assert.ok(startBtn, '面板应渲染出开始按钮');

    startBtn._handlers.click();
    await sleep(300);

    assert.strictEqual(opened.length, 2, '并发上限必须生效，不能一次性扇出 5 个');

    // 模拟第一个 worker 上报成功
    const run = BOS._store.get('run', null);
    assert.ok(run && run.id, '开始时应写入本次 runId');
    BOS._channel.report(run.id, 'a1', 'success', '沟通成功');

    await sleep(300);
    assert.strictEqual(opened.length, 3, '有任务回收后应补位开下一个');
    assert.ok(opened.every((u) => u.indexOf('/job_detail/') !== -1), '只允许打开详情页');

    // 清理：停机，避免定时器影响其它用例
    byText('停止')._handlers.click();
});
