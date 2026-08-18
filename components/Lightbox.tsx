"use client";

import { useEffect, useCallback, memo } from "react";

interface LightboxProps {
  src: string | null;
  onClose: () => void;
}

export const Lightbox = memo(function Lightbox({ src, onClose }: LightboxProps) {
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") {
      onClose();
    }
  }, [onClose]);

  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  }, [onClose]);

  useEffect(() => {
    if (!src) return;
    document.addEventListener("keydown", handleKeyDown);
    // 防止背景滚动
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "";
    };
  }, [src, handleKeyDown]);

  if (!src) return null;

  return (
    <div
      onClick={handleBackdropClick}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0, 0, 0, 0.88)",
        backdropFilter: "blur(4px)",
        animation: "lightboxFadeIn 0.15s ease-out",
      }}
    >
      {/* 关闭按钮 */}
      <button
        onClick={onClose}
        aria-label="关闭"
        style={{
          position: "absolute",
          top: 16,
          right: 16,
          width: 40,
          height: 40,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "rgba(255, 255, 255, 0.1)",
          border: "none",
          borderRadius: 8,
          cursor: "pointer",
          color: "#fff",
          transition: "background 0.15s",
          zIndex: 1,
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255, 255, 255, 0.2)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(255, 255, 255, 0.1)"; }}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>

      {/* 图片容器 */}
      <div
        style={{
          maxWidth: "90vw",
          maxHeight: "90vh",
          animation: "lightboxZoomIn 0.15s ease-out",
        }}
        onClick={handleBackdropClick}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt=""
          style={{
            maxWidth: "90vw",
            maxHeight: "90vh",
            objectFit: "contain",
            borderRadius: 8,
            boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.5)",
          }}
        />
      </div>

      <style>{`
        @keyframes lightboxFadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes lightboxZoomIn {
          from {
            opacity: 0;
            transform: scale(0.95);
          }
          to {
            opacity: 1;
            transform: scale(1);
          }
        }
      `}</style>
    </div>
  );
});
