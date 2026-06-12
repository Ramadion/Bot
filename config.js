const fs = require('fs');
const path = require('path');

function load() {
  try {
    const file = path.join(__dirname, 'config.json');
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return {};
  }
}

const cfg = load();
module.exports = cfg;
