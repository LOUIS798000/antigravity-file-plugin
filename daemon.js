const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const { execSync } = require('child_process');
const { HOOK_SCRIPT, getDevToolsPort } = require('./cdp_injector');

// 内存常用目录缓存池（LRU式，最近命中的目录优先）
const recentDirectories = new Set([
  path.join(os.homedir(), 'Desktop'),
  'C:\\Users\\Public\\Desktop',
  path.join(os.homedir(), 'Downloads'),
  path.join(os.homedir(), 'Documents')
]);

function normalizeWindowsPath(p) {
  if (!p || typeof p !== 'string') return null;
  let normalized = path.normalize(p);
  // 规范化盘符大写（如 c:\ -> C:\）
  if (/^[a-z]:\\/i.test(normalized)) {
    normalized = normalized[0].toUpperCase() + normalized.slice(1);
  }
  return normalized;
}

function isAbsoluteFilePath(p) {
  if (!p || typeof p !== 'string') return false;
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\');
}

// 快速获取 Windows Explorer 当前选中的所有文件路径（极速模式，通常 70~250ms）
function getExplorerSelectedPaths() {
  const results = [];
  try {
    const psScript = `
      $ProgressPreference = 'SilentlyContinue';
      [Console]::OutputEncoding = [System.Text.Encoding]::UTF8;
      $shell = New-Object -ComObject Shell.Application;
      foreach ($w in $shell.Windows()) {
        try {
          foreach ($i in $w.Document.SelectedItems()) {
            [Console]::WriteLine($i.Path);
          }
        } catch {}
      }
    `;
    const b64 = Buffer.from(psScript, 'utf16le').toString('base64');
    const out = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${b64}`, {
      encoding: 'utf8',
      timeout: 1800,
      windowsHide: true
    });
    out.split(/\r?\n/).forEach(line => {
      const trimmed = line.trim();
      if (trimmed && isAbsoluteFilePath(trimmed)) {
        results.push(normalizeWindowsPath(trimmed));
      }
    });
  } catch (err) {}
  return results;
}

// 解析 Windows Recent 里的快捷方式真实目标
function resolveRecentShortcut(cleanName) {
  try {
    const psScript = `
      $ProgressPreference = 'SilentlyContinue';
      [Console]::OutputEncoding = [System.Text.Encoding]::UTF8;
      $sh = New-Object -ComObject WScript.Shell;
      $recent = [Environment]::GetFolderPath('Recent');
      Get-ChildItem -Path $recent -Filter "*.lnk" | ForEach-Object {
        try {
          $target = $sh.CreateShortcut($_.FullName).TargetPath;
          if ($target) { [Console]::WriteLine($target); }
        } catch {}
      }
    `;
    const b64 = Buffer.from(psScript, 'utf16le').toString('base64');
    const out = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${b64}`, {
      encoding: 'utf8',
      timeout: 1800,
      windowsHide: true
    });
    const lines = out.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    for (const target of lines) {
      if (path.basename(target).toLowerCase() === cleanName.toLowerCase() && fs.existsSync(target)) {
        return normalizeWindowsPath(target);
      }
    }
  } catch (err) {}
  return null;
}

// 本地物理绝对路径智能解析引擎
function resolveLocalPath({ fileName, fileSize, isDirectory, workspacePath }) {
  if (!fileName) return null;

  // 0. 本身已包含盘符并且真实存在
  if (isAbsoluteFilePath(fileName) && fs.existsSync(fileName)) {
    return normalizeWindowsPath(fileName);
  }

  const cleanName = path.basename(fileName);
  const targetSize = fileSize ? Number(fileSize) : null;

  // 1. 第一优先级：Windows 资源管理器窗口当前选中的文件/文件夹（拖拽来源最精准探测）
  const explorerPaths = getExplorerSelectedPaths();
  for (const expPath of explorerPaths) {
    if (path.basename(expPath).toLowerCase() === cleanName.toLowerCase()) {
      try {
        const stat = fs.statSync(expPath);
        if (isDirectory && stat.isDirectory()) {
          recentDirectories.add(path.dirname(expPath));
          return expPath;
        }
        if (!isDirectory && stat.isFile()) {
          if (targetSize && targetSize > 0) {
            if (stat.size === targetSize) {
              recentDirectories.add(path.dirname(expPath));
              return expPath;
            }
          } else {
            recentDirectories.add(path.dirname(expPath));
            return expPath;
          }
        }
      } catch (e) {}
    }
  }

  // 2. 第二优先级：当前 Antigravity 工作区匹配
  if (workspacePath && isAbsoluteFilePath(workspacePath)) {
    const wsCandidates = [
      path.join(workspacePath, fileName),
      path.join(workspacePath, cleanName)
    ];
    for (const cand of wsCandidates) {
      try {
        if (fs.existsSync(cand)) {
          const stat = fs.statSync(cand);
          if (!targetSize || targetSize === stat.size) {
            const norm = normalizeWindowsPath(cand);
            recentDirectories.add(path.dirname(norm));
            return norm;
          }
        }
      } catch (e) {}
    }
  }

  // 3. 第三优先级：用户桌面与公用桌面（拖拽最高频目录）
  const desktopDirs = [
    path.join(os.homedir(), 'Desktop'),
    'C:\\Users\\Public\\Desktop'
  ];
  for (const d of desktopDirs) {
    try {
      const full = path.join(d, cleanName);
      if (fs.existsSync(full)) {
        const stat = fs.statSync(full);
        if (!targetSize || targetSize === stat.size) {
          const norm = normalizeWindowsPath(full);
          recentDirectories.add(path.dirname(norm));
          return norm;
        }
      }
    } catch (e) {}
  }

  // 4. 第四优先级：内存记忆目录（之前成功匹配过的目录，0ms 快速命中）
  for (const dir of recentDirectories) {
    try {
      const full = path.join(dir, cleanName);
      if (fs.existsSync(full)) {
        const stat = fs.statSync(full);
        if (!targetSize || targetSize === stat.size) {
          return normalizeWindowsPath(full);
        }
      }
    } catch (e) {}
  }

  // 5. 第五优先级：常见个人及系统根目录
  const commonDirs = [
    path.join(os.homedir(), 'Downloads'),
    path.join(os.homedir(), 'Documents'),
    path.join(os.homedir(), 'Pictures'),
    path.join(os.homedir(), 'Videos'),
    path.join(os.homedir(), 'Music'),
    os.homedir(),
    'D:\\',
    'C:\\'
  ];
  for (const dir of commonDirs) {
    try {
      const full = path.join(dir, cleanName);
      if (fs.existsSync(full)) {
        const stat = fs.statSync(full);
        if (!targetSize || targetSize === stat.size) {
          const norm = normalizeWindowsPath(full);
          recentDirectories.add(path.dirname(norm));
          return norm;
        }
      }
    } catch (e) {}
  }

  // 6. 第六优先级：Windows Recent 最近访问快捷方式真实指向
  const recentTarget = resolveRecentShortcut(cleanName);
  if (recentTarget) {
    recentDirectories.add(path.dirname(recentTarget));
    return recentTarget;
  }

  return null;
}

// 单实例 HTTP 服务：同时承担防多开单例锁与本地绝对物理路径解析 API
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const reqUrl = new URL(req.url, 'http://127.0.0.1:29888');
  if (reqUrl.pathname === '/resolve') {
    const name = reqUrl.searchParams.get('name') || '';
    const size = reqUrl.searchParams.get('size') || '';
    const isDir = reqUrl.searchParams.get('dir') === '1';
    const workspace = reqUrl.searchParams.get('workspace') || '';

    const fullPath = resolveLocalPath({
      fileName: name,
      fileSize: size ? parseInt(size, 10) : null,
      isDirectory: isDir,
      workspacePath: workspace
    });

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      success: !!fullPath && isAbsoluteFilePath(fullPath),
      fullPath: fullPath || null
    }));
    return;
  }

  res.writeHead(404);
  res.end();
});

server.once('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log('[守护进程] 已有实例在后台运行，本进程安全退出。');
    process.exit(0);
  }
});

server.listen(29888, '127.0.0.1', () => {
  console.log('[守护进程] 本地绝对路径解析 API 已在 127.0.0.1:29888 启动就绪');
});

async function checkAndInject() {
  const port = getDevToolsPort();
  if (!port) return;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return;
    const pages = await res.json();
    const targetPages = pages.filter(p => p.type === 'page' && p.webSocketDebuggerUrl);

    for (const page of targetPages) {
      await inspectAndInjectPage(page);
    }
  } catch (err) {}
}

const injectingPages = new Set();

async function inspectAndInjectPage(page) {
  if (injectingPages.has(page.id)) return;
  injectingPages.add(page.id);

  let ws;
  try {
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 1500);
      ws.onopen = () => { clearTimeout(timer); resolve(); };
      ws.onerror = (e) => { clearTimeout(timer); reject(e); };
    });

    // 检查页面是否已注入最新 v10 Hook
    const checkMsg = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 1000);
      const onMsg = (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data.id === 10) {
            clearTimeout(timer);
            ws.removeEventListener('message', onMsg);
            resolve(data.result?.result?.value);
          }
        } catch (err) {
          resolve(null);
        }
      };
      ws.addEventListener('message', onMsg);
      ws.send(JSON.stringify({
        id: 10,
        method: 'Runtime.evaluate',
        params: {
          expression: '!!window.__antigravity_drag_drop_hook_v10_installed',
          returnByValue: true
        }
      }));
    });

    if (checkMsg === true) {
      try { ws.close(); } catch {}
      injectingPages.delete(page.id);
      return;
    }

    // 注入持久化脚本与即时执行
    ws.send(JSON.stringify({
      id: 1,
      method: 'Page.addScriptToEvaluateOnNewDocument',
      params: { source: HOOK_SCRIPT }
    }));

    ws.send(JSON.stringify({
      id: 2,
      method: 'Runtime.evaluate',
      params: {
        expression: HOOK_SCRIPT,
        returnByValue: true
      }
    }));

    console.log(`[提示] 已向窗口 [${page.title || 'Antigravity'}] 注入全新绝对路径增强脚本 (v10)。`);
  } catch (e) {
  } finally {
    try { if (ws && ws.readyState === WebSocket.OPEN) ws.close(); } catch (e) {}
    injectingPages.delete(page.id);
  }
}

console.log('Antigravity 文件拖拽绝对路径辅助服务已启动，正在后台监听客户端窗口...');

checkAndInject();
setInterval(checkAndInject, 2500);
