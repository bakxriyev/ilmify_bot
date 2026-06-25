const axios = require('axios');

const BACKEND_URL = process.env.BACKEND_URL || 'https://api.ilmify-edu.uz';
const POLL_INTERVAL = 3000;
const API_TIMEOUT = 15000;

// ─── State ─────────────────────────────────────────────────
const bots = new Map();
const userStates = new Map();   // chatId -> 'auth' | 'menu' | 'contact'
const userPhones = new Map();
const userStudents = new Map(); // chatId -> { id, first_name, last_name, center_id }

// ─── Logging ──────────────────────────────────────────────
function log(level, msg, data = null) {
  const time = new Date().toISOString();
  const prefix = `[${time}] [${level.toUpperCase()}]`;
  if (data) {
    console.log(`${prefix} ${msg}`, typeof data === 'object' ? JSON.stringify(data).slice(0, 300) : data);
  } else {
    console.log(`${prefix} ${msg}`);
  }
}

// ─── HTTP helpers ─────────────────────────────────────────
async function tg(method, token, payload) {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const res = await axios.post(url, payload, { timeout: API_TIMEOUT });
  return res.data;
}

async function be(centerId, path, data = null) {
  const url = `${BACKEND_URL}/telegram-bot/${centerId}${path}`;
  if (data) {
    return (await axios.post(url, data, { timeout: API_TIMEOUT })).data;
  }
  return (await axios.get(url, { timeout: API_TIMEOUT })).data;
}

async function fetchActiveBots() {
  try {
    const res = await axios.get(`${BACKEND_URL}/telegram-bot/active-configs`, { timeout: API_TIMEOUT });
    return res.data || [];
  } catch (err) {
    log('error', `Failed to fetch active bots: ${err.message}`);
    return [];
  }
}

// ─── Telegram message builders ────────────────────────────
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

// ─── Menus ─────────────────────────────────────────────────
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

// ─── Auth flow ─────────────────────────────────────────────
async function handleStart(centerId, token, chatId, from) {
  userStates.delete(chatId);
  userPhones.delete(chatId);
  userStudents.delete(chatId);

  // Check if already linked
  try {
    const status = await be(centerId, `/chat-status/${chatId}`);
    if (status.authenticated && status.student) {
      userStates.set(chatId, 'menu');
      userStudents.set(chatId, status.student);
      await sendMsg(token, chatId,
        `Assalomu alaykum, <b>${status.student.first_name}</b>!\n\nQuyidagi bo'limlardan birini tanlang:`,
        mainMenuKb()
      );
      return;
    }
  } catch {}

  await sendMsg(token, chatId,
    `Assalomu alaykum! <b>Ilmify Education</b> botiga xush kelibsiz!\n\n` +
    `Botdan foydalanish uchun telefon raqamingizni yuboring yoki quyidagi tugmani bosing.`,
    phoneKb()
  );
  userStates.set(chatId, 'auth_phone');
}

async function handleAuthPhone(centerId, token, chatId, phone, from) {
  let cleaned = phone.replace(/[^\d+]/g, '');

  // Uzbek nomer format qo'llash
  if (cleaned.startsWith('998') && !cleaned.startsWith('+')) {
    cleaned = '+' + cleaned;
  } else if (cleaned.startsWith('8') && cleaned.length === 12) {
    // 8 99 XXX XX XX -> +998 99 XXX XX XX
    cleaned = '+998' + cleaned.substring(1);
  } else if (cleaned.startsWith('8') && cleaned.length === 11) {
    // 8 9X XXX XX XX (11 digits) -> +998 9X XXX XX XX
    cleaned = '+998' + cleaned.substring(1);
  } else if (cleaned.startsWith('+') && cleaned.length === 12) {
    // +9989XXXXXXX (12 chars, missing last digit)
    // Aslida +998 XX XXX XX XX = 13 chars, shuning uchun bu holatda hech narsa qilmaymiz
  } else if (cleaned.length === 9) {
    // Faqat 9 raqam (masalan 901234567) -> +998901234567
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
      await sendMsg(token, chatId, `Parolingizni yuboring:`, removeKb());
    } else {
      await sendMsg(token, chatId,
        `❌ Siz tizimda topilmadingiz.\n\n` +
        `Iltimos, o'quv markazingizga murojaat qiling yoki qaytadan urinib ko'ring.`,
        phoneKb()
      );
    }
  } catch (err) {
    log('error', `Check phone error: ${err.message}`);
    await sendMsg(token, chatId, `❌ Xatolik yuz berdi. Iltimos, qaytadan /start bosing.`);
    userStates.delete(chatId);
    userPhones.delete(chatId);
  }
}

async function handleAuthPassword(centerId, token, chatId, password, from) {
  const phone = userPhones.get(chatId);
  if (!phone) {
    await sendMsg(token, chatId, `Xatolik yuz berdi. Iltimos, /start bosing.`);
    userStates.delete(chatId);
    return;
  }

  try {
    const res = await be(centerId, '/verify-password', { phone, password });
    if (res.success && res.student) {
      const s = res.student;
      userStudents.set(chatId, s);
      userStates.set(chatId, 'menu');

      // Link chat to student
      try {
        await be(centerId, '/link-student', {
          chat_id: chatId,
          student_id: s.id,
          first_name: from.first_name || '',
          last_name: from.last_name || '',
          username: from.username || '',
        });
      } catch (err) {
        log('warn', `Link error: ${err.message}`);
      }

      await sendMsg(token, chatId,
        `✅ <b>Xush kelibsiz, ${s.first_name}!</b>\n\nQuyidagi bo'limlardan birini tanlang:`,
        mainMenuKb()
      );
    } else {
      await sendMsg(token, chatId, `❌ Parol noto'g'ri. Qaytadan urinib ko'ring.`);
    }
  } catch (err) {
    const detail = err.response ? `status=${err.response.status} data=${JSON.stringify(err.response.data).slice(0,200)}` : err.message;
    log('error', `Verify password error: ${detail}`);
    log('error', `URL: ${BACKEND_URL}/telegram-bot/${centerId}/verify-password phone=${phone} password=${password}`);
    await sendMsg(token, chatId, `Xatolik yuz berdi. Iltimos, /start bosing.`);
    userStates.delete(chatId);
    userPhones.delete(chatId);
  }
}

// ─── Menu handlers ─────────────────────────────────────────
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

    // Group by month
    const byMonth = {};
    for (const r of records) {
      if (!r.date) continue;
      const d = r.date.slice(0, 7); // YYYY-MM
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

    // Summary
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
    await sendMsg(token, chatId, `Xatolik yuz berdi. Qaytadan urinib ko'ring.`);
  }
}

// ─── Main dispatcher ──────────────────────────────────────
async function handleUpdate(centerId, token, update) {
  const msg = update.message;
  const cbq = update.callback_query;

  // ── Handle callback queries (inline keyboard) ──
  if (cbq) {
    const chatId = cbq.message.chat.id;
    const msgId = cbq.message.message_id;
    const data = cbq.data;

    // Ack callback
    await tg('answerCallbackQuery', token, { callback_query_id: cbq.id });

    const student = userStudents.get(chatId);
    if (!student && data !== 'menu_back') {
      await editMsg(token, chatId, msgId,
        `Iltimos, avval /start bosing va tizimga kiring.`,
        removeKb()
      );
      return;
    }

    switch (data) {
      case 'menu_back':
        userStates.set(chatId, 'menu');
        await sendMsg(token, chatId,
          `🏠 <b>Bosh menyu</b>\n\nQuyidagi bo'limlardan birini tanlang:`,
          mainMenuKb()
        );
        break;
      case 'menu_profile':
        await editMsg(token, chatId, msgId, `⏳ Yuklanmoqda...`, null);
        await showProfile(centerId, token, chatId, student);
        break;
      case 'menu_groups':
        await editMsg(token, chatId, msgId, `⏳ Yuklanmoqda...`, null);
        await showGroups(centerId, token, chatId, student);
        break;
      case 'menu_attendance':
        await editMsg(token, chatId, msgId, `⏳ Yuklanmoqda...`, null);
        await showAttendance(centerId, token, chatId, student);
        break;
      case 'menu_payments':
        await editMsg(token, chatId, msgId, `⏳ Yuklanmoqda...`, null);
        await showPayments(centerId, token, chatId, student);
        break;
      case 'menu_grades':
        await editMsg(token, chatId, msgId, `⏳ Yuklanmoqda...`, null);
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

  // ── Handle regular messages ──
  if (!msg) return;
  const chatId = msg.chat.id;
  const from = msg.from || {};
  const text = (msg.text || '').trim();
  const contact = msg.contact;
  const state = userStates.get(chatId);

  log('info', `[Center ${centerId}] Chat ${chatId} state=${state || 'none'} text=${text || '(contact)'}`);

  // Forward message to backend for inbox (except passwords)
  if (state !== 'auth_password') {
    try {
      await be(centerId, '/incoming', {
        chat_id: chatId, text: text || (contact ? contact.phone_number : ''),
        first_name: from.first_name || '',
        last_name: from.last_name || '',
        username: from.username || '',
      });
    } catch {}
  }

  // /start or /menu
  if (text === '/start' || text === '/menu' || text.startsWith('/start ')) {
    await handleStart(centerId, token, chatId, from);
    return;
  }

  // Auth states
  if (state === 'auth_phone') {
    const phone = contact ? contact.phone_number : text;
    await handleAuthPhone(centerId, token, chatId, phone, from);
    return;
  }

  if (state === 'auth_password') {
    await handleAuthPassword(centerId, token, chatId, text, from);
    return;
  }

  // Contact admin mode
  if (state === 'contact') {
    const student = userStudents.get(chatId);
    if (student) {
      await handleContactMessage(centerId, token, chatId, text, student);
    }
    return;
  }

  // Menu state - route by text
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
          await sendMsg(token, chatId,
            `Quyidagi bo'limlardan birini tanlang:`,
            mainMenuKb()
          );
      }
    }
    return;
  }

  // No state - start
  await sendMsg(token, chatId,
    `Botdan foydalanish uchun /start bosing.`,
    removeKb()
  );
}

// ─── Polling ──────────────────────────────────────────────
async function pollBot(centerId, token) {
  const botInfo = bots.get(centerId);
  if (!botInfo) return;

  try {
    const params = new URLSearchParams({
      offset: String(botInfo.lastOffset),
      timeout: '30',
      allowed_updates: 'message,callback_query',
    });
    const res = await axios.get(`https://api.telegram.org/bot${token}/getUpdates?${params}`, { timeout: 35000 });
    const updates = res.data.result || [];

    for (const update of updates) {
      botInfo.lastOffset = update.update_id + 1;
      await handleUpdate(centerId, token, update);
    }
  } catch (err) {
    if (err.response?.status === 401) {
      log('error', `[Center ${centerId}] Invalid token`);
      bots.delete(centerId);
      return;
    }
    if (err.response?.status === 409) {
      log('warn', `[Center ${centerId}] Conflict: ${err.response.data?.description || ''}`);
      return;
    }
    if (err.code !== 'ECONNABORTED') {
      log('error', `[Center ${centerId}] Poll: ${err.message}`);
    }
  }
}

async function mainLoop() {
  const configs = await fetchActiveBots();

  for (const cfg of configs) {
    if (!bots.has(cfg.center_id)) {
      log('info', `Starting bot for center ${cfg.center_id}`);
      bots.set(cfg.center_id, { token: cfg.bot_token, lastOffset: 0 });
    }
  }

  for (const [centerId] of bots) {
    if (!configs.find(c => c.center_id === centerId)) {
      log('info', `Stopping bot for center ${centerId}`);
      bots.delete(centerId);
    }
  }

  const promises = [];
  for (const [centerId, botInfo] of bots) {
    promises.push(pollBot(centerId, botInfo.token));
  }
  await Promise.allSettled(promises);

  setTimeout(mainLoop, POLL_INTERVAL);
}

// ─── Shutdown ─────────────────────────────────────────────
process.on('SIGINT', () => { log('info', 'Shutting down...'); process.exit(0); });
process.on('SIGTERM', () => { log('info', 'Shutting down...'); process.exit(0); });
process.on('uncaughtException', (err) => { log('error', `Uncaught: ${err.message}`); });
process.on('unhandledRejection', (err) => { log('error', `Unhandled: ${err.message}`) });

log('info', 'Ilmify Telegram bot starting...');
mainLoop();
