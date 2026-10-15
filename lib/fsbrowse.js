'use strict';
/**
 * fsbrowse.js — 本地文件系统浏览与文件树扫描
 *
 * 设计要点：
 * 1. 所有路径都必须收敛到 allowedRoots（默认允许所有盘符根，可通过启动参数 --root 收窄），
 *    防止 API 被用来读取任意系统文件。
 * 2. 扫描时遵循 ignore 规则，默认跳过 .git / node_modules / 构建产物，避免把几万个文件
 *    塞进浏览器和 GitHub API（GitHub 单次 tree 提交也有体积限制）。
 * 3. 大文件用流式 SHA-1 计算，不整块读进内存。
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const os = require('os');

/** 单文件上传上限，超过 100MB GitHub 会拒收 */
const MAX_FILE_BYTES = 95 * 1024 * 1024;

/** 默认忽略规则，可被前端传参追加/覆盖 */
const DEFAULT_IGNORE = [
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '.next',
  '.nuxt',
  'dist',
  'build',
  'out',
  'target',
  '.venv',
  'venv',
  '__pycache__',
  '.DS_Store',
  'Thumbs.db',
  '.idea',
  '.vscode',
  '.workbuddy',
];

class FsError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
    this.name = 'FsError';
  }
}

/** 同步枚举本机存在的磁盘根，供默认放行范围使用 */
function allDriveRootsSync() {
  if (process.platform !== 'win32') return ['/'];
  const roots = [];
  for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    const drive = `${letter}:\\`;
    try {
      if (fs.existsSync(drive)) roots.push(drive);
    } catch {
      /* 忽略不可访问的盘符 */
    }
  }
  return roots;
}

/**
 * 判断 child 是否位于 parent 之内（含相等）。
 * 注意盘符根目录的坑：`F:\` 本身就以分隔符结尾，
 * 若直接拼 `root + path.sep` 会得到 `F:\\`，导致任何合法路径都匹配失败。
 */
function isInside(parent, child) {
  const p = path.resolve(parent);
  const c = path.resolve(child);
  if (p === c) return true;
  const withSep = p.endsWith(path.sep) ? p : p + path.sep;
  return c.startsWith(withSep);
}

/**
 * 路径安全闸门。任何来自前端的路径都要先过这里。
 * resolve 之后再比对前缀，能挡掉 ../../ 穿越与符号链接混淆的常见写法。
 *
 * 未显式传入 allowedRoots 时，放行本机全部磁盘根——这与界面里"可浏览所有盘符"
 * 的呈现保持一致；启动时用 --root 即可把范围收窄到指定目录。
 */
function createPathGuard(allowedRoots) {
  const roots = (allowedRoots && allowedRoots.length
    ? allowedRoots
    : allDriveRootsSync()
  ).map((r) => path.resolve(r));

  return function guard(inputPath) {
    if (!inputPath || typeof inputPath !== 'string') {
      throw new FsError('缺少 path 参数');
    }
    const resolved = path.resolve(inputPath);
    const ok = roots.some((root) => isInside(root, resolved));
    if (!ok) {
      throw new FsError(`路径不在允许访问的范围内：${resolved}`, 403);
    }
    return resolved;
  };
}

/** 列出所有可用的磁盘根（Windows 列盘符，类 Unix 列 /） */
async function listRoots() {
  if (process.platform !== 'win32') {
    return [{ name: '/', path: '/', kind: 'root' }];
  }
  const roots = [];
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  await Promise.all(
    letters.split('').map(async (letter) => {
      const drive = `${letter}:\\`;
      try {
        await fsp.access(drive);
        roots.push({ name: `${letter}:`, path: drive, kind: 'root' });
      } catch {
        /* 该盘符不存在，忽略 */
      }
    })
  );
  // 按盘符排序，保证结果稳定
  roots.sort((a, b) => a.name.localeCompare(b.name));
  return roots;
}

/** 常用快捷入口，让用户少点几次 */
function shortcuts() {
  const home = os.homedir();
  const candidates = [
    { name: '桌面', path: path.join(home, 'Desktop') },
    { name: '文档', path: path.join(home, 'Documents') },
    { name: '下载', path: path.join(home, 'Downloads') },
    { name: '用户目录', path: home },
  ];
  return candidates.filter((item) => {
    try {
      return fs.statSync(item.path).isDirectory();
    } catch {
      return false;
    }
  });
}

/** 列出一个目录的直接子项（为了速度，不递归） */
async function listDirectory(dirPath, guard) {
  const dir = guard(dirPath);
  let stat;
  try {
    stat = await fsp.stat(dir);
  } catch {
    throw new FsError(`目录不存在或无法访问：${dir}`, 404);
  }
  if (!stat.isDirectory()) {
    throw new FsError(`不是一个目录：${dir}`, 400);
  }

  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const items = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      // lstat 而非 stat：软链接单独标记，不跟随进入，避免环形引用
      const st = await fsp.lstat(full);
      const isLink = st.isSymbolicLink();
      items.push({
        name: entry.name,
        path: full,
        kind: isLink
          ? 'link'
          : st.isDirectory()
            ? 'dir'
            : 'file',
        size: st.isFile() ? st.size : 0,
        mtime: st.mtimeMs,
        tooLarge: st.isFile() && st.size > MAX_FILE_BYTES,
      });
    } catch {
      /* 权限不足的项直接跳过，不让单个文件拖垮整个列表 */
    }
  }

  const parent = path.dirname(dir);
  return {
    current: dir,
    parent: parent === dir ? null : parent,
    items: sortItems(items),
  };
}

/** 目录优先、其次按名称自然排序 */
function sortItems(items) {
  return items.sort((a, b) => {
    const rank = (k) => (k === 'dir' ? 0 : k === 'file' ? 1 : 2);
    if (rank(a.kind) !== rank(b.kind)) return rank(a.kind) - rank(b.kind);
    return a.name.localeCompare(b.name, 'zh-CN', { numeric: true });
  });
}

/**
 * 判断某个条目名是否命中忽略规则。
 * 支持三种写法：目录名(node_modules)、后缀(*.log)、精确文件名(.env.local)
 */
function createIgnoreMatcher(extra) {
  const patterns = [...DEFAULT_IGNORE, ...(extra || [])];
  const dirNames = new Set();
  const suffix = [];
  const exact = new Set();

  for (const raw of patterns) {
    const p = String(raw).trim();
    if (!p || p.startsWith('#')) continue;
    if (p.startsWith('*.')) suffix.push(p.slice(1).toLowerCase());
    else if (p.includes('*') || p.includes('/')) exact.add(p.toLowerCase());
    else {
      dirNames.add(p.toLowerCase());
      exact.add(p.toLowerCase());
    }
  }

  return function ignored(name, isDir) {
    const lower = name.toLowerCase();
    if (exact.has(lower)) return true;
    for (const s of suffix) {
      if (lower.endsWith(s)) return true;
    }
    // 未加通配符的名字，无论深浅一律忽略（node_modules 出现在任意层级都应跳过）
    if (dirNames.has(lower)) return true;
    return false;
  };
}

/**
 * 递归扫描成树。返回节点同时带 "勾选建议"：
 * includeSuggestion 为 true 的是常规源码文件，前端默认勾上。
 */
async function scanTree(rootPath, options, guard) {
  const root = guard(rootPath);
  const { maxFiles = 20000, maxDepth = 24, ignore = [] } = options || {};
  const ignored = createIgnoreMatcher(ignore);
  const counter = { files: 0, dirs: 0, bytes: 0, skipped: 0, oversize: 0 };

  let rootStat;
  try {
    rootStat = await fsp.stat(root);
  } catch {
    throw new FsError(`路径不存在：${root}`, 404);
  }

  async function walk(dir, depth) {
    const node = {
      name: depth === 0 ? path.basename(dir) || dir : path.basename(dir),
      path: dir,
      kind: 'dir',
      children: [],
    };
    counter.dirs += 1;

    if (depth >= maxDepth) {
      node.truncated = true;
      return node;
    }

    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      node.error = '无法读取该目录（权限不足）';
      return node;
    }

    const dirTasks = [];
    for (const entry of entries) {
      if (ignored(entry.name, entry.isDirectory())) {
        counter.skipped += 1;
        continue;
      }
      if (counter.files >= maxFiles) {
        node.truncated = true;
        break;
      }
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        dirTasks.push(walk(full, depth + 1));
      } else if (entry.isFile()) {
        let st;
        try {
          st = await fsp.lstat(full);
        } catch {
          continue;
        }
        const oversized = st.size > MAX_FILE_BYTES;
        if (oversized) counter.oversize += 1;
        counter.files += 1;
        counter.bytes += st.size;
        node.children.push({
          name: entry.name,
          path: full,
          kind: 'file',
          size: st.size,
          mtime: st.mtimeMs,
          includeSuggestion: !oversized,
          tooLarge: oversized,
          // 二进制文件不内联预览，标记出来让前端显示不同图标
          binary: isLikelyBinary(entry.name),
        });
      }
      // 软链接一律不展开，避免环形目录把扫描拖死
    }

    const childDirs = await Promise.all(dirTasks);
    node.children.push(...childDirs);
    node.children = sortItems(node.children);
    return node;
  }

  const tree = await walk(root, 0);
  return {
    root: tree,
    stats: counter,
    limits: { maxFiles, maxDepth },
  };
}

/** 依据扩展名粗略判断是否二进制，仅用于界面提示 */
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.ico', '.svgz',
  '.mp3', '.mp4', '.mov', '.avi', '.mkv', '.wav', '.flac',
  '.zip', '.rar', '.7z', '.gz', '.tar', '.jar', '.exe', '.dll', '.so', '.dylib',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.woff', '.woff2', '.ttf', '.otf', '.eot', '.class', '.pyc', '.wasm',
]);

function isLikelyBinary(name) {
  return BINARY_EXT.has(path.extname(name).toLowerCase());
}

/** 流式计算 git blob 的 SHA-1（git 用的是 "blob <len>\0" + 内容） */
function gitBlobSha(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    let size = -1;
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('end', () => {
      hash.update('\0');
      resolve(hash.digest('hex'));
    });
    stream.once('open', () => {
      size = fs.statSync(filePath).size;
      hash.update(`blob ${size}`);
    });
    stream.on('data', (chunk) => hash.update(chunk));
  });
}

module.exports = {
  FsError,
  MAX_FILE_BYTES,
  DEFAULT_IGNORE,
  createPathGuard,
  isInside,
  listRoots,
  shortcuts,
  listDirectory,
  scanTree,
  gitBlobSha,
  isLikelyBinary,
};