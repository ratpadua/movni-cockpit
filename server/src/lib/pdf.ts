import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Converting Word documents to PDF with fidelity requires LibreOffice. We invoke
// it headless and convert in an OS temp directory (NEVER the project folder),
// then delete everything — the PDF only lives in memory on the way to the client.

function sofficeBinary(): string {
  if (process.env.LIBREOFFICE_PATH) return process.env.LIBREOFFICE_PATH;
  const candidates =
    process.platform === 'win32'
      ? [
          'C:/Program Files/LibreOffice/program/soffice.exe',
          'C:/Program Files (x86)/LibreOffice/program/soffice.exe',
        ]
      : ['/usr/bin/soffice', '/usr/bin/libreoffice', '/opt/libreoffice/program/soffice'];
  for (const c of candidates) if (existsSync(c)) return c;
  // Fall back to PATH lookup.
  return process.platform === 'win32' ? 'soffice.exe' : 'soffice';
}

function runSoffice(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('error', (e: any) =>
      reject(
        new Error(
          e?.code === 'ENOENT'
            ? 'LibreOffice não encontrado. Instale o LibreOffice (ou defina LIBREOFFICE_PATH) para exportar em PDF.'
            : `Falha ao iniciar o LibreOffice: ${e?.message ?? e}`
        )
      )
    );
    p.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`Falha ao converter o documento (código ${code}). ${err}`.trim()))
    );
  });
}

// Convert a document buffer with LibreOffice in an isolated temp dir. `target` is
// the soffice --convert-to filter (e.g. 'pdf') and `outExt` the resulting file
// extension. Nothing is written to the project.
async function convertWithSoffice(input: Buffer, inExt: string, target: string, outExt: string): Promise<Buffer> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'movni-conv-'));
  const inPath = path.join(tmp, `doc.${inExt}`);
  const outPath = path.join(tmp, `doc.${outExt}`);
  const profile = path.join(tmp, 'lo-profile'); // isolated profile avoids clashing with a running LibreOffice
  try {
    await fs.writeFile(inPath, input);
    await runSoffice(sofficeBinary(), [
      '--headless',
      `-env:UserInstallation=${pathToFileURL(profile).href}`,
      '--convert-to',
      target,
      '--outdir',
      tmp,
      inPath,
    ]);
    if (!existsSync(outPath)) throw new Error('A conversão não gerou o arquivo esperado.');
    return await fs.readFile(outPath);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

// Convert a generated document to a .pdf buffer. An .odt is LibreOffice's native
// format, so it converts without the lossy Word -> LibreOffice translation
// (e.g. background images) that a .docx goes through.
export function officeToPdf(doc: Buffer, ext: 'docx' | 'odt'): Promise<Buffer> {
  return convertWithSoffice(doc, ext, 'pdf', 'pdf');
}
