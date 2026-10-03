const { getDevToolsPort } = require('./cdp_injector');

async function main() {
  const port = getDevToolsPort();
  if (!port) {
    console.error('未找到 DevToolsActivePort，请确认 Antigravity 是否正在运行。');
    return;
  }
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  const pages = await res.json();
  const page = pages.find(p => p.type === 'page');
  if (!page) {
    console.error('未找到活跃窗口页面。');
    return;
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);

  ws.onopen = () => {
    ws.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: {
        expression: `(() => {
          const editable = document.querySelector('[contenteditable="true"]');
          const input = document.querySelector('input[type="file"]');
          return {
            hasEditable: !!editable,
            hasInput: !!input,
            url: window.location.href,
            hookInstalled: !!window.__antigravity_drag_drop_hook_v10_installed
          };
        })()`,
        returnByValue: true
      }
    }));
  };

  ws.onmessage = (e) => {
    const data = JSON.parse(e.data);
    console.log('DOM 检测结果:', data.result?.result?.value);
    ws.close();
    process.exit(0);
  };
}

main().catch(console.error);
