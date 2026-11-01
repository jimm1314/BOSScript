/**
 * 主控翻页仿真：验证自动翻页、跨页去重、白名单同步
 * 运行：node --test tests/pagination.test.js
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
    const title = mkEl('职位' + id);
    return {
        innerText: '职位' + id,
        textContent: '职位' + id,
        querySelector(sel) {
            if (sel.indexOf('job_detail') !== -1) return a;
            if (sel === '.job-name') return title;
            return null;
        }
    };
}

const page1 = ['a1', 'a2'].map(mkCard);
const page2 = ['b1', 'b2'].map(mkCard);
let cards = page1;

const nextBtn = {
    className: '',
    disabled: false,
    clickCount: 0,
    click() { this.clickCount += 1; cards = page2; }
};

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
    querySelector(sel) {
        if ((sel || '').indexOf('options-pages') !== -1 || (sel || '').indexOf('ui-icon-arrow-right') !== -1) return nextBtn;
        return null;
    },
    querySelectorAll(sel) { return sel.indexOf('job-list-box') !== -1 ? cards : []; },
    getElementById() { return null; },
    createElement() { const el = mkEl(''); created.push(el); return el; }
};

const BOS = require('../instant.js') && globalThis.__BOS__;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const byText = (t) => created.find((e) => e.textContent === t);

test('自动翻页：第 2 页任务入队，且同步进执行器白名单', async () => {
    BOS.CONFIG.concurrency = 1;
    BOS.CONFIG.minGapMs = 5;
    BOS.CONFIG.maxGapMs = 10;
    BOS.CONFIG.controllerTickMs = 20;
    BOS.CONFIG.taskTimeoutMs = 60;
    BOS.CONFIG.maxTasksPerRun = 10;
    BOS.CONFIG.pagination = { enabled: true, maxPages: 1, waitMs: 400 };

    BOS.runController();
    byText('开始')._handlers.click();

    await sleep(900);

    assert.strictEqual(nextBtn.clickCount, 1, '队列空且可翻页时应点一次下一页');
    assert.strictEqual(opened.length, 4, '两页共 4 个职位都应被处理');
    assert.ok(opened[2].indexOf('/job_detail/b1.html') !== -1, '第 3 个窗口应来自第 2 页');
    assert.ok(opened.every((u) => u.indexOf('/job_detail/') !== -1));

    const run = BOS._store.get('run', null);
    assert.ok(run, '应有本次 run 记录');
    assert.deepStrictEqual(run.ids.sort(), ['a1', 'a2', 'b1', 'b2'], '翻页后的任务必须进入白名单');

    // 结束后不应再有新的开窗
    const countAfter = opened.length;
    await sleep(200);
    assert.strictEqual(opened.length, countAfter, '结束后定时器必须停止');
});
