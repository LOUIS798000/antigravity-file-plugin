const path = require('path');
const { execSync } = require('child_process');

function setupRegistry() {
  const vbsPath = path.resolve(__dirname, '后台静默启动.vbs');
  const targetValue = `"C:\\WINDOWS\\System32\\wscript.exe" //B //Nologo "${vbsPath}"`;

  try {
    const psCmd = `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'AntigravityFilePlugin' -Value '${targetValue.replace(/'/g, "''")}'`;
    execSync(`powershell -NoProfile -Command "${psCmd}"`, { stdio: 'inherit' });
    console.log('已设置 Windows 开机自启项: AntigravityFilePlugin');
  } catch (err) {
    console.error('设置自启项失败:', err.message);
  }
}

setupRegistry();

