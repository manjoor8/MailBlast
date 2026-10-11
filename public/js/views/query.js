/* Page-level constants and pure query builders, kept free of DOM access so
   they can be unit tested directly. */

export const PAGE_SIZE = 25;
export const CONTACT_PAGE_SIZE = 25;

/**
 * Build the query string for the sent-history endpoints.
 * Mirrors server/routes.js:historyQuery so the UI and API agree on filters.
 */
export function historyParams({
  q = '',
  status = 'all',
  campaignId = '',
  from = '',
  to = '',
  order = 'newest',
  limit = PAGE_SIZE,
  offset = 0,
} = {}) {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
    order: order === 'oldest' ? 'oldest' : 'newest',
  });
  if (q) params.set('q', q);
  if (status && status !== 'all') params.set('status', status);
  if (campaignId) params.set('campaignId', String(campaignId));
  if (from) params.set('from', `${from}T00:00:00.000Z`);
  if (to) params.set('to', to);
  return params;
}

/** Build the query string for the contacts list endpoint. */
export function contactParams({ q = '', tag = '', sort = 'name', limit = CONTACT_PAGE_SIZE, offset = 0 } = {}) {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
    sort: sort === 'created' ? 'created' : 'name',
  });
  if (q) params.set('q', q);
  if (tag) params.set('tag', tag);
  return params;
}

/** 1-based page number for a given offset. */
export function pageNumber(offset, limit) {
  return Math.floor(offset / limit) + 1;
}

export function pageCount(total, limit) {
  return Math.max(1, Math.ceil(total / limit));
}

/** Inclusive 1-based range of the rows currently shown. */
export function visibleRange(offset, limit, total) {
  if (!total) return { first: 0, last: 0 };
  return { first: offset + 1, last: Math.min(offset + limit, total) };
}
