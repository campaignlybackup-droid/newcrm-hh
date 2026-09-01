import type { FieldDef, ModuleDef } from '@/modules/types';

/**
 * Client-side export of exactly the rows the user was allowed to read.
 * There is no privileged server export path, so an export can never widen
 * what someone can see: RLS already filtered the rows on their way in.
 */
function cell(value: unknown): string {
  if (value == null) return '';
  if (Array.isArray(value)) return value.join('; ');
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return String(o.full_name ?? o.brand_name ?? o.name ?? o.title ?? JSON.stringify(o));
  }
  return String(value);
}

function escapeCsv(s: string) {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(mod: ModuleDef, rows: Record<string, unknown>[], fields?: FieldDef[]): string {
  const cols = fields ?? mod.fields;
  const header = cols.map((f) => escapeCsv(f.label)).join(',');
  const body = rows.map((r) =>
    cols.map((f) => escapeCsv(cell(resolveValue(r, f)))).join(','),
  );
  return [header, ...body].join('\n');
}

/** Prefers the embedded relation label over the raw foreign key. */
export function resolveValue(row: Record<string, unknown>, f: FieldDef): unknown {
  const embedKey = f.key.replace(/_id$/, '');
  if (f.key.endsWith('_id') && row[embedKey] && typeof row[embedKey] === 'object') {
    return row[embedKey];
  }
  return row[f.key];
}

/**
 * SpreadsheetML — a real .xlsx needs a zip writer; this opens natively in
 * Excel, Numbers and Sheets while staying dependency-free.
 */
export function toXlsxXml(mod: ModuleDef, rows: Record<string, unknown>[], fields?: FieldDef[]): string {
  const cols = fields ?? mod.fields;
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const row = (cells: string[], style = '') =>
    `<Row>${cells.map((c) => `<Cell${style}><Data ss:Type="String">${esc(c)}</Data></Cell>`).join('')}</Row>`;
  return `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
          xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Styles><Style ss:ID="h"><Font ss:Bold="1"/></Style></Styles>
 <Worksheet ss:Name="${esc(mod.label).slice(0, 31)}"><Table>
  ${row(cols.map((f) => f.label), ' ss:StyleID="h"')}
  ${rows.map((r) => row(cols.map((f) => cell(resolveValue(r, f))))).join('\n  ')}
 </Table></Worksheet>
</Workbook>`;
}

export function download(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function exportRecords(
  mod: ModuleDef,
  rows: Record<string, unknown>[],
  format: 'csv' | 'xlsx',
  fields?: FieldDef[],
) {
  const stamp = new Date().toISOString().slice(0, 10);
  if (format === 'csv') {
    download(`${mod.key}-${stamp}.csv`, toCsv(mod, rows, fields), 'text/csv;charset=utf-8');
  } else {
    download(`${mod.key}-${stamp}.xls`, toXlsxXml(mod, rows, fields), 'application/vnd.ms-excel');
  }
}
