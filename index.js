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

let ai = new GoogleGenAI({ apiKey: getConfig().geminiApiKey });

function reloadConfig() {
  delete require.cache[require.resolve('./config')];
  const cfg = getConfig();
  ai = new GoogleGenAI({ apiKey: cfg.geminiApiKey || '' });
  return cfg;
}

let responseCount = 0;
let botReady = false;
let lastQR = null;
let lastQRText = '';
let lastMessageLog = [];
let client = null;
const userStates = new Map();

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
  if (matchDM) {
    day = parseInt(matchDM[1]);
    month = parseInt(matchDM[2]);
  } else {
    const meses = { 'enero':1,'febrero':2,'marzo':3,'abril':4,'mayo':5,'junio':6,'julio':7,'agosto':8,'septiembre':9,'octubre':10,'noviembre':11,'diciembre':12 };
    const matchDE = t.match(/(\d{1,2})\s*de\s*(\w+)/);
    if (matchDE) {
      day = parseInt(matchDE[1]);
      month = meses[matchDE[2]];
      if (!month) return null;
    } else {
      const matchN = t.match(/(\d{1,2})/);
      if (matchN) {
        day = parseInt(matchN[1]);
        month = new Date().getMonth() + 1;
      } else {
        return null;
      }
    }
  }

  const year = new Date().getFullYear();
  const dateStr = `${year}-${pad(month)}-${pad(day)}`;
  return dateStr;
}

function parseTime(text) {
  const t = text.toLowerCase().trim();
  const match = t.match(/(?:a\s*las\s*)?(\d{1,2})(?::(\d{2}))?\b/);
  if (!match) return null;
  const h = pad(parseInt(match[1]));
  const m = match[2] ? pad(parseInt(match[2])) : '00';
  return `${h}:${m}`;
}

function getAvailableDates() {
  const horarios = loadJSON(HORARIOS_FILE);
  return Object.keys(horarios).sort();
}

function getAvailableTimes(date) {
  const horarios = loadJSON(HORARIOS_FILE);
  return horarios[date] || [];
}

function removeTime(date, time) {
  const horarios = loadJSON(HORARIOS_FILE);
  if (!horarios[date]) return false;
  const idx = horarios[date].indexOf(time);
  if (idx === -1) return false;
  horarios[date].splice(idx, 1);
  if (horarios[date].length === 0) delete horarios[date];
  saveJSON(HORARIOS_FILE, horarios);
  return true;
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

function resetState(from) {
  userStates.delete(from);
}

function formatDateStr(dateStr) {
  const [y, m, d] = dateStr.split('-');
  return `${d}/${m}`;
}

const meses = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
function formatDateNice(dateStr) {
  const [y, m, d] = dateStr.split('-');
  return `${parseInt(d)} de ${meses[parseInt(m)-1]}`;
}

function formatDateShort(dateStr) {
  const [y, m, d] = dateStr.split('-');
  return `${d}/${m}`;
}

function isGroupMsg(msg) {
  return msg.from.endsWith('@g.us');
}

function getTopic(text) {
  const t = text.toLowerCase();
  const cfg = getConfig();
  if (cfg.bookingTriggers && cfg.bookingTriggers.some(k => t.includes(k))) return 'Reserva de turno';
  if (cfg.workTriggers && cfg.workTriggers.some(k => t.includes(k))) return 'Pedido de trabajo';
  if (cfg.consultTriggers && cfg.consultTriggers.some(k => t.includes(k))) return 'Consulta de horarios';
  return 'Consulta general';
}

async function handleBookingInput(msg, state) {
  const text = msg.body.toLowerCase().trim();

  if (text === 'cancelar' || text === 'no' || text === 'cancel') {
    resetState(msg.from);
    return 'Reserva cancelada. Si necesitás algo más, avisame.';
  }

  switch (state.step) {
    case 'awaiting_fecha': {
      const dateStr = parseDate(text);
      if (!dateStr) return 'No entendí la fecha. Decime un día disponible (ej: 12/06, 12 de junio, mañana).';

      const times = getAvailableTimes(dateStr);
      if (times.length === 0) return `No hay horarios disponibles para el ${formatDateNice(dateStr)}. Elegí otro día.`;

      state.data.fecha = dateStr;
      state.step = 'awaiting_hora';
      const timesList = times.map(t => `- ${t}`).join('\n');
      return `📅 Para el ${formatDateNice(dateStr)} los horarios disponibles son:\n${timesList}\n\n¿A qué hora te queda mejor?`;
    }

    case 'awaiting_hora': {
      const time = parseTime(text);
      if (!time) return 'No entendí la hora. Decila así nomás (ej: 10, 10:30, las 11).';

      const times = getAvailableTimes(state.data.fecha);
      if (!times.includes(time)) return `Las ${time} no está disponible para el ${formatDateShort(state.data.fecha)}. Horarios libres:\n${times.map(t => `- ${t}`).join('\n')}`;

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
      const fecha = formatDateNice(state.data.fecha);
      const hora = state.data.hora;
      const info = state.data.info ? `\nInfo: ${state.data.info}` : '';
      return `📋 Resumen del turno:\n📅 ${fecha} a las ${hora}\n👤 ${state.data.nombre}${info}\n\n¿Confirmás? (sí/no)`;
    }

    case 'awaiting_confirmacion': {
      if (text === 'sí' || text === 'si' || text === 'si, sí' || text === 'dale' || text === 'ok' || text === 'confirmo') {
        const dateStr = state.data.fecha;
        const time = state.data.hora;

        const stillAvailable = getAvailableTimes(dateStr).includes(time);
        if (!stillAvailable) {
          resetState(msg.from);
          return 'Ese horario ya no está disponible. Iniciá de nuevo la reserva si querés.';
        }

        removeTime(dateStr, time);

        const turno = {
          fecha: dateStr,
          hora: time,
          nombre: state.data.nombre,
          telefono: msg.from.replace('@c.us', ''),
          info: state.data.info || '',
          confirmado: true,
          timestamp: new Date().toISOString(),
        };
        addTurno(turno);

        resetState(msg.from);
        return `✅ Turno confirmado para el ${formatDateNice(dateStr)} a las ${time}.\nTe espero, ${state.data.nombre}!`;
      }

      if (text === 'no' || text === 'cancelar' || text === 'cancel') {
        resetState(msg.from);
        return 'Reserva cancelada. Si querés probar de nuevo, decime "turno".';
      }

      return 'Respondé "sí" para confirmar o "no" para cancelar.';
    }

    default:
      resetState(msg.from);
      return 'Algo salió mal. Iniciá de nuevo la reserva si querés.';
  }
}

async function handleWorkInput(msg, state) {
  const text = msg.body.toLowerCase().trim();

  if (text === 'cancelar' || text === 'cancel') {
    resetState(msg.from);
    return 'Pedido cancelado. Si necesitás algo más, avisame.';
  }

  switch (state.step) {
    case 'awaiting_work_desc': {
      if (text.length < 3) return 'Contame un poco más sobre lo que necesitás.';
      state.data.descripcion = msg.body.trim();
      const fields = getConfig().workFields || [];
      if (fields.length > 0) {
        state.data.fieldIdx = 0;
        state.data.fieldValues = {};
        state.step = 'awaiting_work_field';
        const f = fields[0];
        return `${f.label}${f.required ? '' : ' (opcional)'}`;
      }
      state.step = 'awaiting_nombre';
      return '¿Me decís tu nombre?';
    }

    case 'awaiting_work_field': {
      const fields = getConfig().workFields || [];
      const idx = state.data.fieldIdx || 0;
      const currentField = fields[idx];
      if (currentField && currentField.required && text.length < 1) {
        return `${currentField.label} es obligatorio.`;
      }
      state.data.fieldValues[currentField.name] = msg.body.trim();
      const nextIdx = idx + 1;
      if (nextIdx < fields.length) {
        state.data.fieldIdx = nextIdx;
        const nextField = fields[nextIdx];
        return `${nextField.label}${nextField.required ? '' : ' (opcional)'}`;
      }
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
        const dates = getAvailableDates();
        if (dates.length > 0) {
          state.step = 'awaiting_fecha';
          const datesList = dates.map(d => `- ${formatDateNice(d)}`).join('\n');
          return `📅 También podés elegir día de entrega:\n${datesList}\n\n¿Qué día te queda bien?\n(si no querés fecha, decí "no")`;
        }
      }

      state.step = 'awaiting_confirmacion';
      return buildWorkSummary(state.data);
    }

    case 'awaiting_fecha': {
      if (text === 'no') {
        state.data.fecha = '';
        state.data.hora = '';
        state.step = 'awaiting_confirmacion';
        return buildWorkSummary(state.data);
      }
      const dateStr = parseDate(text);
      if (!dateStr) return 'No entendí la fecha.';
      const times = getAvailableTimes(dateStr);
      if (times.length === 0) return `No hay horarios para el ${formatDateNice(dateStr)}. Elegí otro.`;
      state.data.fecha = dateStr;
      state.step = 'awaiting_hora';
      return `Horarios disponibles:\n${times.map(t => `- ${t}`).join('\n')}\n\n¿A qué hora?`;
    }

    case 'awaiting_hora': {
      const time = parseTime(text);
      if (!time) return 'No entendí la hora.';
      const times = getAvailableTimes(state.data.fecha);
      if (!times.includes(time)) return `Las ${time} no está disponible.`;
      state.data.hora = time;
      state.step = 'awaiting_confirmacion';
      return buildWorkSummary(state.data);
    }

    case 'awaiting_confirmacion': {
      if (text === 'sí' || text === 'si' || text === 'dale' || text === 'ok' || text === 'confirmo') {
        const d = state.data;
        if (d.fecha && d.hora) {
          const still = getAvailableTimes(d.fecha).includes(d.hora);
          if (!still) {
            resetState(msg.from);
            return 'Ese horario ya no está disponible. Iniciá de nuevo.';
          }
          removeTime(d.fecha, d.hora);
        }

        addTrabajo({
          descripcion: d.descripcion,
          fieldValues: d.fieldValues || {},
          nombre: d.nombre,
          telefono: msg.from.replace('@c.us', ''),
          info: d.info || '',
          fecha: d.fecha || '',
          hora: d.hora || '',
        });

        resetState(msg.from);
        let r = `✅ Pedido confirmado!\n📋 ${d.descripcion}`;
        if (d.fecha) r += `\n📅 ${formatDateNice(d.fecha)} ${d.hora ? 'a las ' + d.hora : ''}`;
        r += `\n👤 ${d.nombre}`;
        return r;
      }
      if (text === 'no') {
        resetState(msg.from);
        return 'Pedido cancelado.';
      }
      return 'Respondé "sí" para confirmar o "no" para cancelar.';
    }

    default:
      resetState(msg.from);
      return 'Algo salió mal. Iniciá de nuevo.';
  }
}

function buildWorkSummary(data) {
  let r = `📋 Resumen del pedido:\n🔹 ${data.descripcion}`;
  if (data.fieldValues) {
    for (const [k, v] of Object.entries(data.fieldValues)) {
      if (v) r += `\n🔸 ${k}: ${v}`;
    }
  }
  r += `\n👤 ${data.nombre}`;
  if (data.info) r += `\n📝 ${data.info}`;
  if (data.fecha) r += `\n📅 ${formatDateNice(data.fecha)}${data.hora ? ' ' + data.hora : ''}`;
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
      const reply = await handler(msg, state);
      return sendReply(msg, reply);
    }

    const isWork = cfg.workTriggers && cfg.workTriggers.some(k => text.includes(k));
    if (isWork) {
      userStates.set(msg.from, { type: 'work', step: 'awaiting_work_desc', data: {} });
      return sendReply(msg, 'Describime qué trabajo necesitás (ej: un cartel, un mueble, un letrero) y los detalles que quieras.');
    }

    const isBooking = cfg.bookingTriggers && cfg.bookingTriggers.some(k => text.includes(k));
    if (isBooking) {
      const dates = getAvailableDates();
      if (dates.length === 0) {
        return sendReply(msg, 'Actualmente no tengo días disponibles. Consultame más tarde.');
      }
      userStates.set(msg.from, { type: 'booking', step: 'awaiting_fecha', data: {} });
      const datesList = dates.map(d => `- ${formatDateNice(d)}`).join('\n');
      return sendReply(msg, `📅 Días disponibles:\n${datesList}\n\nDecime para qué día querés el turno.`);
    }

    const isConsulta = cfg.consultTriggers && cfg.consultTriggers.some(k => text.includes(k));
    if (isConsulta) {
      const dates = getAvailableDates();
      if (dates.length === 0) return sendReply(msg, 'No hay horarios disponibles por ahora.');
      const lines = dates.map(d => {
        const times = getAvailableTimes(d);
        if (times.length === 0) return null;
        return `📅 ${formatDateNice(d)}:\n  ${times.join(', ')}`;
      }).filter(Boolean);
      return sendReply(msg, `Horarios disponibles:\n\n${lines.join('\n\n')}`);
    }

    const match = cfg.responses && cfg.responses.find(r =>
      r.keywords.some(k => text.includes(k))
    );
    if (match) return sendReply(msg, match.reply);

    const modelName = cfg.aiModel || 'gemini-2.5-flash';
    try {
      const response = await ai.models.generateContent({
        model: modelName,
        contents: msg.body,
        config: {
          systemInstruction: cfg.systemPrompt || 'Eres un asistente útil.',
          maxOutputTokens: 1024,
          temperature: 0.9,
        },
      });
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
    puppeteer: {
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--disable-sync',
      ],
    },
    restartOnAuthFail: true,
  });
  setupClientEvents(c);
  return c;
}

async function reconnectWhatsApp() {
  if (client) {
    try { await client.destroy(); } catch {}
  }
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

// ─── Express Web UI ─────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/horarios', (req, res) => res.sendFile(path.join(__dirname, 'public', 'horarios.html')));
app.get('/turnos', (req, res) => res.sendFile(path.join(__dirname, 'public', 'turnos.html')));
app.get('/settings', (req, res) => res.sendFile(path.join(__dirname, 'public', 'settings.html')));
app.get('/trabajos', (req, res) => res.sendFile(path.join(__dirname, 'public', 'trabajos.html')));

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/status', (req, res) => {
  res.json({
    botReady,
    responseCount,
    qr: lastQR,
    qrText: lastQRText,
    uptime: process.uptime(),
    log: lastMessageLog,
  });
});

app.get('/api/horarios', (req, res) => {
  res.json(loadJSON(HORARIOS_FILE));
});

app.post('/api/horarios', (req, res) => {
  const { fecha, horas } = req.body;
  if (!fecha || !horas || !Array.isArray(horas) || horas.length === 0) {
    return res.status(400).json({ error: 'Falta fecha u horas' });
  }
  const horarios = loadJSON(HORARIOS_FILE);
  if (horarios[fecha]) {
    const existing = new Set(horarios[fecha]);
    horas.forEach(h => { if (!existing.has(h)) horarios[fecha].push(h); });
    horarios[fecha].sort();
  } else {
    horarios[fecha] = [...horas].sort();
  }
  saveJSON(HORARIOS_FILE, horarios);
  res.json({ success: true, horarios });
});

app.delete('/api/horarios/:fecha/:hora', (req, res) => {
  const { fecha, hora } = req.params;
  const ok = removeTime(fecha, hora);
  if (!ok) return res.status(404).json({ error: 'No encontrado' });
  res.json({ success: true, horarios: loadJSON(HORARIOS_FILE) });
});

app.delete('/api/horarios/:fecha', (req, res) => {
  const { fecha } = req.params;
  const horarios = loadJSON(HORARIOS_FILE);
  if (!horarios[fecha]) return res.status(404).json({ error: 'Fecha no encontrada' });
  delete horarios[fecha];
  saveJSON(HORARIOS_FILE, horarios);
  res.json({ success: true, horarios });
});

app.get('/api/turnos', (req, res) => {
  const { fecha } = req.query;
  let turnos = loadJSON(TURNOS_FILE);
  if (fecha) turnos = turnos.filter(t => t.fecha === fecha);
  res.json(turnos);
});

app.delete('/api/turnos/:index', (req, res) => {
  const idx = parseInt(req.params.index);
  const turnos = loadJSON(TURNOS_FILE);
  if (isNaN(idx) || idx < 0 || idx >= turnos.length) {
    return res.status(404).json({ error: 'Turno no encontrado' });
  }
  const turno = turnos.splice(idx, 1)[0];
  saveJSON(TURNOS_FILE, turnos);

  const horarios = loadJSON(HORARIOS_FILE);
  if (!horarios[turno.fecha]) horarios[turno.fecha] = [];
  if (!horarios[turno.fecha].includes(turno.hora)) {
    horarios[turno.fecha].push(turno.hora);
    horarios[turno.fecha].sort();
  }
  saveJSON(HORARIOS_FILE, horarios);

  res.json({ success: true, turnos });
});

app.get('/api/trabajos', (req, res) => {
  res.json(loadJSON(TRABAJOS_FILE));
});

app.delete('/api/trabajos/:id', (req, res) => {
  const id = parseInt(req.params.id);
  let trabajos = loadJSON(TRABAJOS_FILE);
  const idx = trabajos.findIndex(t => t.id === id);
  if (idx === -1) return res.status(404).json({ error: 'No encontrado' });
  const t = trabajos.splice(idx, 1)[0];
  saveJSON(TRABAJOS_FILE, trabajos);
  if (t.fecha && t.hora) {
    const horarios = loadJSON(HORARIOS_FILE);
    if (!horarios[t.fecha]) horarios[t.fecha] = [];
    if (!horarios[t.fecha].includes(t.hora)) {
      horarios[t.fecha].push(t.hora);
      horarios[t.fecha].sort();
    }
    saveJSON(HORARIOS_FILE, horarios);
  }
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

app.get('/api/config', (req, res) => {
  const cfg = getConfig();
  res.json({
    aiModel: cfg.aiModel || 'gemini-2.5-flash',
    systemPrompt: cfg.systemPrompt || '',
    businessType: cfg.businessType || 'turnos',
    businessName: cfg.businessName || '',
    bookingTriggers: cfg.bookingTriggers || [],
    workTriggers: cfg.workTriggers || [],
    consultTriggers: cfg.consultTriggers || [],
    workFields: cfg.workFields || [],
    responses: cfg.responses || [],
    hasApiKey: !!(cfg.geminiApiKey),
  });
});

app.post('/api/config', (req, res) => {
  try {
    const cfg = getConfig();
    const body = req.body;
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/reconnect', async (req, res) => {
  try {
    await reconnectWhatsApp();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function startServer(port, attempt) {
  const s = app.listen(port);
  const maxAttempts = 5;
  s.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      console.error(`⚠️ Puerto ${port} en uso (intento ${attempt}/${maxAttempts}). Liberando...`);
      try {
        require('child_process').execSync(`fuser -k ${port}/tcp 2>/dev/null`, { timeout: 3000 });
      } catch {}
      if (attempt < maxAttempts) {
        setTimeout(() => startServer(port, attempt + 1), 1500);
      } else {
        console.error('❌ No se pudo liberar el puerto tras varios intentos. Cerrando.');
        process.exit(1);
      }
    } else {
      console.error('❌ Error del servidor:', err.message);
      process.exit(1);
    }
  });
  s.on('listening', () => {
    console.log(`🌐 Web UI: http://localhost:${port}`);
  });
}

const PORT = process.env.PORT || 3000;
startServer(PORT, 1);
