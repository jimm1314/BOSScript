/**
 * 零依赖单测：只验证纯逻辑 + 用 DOM 桩仿真详情页状态机
 * 运行：node --test tests/
 */
const test = require('node:test');
const assert = require('node:assert');

/* ---------- 1. 运行前装好宿主环境（模拟油猴沙箱） ---------- */
const mem = new Map();
global.GM_getValue = (k, d) => (mem.has(k) ? mem.get(k) : d);
global.GM_setValue = (k, v) => { mem.set(k, v); };
global.GM_deleteValue = (k) => { mem.delete(k); };

globalThis.__BOS_NO_AUTOBOOT__ = true;

function mkEl(text) {
    return {
        innerText: text || '',
        textContent: text || '',
        className: '',
        disabled: false,
        clickCount: 0,
        parentNode: null,
        style: { cssText: '' },
        click() { this.clickCount += 1; },
        getAttribute() { return null; },
        querySelector(sel) { return dom.query(sel); },
        querySelectorAll() { return []; },
        appendChild(c) { c.parentNode = this; },
        removeChild() {},
        addEventListener() {}
    };
}

const dom = { query: () => null };
const windowStub = { opener: {}, closeCount: 0, close() { this.closeCount += 1; } };

global.location = { pathname: '/job_detail/abc123.html', href: 'https://www.zhipin.com/job_detail/abc123.html' };
global.window = windowStub;
global.document = {
    title: '',
    body: mkEl(''),
    documentElement: mkEl(''),
    querySelector(sel) { return dom.query(sel); },
    querySelectorAll() { return []; },
    getElementById() { return null; },
    createElement() { return mkEl(''); }
};

const BOS = require('../instant.js') && globalThis.__BOS__;

/* ---------- 2. 纯逻辑 ---------- */

test('extractJobId：兼容带参/不带参/非职位链接', () => {
    const f = BOS.extractJobId;
    assert.strictEqual(f('https://www.zhipin.com/job_detail/abc123.html'), 'abc123');
    assert.strictEqual(f('https://www.zhipin.com/job_detail/abc123.html?lid=9&securityId=x'), 'abc123');
    assert.strictEqual(f('https://www.zhipin.com/job_detail/abc-123_def.html#top'), 'abc-123_def');
    assert.strictEqual(f('https://www.zhipin.com/web/geek/job?query=前端'), '');
    assert.strictEqual(f(''), '');
    assert.strictEqual(f(null), '');
});

test('pickTasks：jobId 去重，保留首个', () => {
    const out = BOS.pickTasks([
        { id: 'a', title: '前端' },
        { id: 'a', title: '前端(重复卡位)' },
        { id: 'b', title: '后端' }
    ], {});
    assert.deepStrictEqual(out.map((t) => t.id), ['a', 'b']);
    assert.strictEqual(out[0].title, '前端');
});

test('pickTasks：排除历史已处理 + 跳过卡片文案 + 关键词白名单', () => {
    const tasks = [
        { id: 'a', title: '前端开发', text: '20-30K' },
        { id: 'b', title: '前端开发', text: '已投递' },
        { id: 'c', title: 'Java开发', text: '20-30K' },
        { id: 'd', title: 'React开发', text: '已沟通' }
    ];
    const out = BOS.pickTasks(tasks, {
        exclude: { d: 1 },
        keywords: ['前端', 'React'],
        skipText: ['已投递']
    });
    assert.deepStrictEqual(out.map((t) => t.id), ['a']);
});

test('pickTasks：limit 精确截断', () => {
    const tasks = Array.from({ length: 10 }, (_, i) => ({ id: 'j' + i }));
    assert.strictEqual(BOS.pickTasks(tasks, { limit: 3 }).length, 3);
    assert.strictEqual(BOS.pickTasks(tasks, { limit: 0 }).length, 0);
    assert.strictEqual(BOS.pickTasks(tasks, {}).length, 10);
});

test('randGap：落在 [min, max] 区间内', () => {
    for (let i = 0; i < 200; i++) {
        const g = BOS.randGap();
        assert.ok(g >= BOS.CONFIG.minGapMs && g <= BOS.CONFIG.maxGapMs, '越界: ' + g);
    }
});

test('路由：详情页与列表页互斥', () => {
    assert.ok(BOS.isDetailPath('/job_detail/abc.html'));
    assert.ok(!BOS.isDetailPath('/web/geek/job'));
    assert.ok(BOS.isListPath('/web/geek/job'));
    assert.ok(BOS.isListPath('/web/geek/job/'));
    assert.ok(!BOS.isListPath('/web/geek/job_detail/x'));
});

/* ---------- 3. 详情页状态机仿真 ---------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function seedRun() {
    mem.clear();
    BOS._store.set('control', { stop: false, ts: Date.now() });
    BOS._store.set('run', { id: 'run-1', startedAt: Date.now(), ids: ['abc123'] });
}
function report() { return BOS._store.get('task:run-1:abc123', null); }

test('状态机：按钮出现后才点击，且全流程只点一次', async () => {
    seedRun();
    windowStub.closeCount = 0;

    const btn = mkEl('立即沟通');
    const container = mkEl('');
    const dialog = mkEl('');
    let clicked = false;

    dom.query = (sel) => {
        if (sel === '.btn-container') return container;
        if (sel === '.btn-startchat') return btn;
        if (sel === '.dialog-container') return clicked ? dialog : null;
        return null;
    };
    btn.click = function () { this.clickCount += 1; clicked = true; this.innerText = '继续沟通'; };

    BOS.CONFIG.tickMs = 10;
    BOS.CONFIG.minSettleMs = 20;
    BOS.CONFIG.workerDeadlineMs = 2000;
    BOS.runWorker();

    await sleep(700);

    assert.strictEqual(btn.clickCount, 1, '点击次数必须恰好为 1');
    const rep = report();
    assert.ok(rep, '必须向主控回写状态');
    assert.strictEqual(rep.status, 'success');
    assert.strictEqual(windowStub.closeCount, 1, '成功后应关闭自身一次');
});

test('状态机：按钮一直不出现 → 到点超时，不点击、仍上报并关闭', async () => {
    seedRun();
    windowStub.closeCount = 0;
    dom.query = () => null;
    BOS.CONFIG.workerDeadlineMs = 120;

    BOS.runWorker();
    await sleep(700);

    const rep = report();
    assert.ok(rep);
    assert.strictEqual(rep.status, 'failed');
    assert.match(rep.reason, /超时/);
    assert.strictEqual(windowStub.closeCount, 1);
});

test('状态机：文案已是「继续沟通」→ 判定 already，不发起点击', async () => {
    seedRun();
    const btn = mkEl('继续沟通');
    dom.query = (sel) => (sel === '.btn-startchat' ? btn : null);
    BOS.CONFIG.workerDeadlineMs = 500;

    BOS.runWorker();
    await sleep(120);

    assert.strictEqual(btn.clickCount, 0);
    assert.strictEqual(report().status, 'already');
});

test('状态机：命中安全验证页 → 失败并拉全局刹车', async () => {
    seedRun();
    const risk = mkEl('');
    dom.query = (sel) => (sel.indexOf('geetest_panel') !== -1 ? risk : null);
    BOS.CONFIG.workerDeadlineMs = 500;

    BOS.runWorker();
    await sleep(120);

    assert.strictEqual(report().status, 'failed');
    assert.match(report().reason, /安全验证/);
    assert.strictEqual(BOS._control.isStopped(), true, '应写入全局停止标志');
});

test('状态机：全局停止标志存在时立即退出，不点击', async () => {
    seedRun();
    BOS._control.stop();
    const btn = mkEl('立即沟通');
    dom.query = (sel) => (sel === '.btn-startchat' ? btn : null);

    BOS.runWorker();
    await sleep(60);

    assert.strictEqual(btn.clickCount, 0);
    assert.strictEqual(report().status, 'cancelled');
});

test('状态机：不在本次任务白名单内的详情页不介入', async () => {
    seedRun();
    BOS._store.set('run', { id: 'run-1', startedAt: Date.now(), ids: ['other-job'] });
    const btn = mkEl('立即沟通');
    dom.query = (sel) => (sel === '.btn-startchat' ? btn : null);

    BOS.runWorker();
    await sleep(80);

    assert.strictEqual(btn.clickCount, 0, '手动浏览的职位不应被自动点击');
});

test('存储：配额按天累计并可重置', () => {
    mem.clear();
    assert.strictEqual(BOS._quota.remaining(), BOS.CONFIG.dailyLimit);
    BOS._quota.inc();
    BOS._quota.inc();
    assert.strictEqual(BOS._quota.used(), 2);
    assert.strictEqual(BOS._quota.remaining(), BOS.CONFIG.dailyLimit - 2);

    BOS._store.set('quota', { date: '2000-01-01', used: 99 });
    assert.strictEqual(BOS._quota.used(), 0, '跨天应自动归零');
});

test('CSV：表头、中文状态、逗号与引号转义', () => {
    const csv = BOS.recordsToCsv({
        j1: { status: 'success', reason: '页面信号确认', title: '前端,高级', url: 'https://x/1', ts: 1700000000000 },
        j2: { status: 'failed', reason: '超时', title: 'A"B', url: 'https://x/2', ts: 1700000001000 }
    });
    const lines = csv.split('\r\n');
    assert.strictEqual(lines.length, 3, '表头 + 2 条记录');
    assert.strictEqual(lines[0], 'jobId,职位,状态,原因,时间,链接');
    assert.ok(csv.indexOf('已沟通') === -1);
    assert.ok(lines[2].indexOf('成功') !== -1, '状态应转成中文');
    assert.ok(lines[1].indexOf('"A""B"') !== -1, '引号需双写转义');
    assert.ok(lines[2].indexOf('"前端,高级"') !== -1, '含逗号需包裹');
    assert.strictEqual(BOS.recordsToCsv({}).split('\r\n').length, 1, '空记录只输出表头');
});

test('接口信号：命中 pattern 且 2xx 才计成功', () => {
    const net = BOS._net;
    BOS.CONFIG.network.enabled = true;
    BOS.CONFIG.network.urlPattern = 'chat/start';
    net.hit = 0;
    net.ts = 0;

    BOS._netDone(200, 'https://www.zhipin.com/wapi/zpchat/chat/start');
    const okTs = net.ts;
    assert.ok(okTs > 0, '2xx + 命中 pattern 应记录');
    assert.strictEqual(net.hit, 1);

    BOS._netDone(500, 'https://www.zhipin.com/wapi/zpchat/chat/start');
    assert.strictEqual(net.ts, okTs, '5xx 不应计成功');

    BOS._netDone(200, 'https://www.zhipin.com/wapi/zpjob/list');
    assert.strictEqual(net.ts, okTs, '不匹配 pattern 不应计成功');

    BOS.CONFIG.network.urlPattern = '';
    BOS._netDone(200, 'https://www.zhipin.com/wapi/zpchat/chat/start');
    assert.strictEqual(net.ts, okTs, '未配置 pattern 时只记录不判定');

    BOS.CONFIG.network.enabled = false;
});

