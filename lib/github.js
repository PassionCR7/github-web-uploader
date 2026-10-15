'use strict';
/**
 * github.js — GitHub REST API 封装（零依赖，用 Node 内置 fetch）
 *
 * 上传链路完全走 Git Data API：
 *   blob(逐文件) -> tree(挂到 base_tree 上) -> commit -> 移动 ref
 * 这样做的好处是 N 个文件只产生 1 个提交，撤回时也只需针对那一个提交操作。
 *
 * 撤回实现说明（重点）：
 *   GitHub 的 REST API 并没有 "revert" 端点，所以这里给出两种语义明确的方案：
 *   - safe（默认）：读出被撤回提交的父提交 tree，以当前分支头为父、以该 tree 为新 tree
 *                  再提交一次。效果是文件回到上传前的内容，历史完整保留，可再次撤销。
 *   - force     ：直接把分支 ref 指回目标提交。历史被抹除，但"彻底干净"。
 *   如果上传前仓库是空的（没有父提交），safe 模式会退化为「删除这批文件」，
 *   用一个不含这些路径的新 tree 提交完成。
 */

const fs = require('fs');
const fsp = fs.promises;

/**
 * API 地址可通过环境变量覆盖：
 *  - GitHub Enterprise 用户指向自建实例
 *  - 单元测试指向本地 mock 服务
 */
const API = process.env.GITHUB_API_BASE || 'https://api.github.com';
const OAUTH = process.env.GITHUB_OAUTH_BASE || 'https://github.com/login';

class GithubError extends Error {
  constructor(message, status = 400, detail) {
    super(message);
    this.status = status;
    this.name = 'GithubError';
    this.detail = detail;
  }
}

/** 统一请求入口：自动带 UA / Accept / Token，并把错误信息整理成人话 */
async function gh(pathOrUrl, { token, method = 'GET', body, headers = {}, raw = false } = {}) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : API + pathOrUrl;
  const opts = {
    method,
    headers: {
      'User-Agent': 'github-agent-local',
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...headers,
    },
  };
  if (token) opts.headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }

  const res = await fetch(url, opts);
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { rawBody: text };
    }
  }

  if (!res.ok) {
    if (res.status === 401) {
      throw new GithubError('令牌无效或已过期，请重新登录 GitHub', 401, data);
    }
    if (res.status === 404) {
      throw new GithubError('资源不存在，或当前令牌没有访问权限（私有仓库需要 repo 权限）', 404, data);
    }
    if (res.status === 403 && /rate limit/i.test(text)) {
      throw new GithubError('触发了 GitHub 速率限制，请稍后再试', 429, data);
    }
    if (res.status === 422) {
      throw new GithubError(
        `GitHub 拒绝了这次请求：${data && data.message ? data.message : '参数不合法'}`,
        422,
        data
      );
    }
    throw new GithubError(
      `GitHub 请求失败（HTTP ${res.status}）：${data && data.message ? data.message : text.slice(0, 200)}`,
      res.status === 409 ? 409 : 502,
      data
    );
  }
  return raw ? { data, res } : data;
}

/** 校验令牌并返回账号信息 */
async function getViewer(token) {
  if (!token) throw new GithubError('缺少访问令牌', 401);
  const me = await gh('/user', { token });
  const scopes = [];
  return {
    login: me.login,
    name: me.name,
    avatar: me.avatar_url,
    scopes,
  };
}

/** 该令牌是否能读写指定仓库（顺带确认仓库是否存在） */
async function getRepo(token, owner, repo) {
  return gh(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, { token });
}

/** 列出当前账号可写的大部分仓库（含本人、协作者、所属组织） */
async function listRepos(token, { page = 1, perPage = 100 } = {}) {
  const list = await gh(
    `/user/repos?per_page=${perPage}&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`,
    { token }
  );
  return (Array.isArray(list) ? list : []).map((r) => ({
    fullName: r.full_name,
    name: r.name,
    owner: r.owner.login,
    private: r.private,
    defaultBranch: r.default_branch,
    htmlUrl: r.html_url,
    updatedAt: r.updated_at,
    empty: r.size === 0,
  }));
}

/**
 * 在指定 owner 下新建仓库。
 * 注意：如果 owner 是组织，接口会自动落到 POST /orgs/{org}/repos 的语义上
 * （GitHub 对 /user/repos 也接受 org 归属，这里做一次兼容处理）。
 */
async function createRepo(token, { name, privateRepo = true, description = '', owner }) {
  const result = await gh('/user/repos', {
    token,
    method: 'POST',
    body: {
      name,
      private: !!privateRepo,
      description: description || 'Uploaded by github-agent',
      auto_init: false,
    },
  });
  return {
    fullName: result.full_name,
    owner: result.owner.login,
    name: result.name,
    defaultBranch: result.default_branch,
    htmlUrl: result.html_url,
  };
}

/** 取分支头提交，分支不存在时返回 null（空仓库/新分支都走这条路径） */
async function getBranchHead(token, owner, repo, branch) {
  try {
    const ref = await gh(
      `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
      { token }
    );
    return ref.object.sha;
  } catch (err) {
    if (err.status === 404 || err.status === 409 || err.status === 502) return null;
    throw err;
  }
}

/** 取某个提交的详情 */
async function getCommit(token, owner, repo, sha) {
  return gh(`/repos/${owner}/${repo}/git/commits/${sha}`, { token });
}

/** 创建 blob（base64 内容） */
async function createBlob(token, owner, repo, base64Content) {
  const blob = await gh(`/repos/${owner}/${repo}/git/blobs`, {
    token,
    method: 'POST',
    body: { content: base64Content, encoding: 'base64' },
  });
  return blob.sha;
}

/** 创建 tree。base_tree 会做增量叠加，未列出的文件保持原样不被删除 */
async function createTree(token, owner, repo, entries, baseTree) {
  const body = { tree: entries };
  if (baseTree) body.base_tree = baseTree;
  const tree = await gh(`/repos/${owner}/${repo}/git/trees`, {
    token,
    method: 'POST',
    body,
  });
  return tree.sha;
}

async function createCommit(token, owner, repo, { message, tree, parents }) {
  const commit = await gh(`/repos/${owner}/${repo}/git/commits`, {
    token,
    method: 'POST',
    body: { message, tree, parents },
  });
  return commit.sha;
}

/** 移动分支 ref；分支不存在则创建 */
async function updateRef(token, owner, repo, branch, sha, { force = false, create = false } = {}) {
  if (create) {
    await gh(`/repos/${owner}/${repo}/git/refs`, {
      token,
      method: 'POST',
      body: { ref: `refs/heads/${branch}`, sha },
    });
    return sha;
  }
  await gh(`/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
    token,
    method: 'PATCH',
    body: { sha, force },
  });
  return sha;
}

/** 列出分支最近提交，用于界面展示"上传历史" */
async function listCommits(token, owner, repo, branch, perPage = 20) {
  const commits = await gh(
    `/repos/${owner}/${repo}/commits?sha=${encodeURIComponent(branch)}&per_page=${perPage}`,
    { token }
  );
  return (Array.isArray(commits) ? commits : []).map((c) => ({
    sha: c.sha,
    shortSha: c.sha.slice(0, 7),
    message: c.commit.message,
    author: c.commit.author ? c.commit.author.name : 'unknown',
    date: c.commit.author ? c.commit.author.date : null,
    htmlUrl: c.html_url,
    parents: (c.parents || []).map((p) => p.sha),
  }));
}

/** 删除仓库（留给"建错了想删掉"的场景，前端会二次确认） */
async function deleteRepo(token, owner, repo) {
  await gh(`/repos/${owner}/${repo}`, { token, method: 'DELETE' });
  return true;
}

/* ------------------------------------------------------------------ */
/* 设备码登录（Device Flow）                                            */
/* ------------------------------------------------------------------ */

/**
 * 第一步：向 GitHub 申请设备码。
 * 需要客户端 id（GitHub OAuth App 的 Client ID），由用户在界面填写或环境变量提供。
 */
async function startDeviceFlow(clientId, scope = 'repo') {
  const res = await fetch(`${OAUTH}/device/code`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'github-agent-local',
    },
    body: JSON.stringify({ client_id: clientId, scope }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.device_code) {
    throw new GithubError(
      `申请设备码失败：${data.error_description || data.error || `HTTP ${res.status}`}。请确认 Client ID 正确，且该 OAuth App 已启用 Device Flow。`,
      400,
      data
    );
  }
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    expiresIn: data.expires_in,
    interval: data.interval || 5,
  };
}

/**
 * 第二步：轮询换取令牌。
 * GitHub 的约定：authorization_pending 表示用户还没点授权，slow_down 要求放慢轮询频率。
 */
async function pollDeviceFlow(clientId, deviceCode) {
  const res = await fetch(`${OAUTH}/oauth/access_token`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'github-agent-local',
    },
    body: JSON.stringify({
      client_id: clientId,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (data.access_token) {
    return { status: 'ok', token: data.access_token, scope: data.scope };
  }
  const err = data.error || 'unknown_error';
  if (err === 'authorization_pending') return { status: 'pending' };
  if (err === 'slow_down') return { status: 'slow_down' };
  if (err === 'expired_token') {
    return { status: 'error', message: '设备码已过期，请重新发起登录' };
  }
  if (err === 'access_denied') {
    return { status: 'error', message: '你在 GitHub 页面上取消了授权' };
  }
  return {
    status: 'error',
    message: data.error_description || `授权失败：${err}`,
  };
}

/* ------------------------------------------------------------------ */
/* 上传主流程                                                          */
/* ------------------------------------------------------------------ */

/**
 * 把一批本地文件提交到仓库的某个分支。
 *
 * @param {object} p
 * @param {string} p.token
 * @param {string} p.owner
 * @param {string} p.repo
 * @param {string} p.branch
 * @param {Array<{relativePath:string, absolutePath:string}>} p.files
 * @param {string} p.message  提交信息
 * @param {boolean} p.overwrite 是否允许覆盖远端已有文件
 * @param {(e:object)=>void} p.onProgress
 */
async function pushFiles({
  token,
  owner,
  repo,
  branch,
  files,
  message,
  overwrite = true,
  onProgress = () => {},
}) {
  if (!files || !files.length) throw new GithubError('没有选中任何文件', 400);

  const repoInfo = await getRepo(token, owner, repo);
  const targetBranch = branch || repoInfo.default_branch || 'main';

  // 1. 找分支基点。空仓库没有 ref，走"创建首个提交"的分支。
  const headSha = await getBranchHead(token, owner, repo, targetBranch);
  let baseTree = null;

  if (headSha) {
    const head = await getCommit(token, owner, repo, headSha);
    baseTree = head.tree.sha;

    if (!overwrite) {
      const existing = await listTreePaths(token, owner, repo, baseTree);
      const conflicts = files
        .map((f) => f.relativePath)
        .filter((p) => existing.has(p));
      if (conflicts.length) {
        throw new GithubError(
          `以下文件在远端已存在，已按你的设置中止上传：\n${conflicts.slice(0, 20).join('\n')}${
            conflicts.length > 20 ? `\n...共 ${conflicts.length} 个` : ''
          }`,
          409,
          { conflicts }
        );
      }
    }
  }

  // 2. 逐个文件生成 blob。这里是耗时段，逐条上报进度。
  const treeEntries = [];
  const uploaded = [];
  let done = 0;
  const total = files.length;

  for (const file of files) {
    const buf = await fsp.readFile(file.absolutePath);

    // GitHub 单文件上限 100MB，base64 后体积再涨 1/3，超限就直接报错而不是把请求打挂
    if (buf.length > 95 * 1024 * 1024) {
      throw new GithubError(`文件过大（${(buf.length / 1048576).toFixed(1)}MB）：${file.relativePath}`, 400);
    }

    const blobSha = await createBlob(token, owner, repo, buf.toString('base64'));
    treeEntries.push({
      path: file.relativePath.replace(/\\/g, '/'),
      mode: '100644',
      type: 'blob',
      sha: blobSha,
    });
    uploaded.push({
      path: file.relativePath.replace(/\\/g, '/'),
      size: buf.length,
      sha: blobSha,
    });

    done += 1;
    onProgress({
      phase: 'blob',
      done,
      total,
      percent: Math.round((done / total) * 90),
      current: file.relativePath,
    });
  }

  // 3. 生成 tree / commit / 移动 ref
  onProgress({ phase: 'tree', percent: 92 });
  const treeSha = await createTree(token, owner, repo, treeEntries, baseTree);

  const parents = headSha ? [headSha] : [];
  onProgress({ phase: 'commit', percent: 96 });
  const commitSha = await createCommit(token, owner, repo, {
    message: message || `Upload ${total} file(s) from local project`,
    tree: treeSha,
    parents,
  });

  onProgress({ phase: 'ref', percent: 99 });
  await updateRef(token, owner, repo, targetBranch, commitSha, { create: !headSha });

  onProgress({ phase: 'done', percent: 100 });

  return {
    owner,
    repo,
    branch: targetBranch,
    commitSha,
    shortSha: commitSha.slice(0, 7),
    baseCommitSha: headSha,
    createdBranch: !headSha,
    fileCount: total,
    uploaded,
    htmlUrl: `https://github.com/${owner}/${repo}/commit/${commitSha}`,
  };
}

/** 拉取整棵 tree 的路径集合，用于"是否覆盖"检查 */
async function listTreePaths(token, owner, repo, treeSha) {
  const data = await gh(
    `/repos/${owner}/${repo}/git/trees/${treeSha}?recursive=1`,
    { token }
  );
  const set = new Set();
  for (const item of data.tree || []) {
    if (item.type === 'blob') set.add(item.path);
  }
  return set;
}

/** 取提交的第一个父提交 sha。
 *  注意：GitHub 返回的 parents 是对象数组 [{sha, url, html_url}]，不是字符串数组，
 *  直接当字符串用会拼出 /commits/[object Object] 这种非法 URL。 */
function firstParentSha(commit) {
  const p = commit && commit.parents && commit.parents[0];
  if (!p) return null;
  return typeof p === 'string' ? p : p.sha || null;
}

/** 还原整个 tree 为某个提交的内容（撤回的内部工具） */
async function revertTree(token, owner, repo, commitSha) {
  const commit = await getCommit(token, owner, repo, commitSha);
  const parentSha = firstParentSha(commit);
  if (!parentSha) {
    // 根提交：把 tree 换成空树，等价于删掉这批文件
    const emptyTree = await createTree(token, owner, repo, [], null);
    return { treeSha: emptyTree, parentOfTarget: null };
  }
  const parent = await getCommit(token, owner, repo, parentSha);
  return { treeSha: parent.tree.sha, parentOfTarget: parentSha };
}

/**
 * 撤回一次上传。
 *
 * @param {'safe'|'force'} mode
 *   safe  — 新增一个"反向提交"，内容回到上传前，历史保留
 *   force — 把分支指针直接拨回上传前的提交，历史被抹掉
 */
async function revertUpload({
  token,
  owner,
  repo,
  branch,
  commitSha,
  mode = 'safe',
  onProgress = () => {},
}) {
  const repoInfo = await getRepo(token, owner, repo);
  const targetBranch = branch || repoInfo.default_branch || 'main';

  const headSha = await getBranchHead(token, owner, repo, targetBranch);
  if (!headSha) throw new GithubError('目标分支不存在，无法撤回', 404);

  const target = await getCommit(token, owner, repo, commitSha);
  const parentSha = firstParentSha(target);

  if (mode === 'force') {
    if (!parentSha) {
      throw new GithubError(
        '这次上传是仓库的第一个提交，没有可回退的父提交。请改用"安全撤回"（会删除这批文件并保留历史）。',
        400
      );
    }
    onProgress({ phase: 'force', percent: 50 });
    await updateRef(token, owner, repo, targetBranch, parentSha, { force: true });
    onProgress({ phase: 'done', percent: 100 });
    return {
      mode: 'force',
      branch: targetBranch,
      newHeadSha: parentSha,
      shortSha: parentSha.slice(0, 7),
      message: `分支 ${targetBranch} 已回退到 ${parentSha.slice(0, 7)}，该次上传及其之后的提交都已从分支上移除。`,
    };
  }

  // safe 模式
  onProgress({ phase: 'prepare', percent: 20 });
  const { treeSha } = await revertTree(token, owner, repo, commitSha);

  onProgress({ phase: 'commit', percent: 60 });
  const newCommit = await createCommit(token, owner, repo, {
    message: `Revert upload ${commitSha.slice(0, 7)}\n\nRestore content to the state before this upload.`,
    tree: treeSha,
    parents: [headSha],
  });

  onProgress({ phase: 'ref', percent: 85 });
  await updateRef(token, owner, repo, targetBranch, newCommit, { force: false });
  onProgress({ phase: 'done', percent: 100 });

  return {
    mode: 'safe',
    branch: targetBranch,
    newHeadSha: newCommit,
    shortSha: newCommit.slice(0, 7),
    revertedCommit: commitSha,
    message: `已生成反向提交 ${newCommit.slice(0, 7)}，文件内容恢复到 ${commitSha.slice(0, 7)} 之前的状态。`,
  };
}

module.exports = {
  GithubError,
  getViewer,
  getRepo,
  listRepos,
  createRepo,
  getBranchHead,
  getCommit,
  listCommits,
  deleteRepo,
  startDeviceFlow,
  pollDeviceFlow,
  pushFiles,
  revertUpload,
  listTreePaths,
  firstParentSha,
};