const { execSync } = require('child_process');

function removeRegistry() {
  try {
    const psCmd = `Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'AntigravityFilePlugin' -ErrorAction SilentlyContinue`;
    execSync(`powershell -NoProfile -Command "${psCmd}"`, { stdio: 'inherit' });
    console.log('已成功移除开机自启项: AntigravityFilePlugin');
  } catch (err) {
    console.error('移除自启项失败:', err.message);
  }
}

removeRegistry();
