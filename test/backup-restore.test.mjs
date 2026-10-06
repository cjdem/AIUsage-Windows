/**
 * 备份 / 还原回归（非破坏性）：全部在临时目录里做，绝不碰真实 data-dir。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backupDataDir, restoreBackup } from '../src/science-control.mjs';
import { encryptTokenV2, buildVirtualToken, deriveOAuthKey } from '../src/virtual-login.mjs';

function makeDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sci-data-'));
  // 伪造一个 OpenAI 兼容的 encryption.key（4 个 base64 32B 密钥）
  const keys = [
    'ANTHROPIC_API_KEY_ENCRYPTION_KEY',
    'OAUTH_ENCRYPTION_KEY',
    'JWT_SIGNING_SECRET',
    'USER_SECRET_ENCRYPTION_KEY',
  ];
  fs.writeFileSync(path.join(dir, 'encryption.key'), keys.map((k) => `${k}=${'A'.repeat(43)}B`).join('\n'));
  fs.writeFileSync(path.join(dir, 'preferences.json'), '{"installDate":"2026-10-05"}');
  fs.mkdirSync(path.join(dir, '.oauth-tokens'), { recursive: true });
  const derived = deriveOAuthKey(Buffer.from(`${'A'.repeat(43)}B`, 'base64'));
  const token = buildVirtualToken({
    email: 'aiusage@cslocal.invalid',
    accountUuid: '11111111-2222-3333-4444-555555555555',
    orgUuid: '66666666-7777-8888-9999-aaaaaaaaaaaa',
  });
  fs.writeFileSync(path.join(dir, '.oauth-tokens', 'local-dev.enc'), encryptTokenV2(JSON.stringify(token), derived));
  return dir;
}

test('backupDataDir 复制凭据/状态文件并写 manifest', () => {
  const dataDir = makeDataDir();
  const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sci-backup-'));
  const cfg = { science: { dataDir } };

  const result = backupDataDir(cfg, backupRoot);
  assert.ok(result.copied.includes('encryption.key'));
  assert.ok(result.copied.includes('.oauth-tokens'));
  assert.ok(result.copied.includes('preferences.json'));
  assert.ok(result.missing.includes('active-org.json'), '不存在的项应记入 missing');

  const manifest = JSON.parse(fs.readFileSync(path.join(result.dest, 'backup-manifest.json'), 'utf8'));
  assert.equal(manifest.dataDir, dataDir);
  assert.deepEqual(manifest.copied, result.copied);
  // 原始文件未被移动/删除
  assert.ok(fs.existsSync(path.join(dataDir, 'encryption.key')));
  assert.ok(fs.existsSync(path.join(dataDir, '.oauth-tokens', 'local-dev.enc')));
});

test('restoreBackup 能把改动恢复原状', () => {
  const dataDir = makeDataDir();
  const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sci-backup-'));
  const cfg = { science: { dataDir } };

  const originalKey = fs.readFileSync(path.join(dataDir, 'encryption.key'), 'utf8');
  const originalToken = fs.readFileSync(path.join(dataDir, '.oauth-tokens', 'local-dev.enc'), 'utf8');
  const { dest } = backupDataDir(cfg, backupRoot);

  // 破坏现状：改密钥、删令牌、加噪声文件
  fs.writeFileSync(path.join(dataDir, 'encryption.key'), 'BROKEN=1\n');
  fs.rmSync(path.join(dataDir, '.oauth-tokens'), { recursive: true, force: true });

  const restored = restoreBackup(dest, cfg);
  assert.ok(restored.includes('encryption.key'));
  assert.ok(restored.includes('.oauth-tokens'));
  assert.equal(fs.readFileSync(path.join(dataDir, 'encryption.key'), 'utf8'), originalKey);
  assert.equal(fs.readFileSync(path.join(dataDir, '.oauth-tokens', 'local-dev.enc'), 'utf8'), originalToken);
});

test('restoreBackup 对不存在的备份目录报错', () => {
  const cfg = { science: { dataDir: makeDataDir() } };
  assert.throws(() => restoreBackup(path.join(os.tmpdir(), 'no-such-backup-dir-xyz'), cfg), /备份目录不存在/);
});