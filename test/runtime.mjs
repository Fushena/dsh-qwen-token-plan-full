import { registerHooks, createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const root = process.env.DSH_TEST_RUNTIME ?? '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh';
const runtimeRequire = createRequire(`${root}/package.json`);
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('@deepseek-ai/')) {
    try { return next(specifier, context); }
    catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
      // pathToFileURL 而非 `file://${path}` 拼接：Windows 绝对路径拼出来是
      // file://C:\… （协议被解析成 c:），ESM loader 直接拒载（2026-11-17 实测）。
      return next(pathToFileURL(runtimeRequire.resolve(specifier)).href, context);
    }
  }
  return next(specifier, context);
} });
