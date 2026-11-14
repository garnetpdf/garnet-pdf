/** Search patterns for Find & redact. Pure functions, shared by the engine and tests. */
export type PresetId = 'email' | 'phone' | 'date' | 'ukNi' | 'iban' | 'card';
export type FindSpec =
  | { kind: 'literal'; query: string; caseSensitive?: boolean; wholeWord?: boolean }
  | { kind: 'regex'; pattern: string; caseSensitive?: boolean }
  | { kind: 'presets'; presets: PresetId[] };
export interface LineMatch {
  start: number;
  end: number;
  label: string;
}

export const PRESETS: Record<PresetId, { label: string; example: string }> = {
  email: { label: 'Email addresses', example: 'name@example.com' },
  phone: { label: 'Phone numbers (UK and international)', example: '+44 20 7946 0958' },
  date: { label: 'Dates', example: '24/03/2025, 24 March 2025' },
  ukNi: { label: 'UK National Insurance numbers', example: 'AB 12 34 56 C' },
  iban: { label: 'IBAN bank account numbers', example: 'GB82 WEST 1234 5698 7654 32' },
  card: { label: 'Payment card numbers', example: '4111 1111 1111 1111' },
};

const WORD = '[\\p{L}\\p{N}_]';
const MONTHS = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';

export function luhnValid(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

export function ibanValid(value: string): boolean {
  const iban = value.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const character of rearranged) {
    const code = character.charCodeAt(0);
    const digits = code >= 65 ? String(code - 55) : character;
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

function validDayMonth(day: number, month: number) {
  return day >= 1 && day <= 31 && month >= 1 && month <= 12;
}

interface PresetRule { regex: RegExp; valid?: (match: string, groups: RegExpExecArray) => boolean }
const RULES: Record<PresetId, PresetRule[]> = {
  email: [{ regex: /(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}(?![\p{L}\p{N}])/gu }],
  phone: [{
    regex: /(?<![\p{L}\p{N}+])(?:\+|\(|0)[\d\s().-]{6,22}\d(?![\p{L}\p{N}])/gu,
    valid: match => {
      const digits = match.replace(/\D/g, '');
      if (/[.]{2}|[-]{2}/.test(match)) return false;
      if ((match.match(/\(/g) || []).length !== (match.match(/\)/g) || []).length) return false;
      if (/^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/.test(match.trim())) return false;
      return match.startsWith('+') ? digits.length >= 8 && digits.length <= 15 : digits.length >= 10 && digits.length <= 15;
    },
  }],
  date: [
    {
      regex: /(?<![\p{L}\p{N}])(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})(?![\p{L}\p{N}])/gu,
      valid: (_m, g) => validDayMonth(Number(g[1]), Number(g[2])) || validDayMonth(Number(g[2]), Number(g[1])),
    },
    {
      regex: /(?<![\p{L}\p{N}])(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})(?![\p{L}\p{N}])/gu,
      valid: (_m, g) => validDayMonth(Number(g[3]), Number(g[2])),
    },
    { regex: new RegExp(`(?<!${WORD})(?:[0-3]?\\d)(?:st|nd|rd|th)?\\s+(?:${MONTHS})\\.?,?\\s+\\d{4}(?!${WORD})`, 'giu') },
    { regex: new RegExp(`(?<!${WORD})(?:${MONTHS})\\.?\\s+[0-3]?\\d(?:st|nd|rd|th)?,?\\s+\\d{4}(?!${WORD})`, 'giu') },
  ],
  ukNi: [{ regex: /(?<![\p{L}\p{N}])(?!BG|GB|NK|KN|TN|NT|ZZ)[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z] ?\d{2} ?\d{2} ?\d{2} ?[A-D](?![\p{L}\p{N}])/gu }],
  iban: [{ regex: /(?<![\p{L}\p{N}])[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}(?![\p{L}\p{N}])/gu, valid: match => ibanValid(match) }],
  card: [{ regex: /(?<![\p{L}\p{N}])\d(?:[ -]?\d){12,18}(?![\p{L}\p{N}])/gu, valid: match => luhnValid(match.replace(/\D/g, '')) }],
};

function escape(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class FindSpecError extends Error {}

export function compileSpec(spec: FindSpec): { regex: RegExp; label: string; valid?: PresetRule['valid'] }[] {
  if (spec.kind === 'literal') {
    const query = spec.query;
    if (!query.trim()) throw new FindSpecError('Enter text to find.');
    const body = escape(query);
    const pattern = spec.wholeWord ? `(?<!${WORD})${body}(?!${WORD})` : body;
    return [{ regex: new RegExp(pattern, spec.caseSensitive ? 'gu' : 'giu'), label: query }];
  }
  if (spec.kind === 'regex') {
    if (!spec.pattern) throw new FindSpecError('Enter a pattern.');
    let regex: RegExp;
    const flags = spec.caseSensitive ? 'g' : 'gi';
    try { regex = new RegExp(spec.pattern, `${flags}u`); }
    catch {
      try { regex = new RegExp(spec.pattern, flags); }
      catch (error) { throw new FindSpecError(`The pattern is not valid: ${error instanceof Error ? error.message : String(error)}`); }
    }
    return [{ regex, label: 'Pattern' }];
  }
  if (!spec.presets.length) throw new FindSpecError('Choose at least one kind of information.');
  return spec.presets.flatMap(id => RULES[id].map(rule => ({ regex: new RegExp(rule.regex.source, rule.regex.flags), label: PRESETS[id].label, valid: rule.valid })));
}

/** Finds non-overlapping matches in one line of text. Overlaps keep the earliest, then longest match. */
export function matchLine(text: string, compiled: ReturnType<typeof compileSpec>, limit = 2000): LineMatch[] {
  const found: LineMatch[] = [];
  for (const { regex, label, valid } of compiled) {
    regex.lastIndex = 0;
    let guard = 0;
    for (let match = regex.exec(text); match; match = regex.exec(text)) {
      if (++guard > limit) break;
      if (match[0].length === 0) { regex.lastIndex++; continue; }
      let value = match[0];
      let start = match.index;
      const trimmed = value.replace(/^\s+/, '');
      start += value.length - trimmed.length;
      value = trimmed.replace(/\s+$/, '');
      if (!value) continue;
      if (valid && !valid(value, match)) continue;
      found.push({ start, end: start + value.length, label });
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const result: LineMatch[] = [];
  for (const item of found) {
    const last = result.at(-1);
    if (last && item.start < last.end) continue;
    result.push(item);
  }
  return result;
}
