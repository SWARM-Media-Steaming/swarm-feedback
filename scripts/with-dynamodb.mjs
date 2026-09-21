import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dynamoDir = path.join(root, '.dynamodb');
const port = Number(process.env.DYNAMODB_PORT ?? 8000);
const command = process.argv.slice(2);
if (command.length === 0) {
  console.error('Usage: node scripts/with-dynamodb.mjs <command> [args...]');
  process.exit(1);
}

const alreadyUp = await portOpen(port);
let child = null;
if (!alreadyUp) {
  if (!existsSync(path.join(dynamoDir, 'DynamoDBLocal.jar'))) {
    console.error('DynamoDB Local jar is missing. Run scripts/download-dynamodb.sh or start docker compose.');
    process.exit(1);
  }
  child = spawn('java', [
    '-Djava.library.path=./DynamoDBLocal_lib',
    '-jar',
    'DynamoDBLocal.jar',
    '-sharedDb',
    '-inMemory',
    '-port',
    String(port),
  ], { cwd: dynamoDir, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  const started = await waitForPort(port, 40);
  if (!started) {
    console.error('DynamoDB Local did not start');
    child.kill('SIGTERM');
    process.exit(1);
  }
}

const childEnv = { ...process.env, DYNAMODB_ENDPOINT: process.env.DYNAMODB_ENDPOINT ?? `http://127.0.0.1:${port}` };
const runner = spawn(command[0], command.slice(1), { cwd: root, stdio: 'inherit', env: childEnv, shell: false });
const code = await new Promise((resolve) => runner.on('exit', (exitCode) => resolve(exitCode ?? 1)));
if (child) child.kill('SIGTERM');
process.exit(code);

function portOpen(targetPort) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port: targetPort });
    const done = (open) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function waitForPort(targetPort, attempts) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await portOpen(targetPort)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}
