import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { loadEnvFiles } from './env.js';
import { connectDynamo } from './repos/dynamo.js';
import { seedDemo } from './seed.js';

loadEnvFiles();
const config = loadConfig(process.env);
const dynamo = connectDynamo(config);

await dynamo.migrate();
await seedDemo(config, dynamo.repos);

const app = await buildApp(config, dynamo.repos);
await app.listen({ host: config.host, port: config.port });

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
