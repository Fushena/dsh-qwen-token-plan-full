import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { trustedRouteRequest, isLoopbackHostname, hostnameOf } from '../lib/route-guard.js';
import { download, assertDownloadUrl, isPrivateHostLiteral } from '../lib/media-tools.js';

// 这些用例复刻 2026-11-10 实测的攻击面：DSH 的 prefix 路由不做鉴权，
// 旧守卫把 Origin 与 Host 自比 → DNS rebinding 直接 200。
const BIND = '127.0.0.1'; // ctx.get("webServer").host 的典型值
const req = (headers) => ({ headers });

test('route guard: loopback and bind hosts are allowed', () => {
  assert.equal(trustedRouteRequest(req({ host: '127.0.0.1:49419' }), BIND), true, '① 127.0.0.1 无其他头');
  assert.equal(trustedRouteRequest(req({ host: 'localhost:49419' }), BIND), true, '② localhost');
  assert.equal(trustedRouteRequest(req({ host: '[::1]:49419' }), BIND), true, '③ [::1]');
  assert.equal(trustedRouteRequest(req({ host: '127.0.0.2:49419' }), BIND), true, '127.0.0.0/8 其余地址');
  // 绑定地址不是回环时（例如绑定具体网卡），它自己也算可信。
  assert.equal(trustedRouteRequest(req({ host: '192.0.2.5:49419' }), '192.0.2.5'), true, '等于 bind 地址');
  // 无 Host 时绝不因为"没有头"而放行。
  assert.equal(trustedRouteRequest(req({}), BIND), false, '⑩ Host 缺失');
});

test('route guard: DNS rebinding (Origin === Host self-compare) is rejected', () => {
  // 修前实测：curl -H "Host: evil.example:49419" -H "Origin: http://evil.example:49419" → 200。
  assert.equal(
    trustedRouteRequest(req({ host: 'evil.example:49419', origin: 'http://evil.example:49419' }), BIND),
    false,
    '④ 攻击者同时控制 Host 与 Origin，旧实现自比成功 → 必须拒绝',
  );
  assert.equal(trustedRouteRequest(req({ host: 'evil.example:49419' }), BIND), false, '⑤ 非 loopback Host 无 Origin 也拒绝');
  assert.equal(trustedRouteRequest(req({ host: 'evil.example:49419', origin: 'null' }), BIND), false, 'Host 本身就不可信');
});

test('route guard: browser cross-site signals are rejected', () => {
  assert.equal(
    trustedRouteRequest(req({ host: '127.0.0.1:49419', origin: 'http://evil.example' }), BIND),
    false,
    '⑥ loopback Host + 非 loopback Origin → 拒绝（origin 走同一套判定，不与 Host 自比）',
  );
  assert.equal(
    trustedRouteRequest(req({ host: '127.0.0.1:49419', 'sec-fetch-site': 'cross-site' }), BIND),
    false,
    '⑦ Sec-Fetch-Site: cross-site → 拒绝',
  );
  assert.equal(
    trustedRouteRequest(req({ host: '127.0.0.1:49419', 'sec-fetch-site': 'cross-site', origin: 'http://evil.example' }), BIND),
    false,
    '⑦b 跨站头 + 坏 Origin',
  );
  assert.equal(
    trustedRouteRequest(req({ host: '127.0.0.1:49419', origin: 'null' }), BIND),
    false,
    '⑨ Origin: null（沙箱 iframe/本地文件）→ 拒绝',
  );
});

test('route guard: same-site pages on OTHER local ports are rejected (Origin must match scheme+host+port)', () => {
  // 回归（2026-11-13）：旧 c) 只比 Origin 的 hostname，丢协议与端口 →
  // 本机 8080 端口的任意页面（浏览器标 sec-fetch-site: same-site）能对 49419 的
  // /login 等副作用路由发 CSRF。Origin 必须与请求自身的完整 origin 一致。
  assert.equal(
    trustedRouteRequest(req({ host: '127.0.0.1:49419', origin: 'http://127.0.0.1:8080', 'sec-fetch-site': 'same-site' }), BIND),
    false,
    '同 hostname 不同端口 → 拒绝（现漏洞：trusted=true）',
  );
  assert.equal(
    trustedRouteRequest(req({ host: 'localhost:49419', origin: 'http://127.0.0.1:49419', 'sec-fetch-site': 'same-site' }), BIND),
    false,
    'localhost 与 127.0.0.1 是不同 origin（same-site）→ 拒绝',
  );
  assert.equal(
    trustedRouteRequest(req({ host: '127.0.0.1:49419', origin: 'https://127.0.0.1:49419' }), BIND),
    false,
    '协议不同（https vs 本机 http 服务）→ 拒绝',
  );
  // 合法同源必须仍放行：完整一致；默认端口写法归一化后一致。
  assert.equal(
    trustedRouteRequest(req({ host: '127.0.0.1:49419', origin: 'http://127.0.0.1:49419', 'sec-fetch-site': 'same-origin' }), BIND),
    true,
    '完整同源 → 放行',
  );
  assert.equal(
    trustedRouteRequest(req({ host: '127.0.0.1:80', origin: 'http://127.0.0.1' }), BIND),
    true,
    '默认端口归一化（:80 与省略等价）→ 放行',
  );
});

test('route guard: desktop proxy and browser same-origin traffic keeps working', () => {
  // dsh-app:// 代理转发（main.js forwardWebRequest）注入了 sec-fetch-site: same-origin。
  assert.equal(
    trustedRouteRequest(req({ host: '127.0.0.1:49419', 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:49419' }), BIND),
    true,
    '⑧ 同源 Origin + same-origin → 允许',
  );
  // 浏览器直连本机：sec-fetch-site 为 none 或 same-origin。
  assert.equal(trustedRouteRequest(req({ host: '127.0.0.1:49419', 'sec-fetch-site': 'none' }), BIND), true, 'none 放行（已过 Host 栅栏）');
  assert.equal(trustedRouteRequest(req({ host: 'localhost:49419', 'sec-fetch-site': 'same-origin' }), BIND), true, 'same-origin 放行');
  // 本机进程 curl：无 Origin、无 sec-fetch-site → 放行（同 uid 本在同一信任域）。
  assert.equal(trustedRouteRequest(req({ host: '127.0.0.1:49419' }), BIND), true, '本机进程放行');
});

test('route guard: garbage hosts are rejected', () => {
  assert.equal(trustedRouteRequest(req({ host: '' }), BIND), false, '⑩ 空 Host');
  assert.equal(trustedRouteRequest(req({ host: 'not a host' }), BIND), false, '无法解析的 Host');
  assert.equal(trustedRouteRequest(req({ host: '127.0.0.1:49419:0' }), BIND), false, '畸形端口');
  assert.equal(trustedRouteRequest(req({ host: 'evil.example:49419', origin: 'http://127.0.0.1:49419' }), BIND), false, 'Origin 可信但 Host 不可信');
  assert.equal(isLoopbackHostname('127.0.0.1'), true);
  assert.equal(isLoopbackHostname('::1'), true);
  assert.equal(isLoopbackHostname('localhost'), true);
  assert.equal(isLoopbackHostname('128.0.0.1'), false);
  assert.equal(isLoopbackHostname('127.0.0.999'), false);
  assert.equal(hostnameOf('127.0.0.1:49419'), '127.0.0.1');
  assert.equal(hostnameOf('http://evil.example:49419'), 'evil.example');
});

test('media download: non-https, private, and oversized results are refused', async () => {
  // 下载产物必须落在临时目录：这个用例真的会写文件，不能污染 test/。
  const dir = mkdtempSync(path.join(os.tmpdir(), 'qtpf-dl-'));
  const okFetch = async () => new Response('x', { headers: { 'content-type': 'image/png' } });
  try {

  // 协议：只允许 https。
  await assert.rejects(download(okFetch, 'http://example.invalid/a.png', dir, 'qwen-image', 'png'), /非 https/);
  await assert.rejects(download(okFetch, 'file:///etc/passwd', dir, 'qwen-image', 'png'), /非 https/);
  // 主机：本机/内网字面量（SSRF 面）。
  for (const host of ['127.0.0.1', 'localhost', '10.0.0.5', '172.20.0.1', '192.168.1.1', '169.254.1.1', '0.0.0.0', '[::1]']) {
    await assert.rejects(download(okFetch, `https://${host}/a.png`, dir, 'qwen-image', 'png'), /本机\/内网/, `应拒绝 ${host}`);
  }
  // 合法公网 https 地址可下载（example.invalid 不在黑名单内）。
  const saved = await download(okFetch, 'https://example.invalid/a.png', dir, 'qwen-image', 'png');
  assert.equal(saved.bytes, 1);

  // 大小上限：content-length 预检即拒绝（不读流）。
  const bigDeclared = async () => new Response('small', { headers: { 'content-type': 'image/png', 'content-length': String(50 * 1024 * 1024) } });
  await assert.rejects(download(bigDeclared, 'https://example.invalid/big.png', dir, 'qwen-image', 'png'), /过大/);
  // 流式累积超限：content-length 不可信时也不能全量进内存，超限立刻中断。
  const hugeStream = async () => new Response(new ReadableStream({
    start(c) {
      for (let i = 0; i < 600; i++) c.enqueue(new Uint8Array(1024));
      c.close();
    },
  }), { headers: { 'content-type': 'image/png' } });
  await assert.rejects(
    download(hugeStream, 'https://example.invalid/huge.png', dir, 'qwen-image', 'png', undefined, 64 * 1024),
    /超过大小上限/,
  );
  // URL 校验函数本身也要能被单独断言。
  assert.throws(() => assertDownloadUrl('http://127.0.0.1/x.png'), /非 https/);
  assert.equal(assertDownloadUrl('https://example.invalid/x.png').hostname, 'example.invalid');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('media download: IPv6 private literals (mapped / ULA / link-local) are refused', async () => {
  // 回归（2026-11-13 审计）：旧 isPrivateHostLiteral 只认 ::1/:: 与 IPv4 四段，
  // IPv4-mapped IPv6、ULA fc00::/7、链路本地 fe80::/10 全部漏过。
  // 注意 new URL 会把 ::ffff:127.0.0.1 规范化成 [::ffff:7f00:1]，两种写法都要拦。
  const dir = mkdtempSync(path.join(os.tmpdir(), 'qtpf-dl-'));
  const okFetch = async () => new Response('x', { headers: { 'content-type': 'image/png' } });
  try {
    for (const host of [
      '[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[0:0:0:0:0:ffff:7f00:1]',
      '[::ffff:10.0.0.5]', '[::ffff:192.168.1.1]',
      '[::127.0.0.1]', '[::7f00:1]',
      '[fc00::1]', '[fd12:3456::1]', '[fe80::1]', '[fec0::1]',
    ]) {
      await assert.rejects(download(okFetch, `https://${host}/a.png`, dir, 'qwen-image', 'png'), /本机\/内网/, `应拒绝 ${host}`);
    }
    // 公网 IPv6 与 mapped 公网地址不得误伤。
    assert.equal(isPrivateHostLiteral('2606:4700::1111'), false);
    assert.equal(isPrivateHostLiteral('2001:4860:4860::8888'), false);
    assert.equal(isPrivateHostLiteral('::ffff:8.8.8.8'), false);
    const saved = await download(okFetch, 'https://[2606:4700::1111]/a.png', dir, 'qwen-image', 'png');
    assert.equal(saved.bytes, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('media download: redirects are re-validated hop by hop (302 to loopback is refused)', async () => {
  // 回归（2026-11-13 审计）：旧 download 用默认 redirect:follow，上游 302 →
  // http://127.0.0.1/… 时校验只在第一跳做过，内网响应体被直接读走。
  // 这里用真实 fetch（undici 默认跟随重定向）+ 回环服务器模拟被投毒的上游：
  // 公网 https 地址的应答实际来自本地服务器。全程只碰 127.0.0.1，不出网。
  const dir = mkdtempSync(path.join(os.tmpdir(), 'qtpf-dl-'));
  const srv = http.createServer((req, res) => {
    const port = srv.address().port;
    if (req.url === '/a.png') { res.writeHead(302, { location: `http://127.0.0.1:${port}/internal` }); res.end(); return; }
    if (req.url === '/b.png') { res.writeHead(302, { location: 'https://10.0.0.5/x.png' }); res.end(); return; }
    if (req.url === '/loop.png') { res.writeHead(302, { location: 'https://cdn.example.invalid/loop.png' }); res.end(); return; }
    if (req.url === '/ok.png') { res.writeHead(302, { location: 'https://cdn.example.invalid/final.png' }); res.end(); return; }
    if (req.url === '/final.png') { res.writeHead(200, { 'content-type': 'image/png' }); res.end('IMG'); return; }
    res.writeHead(200, { 'content-type': 'image/png' }); res.end('SECRET-INTERNAL');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const poisonedFetch = (url, opts) => fetch(`http://127.0.0.1:${port}${new URL(String(url)).pathname}`, opts);
  try {
    // 攻击用例在前：修复前第一条就会读到 SECRET-INTERNAL 而失败（不会走到后面的 DNS）。
    await assert.rejects(
      download(poisonedFetch, 'https://cdn.example.invalid/a.png', dir, 'qwen-image', 'png'),
      /非 https|本机\/内网|重定向/,
      '302 → http://127.0.0.1 必须拒绝，不得跟随后读走内网响应体',
    );
    await assert.rejects(
      download(poisonedFetch, 'https://cdn.example.invalid/b.png', dir, 'qwen-image', 'png'),
      /本机\/内网/,
      '302 → https://10.0.0.5（内网 https）同样必须拒绝',
    );
    await assert.rejects(
      download(poisonedFetch, 'https://cdn.example.invalid/loop.png', dir, 'qwen-image', 'png'),
      /重定向/,
      '无限重定向必须有跳数上限',
    );
    // 合法 https→https 公网重定向仍要能手动跟随下载。
    const saved = await download(poisonedFetch, 'https://cdn.example.invalid/ok.png', dir, 'qwen-image', 'png');
    assert.equal(saved.bytes, 3);
  } finally { srv.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('index.js wires the guard in front of every route branch', () => {
  // 回归：旧 index.js 用 sameOriginOnly()（Origin 与 Host 自比）。现在守卫必须
  // 在 handler 的第一行、任何 json(200) 之前执行，否则 prefix 路由仍然裸奔。
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /sameOriginOnly/, 'index.js 不得再用自比式的 sameOriginOnly');
  assert.match(source, /import\s*\{\s*trustedRouteRequest\s*\}\s*from\s*"\.\/lib\/route-guard\.js"/, '必须引入 route-guard');
  assert.match(source, /if\s*\(\s*!trusted\(req\)\s*\)\s*return\s*json\(res,\s*403/);
  // 403 在 handler 最前：出现在第一个 200 分支之前。
  const handlerAt = source.indexOf('async handler(req, res)');
  const guardAt = source.indexOf('!trusted(req)', handlerAt);
  const firstOk = source.indexOf('json(res, 200', handlerAt);
  assert.ok(handlerAt >= 0 && guardAt > handlerAt, '守卫必须在 handler 内');
  assert.ok(firstOk > guardAt, '守卫必须早于任何 200 响应');
  // bindHost 取自 webServer.host（不是请求头）。
  assert.match(source, /server\?\.host/);
});

test('proxy: undici is never resolved from the launch working directory', () => {
  // 回归：旧 loadUndici 的候选里有 cwd → 从任意启动目录加载 undici = 宿主 RCE。
  const source = readFileSync(new URL('../lib/proxy.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /process\s*\.\s*cwd/, 'lib/proxy.js 不得再使用 process.cwd()');
  assert.match(source, /DSH_PROFILE_DIR/, '仍保留 profile 目录候选');
  assert.match(source, /profiles/, '仍保留 DSH_HOME/profiles/desktop 候选');
});
