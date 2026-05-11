"use client";

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { visit } from "unist-util-visit";
import type { Root, Paragraph, RootContent, PhrasingContent } from "mdast";
import "highlight.js/styles/github-dark.css";
import { CodeBlock } from "./code-block";
import { MermaidBlock } from "./mermaid-block";

interface Props {
  source: string;
}

// Markdown is the renderer used by AssistantBubble for any text block.
// It supports GFM (tables, task lists, strikethrough), code blocks with
// syntax highlighting via highlight.js, ```mermaid fences via the
// MermaidBlock component, and a small remark pass that promotes ASCII-art
// paragraphs into fenced code blocks so box-drawing diagrams render in
// monospace instead of a broken proportional-font heap.
export function Markdown({ source }: Props) {
  return (
    <div className="prose-chat">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkAsciiArtToCode]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={components}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}

// Pulled out so the components object is not reallocated on every render.
const components: Components = {
  pre({ node, children }) {
    // react-markdown renders fenced code as <pre><code class="language-x">...</code></pre>.
    // We dig into the AST to read the language class + the raw source text,
    // then replace the whole pre with either CodeBlock or MermaidBlock.
    const codeNode = node?.children?.[0];
    if (
      !codeNode ||
      codeNode.type !== "element" ||
      codeNode.tagName !== "code"
    ) {
      return <pre>{children}</pre>;
    }
    const classes = (codeNode.properties?.className ?? []) as string[];
    const langClass = classes.find((c) => c.startsWith("language-"));
    const language = langClass ? langClass.slice("language-".length) : undefined;
    const source = extractText(codeNode);

    if (language === "mermaid") {
      return <MermaidBlock source={source.trim()} />;
    }

    // plaintext / text blocks bypass the syntax-highlighted JSX entirely.
    // Our ASCII-art promoter tags into this branch (lang: "plaintext"),
    // but user-written ```text fences also benefit: any inner
    // <span class="hljs-*"> wrappers would inherit whatever font-weight
    // the theme assigns and visibly break monospace alignment on
    // box-drawing diagrams. Rendering the raw source ensures pure
    // monospace.
    if (language === "plaintext" || language === "text") {
      return (
        <CodeBlock language={language} source={source}>
          <code>{source}</code>
        </CodeBlock>
      );
    }

    // children is the highlighted JSX rehype-highlight produced (a <code>
    // element with span children). Hand it to CodeBlock unchanged so we
    // keep token colors.
    return (
      <CodeBlock language={language} source={source}>
        {children}
      </CodeBlock>
    );
  },
  code({ className, children, ...props }) {
    // react-markdown calls this for both inline `code` and the inner
    // <code> of a fenced ```block```. After rehype-highlight runs on the
    // fenced one, className becomes "hljs language-x" - earlier we only
    // checked for `language-` prefix, missed the rehype-prefixed string,
    // and applied inline `bg-muted` to the <code>. Since <code> is inline,
    // its background paints under each text run separately - that's why
    // multi-line code blocks rendered with a light strip per line.
    //
    // Inline code never has a className from react-markdown, so the
    // presence of any className signals a fenced block: pass it through.
    if (className) {
      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    }
    return (
      <code
        className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]"
        {...props}
      >
        {children}
      </code>
    );
  },
  // Tables: the heavy styling lives in globals.css under `.prose-chat
  // table` so the rules can use CSS variables for theme-aware colors.
  // Here we only wire the wrapper (overflow + border + rounded corners
  // for narrow viewports) and pass children through to a real
  // <table>/<thead>/<tbody>/<tr>/<th>/<td> tree. Returning a wrapping div
  // also keeps wide tables from blowing the bubble out horizontally.
  table({ children }) {
    return (
      <div className="my-3 overflow-x-auto rounded-lg border bg-card shadow-sm">
        <table className="w-full">{children}</table>
      </div>
    );
  },
  thead({ children }) {
    return <thead>{children}</thead>;
  },
  tbody({ children }) {
    return <tbody>{children}</tbody>;
  },
  tr({ children }) {
    return <tr>{children}</tr>;
  },
  th({ children, style }) {
    // GFM emits text-align via inline `style` for `:---:` etc. We forward
    // it so column alignment hints from the source render correctly.
    return <th style={style}>{children}</th>;
  },
  td({ children, style }) {
    return <td style={style}>{children}</td>;
  },
  a({ children, href }) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="text-primary underline underline-offset-2 hover:text-primary/80"
      >
        {children}
      </a>
    );
  },
};

// extractText walks an HAST element tree and concatenates raw text. Used
// to recover the un-highlighted source for the clipboard / mermaid input.
type HastNode = {
  type: string;
  value?: string;
  children?: HastNode[];
};

function extractText(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  if (!node.children) return "";
  return node.children.map(extractText).join("");
}

// ── ASCII-art → fenced code promotion ────────────────────────────────
//
// Claude likes to draw tree views, box diagrams, and tables using
// box-drawing characters (U+2500–U+259F) directly in prose, without
// wrapping them in a code fence. CommonMark collapses soft line breaks
// inside a paragraph to a single space, and the default sans-serif font
// has variable-width glyphs — together they reduce a clean diagram to
// an unaligned blob.
//
// This remark pass walks paragraphs and, when their text looks like
// monospace-only content (multi-line with box-drawing chars, or
// multi-line with structural multi-space alignment), replaces the
// paragraph with a fenced code node. The existing CodeBlock renderer
// then takes over: monospace font, preserved whitespace, horizontal
// scroll on overflow.
//
// We deliberately skip single-line paragraphs to avoid breaking inline
// references like "Use the └─ pattern here." — those are conversational
// uses, not art.
const BOX_DRAWING_LINE = /[─-▟]/;
const ALIGNED_SPACES = /\S {2,}\S/;
const ASCII_BOX_LINE = /[─│┌┐└┘├┤┬┴┼╔╗╚╝═║╠╣╦╩╬]|[+\-=|]{3,}/;

function looksLikeAsciiArt(text: string): boolean {
  const lines = text.split("\n");
  if (lines.length < 2) return false;
  const hasBoxLine = lines.some(
    (l) => BOX_DRAWING_LINE.test(l) || ASCII_BOX_LINE.test(l),
  );
  if (hasBoxLine) return true;
  // Fallback heuristic: lots of lines with internal multi-space alignment
  // (column-aligned tables, indented diagrams without fancy glyphs).
  // We need at least half the lines to look aligned to avoid converting
  // ordinary prose that happens to have a stray double-space.
  let aligned = 0;
  for (const line of lines) {
    if (ALIGNED_SPACES.test(line)) aligned++;
  }
  return aligned >= 2 && aligned * 2 >= lines.length;
}

function paragraphText(p: Paragraph): string {
  return p.children.map(phrasingToString).join("");
}

function phrasingToString(node: PhrasingContent): string {
  // mdast text + inlineCode nodes both carry `.value`. break nodes
  // (hard line breaks) reify as `\n` so we don't lose the visual line
  // count. Anything else (emphasis, links, etc.) recurses through its
  // children. Image alt text is irrelevant for our heuristic.
  switch (node.type) {
    case "text":
    case "inlineCode":
      return node.value;
    case "break":
      return "\n";
    case "emphasis":
    case "strong":
    case "delete":
    case "link":
    case "linkReference":
      return node.children.map(phrasingToString).join("");
    default:
      return "";
  }
}

function remarkAsciiArtToCode() {
  return (tree: Root) => {
    visit(tree, "paragraph", (node, index, parent) => {
      if (!parent || index === undefined) return;
      const text = paragraphText(node as Paragraph);
      if (!looksLikeAsciiArt(text)) return;
      const code: RootContent = {
        type: "code",
        // "plaintext" is highlight.js's no-op language: hljs returns the
        // input unchanged, no inner <span class="hljs-*"> wrappers. This
        // matters because hljs-section (and others) apply font-weight:
        // bold, and a bold glyph in a "monospace" font is often a hair
        // wider than the regular weight — enough to wobble the right
        // wall of a box-drawing diagram by a pixel or two per line.
        lang: "plaintext",
        value: text,
      };
      // Replace the paragraph in-place so position-dependent siblings
      // (headings, lists) stay aligned with the surrounding content.
      (parent.children as RootContent[]).splice(index, 1, code);
    });
  };
}
