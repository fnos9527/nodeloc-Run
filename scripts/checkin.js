/**
 * NodeLoc 每日自动签到脚本
 * 流程：用 Cookie 登录（失败且配置了账号密码时，再用账号密码登录）
 *      -> 调用网站签到接口 /api/v1/checkin（和点日历图标一样）
 *      -> 登录成功时导出最新 Cookie（由工作流保存回 Secret，下次自动使用）
 *      -> 通过 Telegram 通知结果
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const NODELOC_COOKIE = (process.env.NODELOC_COOKIE || '').trim();
const NODELOC_USER = process.env.NODELOC_USER;
const NODELOC_PASS = process.env.NODELOC_PASS;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

const SITE = 'https://www.nodeloc.com';
const ROOT = path.join(__dirname, '..');
const DEBUG_DIR = path.join(ROOT, 'debug');
const COOKIE_OUT = path.join(ROOT, 'cookie_new.txt'); // 不在 debug 目录里，不会被上传成产物
if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });

// Cloudflare 的这两个 Cookie 和你电脑的 IP / 浏览器绑定，带到 GitHub 上反而可能被拦，导入时跳过
const SKIP_COOKIES = new Set(['cf_clearance', '__cf_bm']);

async function sendTelegram(text) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
    console.log('未配置 Telegram Secrets，跳过通知。消息内容：\n' + text);
    return;
  }
  try {
    const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: 'HTML' }),
    });
    if (!res.ok) console.error('Telegram 通知发送失败:', await res.text());
  } catch (e) {
    console.error('Telegram 通知发送异常:', e.message);
  }
}

/** 把浏览器里复制的 "a=1; b=2" 字符串转成 Playwright 的 cookie 列表 */
function parseCookieString(str) {
  // 兼容整行复制，例如 "Cookie: a=1; b=2" 或带引号
  str = str.replace(/^cookie\s*:\s*/i, '').replace(/^["']|["']$/g, '');
  const list = [];
  for (const part of str.split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (!name || SKIP_COOKIES.has(name)) continue;
    list.push({ name, value, domain: 'www.nodeloc.com', path: '/', secure: true, sameSite: 'Lax' });
  }
  return list;
}

/** 用网站自己的接口 /api/v1/me 判断是否已登录，返回用户名；未登录返回 null */
async function currentUser(page) {
  return page.evaluate(async () => {
    try {
      const r = await fetch('/api/v1/me', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (!r.ok) return null;
      const j = await r.json();
      const u = (j && j.user) || j || {};
      return u.username || u.name || (u.id != null ? String(u.id) : null) || 'ok';
    } catch { return null; }
  }).catch(() => null);
}

/** 在页面里调用网站接口（和网页自己点按钮时发的请求一样） */
async function siteApi(page, method, url) {
  return page.evaluate(async ({ method, url }) => {
    const headers = { Accept: 'application/json' };
    if (method !== 'GET') headers['Idempotency-Key'] = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random();
    const r = await fetch(url, { method, headers, credentials: 'same-origin' });
    let data = null;
    try { data = await r.json(); } catch {}
    return { status: r.status, ok: r.ok, data };
  }, { method, url });
}

async function openHome(page) {
  try {
    await page.goto(SITE + '/', { waitUntil: 'networkidle', timeout: 30000 });
  } catch (e) {
    await page.goto(SITE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  }
  await page.waitForTimeout(2000);
}

/** 账号密码登录（备用，原来的逻辑） */
async function loginWithPassword(page) {
  try {
    await page.goto(SITE + '/login', { waitUntil: 'networkidle', timeout: 30000 });
  } catch (e) {
    await page.goto(SITE + '/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
  }
  await page.waitForSelector('input[type="password"]', { timeout: 20000 });
  await page.screenshot({ path: path.join(DEBUG_DIR, '00-login-page.png'), fullPage: true });

  const passwordInput = page.locator('input[type="password"]').first();
  const usernameCandidates = [
    () => page.getByLabel('电子邮件/用户名'),
    () => page.getByPlaceholder('电子邮件/用户名'),
    () => page.locator('input[type="email"]').first(),
    () => page.locator('input[type="text"]').first(),
  ];
  let usernameInput = null;
  for (const getLocator of usernameCandidates) {
    const loc = getLocator();
    if ((await loc.count()) > 0 && (await loc.first().isVisible().catch(() => false))) {
      usernameInput = loc.first();
      break;
    }
  }
  if (!usernameInput) throw new Error('未能定位用户名/邮箱输入框');

  await usernameInput.fill(NODELOC_USER);
  await passwordInput.fill(NODELOC_PASS);

  const loginButtonCandidates = [
    () => page.getByRole('button', { name: '登录' }),
    () => page.locator('button[type="submit"]').first(),
  ];
  let loginBtn = null;
  for (const getLocator of loginButtonCandidates) {
    const loc = getLocator();
    if ((await loc.count()) > 0 && (await loc.first().isVisible().catch(() => false))) {
      loginBtn = loc.first();
      break;
    }
  }
  if (!loginBtn) throw new Error('未能定位登录按钮');
  await loginBtn.click();
  await page.waitForTimeout(5000);
  await openHome(page);
}

/** 导出当前最新的 Cookie（只在确认已登录时调用） */
async function exportCookies(context) {
  const cookies = await context.cookies(SITE);
  const str = cookies
    .filter(c => !SKIP_COOKIES.has(c.name))
    .map(c => `${c.name}=${c.value}`)
    .join('; ');
  if (str) fs.writeFileSync(COOKIE_OUT, str);
  return cookies.length;
}

async function main() {
  if (!NODELOC_COOKIE && !(NODELOC_USER && NODELOC_PASS)) {
    await sendTelegram('❌ NodeLoc 签到失败：未配置 NODELOC_COOKIE（或备用的 NODELOC_USER / NODELOC_PASS）Secrets');
    process.exit(1);
  }

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: 'zh-CN',
  });
  const page = await context.newPage();

  let extraLog = '';
  let success = false;
  let energyGained = null;
  let loginMethod = '';
  let username = null;
  let alreadyDone = false;

  try {
    // 1. 先用 Cookie 登录
    if (NODELOC_COOKIE) {
      const cookies = parseCookieString(NODELOC_COOKIE);
      if (cookies.length) await context.addCookies(cookies);
      await openHome(page);
      username = await currentUser(page);
      if (username) loginMethod = 'Cookie';
      else extraLog += '\n⚠️ Cookie 登录失败（可能已过期），请重新复制 Cookie 更新 NODELOC_COOKIE。';
    }

    // 2. Cookie 不行且配置了账号密码，再试账号密码
    if (!username && NODELOC_USER && NODELOC_PASS) {
      await context.clearCookies();
      await loginWithPassword(page);
      username = await currentUser(page);
      if (username) loginMethod = '账号密码';
      else extraLog += '\n⚠️ 账号密码登录也失败了。';
    }

    await page.screenshot({ path: path.join(DEBUG_DIR, '01-after-login.png'), fullPage: true });
    if (!username) throw new Error('未登录成功，请查看调试截图 01-after-login.png');
    extraLog += `\n🔑 登录方式：${loginMethod}（用户 ${username}）`;

    // 3. 登录成功，先把最新 Cookie 导出一次（即使后面签到出错也能保存）
    await exportCookies(context);

    // 4. 签到：直接调用网站的签到接口（就是点日历图标时网页发的请求），比找按钮点更稳
    const status = await siteApi(page, 'GET', '/api/v1/checkin');
    if (status.ok && status.data && status.data.checked_in_today) {
      success = true;
      alreadyDone = true;
      extraLog += '\nℹ️ 今天已经签到过了';
    } else {
      const res = await siteApi(page, 'POST', '/api/v1/checkin');
      if (res.ok && res.data) {
        success = true;
        energyGained = res.data.points != null ? res.data.points : null;
        if (res.data.balance != null) extraLog += `\n💰 当前能量：${res.data.balance}`;
      } else {
        const msg = (res.data && res.data.error && (res.data.error.message || res.data.error.code)) || `HTTP ${res.status}`;
        if (/已经?签到|already/i.test(msg)) { success = true; alreadyDone = true; extraLog += '\nℹ️ 今天已经签到过了'; }
        else extraLog += `\n❌ 签到接口返回：${msg}`;
      }
    }
    await page.screenshot({ path: path.join(DEBUG_DIR, '03-after-checkin.png'), fullPage: true });

    // 6. 签到后再导出一次，拿到最新的 Cookie
    if (await currentUser(page)) await exportCookies(context);
  } catch (err) {
    extraLog += `\n💥 脚本执行出错：${err.message}`;
    await page.screenshot({ path: path.join(DEBUG_DIR, '99-error.png'), fullPage: true }).catch(() => {});
  } finally {
    await browser.close();
  }

  if (fs.existsSync(COOKIE_OUT)) extraLog += '\n🍪 已导出最新 Cookie，下次运行自动使用';

  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const header = alreadyDone
    ? `✅ <b>NodeLoc 今日已签到</b>`
    : success
    ? `✅ <b>NodeLoc 签到成功</b>${energyGained != null ? `，获得 ${energyGained} 能量` : ''}`
    : `❌ <b>NodeLoc 签到失败/未确认</b>`;

  const finalMsg = `${header}\n🕐 ${now}（北京时间）${extraLog}`;
  console.log(finalMsg);
  await sendTelegram(finalMsg);

  process.exit(success ? 0 : 1);
}

main();
