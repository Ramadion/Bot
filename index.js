const { createBot } = require('./bot');
const PORT = process.env.PORT || 3000;
createBot(PORT).then(() => console.log(`✅ Servidor iniciado en puerto ${PORT}`));
