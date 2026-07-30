/* xlsx.ts — dependency-free .xlsx writer (ZIP "stored" method + SpreadsheetML).
   Works in the browser and in Node.

   Everything is assembled as byte chunks (never as one big string encoded at the
   end) so that non-ASCII content cannot shift ZIP central-directory offsets. */

/* ------------------------------------------------------------------ CRC32 */

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]!) & 0xFF]! ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const ENCODER = new TextEncoder();
const utf8 = (str: string): Uint8Array => ENCODER.encode(str);

/* ------------------------------------------------------------ byte writer */

class ByteWriter {
  private readonly chunks: Uint8Array[] = [];
  length = 0;

  push(bytes: Uint8Array): void {
    this.chunks.push(bytes);
    this.length += bytes.length;
  }

  u16(v: number): void {
    const b = new Uint8Array(2);
    b[0] = v & 0xFF;
    b[1] = (v >>> 8) & 0xFF;
    this.push(b);
  }

  u32(v: number): void {
    const b = new Uint8Array(4);
    b[0] = v & 0xFF;
    b[1] = (v >>> 8) & 0xFF;
    b[2] = (v >>> 16) & 0xFF;
    b[3] = (v >>> 24) & 0xFF;
    this.push(b);
  }

  bytes(): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

/* -------------------------------------------------------------------- ZIP */

interface ZipFile { name: string; data: Uint8Array }

function dosStamp(date?: Date): { time: number; date: number } {
  const d = date ?? new Date();
  const year = Math.max(d.getFullYear(), 1980);
  return {
    time: ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() >> 1) & 31),
    date: (((year - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31)
  };
}

/** Files are stored, never deflated — the writer stays dependency-free. */
function zipStore(files: readonly ZipFile[], when?: Date): Uint8Array<ArrayBuffer> {
  const stamp = dosStamp(when);
  const w = new ByteWriter();
  const index: Array<{ nameBytes: Uint8Array; crc: number; size: number; offset: number }> = [];

  for (const file of files) {
    const nameBytes = utf8(file.name);
    const crc = crc32(file.data);
    const offset = w.length;

    w.u32(0x04034B50);            // local file header signature
    w.u16(20);                    // version needed
    w.u16(0);                     // general purpose flag
    w.u16(0);                     // compression method: stored
    w.u16(stamp.time);
    w.u16(stamp.date);
    w.u32(crc);
    w.u32(file.data.length);      // compressed size
    w.u32(file.data.length);      // uncompressed size
    w.u16(nameBytes.length);
    w.u16(0);                     // extra field length
    w.push(nameBytes);
    w.push(file.data);

    index.push({ nameBytes, crc, size: file.data.length, offset });
  }

  const cdStart = w.length;
  for (const e of index) {
    w.u32(0x02014B50);            // central directory header signature
    w.u16(20);                    // version made by
    w.u16(20);                    // version needed
    w.u16(0);                     // flag
    w.u16(0);                     // compression method
    w.u16(stamp.time);
    w.u16(stamp.date);
    w.u32(e.crc);
    w.u32(e.size);
    w.u32(e.size);
    w.u16(e.nameBytes.length);
    w.u16(0);                     // extra length
    w.u16(0);                     // comment length
    w.u16(0);                     // disk number start
    w.u16(0);                     // internal attributes
    w.u32(0);                     // external attributes
    w.u32(e.offset);
    w.push(e.nameBytes);
  }
  const cdSize = w.length - cdStart;

  w.u32(0x06054B50);              // end of central directory
  w.u16(0); w.u16(0);
  w.u16(index.length); w.u16(index.length);
  w.u32(cdSize);
  w.u32(cdStart);
  w.u16(0);                       // comment length

  return w.bytes();
}

/* -------------------------------------------------------------------- XML */

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'
};

export function esc(value: unknown): string {
  return String(value)
    .replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c)
    // Control characters are not representable in XML 1.0 and make Excel
    // reject the whole part.
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

/** 1-based column index -> A, B, … AA. */
export function colName(index: number): string {
  let name = '';
  let n = index;
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name || 'A';
}

const EPOCH = Date.UTC(1899, 11, 30); // Excel's 1900 system, leap-bug aligned

/** Excel serial for a date, or null if the value is not one. */
export function dateSerial(value: Date | string | null | undefined): number | null {
  let ms: number;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    ms = Date.UTC(value.getFullYear(), value.getMonth(), value.getDate());
  } else {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
    if (!m) return null;
    ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
  return Math.round((ms - EPOCH) / 86400000);
}

/* ----------------------------------------------------------------- styles */

/** Style name -> cellXfs index. Keep in sync with buildStyles(). */
export const STYLES = {
  normal: 0, header: 1, date: 2, money: 3, text: 4, bold: 5,
  moneyBold: 6, percent: 7, title: 8, number: 9, group: 10,
  int: 11, muted: 12, moneyNeg: 13, wrap: 14
} as const;

export type StyleName = keyof typeof STYLES;

function buildStyles(currencySymbol: string | null | undefined): string {
  const cur = esc(currencySymbol ?? '');
  const q = '&quot;';
  const money = `${q}${cur}${q}#,##0.00;[Red]\\-${q}${cur}${q}#,##0.00`;

  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<numFmts count="5">' +
      '<numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/>' +
      `<numFmt numFmtId="165" formatCode="${money}"/>` +
      '<numFmt numFmtId="166" formatCode="0.0%"/>' +
      '<numFmt numFmtId="167" formatCode="#,##0.00"/>' +
      '<numFmt numFmtId="168" formatCode="#,##0"/>' +
    '</numFmts>' +
    '<fonts count="5">' +
      '<font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font>' +
      '<font><b/><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font>' +
      '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>' +
      '<font><b/><sz val="15"/><color rgb="FF17324D"/><name val="Calibri"/><family val="2"/></font>' +
      '<font><sz val="11"/><color rgb="FF6B7785"/><name val="Calibri"/><family val="2"/></font>' +
    '</fonts>' +
    '<fills count="4">' +
      '<fill><patternFill patternType="none"/></fill>' +
      '<fill><patternFill patternType="gray125"/></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FF17324D"/><bgColor indexed="64"/></patternFill></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FFE8EEF5"/><bgColor indexed="64"/></patternFill></fill>' +
    '</fills>' +
    '<borders count="2">' +
      '<border><left/><right/><top/><bottom/><diagonal/></border>' +
      '<border><left/><right/><top/><bottom style="thin"><color rgb="FFB9C4D2"/></bottom><diagonal/></border>' +
    '</borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="15">' +
      /*  0 normal    */ '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      /*  1 header    */ '<xf numFmtId="0" fontId="2" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>' +
      /*  2 date      */ '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
      /*  3 money     */ '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
      /*  4 text      */ '<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
      /*  5 bold      */ '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
      /*  6 moneyBold */ '<xf numFmtId="165" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>' +
      /*  7 percent   */ '<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
      /*  8 title     */ '<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
      /*  9 number    */ '<xf numFmtId="167" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
      /* 10 group     */ '<xf numFmtId="0" fontId="1" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>' +
      /* 11 int       */ '<xf numFmtId="168" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
      /* 12 muted     */ '<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
      /* 13 moneyNeg  */ '<xf numFmtId="165" fontId="4" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>' +
      /* 14 wrap      */ '<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>' +
    '</cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>';
}

/* ------------------------------------------------------------------ cells */

export type CellType = 'text' | 'number' | 'money' | 'date' | 'percent' | 'int' | 'formula';

export interface CellObject {
  t?: CellType;
  /** For a formula this is the cached result Excel shows before recalculating. */
  v?: string | number | Date | null;
  /** Formula text, without the leading `=`. */
  f?: string;
  s?: StyleName;
}

/** `null`/`undefined`/`''` are blank; a bare string or number is inferred. */
export type CellInput = CellObject | string | number | null | undefined;

export type Row = readonly CellInput[];

export interface Sheet {
  name?: string;
  rows?: readonly Row[];
  cols?: ReadonlyArray<{ w?: number }>;
  /** Number of leading rows to freeze. */
  freeze?: number;
  autoFilter?: string;
}

export interface WriteOptions {
  currency?: string;
  when?: Date;
  sheets?: ReadonlyArray<Sheet | null | undefined>;
}

interface NormalCell {
  t: CellType | 'blank';
  v?: string | number | Date | null;
  f?: string;
  s: StyleName;
}

const DEFAULT_STYLE: Readonly<Partial<Record<CellType, StyleName>>> = {
  money: 'money', date: 'date', percent: 'percent', int: 'int', number: 'number'
};

function normalize(cell: CellInput): NormalCell {
  if (cell === null || cell === undefined || cell === '') return { t: 'blank', s: 'normal' };
  if (typeof cell === 'number') return { t: 'number', v: cell, s: 'number' };
  if (typeof cell === 'string') return { t: 'text', v: cell, s: 'text' };

  const t: CellType = cell.t ?? (cell.f ? 'formula' : (typeof cell.v === 'number' ? 'number' : 'text'));
  return {
    t,
    v: cell.v,
    f: cell.f,
    s: cell.s ?? DEFAULT_STYLE[t] ?? 'text'
  };
}

function inlineString(ref: string, styleIndex: number, value: unknown): string {
  const sAttr = styleIndex ? ` s="${styleIndex}"` : '';
  return `<c r="${ref}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${esc(value ?? '')}</t></is></c>`;
}

function cellXml(ref: string, cell: CellInput): string {
  const c = normalize(cell);
  const styleIndex = STYLES[c.s] ?? STYLES.normal;
  const sAttr = styleIndex ? ` s="${styleIndex}"` : '';

  switch (c.t) {
    case 'blank':
      return `<c r="${ref}"${sAttr}/>`;

    case 'formula': {
      // Both <f> and a cached <v>: Excel shows the value before it recalculates.
      const cached = (typeof c.v === 'number' && Number.isFinite(c.v)) ? `<v>${c.v}</v>` : '';
      return `<c r="${ref}"${sAttr}><f>${esc(c.f)}</f>${cached}</c>`;
    }

    case 'date': {
      const value = c.v;
      const serial = (value instanceof Date || typeof value === 'string') ? dateSerial(value) : null;
      if (serial === null) return inlineString(ref, STYLES.text, value);
      return `<c r="${ref}"${sAttr}><v>${serial}</v></c>`;
    }

    case 'number':
    case 'money':
    case 'percent':
    case 'int': {
      const num = Number(c.v);
      if (!Number.isFinite(num)) return `<c r="${ref}"${sAttr}/>`;
      return `<c r="${ref}"${sAttr}><v>${num}</v></c>`;
    }

    default:
      return inlineString(ref, styleIndex, c.v);
  }
}

function sheetXml(sheet: Sheet): string {
  const rows = sheet.rows ?? [];
  const maxCols = rows.reduce((max, row) => Math.max(max, row?.length ?? 0), 1);

  const parts: string[] = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'];

  parts.push(`<dimension ref="A1:${colName(maxCols)}${Math.max(rows.length, 1)}"/>`);

  const freeze = sheet.freeze ?? 0;
  if (freeze > 0) {
    parts.push('<sheetViews><sheetView workbookViewId="0">' +
      `<pane ySplit="${freeze}" topLeftCell="A${freeze + 1}" activePane="bottomLeft" state="frozen"/>` +
      `<selection pane="bottomLeft" activeCell="A${freeze + 1}" sqref="A${freeze + 1}"/>` +
      '</sheetView></sheetViews>');
  } else {
    parts.push('<sheetViews><sheetView workbookViewId="0"/></sheetViews>');
  }

  parts.push('<sheetFormatPr defaultRowHeight="15"/>');

  if (sheet.cols?.length) {
    parts.push('<cols>');
    sheet.cols.forEach((col, i) => {
      parts.push(`<col min="${i + 1}" max="${i + 1}" width="${col.w ?? 14}" customWidth="1"/>`);
    });
    parts.push('</cols>');
  }

  parts.push('<sheetData>');
  rows.forEach((row, r) => {
    if (!row?.length) { parts.push(`<row r="${r + 1}"/>`); return; }
    parts.push(`<row r="${r + 1}">`);
    for (let c = 0; c < row.length; c++) {
      parts.push(cellXml(colName(c + 1) + (r + 1), row[c]));
    }
    parts.push('</row>');
  });
  parts.push('</sheetData>');

  // Schema order: autoFilter must follow sheetData.
  if (sheet.autoFilter) parts.push(`<autoFilter ref="${esc(sheet.autoFilter)}"/>`);

  parts.push('</worksheet>');
  return parts.join('');
}

/* --------------------------------------------------------------- workbook */

/** Excel rejects several characters in a sheet name, caps it at 31 characters
    and will not open a workbook with two sheets of the same name. */
function sanitizeSheetName(name: string | undefined, index: number, used: string[]): string {
  const fallback = `Sheet${index + 1}`;
  const clean = String(name || fallback).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31).trim() || fallback;

  let candidate = clean;
  let n = 2;
  while (used.includes(candidate.toLowerCase())) {
    const suffix = ` (${n++})`;
    candidate = clean.slice(0, 31 - suffix.length) + suffix;
  }
  used.push(candidate.toLowerCase());
  return candidate;
}

export function write(options: WriteOptions = {}): Uint8Array<ArrayBuffer> {
  const supplied = (options.sheets ?? []).filter((s): s is Sheet => !!s);
  const sheets: Sheet[] = supplied.length ? supplied : [{ name: 'Sheet1', rows: [] }];

  // Names are resolved alongside the sheets rather than written back onto the
  // caller's objects, so write() leaves its input untouched.
  const used: string[] = [];
  const names = sheets.map((s, i) => sanitizeSheetName(s.name, i, used));

  const contentTypes = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'];
  sheets.forEach((_s, i) => {
    contentTypes.push(`<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
  });
  contentTypes.push('</Types>');

  const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>';

  const wbSheets = names
    .map((name, i) => `<sheet name="${esc(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join('');

  const workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheets>${wbSheets}</sheets></workbook>`;

  const wbRels = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'];
  sheets.forEach((_s, i) => {
    wbRels.push(`<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`);
  });
  wbRels.push(`<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`);
  wbRels.push('</Relationships>');

  const files: ZipFile[] = [
    { name: '[Content_Types].xml', data: utf8(contentTypes.join('')) },
    { name: '_rels/.rels', data: utf8(rootRels) },
    { name: 'xl/workbook.xml', data: utf8(workbook) },
    { name: 'xl/_rels/workbook.xml.rels', data: utf8(wbRels.join('')) },
    { name: 'xl/styles.xml', data: utf8(buildStyles(options.currency)) }
  ];
  sheets.forEach((s, i) => {
    files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: utf8(sheetXml(s)) });
  });

  return zipStore(files, options.when);
}
