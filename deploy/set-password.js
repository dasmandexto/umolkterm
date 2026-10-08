#!/usr/bin/env node
// Змінити пароль входу UmolkTerm, не чіпаючи 2FA:
//   node deploy/set-password.js 'новий_пароль'
// Формат такий самий, як у server.js (scrypt, 64 байти, сіль 16 байт hex).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const pw = process.argv[2];
if (!pw) {
  console.error('Використання: node deploy/set-password.js <пароль>');
  process.exit(1);
}
const dataDir = path.join(__dirname, '..', 'data');
const authFile = path.join(dataDir, 'auth.json');
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

let existing = {};
try { existing = JSON.parse(fs.readFileSync(authFile, 'utf8')); } catch (e) {}
const salt = crypto.randomBytes(16).toString('hex');
const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
fs.writeFileSync(authFile, JSON.stringify({ ...existing, salt, hash }), { mode: 0o600 });
fs.chmodSync(authFile, 0o600);
console.log('Пароль оновлено' + (existing.totpEnabled ? ' (2FA залишається увімкненою)' : ''));
