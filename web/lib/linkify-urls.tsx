// linkifyUrls splits a blob of text into alternating text/anchor
// React nodes — anchors point at whatever http(s) URLs it finds.
//
// Motivation: MCP tool results are rendered as a raw <pre> dump of
// the JSON the upstream server returned. Useful task identifiers
// (e.g. ClickUp's "url": "https://app.clickup.com/t/<id>", GitHub's
// html_url, Slack permalinks) are *in* that JSON but inert — copy-
// paste only. Detecting URLs and wrapping them as <a target="_blank">
// makes "click the task to open it in ClickUp" work without needing
// per-service custom result cards.
//
// Why not let remark-gfm do it: gfm only runs on the Markdown render
// path used for assistant text. Tool-result JSON is rendered as raw
// text in a <pre>, so it never goes through the markdown pipeline.

import { Fragment, type ReactNode } from "react";

// URL_RE matches http(s) URLs, stopping at whitespace, quotes, angle
// brackets, or the JSON close-paren / close-brace that typically
// follow a `"url": "..."` value. The trailing-punct trim below
// further strips a closing paren/period/comma that may have ended up
// inside the match (e.g. "see (https://foo.com).").
const URL_RE = /https?:\/\/[^\s"'<>{}]+/g;
const TRAILING_PUNCT = /[.,;:!?)\]]+$/;

// Returns a stable React fragment so callers can drop it inline into
// a <pre> (preserving whitespace) without breaking the surrounding
// monospace layout.
export function linkifyUrls(text: string): ReactNode {
  if (!text) return text;
  // Cheap pre-check — avoid running the regex if there's no scheme.
  if (text.indexOf("http") < 0) return text;

  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;

  // Use a fresh RegExp each call so concurrent renders don't share
  // lastIndex state on the module-level instance.
  const re = new RegExp(URL_RE.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const start = match.index;
    let url = match[0];
    let end = start + url.length;

    // Strip trailing punctuation that's almost certainly *not* part
    // of the URL — "(https://foo.com)." → match was including the
    // ")." which would 404. The stripped chars are pushed back into
    // the following text segment so the user still sees them.
    const trailing = url.match(TRAILING_PUNCT);
    if (trailing) {
      url = url.slice(0, url.length - trailing[0].length);
      end = start + url.length;
    }

    if (start > lastIndex) {
      parts.push(
        <Fragment key={`t-${key++}`}>{text.slice(lastIndex, start)}</Fragment>,
      );
    }
    parts.push(
      <a
        key={`a-${key++}`}
        href={url}
        target="_blank"
        rel="noreferrer"
        className="text-primary underline underline-offset-2 hover:text-primary/80"
      >
        {url}
      </a>,
    );
    lastIndex = end;
  }

  if (lastIndex === 0) return text;
  if (lastIndex < text.length) {
    parts.push(<Fragment key={`t-${key++}`}>{text.slice(lastIndex)}</Fragment>);
  }
  return parts;
}
