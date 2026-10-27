import { buildApp } from './app';
import { loadConfig } from './config';
import { migrateUp } from '@blissnova/database';

const config = loadConfig();
const app = await buildApp({ config });

if (process.env.MIGRATE_ON_START === 'true') {
  await migrateUp(app.ctx.db, (m) => app.log.info(m));
}

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down gracefully');
  const timer = setTimeout(() => {
    app.log.error('forced shutdown after timeout');
    process.exit(1);
  }, 15_000);
  try {
    await app.close(); // stops accepting connections and waits for in-flight requests
    clearTimeout(timer);
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'error during shutdown');
    process.exit(1);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (err) => {
  app.log.error({ err }, 'unhandled rejection');
  app.reportError?.(err);
});

await app.listen({ host: config.HOST, port: config.PORT });
