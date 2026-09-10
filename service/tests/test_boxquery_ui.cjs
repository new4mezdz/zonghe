/* Run with Node and Playwright on NODE_PATH. Optional: PYTHON, BROWSER_CHANNEL, UI_OUTPUT_DIR.
 * Renders the real Flask template and loads production scripts/styles. Only API responses
 * are controlled, so this never reads or changes the user's database or configuration.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {chromium} = require('playwright');

const repo = path.resolve(__dirname, '../..');
const output = process.env.UI_OUTPUT_DIR || path.join(repo, 'tmp/boxquery-compact');
const python = process.env.PYTHON || path.join(repo, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
const html = execFileSync(python, ['-I', '-c', [
    'from flask import Flask, render_template',
    'from pathlib import Path',
    'import sys',
    'app = Flask("boxquery_ui_test", template_folder=str(Path("service/templates").resolve()))',
    'with app.test_request_context():',
    '    sys.stdout.buffer.write(render_template("boxquery.html").encode("utf-8"))',
].join('\n')], {cwd: repo, encoding: 'utf8'});

const ids = [1, 2, 3, 4, 5, 6, 8];
const wheels = ids.map(id => ({id, min: 1, max: id === 1 ? 2 : id === 3 ? 8 : 6}));
const record = (box, options = {}) => ({
    index: 1, content: 'MH-03001', time: '2026-09-10 14:32:08.000', box_num: box,
    wheel_numbers: {'1': 1, '2': 3, '3': box, '4': 2, '5': 5, '6': 3, '8': 6}, ...options,
});
const found = matches => ({success: true, source: 'database', total_records: matches.length, matches, wheels});

(async () => {
    fs.mkdirSync(output, {recursive: true});
    const browser = await chromium.launch({headless: true, channel: process.env.BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined)});
    let passed = 0;
    try {
        const page = await browser.newPage({viewport: {width: 1400, height: 900}, reducedMotion: 'reduce'});
        const errors = [], requests = [];
        page.on('pageerror', error => errors.push(error.message));
        let response = found([]), respond = async () => response;
        await page.route('http://boxquery.test/**', async route => {
            const url = new URL(route.request().url());
            if (url.pathname === '/boxquery') return route.fulfill({contentType: 'text/html', body: html});
            if (url.pathname.startsWith('/static/')) {
                const file = path.join(repo, 'service', url.pathname);
                return route.fulfill({contentType: file.endsWith('.js') ? 'text/javascript' : 'text/css', body: fs.readFileSync(file)});
            }
            if (url.pathname === '/api/urldata/box_layout') return route.fulfill({json: {wheels}});
            if (url.pathname === '/api/urldata/box_query') {
                const payload = route.request().postDataJSON();
                requests.push(payload);
                const result = await respond(payload);
                return route.fulfill({json: result});
            }
            return route.fulfill({status: 404, body: 'Not found'});
        });
        const check = async (name, action) => {await action(); passed++; console.log('PASS: ' + name);};
        const text = selector => page.locator(selector).textContent();
        const query = async (code = 'sample', enter = false) => {
            await page.locator('#qrcodeInput').fill(code);
            if (enter) await page.locator('#qrcodeInput').press('Enter');
            else await page.locator('#queryButton').click();
            await page.waitForFunction(() => !document.getElementById('queryButton').disabled && !document.getElementById('queryStatus').textContent.startsWith('正在'));
        };
        const clearHistory = () => page.locator('#clearHistoryButton').click();
        const selectedValues = () => page.locator('#matchBody tr.is-selected [data-wheel]').allTextContents();
        const noPageOverflow = async () => assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Page overflows horizontally');

        await page.goto('http://boxquery.test/boxquery');
        await page.waitForFunction(() => document.querySelectorAll('.mold-station').length > 0);
        await check('initial layout, navigation and empty comparison table', async () => {
            assert.equal(await page.locator('.wheel-group').count(), 7);
            assert.equal(await page.locator('[data-wheel="1"] .mold-station').count(), 2);
            assert.equal(await page.locator('thead th').count(), 10);
            assert.equal(await page.locator('#matchPanel').isVisible(), true);
            assert.match(await text('#matchBody'), /查询二维码/);
            assert.deepEqual(await page.locator('nav a').evaluateAll(links => links.map(a => a.getAttribute('href'))), ['/urldata', '/']);
            assert.equal(await page.locator('#lookbackHours').inputValue(), '24');
        });
        await check('Enter query, latest record and all seven real wheel values', async () => {
            response = found([record(4), record(1, {index: 2, time: '2026-09-10 14:20:00.000', wheel_numbers: {'1': 2, '2': 5, '3': 1, '4': 4, '5': 2, '6': 6, '8': 3}})]);
            await query('MH-03001', true);
            assert.deepEqual(requests.at(-1), {qrcode: 'MH-03001', lookback_hours: 24});
            assert.equal(await text('#locationStatus'), '7 / 7 轮已定位');
            assert.deepEqual(await selectedValues(), ['1', '3', '4', '2', '5', '3', '6']);
            assert.equal(await text('#historyCount'), '1 条');
            assert.equal(await text('#inspectionProgress'), '1 / 8');
            assert.equal(await page.locator('#inspectionMeter').evaluate(el => el.value), 1);
            assert.equal(await page.locator('#qrcodeInput').inputValue(), '');
            assert.equal(await page.locator('#qrcodeInput').evaluate(el => el === document.activeElement), true);
        });
        await check('table selection and history restore do not count as scans', async () => {
            const requestCount = requests.length;
            await page.locator('#matchBody .select-record').nth(1).click();
            assert.deepEqual(await selectedValues(), ['2', '5', '1', '4', '2', '6', '3']);
            assert.equal(await text('[data-wheel="3"] .wheel-number'), 'M-01');
            assert.equal(await text('#inspectionProgress'), '1 / 8');
            assert.equal(requests.length, requestCount);
            await page.locator('#matchBody .record-code').first().click();
            assert.equal(await text('[data-wheel="3"] .wheel-number'), 'M-04');
            await page.locator('#resetButton').click();
            assert.equal(await text('#selectedCode'), '尚未选择');
            assert.equal(await text('#inspectionProgress'), '1 / 8');
            assert.equal(await text('#historyCount'), '1 条');
            await page.locator('.history-choice').first().click();
            assert.equal(await text('#selectedCode'), 'MH-03001');
            assert.equal(await text('#inspectionProgress'), '1 / 8');
        });
        await check('remote range choices, unknown wheels and verification warning', async () => {
            for (const hours of [2, 24, 168]) {
                await page.locator('#lookbackHours').selectOption(String(hours));
                response = {...found([record(6, {wheel_numbers: {'3': 6}})]), source: 'influxdb', lookback_hours: hours};
                await query('remote');
                assert.equal(requests.at(-1).lookback_hours, hours);
                assert.deepEqual(await selectedValues(), ['—', '—', '6', '—', '—', '—', '—']);
                assert.match(await text('#dataSource'), new RegExp(hours + '小时'));
                assert.match(await text('#locationStatus'), /1 \/ 7.*6 轮待确认/);
            }
            response = {...found([record(null, {wheel_numbers: {}})]), source: 'influxdb', lookback_hours: 168, warning: '读取校验数据库失败'};
            await query();
            assert.match(await text('#queryStatus'), /读取校验数据库失败/);
            assert.deepEqual(await selectedValues(), Array(7).fill('—'));
        });
        await check('empty, failed and malformed responses clear stale results', async () => {
            response = {...found([]), source: 'influxdb', lookback_hours: 168};
            await query();
            assert.match(await text('#queryStatus'), /168小时.*未找到/);
            assert.match(await text('#matchBody'), /没有匹配记录/);
            response = {success: false, error: '读取二维码数据库失败'};
            await query();
            assert.match(await text('#queryStatus'), /数据库失败/);
            assert.equal(await page.locator('#qrcodeInput').inputValue(), 'sample');
            assert.equal(await text('#selectedCode'), '尚未选择');
            response = {success: true, matches: [null]};
            await query();
            assert.match(await text('#queryStatus'), /数据格式不完整/);
        });
        await check('blank input and clear input', async () => {
            const count = requests.length;
            await page.locator('#qrcodeInput').fill('   ');
            await page.locator('#qrcodeInput').press('Enter');
            assert.match(await text('#queryStatus'), /请输入二维码/);
            assert.equal(requests.length, count);
            await page.locator('#clearInputButton').click();
            assert.equal(await page.locator('#qrcodeInput').inputValue(), '');
            assert.equal(await page.locator('#qrcodeInput').evaluate(el => el === document.activeElement), true);
        });
        await check('repeat scan counts, eight-box completion and history clearing', async () => {
            await clearHistory();
            response = found([record(1)]);
            await query(); await query();
            assert.equal(await text('.inspection-slot small'), '2');
            assert.equal(await text('#inspectionProgress'), '1 / 8');
            for (let box = 2; box <= 8; box++) {response = found([record(box)]); await query();}
            assert.match(await text('#queryStatus'), /已完成第 1 轮八盒检验/);
            assert.match(await text('#roundStatus'), /第 2 轮检验.*已完成 1 轮/);
            assert.equal(await text('#inspectionProgress'), '0 / 8');
            assert.equal(await page.locator('.history-choice').count(), 9);
            await page.locator('.history-choice').last().click();
            assert.equal(await text('#inspectionProgress'), '0 / 8');
            await clearHistory();
            assert.equal(await text('#historyCount'), '0 条');
            assert.equal(await text('#roundStatus'), '第 1 轮检验');
            assert.equal(await page.locator('.wheel-group[data-state="empty"]').count(), 7);
        });
        await check('cancelled request cannot overwrite a newer selection', async () => {
            response = found([record(2)]); await query('saved');
            let release;
            respond = () => new Promise(resolve => {release = resolve;});
            await page.locator('#qrcodeInput').fill('delayed');
            await page.locator('#queryButton').click();
            await page.waitForFunction(() => document.getElementById('queryButton').disabled);
            while (!release) await new Promise(resolve => setTimeout(resolve, 10));
            await page.locator('#resetButton').click();
            await page.locator('.history-choice').first().click();
            release(found([record(8, {content: 'late-response'})]));
            respond = async () => response;
            await page.waitForTimeout(150);
            assert.equal(await text('#selectedCode'), 'MH-03001');
            assert.equal(await text('[data-wheel="3"] .wheel-number'), 'M-02');
            assert.equal(await page.locator('.history-choice').count(), 1);
        });
        await check('text remains literal, large IDs and invalid ranges remain visible', async () => {
            const literal = '<img src=x onerror=alert(1)> & test';
            response = {...found([record(4, {content: literal, wheel_numbers: {'1': 1, '2': 1000, '3': 4, '4': 9999, '5': null, '6': 0, '8': 6}})]), wheels: wheels.map(w => w.id === 2 ? {...w, max: 1000} : w)};
            await query('special');
            assert.equal(await text('#selectedCode'), literal);
            assert.equal(await page.locator('#matchBody img, #historyList img').count(), 0);
            assert.equal(await text('#matchBody [data-wheel="2"]'), '1000');
            assert.equal(await page.locator('.wheel-group[data-wheel="4"]').getAttribute('data-state'), 'out-of-range');
            assert.equal(await page.locator('.wheel-group[data-wheel="5"]').getAttribute('data-state'), 'missing');
        });
        await check('desktop C layout and full-width wheel comparison', async () => {
            await clearHistory();
            for (let n = 4; n >= 1; n--) {
                const code = 'MH-0300' + n;
                response = found([record(n, {content: code})]);
                if (n === 1) response.matches.push(record(6, {index: 2, content: code, time: '2026-09-10 14:20:00.000', wheel_numbers: {'1': 2, '2': 5, '3': 6, '4': 4, '5': 2, '6': 6, '8': 3}}));
                await query(code);
            }
            await noPageOverflow();
            await page.mouse.move(0, 0);
            assert.equal(await page.locator('.button.primary').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(22, 118, 90)');
            const [sidebar, diagram, table] = await Promise.all(['.sidebar', '.main-content', '#matchPanel'].map(s => page.locator(s).boundingBox()));
            assert(Math.abs(table.x - sidebar.x) < 2);
            assert(table.width > diagram.width && table.y >= diagram.y + diagram.height);
            await page.screenshot({path: path.join(output, 'compact-desktop.png'), fullPage: true});
        });
        await check('narrow view keeps controls and scrollable table accessible', async () => {
            for (const width of [1000, 768, 390, 320]) {
                await page.setViewportSize({width, height: 900});
                await noPageOverflow();
                assert(await page.locator('#queryButton').isVisible());
                assert(await page.locator('#resetButton').isVisible());
                if (width < 760) {
                    assert(await page.locator('.table-scroll').evaluate(el => el.scrollWidth > el.clientWidth));
                    assert(await page.locator('.diagram-scroll').evaluate(el => el.scrollWidth > el.clientWidth));
                }
            }
            await page.setViewportSize({width: 390, height: 844});
            await page.locator('.table-scroll').evaluate(el => {el.scrollLeft = el.scrollWidth;});
            await page.locator('#matchBody .select-record').nth(1).click();
            assert.equal(await text('[data-wheel="3"] .wheel-number'), 'M-06');
            await page.locator('.table-scroll').evaluate(el => {el.scrollLeft = 0;});
            await page.screenshot({path: path.join(output, 'compact-mobile.png'), fullPage: true});
        });
        await check('normal animation and reduced-motion preference', async () => {
            await page.setViewportSize({width: 1400, height: 900});
            await page.emulateMedia({reducedMotion: 'no-preference'});
            await page.locator('#matchBody .select-record').first().click();
            await page.waitForFunction(() => document.querySelector('.wheel-group[data-state="moving"]'));
            await page.waitForFunction(() => document.getElementById('locationStatus').textContent === '7 / 7 轮已定位');
            await page.locator('#matchBody .select-record').nth(1).click();
            await page.emulateMedia({reducedMotion: 'reduce'});
            await page.waitForFunction(() => !document.querySelector('.wheel-group[data-state="moving"]'));
            assert.equal(await text('[data-wheel="3"] .wheel-number'), 'M-06');
        });
        assert.deepEqual(errors, []);
        console.log('All ' + passed + ' browser scenarios passed; no JavaScript errors. Screenshots: ' + output);
    } finally {await browser.close();}
})().catch(error => {console.error(error); process.exitCode = 1;});
