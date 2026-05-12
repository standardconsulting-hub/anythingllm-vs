import React from "react";
import { Sun, Moon } from "@phosphor-icons/react";
import { Tooltip } from "react-tooltip";
import { useThemeContext } from "@/ThemeContext";

/**
 * VS Declaration theme toggle.
 *
 * Renders as a footer icon styled to match the github/discord/wrench
 * icons in AnythingLLM's Footer component. Lives in the footer rather
 * than the brand header so it does not collide with the absolute-
 * positioned sidebar collapse button at the top-right.
 */
export default function VSThemeToggle() {
  const themeCtx = useThemeContext() || {};
  const { setTheme, isLight } = themeCtx;

  function toggleTheme() {
    if (!setTheme) return;
    setTheme(isLight ? "dark" : "light");
  }

  return (
    <div className="flex w-fit">
      <button
        type="button"
        onClick={toggleTheme}
        aria-label={isLight ? "Switch to dark mode" : "Switch to light mode"}
        data-tooltip-id="vs-footer-theme"
        data-tooltip-content={
          isLight ? "Switch to dark mode" : "Switch to light mode"
        }
        className="transition-all duration-300 p-2 rounded-full bg-theme-sidebar-footer-icon hover:bg-theme-sidebar-footer-icon-hover text-theme-text-primary"
      >
        {isLight ? (
          <Moon size={18} weight="bold" />
        ) : (
          <Sun size={18} weight="bold" />
        )}
      </button>
      <Tooltip
        id="vs-footer-theme"
        place="top"
        delayShow={200}
        className="!text-xs !py-1 !px-2"
      />
    </div>
  );
}
