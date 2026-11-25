/**
 * Display-name validation + profanity filter (FR-4, D10). Pure and unit-tested.
 */

const MIN_LEN = 1;
const MAX_LEN = 24;

// Small illustrative blocklist. This is a user-experience filter, not a
// comprehensive moderation or security boundary.
const BLOCKLIST = ['badword', 'slur1', 'slur2'];

export type NameValidation =
  | { ok: true; name: string }
  | { ok: false; code: 'NAME_LENGTH' | 'NAME_PROFANITY'; message: string };

export function validateName(raw: string): NameValidation {
  const name = raw.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (name.length < MIN_LEN || name.length > MAX_LEN) {
    return {
      ok: false,
      code: 'NAME_LENGTH',
      message: `Name must be ${MIN_LEN}–${MAX_LEN} characters.`,
    };
  }
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (BLOCKLIST.some((w) => normalized.includes(w))) {
    return { ok: false, code: 'NAME_PROFANITY', message: 'Please choose a different name.' };
  }
  return { ok: true, name };
}
