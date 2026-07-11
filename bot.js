const fs = require('fs');
const path = require('path');
const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const { GoogleGenAI } = require('@google/genai');

const CONFIG_FILE = path.join(__dirname, 'config.json');
const HORARIOS_FILE = path.join(__dirname, 'horarios.json');
const TURNOS_FILE = path.join(__dirname, 'turnos.json');
const TRABAJOS_FILE = path.join(__dirname, 'trabajos.json');

const DIAS_SEMANA = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
const DIAS_ABREV = { 'dom':0,'domingo':0, 'lun':1,'lunes':1, 'mar':2,'martes':2, 'mie':3,'miercoles':3, 'jue':4,'jueves':4, 'vie':5,'viernes':5, 'sab':6,'sabado':6 };

function loadJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch { return (file.endsWith('turnos.json') || file.endsWith('trabajos.json')) ? [] : {}; }
}

function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
}

function getConfig() {
  return loadJSON(CONFIG_FILE);
}

function startServer(app, port, resolve) {
  const maxAttempts = 5;
  function attempt(n) {
    const s = app.listen(port);
    s.on('error', err => {
      if (err.code === 'EADDRINUSE') {
        console.error(`⚠️ Puerto ${port} en uso (intento ${n}/${maxAttempts}). Liberando...`);
        try {
          require('child_process').execSync(`fuser -k ${port}/tcp 2>/dev/null`, { timeout: 3000 });
        } catch {}
        if (n < maxAttempts) {
          setTimeout(() => attempt(n + 1), 1500);
        } else {
          console.error('❌ No se pudo liberar el puerto. Cerrando.');
          process.exit(1);
        }
      } else {
        console.error('❌ Error del servidor:', err.message);
        process.exit(1);
      }
    });
    s.on('listening', () => {
      console.log(`🌐 Web UI: http://localhost:${port}`);
      resolve(s);
    });
  }
  attempt(1);
}

function createBot(port) {
  let responseCount = 0;
  let botReady = false;
  let lastQR = null;
  let lastQRText = '';
  let lastMessageLog = [];
  let client = null;
  const userStates = new Map();
  let ai = new GoogleGenAI({ apiKey: getConfig().geminiApiKey });

  function migrateHorarios() {
    const horarios = loadJSON(HORARIOS_FILE);
    if (isOldHorarios(horarios)) {
      const keys = Object.keys(horarios);
      const backupPath = HORARIOS_FILE.replace('.json', '_backup.json');
      fs.writeFileSync(backupPath, JSON.stringify(horarios, null, 2), 'utf-8');
      saveJSON(HORARIOS_FILE, {});
      console.log(`🗓️ Migración: horarios con formato antiguo (${keys.length} fechas) → respaldado en horarios_backup.json`);
    }
  }
  migrateHorarios();

  function reloadConfig() {
    delete require.cache[require.resolve('./config')];
    const cfg = getConfig();
    ai = new GoogleGenAI({ apiKey: cfg.geminiApiKey || '' });
    return cfg;
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  }

  function tomorrowStr() {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  }

  function parseDate(text) {
    const t = text.toLowerCase().trim();
    if (t === 'hoy') return todayStr();
    if (t === 'mañana' || t === 'manana') return tomorrowStr();
    let day, month;
    const matchDM = t.match(/(\d{1,2})\s*[/\-]\s*(\d{1,2})/);
    if (matchDM) { day = parseInt(matchDM[1]); month = parseInt(matchDM[2]); }
    else {
      const meses = { 'enero':1,'febrero':2,'marzo':3,'abril':4,'mayo':5,'junio':6,'julio':7,'agosto':8,'septiembre':9,'octubre':10,'noviembre':11,'diciembre':12 };
      const matchDE = t.match(/(\d{1,2})\s*de\s*(\w+)/);
      if (matchDE) { day = parseInt(matchDE[1]); month = meses[matchDE[2]]; if (!month) return null; }
      else {
        const matchN = t.match(/(\d{1,2})/);
        if (matchN) { day = parseInt(matchN[1]); month = new Date().getMonth() + 1; }
        else return null;
      }
    }
    const year = new Date().getFullYear();
    return `${year}-${pad(month)}-${pad(day)}`;
  }

  function parseTime(text) {
    const t = text.toLowerCase().trim();
    const match = t.match(/(?:a\s*las\s*)?(\d{1,2})(?::(\d{2}))?\b/);
    if (!match) return null;
    const h = pad(parseInt(match[1]));
    const m = match[2] ? pad(parseInt(match[2])) : '00';
    return `${h}:${m}`;
  }

  function parseWeekday(text) {
    const t = text.toLowerCase().trim();
    return DIAS_ABREV[t] !== undefined ? DIAS_SEMANA[DIAS_ABREV[t]] : null;
  }

  function getNextDateForWeekday(dayName, fromDate) {
    const targetDay = DIAS_SEMANA.indexOf(dayName);
    if (targetDay === -1) return null;
    const start = fromDate || new Date();
    const currentDay = start.getDay();
    let diff = targetDay - currentDay;
    if (diff <= 0) diff += 7;
    const next = new Date(start);
    next.setDate(start.getDate() + diff);
    return `${next.getFullYear()}-${pad(next.getMonth()+1)}-${pad(next.getDate())}`;
  }

  function isOldHorarios(horarios) {
    return Object.keys(horarios).length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(Object.keys(horarios)[0]);
  }

  function getAvailableWeekdays() {
    const horarios = loadJSON(HORARIOS_FILE);
    return DIAS_SEMANA.filter(d => horarios[d] && horarios[d].length > 0);
  }

  function getHorariosForDay(dayName) {
    const horarios = loadJSON(HORARIOS_FILE);
    return horarios[dayName] || [];
  }

  function getBookedTimesForDate(dateStr) {
    const turnos = loadJSON(TURNOS_FILE);
    return turnos.filter(t => t.fecha === dateStr).map(t => t.hora);
  }

  function getAvailableTimesForDate(dateStr) {
    const d = new Date(dateStr + 'T12:00:00');
    if (isNaN(d.getTime())) return [];
    const dayName = DIAS_SEMANA[d.getDay()];
    const allTimes = getHorariosForDay(dayName);
    const booked = getBookedTimesForDate(dateStr);
    return allTimes.filter(t => !booked.includes(t));
  }

  function addTurno(turno) {
    const turnos = loadJSON(TURNOS_FILE);
    turnos.push(turno);
    saveJSON(TURNOS_FILE, turnos);
  }

  function addTrabajo(trabajo) {
    const trabajos = loadJSON(TRABAJOS_FILE);
    trabajo.id = Date.now();
    trabajo.estado = 'pendiente';
    trabajo.timestamp = new Date().toISOString();
    trabajos.push(trabajo);
    saveJSON(TRABAJOS_FILE, trabajos);
  }

  function resetState(from) { userStates.delete(from); }

  function formatDateStr(dateStr) { const [y,m,d] = dateStr.split('-'); return `${d}/${m}`; }

  const meses = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  function formatDateNice(dateStr) { const [y,m,d] = dateStr.split('-'); return `${parseInt(d)} de ${meses[parseInt(m)-1]}`; }

  function formatDateShort(dateStr) { const [y,m,d] = dateStr.split('-'); return `${d}/${m}`; }

  function isGroupMsg(msg) { return msg.from.endsWith('@g.us'); }

  function getTopic(text) {
    const t = text.toLowerCase();
    const cfg = getConfig();
    if (cfg.bookingTriggers && cfg.bookingTriggers.some(k => t.includes(k))) return 'Reserva de turno';
    if (cfg.workTriggers && cfg.workTriggers.some(k => t.includes(k))) return 'Pedido de trabajo';
    if (cfg.consultTriggers && cfg.consultTriggers.some(k => t.includes(k))) return 'Consulta de horarios';
    return 'Consulta general';
  }

  function formatDayName(dayName) {
    return dayName.charAt(0).toUpperCase() + dayName.slice(1);
  }

  async function handleBookingInput(msg, state) {
    const text = msg.body.toLowerCase().trim();
    if (text === 'cancelar' || text === 'no' || text === 'cancel') { resetState(msg.from); return 'Reserva cancelada. Si necesitás algo más, avisame.'; }
    switch (state.step) {
      case 'awaiting_fecha': {
        const dayName = parseWeekday(text);
        if (!dayName) {
          const days = getAvailableWeekdays();
          return `Decime un día de la semana disponible:\n${days.map(d => `- ${formatDayName(d)}`).join('\n')}`;
        }
        const times = getHorariosForDay(dayName);
        if (times.length === 0) return `No hay horarios disponibles para los ${formatDayName(dayName)}. Elegí otro día.`;
        const nextDate = getNextDateForWeekday(dayName);
        const available = getAvailableTimesForDate(nextDate);
        if (available.length === 0) return `El próximo ${formatDayName(dayName)} (${formatDateShort(nextDate)}) ya está completo. Elegí otro día o intentá más tarde.`;
        state.data.fecha = nextDate;
        state.data.dayName = dayName;
        state.step = 'awaiting_hora';
        return `📅 Para el próximo ${formatDayName(dayName)} (${formatDateNice(nextDate)}) los horarios libres son:\n${available.map(t => `- ${t}`).join('\n')}\n\n¿A qué hora te queda mejor?`;
      }
      case 'awaiting_hora': {
        const time = parseTime(text);
        if (!time) return 'No entendí la hora. Decila así nomás (ej: 10, 10:30, las 11).';
        const available = getAvailableTimesForDate(state.data.fecha);
        if (!available.includes(time)) return `Las ${time} no está disponible para el ${formatDateShort(state.data.fecha)}. Horarios libres:\n${available.map(t => `- ${t}`).join('\n')}`;
        state.data.hora = time;
        state.step = 'awaiting_nombre';
        return 'Perfecto. ¿Me decís tu nombre?';
      }
      case 'awaiting_nombre': {
        if (text.length < 2 || text.length > 50) return 'Decime un nombre válido.';
        state.data.nombre = msg.body.trim();
        state.step = 'awaiting_info';
        return `Gracias ${state.data.nombre}. ¿Alguna información adicional para el turno? (si no, decí "no")`;
      }
      case 'awaiting_info': {
        state.data.info = (text === 'no' || text === 'nada' || text === 'no gracias') ? '' : msg.body.trim();
        state.step = 'awaiting_confirmacion';
        return `📋 Resumen del turno:\n📅 ${formatDayName(state.data.dayName)} ${formatDateNice(state.data.fecha)} a las ${state.data.hora}\n👤 ${state.data.nombre}${state.data.info ? '\nInfo: '+state.data.info : ''}\n\n¿Confirmás? (sí/no)`;
      }
      case 'awaiting_confirmacion': {
        if (text === 'sí' || text === 'si' || text === 'dale' || text === 'ok' || text === 'confirmo') {
          const dateStr = state.data.fecha;
          const time = state.data.hora;
          const available = getAvailableTimesForDate(dateStr);
          if (!available.includes(time)) { resetState(msg.from); return 'Ese horario ya no está disponible. Iniciá de nuevo la reserva si querés.'; }
          addTurno({ fecha: dateStr, hora: time, nombre: state.data.nombre, telefono: msg.from.replace('@c.us', ''), info: state.data.info || '', confirmado: true, timestamp: new Date().toISOString() });
          resetState(msg.from);
          return `✅ Turno confirmado para el ${formatDateNice(dateStr)} a las ${time}.\nTe espero, ${state.data.nombre}!`;
        }
        if (text === 'no' || text === 'cancelar' || text === 'cancel') { resetState(msg.from); return 'Reserva cancelada. Si querés probar de nuevo, decime "turno".'; }
        return 'Respondé "sí" para confirmar o "no" para cancelar.';
      }
      default: resetState(msg.from); return 'Algo salió mal. Iniciá de nuevo la reserva si querés.';
    }
  }

  async function handleWorkInput(msg, state) {
    const text = msg.body.toLowerCase().trim();
    if (text === 'cancelar' || text === 'cancel') { resetState(msg.from); return 'Pedido cancelado. Si necesitás algo más, avisame.'; }
    switch (state.step) {
      case 'awaiting_work_desc': {
        if (text.length < 3) return 'Contame un poco más sobre lo que necesitás.';
        state.data.descripcion = msg.body.trim();
        const fields = getConfig().workFields || [];
        if (fields.length > 0) { state.data.fieldIdx = 0; state.data.fieldValues = {}; state.step = 'awaiting_work_field'; return `${fields[0].label}${fields[0].required ? '' : ' (opcional)'}`; }
        state.step = 'awaiting_nombre';
        return '¿Me decís tu nombre?';
      }
      case 'awaiting_work_field': {
        const fields = getConfig().workFields || [];
        const idx = state.data.fieldIdx || 0;
        const currentField = fields[idx];
        if (currentField && currentField.required && text.length < 1) return `${currentField.label} es obligatorio.`;
        state.data.fieldValues[currentField.name] = msg.body.trim();
        const nextIdx = idx + 1;
        if (nextIdx < fields.length) { state.data.fieldIdx = nextIdx; const nextField = fields[nextIdx]; return `${nextField.label}${nextField.required ? '' : ' (opcional)'}`; }
        state.step = 'awaiting_nombre';
        return '¿Me decís tu nombre?';
      }
      case 'awaiting_nombre': {
        if (text.length < 2 || text.length > 50) return 'Decime un nombre válido.';
        state.data.nombre = msg.body.trim();
        state.step = 'awaiting_info';
        return `Gracias ${state.data.nombre}. ¿Alguna información adicional? (si no, decí "no")`;
      }
      case 'awaiting_info': {
        state.data.info = (text === 'no' || text === 'nada') ? '' : msg.body.trim();
        const cfg = getConfig();
        if (cfg.businessType === 'ambos') {
          const days = getAvailableWeekdays();
          if (days.length > 0) { state.step = 'awaiting_fecha'; return `📅 También podés elegir día de entrega:\n${days.map(d => `- ${formatDayName(d)}`).join('\n')}\n\n¿Qué día te queda bien?\n(si no querés fecha, decí "no")`; }
        }
        state.step = 'awaiting_confirmacion';
        return buildWorkSummary(state.data);
      }
      case 'awaiting_fecha': {
        if (text === 'no') { state.data.fecha = ''; state.data.hora = ''; state.step = 'awaiting_confirmacion'; return buildWorkSummary(state.data); }
        const dayName = parseWeekday(text);
        if (!dayName) return 'Decime un día de la semana (ej: viernes, martes, etc.).';
        const times = getHorariosForDay(dayName);
        if (times.length === 0) return `No hay horarios disponibles para los ${formatDayName(dayName)}. Elegí otro día.`;
        const nextDate = getNextDateForWeekday(dayName);
        const available = getAvailableTimesForDate(nextDate);
        if (available.length === 0) return `El próximo ${formatDayName(dayName)} (${formatDateShort(nextDate)}) ya está completo. Elegí otro día.`;
        state.data.fecha = nextDate;
        state.data.dayName = dayName;
        state.data.timesForFecha = available;
        state.step = 'awaiting_hora';
        return `Horarios disponibles para el ${formatDayName(dayName)} (${formatDateNice(nextDate)}):\n${available.map(t => `- ${t}`).join('\n')}\n\n¿A qué hora?`;
      }
      case 'awaiting_hora': {
        const time = parseTime(text);
        if (!time) return 'No entendí la hora.';
        const available = state.data.timesForFecha || getAvailableTimesForDate(state.data.fecha);
        if (!available.includes(time)) return `Las ${time} no está disponible. Horarios libres:\n${available.map(t => `- ${t}`).join('\n')}`;
        state.data.hora = time;
        state.step = 'awaiting_confirmacion';
        return buildWorkSummary(state.data);
      }
      case 'awaiting_confirmacion': {
        if (text === 'sí' || text === 'si' || text === 'dale' || text === 'ok' || text === 'confirmo') {
          const d = state.data;
          if (d.fecha && d.hora) { if (!getAvailableTimesForDate(d.fecha).includes(d.hora)) { resetState(msg.from); return 'Ese horario ya no está disponible. Iniciá de nuevo.'; } }
          addTrabajo({ descripcion: d.descripcion, fieldValues: d.fieldValues || {}, nombre: d.nombre, telefono: msg.from.replace('@c.us', ''), info: d.info || '', fecha: d.fecha || '', hora: d.hora || '' });
          resetState(msg.from);
          let r = `✅ Pedido confirmado!\n📋 ${d.descripcion}`;
          if (d.fecha) r += `\n📅 ${formatDateNice(d.fecha)}${d.hora ? ' a las '+d.hora : ''}`;
          r += `\n👤 ${d.nombre}`;
          return r;
        }
        if (text === 'no') { resetState(msg.from); return 'Pedido cancelado.'; }
        return 'Respondé "sí" para confirmar o "no" para cancelar.';
      }
      default: resetState(msg.from); return 'Algo salió mal. Iniciá de nuevo.';
    }
  }

  function buildWorkSummary(data) {
    let r = `📋 Resumen del pedido:\n🔹 ${data.descripcion}`;
    if (data.fieldValues) for (const [k,v] of Object.entries(data.fieldValues)) if (v) r += `\n🔸 ${k}: ${v}`;
    r += `\n👤 ${data.nombre}`;
    if (data.info) r += `\n📝 ${data.info}`;
    if (data.fecha) r += `\n📅 ${formatDateNice(data.fecha)}${data.hora ? ' '+data.hora : ''}`;
    r += '\n\n¿Confirmás? (sí/no)';
    return r;
  }

  async function sendReply(msg, replyText) {
    if (!replyText) return;
    responseCount++;
    const from = msg.from.replace('@c.us', '').replace('@g.us', '');
    const topic = getTopic(msg.body);
    const now = new Date();
    const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    console.log(`[${time}] De: ${from} | Tema: ${topic} | Respuestas: ${responseCount}`);
    lastMessageLog.unshift({ from, topic, time, date: now.toISOString(), message: msg.body.slice(0, 80) });
    if (lastMessageLog.length > 50) lastMessageLog.pop();
    await msg.reply(replyText);
  }

  function setupClientEvents(c) {
    c.on('qr', async qr => {
      qrcodeTerminal.generate(qr, { small: true });
      lastQRText = qr;
      try { lastQR = await QRCode.toDataURL(qr); } catch { lastQR = null; }
      console.log('📱 QR generado (tamaño:', qr.length, 'caracteres)');
    });
    c.on('ready', () => {
      botReady = true;
      lastQR = null;
      lastQRText = '';
      console.log('✅ Bot conectado!');
    });
    c.on('message', async msg => {
      if (msg.from === 'status@broadcast') return;
      if (msg.fromMe) return;
      const cfg = getConfig();
      const isGroup = isGroupMsg(msg);
      const botNumber = client.info ? client.info.wid.user : null;
      const mentioned = msg.mentionedIds || [];
      if (isGroup && !mentioned.includes(botNumber)) return;
      const text = msg.body.toLowerCase().trim();
      if (!text) return;
      const state = userStates.get(msg.from);
      if (state && state.step !== 'idle') {
        const handler = state.type === 'work' ? handleWorkInput : handleBookingInput;
        return sendReply(msg, await handler(msg, state));
      }
      const isWork = cfg.workTriggers && cfg.workTriggers.some(k => text.includes(k));
      if (isWork) { userStates.set(msg.from, { type: 'work', step: 'awaiting_work_desc', data: {} }); return sendReply(msg, 'Describime qué trabajo necesitás (ej: un cartel, un mueble, un letrero) y los detalles que quieras.'); }
      const isBooking = cfg.bookingTriggers && cfg.bookingTriggers.some(k => text.includes(k));
      if (isBooking) {
        const days = getAvailableWeekdays();
        if (days.length === 0) return sendReply(msg, 'Actualmente no tengo días disponibles. Consultame más tarde.');
        userStates.set(msg.from, { type: 'booking', step: 'awaiting_fecha', data: {} });
        return sendReply(msg, `📅 Días disponibles:\n${days.map(d => `- ${formatDayName(d)}`).join('\n')}\n\nDecime qué día querés (ej: viernes, martes).`);
      }
      const isConsulta = cfg.consultTriggers && cfg.consultTriggers.some(k => text.includes(k));
      if (isConsulta) {
        const days = getAvailableWeekdays();
        if (days.length === 0) return sendReply(msg, 'No hay horarios disponibles por ahora.');
        return sendReply(msg, `Horarios disponibles:\n\n${days.map(d => `📅 ${formatDayName(d)}: ${getHorariosForDay(d).join(', ')}`).join('\n\n')}`);
      }
      const match = cfg.responses && cfg.responses.find(r => r.keywords.some(k => text.includes(k)));
      if (match) return sendReply(msg, match.reply);
      const modelName = cfg.aiModel || 'gemini-2.5-flash';
      try {
        const response = await ai.models.generateContent({ model: modelName, contents: msg.body, config: { systemInstruction: cfg.systemPrompt || 'Eres un asistente útil.', maxOutputTokens: 1024, temperature: 0.9 } });
        const reply = (response.text || '').trim();
        if (!reply) throw new Error('Respuesta vacía del modelo');
        return sendReply(msg, reply);
      } catch (err) {
        console.error(`[${msg.from}] Error:`, err.message);
        return sendReply(msg, 'Disculpa, ahora no puedo responder. Intenta más tarde.');
      }
    });
  }

  function createClient() {
    const c = new Client({
      authStrategy: new LocalAuth({ clientId: 'bot' }),
      puppeteer: { args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-first-run','--disable-sync'] },
      restartOnAuthFail: true,
    });
    setupClientEvents(c);
    return c;
  }

  async function reconnectWhatsApp() {
    if (client) { try { await client.destroy(); } catch {} }
    for (const dir of ['.wwebjs_auth', '.wwebjs_cache']) {
      const p = path.join(__dirname, dir);
      if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
    }
    botReady = false;
    lastQR = null;
    lastQRText = '';
    client = createClient();
    await client.initialize();
  }

  client = createClient();
  client.initialize().catch(err => {
    console.error('❌ Error al iniciar WhatsApp:', err.message);
    console.log('🔄 Reintentando en 5 segundos...');
    setTimeout(() => {
      client = createClient();
      client.initialize().catch(e => console.error('❌ Segundo intento falló:', e.message));
    }, 5000);
  });

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); next(); });

  app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html'), { dotfiles: 'allow' }));
  app.get('/horarios', (req, res) => res.sendFile(path.join(__dirname, 'public', 'horarios.html'), { dotfiles: 'allow' }));
  app.get('/turnos', (req, res) => res.sendFile(path.join(__dirname, 'public', 'turnos.html'), { dotfiles: 'allow' }));
  app.get('/settings', (req, res) => res.sendFile(path.join(__dirname, 'public', 'settings.html'), { dotfiles: 'allow' }));
  app.get('/trabajos', (req, res) => res.sendFile(path.join(__dirname, 'public', 'trabajos.html'), { dotfiles: 'allow' }));
  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/api/status', (req, res) => { res.json({ botReady, responseCount, qr: lastQR, qrText: lastQRText, uptime: process.uptime(), log: lastMessageLog }); });
  app.get('/api/horarios', (req, res) => { res.json(loadJSON(HORARIOS_FILE)); });
  app.post('/api/horarios', (req, res) => {
    const { dia, horas } = req.body;
    if (!dia || !horas || !Array.isArray(horas) || horas.length === 0) return res.status(400).json({ error: 'Falta dia u horas' });
    const dayName = DIAS_ABREV[dia.toLowerCase()] !== undefined ? DIAS_SEMANA[DIAS_ABREV[dia.toLowerCase()]] : null;
    if (!dayName) return res.status(400).json({ error: 'Día inválido. Usá: lunes, martes, miercoles, jueves, viernes, sabado, domingo' });
    const horarios = loadJSON(HORARIOS_FILE);
    horarios[dayName] = [...horas].sort();
    saveJSON(HORARIOS_FILE, horarios);
    res.json({ success: true, horarios });
  });
  app.delete('/api/horarios/:dia/:hora', (req, res) => {
    const { dia, hora } = req.params;
    const dayName = DIAS_ABREV[dia.toLowerCase()] !== undefined ? DIAS_SEMANA[DIAS_ABREV[dia.toLowerCase()]] : null;
    if (!dayName) return res.status(400).json({ error: 'Día inválido' });
    const horarios = loadJSON(HORARIOS_FILE);
    if (!horarios[dayName]) return res.status(404).json({ error: 'No encontrado' });
    const idx = horarios[dayName].indexOf(hora);
    if (idx === -1) return res.status(404).json({ error: 'Hora no encontrada' });
    horarios[dayName].splice(idx, 1);
    if (horarios[dayName].length === 0) delete horarios[dayName];
    saveJSON(HORARIOS_FILE, horarios);
    res.json({ success: true, horarios });
  });
  app.delete('/api/horarios/:dia', (req, res) => {
    const { dia } = req.params;
    const dayName = DIAS_ABREV[dia.toLowerCase()] !== undefined ? DIAS_SEMANA[DIAS_ABREV[dia.toLowerCase()]] : null;
    if (!dayName) return res.status(400).json({ error: 'Día inválido' });
    const horarios = loadJSON(HORARIOS_FILE);
    if (!horarios[dayName]) return res.status(404).json({ error: 'Día no encontrado' });
    delete horarios[dayName];
    saveJSON(HORARIOS_FILE, horarios);
    res.json({ success: true, horarios });
  });
  app.get('/api/turnos', (req, res) => { const { fecha } = req.query; let turnos = loadJSON(TURNOS_FILE); if (fecha) turnos = turnos.filter(t => t.fecha === fecha); res.json(turnos); });
  app.delete('/api/turnos/:index', (req, res) => {
    const idx = parseInt(req.params.index);
    const turnos = loadJSON(TURNOS_FILE);
    if (isNaN(idx) || idx < 0 || idx >= turnos.length) return res.status(404).json({ error: 'Turno no encontrado' });
    turnos.splice(idx, 1);
    saveJSON(TURNOS_FILE, turnos);
    res.json({ success: true, turnos });
  });
  app.get('/api/trabajos', (req, res) => { res.json(loadJSON(TRABAJOS_FILE)); });
  app.delete('/api/trabajos/:id', (req, res) => {
    const id = parseInt(req.params.id);
    let trabajos = loadJSON(TRABAJOS_FILE);
    const idx = trabajos.findIndex(t => t.id === id);
    if (idx === -1) return res.status(404).json({ error: 'No encontrado' });
    trabajos.splice(idx, 1);
    saveJSON(TRABAJOS_FILE, trabajos);
    res.json({ success: true });
  });
  app.patch('/api/trabajos/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const trabajos = loadJSON(TRABAJOS_FILE);
    const t = trabajos.find(t => t.id === id);
    if (!t) return res.status(404).json({ error: 'No encontrado' });
    if (req.body.estado) t.estado = req.body.estado;
    saveJSON(TRABAJOS_FILE, trabajos);
    res.json({ success: true });
  });
  app.get('/api/config', (req, res) => { const c = getConfig(); res.json({ aiModel: c.aiModel, systemPrompt: c.systemPrompt, businessType: c.businessType, businessName: c.businessName, bookingTriggers: c.bookingTriggers, workTriggers: c.workTriggers, consultTriggers: c.consultTriggers, workFields: c.workFields, responses: c.responses, hasApiKey: !!(c.geminiApiKey) }); });
  app.post('/api/config', (req, res) => {
    try {
      const cfg = getConfig(); const body = req.body;
      if (body.geminiApiKey !== undefined) cfg.geminiApiKey = body.geminiApiKey;
      if (body.aiModel !== undefined) cfg.aiModel = body.aiModel;
      if (body.systemPrompt !== undefined) cfg.systemPrompt = body.systemPrompt;
      if (body.businessType !== undefined) cfg.businessType = body.businessType;
      if (body.businessName !== undefined) cfg.businessName = body.businessName;
      if (body.bookingTriggers !== undefined) cfg.bookingTriggers = body.bookingTriggers;
      if (body.workTriggers !== undefined) cfg.workTriggers = body.workTriggers;
      if (body.consultTriggers !== undefined) cfg.consultTriggers = body.consultTriggers;
      if (body.workFields !== undefined) cfg.workFields = body.workFields;
      if (body.responses !== undefined) cfg.responses = body.responses;
      saveJSON(CONFIG_FILE, cfg);
      reloadConfig();
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
  app.post('/api/reconnect', async (req, res) => { try { await reconnectWhatsApp(); res.json({ success: true }); } catch (err) { res.status(500).json({ error: err.message }); } });

  return new Promise(resolve => startServer(app, port, resolve));
}

module.exports = { createBot };
