// solve.js — a fast drop-in replacement for csv-reader 1.0.0 (v2).
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
// Assumptions A1-A5 of the build spec hold exactly as in v1 (stray CRs do
// not advance the line counter; a stray CR at a line start attaches to the
// next record; the unterminated-quote fallback re-reads from just after the
// opening quote; quote junk appends literally except for its delimiters;
// "" is a normal empty field and a line holding only "" is a record).
//
// Speed design (v2): one pass, everything inlined in a single loop. Two
// cursors, nextNL / nextCR, hold the next LF / CR at or after the scanner
// (n as the "none left" sentinel), refreshed lazily, so a plain field costs
// one indexOf(',') plus integer comparisons instead of three indexOf scans:
// a field ends at the nearer of the next comma and nextNL, and a stray CR
// inside it is caught by comparing nextCR with the field end (a CR that is
// the CRLF ending a line is the one exception, recognised by position).
// A quoted field on one line with no doubled quote is one indexOf('"') and
// one slice. The careful parsers (quoted fields with embedded breaks or
// doubled quotes, fields holding stray CRs, quote junk) live in small
// closures used only on those rare paths, so the common path allocates
// nothing but the field strings and the row arrays themselves. Nothing is
// cached between calls; run() is pure per case.

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

  // Cursors: the next LF / CR at or after i, or n when none is left. They
  // start at -1 so the first field refreshes them (see the refresh below).
  let nextNL = -1;
  let nextCR = -1;

  // A plain field's text in [start, end), dropping lone CRs (each raises
  // stray_cr). end is a comma, an LF, or n. A CR immediately before the
  // record's LF is that line's CRLF ending and is not content. Rare path.
  function slowPlain(start, end, recordLine, row) {
    let contentEnd = end;
    if (end < n && end === nextNL && end > start && text.charCodeAt(end - 1) === 13) contentEnd = end - 1;
    let parts = null;
    let segStart = start;
    let pos = start;
    for (;;) {
      const cr = text.indexOf("\r", pos);
      if (cr === -1 || cr >= contentEnd) break;
      if (parts === null) parts = [];
      parts.push(text.slice(segStart, cr));
      errors.push({ code: "stray_cr", line: recordLine, row });
      pos = cr + 1;
      segStart = pos;
    }
    if (parts === null) return text.slice(start, contentEnd);
    parts.push(text.slice(segStart, contentEnd));
    return parts.join("");
  }

  // A whole plain field read from start (rare path: the unterminated-quote
  // fallback re-reads from just after the opening quote). Returns
  // {value, end} with end at the comma, LF, or n that ends the field.
  function readPlain(start, recordLine, row) {
    if (nextNL < start) {
      nextNL = text.indexOf("\n", start);
      if (nextNL === -1) nextNL = n;
    }
    if (nextCR < start) {
      nextCR = text.indexOf("\r", start);
      if (nextCR === -1) nextCR = n;
    }
    const comma = text.indexOf(",", start);
    const end = comma !== -1 && comma < nextNL ? comma : nextNL;
    let value;
    if (nextCR < end && !(end < n && end === nextNL && nextCR === end - 1)) {
      value = slowPlain(start, end, recordLine, row);
    } else if (end < n && end === nextNL && end > start && text.charCodeAt(end - 1) === 13) {
      value = text.slice(start, end - 1);
    } else {
      value = text.slice(start, end);
    }
    return { value, end };
  }

  // A quoted field from its opening quote at start, read carefully: doubled
  // quotes, LF / CRLF / lone CR inside it (each read as one LF). Returns
  // {value, end, closed, lineDelta}; end is just past the closing quote
  // when closed, else the position the scan reached. lineDelta counts the
  // breaks inside the field and is only committed when it really closes:
  // on the unterminated fallback the re-read counts those breaks itself.
  // Rare path (the fast path below takes the common quoted field).
  function quotedSlow(start, recordLine, row) {
    void recordLine;
    void row;
    const parts = [];
    let segStart = start + 1;
    let pos = start + 1;
    let closed = false;
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
        if (text.charCodeAt(next + 1) === 34) {
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
        pos = text.charCodeAt(next + 1) === 10 ? next + 2 : next + 1;
        segStart = pos;
      }
    }
    const value = parts.length === 1 ? parts[0] : parts.join("");
    return { value, end: pos, closed, lineDelta };
  }

  // Quote junk: everything from p up to the next comma or line break,
  // appended as it stands; a lone CR in it is dropped (stray_cr). Returns
  // {value, end, hadJunk}. Rare path.
  function readJunk(base, p, recordLine, row) {
    let junkStart = p;
    let junkParts = null;
    let pos = p;
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
      if (kind === 3 && text.charCodeAt(next + 1) !== 10) {
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
    return { value: junk === "" ? base : base + junk, end: pos, hadJunk: junk !== "" };
  }

  while (i < n) {
    const c = text.charCodeAt(i);

    // A line left with no characters is no record: skip its terminator.
    if (c === 10) {
      // LF
      i += 1;
      line += 1;
      continue;
    }
    if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) {
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
    const row = header ? (recordIndex === 0 ? null : recordIndex - 1) : recordIndex;
    while (pendingStrays > 0) {
      errors.push({ code: "stray_cr", line: recordLine, row });
      pendingStrays -= 1;
    }

    const fields = [];

    // Parse fields until a line break or the end of the text ends the record.
    for (;;) {
      // Refresh the cursors: they must point at or after the field start.
      if (nextNL < i) {
        nextNL = text.indexOf("\n", i);
        if (nextNL === -1) nextNL = n;
      }
      if (nextCR < i) {
        nextCR = text.indexOf("\r", i);
        if (nextCR === -1) nextCR = n;
      }

      let value;
      let junkError = false;
      let unterminatedError = false;

      if (text.charCodeAt(i) === 34) {
        // '"' — a field that opens with a quote.
        const q2 = text.indexOf('"', i + 1);
        if (q2 !== -1 && text.charCodeAt(q2 + 1) !== 34 && nextNL >= q2 && nextCR >= q2) {
          // Fast path: one line, no doubled quote, no break inside.
          value = text.slice(i + 1, q2);
          i = q2 + 1;
          // Quote junk (shared step below): what follows the closing
          // quote, up to the next comma or line break, is appended.
          if (i < n) {
            const d = text.charCodeAt(i);
            if (d !== 44 && d !== 10 && !(d === 13 && text.charCodeAt(i + 1) === 10)) {
              const j = readJunk(value, i, recordLine, row);
              value = j.value;
              junkError = j.hadJunk;
              i = j.end;
            }
          }
        } else {
          const q = quotedSlow(i, recordLine, row);
          if (q.closed) {
            line += q.lineDelta;
            value = q.value;
            i = q.end;
            // Quote junk (shared step).
            if (i < n) {
              const d = text.charCodeAt(i);
              if (d !== 44 && d !== 10 && !(d === 13 && text.charCodeAt(i + 1) === 10)) {
                const j = readJunk(value, i, recordLine, row);
                value = j.value;
                junkError = j.hadJunk;
                i = j.end;
              }
            }
          } else {
            // The quote never closes: it is a literal character and the
            // text after it is read again as unquoted, from just after
            // the quote.
            unterminatedError = true;
            const r = readPlain(i + 1, recordLine, row);
            value = '"' + r.value;
            i = r.end;
          }
        }
      } else {
        // Plain field: one indexOf(',') plus comparisons. It ends at the
        // nearer of the next comma and nextNL; a stray CR inside it is
        // caught by nextCR (a CR that is the line's CRLF ending excepted).
        const comma = text.indexOf(",", i);
        const end = comma !== -1 && comma < nextNL ? comma : nextNL;
        if (nextCR < end && !(end < n && end === nextNL && nextCR === end - 1)) {
          value = slowPlain(i, end, recordLine, row);
        } else if (end < n && end === nextNL && end > i && text.charCodeAt(end - 1) === 13) {
          value = text.slice(i, end - 1); // CRLF ending: drop the CR
        } else {
          value = text.slice(i, end);
        }
        i = end;
      }

      if (junkError) errors.push({ code: "quote_junk", line: recordLine, row });
      if (unterminatedError) {
        errors.push({ code: "unterminated_quote", line: recordLine, row });
      }
      fields.push(value);

      // What ended the field decides what happens next.
      if (i >= n) break; // the record ends at the end of the text
      const d = text.charCodeAt(i);
      if (d === 44) {
        // ',' — another field follows (possibly an empty one at the end).
        i += 1;
        if (i >= n) {
          fields.push("");
          break;
        }
        const e = text.charCodeAt(i);
        if (e === 10) {
          fields.push("");
          i += 1;
          line += 1;
          break;
        }
        if (e === 13 && text.charCodeAt(i + 1) === 10) {
          fields.push("");
          i += 2;
          line += 1;
          break;
        }
        continue;
      }
      if (d === 10) {
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
    errors.push({ code: "stray_cr", line, row: header ? (recordIndex === 0 ? null : recordIndex - 1) : recordIndex });
    pendingStrays -= 1;
  }

  return { columns, rows, errors };
}
