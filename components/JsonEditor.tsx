"use client";

import Editor from "react-simple-code-editor";
import Prism from "prismjs";
import "prismjs/components/prism-json";
import type { CSSProperties } from "react";

/**
 * JSON editor with syntax highlighting (prismjs) over an editable surface
 * (react-simple-code-editor). Highlights keys / strings / numbers in distinct
 * colors so the structure is readable, unlike a plain textarea.
 *
 * prismjs is already pulled in transitively by react-syntax-highlighter; we
 * define our own token colors here to match the app's dark theme instead of
 * importing a prism CSS theme (which would force its own background).
 */
const TOKEN_COLORS = `
.json-editor .token.property,
.json-editor .token.tag { color: #7dd3fc; }
.json-editor .token.string { color: #86efac; }
.json-editor .token.number,
.json-editor .token.boolean { color: #fda4af; }
.json-editor .token.null,
.json-editor .token.keyword { color: #94a3b8; }
.json-editor .token.punctuation,
.json-editor .token.operator { color: var(--text-muted); }
`;

export function JsonEditor({
  value,
  onChange,
  placeholder,
  invalid = false,
  height = 320,
  style,
}: {
  value: string;
  onChange: (code: string) => void;
  placeholder?: string;
  invalid?: boolean;
  /** 编辑区固定高度（px），内容超出后在内部滚动，不撑高外层容器 */
  height?: number;
  style?: CSSProperties;
}) {
  return (
    <div className="json-editor" style={style}>
      <style>{TOKEN_COLORS}</style>
      <Editor
        value={value}
        onValueChange={onChange}
        highlight={(code) => Prism.highlight(code, Prism.languages.json, "json")}
        padding={10}
        placeholder={placeholder}
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          lineHeight: 1.6,
          height,
          overflow: "auto",
          background: "var(--bg)",
          border: `1px solid ${invalid ? "#ef4444" : "var(--border)"}`,
          borderRadius: 6,
          color: "var(--text)",
        }}
      />
    </div>
  );
}
