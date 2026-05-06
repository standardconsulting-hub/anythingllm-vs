import { encode as HTMLEncode } from "he";
import markdownIt from "markdown-it";
import markdownItKatexPlugin from "./plugins/markdown-katex";
import Appearance from "@/models/appearance";
import hljs from "highlight.js";
import "./themes/github-dark.css";
import "./themes/github.css";
import { v4 } from "uuid";

// Register custom lanaguages
import hljsDefineSvelte from "./hljs-libraries/svelte";
hljs.registerLanguage("svelte", hljsDefineSvelte);

const markdown = markdownIt({
  html: Appearance.get("renderHTML") ?? false,
  typographer: true,
  highlight: function (code, lang) {
    const uuid = v4();
    const theme =
      window.localStorage.getItem("theme") === "light"
        ? "github"
        : "github-dark";

    if (lang && hljs.getLanguage(lang)) {
      try {
        return (
          `<div class="whitespace-pre-line w-full max-w-[65vw] hljs ${theme} light:border-solid light:border light:border-gray-700 rounded-lg relative font-mono font-normal text-sm text-slate-200">
            <div class="w-full flex items-center sticky top-0 text-slate-200 light:bg-sky-800 bg-stone-800 px-4 py-2 text-xs font-sans justify-between rounded-t-md -mt-5">
              <div class="flex gap-2">
                <code class="text-xs">${lang || ""}</code>
              </div>
              <button data-code-snippet data-code="code-${uuid}" class="flex items-center gap-x-1">
                <svg stroke="currentColor" fill="none" stroke-width="2" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round" class="h-3 w-3" height="1em" width="1em" xmlns="http://www.w3.org/2000/svg"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect></svg>
                <p class="text-xs" style="margin: 0px;padding: 0px;">Copy block</p>
              </button>
            </div>
            <pre class="whitespace-pre-wrap px-4 pb-4">` +
          hljs.highlight(code, { language: lang, ignoreIllegals: true }).value +
          "</pre></div>"
        );
      } catch {}
    }

    return (
      `<div class="whitespace-pre-line w-full max-w-[65vw] hljs ${theme} light:border-solid light:border light:border-gray-700 rounded-lg relative font-mono font-normal text-sm text-slate-200">
        <div class="w-full flex items-center sticky top-0 text-slate-200 bg-stone-800 px-4 py-2 text-xs font-sans justify-between rounded-t-md -mt-5">
          <div class="flex gap-2"><code class="text-xs"></code></div>
          <button data-code-snippet data-code="code-${uuid}" class="flex items-center gap-x-1">
            <svg stroke="currentColor" fill="none" stroke-width="2" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round" class="h-3 w-3" height="1em" width="1em" xmlns="http://www.w3.org/2000/svg"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect></svg>
            <p class="text-xs" style="margin: 0px;padding: 0px;">Copy block</p>
          </button>
        </div>
        <pre class="whitespace-pre-wrap px-4 pb-4">` +
      HTMLEncode(code) +
      "</pre></div>"
    );
  },
});

// Add custom renderer for strong tags to handle theme colors
markdown.renderer.rules.strong_open = () => '<strong class="text-white">';
markdown.renderer.rules.strong_close = () => "</strong>";
markdown.renderer.rules.link_open = (tokens, idx) => {
  const token = tokens[idx];
  const href = token.attrs.find((attr) => attr[0] === "href");
  return `<a href="${HTMLEncode(href[1])}" target="_blank" rel="noopener noreferrer">`;
};

// Custom renderer for responsive images rendered in markdown
markdown.renderer.rules.image = function (tokens, idx) {
  const token = tokens[idx];
  const srcIndex = token.attrIndex("src");
  const src = token.attrs[srcIndex][1];
  const alt = token.content || "";

  return `<div class="w-full max-w-[800px]"><img src="${HTMLEncode(src)}" alt="${HTMLEncode(alt)}" class="w-full h-auto" /></div>`;
};

markdown.use(markdownItKatexPlugin);

// vs-fork Plan 4 §A.4b: tag any blockquote whose first text line
// starts with the literal `[VS-BANNER]` token with class="vs-banner"
// AND strip the marker token from the rendered content. The §A.1
// CSS selector `blockquote.vs-banner` then applies the Signal Teal
// left-border + bold treatment. Marker is template-enforced by the
// Plan 4 §B.1 default system prompt; without this rule the marker
// would render visibly to the operator. Defense-in-depth: strip-on-
// render means even a visible-banner copy attack cannot exfiltrate
// the marker into a regular blockquote.
markdown.core.ruler.push("vs_banner_blockquote", (state) => {
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== "blockquote_open") continue;
    // The first inline token after blockquote_open carries the
    // initial paragraph's text content.
    let inlineIdx = -1;
    for (let j = i + 1; j < tokens.length; j++) {
      if (tokens[j].type === "blockquote_close") break;
      if (tokens[j].type === "inline") {
        inlineIdx = j;
        break;
      }
    }
    if (inlineIdx === -1) continue;
    const inlineTok = tokens[inlineIdx];
    const content = (inlineTok.content || "").trimStart();
    if (!content.startsWith("[VS-BANNER]")) continue;
    // Tag the blockquote.
    const open = tokens[i];
    const existing = open.attrGet("class");
    open.attrSet(
      "class",
      existing ? `${existing} vs-banner` : "vs-banner"
    );
    // Strip the marker from inline content + first text child token.
    const stripped = content.replace(/^\[VS-BANNER\]\s*/, "");
    inlineTok.content = stripped;
    if (Array.isArray(inlineTok.children)) {
      for (const child of inlineTok.children) {
        if (child.type === "text" && typeof child.content === "string") {
          child.content = child.content.replace(/^\[VS-BANNER\]\s*/, "");
          break;
        }
      }
    }
  }
});

export default function renderMarkdown(text = "") {
  return markdown.render(text);
}
