// Fast CSV reader: a drop-in for csv-reader 1.0.0 — same answers, faster.
// Single pass, charCodeAt-based scanning, slice-based field extraction, indexOf
// to find closing quotes. No per-character string concatenation.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input {text, header}: {columns, rows, errors}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (len > 0 && text.charCodeAt(0) === 0xFEFF) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // Field result state, kept in closure variables so no result object is allocated per field.
  let ended = END;
  let added = 0;

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads unquoted characters onto `value` up to the next comma or line break: a CR not followed by LF is
  // dropped (stray_cr). Returns the field value; sets `ended` and `added` (characters kept).
  function readUnquoted(value) {
    let segStart = pos;
    added = 0;
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 44) { // ','
        if (pos > segStart) { value += text.slice(segStart, pos); added += pos - segStart; }
        pos += 1;
        ended = COMMA;
        return value;
      }
      if (c === 10) { // '\n'
        if (pos > segStart) { value += text.slice(segStart, pos); added += pos - segStart; }
        pos += 1;
        line += 1;
        ended = LINE_BREAK;
        return value;
      }
      if (c === 13) { // '\r'
        if (pos + 1 < len && text.charCodeAt(pos + 1) === 10) {
          if (pos > segStart) { value += text.slice(segStart, pos); added += pos - segStart; }
          pos += 2;
          line += 1;
          ended = LINE_BREAK;
          return value;
        }
        // Stray CR: dropped, error recorded, scanning continues.
        if (pos > segStart) { value += text.slice(segStart, pos); added += pos - segStart; }
        error('stray_cr');
        pos += 1;
        segStart = pos;
        continue;
      }
      pos += 1;
    }
    if (pos > segStart) { value += text.slice(segStart, pos); added += pos - segStart; }
    ended = END;
    return value;
  }

  // Appends text[start..end) of a quoted field to `value`, converting each CRLF or lone CR inside it
  // to LF and counting the lines. Fast path when the segment holds no CR or LF.
  function appendQuotedSegment(value, start, end) {
    const r = text.indexOf('\r', start);
    const n = text.indexOf('\n', start);
    if ((r === -1 || r >= end) && (n === -1 || n >= end)) {
      return value + text.slice(start, end);
    }
    // Slow path: CR or LF present. Slice between CRs, each CR becomes one LF.
    let out = value;
    let p = start;
    let segStart = start;
    while (p < end) {
      const c = text.charCodeAt(p);
      if (c === 13) { // '\r'
        out += text.slice(segStart, p);
        out += '\n';
        line += 1;
        p += (p + 1 < end && text.charCodeAt(p + 1) === 10) ? 2 : 1;
        segStart = p;
      } else {
        if (c === 10) line += 1;
        p += 1;
      }
    }
    out += text.slice(segStart, end);
    return out;
  }

  // Reads a quoted field whose opening quote is at pos. Returns the field value; sets `ended`.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    pos += 1; // skip the opening quote
    let segStart = pos;
    while (true) {
      const q = text.indexOf('"', pos);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text after it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        error('unterminated_quote');
        return readUnquoted('"');
      }
      if (q + 1 < len && text.charCodeAt(q + 1) === 34) {
        // Doubled quote: one quote in the value, scanning continues after the pair.
        value = appendQuotedSegment(value, segStart, q);
        value += '"';
        pos = q + 2;
        segStart = pos;
        continue;
      }
      // Closing quote at q.
      value = appendQuotedSegment(value, segStart, q);
      pos = q + 1;
      if (pos >= len) { ended = END; return value; }
      const c = text.charCodeAt(pos);
      if (c === 44) { pos += 1; ended = COMMA; return value; } // ','
      if (c === 10) { pos += 1; line += 1; ended = LINE_BREAK; return value; } // '\n'
      if (c === 13 && pos + 1 < len && text.charCodeAt(pos + 1) === 10) {
        pos += 2; line += 1; ended = LINE_BREAK; return value; // CRLF
      }
      // What follows the closing quote is appended as it stands, up to the next comma or line break.
      const junk = readUnquoted(value);
      if (added > 0) error('quote_junk');
      return junk;
    }
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) { // '\n'
        pos += 1;
        line += 1;
      } else if (c === 13 && pos + 1 < len && text.charCodeAt(pos + 1) === 10) { // CRLF
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted = false;
    do {
      quoted = pos < len && text.charCodeAt(pos) === 34;
      const v = quoted ? readQuoted() : readUnquoted('');
      fields.push(v);
    } while (ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
