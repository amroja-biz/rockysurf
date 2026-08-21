export interface ToolListItem {
  toolId: string
  name: string
  url?: string
  description?: string
}

/**
 * What a pack (or a running server) installed: each tool by name, linked when it declares a
 * `url`, with its description after an em dash when it has one.
 *
 * Extracted from `ServerDetailPage`'s Installed card (rockysurf-4d8h) so `/packs/:packId` can
 * render a pack's contents the identical way rather than growing a second implementation. The
 * caller decides what to show when there is nothing to list — this renders nothing itself.
 */
export function ToolList({ tools, testId }: { tools: ToolListItem[]; testId: string }): React.JSX.Element | null {
  if (tools.length === 0) return null
  return (
    <ul data-testid={testId}>
      {tools.map((tool) => (
        <li key={tool.toolId}>
          {tool.url ? (
            <a href={tool.url} target="_blank" rel="noopener noreferrer">
              {tool.name}
            </a>
          ) : (
            tool.name
          )}
          {tool.description ? <span className="hint"> — {tool.description}</span> : null}
        </li>
      ))}
    </ul>
  )
}
