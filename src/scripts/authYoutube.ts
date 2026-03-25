// ============================================================
// SCRIPT: scripts/authYoutube.ts
// PURPOSE: One-time OAuth flow to get YouTube refresh token
// USAGE: npx ts-node src/scripts/authYoutube.ts
// ============================================================

import 'dotenv/config';
import * as readline from 'readline';
import { google } from 'googleapis';

const clientId     = process.env.YOUTUBE_CLIENT_ID ?? '';
const clientSecret = process.env.YOUTUBE_CLIENT_SECRET ?? '';

if (!clientId || !clientSecret) {
  console.error('Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET in .env first');
  process.exit(1);
}

const auth = new google.auth.OAuth2(clientId, clientSecret, 'urn:ietf:wg:oauth:2.0:oob');

const url = auth.generateAuthUrl({
  access_type: 'offline',
  scope: ['https://www.googleapis.com/auth/youtube.upload'],
});

console.log('\n─────────────────────────────────────────────────');
console.log('Open this URL in your browser and sign in:');
console.log('\n' + url + '\n');
console.log('─────────────────────────────────────────────────\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('Paste the code from the browser here: ', async (code) => {
  rl.close();
  const { tokens } = await auth.getToken(code.trim());
  console.log('\n✓ Got tokens. Add this to your .env:\n');
  console.log(`YOUTUBE_REFRESH_TOKEN=${tokens.refresh_token}`);
  console.log('\nThen run npm start to publish videos automatically.\n');
});
