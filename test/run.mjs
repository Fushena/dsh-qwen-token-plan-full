import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const electron = process.env.DSH_TEST_NODE ?? '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness';
const executable = existsSync(electron) ? electron : process.execPath;
const result = spawnSync(executable, ['--import', fileURLToPath(new URL('./runtime.mjs', import.meta.url)), '--test', fileURLToPath(new URL('./compat.test.js', import.meta.url)), fileURLToPath(new URL('./relogin.test.js', import.meta.url)), fileURLToPath(new URL('./stream.test.js', import.meta.url)), fileURLToPath(new URL('./route-guard.test.mjs', import.meta.url))], {
  stdio: 'inherit', env: { ...process.env, ...(executable === process.execPath ? {} : { ELECTRON_RUN_AS_NODE: '1' }) },
});
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
