#!/usr/bin/env node
'use strict';
/**
 * github-mock-test.js — 用本地 mock 服务验证「上传 → 撤回」完整链路
 *
 * 为什么需要它：撤回是本工具最关键的承诺，但它依赖 Git Data API 的对象模型
 * （blob → tree → commit → ref）。没有真实令牌时，唯一能真正验证的办法就是
 * 在本地把 GitHub 的这套语义忠实模拟出来，然后跑真实的 pushFiles / revertUpload。
 *
 * 用法：node test/github-mock-test.js
 */

const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

let pass = 0;
let fail = 0;
function report(name, ok, extra) {
  if (ok) { pass += 1; console.log(`  ✓ ${name}${extra ? '  — ' + extra : ''}`); }
  else { fail += 1; console.log(`  ✗ ${name}${extra ? '  — ' + extra : ''}`); }
}

/* =====================================================================
   一个够用的假 GitHub：只实现 Git Data API 里我们用到的部分
   ===================================================================== */

const db = {
  blobs: new Map(),      // sha -> content(base64)
  trees: new Map(),      // sha -> entries[]
  commits: new Map(),    // sha -> {sha, message, tree, parents}
  refs: new Map(),       // 'owner/repo/branch' -> sha
};

const sha = (prefix, payload) =>
  crypto.createHash('sha1').update(prefix + JSON.stringify(payload) + Date.now() + Math.random()).digest('hex');

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
  });
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

// 把 tree entries 展开成"路径 -> blob sha"的映射，用于断言文件是否真的在树里
function flatten(entries) {
  const map = {};
  for (const e of entries || []) map[e.path] = e.sha;
  return map;
}

async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean); // 例如 ['repos','o','r','git','blobs']
  const body = await readBody(req);

  // GET /repos/:o/:r
  if (parts[0] === 'repos' && parts.length === 3) {
    return json(res, 200, {
      full_name: `${parts[1]}/${parts[2]}`,
      name: parts[2],
      owner: { login: parts[1] },
      private: true,
      default_branch: 'main',
      html_url: `https://example.test/${parts[1]}/${parts[2]}`,
    });
  }

  // GET /repos/:o/:r/git/ref/heads/:branch
  if (parts[3] === 'git' && parts[4] === 'ref' && parts[5] === 'heads') {
    const branch = decodeURIComponent(parts.slice(6).join('/'));
    const refSha = db.refs.get(`${parts[1]}/${parts[2]}/${branch}`);
    if (!refSha) return json(res, 404, { message: 'Not Found' });
    return json(res, 200, { ref: `refs/heads/${branch}`, object: { sha: refSha, type: 'commit' } });
  }

  // POST /repos/:o/:r/git/refs  （创建分支）
  if (parts[3] === 'git' && parts[4] === 'refs' && req.method === 'POST') {
    const branch = body.ref.replace('refs/heads/', '');
    db.refs.set(`${parts[1]}/${parts[2]}/${branch}`, body.sha);
    return json(res, 201, { ref: body.ref, object: { sha: body.sha } });
  }

  // PATCH /repos/:o/:r/git/refs/heads/:branch  （移动分支）
  if (parts[3] === 'git' && parts[4] === 'refs' && parts[5] === 'heads' && req.method === 'PATCH') {
    const branch = decodeURIComponent(parts.slice(6).join('/'));
    const key = `${parts[1]}/${parts[2]}/${branch}`;
    if (!db.refs.has(key)) return json(res, 422, { message: 'Reference does not exist' });
    db.refs.set(key, body.sha);
    return json(res, 200, { ref: `refs/heads/${branch}`, object: { sha: body.sha } });
  }

  // POST /repos/:o/:r/git/blobs
  if (parts[3] === 'git' && parts[4] === 'blobs' && req.method === 'POST') {
    if (body.encoding !== 'base64') return json(res, 422, { message: 'encoding must be base64' });
    const s = sha('blob', body.content);
    db.blobs.set(s, body.content);
    return json(res, 201, { sha: s });
  }

  // POST /repos/:o/:r/git/trees
  if (parts[3] === 'git' && parts[4] === 'trees' && req.method === 'POST') {
    let entries = [];
    if (body.base_tree) {
      // base_tree 语义：在原有条目上叠加，被点名的路径覆盖，未点名的保留
      entries = (db.trees.get(body.base_tree) || []).slice();
    }
    for (const e of body.tree || []) {
      if (e.sha === null) {
        entries = entries.filter((x) => x.path !== e.path); // 删除
      } else {
        const idx = entries.findIndex((x) => x.path === e.path);
        if (idx >= 0) entries[idx] = e;
        else entries.push(e);
      }
    }
    const s = sha('tree', entries);
    db.trees.set(s, entries);
    return json(res, 201, { sha: s });
  }

  // GET /repos/:o/:r/git/trees/:sha?recursive=1
  if (parts[3] === 'git' && parts[4] === 'trees' && req.method === 'GET') {
    const entries = db.trees.get(parts[5]);
    if (!entries) return json(res, 404, { message: 'Not Found' });
    return json(res, 200, {
      sha: parts[5],
      tree: entries.map((e) => ({ path: e.path, mode: e.mode, type: e.type, sha: e.sha })),
    });
  }

  // POST /repos/:o/:r/git/commits
  if (parts[3] === 'git' && parts[4] === 'commits' && req.method === 'POST') {
    if (!db.trees.has(body.tree)) return json(res, 422, { message: 'tree not found' });
    const s = sha('commit', { tree: body.tree, parents: body.parents });
    db.commits.set(s, { sha: s, message: body.message, tree: body.tree, parents: body.parents || [] });
    return json(res, 201, { sha: s, message: body.message, tree: { sha: body.tree }, parents: (body.parents || []).map((p) => ({ sha: p })) });
  }

  // GET /repos/:o/:r/git/commits/:sha
  if (parts[3] === 'git' && parts[4] === 'commits' && req.method === 'GET') {
    const c = db.commits.get(parts[5]);
    if (!c) return json(res, 404, { message: 'Not Found' });
    return json(res, 200, {
      sha: c.sha,
      message: c.message,
      tree: { sha: c.tree },
      parents: c.parents.map((p) => ({ sha: p })),
    });
  }

  // GET /repos/:o/:r/commits?sha=...
  if (parts[3] === 'commits' && req.method === 'GET') {
    const branch = url.searchParams.get('sha') || 'main';
    const head = db.refs.get(`${parts[1]}/${parts[2]}/${branch}`);
    const out = [];
    let cur = head;
    while (cur && out.length < 20) {
      const c = db.commits.get(cur);
      if (!c) break;
      out.push({
        sha: c.sha,
        commit: { message: c.message, author: { name: 'mock', date: new Date().toISOString() } },
        html_url: `https://example.test/commit/${c.sha}`,
        parents: c.parents.map((p) => ({ sha: p })),
      });
      cur = c.parents[0];
    }
    return json(res, 200, out);
  }

  return json(res, 404, { message: `mock 未实现该路由: ${req.method} ${url.pathname}` });
}

/* =====================================================================
   测试主体
   ===================================================================== */

(async () => {
  // 准备一个临时项目目录，放几个待上传文件
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-agent-test-'));
  fs.writeFileSync(path.join(tmp, 'README.md'), '# Hello\n');
  fs.mkdirSync(path.join(tmp, 'src'));
  fs.writeFileSync(path.join(tmp, 'src', 'index.js'), 'console.log(1);\n');
  fs.writeFileSync(path.join(tmp, 'src', 'util.js'), 'export const x = 1;\n');

  const server = http.createServer((req, res) => {
    handler(req, res).catch((e) => json(res, 500, { message: e.message }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  // 让 github.js 指向 mock
  process.env.GITHUB_API_BASE = `http://127.0.0.1:${port}`;
  delete require.cache[require.resolve('../lib/github.js')];
  const github = require('../lib/github.js');

  const ctx = { token: 'mock-token', owner: 'demo', repo: 'proj' };
  const files = [
    { relativePath: 'README.md', absolutePath: path.join(tmp, 'README.md') },
    { relativePath: 'src/index.js', absolutePath: path.join(tmp, 'src', 'index.js') },
    { relativePath: 'src/util.js', absolutePath: path.join(tmp, 'src', 'util.js') },
  ];

  console.log('\n用本地 mock 验证上传与撤回链路\n');

  /* ---------- 1. 首次上传（空仓库） ---------- */
  console.log('[1] 首次上传到空仓库');
  const progressPhases = [];
  const up1 = await github.pushFiles({
    ...ctx,
    branch: 'main',
    files,
    message: 'init project',
    onProgress: (p) => progressPhases.push(p.phase),
  });

  report('返回提交 sha', !!up1.commitSha, up1.shortSha);
  report('识别为新建分支', up1.createdBranch === true);
  report('文件数正确', up1.fileCount === 3, `${up1.fileCount}`);
  report('进度事件依次为 blob/tree/commit/ref/done',
    ['blob', 'tree', 'commit', 'ref', 'done'].every((p) => progressPhases.includes(p)),
    progressPhases.join(' → '));

  const ref1 = db.refs.get('demo/proj/main');
  const tree1 = flatten(db.trees.get(db.commits.get(ref1).tree));
  report('三个文件都进入了 tree', Object.keys(tree1).length === 3,
    Object.keys(tree1).join(', '));
  report('路径使用正斜杠', Object.keys(tree1).includes('src/index.js'));
  report('README.md 内容正确',
    Buffer.from(db.blobs.get(tree1['README.md']), 'base64').toString() === '# Hello\n');

  /* ---------- 2. 增量上传第二个提交 ---------- */
  console.log('\n[2] 再上传一个新文件（验证 base_tree 增量叠加）');
  fs.writeFileSync(path.join(tmp, 'src', 'new.js'), 'export const y = 2;\n');
  const up2 = await github.pushFiles({
    ...ctx,
    branch: 'main',
    files: [{ relativePath: 'src/new.js', absolutePath: path.join(tmp, 'src', 'new.js') }],
    message: 'add new.js',
  });
  const tree2 = flatten(db.trees.get(db.commits.get(db.refs.get('demo/proj/main')).tree));
  report('新文件已加入', Object.keys(tree2).includes('src/new.js'));
  report('原有文件未被删除（base_tree 生效）',
    Object.keys(tree2).length === 4, `${Object.keys(tree2).length} 个文件`);
  report('父提交正确指向第一次上传', db.commits.get(up2.commitSha).parents[0] === up1.commitSha);

  /* ---------- 3. 覆盖保护 ---------- */
  console.log('\n[3] 不允许覆盖时应当中止');
  let conflictErr = null;
  try {
    await github.pushFiles({
      ...ctx,
      branch: 'main',
      files: [{ relativePath: 'README.md', absolutePath: path.join(tmp, 'README.md') }],
      message: 'should fail',
      overwrite: false,
    });
  } catch (e) { conflictErr = e; }
  report('同名文件被拦截（409）', !!conflictErr && conflictErr.status === 409,
    conflictErr ? conflictErr.status : '未报错');
  report('错误信息列出了冲突文件',
    !!conflictErr && /README\.md/.test(conflictErr.message));

  /* ---------- 4. 安全撤回 ---------- */
  console.log('\n[4] 安全撤回第二次上传');
  const headBeforeRevert = db.refs.get('demo/proj/main');
  const rev1 = await github.revertUpload({
    ...ctx,
    branch: 'main',
    commitSha: up2.commitSha,
    mode: 'safe',
  });
  const tree3 = flatten(db.trees.get(db.commits.get(db.refs.get('demo/proj/main')).tree));
  report('产生了新的撤销提交', db.refs.get('demo/proj/main') === rev1.newHeadSha && rev1.newHeadSha !== headBeforeRevert);
  report('撤回后 src/new.js 已从树中移除', !Object.keys(tree3).includes('src/new.js'));
  report('撤回后原有 3 个文件仍在', Object.keys(tree3).length === 3, `${Object.keys(tree3).length} 个文件`);
  report('撤销提交的父提交是撤回前的分支头',
    db.commits.get(rev1.newHeadSha).parents[0] === headBeforeRevert);
  report('历史保留（up2 提交对象依然存在）', db.commits.has(up2.commitSha));

  /* ---------- 5. 强制回退 ---------- */
  console.log('\n[5] 强制回退');
  const rev2 = await github.revertUpload({
    ...ctx,
    branch: 'main',
    commitSha: up2.commitSha,
    mode: 'force',
  });
  report('分支指针回到 up2 的父提交（即 up1）',
    db.refs.get('demo/proj/main') === up1.commitSha,
    `${rev2.shortSha}`);
  const tree4 = flatten(db.trees.get(db.commits.get(db.refs.get('demo/proj/main')).tree));
  report('强制回退后文件回到 3 个', Object.keys(tree4).length === 3);

  /* ---------- 6. 边界情形 ---------- */
  console.log('\n[6] 边界情形');
  let rootForceErr = null;
  try {
    await github.revertUpload({
      ...ctx,
      branch: 'main',
      commitSha: up1.commitSha,   // 根提交，没有父提交
      mode: 'force',
    });
  } catch (e) { rootForceErr = e; }
  report('对根提交强制回退被明确拒绝并给出建议',
    !!rootForceErr && /第一个提交|安全撤回/.test(rootForceErr.message));

  // 根提交的安全撤回：应退化为"删除这批文件"
  const rev3 = await github.revertUpload({
    ...ctx,
    branch: 'main',
    commitSha: up1.commitSha,
    mode: 'safe',
  });
  const tree5 = flatten(db.trees.get(db.commits.get(db.refs.get('demo/proj/main')).tree));
  report('根提交安全撤回后仓库变为空树', Object.keys(tree5).length === 0,
    `${Object.keys(tree5).length} 个文件`);

  /* ---------- 7. 提交历史读取 ---------- */
  console.log('\n[7] 读取提交历史（验证 force 撤回确实抹掉了历史）');
  const commits = await github.listCommits(ctx.token, ctx.owner, ctx.repo, 'main', 20);
  report('能读到提交列表', commits.length >= 2, `${commits.length} 条`);
  report('每条都带 shortSha 与父提交', commits.every((c) => c.shortSha && Array.isArray(c.parents)));

  // 关键对比：force 回退把 up2 与 rev1 从分支链上摘掉了，
  // 因此从分支头回溯不应再看到这两个提交。
  const reachable = new Set(commits.map((c) => c.sha));
  report('force 回退后 up2 已不可达（历史被抹掉）', !reachable.has(up2.commitSha));
  report('force 回退后 rev1 已不可达', !reachable.has(rev1.newHeadSha));
  report('但提交对象本身仍存在于仓库（未被物理删除）',
    db.commits.has(up2.commitSha) && db.commits.has(rev1.newHeadSha));

  /* ---------- 清理 ---------- */
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(`\n${'─'.repeat(52)}`);
  console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
  console.log(`${'─'.repeat(52)}\n`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('\n测试异常：', err);
  process.exit(1);
});