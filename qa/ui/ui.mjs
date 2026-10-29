import * as L from './lib.mjs';

export const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });
export const isSorted = (arr) => arr.every((v, i) => i === 0 || collator.compare(arr[i - 1], v) <= 0);

// the top-most MODAL (Mantine popovers/dropdowns also carry role=dialog, so do not use getByRole('dialog'))
export const dlg = (page) => page.locator('.mantine-Modal-content').last();

export async function go(page, p, readyText) {
  await page.goto(L.BASE + p);
  if (readyText) await page.getByRole('heading', { name: readyText }).first().waitFor({ timeout: 15000 });
  await page.waitForLoadState('networkidle');
}

// Open a Mantine Select/MultiSelect by label and return its option texts
export async function optionsOf(page, scope, label) {
  const input = scope.getByLabel(label).first();
  await input.click();
  const opts = page.getByRole('option');
  await opts.first().waitFor({ timeout: 5000 }).catch(() => {});
  const texts = (await opts.allInnerTexts()).map((t) => t.trim()).filter(Boolean);
  return texts;
}
export async function closeDropdown(page) { await page.keyboard.press('Escape'); }

export async function pickOption(page, scope, label, optionText) {
  const input = scope.getByLabel(label).first();
  await input.click();
  const opt = page.getByRole('option', { name: optionText }).first();
  await opt.waitFor({ timeout: 5000 });
  await opt.click();
}

export async function typeDate(scope, label, text) {
  const loc = scope.getByLabel(label).first();
  await loc.click();
  await loc.fill(text);
  await loc.press('Tab');
  return loc;
}
// pick a day of the currently displayed month in an opened DateInput popover
export async function pickDay(page, scope, label, day) {
  const loc = scope.getByLabel(label).first();
  await loc.click();
  const cell = page.locator('.mantine-Popover-dropdown button.mantine-DateInput-day:not([data-outside])').filter({ visible: true }).filter({ hasText: new RegExp(`^${day}$`) }).last();
  await cell.waitFor({ timeout: 5000 });
  await cell.click();
  // the input is updated asynchronously after the click
  await page.waitForFunction(([el, d]) => new RegExp('^' + d + '/').test(el.value), [await loc.elementHandle(), String(day).padStart(2, '0')], { timeout: 3000 }).catch(() => {});
  return loc;
}

export async function toast(page, re, timeout = 8000) {
  const t = page.locator('.mantine-Notification-root').filter({ hasText: re }).first();
  try { await t.waitFor({ timeout }); return true; } catch { return false; }
}
export const toastTexts = async (page) => (await page.locator('.mantine-Notification-root').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());

export async function clearToasts(page) {
  await page.evaluate(() => document.querySelectorAll('.mantine-Notification-closeButton').forEach((b) => b.click()));
  await page.waitForTimeout(500);
}
export const row =(page, text) => page.locator('tr').filter({ hasText: text }).first();
export const brlRe = /R\$\s?\d{1,3}(\.\d{3})*,\d{2}/;
export async function bodyText(page) { return (await page.locator('body').innerText()); }
export const isBrDate = (s) => /^\d{2}\/\d{2}\/\d{4}$/.test(s);
// all visible texts that look like dates in iso (yyyy-mm-dd) or US (m/d/yyyy)
export async function badDates(page) {
  const t = await bodyText(page);
  const inputs = await page.locator('input').evaluateAll((els) => els.map((e) => e.value));
  const all = t + '\n' + inputs.join('\n');
  return (all.match(/\b\d{4}-\d{2}-\d{2}\b/g) || []).concat(all.match(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/g)?.filter((d) => !/^\d{2}\/\d{2}\/\d{4}$/.test(d)) || []);
}
export async function closeModal(page) {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
}
