const axios = require('axios');
const http = require('http');
const https = require('https');

const BACKEND_URL = process.env.BACKEND_URL || 'https://api.ilmify-edu.uz';
const API_TIMEOUT = 15000;
const POLL_TIMEOUT = 35000;
const CONFIG_REFRESH_MS = 5 * 60 * 1000;
const STALE_THRESHOLD_MS = 60 * 60 * 1000;
const STATE_CLEANUP_MS = 10 * 60 * 1000;
const MAX_PASSWORD_ATTEMPTS = 5;
const PASSWORD_BLOCK_MS = 15 * 60 * 1000;

// Keep-alive agents
const keepAliveAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 10000, maxSockets: 50 });
const tgKeepAliveAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 10000, maxSockets: 25 });

const api = axios.create({ timeout: API_TIMEOUT, httpsAgent: keepAliveAgent });
const tgApi = axios.create({ timeout: API_TIMEOUT, httpsAgent: tgKeepAliveAgent });

// State
const bots = new Map();
const userStates = new Map();
const userPhones = new Map();
const userStudents = new Map();
const lastActivity = new Map();
const passwordFails = new Map();

let activeConfigs = [];

function log(level, msg, data = null) {
  const time = new Date().toISOString();
  const prefix = `[${time}] [${level.toUpperCase()}]`;
  if (data) {
    console.log(`${prefix} ${msg}`, typeof data === 'object' ? JSON.stringify(data).slice(0, 300) : data);
  } else {
    console.log(`${prefix} ${msg}`);
  }
}

function touch(chatId) {
  lastActivity.set(chatId, Date.now());
}

// HTTP helpers
async function tg(method, token, payload) {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const res = await tgApi.post(url, payload);
  return res.data;
}

async function be(centerId, path, data = null) {
  const url = `${BACKEND_URL}/telegram-bot/${centerId}${path}`;
  if (data) {
    return (await api.post(url, data)).data;
  }
  return (await api.get(url)).data;
}

async function refreshConfigs() {
  try {
    const res = await api.get(`${BACKEND_URL}/telegram-bot/active-configs`);
    activeConfigs = res.data || [];
  } catch (err) {
    log('error', `Failed to fetch active configs: ${err.message}`);
  }
}

// Telegram helpers
function sendMsg(token, chatId, text, kb = null) {
  const payload = { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true };
  if (kb) payload.reply_markup = kb;
  return tg('sendMessage', token, payload);
}

function editMsg(token, chatId, msgId, text, kb = null) {
  const payload = { chat_id: chatId, message_id: msgId, text, parse_mode: 'HTML', disable_web_page_preview: true };
  if (kb) payload.reply_markup = kb;
  return tg('editMessageText', token, payload);
}

function inlineKb(rows) {
  return { inline_keyboard: rows.map(r => r.map(b => ({
    text: b.text || b[0],
    callback_data: b.callback_data || b[1],
  }))) };
}

function removeKb() {
  return { remove_keyboard: true };
}

function phoneKb() {
  return {
    keyboard: [[{ text: '📱 Telefon raqamni yuborish', request_contact: true }]],
    resize_keyboard: true,
    one_time_keyboard: true,
  };
}

function mainMenuKb() {
  return {
    keyboard: [
      [{ text: '👤 Mening profilim' }, { text: '📚 Guruhlarim' }],
      [{ text: '📊 Davomat' }, { text: '💳 To\'lovlar' }],
      [{ text: '📝 Baholarim' }, { text: '✉️ Admin bilan bog\'lanish' }],
    ],
    resize_keyboard: true,
  };
}

function backKb(action) {
  return inlineKb([
    [{ text: '⬅️ Orqaga', callback_data: action }],
  ]);
}

function groupsBackKb() {
  return inlineKb([
    [{ text: '⬅️ Orqaga', callback_data: 'menu_groups' }],
  ]);
}

// Auth
async function handleStart(centerId, token, chatId, from) {
  userStates.delete(chatId);
  userPhones.delete(chatId);
  userStudents.delete(chatId);
  passwordFails.delete(chatId);

  try {
    const status = await be(centerId, `/chat-status/${chatId}`);
    if (status.authenticated && status.student) {
      userStates.set(chatId, 'menu');
      userStudents.set(chatId, status.student);
      touch(chatId);
      await sendMsg(token, chatId,
        `Assalomu alaykum, <b>${status.student.first_name}</b>!\n\nQuyidagi bo'limlardan birini tanlang:`,
        mainMenuKb()
      );
      return;
    }
  } catch {}

  await sendMsg(token, chatId,
    `Assalomu alaykum! <b>Ilmify Education</b> botiga xush kelibsiz!\n\nBotdan foydalanish uchun telefon raqamingizni yuboring yoki quyidagi tugmani bosing.`,
    phoneKb()
  );
  userStates.set(chatId, 'auth_phone');
  touch(chatId);
}

async function handleAuthPhone(centerId, token, chatId, phone, from) {
  let cleaned = phone.replace(/[^\d+]/g, '');

  if (cleaned.startsWith('998') && !cleaned.startsWith('+')) {
    cleaned = '+' + cleaned;
  } else if (cleaned.startsWith('8') && cleaned.length === 12) {
    cleaned = '+998' + cleaned.substring(1);
  } else if (cleaned.startsWith('8') && cleaned.length === 11) {
    cleaned = '+998' + cleaned.substring(1);
  } else if (cleaned.length === 9) {
    cleaned = '+998' + cleaned;
  }

  if (!cleaned.match(/^\+?\d{9,15}$/)) {
    await sendMsg(token, chatId,
      `Noto'g'ri format. Iltimos, telefon raqamingizni to'g'ri kiriting.\nMasalan: <code>+998901234567</code> yoki <code>998901234567</code>`,
      phoneKb()
    );
    return;
  }

  try {
    const res = await be(centerId, '/check-phone', { phone: cleaned });
    if (res.exists) {
      userPhones.set(chatId, cleaned);
      userStates.set(chatId, 'auth_password');
      touch(chatId);
      await sendMsg(token, chatId, 'Parolingizni yuboring:', removeKb());
    } else {
      await sendMsg(token, chatId,
        `❌ Siz tizimda topilmadingiz.\n\nIltimos, o'quv markazingizga murojaat qiling yoki qaytadan urinib ko'ring.`,
        phoneKb()
      );
    }
  } catch (err) {
    log('error', `Check phone error: ${err.message}`);
    await sendMsg(token, chatId, '❌ Xatolik yuz berdi. Iltimos, qaytadan /start bosing.');
    userStates.delete(chatId);
    userPhones.delete(chatId);
  }
}

async function handleAuthPassword(centerId, token, chatId, password, from) {
  const phone = userPhones.get(chatId);
  if (!phone) {
    await sendMsg(token, chatId, 'Xatolik yuz berdi. Iltimos, /start bosing.');
    userStates.delete(chatId);
    return;
  }

  // Rate limit check
  const failEntry = passwordFails.get(chatId);
  if (failEntry) {
    if (failEntry.count >= MAX_PASSWORD_ATTEMPTS) {
      if (Date.now() < failEntry.blockUntil) {
        const remaining = Math.ceil((failEntry.blockUntil - Date.now()) / 60000);
        await sendMsg(token, chatId, `❌ Juda ko'p urinishlar. ${remaining} daqiqa kutib, keyin /start bosing.`);
        return;
      }
      passwordFails.delete(chatId);
    }
  }

  try {
    const res = await be(centerId, '/verify-password', { phone, password });
    if (res.success && res.student) {
      passwordFails.delete(chatId);
      const s = res.student;
      userStudents.set(chatId, s);
      userStates.set(chatId, 'menu');
      touch(chatId);

      be(centerId, '/link-student', {
        chat_id: chatId,
        student_id: s.id,
        first_name: from.first_name || '',
        last_name: from.last_name || '',
        username: from.username || '',
      }).catch(() => {});

      await sendMsg(token, chatId,
        `✅ <b>Xush kelibsiz, ${s.first_name}!</b>\n\nQuyidagi bo'limlardan birini tanlang:`,
        mainMenuKb()
      );
    } else {
      const entry = passwordFails.get(chatId) || { count: 0, blockUntil: 0 };
      entry.count++;
      if (entry.count >= MAX_PASSWORD_ATTEMPTS) {
        entry.blockUntil = Date.now() + PASSWORD_BLOCK_MS;
      }
      passwordFails.set(chatId, entry);
      await sendMsg(token, chatId, '❌ Parol noto\'g\'ri. Qaytadan urinib ko\'ring.');
    }
  } catch (err) {
    const detail = err.response ? `status=${err.response.status}` : err.message;
    log('error', `Verify password error: ${detail}`);
    await sendMsg(token, chatId, 'Xatolik yuz berdi. Iltimos, /start bosing.');
    userStates.delete(chatId);
    userPhones.delete(chatId);
  }
}

// Menu handlers
async function showProfile(centerId, token, chatId, student) {
  try {
    const s = await be(centerId, `/student-profile/${student.id}`);
    const lines = [
      `👤 <b>Mening profilim</b>`,
      ``,
      `Ism: ${s.first_name} ${s.last_name || ''}`,
      `Telefon: ${s.phone_number || 'Kiritilmagan'}`,
      `Guruh: ${s.group_name || 'Biriktirilmagan'}`,
      `O'qituvchi: ${s.teacher_name || '-'}`,
      `Markaz: ${s.center_name || ''}`,
    ];
    await sendMsg(token, chatId, lines.join('\n'), backKb('menu_back'));
  } catch {
    await sendMsg(token, chatId, 'Profil ma\'lumotlarini olishda xatolik.', backKb('menu_back'));
  }
}

async function showGroups(centerId, token, chatId, student) {
  try {
    const groups = await be(centerId, `/student-groups/${student.id}`);
    if (!groups || groups.length === 0) {
      await sendMsg(token, chatId,
        `📚 <b>Guruhlarim</b>\n\nSiz hali hech qanday guruhga biriktirilmagansiz.`,
        backKb('menu_back')
      );
      return;
    }

    let msg = `📚 <b>Guruhlarim</b>\n\n`;
    for (const g of groups) {
      msg += `<b>${g.name || 'N/A'}</b>\n`;
      if (g.teacher_name) msg += `👨‍🏫 O'qituvchi: ${g.teacher_name}\n`;
      if (g.teacher_phone) msg += `📞 Tel: ${g.teacher_phone}\n`;
      if (g.monthly_price) msg += `💰 Oylik: ${Number(g.monthly_price).toLocaleString()} so'm\n`;
      msg += '\n';
    }
    await sendMsg(token, chatId, msg, backKb('menu_back'));
  } catch (err) {
    log('error', `Groups error: ${err.message}`);
    await sendMsg(token, chatId, `❌ Guruhlarni olishda xatolik: ${err.message}`, backKb('menu_back'));
  }
}

async function showAttendance(centerId, token, chatId, student) {
  try {
    const records = await be(centerId, `/student-attendance/${student.id}`);
    if (!records || records.length === 0) {
      await sendMsg(token, chatId,
        `📊 <b>Davomat</b>\n\nSizda hali davomat ma'lumotlari mavjud emas.`,
        backKb('menu_back')
      );
      return;
    }

    const byMonth = {};
    for (const r of records) {
      if (!r.date) continue;
      const d = r.date.slice(0, 7);
      if (!byMonth[d]) byMonth[d] = [];
      byMonth[d].push(r);
    }

    const months = Object.keys(byMonth).sort((a, b) => b.localeCompare(a));
    let totalPresent = 0;
    let totalAbsent = 0;

    for (const month of months.slice(0, 6)) {
      const monthName = new Date(month + '-01').toLocaleString('uz-UZ', { month: 'long', year: 'numeric' });
      const days = byMonth[month].sort((a, b) => a.date.localeCompare(b.date));
      let line = `📅 <b>${monthName}</b>\n`;
      for (const d of days) {
        const day = d.date.slice(8, 10);
        const dayNum = parseInt(day, 10);
        if (d.is_present) {
          line += `${dayNum} - ✅\n`;
          totalPresent++;
        } else {
          line += `${dayNum} - ❌${d.reason ? ` (${d.reason})` : ''}\n`;
          totalAbsent++;
        }
      }
      await sendMsg(token, chatId, line);
    }

    const total = totalPresent + totalAbsent;
    const pct = total > 0 ? Math.round((totalPresent / total) * 100) : 0;
    await sendMsg(token, chatId,
      `<b>Davomat statistikasi</b>\n\n` +
      `✅ Kelgan: ${totalPresent} kun\n` +
      `❌ Kelmagan: ${totalAbsent} kun\n` +
      `📊 Davomat: ${pct}%`,
      backKb('menu_back')
    );
  } catch (err) {
    log('error', `Attendance error: ${err.message}`);
    await sendMsg(token, chatId, 'Davomat ma\'lumotlarini olishda xatolik.', backKb('menu_back'));
  }
}

async function showPayments(centerId, token, chatId, student) {
  try {
    const payments = await be(centerId, `/student-payments/${student.id}`);
    if (!payments || payments.length === 0) {
      await sendMsg(token, chatId,
        `💳 <b>To'lovlar</b>\n\nSizda hali to'lovlar mavjud emas.`,
        backKb('menu_back')
      );
      return;
    }

    const monthNames = {
      '1': 'Yanvar', '2': 'Fevral', '3': 'Mart', '4': 'Aprel',
      '5': 'May', '6': 'Iyun', '7': 'Iyul', '8': 'Avgust',
      '9': 'Sentabr', '10': 'Oktabr', '11': 'Noyabr', '12': 'Dekabr',
    };

    let msg = `💳 <b>To'lovlarim</b>\n\n`;
    for (const p of payments.slice(0, 12)) {
      const m = monthNames[String(p.month)] || p.month;
      const statusIcon = p.status === 'paid' ? '✅' : p.status === 'partial' ? '🟡' : '❌';
      const statusText = p.status === 'paid' ? 'To\'langan' : p.status === 'partial' ? 'Qisman' : 'To\'lanmagan';
      msg += `${statusIcon} <b>${m} ${p.year}</b>\n`;
      if (p.amount) msg += `   Summa: ${Number(p.amount).toLocaleString()} so'm\n`;
      msg += `   Holat: ${statusText}\n`;
      if (p.paid_at) msg += `   To'langan sana: ${p.paid_at}\n`;
      msg += '\n';
    }
    await sendMsg(token, chatId, msg, backKb('menu_back'));
  } catch (err) {
    log('error', `Payments error: ${err.message}`);
    await sendMsg(token, chatId, `❌ To'lovlarni olishda xatolik: ${err.message}`, backKb('menu_back'));
  }
}

async function showGrades(centerId, token, chatId, student) {
  try {
    const grades = await be(centerId, `/student-grades/${student.id}`);
    if (!grades || grades.length === 0) {
      await sendMsg(token, chatId,
        `📝 <b>Baholarim</b>\n\nSizda hali baholar mavjud emas.`,
        backKb('menu_back')
      );
      return;
    }

    let msg = `📝 <b>Baholarim</b>\n\n`;
    for (const g of grades.slice(0, 20)) {
      const d = g.date ? new Date(g.date).toLocaleDateString('uz-UZ') : '';
      msg += `📖 ${g.subject}: <b>${g.score}</b>\n`;
      if (d) msg += `   ${d}\n`;
      msg += '\n';
    }
    await sendMsg(token, chatId, msg, backKb('menu_back'));
  } catch (err) {
    log('error', `Grades error: ${err.message}`);
    await sendMsg(token, chatId, 'Baholarni olishda xatolik.', backKb('menu_back'));
  }
}

async function startContact(centerId, token, chatId, student) {
  userStates.set(chatId, 'contact');
  touch(chatId);
  await sendMsg(token, chatId,
    `✉️ <b>Admin bilan bog'lanish</b>\n\n` +
    `Adminga yubormoqchi bo'lgan xabaringizni yozing.\n\n` +
    `Xabar yuborilgandan so'ng admin sizga javob berishi mumkin.\n\n` +
    `Menyuga qaytish uchun /menu bosing.`,
    removeKb()
  );
}

async function handleContactMessage(centerId, token, chatId, text, student) {
  try {
    await be(centerId, '/contact-admin', { chat_id: chatId, text });
    await sendMsg(token, chatId,
      `✅ Xabaringiz adminga yuborildi!\n\n` +
      `Yana xabar yuborishingiz yoki quyidagi tugma orqali menyuga qaytishingiz mumkin.`,
      inlineKb([[{ text: '🏠 Bosh menyu', callback_data: 'menu_back' }]])
    );
  } catch (err) {
    log('error', `Contact error: ${err.message}`);
    await sendMsg(token, chatId, 'Xatolik yuz berdi. Qaytadan urinib ko\'ring.');
  }
}

// Main dispatcher
async function handleUpdate(centerId, token, update) {
  const msg = update.message;
  const cbq = update.callback_query;

  if (cbq) {
    const chatId = cbq.message.chat.id;
    const msgId = cbq.message.message_id;
    const data = cbq.data;

    tg('answerCallbackQuery', token, { callback_query_id: cbq.id }).catch(() => {});

    const student = userStudents.get(chatId);
    if (!student && data !== 'menu_back') {
      await editMsg(token, chatId, msgId,
        `Iltimos, avval /start bosing va tizimga kiring.`,
        removeKb()
      );
      return;
    }

    touch(chatId);

    switch (data) {
      case 'menu_back':
        userStates.set(chatId, 'menu');
        await sendMsg(token, chatId,
          `🏠 <b>Bosh menyu</b>\n\nQuyidagi bo'limlardan birini tanlang:`,
          mainMenuKb()
        );
        break;
      case 'menu_profile':
        await editMsg(token, chatId, msgId, '⏳ Yuklanmoqda...', null);
        await showProfile(centerId, token, chatId, student);
        break;
      case 'menu_groups':
        await editMsg(token, chatId, msgId, '⏳ Yuklanmoqda...', null);
        await showGroups(centerId, token, chatId, student);
        break;
      case 'menu_attendance':
        await editMsg(token, chatId, msgId, '⏳ Yuklanmoqda...', null);
        await showAttendance(centerId, token, chatId, student);
        break;
      case 'menu_payments':
        await editMsg(token, chatId, msgId, '⏳ Yuklanmoqda...', null);
        await showPayments(centerId, token, chatId, student);
        break;
      case 'menu_grades':
        await editMsg(token, chatId, msgId, '⏳ Yuklanmoqda...', null);
        await showGrades(centerId, token, chatId, student);
        break;
      case 'menu_contact':
        await editMsg(token, chatId, msgId,
          `✉️ <b>Admin bilan bog'lanish</b>\n\n` +
          `Adminga yubormoqchi bo'lgan xabaringizni yozing.\n\n` +
          `Menyuga qaytish uchun /menu bosing.`,
          removeKb()
        );
        userStates.set(chatId, 'contact');
        break;
    }
    return;
  }

  if (!msg) return;
  const chatId = msg.chat.id;
  const from = msg.from || {};
  const text = (msg.text || '').trim();
  const contact = msg.contact;
  const state = userStates.get(chatId);

  touch(chatId);

  // Forward message to backend for inbox (fire-and-forget, except passwords)
  if (state !== 'auth_password') {
    be(centerId, '/incoming', {
      chat_id: chatId, text: text || (contact ? contact.phone_number : ''),
      first_name: from.first_name || '',
      last_name: from.last_name || '',
      username: from.username || '',
    }).catch(() => {});
  }

  if (text === '/start' || text === '/menu' || text.startsWith('/start ')) {
    await handleStart(centerId, token, chatId, from);
    return;
  }

  if (state === 'auth_phone') {
    const phone = contact ? contact.phone_number : text;
    await handleAuthPhone(centerId, token, chatId, phone, from);
    return;
  }

  if (state === 'auth_password') {
    await handleAuthPassword(centerId, token, chatId, text, from);
    return;
  }

  if (state === 'contact') {
    const student = userStudents.get(chatId);
    if (student) {
      await handleContactMessage(centerId, token, chatId, text, student);
    }
    return;
  }

  if (state === 'menu') {
    const student = userStudents.get(chatId);
    if (student) {
      switch (text) {
        case '👤 Mening profilim':
          await showProfile(centerId, token, chatId, student);
          break;
        case '📚 Guruhlarim':
          await showGroups(centerId, token, chatId, student);
          break;
        case '📊 Davomat':
          await showAttendance(centerId, token, chatId, student);
          break;
        case "💳 To'lovlar":
          await showPayments(centerId, token, chatId, student);
          break;
        case '📝 Baholarim':
          await showGrades(centerId, token, chatId, student);
          break;
        case '✉️ Admin bilan bog\'lanish':
          userStates.set(chatId, 'contact');
          await sendMsg(token, chatId,
            `✉️ <b>Admin bilan bog'lanish</b>\n\n` +
            `Adminga yubormoqchi bo'lgan xabaringizni yozing.\n\n` +
            `Menyuga qaytish uchun /menu bosing.`,
            removeKb()
          );
          break;
        default:
          await sendMsg(token, chatId, 'Quyidagi bo\'limlardan birini tanlang:', mainMenuKb());
      }
    }
    return;
  }

  await sendMsg(token, chatId, 'Botdan foydalanish uchun /start bosing.', removeKb());
}

// Polling
async function pollBotForever(centerId, token) {
  const entry = bots.get(centerId);
  if (!entry) return;

  let offset = 0;
  while (entry.running) {
    try {
      const params = `offset=${offset}&timeout=30&allowed_updates=message,callback_query`;
      const res = await tgApi.get(`https://api.telegram.org/bot${token}/getUpdates?${params}`, { timeout: POLL_TIMEOUT });
      const updates = res.data.result || [];

      for (const update of updates) {
        offset = update.update_id + 1;
        await handleUpdate(centerId, token, update);
      }
    } catch (err) {
      if (err.response?.status === 401) {
        log('error', `[${centerId}] Invalid token, stopping`);
        entry.running = false;
        return;
      }
      if (err.response?.status === 409) {
        continue;
      }
      if (err.code !== 'ECONNABORTED') {
        log('error', `[${centerId}] Poll: ${err.message}`);
      }
    }
  }
}

function startBotPolling(centerId, token) {
  if (bots.has(centerId)) {
    bots.get(centerId).running = false;
  }
  const entry = { token, running: true };
  bots.set(centerId, entry);
  pollBotForever(centerId, token).catch(err => {
    log('error', `[${centerId}] Poll loop crashed: ${err.message}`);
  });
}

function stopBotPolling(centerId) {
  const entry = bots.get(centerId);
  if (entry) {
    entry.running = false;
    bots.delete(centerId);
  }
}

function syncConfigs() {
  const cfgMap = new Map(activeConfigs.map(c => [c.center_id, c.bot_token]));

  // Start new bots
  for (const [centerId, token] of cfgMap) {
    if (!bots.has(centerId)) {
      log('info', `Starting bot for center ${centerId}`);
      startBotPolling(centerId, token);
    }
  }

  // Stop removed bots
  for (const [centerId] of bots) {
    if (!cfgMap.has(centerId)) {
      log('info', `Stopping bot for center ${centerId}`);
      stopBotPolling(centerId);
    }
  }
}

function cleanupStaleState() {
  const stale = Date.now() - STALE_THRESHOLD_MS;
  for (const [chatId, time] of lastActivity) {
    if (time < stale) {
      userStates.delete(chatId);
      userPhones.delete(chatId);
      userStudents.delete(chatId);
      passwordFails.delete(chatId);
      lastActivity.delete(chatId);
    }
  }
}

async function run() {
  log('info', 'Ilmify Telegram bot starting...');

  await refreshConfigs();
  syncConfigs();

  // Refresh configs periodically
  setInterval(async () => {
    await refreshConfigs();
    syncConfigs();
  }, CONFIG_REFRESH_MS);

  // Cleanup stale state periodically
  setInterval(cleanupStaleState, STATE_CLEANUP_MS);
}

// Shutdown
process.on('SIGINT', () => { log('info', 'Shutting down...'); process.exit(0); });
process.on('SIGTERM', () => { log('info', 'Shutting down...'); process.exit(0); });
process.on('uncaughtException', (err) => { log('error', `Uncaught: ${err.message}`); });
process.on('unhandledRejection', (err) => { log('error', `Unhandled: ${err.message}`); });

run();
