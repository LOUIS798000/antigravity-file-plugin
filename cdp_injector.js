const fs = require('fs');
const path = require('path');

function getDevToolsPort() {
  const portFilePath = path.join(
    process.env.APPDATA || path.join(process.env.USERPROFILE, 'AppData', 'Roaming'),
    'Antigravity',
    'DevToolsActivePort'
  );
  if (!fs.existsSync(portFilePath)) return null;
  const content = fs.readFileSync(portFilePath, 'utf8');
  return parseInt(content.trim().split(/\r?\n/)[0], 10);
}

const HOOK_SCRIPT = `
  (() => {
    const HOOK_VERSION = 'v10';
    if (window.__antigravity_drag_drop_hook_v10_installed) return;
    window.__antigravity_drag_drop_hook_v10_installed = true;
    window.__antigravityPathMap = window.__antigravityPathMap || {};

    function isAbsoluteFilePath(p) {
      if (!p || typeof p !== 'string') return false;
      return /^[a-zA-Z]:[\\\\/]/.test(p) || p.startsWith('\\\\\\\\');
    }

    // 从当前 DOM 智能提取活跃 Workspace 绝对物理路径
    function getCurrentWorkspacePath() {
      try {
        const uriEl = document.querySelector('[data-uri^="file:///"]');
        if (uriEl) {
          const u = uriEl.getAttribute('data-uri');
          const match = decodeURIComponent(u).match(/^file:\\/\\/\\/([a-zA-Z]:\\/[^?#]+)/i);
          if (match) {
            let p = match[1].replace(/\\//g, '\\\\');
            return p.substring(0, p.lastIndexOf('\\\\'));
          }
        }
      } catch (e) {}
      return '';
    }

    // 智能异步解析完整绝对路径（向本地后台守护服务查询，毫秒级定位真实盘符）
    async function resolvePathAsync(chip, rawName, meta = {}) {
      if (!chip) return;
      const current = chip.getAttribute('data-full-path');
      if (isAbsoluteFilePath(current)) return;

      if (window.__antigravityPathMap[rawName] && isAbsoluteFilePath(window.__antigravityPathMap[rawName])) {
        const cached = window.__antigravityPathMap[rawName];
        chip.setAttribute('data-full-path', cached);
        chip.title = '完整本地绝对路径:\\n' + cached;
        return;
      }

      try {
        const wsPath = getCurrentWorkspacePath();
        const params = new URLSearchParams({
          name: rawName,
          size: String(meta.size || 0),
          lastModified: String(meta.lastModified || 0),
          dir: meta.isDirectory ? '1' : '0',
          workspace: wsPath || ''
        });

        const res = await fetch('http://127.0.0.1:29888/resolve?' + params.toString(), {
          signal: AbortSignal.timeout(2500)
        });

        if (res.ok) {
          const data = await res.json();
          if (data && data.success && data.fullPath && isAbsoluteFilePath(data.fullPath)) {
            chip.setAttribute('data-full-path', data.fullPath);
            chip.title = '完整本地绝对路径:\\n' + data.fullPath;
            window.__antigravityPathMap[rawName] = data.fullPath;
          }
        }
      } catch (e) {}
    }

    // Polyfill File.prototype.path 针对 Electron 41-44
    try {
      const getPathFn = (window.webUtils && window.webUtils.getPathForFile) || (window.electronNative && window.electronNative.getPathForFile);
      if (getPathFn && !('path' in File.prototype)) {
        Object.defineProperty(File.prototype, 'path', {
          get() {
            try { return getPathFn(this) || ''; } catch (e) { return ''; }
          },
          configurable: true
        });
      }
    } catch (e) {}

    // 安全彻底清理 Antigravity 原生全屏遮罩与“Drop to add to Agent”虚线框
    function dismissDropOverlay() {
      try {
        window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        window.dispatchEvent(new DragEvent('dragleave', { bubbles: true, relatedTarget: null }));
      } catch (e) {}

      try {
        const overlays = Array.from(document.querySelectorAll('*')).filter(el => {
          const text = el.textContent || '';
          const c = typeof el.className === 'string' ? el.className : '';
          return (
            (text.includes('to add to Agent') || text.includes('Drop to add') || text.includes('Upload to Agent') || text.includes('Drop files') || text.includes('Drop to upload')) &&
            (c.includes('z-[5000]') || c.includes('outline-dashed') || c.includes('fixed') || c.includes('absolute'))
          );
        });
        overlays.forEach(el => {
          try {
            el.style.display = 'none';
            el.remove();
          } catch (e) {}
        });
      } catch (e) {}
    }

    function getLexicalEditor() {
      const el = document.querySelector('[contenteditable="true"]');
      if (!el) return null;
      const reactKey = Object.keys(el).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
      let curr = reactKey ? el[reactKey] : null;
      while (curr) {
        if (curr.memoizedProps?.editor) {
          return curr.memoizedProps.editor;
        }
        curr = curr.return;
      }
      return null;
    }

    // 核心：Hook Lexical 状态序列化，在发送提问时附加真实物理绝对路径
    function ensureEditorHooked() {
      const editor = getLexicalEditor();
      if (!editor) return;

      if (!editor.__hasRegisteredUpdateListener && typeof editor.registerUpdateListener === 'function') {
        editor.__hasRegisteredUpdateListener = true;
        try {
          editor.registerUpdateListener(({ editorState }) => {
            editorState.read(() => {
              try {
                const root = editorState._nodeMap?.get('root') || (editor._editorState && editor._editorState._nodeMap?.get('root'));
                if (root) {
                  const text = root.getTextContent ? root.getTextContent().trim() : '';
                  if (text === '') {
                    const chips = document.querySelectorAll('[data-custom-chip="true"]');
                    if (chips.length > 0) {
                      chips.forEach(c => c.remove());
                      const bar = document.querySelector('#custom-attachment-bar');
                      if (bar) bar.remove();
                    }
                  }
                }
              } catch (e) {}
            });
          });
        } catch (e) {}
      }

      if (!editor.__origGetEditorState) {
        editor.__origGetEditorState = editor.getEditorState.bind(editor);
      }

      editor.getEditorState = function(...args) {
        const state = editor.__origGetEditorState(...args);
        if (!state) return state;

        const origToJSON = state.__origToJSON || state.toJSON.bind(state);
        state.__origToJSON = origToJSON;

        state.toJSON = function() {
          const json = origToJSON();
          if (json && json.root && Array.isArray(json.root.children)) {
            // 清理旧路径段落，避免重复
            json.root.children = json.root.children.filter(p => {
              const textNode = p.children?.find(c => typeof c.text === 'string' && c.text.includes('[附带本地文件/目录路径]:'));
              return !textNode;
            });

            const chips = Array.from(document.querySelectorAll('[data-custom-chip="true"]'));
            const paths = chips.map(c => {
              let p = c.getAttribute('data-full-path');
              if (!isAbsoluteFilePath(p) && window.__antigravityPathMap && window.__antigravityPathMap[p]) {
                p = window.__antigravityPathMap[p];
              }
              // 关键保障：必须是包含盘符的有效绝对路径才作为绝对路径附加！
              return isAbsoluteFilePath(p) ? p : null;
            }).filter(Boolean);

            if (paths.length > 0) {
              const pathString = '\\n[附带本地文件/目录路径]:\\n' + paths.join('\\n');
              json.root.children.push({
                type: 'paragraph',
                format: '',
                indent: 0,
                version: 1,
                direction: 'ltr',
                children: [
                  {
                    type: 'text',
                    text: pathString,
                    version: 1,
                    mode: 'normal',
                    style: '',
                    detail: 0,
                    format: 0
                  }
                ]
              });
            }
          }
          return json;
        };

        return state;
      };
    }

    function getOrCreateAttachmentBar() {
      const editable = document.querySelector('[contenteditable="true"]');
      if (!editable) return null;

      const existingAttachment = document.querySelector('[data-testid="input-attachment"]');
      if (existingAttachment && existingAttachment.parentElement) {
        return existingAttachment.parentElement;
      }

      let customBar = document.querySelector('#custom-attachment-bar');
      if (customBar) return customBar;

      let p3 = editable;
      while (p3 && !p3.className?.includes('rounded-lg') && p3.parentElement && p3.parentElement !== document.body) {
        p3 = p3.parentElement;
      }
      if (!p3 || !p3.parentElement) return null;

      customBar = document.createElement('div');
      customBar.id = 'custom-attachment-bar';
      customBar.className = 'flex items-center flex-wrap gap-1.5 border-b border-border p-1.5 animate-in fade-in duration-100';
      p3.parentElement.insertBefore(customBar, p3);
      return customBar;
    }

    // 渲染文件夹卡片：纯文件夹图标 + 目录名称 + 关闭按钮
    function renderFolderChip(displayName, fullPath, meta = {}) {
      const bar = getOrCreateAttachmentBar();
      if (!bar) return;

      const chip = document.createElement('div');
      chip.className = 'group relative inline-flex items-center rounded-md border bg-muted border-border select-none transition-all hover:bg-muted/80';
      chip.setAttribute('data-custom-chip', 'true');
      chip.setAttribute('data-full-path', fullPath);
      chip.title = isAbsoluteFilePath(fullPath) ? ('完整本地绝对路径:\\n' + fullPath) : displayName;

      chip.innerHTML = \`
        <div class="flex h-8 items-center pl-2.5 pr-6 gap-2 cursor-default rounded-md overflow-hidden">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="#f59e0b" stroke="#d97706" stroke-width="1.5" class="shrink-0">
            <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"></path>
          </svg>
          <span class="text-[11px] font-medium truncate max-w-[140px] text-foreground">\${displayName}</span>
        </div>
        <button style="position: absolute; right: 4px; top: 50%; transform: translateY(-50%); display: flex; align-items: center; justify-content: center; width: 15px; height: 15px; border-radius: 9999px; background: transparent; border: none; cursor: pointer;" class="hover:bg-accent/40 text-muted-foreground hover:text-foreground" type="button" aria-label="Remove \${displayName}">
          <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 -960 960 960" fill="currentColor">
            <path d="M256-213.85L213.85-256l224-224l-224-224L256-746.15l224,224l224-224L746.15-704l-224,224l224,224L704-213.85l-224-224l-224,224Z"></path>
          </svg>
        </button>
      \`;

      chip.querySelector('button').addEventListener('click', (e) => {
        e.stopPropagation();
        chip.remove();
        if (bar.children.length === 0 && bar.id === 'custom-attachment-bar') {
          bar.remove();
        }
        ensureEditorHooked();
      });

      bar.appendChild(chip);
      ensureEditorHooked();

      if (!isAbsoluteFilePath(fullPath)) {
        resolvePathAsync(chip, displayName, { ...meta, isDirectory: true });
      }
    }

    // 渲染通用文件卡片：彩色胶囊徽章 + 文件名称 + 关闭按钮
    function renderCustomChip(badgeText, badgeBgColor, displayName, fullPath, meta = {}) {
      const bar = getOrCreateAttachmentBar();
      if (!bar) return;

      const chip = document.createElement('div');
      chip.className = 'group relative inline-flex items-center rounded-md border bg-muted border-border select-none transition-all hover:bg-muted/80';
      chip.setAttribute('data-custom-chip', 'true');
      chip.setAttribute('data-full-path', fullPath);
      chip.title = isAbsoluteFilePath(fullPath) ? ('完整本地绝对路径:\\n' + fullPath) : displayName;

      chip.innerHTML = \`
        <div class="flex h-8 items-center pl-2 pr-6 gap-1.5 cursor-default rounded-md overflow-hidden">
          <div style="background-color: \${badgeBgColor}; color: #ffffff;" class="flex items-center justify-center rounded font-black uppercase tracking-wider px-1.5 h-4 min-w-[24px] text-[8px] leading-none shadow-xs">\${badgeText}</div>
          <span class="text-[11px] font-medium truncate max-w-[140px] text-foreground">\${displayName}</span>
        </div>
        <button style="position: absolute; right: 4px; top: 50%; transform: translateY(-50%); display: flex; align-items: center; justify-content: center; width: 15px; height: 15px; border-radius: 9999px; background: transparent; border: none; cursor: pointer;" class="hover:bg-accent/40 text-muted-foreground hover:text-foreground" type="button" aria-label="Remove \${displayName}">
          <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 -960 960 960" fill="currentColor">
            <path d="M256-213.85L213.85-256l224-224l-224-224L256-746.15l224,224l224-224L746.15-704l-224,224l224,224L704-213.85l-224-224l-224,224Z"></path>
          </svg>
        </button>
      \`;

      chip.querySelector('button').addEventListener('click', (e) => {
        e.stopPropagation();
        chip.remove();
        if (bar.children.length === 0 && bar.id === 'custom-attachment-bar') {
          bar.remove();
        }
        ensureEditorHooked();
      });

      bar.appendChild(chip);
      ensureEditorHooked();

      if (!isAbsoluteFilePath(fullPath)) {
        resolvePathAsync(chip, displayName, { ...meta, isDirectory: false });
      }
    }

    // 全格式智能色彩徽章匹配
    function getFileBadgeInfo(ext) {
      const e = (ext || '').toLowerCase();
      
      // 快捷方式
      if (e === 'lnk' || e === 'url') return { text: e.toUpperCase(), bg: '#4f46e5' };

      // 文档类
      if (e === 'pdf') return { text: 'PDF', bg: '#dc2626' };
      if (['doc', 'docx', 'wps', 'rtf', 'odt'].includes(e)) return { text: 'DOC', bg: '#2563eb' };
      if (['xls', 'xlsx', 'et', 'xlsm'].includes(e)) return { text: 'XLS', bg: '#059669' };
      if (['csv', 'tsv'].includes(e)) return { text: e.toUpperCase(), bg: '#059669' };
      if (['ppt', 'pptx', 'dps', 'odp'].includes(e)) return { text: 'PPT', bg: '#ea580c' };

      // 矢量图与图片
      if (e === 'svg') return { text: 'SVG', bg: '#f97316' };
      if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'tiff', 'tif', 'psd'].includes(e)) return { text: 'IMG', bg: '#db2777' };

      // 压缩包类
      if (['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'iso', 'cab', 'dmg', 'wim'].includes(e)) {
        return { text: 'ZIP', bg: '#9333ea' };
      }

      // 代码编程类
      if (['py', 'pyw', 'ipynb'].includes(e)) return { text: 'PY', bg: '#3b82f6' };
      if (['js', 'mjs', 'cjs'].includes(e)) return { text: 'JS', bg: '#d97706' };
      if (e === 'ts' || e === 'tsx') return { text: e.toUpperCase(), bg: '#2563eb' };
      if (e === 'jsx') return { text: 'JSX', bg: '#06b6d4' };
      if (e === 'html' || e === 'htm') return { text: 'HTML', bg: '#ea580c' };
      if (['css', 'scss', 'sass', 'less'].includes(e)) return { text: 'CSS', bg: '#0ea5e9' };
      if (e === 'json' || e === 'json5') return { text: 'JSON', bg: '#eab308' };
      if (e === 'yaml' || e === 'yml') return { text: 'YAML', bg: '#ef4444' };
      if (e === 'xml') return { text: 'XML', bg: '#f97316' };
      if (e === 'sql') return { text: 'SQL', bg: '#d97706' };
      if (['sh', 'bash', 'zsh', 'bat', 'cmd', 'ps1'].includes(e)) return { text: e.toUpperCase(), bg: '#0d9488' };
      if (e === 'c' || e === 'h') return { text: 'C', bg: '#2563eb' };
      if (['cpp', 'hpp', 'cc', 'cxx'].includes(e)) return { text: 'CPP', bg: '#2563eb' };
      if (e === 'cs') return { text: 'CS', bg: '#7c3aed' };
      if (e === 'java' || e === 'jar') return { text: 'JAVA', bg: '#dc2626' };
      if (e === 'go') return { text: 'GO', bg: '#0891b2' };
      if (e === 'rs') return { text: 'RS', bg: '#c2410c' };
      if (e === 'php') return { text: 'PHP', bg: '#6366f1' };
      if (e === 'rb') return { text: 'RB', bg: '#e11d48' };
      if (e === 'swift') return { text: 'SWIFT', bg: '#f97316' };
      if (e === 'kt' || e === 'kts') return { text: 'KT', bg: '#8b5cf6' };
      if (e === 'vue') return { text: 'VUE', bg: '#10b981' };
      if (e === 'md' || e === 'markdown') return { text: 'MD', bg: '#3b82f6' };
      if (e === 'txt') return { text: 'TXT', bg: '#64748b' };
      if (e === 'log') return { text: 'LOG', bg: '#52525b' };
      if (['ini', 'env', 'conf', 'config', 'toml', 'properties'].includes(e)) return { text: 'CFG', bg: '#71717a' };

      // 音视频媒体类
      if (['mp4', 'webm', 'mkv', 'avi', 'mov', 'wmv', 'flv'].includes(e)) return { text: 'VIDEO', bg: '#e11d48' };
      if (['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'opus'].includes(e)) return { text: 'AUDIO', bg: '#8b5cf6' };

      // 可执行程序
      if (['exe', 'msi', 'apk', 'appimage', 'deb', 'rpm', 'dll'].includes(e)) return { text: 'EXE', bg: '#0891b2' };

      if (e && e.length <= 4 && /^[a-z0-9]+$/i.test(e)) {
        return { text: e.toUpperCase(), bg: '#64748b' };
      }

      return { text: 'FILE', bg: '#64748b' };
    }

    // 原生支持预览的纯图片扩展名
    const NATIVE_IMAGE_PREVIEW_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

    function setupHook() {
      // 阻止 Chromium 默认的文件导航
      window.addEventListener('dragenter', (e) => {
        if (!e.isTrusted) return;
        e.preventDefault();
      }, true);

      window.addEventListener('dragover', (e) => {
        if (!e.isTrusted) return;
        e.preventDefault();
        if (e.dataTransfer) {
          e.dataTransfer.dropEffect = 'copy';
        }
      }, true);

      window.addEventListener('dragleave', (e) => {
        if (!e.isTrusted) return;
        if (e.relatedTarget === null) {
          dismissDropOverlay();
          setTimeout(dismissDropOverlay, 50);
        }
      }, true);

      // 发送后自动清理卡片
      function clearCustomChipsAfterSend() {
        setTimeout(() => {
          const chips = document.querySelectorAll('[data-custom-chip="true"]');
          chips.forEach(c => c.remove());
          const bar = document.querySelector('#custom-attachment-bar');
          if (bar) bar.remove();
        }, 150);
      }

      window.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          if (e.target && (e.target.closest?.('[contenteditable="true"]') || e.target.tagName === 'INPUT')) {
            clearCustomChipsAfterSend();
          }
        }
      }, true);

      window.addEventListener('click', (e) => {
        const btn = e.target.closest?.('button');
        if (btn) {
          const tooltip = btn.getAttribute('data-tooltip-id') || '';
          const aria = btn.getAttribute('aria-label') || '';
          const cls = typeof btn.className === 'string' ? btn.className : '';
          if (tooltip.includes('input-send') || aria.toLowerCase().includes('send') || cls.includes('bg-primary')) {
            clearCustomChipsAfterSend();
          }
        }
      }, true);

      window.addEventListener('focusin', () => {
        ensureEditorHooked();
        dismissDropOverlay();
      }, true);

      // 全局拖拽拦截处理：无论拖入任何文件，一律生成带绝对路径的卡片
      window.addEventListener('drop', (e) => {
        if (!e.isTrusted) return;
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        dismissDropOverlay();
        setTimeout(dismissDropOverlay, 30);
        setTimeout(dismissDropOverlay, 150);

        ensureEditorHooked();

        if (!e.dataTransfer) return;

        const items = e.dataTransfer.items ? Array.from(e.dataTransfer.items) : [];
        const files = e.dataTransfer.files ? Array.from(e.dataTransfer.files) : [];

        if (files.length === 0 && items.length === 0) return;

        const fileInput = document.querySelector('input[type="file"]');
        const nativePreviewImages = [];

        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          const item = items[i];
          const fileName = file.name || 'file';
          
          // 尝试提取绝对物理路径
          let filePath = '';
          if (window.webUtils && typeof window.webUtils.getPathForFile === 'function') {
            try { filePath = window.webUtils.getPathForFile(file); } catch (err) {}
          }
          if (!filePath && window.electronNative && typeof window.electronNative.getPathForFile === 'function') {
            try { filePath = window.electronNative.getPathForFile(file); } catch (err) {}
          }
          if (!filePath && file && file.path && isAbsoluteFilePath(file.path)) {
            filePath = file.path;
          }
          if (!filePath && window.__antigravityPathMap && window.__antigravityPathMap[fileName]) {
            filePath = window.__antigravityPathMap[fileName];
          }
          if (!filePath) {
            filePath = fileName;
          }

          const ext = (fileName.split('.').pop() || '').toLowerCase();
          const isShortcut = ext === 'lnk' || ext === 'url';

          let isDirectory = false;
          if (!isShortcut) {
            try {
              const entry = item && typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
              if (entry) {
                isDirectory = entry.isDirectory;
              } else {
                isDirectory = !file.type && !fileName.includes('.');
              }
            } catch (err) {
              isDirectory = false;
            }
          }

          const fileMeta = {
            size: file.size || 0,
            lastModified: file.lastModified || 0,
            isDirectory
          };

          // 1. 文件夹：渲染专属文件夹卡片
          if (isDirectory) {
            renderFolderChip(fileName, filePath, fileMeta);
            continue;
          }

          // 2. 快捷方式：专属 LNK 徽章卡片
          if (isShortcut) {
            renderCustomChip(ext.toUpperCase(), '#4f46e5', fileName, filePath, fileMeta);
            continue;
          }

          // 3. 所有其它文件（包括 PDF、DOCX、代码、TXT、音视频等）：一律渲染专属彩色胶囊卡片
          const badgeInfo = getFileBadgeInfo(ext);
          renderCustomChip(badgeInfo.text, badgeInfo.bg, fileName, filePath, fileMeta);

          // 4. 对小体积图片同时推给原生 input，保留官方原生图片预览框
          if (NATIVE_IMAGE_PREVIEW_EXTS.has(ext) && file.size <= 2097152) {
            nativePreviewImages.push(file);
          }
        }

        ensureEditorHooked();

        // 仅把纯图片推给原生进行预览
        if (nativePreviewImages.length > 0 && fileInput) {
          try {
            const dt = new DataTransfer();
            for (const f of nativePreviewImages) {
              dt.items.add(f);
            }
            fileInput.files = dt.files;
            fileInput.dispatchEvent(new Event('change', { bubbles: true }));
          } catch (err) {}
        }

        const editable = document.querySelector('[contenteditable="true"]');
        if (editable) editable.focus();
      }, true);

      window.__antigravityRenderCustomChip = renderCustomChip;
      window.__antigravityRenderFolderChip = renderFolderChip;
      window.__antigravityGetFileBadgeInfo = getFileBadgeInfo;
      window.__antigravityEnsureEditorHooked = ensureEditorHooked;
      window.__antigravityDismissDropOverlay = dismissDropOverlay;

      ensureEditorHooked();
      dismissDropOverlay();

      console.log('[Antigravity] 拖拽绝对路径增强脚本 (v10) 已就绪。');
    }

    setupHook();
  })();
`;

async function cdpCall(ws, method, params = {}) {
  const id = Math.floor(Math.random() * 1000000);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${method} timeout`));
    }, 3000);

    function onMessage(event) {
      try {
        const msg = JSON.parse(event.data);
        if (msg.id === id) {
          cleanup();
          resolve(msg.result);
        }
      } catch (err) {
        cleanup();
        reject(err);
      }
    }
    function onError(err) { cleanup(); reject(err); }
    function onClose() { cleanup(); reject(new Error('WebSocket closed')); }

    function cleanup() {
      clearTimeout(timer);
      ws.removeEventListener('message', onMessage);
      ws.removeEventListener('error', onError);
      ws.removeEventListener('close', onClose);
    }

    ws.addEventListener('message', onMessage);
    ws.addEventListener('error', onError);
    ws.addEventListener('close', onClose);

    try {
      ws.send(JSON.stringify({ id, method, params }));
    } catch (e) {
      cleanup();
      reject(e);
    }
  });
}

async function installPermanentHook() {
  const port = getDevToolsPort();
  if (!port) {
    console.error('Antigravity DevToolsActivePort not found.');
    return;
  }
  console.log(`Detected Antigravity CDP Port: ${port}`);

  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  const pages = await res.json();
  const page = pages.find(p => p.type === 'page');
  if (!page) {
    console.error('No active Antigravity page found.');
    return;
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('ws connect timeout')), 2000);
    ws.onopen = () => { clearTimeout(t); resolve(); };
    ws.onerror = (e) => { clearTimeout(t); reject(e); };
  });

  try {
    await cdpCall(ws, 'Page.enable').catch(() => {});
    await cdpCall(ws, 'Page.addScriptToEvaluateOnNewDocument', { source: HOOK_SCRIPT }).catch(() => {});
    await cdpCall(ws, 'Runtime.evaluate', { expression: HOOK_SCRIPT, returnByValue: true });
    console.log('Hook v10 successfully registered and activated on current page!');
  } finally {
    try { ws.close(); } catch {}
  }
}

if (require.main === module) {
  installPermanentHook().catch(console.error);
}

module.exports = { HOOK_SCRIPT, getDevToolsPort, cdpCall };
