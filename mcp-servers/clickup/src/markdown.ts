// Markdown → ClickUp rich comment parts (Quill-style delta): inline
// runs carry {bold|italic|code|strike|link} attributes, and each block
// ends with a "\n" run whose attributes say what the line was (header,
// list, code-block, blockquote). v2 comment endpoints render
// comment_text literally, so this is what makes **bold** or a
// [@Name](#user_mention#123) mention actually show up formatted.

type Part = { text: string; attributes?: Record<string, unknown>; type?: string; user?: { id: number } };

const INLINE =
  /`([^`]+)`|\[@([^\]]*)\]\(#user_mention#(\d+)\)|\[([^\]]+)\]\(([^)\s]+)\)|\*\*(.+?)\*\*|__(.+?)__|~~(.+?)~~|\*([^*\s](?:[^*]*[^*\s])?)\*|(?<![\w])_([^_\s](?:[^_]*[^_\s])?)_(?![\w])/g;

function inline(s: string, out: Part[], attrs: Record<string, unknown> = {}) {
  const run = (text: string, extra: Record<string, unknown> = {}) => {
    if (!text) return;
    const a = { ...attrs, ...extra };
    out.push(Object.keys(a).length ? { text, attributes: a } : { text });
  };
  let last = 0;
  for (const m of s.matchAll(INLINE)) {
    run(s.slice(last, m.index));
    last = m.index! + m[0].length;
    const [, code, mName, mId, lText, lHref, b1, b2, strike, i1, i2] = m;
    if (code !== undefined) run(code, { code: true });
    else if (mId !== undefined) out.push({ text: `@${mName}`, type: "tag", user: { id: Number(mId) } });
    else if (lText !== undefined) run(lText, { link: lHref });
    else if (b1 ?? b2) inline(b1 ?? b2, out, { ...attrs, bold: true });
    else if (strike !== undefined) inline(strike, out, { ...attrs, strike: true });
    else inline(i1 ?? i2, out, { ...attrs, italic: true });
  }
  run(s.slice(last));
}

const eol = (attributes?: Record<string, unknown>): Part => (attributes ? { text: "\n", attributes } : { text: "\n" });

export function markdownToParts(md: string): Part[] {
  const out: Part[] = [];
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) {
        if (lines[i]) out.push({ text: lines[i] });
        out.push(eol({ "code-block": true }));
      }
      continue;
    }
    let m: RegExpExecArray | null;
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
      inline(m[2], out);
      out.push(eol({ header: m[1].length }));
    } else if ((m = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line))) {
      inline(m[2], out);
      out.push(eol({ list: m[1] === " " ? "unchecked" : "checked" }));
    } else if ((m = /^\s*[-*+]\s+(.*)$/.exec(line))) {
      inline(m[1], out);
      out.push(eol({ list: "bullet" }));
    } else if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) {
      inline(m[1], out);
      out.push(eol({ list: "ordered" }));
    } else if ((m = /^>\s?(.*)$/.exec(line))) {
      inline(m[1], out);
      out.push(eol({ blockquote: true }));
    } else if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      out.push({ text: "---" }, eol());
    } else {
      inline(line, out);
      out.push(eol());
    }
  }
  while (out.length && out[out.length - 1].text === "\n" && !out[out.length - 1].attributes) out.pop();
  return out;
}

const BLOCK_PREFIX = (a: Record<string, any>): string => {
  if (a.header) return `${"#".repeat(Number(a.header))} `;
  if (a["code-block"]) return "    ";
  if (a.blockquote) return "> ";
  const l = typeof a.list === "object" ? a.list?.list : a.list;
  return l === "bullet" ? "- " : l === "ordered" ? "1. " : l === "checked" ? "[x] " : l === "unchecked" ? "[ ] " : "";
};

// partsToMarkdown is the reverse, for reading comments back: ClickUp's
// own comment_text drops mentions and all formatting.
export function partsToMarkdown(parts: Part[]): string {
  const lines: string[] = [];
  let cur = "";
  for (const p of parts) {
    const a = (p.attributes ?? {}) as Record<string, any>;
    if (p.type === "tag") cur += p.text || `@${(p.user as any)?.username ?? p.user?.id}`;
    else if (p.text === "\n" || p.text.includes("\n")) {
      const chunks = p.text.split("\n");
      for (let k = 0; k < chunks.length - 1; k++) {
        cur += chunks[k];
        lines.push(BLOCK_PREFIX(a) + cur);
        cur = "";
      }
      cur += chunks[chunks.length - 1];
    } else if (a.link) cur += `[${p.text}](${a.link})`;
    else if (a.code) cur += `\`${p.text}\``;
    else if (a.bold) cur += `**${p.text}**`;
    else if (a.italic) cur += `_${p.text}_`;
    else cur += p.text;
  }
  if (cur) lines.push(cur);
  return lines.join("\n").trim();
}

// hasFormatting says whether sending parts is worth it over plain text.
export function hasFormatting(parts: Part[]): boolean {
  return parts.some((p) => p.type === "tag" || p.attributes);
}
