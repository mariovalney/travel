const path = require('path');
const express = require('express');

const app = express();
const root = __dirname;
const port = Number(process.env.PORT) || 3000;

app.disable('x-powered-by');

// sw.js e index.html nunca devem ser cacheados pelo browser —
// assim o browser sempre verifica se há uma nova versão do SW
const NO_CACHE = 'no-cache, no-store, must-revalidate';

app.get('/sw.js', (req, res) => {
  res.setHeader('Cache-Control', NO_CACHE);
  res.sendFile(path.join(root, 'sw.js'));
});

app.get('/', (req, res) => {
  res.setHeader('Cache-Control', NO_CACHE);
  res.sendFile(path.join(root, 'index.html'));
});

// ícones e manifest podem ser cacheados por mais tempo
app.use(express.static(root, {
  index: 'index.html',
  extensions: ['html'],
  setHeaders(res, filePath) {
    if (filePath.endsWith('.png') || filePath.endsWith('manifest.json')) {
      res.setHeader('Cache-Control', 'public, max-age=604800'); // 7 dias
    }
  },
}));

app.get('*', (req, res) => {
  res.sendFile(path.join(root, 'index.html'));
});

app.listen(port, '0.0.0.0', () => {
  console.log(`http://0.0.0.0:${port}`);
});
