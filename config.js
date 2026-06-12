const fs = require('fs');
const path = require('path');

function load() {
  const file = path.join(__dirname, 'config.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    const example = path.join(__dirname, 'config.example.json');
    try {
      const defaults = JSON.parse(fs.readFileSync(example, 'utf-8'));
      defaults.geminiApiKey = '';
      fs.writeFileSync(file, JSON.stringify(defaults, null, 2));
      console.log('📄 config.json creado desde config.example.json. Configurá tu API Key en el panel de Settings.');
      return defaults;
    } catch {
      const minimal = {
        geminiApiKey: '',
        aiModel: 'gemini-2.5-flash',
        systemPrompt: 'Eres un asistente personal útil. Respondé de forma clara, completa y en español.',
        businessType: 'turnos',
        businessName: 'Mi Negocio',
        bookingTriggers: ['turno', 'reservar', 'agendar', 'cita'],
        workTriggers: ['trabajo', 'presupuesto', 'cotizacion', 'encargo', 'pedido'],
        consultTriggers: [],
        workFields: [],
        responses: [],
        defaultReply: null,
      };
      fs.writeFileSync(file, JSON.stringify(minimal, null, 2));
      return minimal;
    }
  }
}

const cfg = load();
module.exports = cfg;
