import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 跨平台 HOME 隔离：Unix 的 os.homedir() 读 HOME，Windows 读 USERPROFILE
 * （libuv uv_os_homedir）。只覆盖 HOME 时 Windows 上插件仍写真实 home、测试读
 * 临时目录——断言失败之外还会污染真实 ~/.dsh/.env 与预算文件（2026-11-17 实测）。
 * 两个变量同时覆盖、同时还原；临时目录用完即删。
 */
export function isolateHome(prefix = 'qtpf-home-') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return {
    home,
    restore() {
      for (const key of ['HOME', 'USERPROFILE']) {
        if (prev[key] === undefined) delete process.env[key]; else process.env[key] = prev[key];
      }
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}
