// Builds a safe Content-Disposition header value for a download.
//   attachment; filename="<ASCII fallback>"; filename*=UTF-8''<percent-encoded UTF-8 name>
// Quotes, backslashes, CR/LF, control characters, `%` and anything outside printable
// ASCII are replaced in the fallback, so a stored file name can never break out of the
// header (header injection) or make Node throw on a non-latin1 character.
export function contentDisposition(fileName: string): string {
  const name = String(fileName ?? '').replace(/[\r\n]+/g, ' ').trim() || 'arquivo';
  const ascii =
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '') // accents -> base letter
      .replace(/[^\x20-\x7e]/g, '_') // anything else non-ASCII / control
      .replace(/["\\%;]/g, '_') // quote, backslash, percent, separator
      .trim() || 'arquivo';
  // encodeURIComponent leaves ' ( ) * unescaped; RFC 5987 wants them escaped.
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
