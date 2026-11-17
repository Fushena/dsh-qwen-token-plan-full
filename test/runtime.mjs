import { registerHooks, createRequire } from 'node:module';
const root = process.env.DSH_TEST_RUNTIME ?? '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh';
const runtimeRequire = createRequire(`${root}/package.json`);
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('@deepseek-ai/')) {
    try { return next(specifier, context); }
    catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
      return next(new URL(`file://${runtimeRequire.resolve(specifier)}`).href, context);
    }
  }
  return next(specifier, context);
} });
