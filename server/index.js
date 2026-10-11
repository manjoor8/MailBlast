import { app } from './routes.js';
import { DATA_DIR } from './db.js';
import { describeTransport, isTransportConfigured } from './mailer.js';

const PORT = Number(process.env.PORT) || 3210;
const HOST = process.env.HOST || '127.0.0.1';

const server = app.listen(PORT, HOST, () => {
  const url = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;
  const transport = describeTransport();

  console.log('');
  console.log('  MailBlast is running');
  console.log(`  →  ${url}`);
  console.log(`  data:    ${DATA_DIR}`);
  console.log(`  sending: ${transport.label}`);
  if (!isTransportConfigured()) {
    console.log('  note:    open Settings to add SMTP, or switch on capture mode to test safely.');
  }
  console.log('');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Start with a different one, e.g.  PORT=3300 npm start`);
    process.exit(1);
  }
  throw err;
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\nReceived ${signal}, shutting down.`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
