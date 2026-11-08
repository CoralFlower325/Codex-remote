import crypto from 'node:crypto';
import { trustedReleaseKeys } from './release-keys.mjs';

export function signingBytes(value) {
  const canonical = (entry) => {
    if (entry === null || typeof entry !== 'object') return JSON.stringify(entry);
    if (Array.isArray(entry)) return `[${entry.map(canonical).join(',')}]`;
    return `{${Object.keys(entry).filter(key => entry[key] !== undefined).sort()
      .map(key => `${JSON.stringify(key)}:${canonical(entry[key])}`).join(',')}}`;
  };
  const { signature: _signature, ...payload } = value;
  return Buffer.from(`codex-remote-release-v1\n${canonical(payload)}`);
}

export function signRelease(value, privateKey) {
  const key = crypto.createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('发布签名必须使用 Ed25519 密钥。');
  const publicKey = crypto.createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString();
  const keyId = crypto.createHash('sha256').update(publicKey).digest('hex');
  return { ...value, signature: { algorithm: 'ed25519', keyId,
    value: crypto.sign(null, signingBytes(value), key).toString('base64') } };
}

export function verifyRelease(value, keys = trustedReleaseKeys) {
  const signature = value?.signature;
  const publicKey = signature && keys[signature.keyId];
  if (!publicKey || signature.algorithm !== 'ed25519' || typeof signature.value !== 'string' ||
      !/^[A-Za-z0-9+/]{86}==$/.test(signature.value) ||
      !crypto.verify(null, signingBytes(value), publicKey, Buffer.from(signature.value, 'base64'))) {
    throw new Error('发布者签名缺失或不可信，已阻止更新。请等待正式签名版本；不会降级到未签名源码。');
  }
  return value;
}
