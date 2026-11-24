/**
 * 构建 Windows 安装包并发布到 GitHub Releases。
 *
 * 为什么输出目录必须放在系统临时目录：
 * 本项目位于 Documents 工作区，工作区的文件监控会持有刚写入文件的句柄。
 * Windows 不允许给「含有已打开文件的目录」改名，而 electron-builder 在收尾阶段
 * 需要把 win-unpacked.tmp 改名为 win-unpacked；它会先撞上
 * resources/default_app.asar 的 EBUSY（共享冲突），在目录这一层就表现为
 * EPERM: operation not permitted, rename 'win-unpacked.tmp' -> 'win-unpacked'。
 * 实测这个失败是恒定的，不是杀毒软件偶发扫描。把输出挪出工作区即可绕过。
 *
 * 因此这里用 os.tmpdir() 覆盖 directories.output，而不是写死 release/。
 * 工作区还可能向 EXE 继承 Low 完整性标签，造成 NSIS 临时写入失败或
 * Electron 静默退出。测试时直接运行工作区外的原始产物，不复制回 release/。
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const { Arch, build, Platform } = require('electron-builder');

const outputDir = path.resolve(process.env.ORBIT_BUILD_OUTPUT || path.join(os.tmpdir(), 'orbit-build'));

function assertSafeCleanTarget(targetDir) {
  const resolved = path.resolve(targetDir);
  const root = path.parse(resolved).root;
  const home = path.resolve(os.homedir());
  const cwd = path.resolve(process.cwd());
  const tmpRoot = path.resolve(os.tmpdir());
  if (resolved === root || resolved === home || resolved === cwd || resolved === tmpRoot) {
    throw new Error(`拒绝清理受保护目录：${resolved}`);
  }
  const insideTmp = resolved.toLowerCase().startsWith(`${tmpRoot.toLowerCase()}${path.sep}`);
  const baseName = path.basename(resolved).toLowerCase();
  if (!insideTmp && !baseName.includes('orbit-build') && !baseName.includes('release')) {
    throw new Error(`拒绝清理非构建输出目录：${resolved}`);
  }
}

function cleanReleaseOutputDir(targetDir) {
  assertSafeCleanTarget(targetDir);
  if (existsSync(targetDir)) {
    console.log(`[release] 清理旧构建产物：${targetDir}`);
    rmSync(targetDir, { recursive: true, force: true });
  }
  mkdirSync(targetDir, { recursive: true });
}

// electron-builder 只识别 GH_TOKEN/GITHUB_TOKEN；日常 git push 则通常由
// Windows Git Credential Manager 代管。两边原本互不相通，会出现代码能推送、
// 制品却在最后一步报“token 未设置”。发布前把同一份凭据只注入当前 Node 进程，
// 不写磁盘、不打印到日志。
async function tokenFromGitCredential() {
  return new Promise(resolve => {
    let settled = false;
    const finish = value => { if (!settled) { settled = true; resolve(value); } };
    try {
      const child = spawn('git', ['credential', 'fill'], { stdio: ['pipe', 'pipe', 'ignore'] });
      let output = '';
      child.stdout.on('data', chunk => { output += chunk.toString('utf8'); });
      child.on('error', () => finish(''));
      child.on('close', () => finish(((output.match(/^password=(.*)$/m) || [])[1] || '').trim()));
      const timer = setTimeout(() => { try { child.kill(); } catch { /* already closed */ } finish(''); }, 25000);
      child.on('close', () => clearTimeout(timer));
      child.stdin.end('protocol=https\nhost=github.com\n\n');
    } catch { finish(''); }
  });
}

if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
  process.env.GH_TOKEN = await tokenFromGitCredential();
}
if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
  throw new Error('缺少 GitHub 发布凭据：请先登录 Git Credential Manager 或设置 GH_TOKEN');
}

cleanReleaseOutputDir(outputDir);
console.log(`[release] 输出目录（工作区外）：${outputDir}`);

await build({
  // Older updaters expect an installer filename without an architecture suffix.
  // Publish just the x64 build so the installer name stays unambiguous.
  targets: Platform.WINDOWS.createTarget(['nsis', 'portable', 'zip'], Arch.x64),
  config: {
    directories: { output: outputDir },
  },
  publish: 'always',
});

console.log(`[release] 完成，产物位于 ${outputDir}`);
