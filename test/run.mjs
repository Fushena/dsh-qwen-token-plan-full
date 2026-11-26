import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const electron = process.env.DSH_TEST_NODE ?? '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness';
const executable = existsSync(electron) ? electron : process.execPath;
// 逐文件串行 spawn + 相对路径 + 固定 cwd（2026-11-17 Windows 实测的唯一全绿组合）：
// - 绝对 Windows 路径当 argv：ESM loader 把盘符当协议（c:）拒载；
// - file:// URL 当 argv：含非 ASCII 目录时百分号编码让 runner 的存在性检查找不到文件；
// - 一次 --test 多文件：child 进程同样踩 c: 坑。
// 相对路径避开 drive letter 与编码两坑；cwd 锁定仓库根，与手工单跑等价。
const root = fileURLToPath(new URL('..', import.meta.url));
const files = ['compat.test.js', 'relogin.test.js', 'stream.test.js', 'tier-retry.test.js', 'route-guard.test.mjs', 'model-display.test.mjs', 'catalog-feed.test.mjs', 'observer.test.mjs', 'capability-probe.test.js', 'config-knobs.test.js', 'stream-resilience.test.js', 'probe-integrity.test.js', 'media-safety.test.js', 'budget-merge.test.js', 'mcp-equity.test.js', 'quota-layers.test.js', 'tts.test.js', 'audit-medium-low.test.js', 'deep-audit-fixes.test.js'];
let failed = 0;
for (const file of files) {
  const result = spawnSync(executable, ['--import', './test/runtime.mjs', '--test', `./test/${file}`], {
    cwd: root, stdio: 'inherit', env: { ...process.env, ...(executable === process.execPath ? {} : { ELECTRON_RUN_AS_NODE: '1' }) },
  });
  if (result.error) console.error(result.error.message);
  if ((result.status ?? 1) !== 0) failed += 1;
}
process.exitCode = failed === 0 ? 0 : 1;
