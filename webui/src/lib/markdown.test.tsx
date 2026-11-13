import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { isSafeMarkdownHref, InlineMarkdown, MarkdownBlocks } from './markdown';

describe('markdown', () => {
  it('safe href table', () => {
    // True cases: allow http:, https:, mailto:, vscode:, cursor:, #…
    expect(isSafeMarkdownHref('https://a.b')).toBe(true);
    expect(isSafeMarkdownHref('http://a')).toBe(true);
    expect(isSafeMarkdownHref('mailto:x@y')).toBe(true);
    expect(isSafeMarkdownHref('vscode://file/x')).toBe(true);
    expect(isSafeMarkdownHref('cursor://x')).toBe(true);
    expect(isSafeMarkdownHref('#h')).toBe(true);

    // False cases
    expect(isSafeMarkdownHref('javascript:alert(1)')).toBe(false);
    expect(isSafeMarkdownHref(' JavaScript:alert(1)')).toBe(false);
    expect(isSafeMarkdownHref('data:text/html,x')).toBe(false);
    expect(isSafeMarkdownHref('//evil.com')).toBe(false);
    expect(isSafeMarkdownHref('vbscript:x')).toBe(false);
    expect(isSafeMarkdownHref('')).toBe(false);
  });

  it('unsafe link renders as plain text', () => {
    const { container } = render(
      <InlineMarkdown text="[x](javascript:alert(1))" />,
    );
    expect(container.querySelector('a')).toBeNull();
    expect(screen.getByText('x')).toBeInTheDocument();
  });

  it('raw html is inert', () => {
    const { container } = render(
      <InlineMarkdown text="<img src=x onerror=alert(1)>" />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(
      screen.getByText('<img src=x onerror=alert(1)>'),
    ).toBeInTheDocument();
  });

  it('blocks', () => {
    const markdown = [
      '```typescript',
      'const answer = 42;',
      '```',
      '',
      '## H',
      '',
      '- a',
      '',
      '**b** and `c`',
    ].join('\n');

    const { container } = render(<MarkdownBlocks text={markdown} />);

    // Fenced code -> <pre><code>
    const pre = container.querySelector('pre');
    expect(pre).not.toBeNull();
    const code = pre?.querySelector('code');
    expect(code).not.toBeNull();
    expect(code?.textContent).toContain('const answer = 42;');

    // ## H -> heading level 2
    const heading = screen.getByRole('heading', { level: 2 });
    expect(heading).toHaveTextContent('H');

    // - a -> list item
    const listItem = screen.getByRole('listitem');
    expect(listItem).toHaveTextContent('a');

    // **b** -> <strong>
    const strong = container.querySelector('strong');
    expect(strong).not.toBeNull();
    expect(strong?.textContent).toBe('b');

    // `c` -> <code> (inline, not inside pre)
    const inlineCodes = Array.from(container.querySelectorAll('code')).filter(
      (el) => el.closest('pre') === null,
    );
    expect(inlineCodes.length).toBeGreaterThan(0);
    expect(inlineCodes[0].textContent).toBe('c');
  });

  it('wikilinks', async () => {
    const onWikilink = vi.fn();
    render(
      <InlineMarkdown text="[[note:abc|ดูต่อ]]" onWikilink={onWikilink} />,
    );

    const button = screen.getByRole('button', { name: /ดูต่อ/ });
    expect(button).toBeInTheDocument();

    await userEvent.click(button);
    expect(onWikilink).toHaveBeenCalledWith('note:abc');
  });
});
