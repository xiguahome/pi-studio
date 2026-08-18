"use client";

import { useMemo, useState, type MouseEvent } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { useI18n } from "@/hooks/useI18n";
import { resolveLocalFileHref } from "@/lib/file-links";
import { encodeFilePathForApi } from "@/lib/file-paths";
import { markdownRehypePlugins, markdownRemarkPlugins, normalizeDisplayMath } from "@/lib/markdown";
import { MermaidBlock, CodeBlock } from "./MermaidBlock";

interface MarkdownBodyProps {
  children: string;
  className?: string;
  isStreaming?: boolean;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
  onOpenBrowser?: (options: { url?: string; htmlContent?: string; label?: string }) => void;
}

export function MarkdownBody({ children, className, isStreaming, cwd, onOpenFile, onOpenBrowser }: MarkdownBodyProps) {
  const normalizedMarkdown = useMemo(() => normalizeDisplayMath(children), [children]);
  // Stable renderer identities keep stateful blocks mounted across message hover updates.
  const components = useMemo<Components>(() => ({
    code({ className, children, ...props }) {
      const lang = className?.replace("language-", "").toLowerCase() ?? "";
      const raw = String(children);
      const isBlock = className?.includes("language-") || raw.includes("\n");
      if (isBlock) {
        // ```markdown fences carry content the model wants *shown as* markdown
        // (tables, lists…) — render them as rich text instead of highlighted
        // source, with a header toggle back to the code view. Nesting is
        // bounded by the fence layers in the content itself.
        if (lang === "markdown" || lang === "md") {
          return (
            <MarkdownFence
              code={raw}
              isStreaming={isStreaming}
              cwd={cwd}
              onOpenFile={onOpenFile}
              onOpenBrowser={onOpenBrowser}
            />
          );
        }
        if (lang === "mermaid") {
          return <MermaidBlock code={raw.replace(/\n$/, "")} isStreaming={isStreaming} />;
        }
        const headerAction = (lang === "html" && onOpenBrowser) ? (
          <button
            onClick={() => onOpenBrowser({ htmlContent: raw, label: "Preview" })}
            style={{
              display: "inline-flex", alignItems: "center", gap: 4,
              padding: "2px 8px", fontSize: 11, borderRadius: 4,
              border: "1px solid var(--border, #333)", background: "var(--bg-hover, #2a2a2a)",
              color: "var(--text-muted, #aaa)", cursor: "pointer",
            }}
            title="Preview in browser panel"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.2"/><path d="M1.5 8h13M8 1.5c-2 2.5-2 10.5 0 13M8 1.5c2 2.5 2 10.5 0 13" stroke="currentColor" strokeWidth="1.2"/></svg>
            Preview
          </button>
        ) : undefined;
        return <CodeBlock code={raw.replace(/\n$/, "")} lang={lang} headerAction={headerAction} isStreaming={isStreaming} />;
      }
      return (
        <code
          className="markdown-inline-code"
          {...props}
        >
          {children}
        </code>
      );
    },
    pre({ children }) {
      return <>{children}</>;
    },
    a({ href, children, ...props }) {
      // `node` is react-markdown metadata, not a DOM attribute.
      delete props.node;
      const filePath = onOpenFile ? resolveLocalFileHref(href, cwd) : null;
      const openFile = onOpenFile;
      if (!filePath || !openFile) {
        return (
          <a href={href} {...props} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        );
      }

      const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
        if (event.defaultPrevented || event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        const target = event.currentTarget.getAttribute("target");
        if (target && target !== "_self") return;
        event.preventDefault();
        openFile(filePath);
      };

      return (
        <a href={href} {...props} onClick={handleClick}>
          {children}
        </a>
      );
    },
    img({ src, alt, ...props }) {
      delete props.node;
      const filePath = typeof src === "string" ? resolveLocalFileHref(src, cwd) : null;
      const imageSrc = filePath
        ? `/api/files/${encodeFilePathForApi(filePath)}?type=read`
        : src;
      // Dynamic local paths are served directly by the file API.
      // eslint-disable-next-line @next/next/no-img-element
      return <img src={imageSrc} alt={alt ?? ""} loading="lazy" {...props} />;
    },
    table({ children }) {
      return (
        <div className="markdown-table-wrap">
          <table>{children}</table>
        </div>
      );
    },
  }), [cwd, isStreaming, onOpenFile, onOpenBrowser]);

  return (
    <div className={["markdown-body", className].filter(Boolean).join(" ")}>
      <ReactMarkdown
        remarkPlugins={markdownRemarkPlugins}
        rehypePlugins={markdownRehypePlugins}
        components={components}
      >
        {normalizedMarkdown}
      </ReactMarkdown>
    </div>
  );
}

interface MarkdownFenceProps {
  code: string;
  isStreaming?: boolean;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
  onOpenBrowser?: (options: { url?: string; htmlContent?: string; label?: string }) => void;
}

/**
 * ```markdown fence: rendered as rich text by default, toggleable back to the
 * highlighted code view (with copy button) via the header action.
 */
function MarkdownFence({ code, isStreaming, cwd, onOpenFile, onOpenBrowser }: MarkdownFenceProps) {
  const { t } = useI18n();
  const [showSource, setShowSource] = useState(false);

  const toggleButton = (
    <button
      type="button"
      className={["markdown-code-action", showSource ? "" : "is-active"].filter(Boolean).join(" ")}
      onClick={() => setShowSource((value) => !value)}
      title={showSource ? t("i18n.preview") : t("i18n.source")}
    >
      {showSource ? t("i18n.preview") : t("i18n.source")}
    </button>
  );

  if (showSource) {
    return (
      <CodeBlock
        code={code.replace(/\n$/, "")}
        lang="markdown"
        headerAction={toggleButton}
        isStreaming={isStreaming}
      />
    );
  }

  return (
    <div className="markdown-code-block">
      <div className="markdown-code-header">
        <span className="markdown-code-lang">markdown</span>
        <div className="markdown-code-actions">{toggleButton}</div>
      </div>
      <div className="markdown-preview-body">
        <MarkdownBody cwd={cwd} onOpenFile={onOpenFile} onOpenBrowser={onOpenBrowser} isStreaming={isStreaming}>
          {code}
        </MarkdownBody>
      </div>
    </div>
  );
}
