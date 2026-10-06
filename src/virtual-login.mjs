/**
 * 虚拟登录（Track B）：在 Claude Science 的 data-dir 里写一份它认可格式的本地凭证，
 * 让它认为「已用 Claude 账号登录」，从而允许 agent 调用模型——而实际推理被
 * ANTHROPIC_BASE_URL 导到我们的本地代理，最终打到第三方上游。
 *
 * 逆向依据（claude-science 0.1.56，Windows，bun 单文件）：
 *   密钥来源   encryption.key 里的 OAUTH_ENCRYPTION_KEY（base64，≥16B）
 *   派生       HKDF-SHA256(ikm=base64Decode(OAUTH_ENCRYPTION_KEY), salt=空, info="operon:aes-256-gcm:oauth", 32)
 *   密文格式   "v2:" + base64( IV(12) ‖ AES-256-GCM(明文) ‖ authTag(16) )，AAD = "v2:oauth"
 *   存放位置   <dataDir>/.oauth-tokens/<user_id>.enc（UTF-8 文本，权限 0600）
 *   用户判定   目录里恰好一个 .enc，文件名（去掉 .enc）即 user_id；默认 user_id 为 "local-dev"
 *   令牌字段   access_token / refresh_token / token_expires_at / provider("claude_ai") / scopes /
 *              email / account_uuid / subscription_type / org_uuid
 *   登录判定   token_expires_at 未过期 + （若写了 active-org.json 则 org_uuid 必须与之一致）
 *
 * 安全铁律：
 *  - 只写 <dataDir>/.oauth-tokens/ 下的文件；绝不改 encryption.key、绝不碰其他目录。
 *  - 检测到「真实登录」（存在非本模块写入的 .enc）时拒绝覆盖，除非显式 --force。
 *  - 所有写入走 tmp + rename，权限 0600；写前拒符号链接。
 *  - 明文令牌只在内存中出现，绝不打印（只打印长度/字段名）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { log } from './log.mjs';
import { loadConfig } from './config.mjs';

const PROVIDER = 'claude_ai';
const PROVIDER_LABEL = 'oauth';
const KEY_NAME = 'OAUTH_ENCRYPTION_KEY';
const HKDF_INFO = `operon:aes-256-gcm:${PROVIDER_LABEL}`;
const AAD = Buffer.from(`v2:${PROVIDER_LABEL}`, 'utf-8');
const VERSION_PREFIX = 'v2:';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const VIRTUAL_MARKER = 'aiusage_virtual';
const DEFAULT_USER_ID = 'local-dev';
const CLAUDE_AI_SCOPES = 'user:inference user:file_upload user:profile user:mcp_servers user:plugins';
const FAR_FUTURE = '2099-01-01T00:00:00.000Z';

export class VirtualLoginError extends Error {}

// MARK: - 密钥

/** 解析 encryption.key（`KEY=value` 行），只取 OAUTH_ENCRYPTION_KEY。 */
export function readOAuthKey(dataDir) {
  const keyPath = path.join(dataDir, 'encryption.key');
  let raw;
  try {
    raw = fs.readFileSync(keyPath, 'utf-8');
  } catch (err) {
    throw new VirtualLoginError(`读不到 encryption.key（${keyPath}）：${err.message}`);
  }
  const values = {};
  for (const line of raw.split(/\r?\n/)) {
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (value) values[name] = value;
  }
  const key = values[KEY_NAME];
  if (!key) throw new VirtualLoginError(`encryption.key 里缺少 ${KEY_NAME}`);
  const decoded = Buffer.from(key, 'base64');
  if (decoded.length < 16) throw new VirtualLoginError(`${KEY_NAME} 不是有效的 base64（解码后 <16 字节）`);
  return { keyPath, keyB64: key, keyBytes: decoded };
}

/** HKDF-SHA256 派生 32 字节 AES 密钥。 */
export function deriveOAuthKey(keyBytes) {
  return Buffer.from(crypto.hkdfSync('sha256', keyBytes, Buffer.alloc(0), HKDF_INFO, 32));
}

// MARK: - v2 加解密（与 daemon 字节级对齐）

export function encryptTokenV2(plaintext, derivedKey) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', derivedKey, iv, { authTagLength: TAG_LENGTH });
  cipher.setAAD(AAD);
  const body = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return VERSION_PREFIX + Buffer.concat([iv, body, tag]).toString('base64');
}

export function decryptTokenV2(text, derivedKey) {
  if (!text.startsWith(VERSION_PREFIX)) throw new VirtualLoginError('不是 v2 格式密文');
  const raw = Buffer.from(text.slice(VERSION_PREFIX.length), 'base64');
  if (raw.length < IV_LENGTH + TAG_LENGTH) throw new VirtualLoginError('密文长度不足');
  const iv = raw.subarray(0, IV_LENGTH);
  const tag = raw.subarray(raw.length - TAG_LENGTH);
  const body = raw.subarray(IV_LENGTH, raw.length - TAG_LENGTH);
  const decipher = crypto.createDecipheriv('aes-256-gcm', derivedKey, iv, { authTagLength: TAG_LENGTH });
  decipher.setAAD(AAD);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf-8');
}

// MARK: - 令牌内容

export function buildVirtualToken({ email, accountUuid, orgUuid, subscriptionType = 'max' }) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(accountUuid)) {
    throw new VirtualLoginError(`account_uuid 必须是 UUID：${accountUuid}`);
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orgUuid)) {
    throw new VirtualLoginError(`org_uuid 必须是 UUID：${orgUuid}`);
  }
  if (!/\.invalid$/i.test(email)) {
    throw new VirtualLoginError(`email 必须以 .invalid 结尾（不可路由假账号）：${email}`);
  }
  return {
    access_token: 'sk-ant-virtual-aiusage-local',
    refresh_token: '',
    api_key: null,
    token_expires_at: FAR_FUTURE,
    refresh_token_expires_at: FAR_FUTURE,
    provider: PROVIDER,
    scopes: CLAUDE_AI_SCOPES,
    email,
    account_uuid: accountUuid,
    subscription_type: subscriptionType,
    rate_limit_tier: null,
    seat_tier: null,
    org_uuid: orgUuid,
    billing_type: null,
    has_extra_usage_enabled: false,
    [VIRTUAL_MARKER]: true,
    aiusage_created_at: new Date().toISOString(),
  };
}

// MARK: - 读取现状（只读，用于 status / 护栏）

function tokensDir(dataDir) {
  return path.join(dataDir, '.oauth-tokens');
}

function assertNotSymlink(target) {
  try {
    const st = fs.lstatSync(target);
    if (st.isSymbolicLink()) throw new VirtualLoginError(`拒绝操作符号链接：${target}`);
  } catch (err) {
    if (err instanceof VirtualLoginError) throw err;
    if (err.code !== 'ENOENT') throw err;
  }
}

/** 列出并（尽力）解密现有令牌，用于判断是否已有真实登录。 */
export function inspectVirtualLogin(dataDir) {
  const dir = tokensDir(dataDir);
  const result = { dataDir, tokensDir: dir, files: [], tokens: [], hasRealLogin: false, keyAvailable: false };
  let keyBytes = null;
  let derived = null;
  try {
    const { keyBytes: kb } = readOAuthKey(dataDir);
    keyBytes = kb;
    derived = deriveOAuthKey(kb);
    result.keyAvailable = true;
  } catch (err) {
    result.keyError = err.message;
  }

  let entries = [];
  try {
    entries = fs.readdirSync(dir).filter((n) => n.endsWith('.enc'));
  } catch {
    return result;
  }
  result.files = entries;
  for (const name of entries) {
    const entry = { file: name, userId: name.slice(0, -4) };
    if (derived) {
      try {
        const text = fs.readFileSync(path.join(dir, name), 'utf-8');
        const parsed = JSON.parse(decryptTokenV2(text, derived));
        entry.provider = parsed.provider ?? null;
        entry.email = parsed.email ?? null;
        entry.expiresAt = parsed.token_expires_at ?? null;
        entry.accountUuid = parsed.account_uuid ?? null;
        entry.orgUuid = parsed.org_uuid ?? null;
        entry.virtual = parsed[VIRTUAL_MARKER] === true;
        entry.accessTokenLength = typeof parsed.access_token === 'string' ? parsed.access_token.length : 0;
      } catch (err) {
        entry.decryptError = err.message;
      }
    }
    result.tokens.push(entry);
    if (!entry.virtual && !entry.decryptError) result.hasRealLogin = true;
  }
  return result;
}

// MARK: - 写入

function atomicWrite(target, contents) {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, contents, { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, target);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * 写入虚拟登录。默认不写 active-org.json（保持现有数据布局与历史会话不变）。
 * @returns {{file:string,userId:string,orgUuid:string,accountUuid:string,action:string}}
 */
export function writeVirtualLogin({
  dataDir,
  email = 'aiusage@cslocal.invalid',
  accountUuid = crypto.randomUUID(),
  orgUuid = crypto.randomUUID(),
  subscriptionType = 'max',
  userId = DEFAULT_USER_ID,
  force = false,
  dryRun = false,
} = {}) {
  if (!dataDir) throw new VirtualLoginError('缺少 dataDir');
  const { keyBytes } = readOAuthKey(dataDir);
  const derived = deriveOAuthKey(keyBytes);

  const dir = tokensDir(dataDir);
  assertNotSymlink(dir);
  const existing = inspectVirtualLogin(dataDir);
  // 护栏①：任何「不可判定」的凭证（解不开 / 非本工具写入）都不允许被覆盖。
  // 注意：只有解密成功且带标记的条目才算本工具的虚拟登录；解不开的一律按真实凭证对待。
  const suspicious = existing.tokens.filter((t) => !t.virtual);
  if (suspicious.length > 0 && !force) {
    const detail = suspicious
      .map((t) => `${t.file}${t.decryptError ? `(无法解密：${t.decryptError})` : ''}`)
      .join(', ');
    throw new VirtualLoginError(
      `检测到非本工具写入的登录凭证（${detail}）；为避免破坏真实凭证已拒绝写入。`
      + '确需覆盖请显式加 --force。',
    );
  }

  const token = buildVirtualToken({ email, accountUuid, orgUuid, subscriptionType });
  const ciphertext = encryptTokenV2(JSON.stringify(token), derived);
  const file = path.join(dir, `${userId}.enc`);

  if (dryRun) {
    return {
      dryRun: true,
      file,
      userId,
      orgUuid,
      accountUuid,
      action: existing.files.length === 0 ? 'create' : 'overwrite',
      ciphertextLength: ciphertext.length,
      replacedFiles: existing.files.filter((n) => n !== `${userId}.enc`),
    };
  }

  // 单账号：daemon 要求目录里恰好一个 .enc（否则读不到身份）。
  // 护栏②：先写入成功，再清理——且只清理「确认带虚拟标记」的文件，绝不删不可判定的。
  atomicWrite(file, ciphertext);

  const removed = [];
  for (const entry of existing.tokens) {
    if (entry.file === `${userId}.enc`) continue;
    if (!entry.virtual) {
      log.warn(`保留非虚拟凭证不删除：${entry.file}`);
      continue;
    }
    const victim = path.join(dir, entry.file);
    assertNotSymlink(victim);
    try {
      fs.unlinkSync(victim);
      removed.push(entry.file);
    } catch (err) {
      log.warn(`清理旧虚拟令牌失败：${entry.file} ${err.message}`);
    }
  }
  const action = existing.files.includes(`${userId}.enc`) ? 'overwrite' : 'create';
  log.info(`虚拟登录已写入：${file}（provider=${PROVIDER}, org=${orgUuid}, 标记=${VIRTUAL_MARKER}）`);
  return { file, userId, orgUuid, accountUuid, action, removedFiles: removed };
}

/** 移除本模块写入的虚拟令牌（只删带标记的，绝不误删真实登录）。 */
export function removeVirtualLogin({ dataDir, userId = DEFAULT_USER_ID } = {}) {
  const info = inspectVirtualLogin(dataDir);
  const target = info.tokens.find((t) => t.userId === userId);
  if (!target) return { removed: false, reason: '未找到虚拟令牌文件' };
  if (!target.virtual) {
    throw new VirtualLoginError(`拒绝删除：${target.file} 不是本工具写入的虚拟凭证（没有 ${VIRTUAL_MARKER} 标记）`);
  }
  const file = path.join(tokensDir(dataDir), target.file);
  assertNotSymlink(file);
  fs.unlinkSync(file);
  log.info(`已移除虚拟登录：${file}`);
  return { removed: true, file };
}

// MARK: - CLI

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0] ?? 'inspect';
  let configArg = null;
  let force = false;
  let dryRun = false;
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === '--config') configArg = argv[++i];
    else if (argv[i] === '--force') force = true;
    else if (argv[i] === '--dry-run') dryRun = true;
  }
  const cfg = loadConfig(configArg);
  const dataDir = cfg.science.dataDir;

  switch (command) {
    case 'inspect': {
      const info = inspectVirtualLogin(dataDir);
      console.log(JSON.stringify({
        dataDir: info.dataDir,
        keyAvailable: info.keyAvailable,
        keyError: info.keyError,
        files: info.files,
        hasRealLogin: info.hasRealLogin,
        tokens: info.tokens,
      }, null, 2));
      break;
    }
    case 'write': {
      const result = writeVirtualLogin({ dataDir, force, dryRun });
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case 'remove': {
      console.log(JSON.stringify(removeVirtualLogin({ dataDir }), null, 2));
      break;
    }
    default:
      console.error('用法：node src/virtual-login.mjs [inspect|write|remove] [--dry-run] [--force] [--config <path>]');
      process.exit(2);
  }
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`执行失败：${err.message}`);
    process.exit(1);
  });
}
