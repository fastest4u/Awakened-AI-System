import React from 'react';
import { Link2 } from 'lucide-react';

/**
 * Checks whether a markdown hyperlink href uses a safe allowed protocol.
 * Allowed protocols: http:, https:, mailto:, vscode:, cursor:, #…
 * Blocks unsafe protocols such as javascript:, data:, vbscript:, and protocol-relative // URLs.
 */
export function isSafeMarkdownHref(rawHref: string): boolean {
  const href = String(rawHref || '').trim();
  if (!href) return false;
  const lower = href.toLowerCase();
  if (lower.startsWith('//')) return false;
  return (
    lower.startsWith('https://') ||
    lower.startsWith('http://') ||
    lower.startsWith('mailto:') ||
    lower.startsWith('vscode:') ||
    lower.startsWith('cursor:') ||
    lower.startsWith('#')
  );
}

export interface InlineMarkdownProps {
  text: string;
  onWikilink?: (target: string) => void;
}

/**
 * Renders inline Markdown safely using React elements without dangerouslySetInnerHTML.
 * Supports inline code, bold, wikilinks ([[target|label]]), and links ([label](url)).
 */
export function InlineMarkdown({ text, onWikilink }: InlineMarkdownProps) {
  const str = String(text || '');
  if (
    !str.includes('`') &&
    !str.includes('**') &&
    !str.includes('[[') &&
    !str.includes('](')
  ) {
    return <>{str}</>;
  }

  // Token regex for: `code`, **bold**, [[target|label]], [label](href)
  const tokenRe =
    /`([^`]+)`|\*\*([^*]+)\*\*|\[\[([^\]|]+)(?:\|([^\]]+))?\]\]|\[([^\]]+)\]\(([^)\s]+)\)/g;

  const elements: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let partIdx = 0;

  while ((match = tokenRe.exec(str)) !== null) {
    if (match.index > lastIndex) {
      elements.push(str.slice(lastIndex, match.index));
    }

    const key = `inline-tok-${partIdx++}`;

    if (match[1] !== undefined) {
      // `code`
      elements.push(
        <code
          key={key}
          className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground"
        >
          {match[1]}
        </code>,
      );
    } else if (match[2] !== undefined) {
      // **bold**
      elements.push(
        <strong key={key} className="font-semibold text-foreground">
          {match[2]}
        </strong>,
      );
    } else if (match[3] !== undefined) {
      // [[target|label]]
      const target = String(match[3] || '').trim();
      const label = String(match[4] || match[3] || '').trim();
      elements.push(
        <button
          key={key}
          type="button"
          onClick={() => onWikilink?.(target)}
          className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-xs font-semibold text-foreground hover:bg-primary/20 transition-colors cursor-pointer align-baseline mx-0.5"
        >
          <Link2 className="size-3 text-pink-500 shrink-0" />
          <span>{label}</span>
        </button>,
      );
    } else if (match[5] !== undefined && match[6] !== undefined) {
      // [label](href)
      const label = match[5];
      const href = match[6];
      if (isSafeMarkdownHref(href)) {
        elements.push(
          <a
            key={key}
            href={href}
            target={href.startsWith('#') ? undefined : '_blank'}
            rel="noopener noreferrer"
            className="font-medium text-primary underline underline-offset-2 hover:opacity-80"
          >
            {label}
          </a>,
        );
      } else {
        // Unsafe link renders as plain text without <a>
        elements.push(<span key={key}>{label}</span>);
      }
    }

    lastIndex = tokenRe.lastIndex;
  }

  if (lastIndex < str.length) {
    elements.push(str.slice(lastIndex));
  }

  return <>{elements}</>;
}

export interface MarkdownBlocksProps {
  text: string;
  onWikilink?: (target: string) => void;
}

/**
 * Renders block-level markdown safely without dangerouslySetInnerHTML.
 * Supports fenced code blocks, headings (h1..h4), lists (ul/ol), and paragraphs.
 */
export function MarkdownBlocks({ text, onWikilink }: MarkdownBlocksProps) {
  const lines = String(text || '').split('\n');
  const blocks: React.ReactNode[] = [];
  let idx = 0;

  while (idx < lines.length) {
    const line = lines[idx];
    const trimmed = line.trim();

    // Check fenced code block (```)
    if (trimmed.startsWith('```')) {
      const codeLines: string[] = [];
      const fenceStartIdx = idx;
      idx++;
      while (idx < lines.length && !lines[idx].trim().startsWith('```')) {
        codeLines.push(lines[idx]);
        idx++;
      }
      if (idx < lines.length) {
        idx++; // skip closing fence
      }
      blocks.push(
        <pre
          key={`fence-${fenceStartIdx}`}
          className="my-3 overflow-x-auto rounded-lg border border-border bg-muted/60 p-3.5 text-xs font-mono text-foreground"
        >
          <code>{codeLines.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    // Empty lines
    if (!trimmed) {
      idx++;
      continue;
    }

    // Headings
    if (trimmed.startsWith('# ')) {
      blocks.push(
        <h1
          key={`h1-${idx}`}
          className="my-3 text-xl font-bold tracking-tight text-primary"
        >
          <InlineMarkdown text={trimmed.slice(2)} onWikilink={onWikilink} />
        </h1>,
      );
      idx++;
      continue;
    }

    if (trimmed.startsWith('## ')) {
      blocks.push(
        <h2
          key={`h2-${idx}`}
          className="my-2.5 text-lg font-semibold tracking-tight text-foreground"
        >
          <InlineMarkdown text={trimmed.slice(3)} onWikilink={onWikilink} />
        </h2>,
      );
      idx++;
      continue;
    }

    if (trimmed.startsWith('### ')) {
      blocks.push(
        <h3
          key={`h3-${idx}`}
          className="my-2 text-base font-semibold text-foreground"
        >
          <InlineMarkdown text={trimmed.slice(4)} onWikilink={onWikilink} />
        </h3>,
      );
      idx++;
      continue;
    }

    if (trimmed.startsWith('#### ')) {
      blocks.push(
        <h4
          key={`h4-${idx}`}
          className="my-1.5 text-sm font-semibold text-foreground"
        >
          <InlineMarkdown text={trimmed.slice(5)} onWikilink={onWikilink} />
        </h4>,
      );
      idx++;
      continue;
    }

    // List items: - , * , 1.
    const isUnordered = trimmed.startsWith('- ') || trimmed.startsWith('* ');
    const isOrdered = /^\d+\.\s/.test(trimmed);

    if (isUnordered || isOrdered) {
      const listItems: { text: string; idx: number }[] = [];
      const listStartIdx = idx;

      while (idx < lines.length) {
        const itemLine = lines[idx].trim();
        if (isUnordered && (itemLine.startsWith('- ') || itemLine.startsWith('* '))) {
          listItems.push({
            text: itemLine.replace(/^[-*]\s+/, ''),
            idx,
          });
          idx++;
        } else if (isOrdered && /^\d+\.\s/.test(itemLine)) {
          listItems.push({
            text: itemLine.replace(/^\d+\.\s+/, ''),
            idx,
          });
          idx++;
        } else {
          break;
        }
      }

      if (isOrdered) {
        blocks.push(
          <ol
            key={`ol-${listStartIdx}`}
            className="my-2 list-decimal space-y-1 pl-6 text-sm text-foreground"
          >
            {listItems.map((item) => (
              <li key={`li-${item.idx}`}>
                <InlineMarkdown text={item.text} onWikilink={onWikilink} />
              </li>
            ))}
          </ol>,
        );
      } else {
        blocks.push(
          <ul
            key={`ul-${listStartIdx}`}
            className="my-2 list-disc space-y-1 pl-6 text-sm text-foreground"
          >
            {listItems.map((item) => (
              <li key={`li-${item.idx}`}>
                <InlineMarkdown text={item.text} onWikilink={onWikilink} />
              </li>
            ))}
          </ul>,
        );
      }
      continue;
    }

    // Normal paragraph
    blocks.push(
      <p
        key={`p-${idx}`}
        className="my-2 text-sm leading-relaxed text-foreground"
      >
        <InlineMarkdown text={trimmed} onWikilink={onWikilink} />
      </p>,
    );
    idx++;
  }

  return <>{blocks}</>;
}
