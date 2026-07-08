import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';

const prompts = createInterface({
  input: process.stdin,
  output: process.stdout
});

const ask = async (question: string): Promise<string> => prompts.question(question);

const apiId = Number(await ask('API_ID: '));
const apiHash = await ask('API_HASH: ');
const stringSession = new StringSession('');

const client = new TelegramClient(stringSession, apiId, apiHash, {
  connectionRetries: 5
});

try {
  await client.start({
    phoneNumber: async () => ask('Phone number with country code: '),
    password: async () => ask('2FA password, if enabled: '),
    phoneCode: async () => ask('Telegram login code: '),
    onError: (error: unknown) => {
      console.error(error);
    }
  });

  console.log('\nSESSION_STRING:\n');
  console.log(client.session.save());

  await client.disconnect();
} finally {
  prompts.close();
}
