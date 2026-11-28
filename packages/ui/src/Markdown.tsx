import { useMemo, type CSSProperties, type ReactNode, type Ref } from "react";
import { OutLink } from "./Linked.tsx";
import { highlight } from "./highlight.ts";
import { t } from "./i18n/index.ts";
import { CopyButton } from "./shell/CopyButton.tsx";
import { inboxReadingBlocks, parseMarkdown, type Block, type Inline } from "./markdown.ts";
import "./markdown.css";

function inline(nodes: Inline[]): ReactNode[] {
  return nodes.map((node, key) => {
    if (typeof node === "string") return node;
    switch (node.kind) {
      case "strong": return <strong key={key}>{inline(node.children)}</strong>;
      case "em": return <em key={key}>{inline(node.children)}</em>;
      case "del": return <del key={key}>{inline(node.children)}</del>;
      case "code": return <code key={key}>{node.text}</code>;
      case "link": return <OutLink key={key} href={node.url}>{inline(node.children)}</OutLink>;
      case "break": return <br key={key} />;
    }
  });
}

/** A fenced block: what language it is and a copy button above it, the code coloured (highlight.ts). */
function CodeBlock({ text, lang }: { text: string; lang?: string }) {
  const tokens = useMemo(() => highlight(text, lang), [text, lang]);
  return (
    <div className="md-code-block">
      <div className="md-code-head">
        <span className="md-code-lang">{lang ?? ""}</span>
        <CopyButton text={() => text} label={t("md.copyCode")} showLabel />
      </div>
      <pre className="md-code" data-lang={lang || undefined}>
        <code>{tokens.map((token, index) => token.kind === "plain" ? token.text : <span key={index} className={`tok-${token.kind}`}>{token.text}</span>)}</code>
      </pre>
    </div>
  );
}

function blocks(list: Block[], tight = false): ReactNode[] {
  return list.map((block, key) => {
    switch (block.kind) {
      // In a list written without blank lines, an item's own line is the item, not a paragraph in it.
      case "p": return tight && key === 0 ? <span key={key}>{inline(block.children)}</span> : <p key={key}>{inline(block.children)}</p>;
      // The page has its own h1 and h2; a reply's headings sit under them. Their size follows what was written.
      case "heading": {
        const Tag = `h${Math.min(6, block.level + 2)}` as "h3" | "h4" | "h5" | "h6";
        return <Tag key={key} className="md-h" data-level={block.level}>{inline(block.children)}</Tag>;
      }
      case "code": return <CodeBlock key={key} text={block.text} lang={block.lang} />;
      case "quote": return <blockquote key={key}>{blocks(block.blocks)}</blockquote>;
      case "list": {
        const items = block.items.map((item, index) => (
          <li key={index} data-task={item.checked === undefined ? undefined : item.checked ? "done" : "open"}>
            {item.checked !== undefined && <span className="md-box" role="img" aria-label={item.checked ? "✓" : "☐"} />}
            {blocks(item.blocks, !block.loose)}
          </li>
        ));
        return block.ordered
          ? <ol key={key} start={block.start} data-loose={block.loose || undefined}>{items}</ol>
          : <ul key={key} data-loose={block.loose || undefined}>{items}</ul>;
      }
      case "table": {
        const at = (column: number): CSSProperties | undefined => block.align[column] ? { textAlign: block.align[column]! } : undefined;
        return (
          // A table wider than the column scrolls in its own box; it never pushes the page wider.
          <div key={key} className="md-table" tabIndex={0}>
            <table>
              <thead><tr>{block.head.map((cell, column) => <th key={column} style={at(column)}>{inline(cell)}</th>)}</tr></thead>
              <tbody>{block.rows.map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column} style={at(column)}>{inline(cell)}</td>)}</tr>)}</tbody>
            </table>
          </div>
        );
      }
      case "rule": return <hr key={key} />;
    }
  });
}

/** A reply, drawn from the Markdown it was written in (markdown.ts). Nothing in it is HTML from the model: every
 * element here is made from the parsed tree. */
export function Markdown({ text, className, ref, reading = false }: { text: string; className?: string; ref?: Ref<HTMLDivElement>; reading?: boolean }) {
  const tree = useMemo(() => {
    const parsed = parseMarkdown(text);
    return reading ? inboxReadingBlocks(parsed) : parsed;
  }, [text, reading]);
  return <div ref={ref} className={className ? `md ${className}` : "md"}>{blocks(tree)}</div>;
}
