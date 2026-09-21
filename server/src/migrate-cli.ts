import { loadConfig } from './config.js';
import { loadEnvFiles } from './env.js';
import { connectDynamo } from './repos/dynamo.js';

loadEnvFiles();
const config = loadConfig(process.env);
const dynamo = connectDynamo(config);
await dynamo.migrate();
console.log(`DynamoDB tables are ready with prefix ${config.dynamodb.tablePrefix}`);
