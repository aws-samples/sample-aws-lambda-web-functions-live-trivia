import { describe, it, expect } from 'vitest';
import { validateName } from './names.ts';

describe('validateName', () => {
  it('accepts and normalizes whitespace', () => {
    const r = validateName('  Ada   Lovelace ');
    expect(r).toEqual({ ok: true, name: 'Ada Lovelace' });
  });

  it('normalizes compatibility-equivalent Unicode before returning a display name', () => {
    expect(validateName('Ａｄａ')).toEqual({ ok: true, name: 'Ada' });
  });

  it('rejects empty / whitespace-only names', () => {
    expect(validateName('   ')).toMatchObject({ ok: false, code: 'NAME_LENGTH' });
  });

  it('rejects overly long names', () => {
    expect(validateName('x'.repeat(25))).toMatchObject({ ok: false, code: 'NAME_LENGTH' });
  });

  it('rejects blocklisted words even with obfuscation', () => {
    expect(validateName('b a d w o r d')).toMatchObject({ ok: false, code: 'NAME_PROFANITY' });
    expect(validateName('BadWord!')).toMatchObject({ ok: false, code: 'NAME_PROFANITY' });
  });
});
