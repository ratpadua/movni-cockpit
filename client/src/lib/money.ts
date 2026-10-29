// Shared pt-BR props for money <NumberInput>s: comma decimal separator, dot thousands
// separator, 2 decimals. NumberInput's onChange still yields a number (or '' when empty),
// never a locale string, so what is sent to the server does not change.
export const MONEY_INPUT = {
  decimalSeparator: ',',
  thousandSeparator: '.',
  decimalScale: 2,
  // '.' is only a thousands separator: without this, typing '.' key by key is read as the decimal point.
  allowedDecimalSeparators: [','] as string[],
} as const;

// Same, with the "R$ " prefix (the usual money field).
export const MONEY_INPUT_BRL = { ...MONEY_INPUT, prefix: 'R$ ' } as const;
