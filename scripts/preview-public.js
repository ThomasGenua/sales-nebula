// A local preview of the same static routing used in production. No database,
// email provider, or application API is started by this process.
const express = require('express');
const path = require('path');
const app = express();
app.use('/api', (req, res) => res.status(503).json({ error: 'API is not running in this local public-page preview.' }));
app.use(require('../src/middleware/publicSite')(path.resolve(__dirname, '../frontend/dist')));
const server = app.listen(Number(process.env.PUBLIC_PREVIEW_PORT || 7548), '127.0.0.1', () => console.log('Public-page preview ready'));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
