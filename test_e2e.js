const fs = require('fs');
const path = require('path');
const { getDevToolsPort, cdpCall } = require('./cdp_injector');

async function runE2E() {
  const port = getDevToolsPort();
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  const pages = await res.json();
  const page = pages.find(p => p.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);

  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  try {
    // 1. 在页面上渲染各种类型的测试卡片
    const evalRes = await cdpCall(ws, 'Runtime.evaluate', {
      expression: `(() => {
        if (!window.__antigravityRenderCustomChip || !window.__antigravityRenderFolderChip) {
          return { error: 'Test hooks not found' };
        }

        // 清理旧的测试卡片
        document.querySelectorAll('[data-custom-chip="true"]').forEach(c => c.remove());
        const oldBar = document.querySelector('#custom-attachment-bar');
        if (oldBar) oldBar.remove();

        // 渲染 1: docx 文档
        const docxBadge = window.__antigravityGetFileBadgeInfo('docx');
        window.__antigravityRenderCustomChip(docxBadge.text, docxBadge.bg, '商业计划书.docx', 'D:\\\\文档\\\\商业计划书.docx');

        // 渲染 2: svg 矢量图
        const svgBadge = window.__antigravityGetFileBadgeInfo('svg');
        window.__antigravityRenderCustomChip(svgBadge.text, svgBadge.bg, 'logo_vector.svg', 'D:\\\\设计\\\\logo_vector.svg');

        // 渲染 3: xlsx 电子表格
        const xlsxBadge = window.__antigravityGetFileBadgeInfo('xlsx');
        window.__antigravityRenderCustomChip(xlsxBadge.text, xlsxBadge.bg, '财务报表.xlsx', 'D:\\\\财务\\\\财务报表.xlsx');

        // 渲染 4: lnk 快捷方式
        const lnkBadge = window.__antigravityGetFileBadgeInfo('lnk');
        window.__antigravityRenderCustomChip(lnkBadge.text, lnkBadge.bg, '微信.lnk', 'C:\\\\Users\\\\Public\\\\Desktop\\\\微信.lnk');

        // 渲染 5: 文件夹
        window.__antigravityRenderFolderChip('我的项目源码', 'D:\\\\Projects\\\\MyApp');

        // 渲染 6: zip 压缩包
        const zipBadge = window.__antigravityGetFileBadgeInfo('zip');
        window.__antigravityRenderCustomChip(zipBadge.text, zipBadge.bg, 'release_v2.0.zip', 'D:\\\\Dist\\\\release_v2.0.zip');

        // 检查渲染结果
        const chips = Array.from(document.querySelectorAll('[data-custom-chip="true"]')).map(c => {
          const badgeEl = c.querySelector('div[style*="background-color"]');
          const svgEl = c.querySelector('svg');
          const labelEl = c.querySelector('span');
          return {
            hasSvg: !!svgEl,
            badgeText: badgeEl?.textContent?.trim() || null,
            badgeBg: badgeEl?.style?.backgroundColor || null,
            displayName: labelEl?.textContent?.trim(),
            fullPath: c.getAttribute('data-full-path')
          };
        });

        return {
          totalChips: chips.length,
          chips
        };
      })()`,
      returnByValue: true
    });

    console.log('E2E Render Result:', JSON.stringify(evalRes?.result?.value, null, 2));

    // 2. 截取页面截图
    try {
      await cdpCall(ws, 'Page.enable');
      const screenshotRes = await cdpCall(ws, 'Page.captureScreenshot', { format: 'png' });
      if (screenshotRes?.data) {
        const imgBuffer = Buffer.from(screenshotRes.data, 'base64');
        const artifactPath = path.join(__dirname, 'chips_preview.png');
        fs.writeFileSync(artifactPath, imgBuffer);
        console.log(`截图已保存至: ${artifactPath}`);
      }
    } catch (err) {
      console.log('截图跳过或未支持:', err.message);
    }
  } finally {
    // 3. 清理测试卡片，确保输入框恢复初始状态
    try {
      await cdpCall(ws, 'Runtime.evaluate', {
        expression: `(() => {
          document.querySelectorAll('[data-custom-chip="true"]').forEach(c => c.remove());
          const bar = document.querySelector('#custom-attachment-bar');
          if (bar) bar.remove();
        })()`,
        returnByValue: true
      });
    } catch (e) {}
    ws.close();
  }
}

runE2E().catch(console.error);
