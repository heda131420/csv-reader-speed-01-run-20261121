// A faster drop-in for csv-reader 1.0.0: the same answers, read with
// index-based scans instead of one character at a time.
//
// The semantics are csv-reader's own, kept exactly:
//   - a U+FEFF at the very start is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside quotes a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled,
//     "" inside it one quote, each CRLF or lone CR inside it read as LF; what
//     follows its closing quote, up to the next comma or line break, is appended
//     as it stands (quote_junk, when the field ends); a quote that never closes
//     is a literal character, and the text after it is read again as unquoted
//     (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay
//     strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds the
//     records after it, each padded (short_row) or cut (long_row) to the first
//     record's width;
//   - each error is {code, line, row}: line the 1-based line its record starts
//     on, row its record's index in rows (null for the header), in the order met.
//
// The speed comes from never looking at a character twice: an unquoted field is
// one slice up to the next comma, LF or CR found by a single regex scan, and a
// quoted field jumps from quote to quote the same way. Only a field that holds a
// CR or a quoted field that spans lines takes the slow path, and there it works
// on whole segments, not characters.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;
  // First CR at or after pos, found lazily; -1 means "find again".
  let nextCR = -1;
  // Reused field result: readUnquoted/readQuoted write here instead of
  // allocating a result object per field.
  const fieldOut = { value: '', ended: END, added: 0 };

  // The record being read: the line it starts on and the index in rows it takes.
  let recordLine = 1;
  let recordRow = null;

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads unquoted characters onto `value` up to the next comma or line break:
  // a CR not followed by LF is dropped (stray_cr). Returns the field and how it
  // ended; `added` counts the characters kept.
  function readUnquoted(value) {
    let added = 0;
    const out = fieldOut;
    for (;;) {
      const c = text.indexOf(',', pos);
      const nl = text.indexOf('\n', pos);
      let end = -1;
      let kind = END;
      if (c !== -1 && (nl === -1 || c < nl)) {
        end = c;
        kind = COMMA;
      } else if (nl !== -1) {
        end = nl;
        kind = LINE_BREAK;
      }
      // The next CR at or after pos, found lazily. -1 means "find again"; n
      // means "none left", so a CR-free tail is never scanned twice.
      if (nextCR === -1 || nextCR < pos) {
        nextCR = text.indexOf('\r', pos);
        if (nextCR === -1) nextCR = n;
      }
      if (nextCR < n && (end === -1 || nextCR < end)) {
        if (nextCR + 1 < n && text.charCodeAt(nextCR + 1) === 10) {
          if (nextCR > pos) {
            value += text.slice(pos, nextCR);
            added += nextCR - pos;
          }
          pos = nextCR + 2;
          line += 1;
          nextCR = -1;
          out.value = value;
          out.ended = LINE_BREAK;
          out.added = added;
          return out;
        }
        if (nextCR > pos) {
          value += text.slice(pos, nextCR);
          added += nextCR - pos;
        }
        error('stray_cr');
        pos = nextCR + 1;
        nextCR = -1;
        continue;
      }
      if (end === -1) {
        if (pos < n) {
          value += text.slice(pos);
          added += n - pos;
        }
        pos = n;
        out.value = value;
        out.ended = END;
        out.added = added;
        return out;
      }
      if (end > pos) {
        value += text.slice(pos, end);
        added += end - pos;
      }
      if (kind === COMMA) {
        pos = end + 1;
        out.value = value;
        out.ended = COMMA;
        out.added = added;
        return out;
      }
      pos = end + 1;
      line += 1;
      out.value = value;
      out.ended = LINE_BREAK;
      out.added = added;
      return out;
    }
  }

  // A quoted segment with its CRLF and lone CRs read as LF; counts the lines.
  // Only called for a segment that holds a CR or LF.
  function convertSegment(seg) {
    let out = '';
    let start = 0;
    for (let k = 0; k < seg.length; k += 1) {
      const ch = seg.charCodeAt(k);
      if (ch === 13) {
        out += seg.slice(start, k) + '\n';
        line += 1;
        if (k + 1 < seg.length && seg.charCodeAt(k + 1) === 10) k += 1;
        start = k + 1;
      } else if (ch === 10) {
        out += seg.slice(start, k) + '\n';
        line += 1;
        start = k + 1;
      }
    }
    return out + seg.slice(start);
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    pos += 1;
    for (;;) {
      const i = text.indexOf('"', pos);
      if (i === -1) {
        // The quote never closes: it is a literal character, and the text after
        // it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        error('unterminated_quote');
        return readUnquoted('"');
      }
      if (i > pos) {
        const seg = text.slice(pos, i);
        value += seg.indexOf('\r') === -1 && seg.indexOf('\n') === -1
          ? seg
          : convertSegment(seg);
      }
      if (i + 1 < n && text.charCodeAt(i + 1) === 34) {
        value += '"';
        pos = i + 2;
        continue;
      }
      pos = i + 1;
      break;
    }
    const out = fieldOut;
    if (pos >= n) {
      out.value = value;
      out.ended = END;
      out.added = 0;
      return out;
    }
    const c = text[pos];
    if (c === ',') {
      pos += 1;
      out.value = value;
      out.ended = COMMA;
      out.added = 0;
      return out;
    }
    if (c === '\n') {
      pos += 1;
      line += 1;
      out.value = value;
      out.ended = LINE_BREAK;
      out.added = 0;
      return out;
    }
    if (c === '\r' && pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      out.value = value;
      out.ended = LINE_BREAK;
      out.added = 0;
      return out;
    }
    // What follows the closing quote is appended as it stands, up to the next
    // comma or line break.
    const junk = readUnquoted(value);
    if (junk.added > 0) error('quote_junk');
    return junk;
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      if (text.charCodeAt(pos) === 10) {
        pos += 1;
        line += 1;
      } else if (
        text.charCodeAt(pos) === 13 &&
        pos + 1 < n &&
        text.charCodeAt(pos + 1) === 10
      ) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let field;
    let quoted;
    do {
      quoted = text.charCodeAt(pos) === 34;
      field = quoted ? readQuoted() : readUnquoted('');
      fields.push(field.value);
    } while (field.ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
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
