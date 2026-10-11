/**
 * Browser-side CSV/TSV parsing for contact import.
 * Mirrors server/csv.js so imports can be previewed before anything is uploaded.
 */

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

const HEADER_NAME = /^(full\s*)?name$/i;
const HEADER_FIRST = /^(first|given)\s*name$/i;
const HEADER_LAST = /^(last|sur|family)\s*name$/i;
const HEADER_EMAIL = /^(e[-_\s]?mail|email\s*address|mail)$/i;
const HEADER_COMPANY = /^(company|organi[sz]ation|org|business|employer)$/i;
const HEADER_TAGS = /^(tags?|labels?|groups?|lists?)$/i;

export const isEmail = (value) => EMAIL_RE.test(String(value ?? '').trim());

function detectDelimiter(sample) {
  const firstLine = String(sample).split(/\r?\n/)[0] ?? '';
  let best = ',';
  let bestCount = -1;
  for (const candidate of [',', ';', '\t', '|']) {
    const count = firstLine.split(candidate).length - 1;
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

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
        } else inQuotes = false;
      } else field += char;
      continue;
    }

    if (char === '"' && field === '') {
      inQuotes = true;
    } else if (char === delim) {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
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

function inferIndex(dataRows) {
  const width = Math.max(0, ...dataRows.map((r) => r.length));
  const idx = { name: -1, firstName: -1, lastName: -1, email: -1, company: -1, tags: -1 };

  for (let col = 0; col < width; col += 1) {
    const values = dataRows.map((r) => String(r[col] ?? '').trim()).filter(Boolean);
    if (!values.length) continue;
    if (idx.email === -1 && values.filter(isEmail).length / values.length > 0.5) {
      idx.email = col;
      continue;
    }
    if (idx.name === -1 && values.every((v) => !isEmail(v))) idx.name = col;
  }

  if (idx.email === -1 && width) {
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

export function rowsToContacts(rows) {
  if (!rows.length) return { contacts: [], skipped: [], columns: [], hadHeader: false };

  const header = rows[0].map((cell) => String(cell ?? '').trim());
  const hasHeader = header.some((h) => HEADER_EMAIL.test(h) || HEADER_NAME.test(h));
  const dataRows = hasHeader ? rows.slice(1) : rows;
  const idx = hasHeader ? indexPath(header) : inferIndex(dataRows);

  const contacts = [];
  const skipped = [];

  dataRows.forEach((row, rowNumber) => {
    const cell = (index) => (index >= 0 ? String(row[index] ?? '').trim() : '');
    const email = cell(idx.email);
    const line = rowNumber + (hasHeader ? 2 : 1);

    if (!email) {
      skipped.push({ line, reason: 'No email address', raw: row.join(', ') });
      return;
    }
    if (!isEmail(email)) {
      skipped.push({ line, reason: `Invalid email "${email}"`, raw: row.join(', ') });
      return;
    }

    let name = cell(idx.name);
    if (!name) name = [cell(idx.firstName), cell(idx.lastName)].filter(Boolean).join(' ');

    contacts.push({
      name,
      email,
      company: cell(idx.company),
      tags: cell(idx.tags).split(/[,;|]/).map((t) => t.trim()).filter(Boolean),
    });
  });

  return {
    contacts,
    skipped,
    columns: hasHeader ? header : ['name', 'email', 'company', 'tags'],
    hadHeader: hasHeader,
  };
}

export function parseContacts(text) {
  return rowsToContacts(parseDelimited(text));
}
