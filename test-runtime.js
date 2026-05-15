// test-runtime.js
// Run: node test-runtime.js
// Uses existing LocalAuth session — no QR needed if already authenticated.
'use strict';

const { Client, LocalAuth } = require('whatsapp-web.js');
const fs = require('fs');
const path = require('path');
const os = require('os');
require('dotenv').config();

// ── Inline helpers (no dependency on bot modules) ────────────────────────────
const pad = (n) => String(n).padStart(2, '0');
function fmtDate(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function mimeToExt(m) {
  const MAP = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
    'video/mp4': 'mp4', 'video/3gpp': '3gp', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a', 'audio/opus': 'opus', 'application/pdf': 'pdf',
    'application/zip': 'zip', 'text/plain': 'txt'
  };
  const k = (m || '').toLowerCase().split(';')[0].trim();
  return MAP[k] || 'bin';
}
function safeStr(s) {
  return String(s || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').slice(0, 60);
}
function chatType(chat) {
  if (chat.isGroup) return 'GROUP';
  if (chat.isBroadcast) return 'BROADCAST';
  return 'DM';
}

const RESULTS = {
  chats: [],
  messages: [],
  media: [],
  storage: [],
  errors: [],
  dedupProof: null,
  memStart: process.memoryUsage().heapUsed,
};

const OUT_DIR = path.resolve('./test-output');
const JSON_OUT = path.join(OUT_DIR, `test-results-${Date.now()}.json`);
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync('./test-downloads', { recursive: true });

// ── Dedup map (mirrors production logic) ─────────────────────────────────────
const seenIds = new Map();
let dedupHitCount = 0;
function checkDedup(id) {
  if (seenIds.has(id)) { dedupHitCount++; return true; }
  seenIds.set(id, Date.now());
  return false;
}

// ── Client ───────────────────────────────────────────────────────────────────
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  },
});

client.on('qr', (qr) => {
  const qrcodeTerminal = require('qrcode-terminal');
  console.log('\n[QR] Scan with WhatsApp:');
  qrcodeTerminal.generate(qr, { small: true });
});

client.on('authenticated', () => console.log('[AUTH] ✅ Authenticated'));

client.on('ready', async () => {
  console.log('[READY] Bot ready — starting tests...\n');
  try {
    await runAllTests();
  } catch (e) {
    console.error('[FATAL]', e);
    RESULTS.errors.push({ phase: 'FATAL', error: e.message, stack: e.stack });
  } finally {
    await saveResults();
    console.log(`\n[DONE] Results saved → ${JSON_OUT}`);
    await client.destroy();
    process.exit(0);
  }
});

// ────────────────────────────────────────────────────────────────────────────
async function runAllTests() {

  // ── TEST 1: Enumerate all chats ─────────────────────────────────────────
  console.log('═══ TEST 1: Chat Enumeration ═══');
  const allChats = await client.getChats();
  console.log(`Found ${allChats.length} chats total.`);

  const chatSummaries = allChats.slice(0, 50).map(c => ({
    name: c.name || '(no name)',
    id: c.id._serialized,
    type: chatType(c),
    unread: c.unreadCount,
    lastMsgTs: c.lastMessage ? fmtDate(c.lastMessage.timestamp * 1000) : 'n/a',
  }));

  // Print first 20
  chatSummaries.slice(0, 20).forEach((c, i) => {
    console.log(
      `  [${String(i + 1).padStart(2)}] [${c.type.padEnd(9)}] "${c.name}" | unread=${c.unread} | last=${c.lastMsgTs}`
    );
  });
  RESULTS.chats = chatSummaries;

  // ── TEST 2: Select representative chats ─────────────────────────────────
  console.log('\n═══ TEST 2: Select Chats ═══');
  const dms = allChats.filter(c => !c.isGroup && !c.isBroadcast);
  const groups = allChats.filter(c => c.isGroup);
  const broadcasts = allChats.filter(c => c.isBroadcast);

  const testChats = [];
  if (dms[0]) testChats.push({ chat: dms[0], label: 'DM' });
  if (groups[0]) testChats.push({ chat: groups[0], label: 'GROUP' });
  if (dms[1]) testChats.push({ chat: dms[1], label: 'DM-2' });
  if (groups[1]) testChats.push({ chat: groups[1], label: 'GROUP-2' });
  if (broadcasts[0]) testChats.push({ chat: broadcasts[0], label: 'BROADCAST' });

  console.log(`Selected ${testChats.length} test chats:`);
  testChats.forEach(({ chat, label }) => {
    console.log(`  [${label}] "${chat.name}" (${chat.id._serialized})`);
  });

  // ── TEST 3: Fetch & analyse recent messages ──────────────────────────────
  console.log('\n═══ TEST 3: Message Fetch & Analysis ═══');

  for (const { chat, label } of testChats) {
    console.log(`\n  → [${label}] "${chat.name}"`);
    let msgs = [];
    try {
      msgs = await chat.fetchMessages({ limit: 50 });
    } catch (err) {
      console.log(`    ⚠ fetchMessages failed: ${err.message}`);
      RESULTS.errors.push({ phase: 'fetchMessages', chat: chat.name, error: err.message });
      continue;
    }

    console.log(`    Fetched ${msgs.length} messages`);

    // Dedup simulation
    let dupCount = 0;
    for (const msg of msgs) {
      const id = msg.id._serialized || msg.id.id;
      if (checkDedup(id)) dupCount++;
      if (checkDedup(id)) dupCount++; // simulate message_create firing same id
    }

    const analysis = {
      chatName: chat.name,
      chatId: chat.id._serialized,
      chatType: chatType(chat),
      msgCount: msgs.length,
      dupHits: dedupHitCount,
      messages: [],
    };

    for (const msg of msgs.slice(0, 5)) {
      let contact = {};
      try { contact = await msg.getContact(); } catch (_) { }

      const sender = contact.pushname || contact.number || msg.author || 'unknown';
      const ts = msg.timestamp > 0 ? fmtDate(msg.timestamp * 1000) : fmtDate(Date.now());
      const body = (msg.body || '').slice(0, 80);
      const hasVietnamese = /[\u00C0-\u024F\u1E00-\u1EFF]/.test(body);
      const hasEmoji = /\p{Emoji}/u.test(body);

      const msgEntry = {
        id: msg.id._serialized,
        type: msg.type,
        sender,
        timestamp: ts,
        body,
        hasMedia: msg.hasMedia,
        hasVietnamese,
        hasEmoji,
        mediaFile: null,
      };

      console.log(`    [${msg.type.padEnd(8)}] ${sender.slice(0, 20).padEnd(20)} | ${ts} | "${body.slice(0, 40)}"`);

      // ── TEST 4: Media download ─────────────────────────────────────────
      if (msg.hasMedia && RESULTS.media.length < 5) {
        console.log(`      ↳ Downloading media (${msg.type})...`);
        try {
          const media = await msg.downloadMedia();
          if (media && media.data) {
            const ext = mimeToExt(media.mimetype);
            const fname = `test_${msg.id.id.slice(-8)}.${ext}`;
            const fpath = path.join('./test-downloads', fname);
            const buf = Buffer.from(media.data, 'base64');
            fs.writeFileSync(fpath, buf);

            const mediaEntry = {
              chatName: chat.name,
              msgType: msg.type,
              mimetype: media.mimetype,
              extension: ext,
              fileSize: buf.length,
              filePath: fpath,
              filename: fname,
              status: 'OK',
            };
            RESULTS.media.push(mediaEntry);
            msgEntry.mediaFile = fname;
            console.log(`      ↳ ✅ Saved ${buf.length} bytes → ${fpath}`);
          } else {
            console.log(`      ↳ ⚠ downloadMedia() returned empty`);
            RESULTS.media.push({ msgType: msg.type, status: 'EMPTY' });
          }
        } catch (err) {
          console.log(`      ↳ ✗ downloadMedia() error: ${err.message}`);
          RESULTS.media.push({ msgType: msg.type, status: 'ERROR', error: err.message });
          RESULTS.errors.push({ phase: 'downloadMedia', error: err.message });
        }
      }

      analysis.messages.push(msgEntry);
    }

    RESULTS.messages.push(analysis);
  }

  // ── TEST 5: JSON storage (simulate production write) ─────────────────────
  console.log('\n═══ TEST 5: JSON Storage (Atomic Write) ═══');
  const testRecord = {
    id: 'test-id-' + Date.now(),
    chatType: 'dm',
    chatName: 'Kiểm tra tiếng Việt 🇻🇳',
    sender: 'Nguyễn Văn A',
    body: 'Chào buổi sáng! 🌞 This is a test with Vietnamese: Xin chào thế giới',
    timestamp: Math.floor(Date.now() / 1000),
    timestampISO: new Date().toISOString(),
    hasMedia: false,
    mediaFilename: null,
  };

  const storageTestPath = path.join(OUT_DIR, `storage_test_${Date.now()}.json`);

  // Simulate concurrent writes (5 records simultaneously)
  const writePromises = Array.from({ length: 5 }, (_, i) => {
    return new Promise((resolve) => {
      setTimeout(() => {
        const rec = { ...testRecord, id: `concurrent-${i}`, seq: i };
        // Simulate atomic write
        let arr = [];
        if (fs.existsSync(storageTestPath)) {
          try { arr = JSON.parse(fs.readFileSync(storageTestPath, 'utf-8')); } catch (_) { }
        }
        arr.push(rec);
        const tmp = `${storageTestPath}.${i}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(arr, null, 2), 'utf-8');
        fs.renameSync(tmp, storageTestPath);
        resolve(i);
      }, i * 10);
    });
  });

  await Promise.all(writePromises);

  const written = JSON.parse(fs.readFileSync(storageTestPath, 'utf-8'));
  console.log(`  Concurrent writes: 5 attempted, ${written.length} records in file`);
  console.log(`  Vietnamese text preserved: "${written[0]?.chatName}"`);
  console.log(`  Emoji preserved: "${written[0]?.body?.slice(0, 40)}"`);

  RESULTS.storage.push({
    filePath: storageTestPath,
    recordsWritten: written.length,
    concurrentWrites: 5,
    note: written.length < 5 ? '⚠ RACE CONDITION DETECTED' : '✅ All records preserved',
    sampleRecord: written[0],
  });

  // ── TEST 6: Unicode & emoji validation ────────────────────────────────────
  console.log('\n═══ TEST 6: Unicode / Emoji Validation ═══');
  const unicodeTests = [
    'Nhóm bán hàng 🛍️',
    'Gia đình thân yêu ❤️',
    'Công ty XYZ — Kênh thông báo',
    '💼 Sales Team VN',
    'Tân Bình District Group',
    'Nguyễn Thị Bích Ngọc',
  ];
  unicodeTests.forEach(name => {
    const safe = name.replace(/\s+/g, '_').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/[^a-zA-Z0-9_\-.]/g, '_').slice(0, 80);
    const roundTrip = JSON.parse(JSON.stringify({ name })).name;
    console.log(`  Original:  "${name}"`);
    console.log(`  Sanitized: "${safe}"`);
    console.log(`  JSON RT:   "${roundTrip}" ${roundTrip === name ? '✅' : '⚠'}`);
    console.log();
  });

  // ── TEST 7: Dedup proof ───────────────────────────────────────────────────
  console.log('═══ TEST 7: Deduplication Proof ═══');
  const testId = 'FALSE_WAID_' + Date.now();
  const first = checkDedup(testId);
  const second = checkDedup(testId);
  const third = checkDedup(testId);
  console.log(`  First call  (should be false — new):  ${first}  ${!first ? '✅' : '❌'}`);
  console.log(`  Second call (should be true  — dup):  ${second} ${second ? '✅' : '❌'}`);
  console.log(`  Third call  (should be true  — dup):  ${third}  ${third ? '✅' : '❌'}`);
  RESULTS.dedupProof = { first, second, third, pass: !first && second && third };

  // ── TEST 8: Memory usage ──────────────────────────────────────────────────
  console.log('\n═══ TEST 8: Memory Usage ═══');
  const mem = process.memoryUsage();
  const heapDeltaMB = ((mem.heapUsed - RESULTS.memStart) / 1024 / 1024).toFixed(2);
  console.log(`  Heap used:    ${(mem.heapUsed / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  Heap total:   ${(mem.heapTotal / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  RSS:          ${(mem.rss / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  Heap delta (since start): +${heapDeltaMB} MB`);
  RESULTS.memory = { heapUsedMB: (mem.heapUsed / 1024 / 1024).toFixed(2), rssMB: (mem.rss / 1024 / 1024).toFixed(2), deltaHeapMB: heapDeltaMB };
}

// ── Save results ──────────────────────────────────────────────────────────────
async function saveResults() {
  const report = {
    generatedAt: new Date().toISOString(),
    totalChats: RESULTS.chats.length,
    chatsByType: {
      groups: RESULTS.chats.filter(c => c.type === 'GROUP').length,
      dms: RESULTS.chats.filter(c => c.type === 'DM').length,
      broadcasts: RESULTS.chats.filter(c => c.type === 'BROADCAST').length,
    },
    messageThreads: RESULTS.messages.length,
    mediaDownloads: RESULTS.media.length,
    errors: RESULTS.errors,
    dedupProof: RESULTS.dedupProof,
    memory: RESULTS.memory,
    chats: RESULTS.chats,
    messages: RESULTS.messages,
    media: RESULTS.media,
    storage: RESULTS.storage,
  };
  fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 2), 'utf-8');

  // Print JSON summary to console
  console.log('\n══════════════════════════════════════');
  console.log('FINAL REPORT SUMMARY');
  console.log('══════════════════════════════════════');
  console.log(`Chats found:       ${report.totalChats}`);
  console.log(`  Groups:          ${report.chatsByType.groups}`);
  console.log(`  DMs:             ${report.chatsByType.dms}`);
  console.log(`  Broadcasts:      ${report.chatsByType.broadcasts}`);
  console.log(`Message threads:   ${report.messageThreads}`);
  console.log(`Media downloaded:  ${report.mediaDownloads}`);
  console.log(`Errors:            ${report.errors.length}`);
  console.log(`Dedup working:     ${RESULTS.dedupProof?.pass ? '✅ YES' : '❌ NO'}`);
  console.log(`Memory (heap):     ${RESULTS.memory?.heapUsedMB} MB`);
  console.log(`Full report:       ${JSON_OUT}`);
}

// ── Boot ──────────────────────────────────────────────────────────────────────
process.on('unhandledRejection', (r) => { console.error('[UNHANDLED]', r); });
process.on('uncaughtException', (e) => { console.error('[UNCAUGHT]', e); process.exit(1); });

console.log('[BOOT] Initializing test client (using existing session)...');
client.initialize().catch((e) => {
  console.error('[FATAL] initialize() failed:', e.message);
  process.exit(1);
});
