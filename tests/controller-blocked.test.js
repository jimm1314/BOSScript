/**
 * 主控（列表页）仿真：验证弹窗被拦截时的"显式失败"路径
 * 运行：node --test tests/controller-blocked.test.js
 */
const test = require('node:test');
const assert = require('node:assert');

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
    return {
        innerText: '职位' + id,
        textContent: '职位' + id,
        querySelector(sel) {
            if (sel.indexOf('job_detail') !== -1) return a;
            return null;
        }
    };
}

const cards = [mkCard('b1'), mkCard('b2')];

global.location = { pathname: '/web/geek/job', href: 'https://www.zhipin.com/web/geek/job' };
global.window = {
    opener: {},
    open() { return null; }          // 模拟浏览器拦截：window.open 返回 null
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

test('弹窗被拦截：立即停机并明确提示，不静默丢任务', async () => {
    BOS.CONFIG.controllerTickMs = 20;
    BOS.CONFIG.minGapMs = 10;
    BOS.CONFIG.maxGapMs = 20;

    BOS.runController();
    byText('开始')._handlers.click();
    await sleep(150);

    const statusEl = created.find((e) => e.textContent === '新标签页被浏览器拦截');
    assert.ok(statusEl, '界面必须给出"被拦截"的明确提示，而不是假装在跑');

    // 停机后不应再尝试开窗
    const before = created.filter((e) => e.textContent === '新标签页被浏览器拦截').length;
    await sleep(120);
    assert.strictEqual(BOS._control.isStopped(), true, '应写入全局停止标志，避免 worker 空转');
    assert.strictEqual(created.filter((e) => e.textContent === '新标签页被浏览器拦截').length, before);
});
