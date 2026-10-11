/**
 * Small, dependency-free CSV/TSV parser shared by the server and the browser UI.
 *
 * Handles quoted fields, escaped quotes (""), embedded newlines and commas,
 * CRLF line endings, and comma / semicolon / tab separators.
 */

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const HEADER_NAME = /^(full\s*)?name$/i;
const HEADER_FIRST = /^(first|given)\s*name$/i;
const HEADER_LAST = /^(last|sur|family)\s*name$/i;
const HEADER_EMAIL = /^(e[-_\s]?mail|email\s*address|mail)$/i;
const HEADER_COMPANY = /^(company|organi[sz]ation|org|business|employer)$/i;
const HEADER_TAGS = /^(tags?|labels?|groups?|lists?)$/i;

function detectDelimiter(sample) {
  const candidates = [',', ';', '\t', '|'];
  let best = ',';
  let bestCount = -1;
  const firstLine = String(sample).split(/\r?\n/)[0] ?? '';
  for (const candidate of candidates) {
    const count = firstLine.split(candidate).length - 1;
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

export function isEmail(value) {
  return EMAIL_RE.test(String(value ?? '').trim());
}

/** Parse raw delimited text into an array of row arrays. */
export function parseDelimited(text, delimiter) {
  const input = String(text ?? '').replace(/^\uFEFF/, '');
  const delim = delimiter ?? detectDelimiter(input);

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];

    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && field === '') {
      inQuotes = true;
      continue;
    }
    if (char === delim) {
      row.push(field);
      field = '';
      continue;
    }
    if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    if (char === '\r') continue;

    field += char;
  }

  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((cell) => String(cell).trim() !== ''));
}

function indexPath(headers) {
  const map = { name: -1, firstName: -1, lastName: -1, email: -1, company: -1, tags: -1 };
  headers.forEach((raw, index) => {
    const header = String(raw ?? '').trim();
    if (!header) return;
    if (map.email === -1 && HEADER_EMAIL.test(header)) map.email = index;
    else if (map.firstName === -1 && HEADER_FIRST.test(header)) map.firstName = index;
    else if (map.lastName === -1 && HEADER_LAST.test(header)) map.lastName = index;
    else if (map.name === -1 && HEADER_NAME.test(header)) map.name = index;
    else if (map.company === -1 && HEADER_COMPANY.test(header)) map.company = index;
    else if (map.tags === -1 && HEADER_TAGS.test(header)) map.tags = index;
  });
  return map;
}

/**
 * Convert parsed rows into contact objects.
 *
 * Accepts a header row in any column order; when no header is recognised the
 * layout is inferred from the data (an email-looking column plus a name column).
 */
export function rowsToContacts(rows) {
  if (!rows.length) return { contacts: [], skipped: [], columns: null };

  const header = rows[0].map((cell) => String(cell ?? '').trim());
  const hasHeader = header.some((h) => HEADER_EMAIL.test(h) || HEADER_NAME.test(h));
  const dataRows = hasHeader ? rows.slice(1) : rows;

  const idx = hasHeader ? indexPath(header) : inferIndex(dataRows);
  const columns = hasHeader
    ? header
    : ['name', 'email', 'company', 'tags'].filter((key) => idx[key] >= 0);

  const contacts = [];
  const skipped = [];

  dataRows.forEach((row, rowNumber) => {
    const cell = (index) => (index >= 0 ? String(row[index] ?? '').trim() : '');
    const email = cell(idx.email);

    if (!email) {
      skipped.push({ line: rowNumber + (hasHeader ? 2 : 1), reason: 'No email address', raw: row.join(', ') });
      return;
    }
    if (!isEmail(email)) {
      skipped.push({ line: rowNumber + (hasHeader ? 2 : 1), reason: `Invalid email "${email}"`, raw: row.join(', ') });
      return;
    }

    let name = cell(idx.name);
    if (!name) {
      name = [cell(idx.firstName), cell(idx.lastName)].filter(Boolean).join(' ');
    }

    contacts.push({
      name,
      email,
      company: cell(idx.company),
      tags: cell(idx.tags)
        .split(/[,;|]/)
        .map((t) => t.trim())
        .filter(Boolean),
    });
  });

  return { contacts, skipped, columns, hadHeader: hasHeader };
}

function inferIndex(dataRows) {
  const width = Math.max(...dataRows.map((r) => r.length), 0);
  const idx = { name: -1, firstName: -1, lastName: -1, email: -1, company: -1, tags: -1 };

  for (let col = 0; col < width; col += 1) {
    const values = dataRows.map((r) => String(r[col] ?? '').trim()).filter(Boolean);
    if (!values.length) continue;
    const emailish = values.filter(isEmail).length / values.length;
    if (emailish > 0.5 && idx.email === -1) {
      idx.email = col;
      continue;
    }
    // The first non-email column with mostly words becomes the name.
    if (idx.name === -1 && values.every((v) => !isEmail(v))) idx.name = col;
  }

  if (idx.email === -1 && width > 0) {
    // Last resort: the column with the most "@" characters.
    let best = 0;
    let bestScore = -1;
    for (let col = 0; col < width; col += 1) {
      const score = dataRows.reduce((acc, r) => acc + (String(r[col] ?? '').includes('@') ? 1 : 0), 0);
      if (score > bestScore) {
        bestScore = score;
        best = col;
      }
    }
    idx.email = best;
  }

  return idx;
}

/** Convenience: text straight to contacts. */
export function parseContacts(text) {
  return rowsToContacts(parseDelimited(text));
}

/** Build a CSV string (used for the history/contacts export endpoints). */
export function toCsv(rows, columns) {
  const cols = columns ?? Object.keys(rows[0] ?? {});
  const escape = (value) => {
    const str = value === null || value === undefined ? '' : String(value);
    return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const lines = [cols.map(escape).join(',')];
  for (const row of rows) {
    lines.push(cols.map((col) => escape(row[col])).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}
