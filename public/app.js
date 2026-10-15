/* =====================================================================
   GitHub 上传器 — 前端逻辑
   纯原生 JS，无构建步骤。所有 GitHub 请求都由本机 Node 服务代理转发，
   令牌通过 X-GitHub-Token 请求头传递，只存在于内存（可选存 localStorage）。
   ===================================================================== */

'use strict';

/* 记录未捕获异常数量，便于自测脚本断言页面是否干净 */
window.__errCount = 0;
window.addEventListener('error', () => { window.__errCount += 1; });
window.addEventListener('unhandledrejection', () => { window.__errCount += 1; });

/* ---------------------------- 全局状态 ---------------------------- */

const state = {
  token: '',
  viewer: null,
  projectRoot: null,      // 已选项目根目录（绝对路径）
  scan: null,             // 扫描结果 { root, stats }
  checked: new Set(),     // 已勾选文件的相对路径
  fileIndex: new Map(),   // relativePath -> { size, absolutePath }
  repos: [],
  history: [],            // 本会话上传记录
  browsing: { current: '', items: [] },
  deviceTimer: null,
  uploading: false,
};

const LS_TOKEN_KEY = 'github-web-uploader.token';
const SS_HISTORY_KEY = 'github-web-uploader.history';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* ---------------------------- 通用工具 ---------------------------- */

function formatSize(bytes) {
  if (!bytes && bytes !== 0) return '—';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(2) + ' MB';
  return (bytes / 1073741824).toFixed(2) + ' GB';
}

function toast(message, type = 'info', duration = 3600) {
  const el = document.createElement('div');
  el.className = 'toast ' + (type || '');
  el.textContent = message;
  $('#toast-wrap').appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .25s';
    setTimeout(() => el.remove(), 260);
  }, duration);
}

function showAlert(sel, message, type = 'error') {
  const el = $(sel);
  if (!el) return;
  el.className = 'alert alert-' + type;
  el.textContent = message;
  el.classList.remove('hidden');
}

function hideAlert(sel) {
  const el = $(sel);
  if (el) el.classList.add('hidden');
}

/** 带令牌的统一请求封装 */
async function api(path, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const tk = token !== undefined ? token : state.token;
  if (tk) headers['X-GitHub-Token'] = tk;

  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  let payload = null;
  const text = await res.text();
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = null; }
  }

  if (!res.ok || (payload && payload.ok === false)) {
    const msg = (payload && payload.error) || `请求失败（HTTP ${res.status}）`;
    const err = new Error(msg);
    err.detail = payload && payload.detail;
    err.status = res.status;
    throw err;
  }
  return payload ? payload.data : null;
}

/** NDJSON 流式请求：边读边回调进度 */
async function apiStream(path, body, { onProgress } = {}) {
  const res = await fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Token': state.token,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    let msg = `请求失败（HTTP ${res.status}）`;
    try { msg = JSON.parse(text).error || msg; } catch { /* 忽略 */ }
    throw new Error(msg);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalResult = null;
  let streamError = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.type === 'progress') onProgress && onProgress(msg);
      else if (msg.type === 'result') finalResult = msg.data;
      else if (msg.type === 'error') streamError = msg.error;
    }
  }

  if (streamError) throw new Error(streamError);
  if (!finalResult) throw new Error('操作未返回结果，请重试');
  return finalResult;
}

/* ---------------------------- 面板折叠与解锁 ---------------------------- */

function unlockPanel(id) {
  const panel = $(id);
  if (panel) panel.classList.remove('locked');
}

function setupPanels() {
  $$('.toggle-hint').forEach((hint) => {
    hint.addEventListener('click', () => {
      const key = hint.dataset.toggle;
      const body = $(`[data-body="${key}"]`);
      if (!body) return;
      const collapsed = body.classList.toggle('collapsed');
      hint.textContent = collapsed ? '展开' : '收起';
    });
  });
}

/* ---------------------------- ① 登录 ---------------------------- */

function setupTabs() {
  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const name = tab.dataset.tab;
      $$('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      $$('.tabpane').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== name));
    });
  });
}

function setAccountUI(status, text) {
  const dot = $('#account-area .dot');
  dot.className = 'dot ' + (status === 'ok' ? 'dot-ok' : status === 'err' ? 'dot-err' : 'dot-idle');
  $('#account-area .account-text').textContent = text;
}

async function connectWithToken(token) {
  hideAlert('#auth-alert');
  try {
    const data = await api('/api/github/login', { method: 'POST', body: {}, token });
    state.token = token;
    state.viewer = data.viewer;
    setAccountUI('ok', `已登录：${data.viewer.login}`);
    showAlert('#auth-alert', `登录成功，欢迎 ${data.viewer.name || data.viewer.login}。`, 'success');

    if ($('#remember-token').checked) {
      try { localStorage.setItem(LS_TOKEN_KEY, token); } catch { /* 隐私模式可能禁用 */ }
    } else {
      try { localStorage.removeItem(LS_TOKEN_KEY); } catch { /* 忽略 */ }
    }

    unlockPanel('#panel-project');
    unlockPanel('#panel-target');   // 选目标仓库与上传都需要令牌，登录后才解锁
    $('#btn-load-history').disabled = false;
    await loadRepos();
    return true;
  } catch (err) {
    state.token = '';
    state.viewer = null;
    setAccountUI('err', '登录失败');
    showAlert('#auth-alert', err.message, 'error');
    return false;
  }
}

function setupAuth() {
  // 回填已记住的令牌
  try {
    const saved = localStorage.getItem(LS_TOKEN_KEY);
    if (saved) {
      $('#pat-input').value = saved;
      $('#remember-token').checked = true;
    }
  } catch { /* 忽略 */ }

  $('#pat-connect').addEventListener('click', async () => {
    const token = $('#pat-input').value.trim();
    if (!token) {
      showAlert('#auth-alert', '请先粘贴访问令牌', 'error');
      return;
    }
    const btn = $('#pat-connect');
    btn.disabled = true;
    btn.textContent = '连接中…';
    await connectWithToken(token);
    btn.disabled = false;
    btn.textContent = '连接';
  });

  $('#pat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#pat-connect').click();
  });

  // ---- 设备码登录 ----
  $('#device-start').addEventListener('click', async () => {
    const clientId = $('#client-id').value.trim();
    if (!clientId) {
      showAlert('#auth-alert', '请先填写 OAuth App 的 Client ID', 'error');
      return;
    }
    hideAlert('#auth-alert');
    try {
      const data = await api('/api/github/device/start', { method: 'POST', body: { clientId } });
      $('#device-box').classList.remove('hidden');
      $('#device-code').textContent = data.userCode;
      if (data.verificationUri) $('#device-link').href = data.verificationUri;
      $('#device-status').textContent = `等待授权中…（每 ${data.interval} 秒检查一次）`;
      pollDevice(clientId, data.deviceCode, data.interval);
    } catch (err) {
      showAlert('#auth-alert', err.message, 'error');
    }
  });

  $('#device-cancel').addEventListener('click', () => {
    clearInterval(state.deviceTimer);
    state.deviceTimer = null;
    $('#device-box').classList.add('hidden');
    $('#device-status').textContent = '';
  });
}

function pollDevice(clientId, deviceCode, intervalSeconds) {
  clearInterval(state.deviceTimer);
  let wait = intervalSeconds || 5;

  const tick = async () => {
    try {
      const data = await api('/api/github/device/poll', {
        method: 'POST',
        body: { clientId, deviceCode },
      });

      if (data.status === 'ok') {
        clearInterval(state.deviceTimer);
        state.deviceTimer = null;
        $('#device-status').textContent = '授权成功，正在获取账号信息…';
        // 设备码换来的令牌不写入 localStorage，属于临时授权
        $('#remember-token').checked = false;
        await connectWithToken(data.token);
        $('#device-box').classList.add('hidden');
        return;
      }
      if (data.status === 'slow_down') {
        wait += 5;
        clearInterval(state.deviceTimer);
        state.deviceTimer = setInterval(tick, wait * 1000);
        $('#device-status').textContent = `GitHub 要求放慢频率，改为每 ${wait} 秒检查一次…`;
        return;
      }
      if (data.status === 'error') {
        clearInterval(state.deviceTimer);
        state.deviceTimer = null;
        $('#device-status').textContent = '';
        showAlert('#auth-alert', data.message, 'error');
      }
      // pending 就继续等
    } catch (err) {
      clearInterval(state.deviceTimer);
      state.deviceTimer = null;
      showAlert('#auth-alert', err.message, 'error');
    }
  };

  state.deviceTimer = setInterval(tick, wait * 1000);
  tick();
}

/* ---------------------------- ② 文件夹浏览 ---------------------------- */

async function openFolderModal() {
  $('#modal-folder').classList.remove('hidden');
  await loadRoots();
}

async function loadRoots() {
  try {
    const data = await api('/api/fs/roots');
    const wrap = $('#shortcuts');
    wrap.innerHTML = '';
    data.shortcuts.forEach((s) => {
      const chip = document.createElement('button');
      chip.className = 'chip';
      chip.textContent = s.name;
      chip.title = s.path;
      chip.addEventListener('click', () => browseTo(s.path));
      wrap.appendChild(chip);
    });

    const rootsWrap = $('#shortcuts');
    data.roots.forEach((r) => {
      const chip = document.createElement('button');
      chip.className = 'chip';
      chip.textContent = r.name;
      chip.title = r.path;
      chip.addEventListener('click', () => browseTo(r.path));
      rootsWrap.appendChild(chip);
    });

    const start = (data.shortcuts[0] && data.shortcuts[0].path) ||
      (data.roots[0] && data.roots[0].path);
    if (start) await browseTo(start);
  } catch (err) {
    $('#listing').innerHTML = `<div class="listing-empty">读取失败：${escapeHtml(err.message)}</div>`;
  }
}

async function browseTo(dirPath) {
  try {
    const data = await api('/api/fs/list?path=' + encodeURIComponent(dirPath));
    state.browsing = { current: data.current, items: data.items };
    renderCrumbs(data.current);
    renderListing(data.items);
    $('#pick-subfolder').checked = false;
  } catch (err) {
    $('#listing').innerHTML = `<div class="listing-empty">无法打开：${escapeHtml(err.message)}</div>`;
  }
}

function renderCrumbs(current) {
  const wrap = $('#crumbs');
  wrap.innerHTML = '';
  const isWin = /^[A-Za-z]:\\/.test(current);
  const sep = isWin ? '\\' : '/';

  // Windows: D:\a\b  ->  拆成 D: / a / b
  let parts;
  let prefix;
  if (isWin) {
    prefix = current.slice(0, 3);           // "D:\"
    parts = current.slice(3).split(/[\\/]/).filter(Boolean);
  } else {
    prefix = '/';
    parts = current.split('/').filter(Boolean);
  }

  const makeCrumb = (label, path, isCurrent) => {
    const el = document.createElement('span');
    el.className = isCurrent ? 'crumb-current' : 'crumb';
    el.textContent = label;
    if (!isCurrent) el.addEventListener('click', () => browseTo(path));
    return el;
  };

  wrap.appendChild(makeCrumb(prefix, prefix, parts.length === 0 && false));
  let acc = prefix;
  parts.forEach((part, i) => {
    const sepEl = document.createElement('span');
    sepEl.className = 'crumb-sep';
    sepEl.textContent = sep;
    wrap.appendChild(sepEl);

    if (isWin) acc = acc.endsWith('\\') ? acc + part : acc + '\\' + part;
    else acc = acc === '/' ? '/' + part : acc + '/' + part;

    wrap.appendChild(makeCrumb(part, acc, i === parts.length - 1));
  });
}

function renderListing(items) {
  const wrap = $('#listing');
  wrap.innerHTML = '';

  const parentBtn = document.createElement('div');
  parentBtn.className = 'listing-row';
  parentBtn.innerHTML = '<span class="listing-icon">⬆</span><span class="listing-name">.. 上一级</span>';
  parentBtn.addEventListener('click', async () => {
    const data = await api('/api/fs/list?path=' + encodeURIComponent(state.browsing.current));
    // 直接用已知 parent 更省一次请求，但这里保持简单一致
    if (data.parent) browseTo(data.parent);
  });
  wrap.appendChild(parentBtn);

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'listing-empty';
    empty.textContent = '这个文件夹是空的';
    wrap.appendChild(empty);
    return;
  }

  items.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'listing-row' + (item.kind === 'link' ? ' disabled' : '');
    const icon = item.kind === 'dir' ? '📁' : item.kind === 'link' ? '🔗' : '📄';
    row.innerHTML = `
      <span class="listing-icon">${icon}</span>
      <span class="listing-name">${escapeHtml(item.name)}</span>
      <span class="listing-size">${item.kind === 'file' ? formatSize(item.size) : ''}</span>
    `;
    if (item.kind === 'dir') {
      row.addEventListener('click', () => browseTo(item.path));
    } else if (item.kind === 'file') {
      row.style.cursor = 'default';
    }
    wrap.appendChild(row);
  });
}

function setupFolderModal() {
  $('#btn-browse').addEventListener('click', openFolderModal);
  $('#btn-repick').addEventListener('click', openFolderModal);
  $('#modal-close').addEventListener('click', () => $('#modal-folder').classList.add('hidden'));
  $('#pick-cancel').addEventListener('click', () => $('#modal-folder').classList.add('hidden'));
  $('#modal-folder').addEventListener('click', (e) => {
    if (e.target.id === 'modal-folder') $('#modal-folder').classList.add('hidden');
  });

  $('#pick-confirm').addEventListener('click', async () => {
    const dir = state.browsing.current;
    if (!dir) return;
    $('#modal-folder').classList.add('hidden');
    await selectProject(dir);
  });

  $('#btn-rescan').addEventListener('click', () => scanProject());
}

async function selectProject(dir) {
  state.projectRoot = dir;
  $('#project-root-text').textContent = dir;
  $('#folder-picked').classList.remove('hidden');
  $('#folder-empty').classList.add('hidden');
  unlockPanel('#panel-files');
  await scanProject();
}

/* ---------------------------- ③ 扫描与文件树 ---------------------------- */

async function scanProject() {
  if (!state.projectRoot) return;
  $('#tree-wrap').innerHTML = '<div class="empty-state small"><p>正在扫描目录…</p></div>';
  $('#scan-stats').textContent = '扫描中…';

  const ignoreText = $('#ignore-input').value;
  const ignore = ignoreText
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'));

  try {
    const data = await api('/api/fs/scan', {
      method: 'POST',
      body: { path: state.projectRoot, ignore },
    });
    state.scan = data;
    state.checked = new Set();
    state.fileIndex = new Map();
    indexFiles(data.root);
    renderTree();
    updateStats();
    updateSelectionSummary();
  } catch (err) {
    $('#tree-wrap').innerHTML =
      `<div class="empty-state small"><p>扫描失败：${escapeHtml(err.message)}</p></div>`;
    $('#scan-stats').textContent = '扫描失败';
  }
}

/** 把树拍平成索引，勾选状态用相对路径作 key，便于增删 */
function indexFiles(node, base) {
  const root = base || node.path;
  const walk = (n) => {
    if (n.kind === 'file') {
      const rel = relative(root, n.path);
      state.fileIndex.set(rel, {
        size: n.size,
        absolutePath: n.path,
        includeSuggestion: n.includeSuggestion,
        tooLarge: n.tooLarge,
      });
      if (n.includeSuggestion) state.checked.add(rel);
    }
    (n.children || []).forEach(walk);
  };
  walk(node);
}

/** 用正斜杠的相对路径，保证跨平台一致（GitHub 也只接受正斜杠） */
function relative(root, target) {
  let r = root.replace(/\\/g, '/');
  let t = target.replace(/\\/g, '/');
  if (r.endsWith('/')) r = r.slice(0, -1);
  if (t.startsWith(r + '/')) t = t.slice(r.length + 1);
  return t;
}

let treeFilter = '';
let expandAll = true;

function renderTree() {
  const wrap = $('#tree-wrap');
  wrap.innerHTML = '';
  if (!state.scan) return;

  const filter = treeFilter.trim().toLowerCase();
  const frag = document.createDocumentFragment();
  const rootNode = buildNode(state.scan.root, 0, filter);
  if (rootNode) frag.appendChild(rootNode);
  else wrap.innerHTML = '<div class="empty-state small"><p>没有匹配的文件</p></div>';
  wrap.appendChild(frag);

  // 搜索时自动展开所有命中路径
  if (filter) $$('.tree-children', wrap).forEach((c) => c.classList.remove('hidden'));
  $$('.tree-caret', wrap).forEach((c) => {
    if (filter) c.classList.add('open');
  });
}

/**
 * 递归构建树节点。
 * 返回 null 表示该分支在过滤条件下没有任何命中，应当隐藏。
 */
function buildNode(node, depth, filter) {
  if (node.kind === 'file') {
    const rel = relative(state.scan.root.path, node.path);
    if (filter && !rel.toLowerCase().includes(filter)) return null;

    const el = document.createElement('div');
    el.className = 'tree-node';
    const checked = state.checked.has(rel);

    const row = document.createElement('label');
    row.className = 'tree-row';

    const caret = document.createElement('span');
    caret.className = 'tree-caret leaf';
    caret.textContent = '▶';

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = checked;
    box.disabled = !!node.tooLarge;
    box.addEventListener('change', () => {
      if (box.checked) state.checked.add(rel);
      else state.checked.delete(rel);
      refreshIndeterminate();
      updateSelectionSummary();
      updateUploadButton();
    });

    const icon = document.createElement('span');
    icon.className = 'tree-icon';
    icon.textContent = node.binary ? '🧱' : '📄';

    const name = document.createElement('span');
    name.className = 'tree-name' + (node.tooLarge ? ' dim' : '');
    name.innerHTML = highlight(node.name, filter);

    row.appendChild(caret);
    row.appendChild(box);
    row.appendChild(icon);
    row.appendChild(name);

    if (node.size > 1024 * 1024 || node.tooLarge) {
      const meta = document.createElement('span');
      meta.className = 'tree-meta' + (node.tooLarge ? ' warn' : '');
      meta.textContent = node.tooLarge ? `过大 ${formatSize(node.size)}` : formatSize(node.size);
      row.appendChild(meta);
    }

    el.appendChild(row);
    return el;
  }

  // ---- 目录 ----
  const children = (node.children || [])
    .map((c) => buildNode(c, depth + 1, filter))
    .filter(Boolean);

  if (!children.length) return null;

  const el = document.createElement('div');
  el.className = 'tree-node dir-node';

  const row = document.createElement('div');
  row.className = 'tree-row';

  const caret = document.createElement('span');
  caret.className = 'tree-caret open';
  caret.textContent = '▶';

  const box = document.createElement('input');
  box.type = 'checkbox';
  box.dataset.dirPath = node.path;

  const icon = document.createElement('span');
  icon.className = 'tree-icon';
  icon.textContent = '📁';

  const name = document.createElement('span');
  name.className = 'tree-name';
  name.textContent = node.name;
  if (depth === 0) name.textContent = node.path;

  const count = document.createElement('span');
  count.className = 'tree-meta';
  count.textContent = `${children.length} 项`;

  row.appendChild(caret);
  row.appendChild(box);
  row.appendChild(icon);
  row.appendChild(name);
  row.appendChild(count);

  const childWrap = document.createElement('div');
  childWrap.className = 'tree-children';
  children.forEach((c) => childWrap.appendChild(c));

  if (!expandAll && depth > 0) {
    childWrap.classList.add('hidden');
    caret.classList.remove('open');
  }

  caret.addEventListener('click', (e) => {
    e.preventDefault();
    caret.classList.toggle('open');
    childWrap.classList.toggle('hidden');
  });

  // 目录复选框：批量勾选/取消该子树下全部可选文件
  box.addEventListener('change', () => {
    setSubtree(node, box.checked);
    $$('input[type=checkbox]', childWrap).forEach((cb) => {
      if (cb.dataset.dirPath) {
        cb.checked = box.checked;
        cb.indeterminate = false;
      } else if (!cb.disabled) {
        cb.checked = box.checked;
      }
    });
    updateSelectionSummary();
    updateUploadButton();
    refreshIndeterminate();
  });

  el.appendChild(row);
  el.appendChild(childWrap);
  return el;
}

/** 把一个子树内所有可选文件设为勾选/取消 */
function setSubtree(node, checked) {
  const walk = (n) => {
    if (n.kind === 'file') {
      const rel = relative(state.scan.root.path, n.path);
      if (n.tooLarge) return;
      if (checked) state.checked.add(rel);
      else state.checked.delete(rel);
    }
    (n.children || []).forEach(walk);
  };
  walk(node);
}

/** 重新计算所有目录节点的三态（全选 / 半选 / 未选） */
function refreshIndeterminate() {
  const root = state.scan && state.scan.root;
  if (!root) return;

  const wrap = $('#tree-wrap');

  const compute = (node) => {
    if (node.kind === 'file') {
      const rel = relative(state.scan.root.path, node.path);
      return { total: node.tooLarge ? 0 : 1, checked: state.checked.has(rel) && !node.tooLarge ? 1 : 0 };
    }
    let total = 0;
    let checked = 0;
    (node.children || []).forEach((c) => {
      const r = compute(c);
      total += r.total;
      checked += r.checked;
    });
    const box = $(`input[data-dir-path="${cssEscape(node.path)}"]`, wrap);
    if (box) {
      box.checked = total > 0 && checked === total;
      box.indeterminate = checked > 0 && checked < total;
    }
    return { total, checked };
  };

  compute(root);
}

function cssEscape(value) {
  return String(value).replace(/["\\]/g, '\\$&');
}

function highlight(text, filter) {
  const safe = escapeHtml(text);
  if (!filter) return safe;
  const idx = text.toLowerCase().indexOf(filter);
  if (idx < 0) return safe;
  const before = escapeHtml(text.slice(0, idx));
  const hit = escapeHtml(text.slice(idx, idx + filter.length));
  const after = escapeHtml(text.slice(idx + filter.length));
  return `${before}<mark>${hit}</mark>${after}`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function updateStats() {
  if (!state.scan) return;
  const s = state.scan.stats;
  $('#scan-stats').textContent =
    `共 ${s.files} 个文件 / ${s.dirs} 个目录，约 ${formatSize(s.bytes)}` +
    (s.skipped ? ` · 按规则跳过 ${s.skipped} 项` : '') +
    (s.oversize ? ` · ${s.oversize} 个文件超过 95MB 无法上传` : '');
}

function updateSelectionSummary() {
  let bytes = 0;
  state.checked.forEach((rel) => {
    const info = state.fileIndex.get(rel);
    if (info) bytes += info.size;
  });
  $('#sel-count').textContent = state.checked.size;
  $('#sel-size').textContent = formatSize(bytes);
  updateUploadButton();
}

function updateUploadButton() {
  const ok = state.token && state.checked.size > 0 && !state.uploading;
  $('#btn-upload').disabled = !ok;
}

function setupTreeActions() {
  $('#file-search').addEventListener('input', (e) => {
    treeFilter = e.target.value;
    renderTree();
    refreshIndeterminate();
  });

  $('#btn-select-all').addEventListener('click', () => {
    state.fileIndex.forEach((info, rel) => {
      if (!info.tooLarge) state.checked.add(rel);
    });
    syncTreeCheckboxes();
    updateSelectionSummary();
  });

  $('#btn-select-none').addEventListener('click', () => {
    state.checked.clear();
    syncTreeCheckboxes();
    updateSelectionSummary();
  });

  $('#btn-select-invert').addEventListener('click', () => {
    const next = new Set();
    state.fileIndex.forEach((info, rel) => {
      if (!info.tooLarge && !state.checked.has(rel)) next.add(rel);
    });
    state.checked = next;
    syncTreeCheckboxes();
    updateSelectionSummary();
  });

  $('#btn-expand-all').addEventListener('click', () => {
    expandAll = !expandAll;
    $('#btn-expand-all').textContent = expandAll ? '收起全部' : '展开全部';
    $$('#tree-wrap .tree-children').forEach((c) => c.classList.toggle('hidden', !expandAll));
    $$('#tree-wrap .tree-caret').forEach((c) => c.classList.toggle('open', expandAll));
  });

  $('#btn-apply-ignore').addEventListener('click', () => scanProject());
}

/** 把内存中的勾选状态同步回 DOM（全选/反选/清空后调用） */
function syncTreeCheckboxes() {
  const wrap = $('#tree-wrap');
  $$('input[type=checkbox]', wrap).forEach((box) => {
    if (box.dataset.dirPath) return; // 目录节点稍后统一刷新
    // 找到对应的文件相对路径：从树节点反查
    const nameEl = box.parentElement && box.parentElement.querySelector('.tree-name');
    if (!nameEl) return;
    box.checked = false; // 先清，再由下面匹配
  });

  // 逐行匹配（用索引遍历，保证与节点一一对应）
  const lines = $$('.tree-row', wrap).filter((r) => r.querySelector('input[type=checkbox]:not([data-dir-path])'));
  const rels = [];
  collectVisibleFileRels(state.scan.root, treeFilter.trim().toLowerCase(), rels);

  lines.forEach((row, i) => {
    const box = row.querySelector('input[type=checkbox]');
    const rel = rels[i];
    if (!box || rel === undefined) return;
    box.checked = state.checked.has(rel);
    box.indeterminate = false;
  });

  refreshIndeterminate();
}

/** 按渲染顺序收集可见文件的相对路径，供 syncTreeCheckboxes 对应 */
function collectVisibleFileRels(node, filter, out) {
  const walk = (n) => {
    if (n.kind === 'file') {
      const rel = relative(state.scan.root.path, n.path);
      if (filter && !rel.toLowerCase().includes(filter)) return;
      out.push(rel);
      return;
    }
    const kids = (n.children || []).map((c) => {
      const before = out.length;
      walk(c);
      return out.length > before;
    });
    // 目录没有可见子项时不会渲染，这里已经通过 walk 的副作用体现
  };
  walk(node);
}

/* ---------------------------- ④ 仓库与上传 ---------------------------- */

async function loadRepos() {
  if (!state.token) return;
  const sel = $('#repo-select');
  sel.innerHTML = '<option value="">加载中…</option>';
  try {
    const data = await api('/api/github/repos');
    state.repos = data.repos;
    sel.innerHTML = '';
    if (!state.repos.length) {
      sel.innerHTML = '<option value="">没有可用仓库，请改用新建</option>';
      return;
    }
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = `— 请选择（共 ${state.repos.length} 个）—`;
    sel.appendChild(blank);

    state.repos.forEach((r) => {
      const opt = document.createElement('option');
      opt.value = r.fullName;
      opt.textContent = `${r.fullName}${r.private ? '（私有）' : ''}${r.empty ? ' · 空仓库' : ''}`;
      opt.dataset.defaultBranch = r.defaultBranch || '';
      sel.appendChild(opt);
    });

    // 更新历史面板的目标提示
    updateHistoryTarget();
  } catch (err) {
    sel.innerHTML = `<option value="">加载失败：${escapeHtml(err.message)}</option>`;
  }
}

function currentTarget() {
  const mode = ($('input[name="repo-mode"]:checked') || {}).value;
  if (mode === 'new') {
    const name = $('#new-repo-name').value.trim();
    if (!name) return null;
    return {
      mode: 'new',
      owner: state.viewer ? state.viewer.login : '',
      repo: name,
      branch: $('#branch-input').value.trim() || 'main',
    };
  }
  const full = $('#repo-select').value;
  if (!full) return null;
  const [owner, repo] = full.split('/');
  const opt = $('#repo-select').selectedOptions[0];
  const defBranch = (opt && opt.dataset.defaultBranch) || 'main';
  return {
    mode: 'existing',
    owner,
    repo,
    branch: $('#branch-input').value.trim() || defBranch,
  };
}

function updateHistoryTarget() {
  const target = currentTarget();
  $('#history-target').textContent = target
    ? `当前对象：${target.owner}/${target.repo} · 分支 ${target.branch}`
    : '尚未选择仓库';
  $('#btn-load-history').disabled = !(state.token && target);
}

function setupTarget() {
  $$('input[name="repo-mode"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      const isNew = $('input[name="repo-mode"]:checked').value === 'new';
      $('#new-repo-row').classList.toggle('hidden', !isNew);
      $('#repo-select').disabled = isNew;
      if (isNew && !$('#branch-input').value) $('#branch-input').placeholder = '留空则用 main';
      updateHistoryTarget();
    });
  });

  $('#repo-select').addEventListener('change', () => {
    const target = currentTarget();
    if (target) {
      $('#branch-input').placeholder = target.branch;
    }
    updateHistoryTarget();
  });

  $('#branch-input').addEventListener('input', updateHistoryTarget);
  $('#new-repo-name').addEventListener('input', updateHistoryTarget);
  $('#btn-reload-repos').addEventListener('click', loadRepos);

  $('#btn-upload').addEventListener('click', doUpload);
}

async function doUpload() {
  hideAlert('#upload-alert');

  if (!state.token) {
    showAlert('#upload-alert', '请先在第 1 步登录 GitHub', 'error');
    return;
  }
  if (!state.checked.size) {
    showAlert('#upload-alert', '请至少勾选一个文件', 'error');
    return;
  }

  let target = currentTarget();
  if (!target) {
    showAlert('#upload-alert', '请选择目标仓库，或填写要新建的仓库名', 'error');
    return;
  }

  // 新建仓库模式：先建仓库，再上传
  if (target.mode === 'new') {
    try {
      const name = $('#new-repo-name').value.trim();
      if (!/^[A-Za-z0-9._-]+$/.test(name)) {
        showAlert('#upload-alert', '仓库名只能包含字母、数字、点、下划线和短横线', 'error');
        return;
      }
      showAlert('#upload-alert', `正在创建仓库 ${target.owner}/${name} …`, 'info');
      const data = await api('/api/github/repos', {
        method: 'POST',
        body: {
          name,
          owner: target.owner,
          privateRepo: $('#new-repo-private').checked,
          description: `${name} — 由本地 GitHub 上传器 创建`,
        },
      });
      toast(`仓库 ${data.repo.fullName} 创建成功`, 'success');
      await loadRepos();
      target = {
        mode: 'existing',
        owner: data.repo.owner,
        repo: data.repo.name,
        branch: $('#branch-input').value.trim() || data.repo.defaultBranch || 'main',
      };
    } catch (err) {
      showAlert('#upload-alert', `创建仓库失败：${err.message}`, 'error');
      return;
    }
  }

  // 组装上传清单：相对路径（正斜杠）交由服务端还原绝对路径
  const files = Array.from(state.checked);
  const message = $('#commit-message').value.trim() ||
    `Upload ${files.length} file(s) from ${state.projectRoot}`;

  state.uploading = true;
  updateUploadButton();
  $('#progress-wrap').classList.remove('hidden');
  setProgress(2, '正在准备…');

  $('#btn-upload').disabled = true;

  const phaseText = {
    blob: (p) => `正在上传文件 ${p.done}/${p.total}：${p.current}`,
    tree: () => '正在生成目录树…',
    commit: () => '正在创建提交…',
    ref: () => '正在更新分支…',
    done: () => '完成',
  };

  try {
    const result = await apiStream(
      '/api/github/upload',
      {
        owner: target.owner,
        repo: target.repo,
        branch: target.branch,
        message,
        overwrite: $('#overwrite-check').checked,
        root: state.projectRoot,
        files,
      },
      {
        onProgress: (p) => {
          const fn = phaseText[p.phase];
          setProgress(p.percent || 0, fn ? fn(p) : p.phase);
        },
      }
    );

    setProgress(100, '上传完成');
    showAlert(
      '#upload-alert',
      `上传成功！\n提交：${result.shortSha} · ${result.fileCount} 个文件 · 分支 ${result.branch}` +
        (result.createdBranch ? '（新建分支）' : ''),
      'success'
    );
    toast(`已上传 ${result.fileCount} 个文件到 ${result.owner}/${result.repo}`, 'success');

    // 记入本会话历史，供撤回使用
    state.history.unshift({
      owner: result.owner,
      repo: result.repo,
      branch: result.branch,
      commitSha: result.commitSha,
      shortSha: result.shortSha,
      fileCount: result.fileCount,
      message,
      htmlUrl: result.htmlUrl,
      time: new Date().toISOString(),
      reverted: false,
      createdBranch: result.createdBranch,
    });
    persistHistory();
    renderHistory();
    unlockPanel('#panel-history');
    updateHistoryTarget();
  } catch (err) {
    setProgress(0, '上传失败');
    showAlert('#upload-alert', `上传失败：${err.message}`, 'error');
  } finally {
    state.uploading = false;
    updateUploadButton();
    $('#btn-upload').disabled = !(state.token && state.checked.size);
  }
}

function setProgress(percent, text) {
  $('#progress-fill').style.width = Math.max(0, Math.min(100, percent)) + '%';
  if (text !== undefined) $('#progress-text').textContent = text;
}

/* ---------------------------- ⑤ 历史与撤回 ---------------------------- */

function persistHistory() {
  try {
    sessionStorage.setItem(SS_HISTORY_KEY, JSON.stringify(state.history));
  } catch { /* 忽略 */ }
}

function restoreHistory() {
  try {
    const raw = sessionStorage.getItem(SS_HISTORY_KEY);
    if (raw) state.history = JSON.parse(raw) || [];
  } catch {
    state.history = [];
  }
}

function renderHistory() {
  const wrap = $('#history-list');
  wrap.innerHTML = '';

  if (!state.history.length) {
    wrap.innerHTML = '<div class="empty-state small"><p>还没有上传记录。</p></div>';
    return;
  }

  state.history.forEach((item, index) => {
    const el = document.createElement('div');
    el.className = 'history-item' + (item.reverted ? ' reverted' : ' revertible');

    const main = document.createElement('div');
    main.className = 'history-main';
    main.innerHTML = `
      <div class="history-title">${escapeHtml(item.owner)}/${escapeHtml(item.repo)}
        <span class="tag ${item.reverted ? 'tag-rev' : 'tag-ok'}">
          ${item.reverted ? '已撤回' : '可撤回'}
        </span>
        <span class="tag tag-plain">${item.fileCount} 文件</span>
      </div>
      <div class="history-sub">
        ${escapeHtml(item.shortSha)} · ${escapeHtml(item.branch)} · ${escapeHtml(item.message.slice(0, 60))}
        · ${new Date(item.time).toLocaleString('zh-CN')}
      </div>
    `;

    const actions = document.createElement('div');
    actions.className = 'history-actions';

    const link = document.createElement('a');
    link.href = item.htmlUrl;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.className = 'btn btn-ghost btn-sm';
    link.textContent = '在 GitHub 查看';
    actions.appendChild(link);

    if (!item.reverted) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-danger btn-sm';
      btn.textContent = '撤回这次上传';
      btn.addEventListener('click', () => doRevert(item, btn));
      actions.appendChild(btn);
    }

    el.appendChild(main);
    el.appendChild(actions);
    wrap.appendChild(el);
  });
}

async function doRevert(item, btn) {
  hideAlert('#history-alert');
  const mode = ($('input[name="revert-mode"]:checked') || {}).value || 'safe';

  const modeText = mode === 'force'
    ? '强制回退会把分支指针拨回上传前，该提交及其之后的所有提交都会从分支上消失。'
    : '安全撤回会新增一个反向提交，文件内容回到上传前，历史完整保留。';

  const ok = window.confirm(
    `确认撤回这次上传？\n\n` +
    `仓库：${item.owner}/${item.repo}\n` +
    `分支：${item.branch}\n` +
    `提交：${item.shortSha}（${item.fileCount} 个文件）\n\n` +
    modeText
  );
  if (!ok) return;

  btn.disabled = true;
  btn.textContent = '撤回中…';

  try {
    const result = await apiStream('/api/github/revert', {
      owner: item.owner,
      repo: item.repo,
      branch: item.branch,
      commitSha: item.commitSha,
      mode,
    });

    item.reverted = true;
    item.revertInfo = result;
    persistHistory();
    renderHistory();

    showAlert('#history-alert', `撤回成功。\n${result.message}`, 'success');
    toast('撤回完成', 'success');
  } catch (err) {
    btn.disabled = false;
    btn.textContent = '撤回这次上传';
    showAlert('#history-alert', `撤回失败：${err.message}`, 'error');
  }
}

function setupHistory() {
  $('#btn-load-history').addEventListener('click', loadRemoteHistory);
  $$('input[name="revert-mode"]').forEach((r) => r.addEventListener('change', () => {
    if (r.value === 'force' && r.checked) {
      toast('注意：强制回退会抹掉该提交之后的分支历史', 'error', 4200);
    }
  }));
}

async function loadRemoteHistory() {
  const target = currentTarget();
  if (!target) {
    showAlert('#history-alert', '请先选择目标仓库', 'error');
    return;
  }
  try {
    const data = await api(
      `/api/github/commits?owner=${encodeURIComponent(target.owner)}&repo=${encodeURIComponent(target.repo)}&branch=${encodeURIComponent(target.branch)}`
    );
    const mine = new Set(state.history.map((h) => h.commitSha));
    const wrap = $('#history-list');
    wrap.innerHTML = '';

    // 先渲染可撤回的本地记录
    if (state.history.length) {
      state.history.forEach((item) => appendHistoryItem(wrap, item));
    }

    const divider = document.createElement('div');
    divider.className = 'stats-bar';
    divider.textContent = `— 下面是 ${target.owner}/${target.repo} 最近的提交（仅供参考，非本工具上传） —`;
    wrap.appendChild(divider);

    data.commits.forEach((c) => {
      if (mine.has(c.sha)) return; // 已在上面渲染过
      const el = document.createElement('div');
      el.className = 'history-item';
      el.innerHTML = `
        <div class="history-main">
          <div class="history-title">${escapeHtml(c.message.split('\n')[0].slice(0, 80))}</div>
          <div class="history-sub">${escapeHtml(c.shortSha)} · ${escapeHtml(c.author)} · ${
        c.date ? new Date(c.date).toLocaleString('zh-CN') : ''
      }</div>
        </div>
      `;
      const actions = document.createElement('div');
      actions.className = 'history-actions';
      const link = document.createElement('a');
      link.href = c.htmlUrl;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.className = 'btn btn-ghost btn-sm';
      link.textContent = '查看';
      actions.appendChild(link);
      el.appendChild(actions);
      wrap.appendChild(el);
    });
  } catch (err) {
    showAlert('#history-alert', `读取提交历史失败：${err.message}`, 'error');
  }
}

function appendHistoryItem(wrap, item) {
  const el = document.createElement('div');
  el.className = 'history-item' + (item.reverted ? ' reverted' : ' revertible');
  el.innerHTML = `
    <div class="history-main">
      <div class="history-title">${escapeHtml(item.owner)}/${escapeHtml(item.repo)}
        <span class="tag ${item.reverted ? 'tag-rev' : 'tag-ok'}">${item.reverted ? '已撤回' : '可撤回'}</span>
        <span class="tag tag-plain">${item.fileCount} 文件</span>
      </div>
      <div class="history-sub">${escapeHtml(item.shortSha)} · ${escapeHtml(item.branch)} · ${escapeHtml(
    item.message.slice(0, 60)
  )}</div>
    </div>
  `;
  const actions = document.createElement('div');
  actions.className = 'history-actions';
  const link = document.createElement('a');
  link.href = item.htmlUrl;
  link.target = '_blank';
  link.rel = 'noreferrer';
  link.className = 'btn btn-ghost btn-sm';
  link.textContent = '在 GitHub 查看';
  actions.appendChild(link);
  if (!item.reverted) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-danger btn-sm';
    btn.textContent = '撤回这次上传';
    btn.addEventListener('click', () => doRevert(item, btn));
    actions.appendChild(btn);
  }
  el.appendChild(actions);
  wrap.appendChild(el);
}

/* ---------------------------- 启动 ---------------------------- */

async function init() {
  setupPanels();
  setupTabs();
  setupAuth();
  setupFolderModal();
  setupTreeActions();
  setupTarget();
  setupHistory();
  restoreHistory();
  renderHistory();

  // 填充默认忽略规则，让用户看得到并可按需修改
  try {
    const health = await api('/api/health', { token: '' });
    $('#ignore-input').value = health.defaultIgnore.join('\n');
  } catch { /* 忽略 */ }

  // 若之前记住过令牌，尝试自动登录
  try {
    const saved = localStorage.getItem(LS_TOKEN_KEY);
    if (saved) {
      const ok = await connectWithToken(saved);
      if (ok) {
        showAlert('#auth-alert', '已用记住的令牌自动登录。', 'info');
      }
    }
  } catch { /* 忽略 */ }

  updateSelectionSummary();
  console.log('GitHub 上传器 已就绪');
}

document.addEventListener('DOMContentLoaded', init);