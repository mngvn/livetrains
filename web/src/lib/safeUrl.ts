/**
 * Links and images whose address came from someone else's data.
 *
 * Several of the app's links are not written by the app: an alert's "more
 * information" page and an operator's website come from the agency's feeds,
 * and an aircraft photo from a crowd-sourced database. Any of them could
 * hold a `javascript:` or `data:` address — by mistake, or because a feed
 * was tampered with — and an address like that in an `href` runs code in
 * this page when tapped. So they are only used when they are plainly web
 * addresses, and dropped otherwise.
 */

/**
 * The address as a normalised http(s) URL, or null when it is anything else.
 *
 * `upgrade` turns plain http into https, as browsers do for images on a
 * secure page anyway, so an image is never fetched in the clear.
 */
export function safeWebUrl(value: string | null | undefined, { upgrade = false } = {}): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol === 'https:') return url.href;
  if (url.protocol !== 'http:') return null;
  if (upgrade) url.protocol = 'https:';
  return url.href;
}

/** "metrotransit.org", for showing where a link goes. */
export function linkHost(href: string): string {
  try {
    return new URL(href).hostname.replace(/^www\./, '');
  } catch {
    return href;
  }
}

/** Text made safe to place in HTML, for the few places MapLibre takes markup. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
