import type { ClipboardEvent } from 'react';

// A PASTED text that is unambiguously dot-decimal: optional '-', optional 'R$', digits, exactly one '.',
// then 1 or 2 digits (e.g. "1234.56", "12.5", "-50.25", "R$ 1234.56"). With exactly 3 digits after the dot
// ("1.234") or several dots it is a pt-BR thousands separator and is NOT matched. Any ',' also disqualifies it.
const DOT_DECIMAL = /^\s*(-)?\s*(?:R\$)?\s*(-)?\s*(\d+)\.(\d{1,2})\s*$/;

// Returns the pt-BR (comma decimal) text for a dot-decimal paste, or null when the text is anything else.
export function dotDecimalToPtBr(text: string): string | null {
  const m = DOT_DECIMAL.exec(text);
  if (!m || (m[1] && m[2])) return null; // "--5.5" is not a number
  return `${m[1] || m[2] ? '-' : ''}${m[3]},${m[4]}`;
}

// onPaste for the money inputs. The field reads '.' as a thousands separator (so a pasted "1234.56"
// would become 123456, a silent 100x error). For an unambiguous dot-decimal paste that REPLACES the whole
// content (empty field or everything selected) we cancel the paste and set the comma-decimal text through the
// native value setter + an 'input' event, which is what react-number-format / Mantine NumberInput listen to.
// Everything else (other text, partial selection / caret inside the text, read-only) keeps the default paste.
// Note: the converted paste resets the field's native Ctrl+Z history.
export function onMoneyPaste(e: ClipboardEvent<HTMLInputElement>) {
  const input = e.currentTarget;
  if (input.readOnly || input.disabled) return;
  const whole = input.value === '' || (input.selectionStart === 0 && input.selectionEnd === input.value.length);
  if (!whole) return;
  const normalized = dotDecimalToPtBr(e.clipboardData.getData('text'));
  if (normalized === null) return;
  e.preventDefault();
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, normalized);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

// Shared pt-BR props for money <NumberInput>s: comma decimal separator, dot thousands
// separator, 2 decimals. NumberInput's onChange still yields a number (or '' when empty),
// never a locale string, so what is sent to the server does not change.
export const MONEY_INPUT = {
  decimalSeparator: ',',
  thousandSeparator: '.',
  decimalScale: 2,
  // '.' is only a thousands separator: without this, typing '.' key by key is read as the decimal point.
  allowedDecimalSeparators: [','] as string[],
  // pasting an unambiguous dot-decimal ("1234.56") is read as a decimal, not as thousands.
  onPaste: onMoneyPaste,
} as const;

// Same, with the "R$ " prefix (the usual money field).
export const MONEY_INPUT_BRL = { ...MONEY_INPUT, prefix: 'R$ ' } as const;
