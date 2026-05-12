import React from "react";
import { Link } from "react-router-dom";
import paths from "@/utils/paths";
import useLogo from "@/hooks/useLogo";

/**
 * VS Declaration sidebar header.
 *
 * Two-row layout sized for the 250px sidebar column.
 *
 *   [VS mark]                                   [sun/moon]
 *   VARNEY STANDARD
 *
 * The mark on the top-left and the theme toggle on the top-right do
 * not visually clash. The wordmark sits on its own row underneath in
 * Space Mono small caps so the entire header reads as one identity
 * block.
 */
export default function VSBrandHeader({ showSidebar }) {
  const { logo } = useLogo();

  return (
    <div
      className={`flex flex-col w-full gap-1 transition-opacity duration-500 ${
        showSidebar ? "opacity-100" : "opacity-0"
      }`}
    >
      {/* Row 1 — VS mark. */}
      <Link
        to={paths.home()}
        aria-label="Home — VS Declaration"
        className="flex items-center min-w-0"
      >
        <img
          src={logo}
          alt="VS Declaration"
          style={{ height: "26px", width: "auto", objectFit: "contain" }}
        />
      </Link>

      {/* Row 2 — VARNEY STANDARD wordmark. The theme toggle lives in
          the sidebar footer (VSThemeToggle) to avoid clashing with the
          absolute-positioned sidebar collapse button. */}
      <span
        className="text-theme-text-secondary text-[10px] tracking-[0.22em] uppercase"
        style={{
          fontFamily: '"Space Mono", ui-monospace, monospace',
          fontWeight: 700,
        }}
      >
        Varney Standard
      </span>
    </div>
  );
}
