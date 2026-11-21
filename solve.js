// solve.js — a fast drop-in replacement for csv-reader 1.0.0.
//
// run(input) returns, for every input {text, header}, exactly the answer
// csv-reader 1.0.0 returns: {columns, rows, errors}. The reading rules are
// csv-reader's documented ones for broken CSV:
//
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF; a line left with no characters is no
//     record at all;
//   - outside quotes, a CR not followed by LF is dropped (error stray_cr);
//   - a field that opens with a quote runs to the next quote that is not
//     doubled ("" inside it is one quote; each CRLF or lone CR inside it is
//     read as LF); what follows the closing quote, up to the next comma or
//     line break, is appended as it stands (error quote_junk when the field
//     ends, if anything was appended);
//   - a quote that never closes is a literal character and the text after
//     it is read again as unquoted (error unterminated_quote);
//   - a quote inside an unquoted field is a literal character;
//   - fields stay strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows are
//     the records after it (every record when header is false), each padded
//     with empty strings (error short_row, with fields: its field count) or
//     cut (error long_row, with extra: the cut fields) to the first
//     record's width;
//   - each error is {code, line, row} in the order met, a record's
//     short_row or long_row raised when it ends; line is the 1-based line
//     the record starts on, counting every LF, CRLF and lone CR inside
//     quotes; row is the record's index in rows, null for the header.
//
// The scanner is indexOf-driven: on the common path a field is one slice of
// the input, and error objects are only allocated when an error occurs.
// Nothing is cached between calls; run() is pure per case.

export function run(input) {
  const text = input.text;
  const header = !!input.header;
  const n = text.length;
  let i = 0;
  if (n !== 0 && text.charCodeAt(0) === 0xfeff) i = 1;

  let columns = null;
  const rows = [];
  const errors = [];

  let line = 1; // 1-based line the scanner is currently on
  let width = -1; // field count of the first record, once read
  let recordIndex = 0; // records completed so far
  let pendingStrays = 0; // stray CRs met at a line start, awaiting a record

  // The row value an error of the record now being read carries.
  function currentRow() {
    if (!header) return recordIndex;
    return recordIndex === 0 ? null : recordIndex - 1;
  }

  while (i < n) {
    const c = text.charCodeAt(i);

    // A line left with no characters is no record: skip its terminator.
    if (c === 0x0a) {
      // LF
      i += 1;
      line += 1;
      continue;
    }
    if (c === 0x0d) {
      if (text.charCodeAt(i + 1) === 0x0a) {
        // CRLF: also just an empty line.
        i += 2;
        line += 1;
        continue;
      }
      // A lone CR at a line start is dropped (stray_cr); it belongs to the
      // next record and does not advance the line count.
      pendingStrays += 1;
      i += 1;
      continue;
    }

    // A record starts here.
    const recordLine = line;
    const row = currentRow();
    while (pendingStrays > 0) {
      errors.push({ code: "stray_cr", line: recordLine, row });
      pendingStrays -= 1;
    }

    const fields = [];

    // Parse fields until a line break or the end of the text ends the record.
    for (;;) {
      let value;
      let junkError = false;
      let unterminatedError = false;

      if (text.charCodeAt(i) === 0x22) {
        // '"' — a field that opens with a quote.
        const parts = [];
        let segStart = i + 1;
        let pos = i + 1;
        let closed = false;
        // Line breaks inside the field are counted locally and only
        // committed when the field really closes: if the quote never
        // closes, the fallback re-reads the text as unquoted and counts
        // those breaks itself, so committing them here would double-count.
        let lineDelta = 0;
        while (pos < n) {
          const q = text.indexOf('"', pos);
          const lf = text.indexOf("\n", pos);
          const cr = text.indexOf("\r", pos);
          let next = -1;
          let kind = 0; // 1 = quote, 2 = LF, 3 = CR
          if (q !== -1) {
            next = q;
            kind = 1;
          }
          if (lf !== -1 && (next === -1 || lf < next)) {
            next = lf;
            kind = 2;
          }
          if (cr !== -1 && (next === -1 || cr < next)) {
            next = cr;
            kind = 3;
          }
          if (next === -1) break; // EOF inside the quoted field
          if (kind === 1) {
            if (text.charCodeAt(next + 1) === 0x22) {
              // A doubled quote is one quote in the value.
              parts.push(text.slice(segStart, next), '"');
              pos = next + 2;
              segStart = pos;
            } else {
              parts.push(text.slice(segStart, next));
              pos = next + 1;
              closed = true;
              break;
            }
          } else if (kind === 2) {
            parts.push(text.slice(segStart, next), "\n");
            lineDelta += 1;
            pos = next + 1;
            segStart = pos;
          } else {
            // CR inside quotes is read as LF, CRLF as one LF.
            parts.push(text.slice(segStart, next), "\n");
            lineDelta += 1;
            pos = text.charCodeAt(next + 1) === 0x0a ? next + 2 : next + 1;
            segStart = pos;
          }
        }

        if (closed) {
          line += lineDelta;
          value = parts.length === 1 ? parts[0] : parts.join("");
          // Quote junk: everything up to the next comma or line break is
          // appended as it stands; a lone CR in it follows the outside-
          // quotes rule (dropped, stray_cr).
          let junkStart = pos;
          let junkParts = null;
          while (pos < n) {
            const comma = text.indexOf(",", pos);
            const lf = text.indexOf("\n", pos);
            const cr = text.indexOf("\r", pos);
            let next = -1;
            let kind = 0; // 1 = comma, 2 = LF, 3 = CR
            if (comma !== -1) {
              next = comma;
              kind = 1;
            }
            if (lf !== -1 && (next === -1 || lf < next)) {
              next = lf;
              kind = 2;
            }
            if (cr !== -1 && (next === -1 || cr < next)) {
              next = cr;
              kind = 3;
            }
            if (next === -1) {
              pos = n;
              break;
            }
            if (kind === 3 && text.charCodeAt(next + 1) !== 0x0a) {
              // Lone CR in the junk: dropped, stray_cr; junk continues.
              if (junkParts === null) junkParts = [];
              junkParts.push(text.slice(junkStart, next));
              errors.push({ code: "stray_cr", line: recordLine, row });
              pos = next + 1;
              junkStart = pos;
              continue;
            }
            pos = next;
            break;
          }
          let junk;
          if (junkParts === null) {
            junk = text.slice(junkStart, pos);
          } else {
            junkParts.push(text.slice(junkStart, pos));
            junk = junkParts.join("");
          }
          if (junk !== "") {
            value += junk;
            junkError = true;
          }
          i = pos;
        } else {
          // The quote never closes: it is a literal character and the text
          // after it is read again as unquoted, from just after the quote.
          unterminatedError = true;
          value = '"' + readUnquoted(text, i + 1, n, recordLine, row, errors);
          i = readEnd;
        }
      } else {
        value = readUnquoted(text, i, n, recordLine, row, errors);
        i = readEnd;
      }

      if (junkError) errors.push({ code: "quote_junk", line: recordLine, row });
      if (unterminatedError) {
        errors.push({ code: "unterminated_quote", line: recordLine, row });
      }
      fields.push(value);

      // What ended the field decides what happens next.
      if (i >= n) break; // the record ends at the end of the text
      const d = text.charCodeAt(i);
      if (d === 0x2c) {
        // ',' — another field follows (possibly an empty one at the end).
        i += 1;
        if (i >= n) {
          fields.push("");
          break;
        }
        const e = text.charCodeAt(i);
        if (e === 0x0a) {
          fields.push("");
          i += 1;
          line += 1;
          break;
        }
        if (e === 0x0d && text.charCodeAt(i + 1) === 0x0a) {
          fields.push("");
          i += 2;
          line += 1;
          break;
        }
        continue;
      }
      if (d === 0x0a) {
        i += 1;
        line += 1;
        break;
      }
      // d is CR and (from the field readers) is followed by LF: CRLF.
      i += 2;
      line += 1;
      break;
    }

    // The record is complete: file it under columns or rows, padded or cut
    // to the first record's width.
    if (recordIndex === 0) {
      width = fields.length;
      if (header) {
        columns = fields;
      } else {
        rows.push(fields);
      }
    } else {
      if (fields.length < width) {
        errors.push({
          code: "short_row",
          line: recordLine,
          row,
          fields: fields.length,
        });
        while (fields.length < width) fields.push("");
      } else if (fields.length > width) {
        errors.push({
          code: "long_row",
          line: recordLine,
          row,
          extra: fields.slice(width),
        });
        fields.length = width;
      }
      rows.push(fields);
    }
    recordIndex += 1;
  }

  // Stray CRs that no record ever claimed (assumption A2 of the spec).
  while (pendingStrays > 0) {
    errors.push({ code: "stray_cr", line, row: currentRow() });
    pendingStrays -= 1;
  }

  return { columns, rows, errors };
}

// The end position of the most recent readUnquoted call. Kept at module
// level so the common path allocates nothing per field.
let readEnd = 0;

// Reads one unquoted field starting at pos: everything up to the next
// comma, LF, CRLF or the end of the text. A lone CR met on the way is
// dropped and reported as stray_cr against the record being read. A quote
// is an ordinary character here. Sets readEnd to the delimiter position
// (or n) and returns the field's value.
function readUnquoted(text, pos, n, recordLine, row, errors) {
  let parts = null;
  let segStart = pos;
  for (;;) {
    const comma = text.indexOf(",", pos);
    const lf = text.indexOf("\n", pos);
    const cr = text.indexOf("\r", pos);
    let next = -1;
    let kind = 0; // 1 = comma, 2 = LF, 3 = CR
    if (comma !== -1) {
      next = comma;
      kind = 1;
    }
    if (lf !== -1 && (next === -1 || lf < next)) {
      next = lf;
      kind = 2;
    }
    if (cr !== -1 && (next === -1 || cr < next)) {
      next = cr;
      kind = 3;
    }
    if (next === -1) {
      readEnd = n;
      if (parts === null) return text.slice(segStart, n);
      parts.push(text.slice(segStart, n));
      return parts.join("");
    }
    if (kind === 3 && text.charCodeAt(next + 1) !== 0x0a) {
      // A lone CR outside quotes is dropped (stray_cr); the field goes on.
      if (parts === null) parts = [];
      parts.push(text.slice(segStart, next));
      errors.push({ code: "stray_cr", line: recordLine, row });
      pos = next + 1;
      segStart = pos;
      continue;
    }
    readEnd = next;
    if (parts === null) return text.slice(segStart, next);
    parts.push(text.slice(segStart, next));
    return parts.join("");
  }
}
