import DOMPurify from 'dompurify'

/**
 * Lightweight markdown renderer for AI responses.
 * Handles: headers, bold, italic, code blocks, inline code, lists, links, paragraphs, tables.
 */
export function renderMarkdown(text: string): string {
  // Escape HTML
  let html = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  // Code blocks (```...```)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, _lang, code) => {
    return `<pre style="background:var(--bg-secondary);padding:8px 12px;border-radius:8px;overflow-x:auto;margin:8px 0;font-size:12px;line-height:1.5"><code>${code.trim()}</code></pre>`
  })

  // Inline code (`...`)
  html = html.replace(
    /`([^`]+)`/g,
    '<code style="background:var(--bg-secondary);padding:1px 5px;border-radius:4px;font-size:12px">$1</code>',
  )

  // Tables (| ... | ... |)
  html = html.replace(/((?:\|.*\|(?:\n|$))+)/g, (_match, tableBlock: string) => {
    const lines = tableBlock
      .trim()
      .split('\n')
      .filter((l) => l.trim())
    if (lines.length < 2) return tableBlock

    // Check if second line is a separator (|---|---|)
    const isSeparator = (line: string) => /^\|[\s-:|]+\|$/.test(line.trim())
    const hasSeparator = lines.length >= 2 && isSeparator(lines[1])

    const parseRow = (line: string) =>
      line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim())

    let tableHtml =
      '<table style="width:100%;border-collapse:collapse;margin:8px 0;font-size:12px">'

    if (hasSeparator) {
      // Header row
      const headers = parseRow(lines[0])
      tableHtml += '<thead><tr>'
      for (const h of headers) {
        tableHtml += `<th style="border-bottom:2px solid var(--separator);padding:4px 8px;text-align:left;font-weight:600">${h}</th>`
      }
      tableHtml += '</tr></thead><tbody>'

      // Data rows (skip separator)
      for (let i = 2; i < lines.length; i++) {
        const cells = parseRow(lines[i])
        tableHtml += '<tr>'
        for (const c of cells) {
          tableHtml += `<td style="border-bottom:1px solid var(--separator);padding:4px 8px">${c}</td>`
        }
        tableHtml += '</tr>'
      }
      tableHtml += '</tbody>'
    } else {
      // No header separator — all data rows
      tableHtml += '<tbody>'
      for (const line of lines) {
        const cells = parseRow(line)
        tableHtml += '<tr>'
        for (const c of cells) {
          tableHtml += `<td style="border-bottom:1px solid var(--separator);padding:4px 8px">${c}</td>`
        }
        tableHtml += '</tr>'
      }
      tableHtml += '</tbody>'
    }

    tableHtml += '</table>'
    return tableHtml
  })

  // Headers
  html = html.replace(
    /^### (.+)$/gm,
    '<h4 style="font-weight:600;margin:12px 0 4px;font-size:14px">$1</h4>',
  )
  html = html.replace(
    /^## (.+)$/gm,
    '<h3 style="font-weight:600;margin:12px 0 4px;font-size:15px">$1</h3>',
  )
  html = html.replace(
    /^# (.+)$/gm,
    '<h2 style="font-weight:600;margin:12px 0 4px;font-size:16px">$1</h2>',
  )

  // Bold and italic
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>')

  // Lists (- or * or numbered)
  html = html.replace(
    /^[-*] (.+)$/gm,
    '<li style="margin-left:16px;list-style:disc;margin-bottom:2px">$1</li>',
  )
  html = html.replace(
    /^\d+\. (.+)$/gm,
    '<li style="margin-left:16px;list-style:decimal;margin-bottom:2px">$1</li>',
  )

  // Links [text](url)
  html = html.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<span style="color:var(--accent-blue);text-decoration:underline">$1</span>',
  )

  // Horizontal rules
  html = html.replace(
    /^---$/gm,
    '<hr style="border:none;border-top:1px solid var(--separator);margin:8px 0" />',
  )

  // Paragraphs — convert double newlines
  html = html.replace(/\n\n/g, '</p><p style="margin:8px 0">')

  // Single newlines (not inside pre blocks)
  html = html.replace(/(?<!<\/pre>)\n(?!<)/g, '<br />')

  return DOMPurify.sanitize(`<p style="margin:0">${html}</p>`)
}
