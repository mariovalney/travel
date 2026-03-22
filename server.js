const path = require('path');
const express = require('express');

const app = express();
const root = __dirname;
const port = Number(process.env.PORT) || 3000;

app.disable('x-powered-by');
app.use(express.static(root, { index: 'index.html', extensions: ['html'] }));

app.get('*', (req, res) => {
  res.sendFile(path.join(root, 'index.html'));
});

app.listen(port, '0.0.0.0', () => {
  console.log(`http://0.0.0.0:${port}`);
});
