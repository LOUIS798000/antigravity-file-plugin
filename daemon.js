const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const { HOOK_SCRIPT, getDevToolsPort } = require('./cdp_injector');

// 本地路径智能快速解析器（针对当前窗口或特殊场景下的未展开路径）
function resolveLocalPath(fileName) {
  if (!fileName) return null;
  const userHome = os.homedir();
  const searchDirs = [
    path.join(userHome, 'Desktop'),
    path.join(userHome, 'Downloads'),
    path.join(userHome, 'Documents'),
    path.join(userHome, 'Pictures'),
    path.join(userHome, 'Videos'),
    userHome,
    __dirname,
    process.cwd(),
    'd:\\',
    'c:\\'
  ];

  for (const dir of searchDirs) {
    try {
      const full = path.join(dir, fileName);
      if (fs.existsSync(full)) {
        return full;
      }
    } catch (e) {}
  }

  // 检查 Windows Recent 快捷方式指向
  try {
    const recentDir = path.join(userHome, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Recent');
    if (fs.existsSync(recentDir)) {
      const recentFiles = fs.readdirSync(recentDir);
      for (const rf of recentFiles) {
        if (rf.toLowerCase().includes(fileName.toLowerCase())) {
          const full = path.join(recentDir, rf);
          const base = rf.replace(/\.lnk$/i, '');
          if (base.toLowerCase() === fileName.toLowerCase()) {
            return full;
          }
        }
      }
    }
  } catch (e) {}

  return null;
}

// 单实例 HTTP 服务：同时承担防多开单例锁与本地路径解析 API
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
    const fullPath = resolveLocalPath(name);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: !!fullPath, fullPath: fullPath || name }));
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
  console.log('[守护进程] 本地路径解析 API 已在 127.0.0.1:29888 启动就绪');
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

    // 检查页面是否已注入最新 v9 Hook
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
          expression: '!!window.__antigravity_drag_drop_hook_v9_installed',
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

    console.log(`[提示] 已向窗口 [${page.title || 'Antigravity'}] 注入拖拽辅助脚本。`);
  } catch (e) {
  } finally {
    try { if (ws && ws.readyState === WebSocket.OPEN) ws.close(); } catch (e) {}
    injectingPages.delete(page.id);
  }
}

console.log('Antigravity 文件拖拽辅助服务已启动，正在后台监听客户端窗口...');

checkAndInject();
setInterval(checkAndInject, 2500);
