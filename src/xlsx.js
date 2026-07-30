/* xlsx.js — dependency-free .xlsx writer (ZIP "stored" method + SpreadsheetML).
   Works in the browser and in Node. Attaches globalThis.XLSXMini.

   Everything is assembled as byte chunks (never as one big string encoded at the
   end) so that non-ASCII content cannot shift ZIP central-directory offsets. */
(function (root) {
  'use strict';

  /* ------------------------------------------------------------------ CRC32 */

  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  }());

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  var ENCODER = new TextEncoder();
  function utf8(str) { return ENCODER.encode(str); }

  /* ------------------------------------------------------------ byte writer */

  function ByteWriter() { this.chunks = []; this.length = 0; }

  ByteWriter.prototype.push = function (bytes) {
    this.chunks.push(bytes);
    this.length += bytes.length;
  };
  ByteWriter.prototype.u16 = function (v) {
    var b = new Uint8Array(2);
    b[0] = v & 0xFF; b[1] = (v >>> 8) & 0xFF;
    this.push(b);
  };
  ByteWriter.prototype.u32 = function (v) {
    var b = new Uint8Array(4);
    b[0] = v & 0xFF; b[1] = (v >>> 8) & 0xFF; b[2] = (v >>> 16) & 0xFF; b[3] = (v >>> 24) & 0xFF;
    this.push(b);
  };
  ByteWriter.prototype.bytes = function () {
    var out = new Uint8Array(this.length), off = 0;
    for (var i = 0; i < this.chunks.length; i++) {
      out.set(this.chunks[i], off);
      off += this.chunks[i].length;
    }
    return out;
  };

  /* -------------------------------------------------------------------- ZIP */

  function dosStamp(date) {
    var d = date || new Date();
    var year = d.getFullYear() < 1980 ? 1980 : d.getFullYear();
    return {
      time: ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() >> 1) & 31),
      date: (((year - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31)
    };
  }

  /* files: [{ name: 'ascii/path.xml', data: Uint8Array }] — stored, no deflate. */
  function zipStore(files, when) {
    var stamp = dosStamp(when);
    var w = new ByteWriter();
    var index = [];

    files.forEach(function (file) {
      var nameBytes = utf8(file.name);
      var crc = crc32(file.data);
      var offset = w.length;

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

      index.push({ nameBytes: nameBytes, crc: crc, size: file.data.length, offset: offset });
    });

    var cdStart = w.length;
    index.forEach(function (e) {
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
    });
    var cdSize = w.length - cdStart;

    w.u32(0x06054B50);              // end of central directory
    w.u16(0); w.u16(0);
    w.u16(index.length); w.u16(index.length);
    w.u32(cdSize);
    w.u32(cdStart);
    w.u16(0);                       // comment length

    return w.bytes();
  }

  /* -------------------------------------------------------------------- XML */

  var ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

  function esc(value) {
    return String(value)
      .replace(/[&<>"']/g, function (c) { return ESCAPES[c]; })
      // Control characters are not representable in XML 1.0 and make Excel
      // reject the whole part.
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  }

  function colName(index) { // 1-based -> A, B, ... AA
    var name = '';
    while (index > 0) {
      var rem = (index - 1) % 26;
      name = String.fromCharCode(65 + rem) + name;
      index = Math.floor((index - 1) / 26);
    }
    return name || 'A';
  }

  var EPOCH = Date.UTC(1899, 11, 30); // Excel's 1900 system, leap-bug aligned

  function dateSerial(value) {
    var ms;
    if (value instanceof Date) {
      if (isNaN(value.getTime())) return null;
      ms = Date.UTC(value.getFullYear(), value.getMonth(), value.getDate());
    } else {
      var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
      if (!m) return null;
      ms = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    }
    return Math.round((ms - EPOCH) / 86400000);
  }

  /* ----------------------------------------------------------------- styles */

  // Style name -> cellXfs index. Keep in sync with buildStyles().
  var S = {
    normal: 0, header: 1, date: 2, money: 3, text: 4, bold: 5,
    moneyBold: 6, percent: 7, title: 8, number: 9, group: 10,
    int: 11, muted: 12, moneyNeg: 13, wrap: 14
  };

  function buildStyles(currencySymbol) {
    var cur = esc(String(currencySymbol == null ? '' : currencySymbol));
    var q = '&quot;';
    var money = q + cur + q + '#,##0.00;[Red]\\-' + q + cur + q + '#,##0.00';

    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<numFmts count="5">' +
        '<numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/>' +
        '<numFmt numFmtId="165" formatCode="' + money + '"/>' +
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

  /* Accepted cell shapes:
       null | undefined | ''            -> blank
       'text'                           -> inline string
       42                               -> number
       { t:'text'|'number'|'money'|'date'|'percent'|'int'|'formula', v, f, s } */
  function normalize(cell) {
    if (cell === null || cell === undefined || cell === '') return { t: 'blank' };
    if (typeof cell === 'number') return { t: 'number', v: cell, s: 'number' };
    if (typeof cell === 'string') return { t: 'text', v: cell, s: 'text' };
    if (typeof cell !== 'object') return { t: 'text', v: String(cell), s: 'text' };

    var out = { t: cell.t || (cell.f ? 'formula' : (typeof cell.v === 'number' ? 'number' : 'text')) };
    out.v = cell.v;
    out.f = cell.f;
    out.s = cell.s || ({
      money: 'money', date: 'date', percent: 'percent', int: 'int', number: 'number'
    }[out.t] || 'text');
    return out;
  }

  function cellXml(ref, cell) {
    var c = normalize(cell);
    var styleIndex = S[c.s];
    if (styleIndex === undefined) styleIndex = S.normal;
    var sAttr = styleIndex ? ' s="' + styleIndex + '"' : '';

    if (c.t === 'blank') return '<c r="' + ref + '"' + sAttr + '/>';

    if (c.t === 'formula') {
      var cached = (typeof c.v === 'number' && isFinite(c.v)) ? '<v>' + c.v + '</v>' : '';
      // Both <f> and a cached <v>: Excel shows the value before it recalculates.
      return '<c r="' + ref + '"' + sAttr + '><f>' + esc(c.f) + '</f>' + cached + '</c>';
    }

    if (c.t === 'date') {
      var serial = dateSerial(c.v);
      if (serial === null) return '<c r="' + ref + '" s="' + S.text + '" t="inlineStr"><is><t xml:space="preserve">' + esc(c.v == null ? '' : c.v) + '</t></is></c>';
      return '<c r="' + ref + '"' + sAttr + '><v>' + serial + '</v></c>';
    }

    if (c.t === 'number' || c.t === 'money' || c.t === 'percent' || c.t === 'int') {
      var num = Number(c.v);
      if (!isFinite(num)) return '<c r="' + ref + '"' + sAttr + '/>';
      return '<c r="' + ref + '"' + sAttr + '><v>' + num + '</v></c>';
    }

    return '<c r="' + ref + '"' + sAttr + ' t="inlineStr"><is><t xml:space="preserve">' + esc(c.v) + '</t></is></c>';
  }

  function sheetXml(sheet) {
    var rows = sheet.rows || [];
    var maxCols = 1;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i] && rows[i].length > maxCols) maxCols = rows[i].length;
    }

    var parts = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'];

    parts.push('<dimension ref="A1:' + colName(maxCols) + Math.max(rows.length, 1) + '"/>');

    var freeze = sheet.freeze || 0;
    if (freeze > 0) {
      parts.push('<sheetViews><sheetView workbookViewId="0">' +
        '<pane ySplit="' + freeze + '" topLeftCell="A' + (freeze + 1) + '" activePane="bottomLeft" state="frozen"/>' +
        '<selection pane="bottomLeft" activeCell="A' + (freeze + 1) + '" sqref="A' + (freeze + 1) + '"/>' +
        '</sheetView></sheetViews>');
    } else {
      parts.push('<sheetViews><sheetView workbookViewId="0"/></sheetViews>');
    }

    parts.push('<sheetFormatPr defaultRowHeight="15"/>');

    if (sheet.cols && sheet.cols.length) {
      parts.push('<cols>');
      sheet.cols.forEach(function (col, i) {
        parts.push('<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + (col.w || 14) + '" customWidth="1"/>');
      });
      parts.push('</cols>');
    }

    parts.push('<sheetData>');
    rows.forEach(function (row, r) {
      if (!row || !row.length) { parts.push('<row r="' + (r + 1) + '"/>'); return; }
      parts.push('<row r="' + (r + 1) + '">');
      for (var c = 0; c < row.length; c++) {
        parts.push(cellXml(colName(c + 1) + (r + 1), row[c]));
      }
      parts.push('</row>');
    });
    parts.push('</sheetData>');

    // Schema order: autoFilter must follow sheetData.
    if (sheet.autoFilter) parts.push('<autoFilter ref="' + esc(sheet.autoFilter) + '"/>');

    parts.push('</worksheet>');
    return parts.join('');
  }

  /* --------------------------------------------------------------- workbook */

  function sanitizeSheetName(name, index, used) {
    var clean = String(name || ('Sheet' + (index + 1))).replace(/[\\\/\?\*\[\]:]/g, ' ').slice(0, 31).trim();
    if (!clean) clean = 'Sheet' + (index + 1);
    var candidate = clean, n = 2;
    while (used.indexOf(candidate.toLowerCase()) !== -1) {
      var suffix = ' (' + n++ + ')';
      candidate = clean.slice(0, 31 - suffix.length) + suffix;
    }
    used.push(candidate.toLowerCase());
    return candidate;
  }

  /* write({ currency, sheets:[{name, cols, rows, freeze, autoFilter}] }) -> Uint8Array */
  function write(options) {
    var opts = options || {};
    var sheets = (opts.sheets || []).filter(function (s) { return s; });
    if (!sheets.length) sheets = [{ name: 'Sheet1', rows: [] }];

    var used = [];
    sheets.forEach(function (s, i) { s._name = sanitizeSheetName(s.name, i, used); });

    var contentTypes = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'];
    sheets.forEach(function (s, i) {
      contentTypes.push('<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>');
    });
    contentTypes.push('</Types>');

    var rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>';

    var wbSheets = sheets.map(function (s, i) {
      return '<sheet name="' + esc(s._name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>';
    }).join('');

    var workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets>' + wbSheets + '</sheets></workbook>';

    var wbRels = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'];
    sheets.forEach(function (s, i) {
      wbRels.push('<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>');
    });
    wbRels.push('<Relationship Id="rId' + (sheets.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>');
    wbRels.push('</Relationships>');

    var files = [
      { name: '[Content_Types].xml', data: utf8(contentTypes.join('')) },
      { name: '_rels/.rels', data: utf8(rootRels) },
      { name: 'xl/workbook.xml', data: utf8(workbook) },
      { name: 'xl/_rels/workbook.xml.rels', data: utf8(wbRels.join('')) },
      { name: 'xl/styles.xml', data: utf8(buildStyles(opts.currency)) }
    ];
    sheets.forEach(function (s, i) {
      files.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: utf8(sheetXml(s)) });
    });

    return zipStore(files, opts.when);
  }

  root.XLSXMini = {
    write: write,
    styles: S,
    colName: colName,
    dateSerial: dateSerial,
    crc32: crc32,
    _esc: esc
  };
}(typeof globalThis !== 'undefined' ? globalThis : this));
