/**
 * A minimal, allocation-conscious CSV reader for GTFS text files.
 *
 * GTFS is RFC4180-ish: comma separated, optional double quotes, doubled quotes
 * for escaping. Files are small in field count but very large in row count
 * (stop_times.txt runs to millions of lines), so this parses straight out of a
 * string with an index cursor and only materialises the fields a caller asks
 * for. A general-purpose CSV library costs several times more here.
 */

export type Row = Record<string, string>;

/** Strips a UTF-8 BOM, which several agencies emit at the head of each file. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Parses one CSV record starting at `start`.
 *
 * Appends field values to `out` and returns the index just past the record's
 * line terminator (or the text length at EOF). `out` is reused across rows by
 * the caller so the parse does not allocate an array per line.
 */
function readRecord(text: string, start: number, out: string[]): number {
  out.length = 0;
  const len = text.length;
  let i = start;

  while (i <= len) {
    if (i === len) {
      out.push('');
      return len;
    }

    let value: string;

    if (text.charCodeAt(i) === 34 /* " */) {
      // Quoted field: scan for the closing quote, unescaping doubled quotes.
      i++;
      let chunkStart = i;
      let buf = '';
      for (;;) {
        const q = text.indexOf('"', i);
        if (q === -1) {
          // Unterminated quote — take the rest of the file rather than throwing.
          buf += text.slice(chunkStart);
          i = len;
          break;
        }
        if (text.charCodeAt(q + 1) === 34) {
          buf += text.slice(chunkStart, q + 1); // keep one of the two quotes
          i = q + 2;
          chunkStart = i;
          continue;
        }
        buf += text.slice(chunkStart, q);
        i = q + 1;
        break;
      }
      value = buf;
    } else {
      // Unquoted field: runs to the next comma or line terminator.
      let j = i;
      while (j < len) {
        const c = text.charCodeAt(j);
        if (c === 44 /* , */ || c === 10 /* \n */ || c === 13 /* \r */) break;
        j++;
      }
      value = text.slice(i, j);
      i = j;
    }

    out.push(value);

    if (i >= len) return len;
    const c = text.charCodeAt(i);
    if (c === 44) {
      i++;
      continue;
    }
    if (c === 13) i++; // CR of a CRLF pair
    if (text.charCodeAt(i) === 10) i++;
    return i;
  }
  return len;
}

/**
 * Streams rows of a GTFS CSV file to `visit`, reusing one object per row.
 *
 * The row object handed to `visit` is **reused between calls** — copy anything
 * you need to keep. This keeps a multi-million-row pass out of the GC's way.
 */
export function forEachRow(text: string, visit: (row: Row) => void): void {
  const body = stripBom(text);
  if (body.length === 0) return;

  const fields: string[] = [];
  let cursor = readRecord(body, 0, fields);
  const header = fields.slice().map((h) => h.trim());
  if (header.length === 0) return;

  const row: Row = {};
  const len = body.length;

  while (cursor < len) {
    cursor = readRecord(body, cursor, fields);
    // A trailing newline yields a single empty field; skip those.
    if (fields.length === 1 && fields[0] === '') continue;
    for (let c = 0; c < header.length; c++) {
      row[header[c]] = c < fields.length ? fields[c] : '';
    }
    visit(row);
  }
}

/** Collects every row into an array. Only use on the small GTFS files. */
export function parseCsv(text: string): Row[] {
  const rows: Row[] = [];
  forEachRow(text, (row) => rows.push({ ...row }));
  return rows;
}

/**
 * Parses a GTFS `HH:MM:SS` time into seconds after midnight.
 *
 * Hours past 24 are legal and meaningful in GTFS: they denote trips that run
 * past midnight but still belong to the previous service day, which is exactly
 * how late-night routes are encoded. Returns -1 for blank/invalid input.
 */
export function parseGtfsTime(value: string): number {
  if (!value) return -1;
  let h = 0;
  let m = 0;
  let s = 0;
  let part = 0;
  let acc = 0;
  let seen = false;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 48 && c <= 57) {
      acc = acc * 10 + (c - 48);
      seen = true;
    } else if (c === 58 /* : */) {
      if (part === 0) h = acc;
      else if (part === 1) m = acc;
      part++;
      acc = 0;
    }
  }
  if (!seen) return -1;
  if (part === 2) s = acc;
  else if (part === 1) m = acc;
  else h = acc;
  return h * 3600 + m * 60 + s;
}

/** Formats seconds-after-midnight back to `HH:MM:SS`, keeping hours >= 24. */
export function formatGtfsTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}
