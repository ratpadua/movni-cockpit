import { notifications } from '@mantine/notifications';

// Prefer the server-provided filename (Content-Disposition) over a fallback.
export function filenameFromDisposition(cd: string | null, fallback: string): string {
  if (!cd) return fallback;
  // RFC 5987 form first (full UTF-8 name), then the plain ASCII fallback.
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      /* fall through to the plain filename */
    }
  }
  const m = /filename="?([^";]+)"?/i.exec(cd);
  return m ? m[1] : fallback;
}

// Fetch a file (docx/pdf) and trigger a browser download; show a notification on
// failure instead of navigating away from the SPA. PDF generation runs through
// LibreOffice on the server and can take a few seconds, so a loading
// notification is shown while a PDF is being generated.
export async function downloadFile(url: string, fallbackName: string, init?: RequestInit): Promise<boolean> {
  const isPdf = /pdf/i.test(url);
  const nid = isPdf ? `pdf-${Date.now()}-${Math.random().toString(36).slice(2)}` : null;
  if (nid) {
    notifications.show({
      id: nid,
      loading: true,
      title: 'Gerando PDF',
      message: 'Convertendo o documento, aguarde…',
      autoClose: false,
      withCloseButton: false,
    });
  }
  try {
    const res = await fetch(url, init);
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      const msg = e.error ?? 'Falha ao baixar o arquivo';
      if (nid) notifications.update({ id: nid, loading: false, color: 'red', title: 'Falha', message: msg, autoClose: 4000, withCloseButton: true });
      else notifications.show({ message: msg, color: 'red' });
      return false;
    }
    const name = filenameFromDisposition(res.headers.get('Content-Disposition'), fallbackName);
    const blob = await res.blob();
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href;
    a.download = name;
    a.click();
    URL.revokeObjectURL(href);
    if (nid) notifications.hide(nid);
    return true;
  } catch {
    const msg = isPdf ? 'Erro ao gerar o PDF' : 'Erro ao baixar o arquivo';
    if (nid) notifications.update({ id: nid, loading: false, color: 'red', title: 'Falha', message: msg, autoClose: 4000, withCloseButton: true });
    else notifications.show({ message: msg, color: 'red' });
    return false;
  }
}

// Generate + download a receipt (POST marks it 'sent' server-side). `format` is
// 'docx' (default) or 'pdf' (converted on the fly, not stored).
export async function generateReceipt(id: number, format: 'docx' | 'pdf' = 'docx'): Promise<boolean> {
  const q = format === 'pdf' ? '?format=pdf' : '';
  return downloadFile(`/api/payments/${id}/receipt${q}`, `recibo_${id}.${format}`, { method: 'POST' });
}
