#!/usr/bin/env node
'use strict';
/**
 * ui-shot.js — 用 Chrome DevTools Protocol 驱动真实浏览器做交互验证
 *
 * Node 22 自带全局 WebSocket，所以不需要 puppeteer 之类的依赖。
 *
 * 用法：
 *   1. 先启动服务：node server.js
 *   2. 另开终端：  node test/ui-shot.js
 *
 * 为了让结果稳定可复现，脚本会创建一个固定的测试项目夹具，而不是依赖用户桌面上的内容。
 *
 * 夹具刻意放在「中性路径」下（见 pickNeutralRoot），而不是项目目录里。
 * 原因：界面会把项目根路径原样渲染出来，而本脚本会截图——若夹具位于项目目录内，
 * 截图就会把使用者本机的真实路径（用户名、目录层级）永久画进图片。
 * 需要自定义位置时用 --demo-root <目录>，或环境变量 GWU_DEMO_ROOT。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const PORT = 9222;
const TARGET_URL = 'http://127.0.0.1:5178/';
const ROOT_DIR = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT_DIR, '.shots');
const PROFILE = path.join(os.tmpdir(), 'gwu-chrome-profile');

/**
 * 选一个「中性」的根目录放测试夹具。
 *
 * 为什么不能放在项目目录下：界面会把项目根路径完整显示出来，而本脚本要截图，
 * 于是 `D:\Users\你的名字\...\github-web-uploader` 这种路径就被画进图片了。
 * 放在盘符根目录下的固定名字（如 `D:\gwu-demo-<时间戳>`）不含任何个人信息，
 * 截图里只会看到 `D:\gwu-demo-...`。
 *
 * 优先级：命令行 --demo-root > 环境变量 > 盘符根目录 > 系统临时目录。
 */
function pickNeutralRoot() {
  const argv = process.argv.slice(2);
  const argIdx = argv.findIndex((a) => a === '--demo-root');
  if (argIdx >= 0 && argv[argIdx + 1]) return path.resolve(argv[argIdx + 1]);
  if (process.env.GWU_DEMO_ROOT) return path.resolve(process.env.GWU_DEMO_ROOT);

  if (process.platform === 'win32') {
    // 找一个可写的盘符，用固定的中性名字，避免写入用户目录
    for (const letter of 'CDEFGHIJ'.split('')) {
      const base = `${letter}:\\`;
      const candidate = path.join(base, `gwu-demo-${process.pid}`);
      try {
        fs.mkdirSync(candidate, { recursive: true });
        return candidate;
      } catch { /* 该盘不可写，试下一个 */ }
    }
  }
  // 兜底：系统临时目录（路径里通常也不含用户名，Linux 下为 /tmp）
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gwu-demo-'));
}

const TEST_PROJECT = path.join(pickNeutralRoot(), 'sample-project');

/**
 * 用于「截图脱敏」的路径识别正则（字符串形式，会注入到页面里执行）。
 *
 * 匹配两类内容：
 *  1) 盘符绝对路径，如 D:\a\b、D:/a/b
 *  2) 家目录风格路径，如 /home/xxx/、/Users/xxx/
 * 只要出现在页面上就整体替换为中性占位符，避免把使用者本机目录结构画进截图。
 */
const REAL_PATH_PATTERN_SOURCE =
  String.raw`[A-Za-z]:[\\/][^\s"'<>|]*|(?:/home/|/Users/|/root/)[^\s"'<>|]*`;

/** 构建一个内容可控的测试项目，保证扫描/勾选断言稳定 */
function prepareTestProject() {
  fs.rmSync(TEST_PROJECT, { recursive: true, force: true });
  fs.mkdirSync(path.join(TEST_PROJECT, 'src'), { recursive: true });
  fs.mkdirSync(path.join(TEST_PROJECT, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(TEST_PROJECT, 'node_modules', 'ignored'), { recursive: true });
  fs.writeFileSync(path.join(TEST_PROJECT, 'README.md'), '# Test Project\n');
  fs.writeFileSync(path.join(TEST_PROJECT, 'package.json'), '{"name":"uitest"}\n');
  fs.writeFileSync(path.join(TEST_PROJECT, 'src', 'index.js'), 'console.log("hi");\n');
  fs.writeFileSync(path.join(TEST_PROJECT, 'src', 'app.js'), 'export default {};\n');
  fs.writeFileSync(path.join(TEST_PROJECT, 'docs', 'guide.md'), '# Guide\n');
  // 应被默认忽略规则跳过的文件
  fs.writeFileSync(path.join(TEST_PROJECT, 'node_modules', 'ignored', 'x.js'), 'module.exports = 1;\n');

  // 统计"应当被扫描到"的文件数：排除 node_modules 下的内容
  const expected = [];
  (function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      if (name === 'node_modules') continue;
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else expected.push(path.relative(TEST_PROJECT, full).replace(/\\/g, '/'));
    }
  })(TEST_PROJECT);

  return { dir: TEST_PROJECT, expected, expectedCount: expected.length };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error('页面内异常：' + (d.exception && d.exception.description ? d.exception.description : JSON.stringify(d)));
    }
    return res.result.value;
  }

  async screenshot(name) {
    // 截图前先遮蔽页面上的真实路径，避免把使用者本机的目录结构画进图片。
    // 做法：把 DOM 里所有含真实路径的文本换成中性占位符，截完再还原。
    const restore = await this.maskRealPaths();
    const res = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT_DIR, name), Buffer.from(res.data, 'base64'));
    await restore();
    console.log(`  截图已保存：.shots/${name}`);
  }

  /**
   * 把页面上出现的真实路径替换成中性占位符，返回一个还原函数。
   *
   * 为什么必须做：界面会把项目根路径原样渲染（面包屑、已选目录、文件树根节点），
   * 一旦截图，`D:\Users\你的名字\...` 就被永久画进图片。文本扫描查不出图片里的字，
   * 所以在渲染层做遮蔽是最可靠的一道防线。
   */
  async maskRealPaths() {
    const token = 'UITEST-' + Date.now();
    await this.evaluate(`
      (() => {
        window.__maskToken = ${JSON.stringify(token)};
        window.__maskedNodes = [];
        const REAL = ${JSON.stringify(REAL_PATH_PATTERN_SOURCE)};
        const re = new RegExp(REAL, 'g');
        const PLACEHOLDER = 'D:\\\\\\\\sample-projects\\\\\\\\sample-project';

        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);

        for (const node of nodes) {
          const original = node.nodeValue;
          if (!original || !re.test(original)) { re.lastIndex = 0; continue; }
          re.lastIndex = 0;
          window.__maskedNodes.push({ node, original });
          node.nodeValue = original.replace(re, PLACEHOLDER);
        }

        // input/textarea 的 value 不属于文本节点，单独处理
        window.__maskedInputs = [];
        for (const el of document.querySelectorAll('input, textarea')) {
          const v = el.value;
          if (v && re.test(v)) {
            re.lastIndex = 0;
            window.__maskedInputs.push({ el, original: v });
            el.value = v.replace(re, PLACEHOLDER);
          }
          re.lastIndex = 0;
        }
        return true;
      })()
    `);

    return async () => {
      await this.evaluate(`
        (() => {
          for (const { node, original } of (window.__maskedNodes || [])) node.nodeValue = original;
          for (const { el, original } of (window.__maskedInputs || [])) el.value = original;
          window.__maskedNodes = [];
          window.__maskedInputs = [];
          return true;
        })()
      `);
    };
  }
}

async function waitForDevTools(retries = 60) {
  for (let i = 0; i < retries; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch { /* Chrome 还没起来 */ }
    await sleep(250);
  }
  throw new Error('无法连接 Chrome DevTools');
}

(async () => {
  let pass = 0;
  let fail = 0;
  const check = (name, ok, extra) => {
    if (ok) { pass += 1; console.log(`  ✓ ${name}${extra ? '  — ' + extra : ''}`); }
    else { fail += 1; console.log(`  ✗ ${name}${extra ? '  — ' + extra : ''}`); }
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const fixture = prepareTestProject();
  const project = fixture.dir;
  const EXPECTED = fixture.expectedCount;
  const chromePath = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!chromePath) {
    console.error('未找到 Chrome 或 Edge，无法进行交互验证');
    process.exit(1);
  }

  const chrome = spawn(chromePath, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--window-size=1240,1800',
    TARGET_URL,
  ], { stdio: 'ignore' });

  try {
    const page = await waitForDevTools();
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r, j) => {
      ws.addEventListener('open', r);
      ws.addEventListener('error', j);
    });

    const cdp = new CDP(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await sleep(1600);

    console.log('\n浏览器交互验证\n');

    /* ---------- 1. 初始状态 ---------- */
    console.log('[1] 页面初始状态');
    check('标题正确', (await cdp.evaluate('document.title')) === 'GitHub 上传器');
    check('渲染出 5 个步骤面板',
      (await cdp.evaluate("document.querySelectorAll('.panel').length")) === 5);
    check('未登录时后 3 步锁定（第 2 步浏览本地文件已解锁）',
      (await cdp.evaluate("document.querySelectorAll('.panel.locked').length")) === 3);
    check('浏览本地文件面板默认可用',
      (await cdp.evaluate("!document.querySelector('#panel-project').classList.contains('locked')")) === true);
    const ignoreCount = await cdp.evaluate("document.querySelector('#ignore-input').value.split('\\n').length");
    check('默认忽略规则已从服务端填充', ignoreCount > 5, `${ignoreCount} 条`);

    const lockHints = await cdp.evaluate(`
      [...document.querySelectorAll('.panel.locked h2[data-lock-hint]')]
        .map(h => getComputedStyle(h, '::after').content).filter(c => c && c !== 'none').length
    `);
    check('锁定面板显示了锁定原因提示（CSS 伪元素）', lockHints >= 2, `${lockHints} 处提示`);

    /* ---------- 2. 浏览弹窗 ---------- */
    console.log('\n[2] 文件夹浏览弹窗');
    await cdp.evaluate("document.querySelector('#btn-browse').click()");
    await sleep(1300);
    check('弹窗已打开',
      (await cdp.evaluate("!document.querySelector('#modal-folder').classList.contains('hidden')")) === true);
    check('渲染出快捷入口与盘符',
      (await cdp.evaluate("document.querySelectorAll('#shortcuts .chip').length")) > 3);

    // 直接定位到我们准备的测试项目目录
    await cdp.evaluate(`browseTo(${JSON.stringify(project)})`);
    await sleep(1200);
    const items = await cdp.evaluate("state.browsing.items.map(i => i.name + ':' + i.kind)");
    check('列出测试项目内容', items.length > 0, items.join(', '));
    check('能识别目录与文件',
      items.some((s) => s.endsWith(':dir')) && items.some((s) => s.endsWith(':file')));
    await cdp.screenshot('ui-02-folder-modal.png');

    /* ---------- 3. 目录导航 ---------- */
    console.log('\n[3] 目录导航');
    await cdp.evaluate(`
      (() => {
        const rows = [...document.querySelectorAll('#listing .listing-row')];
        const dirRow = rows.find(r => r.querySelector('.listing-icon').textContent === '📁');
        if (dirRow) dirRow.click();
        return !!dirRow;
      })()
    `);
    await sleep(900);
    const navPath = await cdp.evaluate('state.browsing.current');
    check('成功进入子目录（不再是项目根目录）',
      navPath !== project && navPath.startsWith(project),
      navPath.replace(project, '.'));

    // 回到测试项目根
    await cdp.evaluate(`browseTo(${JSON.stringify(project)})`);
    await sleep(800);

    /* ---------- 4. 选定并扫描 ---------- */
    console.log('\n[4] 选择项目目录并扫描文件树');
    await cdp.evaluate("document.querySelector('#pick-confirm').click()");
    await sleep(2400);

    check('项目根目录已记录', (await cdp.evaluate('state.projectRoot')) === project);
    const fileCount = await cdp.evaluate('state.fileIndex.size');
    check(`扫描到 ${EXPECTED} 个文件（node_modules 被忽略）`, fileCount === EXPECTED, `${fileCount} 个`);

    const hasIgnored = await cdp.evaluate(
      "[...state.fileIndex.keys()].some(k => k.includes('node_modules'))"
    );
    check('node_modules 内的文件确实未被收录', hasIgnored === false);

    check('文件树已渲染', (await cdp.evaluate("document.querySelectorAll('#tree-wrap .tree-row').length")) > 0);
    check('源码文件默认已勾选', (await cdp.evaluate('state.checked.size')) === EXPECTED, `${EXPECTED} 个`);
    const stats = await cdp.evaluate("document.querySelector('#scan-stats').textContent");
    check('统计条显示文件数与跳过项', /个文件/.test(stats) && /跳过/.test(stats), stats.slice(0, 70));

    /* ---------- 5. 勾选交互 ---------- */
    console.log('\n[5] 文件勾选与三态');
    await cdp.evaluate("document.querySelector('#btn-select-none').click()");
    await sleep(350);
    check('清空后勾选数为 0', (await cdp.evaluate('state.checked.size')) === 0);
    check('DOM 复选框同步为未勾选',
      (await cdp.evaluate(`
        [...document.querySelectorAll('#tree-wrap input[type=checkbox]')]
          .filter(b => !b.dataset.dirPath).every(b => !b.checked)
      `)) === true);

    await cdp.evaluate("document.querySelector('#btn-select-all').click()");
    await sleep(350);
    check(`全选后 ${EXPECTED} 个文件全部勾选`, (await cdp.evaluate('state.checked.size')) === EXPECTED);

    // 取消一个文件 -> 父目录应半选
    await cdp.evaluate(`
      (() => {
        const b = [...document.querySelectorAll('#tree-wrap input[type=checkbox]')].find(x => !x.dataset.dirPath);
        b.checked = false; b.dispatchEvent(new Event('change'));
      })()
    `);
    await sleep(400);
    check('取消单个文件后父目录呈现半选态',
      (await cdp.evaluate(`
        [...document.querySelectorAll('#tree-wrap input[data-dir-path]')].some(b => b.indeterminate)
      `)) === true);

    // 用目录复选框勾选子树（先恢复到全选，避免受上一步"取消单个文件"影响）
    await cdp.evaluate("document.querySelector('#btn-select-all').click()");
    await sleep(300);
    await cdp.evaluate(`
      (() => {
        const d = [...document.querySelectorAll('#tree-wrap input[data-dir-path]')]
          .find(b => b.dataset.dirPath.endsWith('src'));
        if (d) { d.checked = false; d.dispatchEvent(new Event('change')); }
      })()
    `);
    await sleep(400);
    const afterDirUncheck = await cdp.evaluate('state.checked.size');
    // 测试项目里 src 下有 2 个文件，取消 src 子树后应剩余 EXPECTED-2 个
    check('目录复选框可批量取消其子树', afterDirUncheck === EXPECTED - 2, `${afterDirUncheck} 个剩余`);

    await cdp.evaluate("document.querySelector('#btn-select-all').click()");
    await sleep(350);
    const summary = await cdp.evaluate(
      "document.querySelector('#selection-summary').textContent.replace(/\\s+/g,' ').trim()"
    );
    check('已选摘要正确', new RegExp(`已选\\s*${EXPECTED}\\s*个文件`).test(summary), summary);
    await cdp.screenshot('ui-03-tree.png');

    /* ---------- 6. 过滤 ---------- */
    console.log('\n[6] 文件名过滤');
    await cdp.evaluate(`
      (() => { const el = document.querySelector('#file-search'); el.value = 'app'; el.dispatchEvent(new Event('input')); })()
    `);
    await sleep(700);
    const marks = await cdp.evaluate("document.querySelectorAll('#tree-wrap mark').length");
    check('过滤命中并高亮关键词', marks > 0, `${marks} 处高亮`);
    const visibleFiles = await cdp.evaluate(
      "[...document.querySelectorAll('#tree-wrap .tree-row')].filter(r => r.querySelector('input:not([data-dir-path])')).length"
    );
    check('过滤后只显示匹配文件', visibleFiles < EXPECTED, `显示 ${visibleFiles} 个`);

    await cdp.evaluate(`
      (() => { const el = document.querySelector('#file-search'); el.value = ''; el.dispatchEvent(new Event('input')); })()
    `);
    await sleep(500);
    const restored = await cdp.evaluate(`
      [...document.querySelectorAll('#tree-wrap .tree-row')].filter(r => r.querySelector('input:not([data-dir-path])')).length
    `);
    check('清空过滤后文件全部恢复', restored === EXPECTED, `恢复 ${restored} 个`);

    /* ---------- 7. 上传前置条件 ---------- */
    console.log('\n[7] 上传前置条件');
    check('未登录时上传按钮禁用',
      (await cdp.evaluate("document.querySelector('#btn-upload').disabled")) === true);
    check('目标仓库面板仍未解锁（未登录）',
      (await cdp.evaluate("document.querySelector('#panel-target').classList.contains('locked')")) === true);
    check('历史面板仍未解锁（未登录）',
      (await cdp.evaluate("document.querySelector('#panel-history').classList.contains('locked')")) === true);

    /* ---------- 8. 折叠 ---------- */
    console.log('\n[8] 面板折叠');
    await cdp.evaluate("document.querySelector('.toggle-hint[data-toggle=\"files\"]').click()");
    await sleep(300);
    check('可折叠文件面板',
      (await cdp.evaluate("document.querySelector('[data-body=\"files\"]').classList.contains('collapsed')")) === true);
    check('折叠后提示文字变为“展开”',
      (await cdp.evaluate("document.querySelector('.toggle-hint[data-toggle=\"files\"]').textContent")) === '展开');
    await cdp.evaluate("document.querySelector('.toggle-hint[data-toggle=\"files\"]').click()");
    await sleep(300);

    /* ---------- 9. 无运行时错误 ---------- */
    console.log('\n[9] 运行时错误');
    check('页面无未捕获异常',
      (await cdp.evaluate('window.__errCount')) === 0);

    ws.close();
    console.log(`\n${'─'.repeat(52)}`);
    console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
    console.log(`${'─'.repeat(52)}\n`);
  } finally {
    chrome.kill();
    await sleep(400);
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* 忽略 */ }
    // 清掉中性目录下的夹具，别在盘符根目录留垃圾
    try { fs.rmSync(path.dirname(TEST_PROJECT), { recursive: true, force: true }); } catch { /* 忽略 */ }
  }

  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('\n交互验证异常：', err.message);
  process.exit(1);
});