const fs = require('fs');
const path = require('path');
const readline = require('readline');
const pino = require('pino');

const SESSION_DIR = path.join(__dirname, 'session');
if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(r => rl.question(q, a => r(a.trim())));

let sock = null;
let baileys = null;
let running = true;
let reconnecting = false;
let cachedVersion = null;

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  white: '\x1b[37m',
  blue: '\x1b[34m',
};

function log(msg, color, isBold = false) {
  const boldCode = isBold ? C.bold : '';
  console.log(`${boldCode}${C[color] || ''}${msg}${C.reset}`);
}

function hardClear() {
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H'); 
}

function banner() {
  hardClear();
  console.log(C.cyan + "═".repeat(65) + C.reset);
  console.log(C.bold + C.red + "   _______  _______  _______  _______  _______          ");
  console.log(C.bold + C.yellow + "  (  ____ )(  ___  )(  ____ \\(  ____ \\(  ___  )|\\     /|");
  console.log(C.bold + C.green + "  | (    )|| (   ) || (    \\/| (    \\/| (   ) |( \\   / )");
  console.log(C.bold + C.cyan + "  | (____)|| (___) || (__    | (__    | (___) | \\ (_) / ");
  console.log(C.bold + C.blue + "  |     __)|  ___  ||  __)   |  __)   |  ___  |  \\   /  ");
  console.log(C.bold + C.magenta + "  | (\\ (   | (   ) || (      | (      | (   ) |   ) (   ");
  console.log(C.bold + C.red + "  | ) \\ \\__| )   ( || )      | )      | )   ( |   | |   ");
  console.log(C.bold + C.yellow + "  |/   \\__/|/     \\||/       |/       |/     \\|   \\_/   ");
  console.log(C.bold + C.cyan + "                                                          ");
  console.log(C.bold + C.cyan + "             WHATSAPP ONLINE TERMUX SERVER");
  console.log(C.bold + C.green + "             CREATED BY: RAFFAY");
  console.log(C.cyan + "═".repeat(65) + C.reset);
  console.log("");
}

function makeSocket(state, saveCreds, version) {
  const { default: makeWASocket } = baileys;
  const s = makeWASocket({
    ...(version ? { version } : {}),
    logger: pino({ level: 'silent' }),
    auth: state,
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    keepAliveIntervalMs: 30000, 
    connectTimeoutMs: 60000,
    retryRequestDelayMs: 10000,
    maxMsgRetryCount: 5,
    defaultQueryTimeoutMs: 60000,
  });
  s.ev.on('creds.update', saveCreds);
  return s;
}

async function getVersion() {
  if (cachedVersion) return cachedVersion;
  try { 
    const r = await baileys.fetchLatestBaileysVersion(); 
    cachedVersion = r.version; 
    return cachedVersion; 
  } catch (_) { 
    return null; 
  }
}

async function connectAndPair(phone) {
  const { useMultiFileAuthState } = baileys;
  const version = await getVersion();
  let { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  let s = makeSocket(state, saveCreds, version);
  const isNew = !state.creds.registered;

  return new Promise((resolve, reject) => {
    let codeShown = false;
    let restarts = 0;
    let qrTimeout = null;

    if (isNew) {
      qrTimeout = setTimeout(() => {
        if (!codeShown) reject(new Error('QR event not received. Check internet and restart.'));
      }, 30000);
    }

    const onUpdate = async (u) => {
      const { connection, lastDisconnect, qr } = u || {};

      if (isNew && !codeShown && qr) {
        codeShown = true;
        clearTimeout(qrTimeout);
        try {
          const code = await s.requestPairingCode(phone);
          console.log("");
          log("═══════════════════════════════════════════", 'yellow');
          log(`  📱 PAIRING CODE:  ${C.bold}${code}${C.reset}`, 'yellow');
          log("═══════════════════════════════════════════", 'yellow');
          log("  1. OPEN WHATSAPP", 'cyan');
          log("  2. SETTINGS → LINKED DEVICES", 'cyan');
          log("  3. LINK A DEVICE → LINK WITH PHONE NUMBER", 'cyan');
          log("  4. ENTER THE CODE SHOWN ABOVE 👆", 'cyan');
          log("═══════════════════════════════════════════", 'yellow');
          console.log("");
          log("⏳ WAITING FOR CONNECTION...", 'cyan', true);
        } catch (e) {
          reject(new Error('Pairing code failed: ' + e.message));
        }
        return;
      }

      if (connection === 'open') {
        clearTimeout(qrTimeout);
        s.ev.off('connection.update', onUpdate);
        log("✅ WHATSAPP CONNECTED SUCCESSFULLY!", 'green', true);
        resolve(s);
        return;
      }

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        const msg = lastDisconnect?.error?.message || 'connection closed';

        if (code === 401) {
          clearTimeout(qrTimeout);
          s.ev.off('connection.update', onUpdate);
          reject(new Error('Logged out. Delete session folder and restart.'));
          return;
        }

        if ((code === 515 || code === 428 || code === 408) && restarts < 5) {
          restarts++;
          log(`🔄 Restarting socket (${restarts})...`, 'yellow', true);
          s.ev.off('connection.update', onUpdate);
          await new Promise(r => setTimeout(r, 1500));
          try {
            const fresh = await useMultiFileAuthState(SESSION_DIR);
            s = makeSocket(fresh.state, fresh.saveCreds, version);
            s.ev.on('connection.update', onUpdate);
          } catch (e) { reject(e); }
          return;
        }

        if (!isNew && !codeShown) {
          clearTimeout(qrTimeout);
          s.ev.off('connection.update', onUpdate);
          reject(new Error('Connection failed: ' + msg));
          return;
        }
      }
    };

    s.ev.on('connection.update', onUpdate);
  });
}

async function reconnect() {
  if (reconnecting) {
    while (reconnecting && running) await new Promise(r => setTimeout(r, 1000));
    return;
  }
  reconnecting = true;
  let attempt = 0;

  while (running) {
    attempt++;
    try {
      log(`🔄 CONNECTION LOST. RECONNECTING... (Attempt ${attempt})`, 'yellow', true);
      const { useMultiFileAuthState } = baileys;
      const version = await getVersion();
      const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
      
      const newSock = makeSocket(state, saveCreds, version);
      
      await new Promise((res, rej) => {
        const t = setTimeout(() => { 
          try { newSock.end(undefined); } catch(_) {}
          rej(new Error('timeout')); 
        }, 30000);
        
        const onUp = (u) => {
          if (u.connection === 'open') { 
            clearTimeout(t); 
            newSock.ev.off('connection.update', onUp); 
            res(); 
          }
          if (u.connection === 'close') { 
            clearTimeout(t); 
            newSock.ev.off('connection.update', onUp); 
            const code = u.lastDisconnect?.error?.output?.statusCode;
            rej(new Error(code === 401 ? 'logged_out' : 'close')); 
          }
        };
        newSock.ev.on('connection.update', onUp);
      });
      
      sock = newSock;
      log("✅ RECONNECTED SUCCESSFULLY! Resuming sending...", 'green', true);
      reconnecting = false;
      return;
      
    } catch (e) {
      if (e.message === 'logged_out') {
        log('❌ ACCOUNT LOGGED OUT. DELETE SESSION FOLDER.', 'red', true);
        process.exit(1);
      }
      log(`❌ Reconnect attempt ${attempt} failed. Retrying in 5s...`, 'red');
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  reconnecting = false;
}

function formatPhone(raw) {
  return String(raw || '').replace(/\D/g, '');
}

async function main() {
  banner();
  baileys = await import('@whiskeysockets/baileys');
  const { useMultiFileAuthState } = baileys;

  const { state } = await useMultiFileAuthState(SESSION_DIR);
  const isRegistered = !!state.creds.registered;

  let phone = null;
  if (!isRegistered) {
    while (true) {
      const p = await ask(`${C.bold}${C.cyan}📱 ENTER WHATSAPP NUMBER (WITH COUNTRY CODE): ${C.reset}`);
      const clean = formatPhone(p);
      if (/^\d{7,15}$/.test(clean)) { phone = clean; break; }
      log('❌ Invalid number. Enter 7-15 digits.', 'red');
    }
    log("⏳ CONNECTING TO WHATSAPP...", 'cyan', true);
  } else {
    log("✅ SESSION FOUND. CONNECTING...", 'cyan', true);
  }

  sock = await connectAndPair(phone);

  hardClear(); 
  banner();

  log("═══════════════════════════════════════════", 'magenta');
  log("  🎯 SELECT MESSAGE TARGET", 'magenta', true);
  log("  [1] SINGLE NUMBER / CONTACT", 'cyan');
  log("  [2] GROUP CHAT", 'cyan');
  log("═══════════════════════════════════════════", 'magenta');
  
  const choice = (await ask(`${C.bold}${C.cyan}➤ TYPE 1 OR 2: ${C.reset}`)) || '1';

  let targets = [];
  if (choice === '2') {
    log("📥 LOADING GROUPS...", 'yellow', true);
    const groups = await sock.groupFetchAllParticipating();
    const list = Object.values(groups || {});
    if (!list.length) { log("❌ No groups found.", 'red'); process.exit(1); }
    list.forEach((g, i) => console.log(`  ${C.bold}${C.cyan}[${i + 1}]${C.reset} ${g.subject}`));
    const pick = await ask(`\n${C.bold}${C.cyan}➤ GROUP NUMBER(S) (COMMA SEPARATED): ${C.reset}`);
    const picks = pick.split(',').map(x => parseInt(x.trim()) - 1).filter(n => n >= 0 && n < list.length);
    if (!picks.length) { log("❌ No group selected.", 'red'); process.exit(1); }
    targets = picks.map(i => ({ jid: list[i].id, label: list[i].subject }));
  } else {
    const raw = await ask(`${C.bold}${C.cyan}📞 TARGET NUMBER(S) (COMMA SEPARATED): ${C.reset}`);
    const nums = raw.split(/[,\s]+/).map(formatPhone).filter(Boolean);
    if (!nums.length) { log("❌ No numbers provided.", 'red'); process.exit(1); }
    targets = nums.map(n => ({ jid: `${n}@s.whatsapp.net`, label: n }));
  }
  log(`✅ ${targets.length} TARGET(S) SET.`, 'green', true);

  const msgPath = (await ask(`${C.bold}${C.cyan}📄 MESSAGES FILE PATH (DEFAULT: messages.txt): ${C.reset}`)) || 'messages.txt';
  const absPath = path.isAbsolute(msgPath) ? msgPath : path.join(process.cwd(), msgPath);
  if (!fs.existsSync(absPath)) { log(`❌ File not found: ${absPath}`, 'red'); process.exit(1); }
  const messages = fs.readFileSync(absPath, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!messages.length) { log("❌ Messages file is empty.", 'red'); process.exit(1); }
  log(`✅ ${messages.length} MESSAGES LOADED.`, 'green', true);

  const delayInput = await ask(`${C.bold}${C.cyan}⏱️  DELAY BETWEEN MESSAGES (SECONDS, DEFAULT 10): ${C.reset}`);
  const delaySec = Math.max(1, parseInt(delayInput) || 10);

  rl.close();

  console.log("");
  log("═══════════════════════════════════════════", 'magenta');
  log("  🚀 BOT STARTED SUCCESSFULLY", 'magenta', true);
  log(`  📨 TOTAL MESSAGES: ${messages.length}`, 'cyan');
  log(`  🎯 TOTAL TARGETS:  ${targets.length}`, 'cyan');
  log(`  ⏱️  DELAY TIME:     ${delaySec}s`, 'cyan');
  log("  🛑 PRESS CTRL+C TO STOP", 'red');
  log("═══════════════════════════════════════════", 'magenta');
  console.log("");

  let idx = 0;
  while (running) {
    if (!sock) {
      await reconnect();
      if (!running) break;
      if (!sock) { await new Promise(r => setTimeout(r, 2000)); continue; }
    }

    const msg = messages[idx % messages.length];
    const target = targets[idx % targets.length];
    
    // YAHAN TIMEZONE CHANGE KIYA HAI (Asia/Karachi)
    const ts = new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Karachi' });
    
    const preview = msg.length > 70 ? msg.slice(0, 70) + '...' : msg;

    try {
      await sock.sendMessage(target.jid, { text: msg });
      
      console.log("\n" + C.bold + C.green + "═══════════════════════════════════════════" + C.reset);
      log(`[TIME: ${ts}] ✅ MESSAGE SENT SUCCESSFULLY`, 'green', true);
      log(`🎯 TARGET : ${target.label}`, 'cyan');
      log(`💬 MESSAGE: ${preview}`, 'white');
      console.log(C.bold + C.green + "═══════════════════════════════════════════" + C.reset + "\n");
      
      idx++; 
    } catch (e) {
      log(`[${ts}] ❌ FAILED TO SEND → ${target.label}`, 'red', true);
      log(`Reason: ${e.message}`, 'red');
      
      try { sock.end(undefined); } catch(_) {}
      sock = null; 
      
      await new Promise(r => setTimeout(r, 2000)); 
      continue; 
    }
    
    await new Promise(r => setTimeout(r, delaySec * 1000));
  }
}

process.on('SIGINT', () => {
  console.log("");
  log("👋 STOPPING BOT...", 'yellow', true);
  running = false;
  try { rl.close(); } catch (_) {}
  setTimeout(() => process.exit(0), 500);
});

main().catch(e => {
  log('❌ FATAL ERROR: ' + (e?.message || e), 'red', true);
  process.exit(1);
});
