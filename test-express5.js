const express = require('express');
const path = require('path');
const app = express();
app.use(express.json());

app.get('/test', (req, res) => res.send('hello'));
app.get('/file', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

// Also test with the explicit router
app._router?.forEach?.(r => console.log('route:', r.path));

app.listen(3462, () => {
  console.log('ready');
  const http = require('http');
  http.get('http://localhost:3462/test', r => {
    let d = '';
    r.on('data', c => d+=c);
    r.on('end', () => console.log('/test =>', r.statusCode, d));
  });
  http.get('http://localhost:3462/file', r => {
    let d = '';
    r.on('data', c => d+=c);
    r.on('end', () => console.log('/file =>', r.statusCode, d.slice(0,60)));
  });
});
