/**
 * NodeLoc 每日自动签到脚本
 * 流程：打开登录页 -> 输入账号密码 -> 登录 -> 点击签到按钮
 *      -> 1~15秒内侦测"获得能量"提示 -> 通过 Telegram 通知结果
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const NODELOC_USER = process.env.NODELOC_USER;
const NODELOC_PASS = process.env.NODELOC_PASS;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

const DEBUG_DIR = path.join(__dirname, '..', 'debug');
if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });

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
    if (!res.ok) {
      console.error('Telegram 通知发送失败:', await res.text());
    }
  } catch (e) {
    console.error('Telegram 通知发送异常:', e.message);
  }
}

async function main() {
  if (!NODELOC_USER || !NODELOC_PASS) {
    await sendTelegram('❌ NodeLoc 签到失败：未配置 NODELOC_USER / NODELOC_PASS Secrets');
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

  try {
    // 1. 打开登录页（SPA站点，用 networkidle 等待JS完全渲染，失败则退化为 domcontentloaded）
    try {
      await page.goto('https://nodeloc.com/login', { waitUntil: 'networkidle', timeout: 30000 });
    } catch (e) {
      await page.goto('https://nodeloc.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
    }

    // 密码框用 type="password" 定位，这是原生HTML属性，几乎不会因文案/样式变化而失效
    await page.waitForSelector('input[type="password"]', { timeout: 20000 });
    await page.screenshot({ path: path.join(DEBUG_DIR, '00-login-page.png'), fullPage: true });

    const passwordInput = page.locator('input[type="password"]').first();

    // 2. 用户名/邮箱输入框：依次尝试多种定位方式，
    // 因为"电子邮件/用户名"这行文字很可能是浮动标签(label)而不是真正的 placeholder 属性
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
    if (!usernameInput) {
      await page.screenshot({ path: path.join(DEBUG_DIR, '00b-no-username-input.png'), fullPage: true });
      throw new Error('未能定位用户名/邮箱输入框');
    }

    await usernameInput.fill(NODELOC_USER);
    await passwordInput.fill(NODELOC_PASS);

    // 3. 点击登录按钮：文本"登录"定位，找不到则兜底 type=submit
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

    // 等待登录后跳转/渲染
    await page.waitForTimeout(4000);
    await page.screenshot({ path: path.join(DEBUG_DIR, '01-after-login.png'), fullPage: true });

    // 校验是否登录成功（首页会出现"欢迎回来"字样）
    const loggedIn = await page.locator('text=欢迎回来').first().isVisible().catch(() => false);
    if (!loggedIn) {
      extraLog += '\n⚠️ 登录后未检测到"欢迎回来"字样，可能登录失败，请查看调试截图 01-after-login.png。';
    }

    // 4. 点击签到按钮
    // 已确认该图标是 Discourse 论坛的 d-icon-far-calendar-plus（日历+图标），
    // 对应的一般是 discourse checkin 类插件的按钮。优先精确匹配这个图标，
    // 找不到再退化为通用猜测选择器兜底。
    const checkinSelectors = [
      'svg.d-icon-far-calendar-plus',
      '.d-icon-far-calendar-plus',
      'a[href*="checkin"]',
      'a[href*="check-in"]',
      'button[aria-label*="签到"]',
      'a[aria-label*="签到"]',
      '[title*="签到"]',
      'a[title*="签到"]',
    ];

    let clicked = false;
    for (const sel of checkinSelectors) {
      const el = page.locator(sel).first();
      if ((await el.count()) > 0 && (await el.isVisible().catch(() => false))) {
        await el.click();
        clicked = true;
        break;
      }
    }

    if (!clicked) {
      extraLog += '\n⚠️ 未能自动定位签到按钮，请查看 debug/02-header.png，并根据实际页面结构修改 scripts/checkin.js 中的 checkinSelectors。';
      await page.screenshot({ path: path.join(DEBUG_DIR, '02-header.png'), fullPage: true });
    } else {
      // 5. 在最多15秒内轮询页面文本，侦测"获得能量"类提示
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const bodyText = await page.locator('body').innerText().catch(() => '');
        const match = bodyText.match(/获得\s*[:：]?\s*(\d+)\s*能量|(\+\d+)\s*能量|签到成功/);
        if (match) {
          success = true;
          energyGained = match[1] || match[2] || null;
          extraLog += `\n✅ 检测到签到提示：${match[0]}`;
          break;
        }
        await page.waitForTimeout(1000);
      }
      if (!success) {
        extraLog += '\n❌ 15秒内未检测到"获得能量"提示，签到可能未成功（也可能今日已签到过）。';
      }
      await page.screenshot({ path: path.join(DEBUG_DIR, '03-after-checkin.png'), fullPage: true });
    }
  } catch (err) {
    extraLog += `\n💥 脚本执行出错：${err.message}`;
    await page.screenshot({ path: path.join(DEBUG_DIR, '99-error.png'), fullPage: true }).catch(() => {});
  } finally {
    await browser.close();
  }

  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const header = success
    ? `✅ <b>NodeLoc 签到成功</b>${energyGained ? `，获得 ${energyGained} 能量` : ''}`
    : `❌ <b>NodeLoc 签到失败/未确认</b>`;

  const finalMsg = `${header}\n🕐 ${now}（北京时间）${extraLog}`;
  console.log(finalMsg);
  await sendTelegram(finalMsg);

  process.exit(success ? 0 : 1);
}

main();
