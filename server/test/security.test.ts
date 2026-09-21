import { describe, expect, it } from 'vitest';
import { DEV_JWT_SECRET, loadConfig } from '../src/config.js';
import { canonicalStringify, decryptString, encryptString, redactSecrets } from '../src/security.js';

const key = Buffer.from('ab'.repeat(32), 'hex');

describe('secret redaction', () => {
  it('redacts high-confidence secrets and leaves commit shas intact', () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    const input = {
      prompt: `token ghp_abcdefghijklmnopqrstuvwxyz0123456789 and ${sha}`,
      notes: 'aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      pem: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
      prose: 'api_key: must-be-present',
      assigned: 'api_key: abcdEFGHijkl1234567890abcd',
    };
    const { value, findings } = redactSecrets(input);
    const text = JSON.stringify(value);
    expect(text).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(text).toContain(sha);
    expect(text).not.toContain('wJalrXUtnFEMI');
    expect(text).not.toContain('BEGIN PRIVATE KEY');
    expect(text).toContain('api_key: must-be-present');
    expect(text).toContain('[REDACTED:assigned_secret]');
    expect(findings.map((finding) => finding.type)).toEqual(expect.arrayContaining([
      'github_token',
      'aws_secret_access_key',
      'private_key',
      'assigned_secret',
    ]));
  });
});

describe('encryption', () => {
  it('round-trips plaintext', () => {
    const encrypted = encryptString(key, 'prompt body');
    expect(encrypted.startsWith('enc:v1:')).toBe(true);
    expect(decryptString(key, encrypted)).toBe('prompt body');
  });
});

describe('canonical json', () => {
  it('is stable across key order', () => {
    expect(canonicalStringify({ b: 1, a: { d: true, c: 'x' } })).toBe(canonicalStringify({ a: { c: 'x', d: true }, b: 1 }));
  });
});

describe('config', () => {
  it('rejects development secrets in production', () => {
    expect(() => loadConfig({
      NODE_ENV: 'production',
      JWT_SECRET: DEV_JWT_SECRET,
      DATA_ENCRYPTION_KEY_HEX: 'cd'.repeat(32),
    })).toThrow(/JWT_SECRET/);
  });
});
