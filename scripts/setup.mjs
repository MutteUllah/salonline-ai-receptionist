import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
if (existsSync('.env')) {
  console.log('.env already exists. Existing configuration was preserved.');
} else {
  const password = randomBytes(18).toString('base64url');
  const secret = randomBytes(36).toString('base64url');
  const template = readFileSync('.env.example', 'utf8')
    .replace(/^ADMIN_PASSWORD=$/m, `ADMIN_PASSWORD=${password}`)
    .replace(/^SESSION_SECRET=$/m, `SESSION_SECRET=${secret}`);
  writeFileSync('.env', template, {mode: 0o600, flag: 'wx'});
  console.log('Created .env with a unique owner password and signing secret. Read ADMIN_PASSWORD in .env to sign in.');
}
mkdirSync('data', {recursive: true});
console.log('Next: npm start, then open http://localhost:3000');
