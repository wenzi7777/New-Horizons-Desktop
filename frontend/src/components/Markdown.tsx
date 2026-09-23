import { type ReactNode } from "react";

/*
 * A deliberately small Markdown renderer for app READMEs.
 *
 * READMEs are fetched from the library repo, so they are untrusted: this
 * builds React elements only -- no innerHTML -- and a link is live only when
 * it is an absolute http(s) URL. Relative links point into the repo tree and
 * mean nothing here, so they render as plain text.
 *
 * Supported: #/##/### headings, paragraphs, - * and 1. lists, fenced code,
 * `code`, **bold**, *italic* and [text](url).
 */

const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*|\[[^\]]+\]\([^)\s]+\))/g;

function inline(text: string, keyPrefix: string): ReactNode[] {
  return text.split(INLINE).filter(Boolean).map((part, index) => {
    const key = `${keyPrefix}-${index}`;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={key}>{part.slice(1, -1)}</code>;
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={key}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) return <em key={key}>{part.slice(1, -1)}</em>;
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
    if (link) {
      const [, label, href] = link;
      return /^https?:\/\//i.test(href)
        ? <a key={key} href={href} target="_blank" rel="noreferrer noopener">{inline(label, key)}</a>
        : <span key={key}>{inline(label, key)}</span>;
    }
    return part;
  });
}

export function Markdown({ source }: { source: string }) {
  const blocks: ReactNode[] = [];
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length) {
      const key = `p${blocks.length}`;
      blocks.push(<p key={key}>{inline(paragraph.join(" "), key)}</p>);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      const key = `l${blocks.length}`;
      const items = list.items.map((item, index) => <li key={index}>{inline(item, `${key}-${index}`)}</li>);
      blocks.push(list.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>);
      list = null;
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith("```")) {
      flushParagraph();
      flushList();
      const code: string[] = [];
      for (i += 1; i < lines.length && !lines[i].startsWith("```"); i += 1) code.push(lines[i]);
      blocks.push(<pre key={`c${blocks.length}`}><code>{code.join("\n")}</code></pre>);
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const key = `h${blocks.length}`;
      const content = inline(heading[2], key);
      const level = heading[1].length;
      blocks.push(level === 1 ? <h4 key={key}>{content}</h4>
        : level === 2 ? <h5 key={key}>{content}</h5> : <h6 key={key}>{content}</h6>);
      continue;
    }
    const item = /^\s*(?:([-*])|(\d+)\.)\s+(.*)$/.exec(line);
    if (item) {
      flushParagraph();
      const ordered = Boolean(item[2]);
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push(item[3]);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    flushList();
    paragraph.push(line.trim());
  }
  flushParagraph();
  flushList();

  return <div className="markdown">{blocks}</div>;
}
