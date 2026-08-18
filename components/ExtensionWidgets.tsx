"use client";

export const MAX_EXTENSION_WIDGET_LINES = 10;

interface Widget {
  key: string;
  lines: string[];
}

interface Props {
  widgets: Widget[];
  /** Widget keys that should render a close (✕) button in the header. */
  closableKeys?: string[];
  /** Called when the close button is clicked. */
  onCloseWidget?: (key: string) => void;
}

function getDisplayLines(lines: string[]): string[] {
  if (lines.length <= MAX_EXTENSION_WIDGET_LINES) return lines;
  return [
    ...lines.slice(0, MAX_EXTENSION_WIDGET_LINES),
    "... (widget truncated)",
  ];
}

export function ExtensionWidgets({ widgets, closableKeys, onCloseWidget }: Props) {
  if (widgets.length === 0) return null;
  const closableSet = closableKeys ? new Set(closableKeys) : null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 10 }}>
      {widgets.map((widget) => {
        const closable = !!closableSet && closableSet.has(widget.key) && !!onCloseWidget;
        return (
          <div
            key={widget.key}
            style={{
              border: "1px solid var(--border)",
              borderRadius: 7,
              background: "var(--bg-panel)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                padding: closable ? "3px 4px 3px 9px" : "5px 9px",
                borderBottom: "1px solid var(--border)",
                display: "flex",
                alignItems: "center",
                gap: 6,
                color: "var(--text-dim)",
                fontSize: 11,
                fontFamily: "var(--font-mono)",
              }}
            >
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {widget.key}
              </span>
              {closable && (
                <button
                  type="button"
                  onClick={() => onCloseWidget?.(widget.key)}
                  aria-label="关闭"
                  title="关闭"
                  style={{
                    flexShrink: 0,
                    width: 20,
                    height: 20,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: 0,
                    background: "transparent",
                    border: "none",
                    borderRadius: 5,
                    color: "var(--text-dim)",
                    cursor: "pointer",
                    fontSize: 13,
                    lineHeight: 1,
                  }}
                >
                  ✕
                </button>
              )}
            </div>
            <pre style={{ margin: 0, padding: "8px 9px", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "var(--font-mono)" }}>
              {getDisplayLines(widget.lines).join("\n")}
            </pre>
          </div>
        );
      })}
    </div>
  );
}
