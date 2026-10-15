'use strict';
/**
 * server.js — 本地 GitHub 上传器 的服务端（零第三方依赖）
 *
 * 只用 Node 内置模块，任何人 clone 下来 `node server.js` 就能跑，不需要 npm install。
 *
 * 安全边界：
 *  - 服务只监听 127.0.0.1，不对外暴露。
 *  - 访问令牌只存在于浏览器内存与请求头中，服务端不落盘、不记日志。
 *  - 文件系统访问全部经过 path guard，默认可用 --root 参数把范围收窄到某个目录。
 */

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const url = require('url');

const fsbrowse = require('./lib/fsbrowse');
const github = require('./lib/github');

/* ---------------------------- 启动参数 ---------------------------- */
function parseArgs(argv) {
  const opts = { port: 5178, host: '127.0.0.1', roots: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port' || arg === '-p') opts.port = Number(argv[++i]) || opts.port;
    else if (arg === '--host') opts.host = argv[++i] || opts.host;
    else if (arg === '--root') opts.roots.push(path.resolve(argv[++i]));
    else if (arg === '--help' || arg === '-h') opts.help = true;
  }
  return opts;
}

const ARGS = parseArgs(process.argv.slice(2));

if (ARGS.help) {
  console.log(`
本地 GitHub 上传器

用法:
  node server.js [选项]

选项:
  -p, --port <端口>   监听端口，默认 5178
      --host <地址>   监听地址，默认 127.0.0.1（仅本机，不建议改）
      --root <目录>   把可浏览的文件范围限制在该目录（可重复传入多个）
                      不传则允许浏览本机所有盘符
  -h, --help          显示本帮助
`);
  process.exit(0);
}

const guard = fsbrowse.createPathGuard(ARGS.roots);
const PUBLIC_DIR = path.join(__dirname, 'public');

/* ---------------------------- 工具函数 ---------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limitBytes = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** 从请求头取令牌；不使用 cookie/localStorage 落盘，降低泄露面 */
function tokenFrom(req, body) {
  return req.headers['x-github-token'] || (body && body.token) || '';
}

function errorResponse(res, err) {
  const status = err.status && Number.isInteger(err.status) ? err.status : 500;
  if (status >= 500) {
    console.error('[error]', err.message);
  }
  sendJson(res, status, {
    ok: false,
    error: err.message || '服务器内部错误',
    detail: err.detail || undefined,
  });
}

/* ---------------------------- 静态资源 ---------------------------- */

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';

  // 静态目录同样要做穿越防护
  const target = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!target.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { ok: false, error: '禁止访问' });
    return;
  }

  try {
    const stat = await fsp.stat(target);
    if (!stat.isFile()) throw new Error('not a file');
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(target).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}

/* ---------------------------- API 路由 ---------------------------- */

const routes = {
  /* ---- 健康检查 ---- */
  'GET /api/health': async () => ({
    ok: true,
    data: {
      service: 'github-web-uploader',
      node: process.version,
      platform: process.platform,
      restrictedRoots: ARGS.roots.length ? ARGS.roots : null,
      defaultIgnore: fsbrowse.DEFAULT_IGNORE,
      maxFileBytes: fsbrowse.MAX_FILE_BYTES,
    },
  }),

  /* ---- 文件系统浏览 ---- */
  'GET /api/fs/roots': async () => ({
    ok: true,
    data: { roots: await fsbrowse.listRoots(), shortcuts: fsbrowse.shortcuts() },
  }),

  'GET /api/fs/list': async (ctx) => {
    const target = ctx.query.path || (ARGS.roots[0] ?? path.parse(process.cwd()).root);
    return { ok: true, data: await fsbrowse.listDirectory(target, guard) };
  },

  'POST /api/fs/scan': async (ctx) => {
    const { path: target, ignore, maxFiles, maxDepth } = ctx.body || {};
    const result = await fsbrowse.scanTree(target, { ignore, maxFiles, maxDepth }, guard);
    return { ok: true, data: result };
  },

  /* ---- GitHub 账号与仓库 ---- */
  'POST /api/github/login': async (ctx) => {
    const token = tokenFrom(ctx.req, ctx.body);
    const viewer = await github.getViewer(token);
    return { ok: true, data: { viewer } };
  },

  'GET /api/github/repos': async (ctx) => {
    const token = tokenFrom(ctx.req, null);
    const repos = await github.listRepos(token, {
      page: Number(ctx.query.page) || 1,
      perPage: 100,
    });
    return { ok: true, data: { repos } };
  },

  'POST /api/github/repos': async (ctx) => {
    const token = tokenFrom(ctx.req, ctx.body);
    const { owner, name, privateRepo, description } = ctx.body || {};
    if (!name) throw new github.GithubError('请填写仓库名', 400);
    const repo = await github.createRepo(token, { name, privateRepo, description, owner });
    return { ok: true, data: { repo } };
  },

  'DELETE /api/github/repos': async (ctx) => {
    const token = tokenFrom(ctx.req, ctx.body);
    const { owner, repo } = ctx.body || {};
    await github.deleteRepo(token, owner, repo);
    return { ok: true, data: { deleted: `${owner}/${repo}` } };
  },

  'GET /api/github/commits': async (ctx) => {
    const token = tokenFrom(ctx.req, null);
    const { owner, repo, branch } = ctx.query;
    const commits = await github.listCommits(token, owner, repo, branch || 'main', 20);
    return { ok: true, data: { commits } };
  },

  /* ---- 设备码登录 ---- */
  'POST /api/github/device/start': async (ctx) => {
    const { clientId, scope } = ctx.body || {};
    if (!clientId) throw new github.GithubError('请先填写 OAuth App 的 Client ID', 400);
    return { ok: true, data: await github.startDeviceFlow(clientId, scope || 'repo') };
  },

  'POST /api/github/device/poll': async (ctx) => {
    const { clientId, deviceCode } = ctx.body || {};
    if (!clientId || !deviceCode) throw new github.GithubError('缺少 clientId 或 deviceCode', 400);
    return { ok: true, data: await github.pollDeviceFlow(clientId, deviceCode) };
  },
};

/* ---------------------------- 流式接口（上传 / 撤回） ---------------------------- */

/**
 * 上传与撤回耗时较长，用 NDJSON 流把中间进度推给前端。
 * 每行一个 JSON：{type:'progress'|'result'|'error', ...}
 */
async function handleStream(req, res, kind) {
  const body = await readBody(req, 32 * 1024 * 1024);
  const token = tokenFrom(req, body);

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
  });

  const write = (obj) => res.write(JSON.stringify(obj) + '\n');
  const onProgress = (p) => write({ type: 'progress', ...p });

  try {
    if (kind === 'upload') {
      const { owner, repo, branch, message, overwrite, root, files } = body;
      if (!owner || !repo) throw new github.GithubError('请选择目标仓库', 400);
      if (!Array.isArray(files) || !files.length) {
        throw new github.GithubError('请至少勾选一个文件', 400);
      }

      // 把「根目录 + 相对路径」还原成绝对路径，并逐个过安全闸门
      const baseDir = guard(root);
      const resolved = files.map((rel) => {
        const abs = guard(path.join(baseDir, rel));
        if (!fsbrowse.isInside(baseDir, abs)) {
          throw new fsbrowse.FsError(`文件不在所选项目目录内：${rel}`, 403);
        }
        return { relativePath: rel, absolutePath: abs };
      });

      // 先确认全部存在，避免传到一半才发现缺文件
      for (const item of resolved) {
        const st = await fsp.stat(item.absolutePath).catch(() => null);
        if (!st || !st.isFile()) {
          throw new fsbrowse.FsError(`文件不存在或不可读：${item.relativePath}`, 404);
        }
      }

      const result = await github.pushFiles({
        token,
        owner,
        repo,
        branch,
        files: resolved,
        message,
        overwrite: overwrite !== false,
        onProgress,
      });
      write({ type: 'result', ok: true, data: result });
    } else {
      const { owner, repo, branch, commitSha, mode } = body;
      if (!owner || !repo || !commitSha) {
        throw new github.GithubError('缺少 owner / repo / commitSha', 400);
      }
      const result = await github.revertUpload({
        token,
        owner,
        repo,
        branch,
        commitSha,
        mode: mode === 'force' ? 'force' : 'safe',
        onProgress,
      });
      write({ type: 'result', ok: true, data: result });
    }
  } catch (err) {
    write({
      type: 'error',
      ok: false,
      error: err.message || '操作失败',
      detail: err.detail || undefined,
    });
  } finally {
    res.end();
  }
}

/* ---------------------------- 服务器 ---------------------------- */

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const method = req.method.toUpperCase();

  // 只允许本机来源，避免被网页里的脚本跨站调用
  const originHost = (req.headers.host || '').split(':')[0];
  if (originHost && !['127.0.0.1', 'localhost', '::1'].includes(originHost)) {
    sendJson(res, 403, { ok: false, error: '仅允许本机访问' });
    return;
  }

  if (!pathname.startsWith('/api/')) {
    await serveStatic(req, res, pathname);
    return;
  }

  try {
    if (pathname === '/api/github/upload' && method === 'POST') {
      await handleStream(req, res, 'upload');
      return;
    }
    if (pathname === '/api/github/revert' && method === 'POST') {
      await handleStream(req, res, 'revert');
      return;
    }

    const key = `${method} ${pathname}`;
    const handler = routes[key];
    if (!handler) {
      sendJson(res, 404, { ok: false, error: `未知接口：${key}` });
      return;
    }

    const body =
      method === 'POST' || method === 'DELETE' || method === 'PATCH'
        ? await readBody(req)
        : null;

    const result = await handler({ req, body, query: parsed.query });
    sendJson(res, 200, result);
  } catch (err) {
    errorResponse(res, err);
  }
});

server.listen(ARGS.port, ARGS.host, () => {
  const banner = `
  ┌──────────────────────────────────────────────┐
  │   本地 GitHub 上传器 已启动              │
  └──────────────────────────────────────────────┘

  打开浏览器访问：  http://${ARGS.host}:${ARGS.port}
  可浏览范围：      ${ARGS.roots.length ? ARGS.roots.join(' , ') : '本机全部盘符'}
  Node 版本：       ${process.version}

  按 Ctrl+C 停止服务
`;
  console.log(banner);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${ARGS.port} 已被占用，请换一个：node server.js --port 5179`);
  } else {
    console.error('服务启动失败：', err.message);
  }
  process.exit(1);
});