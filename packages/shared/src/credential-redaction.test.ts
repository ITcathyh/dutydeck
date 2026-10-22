import { describe, expect, it } from 'vitest';
import { redactCredentialText } from './credential-redaction.js';

describe('credential text redaction', () => {
  it.each(['alpha" tail_secret_value', 'alpha"tail_secret_value', 'alpha\\" tail_secret_value', 'alpha\\'])('consumes a complete JSON credential value: %s', password => {
    const input = JSON.stringify({ password, status: 'kept' });
    expect(JSON.parse(input).password).toBe(password);
    const redacted = redactCredentialText(input);
    expect(redacted).not.toContain('alpha');
    expect(redacted).not.toContain('tail_secret_value');
    expect(redacted).toContain('"status":"kept"');
    expect(redacted).toContain('[REDACTED]');
    expect(redactCredentialText(redacted)).toBe(redacted);
  });

  it('keeps nested JSON commands and custom placeholders working without hiding subsequent commands', () => {
    const input = JSON.stringify({ command: 'export SECRET_KEY="opaque credential with spaces"; echo done', status: 'kept' });
    const redacted = redactCredentialText(input, '<hidden $&>');
    expect(redacted).not.toContain('credential with spaces');
    expect(redacted).toContain('<hidden $&>');
    expect(redacted).toContain('; echo done');
    expect(redacted).toContain('"status":"kept"');
    expect(redactCredentialText('pnpm test; echo "ordinary text"')).toBe('pnpm test; echo "ordinary text"');
  });
});
