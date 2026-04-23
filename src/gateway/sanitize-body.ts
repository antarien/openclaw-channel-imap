import type { InboundMessage } from "../parser/types.js";

export interface SanitizedBody {
  text: string;
  wasHtml: boolean;
  wasTruncated: boolean;
  urls: readonly string[];
  droppedScripts: number;
}

export interface SanitizeOptions {
  maxChars?: number;
  maxUrls?: number;
}

const DEFAULT_MAX_CHARS = 8000;
const DEFAULT_MAX_URLS = 20;

const SCRIPT_RE = /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi;
const STYLE_RE = /<style\b[^>]*>[\s\S]*?<\/style\s*>/gi;
const TAG_RE = /<[^>]+>/g;
const WS_RE = /\s+/g;
const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;

/**
 * Turn an InboundMessage into a plain-text body suitable for an LLM agent,
 * with a conservative series of transformations:
 *
 *  1. Prefer `text/plain` if present — HTML is the higher-risk path.
 *  2. For HTML, drop `<script>` / `<style>` blocks *with their content*
 *     before stripping remaining tags. The default `.replace(/<[^>]+>/g)`
 *     would turn `<script>alert(1)</script>` into the visible text
 *     `alert(1)`, preserving the attack payload.
 *  3. Extract URLs into a separate list so a downstream agent can decide
 *     whether to follow them, instead of inlining them into prose.
 *  4. Truncate to `maxChars` with an explicit marker. Mail-bombs land as
 *     20 MB HTML blobs; we do not ship them into the LLM context.
 */
export function sanitizeBody(
  inbound: InboundMessage,
  options: SanitizeOptions = {},
): SanitizedBody {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const maxUrls = options.maxUrls ?? DEFAULT_MAX_URLS;

  const plain = inbound.text?.trim();
  if (plain && plain.length > 0) {
    const urls = extractUrls(plain, maxUrls);
    const { text, wasTruncated } = truncate(plain, maxChars);
    return { text, wasHtml: false, wasTruncated, urls, droppedScripts: 0 };
  }

  if (inbound.html === false || typeof inbound.html !== "string") {
    return { text: "", wasHtml: false, wasTruncated: false, urls: [], droppedScripts: 0 };
  }

  const html = inbound.html;
  let droppedScripts = 0;
  let stripped = html.replace(SCRIPT_RE, () => {
    droppedScripts += 1;
    return " ";
  });
  stripped = stripped.replace(STYLE_RE, () => " ");
  const urls = extractUrls(stripped, maxUrls);
  stripped = stripped.replace(TAG_RE, " ").replace(WS_RE, " ").trim();
  const { text, wasTruncated } = truncate(stripped, maxChars);

  return { text, wasHtml: true, wasTruncated, urls, droppedScripts };
}

function extractUrls(source: string, max: number): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of source.matchAll(URL_RE)) {
    const url = match[0].replace(/[.,);\]]+$/, "");
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
    if (out.length >= max) break;
  }
  return out;
}

function truncate(text: string, max: number): { text: string; wasTruncated: boolean } {
  if (text.length <= max) return { text, wasTruncated: false };
  const marker = `\n\n[... truncated, original was ${text.length} chars ...]`;
  return { text: text.slice(0, max) + marker, wasTruncated: true };
}
