const express = require('express');
const path = require('path');
const app = express();
app.use(express.json());

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/horarios', (req, res) => res.sendFile(path.join(__dirname, 'public', 'horarios.html')));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/status', (req, res) => res.json({ok:true}));

// Error handler
app.use((err, req, res, next) => {
  console.error('Express error:', err.message);
  res.status(500).send('Error: ' + err.message);
});

console.log('__dirname:', __dirname);
console.log('File exists:', require('fs').existsSync(path.join(__dirname, 'public', 'dashboard.html')));

app.listen(3461, () => {
  console.log('ready');
  const http = require('http');
  http.get('http://localhost:3461/', (res) => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => console.log('GET / =>', res.statusCode, d.slice(0,100)));
  });
  http.get('http://localhost:3461/horarios', (res) => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => console.log('GET /horarios =>', res.statusCode, d.slice(0,100)));
  });
});
