const fs = require('fs');
const path = require('path');
const webpack = require('webpack');
const src = path.resolve(__dirname, '../..');
const out = path.resolve(process.env.AUTOMA_TEST_OUTPUT || path.join(src, '../../output/optimization-fix-2026-10-14/browser'));
const executablePath = process.env.AUTOMA_TEST_BROWSER || path.resolve(src, '../../output/chromium90-test/chrome-mac/Chromium.app/Contents/MacOS/Chromium');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '/Users/siluhao/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
(async () => {
  fs.mkdirSync(out, { recursive: true });
  await new Promise((resolve, reject) => webpack({
    mode: 'development', devtool: false, context: src, entry: path.join(__dirname, 'entry.js'),
    output: { path: out, filename: 'dom-tests.js' },
    resolve: { alias: { '@': path.join(src, 'src'), 'webextension-polyfill': path.join(__dirname, 'browser-mock.js') } },
    plugins: [new webpack.DefinePlugin({ BROWSER_TYPE: JSON.stringify('chrome') })],
  }, (error, stats) => error || stats.hasErrors() ? reject(error || new Error(stats.toString('errors-only'))) : resolve()));
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  const results = [];
  try {
    const page = await browser.newPage();
    await page.goto('about:blank');
    await page.addScriptTag({ path: path.join(out, 'dom-tests.js') });
    results.push(...await page.evaluate(async () => {
      window.chrome = { dom: { openOrClosedShadowRoot: element => element.shadowRoot } };
      const { FindElement: F, handleSelector: select, utils, path: paths, findSelector, pressKey, conditions } = window.automaTest;
      const results = [];
      const check = async (name, expected, run) => {
        try { const actual = await run(); results.push({ name, expected, actual, passed: JSON.stringify(actual) === JSON.stringify(expected) }); }
        catch (error) { results.push({ name, error: error.message, passed: false }); }
      };
      document.body.innerHTML = '<input id="focus"><button id="one">One</button><button id="two">Two</button><div id="hidden" style="display:none"><button id="child">hidden</button></div><iframe id="frame"></iframe><div id="host"></div>';
      const host = document.getElementById('host'); host.attachShadow({ mode: 'open' }).innerHTML = '<button id="deep">Deep</button><input id="deep-input">';
      const frame = document.getElementById('frame');
      frame.contentDocument.body.innerHTML = '<section><button>Framed</button></section><div id="host"></div>';
      frame.contentDocument.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<button id="framed-deep">Child</button>';
      await check('CSS single', 'one', () => F.cssSelector({ selector: '#one' }).id);
      await check('XPath single', 'one', () => F.xpath({ selector: '//button[@id="one"]' }).id);
      await check('shadow scope stays in iframe', 'framed-deep', () => F.cssSelector({ selector: '#host >> button' }, frame.contentDocument).id);
      await check('shadow selection deduplicates roots and branches', ['deep'], () => F.cssSelector({ selector: '#host >> button, #host >> #deep', multiple: true }).map(el => el.id));
      await check('marked comma selector skips all previous matches', ['one', 'two'], async () => {
        const block = { id: 'a', data: { selector: '#one, #two', markEl: true } };
        return [(await select(block)).id, (await select(block)).id];
      });
      await check('quoted delimiters remain literal', ['[data-note="a|>b"]'], () => paths.splitSelectorPath('[data-note="a|>b"]', '|>'));
      await check('quoted shadow delimiter remains literal', 'one', () => {
        document.getElementById('one').setAttribute('data-note', 'a>>b');
        return F.cssSelector({ selector: '[data-note="a>>b"]' }).id;
      });
      await check('mixed legacy frame prefix and XPath resolves', 'Framed', () => F.xpath({ selector: '//section/button' }, window.automaTest.getDocumentCtx('#frame')).textContent);
      await check('invalid frame selector reaches callback', true, async () => {
        let caught = false;
        await select({ frameSelector: '[', data: { selector: 'button' } }, { onError() { caught = true; } });
        return caught;
      });
      await check('XPath quoted ID roundtrip', true, () => {
        const el = document.createElement('button'); el.id = 'both\'and"quotes'; document.body.append(el);
        return F.xpath({ selector: utils.generateXPath(el) }) === el;
      });
      await check('XPath no-ID iframe roundtrip', true, () => {
        const el = frame.contentDocument.querySelector('button'); return F.xpath({ selector: utils.generateXPath(el) }, frame.contentDocument) === el;
      });
      await check('shadow CSS generation roundtrip', true, () => {
        const el = host.shadowRoot.querySelector('button'); return F.cssSelector({ selector: findSelector(el) }) === el;
      });
      await check('loop max 1 marks exactly one target', 1, () => utils.generateLoopSelectors(document.querySelectorAll('button'), { max: 1, attrId: 'loop', frameSelector: '' }).length);
      await check('missing keyboard target never writes elsewhere', '', async () => {
        const focus = document.getElementById('focus'); focus.focus();
        try { await pressKey({ data: { selector: '#missing', keys: 'x' } }); } catch {}
        return focus.value;
      });
      await check('keyboard target inside iframe respects frame context', 'x', async () => {
        const input = frame.contentDocument.createElement('input'); input.id = 'input'; frame.contentDocument.body.append(input);
        await pressKey({ frameSelector: '#frame', data: { selector: '#input', keys: 'x' } }); return input.value;
      });
      await check('wait cancellation rejects', true, async () => {
        const controller = new AbortController();
        const result = select({ signal: controller.signal, data: { selector: '#never', waitForSelector: true, waitSelectorTimeout: 5000 } });
        controller.abort(); try { await result; return false; } catch { return true; }
      });
      await check('hidden ancestor is not visible', false, () => conditions({ type: 'element#visible', data: { selector: '#child' } }));
      await check('hidden ancestor is invisible', true, () => conditions({ type: 'element#invisible', data: { selector: '#child' } }));
      await check('offscreen rendered element remains visible', true, () => {
        document.getElementById('two').style.cssText = 'position:absolute;top:3000px';
        return conditions({ type: 'element#visible', data: { selector: '#two' } });
      });
      await check('offscreen rendered element is not invisible', false, () => conditions({ type: 'element#invisible', data: { selector: '#two' } }));
      await check('reopen selector sends lifecycle event', 1, () => {
        const root = document.createElement('div'); root.id = 'app-container'; root.className = 'automa-element-selector'; document.body.append(root);
        let count = 0; window.addEventListener('automa:open-element-selector', () => count++, { once: true });
        utils.elementSelectorInstance(); return count;
      });
      return results;
    }));
    const report = { browser: browser.version(), scope: 'real Chromium DOM, source modules, extension API stub', results };
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (results.some(item => !item.passed)) process.exitCode = 1;
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 2; });
