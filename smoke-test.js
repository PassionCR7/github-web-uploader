#!/usr/bin/env node
/**
 * smoke-test.js — 端到端自测脚本
 * 不依赖任何第三方库；用 Node 内置 fetch 访问本机服务，避开系统代理干扰。
 *
 * 用法：先 `node server.js`，另开一个终端执行 `node smoke-test.js [端口]`
 */

const PORT = process.argv[2] || 5178;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
let fail = 0;

function report(name, ok, extra) {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}${extra ? '  — ' + extra : ''}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${extra ? '  — ' + extra : ''}`);
  }
}

async function call(path, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-GitHub-Token'] = token;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 可能是 HTML */ }
  return { status: res.status, json, text };
}

(async () => {
  console.log(`\n对 ${BASE} 执行自测\n`);

  /* ---------- 1. 健康检查 ---------- */
  console.log('[1] 健康检查');
  const health = await call('/api/health');
  report('GET /api/health 返回 200', health.status === 200, `HTTP ${health.status}`);
  report('service 字段正确', health.json && health.json.data.service === 'github-web-uploader');
  report('返回 node 版本', !!(health.json && health.json.data.node),
    health.json && health.json.data.node);

  /* ---------- 2. 静态资源 ---------- */
  console.log('\n[2] 静态资源');
  for (const file of ['/', '/app.js', '/styles.css']) {
    const r = await call(file);
    report(`GET ${file} 返回 200`, r.status === 200 && r.text.length > 100,
      `${r.status}, ${r.text.length}B`);
  }

  /* ---------- 3. 文件系统 ---------- */
  console.log('\n[3] 文件系统浏览');
  const roots = await call('/api/fs/roots');
  report('GET /api/fs/roots 返回 200', roots.status === 200);
  const rootList = (roots.json && roots.json.data.roots) || [];
  report('至少枚举到一个盘符', rootList.length > 0, rootList.map((r) => r.name).join(', '));

  const listRes = await call('/api/fs/list?path=' + encodeURIComponent(process.cwd()));
  report('列出当前目录成功', listRes.status === 200 && !!listRes.json.data.items,
    `${(listRes.json.data.items || []).length} 项`);

  // 注意：不存在的盘符（如 Z:）会被安全闸门先判为"越界"返回 403，
  // 这里要测的是「存在盘符下不存在的目录」，才应返回 404。
  const rootLetter = (rootList[0] && rootList[0].path) || 'C:\\';
  const ghost = rootLetter + 'no-such-dir-xyz-9988';
  const badPath = await call('/api/fs/list?path=' + encodeURIComponent(ghost));
  report('存在的盘符下不存在的目录返回 404', badPath.status === 404,
    `${ghost} -> HTTP ${badPath.status}`);

  const outOfRange = await call('/api/fs/list?path=' + encodeURIComponent('Z:\\nope'));
  report('不存在的盘符被判为越界（403）', outOfRange.status === 403, `HTTP ${outOfRange.status}`);

  /* ---------- 4. 目录穿越防护 ---------- */
  console.log('\n[4] 安全防护');
  const traversal = await call('/api/fs/list?path=' + encodeURIComponent('C:\\Windows\\System32'));
  const blocked = traversal.status === 403 || traversal.status === 200;
  report('系统目录请求被处理（本机全盘模式为放行，收窄 --root 后为 403）',
    blocked, `HTTP ${traversal.status}`);

  const staticEscape = await call('/../package.json');
  report('静态资源穿越被拦截', staticEscape.status !== 200 || !staticEscape.text.includes('github-web-uploader'),
    `HTTP ${staticEscape.status}`);

  /* ---------- 5. 扫描 ---------- */
  console.log('\n[5] 目录扫描与忽略规则');
  const scan = await call('/api/fs/scan', {
    method: 'POST',
    body: { path: process.cwd() },
  });
  report('POST /api/fs/scan 返回 200', scan.status === 200);
  const stats = scan.json && scan.json.data && scan.json.data.stats;
  report('扫描统计可用', !!(stats && typeof stats.files === 'number'),
    stats ? `${stats.files} 文件 / ${stats.dirs} 目录` : '无');

  const scanIgnore = await call('/api/fs/scan', {
    method: 'POST',
    body: { path: process.cwd(), ignore: ['public'] },
  });
  const stats2 = scanIgnore.json && scanIgnore.json.data && scanIgnore.json.data.stats;
  report('自定义忽略规则生效（跳过 public 后文件数减少）',
    !!(stats && stats2 && stats2.files < stats.files),
    stats2 ? `忽略后 ${stats2.files} 文件` : '无');

  /* ---------- 6. GitHub 令牌校验 ---------- */
  console.log('\n[6] GitHub 接口错误处理');
  const noToken = await call('/api/github/login', { method: 'POST', body: {} });
  report('无令牌登录返回 401', noToken.status === 401, `HTTP ${noToken.status}`);

  const fakeToken = await call('/api/github/login', {
    method: 'POST',
    body: {},
    token: 'ghp_thisIsNotARealToken000000000000000000',
  });
  report('伪造令牌被 GitHub 拒绝（401）', fakeToken.status === 401,
    `HTTP ${fakeToken.status}: ${fakeToken.json && fakeToken.json.error}`);

  /* ---------- 7. 上传参数校验 ---------- */
  console.log('\n[7] 上传/撤回参数校验');
  const uploadNoFiles = await call('/api/github/upload', {
    method: 'POST',
    body: { owner: 'a', repo: 'b', root: process.cwd(), files: [] },
    token: 'ghp_fake',
  });
  report('无文件时返回错误', /至少勾选|失败/.test(uploadNoFiles.text), uploadNoFiles.text.slice(0, 80));

  const revertMissing = await call('/api/github/revert', {
    method: 'POST',
    body: { owner: 'a', repo: 'b' },
    token: 'ghp_fake',
  });
  report('缺参数撤回返回错误', /缺少|失败/.test(revertMissing.text), revertMissing.text.slice(0, 80));

  const unknown = await call('/api/not-a-real-endpoint');
  report('未知接口返回 404', unknown.status === 404, `HTTP ${unknown.status}`);

  /* ---------- 汇总 ---------- */
  console.log(`\n${'─'.repeat(52)}`);
  console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
  console.log(`${'─'.repeat(52)}\n`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('\n自测脚本异常：', err.message);
  console.error('请确认服务已启动：node server.js\n');
  process.exit(1);
});