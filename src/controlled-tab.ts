// Pure builders for the "this tab is controlled by the pi agent" overlay, injected into the
// page via `agent-browser eval`. Kept dependency-free (like cdp-errors.ts / agent-browser-args.ts)
// so the generated scripts are unit-testable without a browser.
//
// The overlay has three matching red signals: a slim full-width line pinned to the top of the
// viewport with a soft breathing glow, a small "pi agent" text pill just beneath it, and a red
// favicon mirrored in the tab strip. Everything overlays the page (position:fixed +
// pointer-events:none) so it never reflows or blocks content.

const CONTROLLED_TAB_BADGE_ID = "__pi_agent_controlled_tab_badge__";
const CONTROLLED_TAB_LABEL_ID = "__pi_agent_controlled_tab_label__";
const CONTROLLED_TAB_STYLE_ID = "__pi_agent_controlled_tab_style__";
const CONTROLLED_TAB_FAVICON_ATTR = "data-pi-agent-controlled-tab-favicon";
const CONTROLLED_TAB_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#f87171"/>
      <stop offset="0.55" stop-color="#dc2626"/>
      <stop offset="1" stop-color="#991b1b"/>
    </linearGradient>
    <radialGradient id="hl" cx="30%" cy="22%" r="70%">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.45"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="64" height="64" rx="15" fill="url(#g)"/>
  <rect width="64" height="64" rx="15" fill="url(#hl)"/>
</svg>`;

// Builds the inject script. The pill text is set via textContent (never innerHTML), so the
// caller may pass a label derived from live state (domain, etc.) without escaping concerns.
export function controlledTabMarkScript(labelText: string): string {
  return `(() => {
  const badgeId = ${JSON.stringify(CONTROLLED_TAB_BADGE_ID)};
  const labelId = ${JSON.stringify(CONTROLLED_TAB_LABEL_ID)};
  const styleId = ${JSON.stringify(CONTROLLED_TAB_STYLE_ID)};
  const faviconAttr = ${JSON.stringify(CONTROLLED_TAB_FAVICON_ATTR)};
  const faviconHref = "data:image/svg+xml," + encodeURIComponent(${JSON.stringify(CONTROLLED_TAB_FAVICON_SVG)});
  const labelText = ${JSON.stringify(labelText)};

  let icon = document.querySelector("link[" + faviconAttr + "]");
  if (!icon) {
    icon = document.querySelector('link[rel="icon"], link[rel="shortcut icon"], link[rel*="icon" i]');
  }
  if (!icon) {
    icon = document.createElement("link");
    icon.rel = "icon";
    icon.dataset.piAgentControlledTabCreated = "true";
    (document.head || document.documentElement).appendChild(icon);
  }
  if (!icon.hasAttribute(faviconAttr)) {
    icon.dataset.piAgentControlledTabOriginalHref = icon.getAttribute("href") || "";
  }
  icon.setAttribute(faviconAttr, "true");
  icon.href = faviconHref;

  const sel = "#" + badgeId;
  const lbl = "#" + labelId;
  let style = document.getElementById(styleId);
  if (!style) {
    style = document.createElement("style");
    style.id = styleId;
    (document.head || document.documentElement).appendChild(style);
  }
  style.textContent =
    "@keyframes __pi_rec_slide{from{background-position:0 0}to{background-position:200% 0}}" +
    "@keyframes __pi_rec_breathe{0%,100%{opacity:.28}50%{opacity:.62}}" +
    "@keyframes __pi_rec_pulse{0%,100%{opacity:.5}50%{opacity:1}}" +
    sel + "{position:fixed;top:0;left:0;right:0;height:4px;z-index:2147483647;pointer-events:none;" +
      "background:linear-gradient(90deg,#991b1b,#dc2626 22%,#f87171 50%,#dc2626 78%,#991b1b);background-size:200% 100%;" +
      "animation:__pi_rec_slide 5.5s linear infinite;" +
      "box-shadow:0 0 7px 0 rgba(239,68,68,.55),0 4px 15px -6px rgba(220,38,38,.4);}" +
    sel + "::after{content:'';position:absolute;left:0;right:0;top:100%;height:13px;pointer-events:none;" +
      "background:linear-gradient(to bottom,rgba(239,68,68,.32),rgba(239,68,68,0));" +
      "animation:__pi_rec_breathe 2.6s ease-in-out infinite;}" +
    lbl + "{position:fixed;top:9px;left:50%;transform:translateX(-50%);z-index:2147483647;pointer-events:none;" +
      "display:flex;align-items:center;gap:6px;max-width:min(82vw,560px);box-sizing:border-box;" +
      "padding:3px 11px 3px 9px;border-radius:999px;" +
      "font:600 11px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.02em;" +
      "color:#fff1f1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" +
      "background:linear-gradient(180deg,rgba(190,32,32,.94),rgba(135,14,14,.94));" +
      "box-shadow:0 3px 12px -3px rgba(220,38,38,.55),inset 0 0 0 1px rgba(255,255,255,.14);" +
      "-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);}" +
    lbl + "::before{content:'';flex:none;width:7px;height:7px;border-radius:50%;background:#fff;" +
      "box-shadow:0 0 7px 1px rgba(255,255,255,.85);animation:__pi_rec_pulse 2s ease-in-out infinite;}" +
    "@media (prefers-reduced-motion: reduce){" +
      sel + "{animation:none}" +
      sel + "::after{animation:none;opacity:.7}" +
      lbl + "::before{animation:none}}";

  document.getElementById(badgeId)?.remove();
  const root = document.createElement("div");
  root.id = badgeId;
  document.documentElement.appendChild(root);

  let label = document.getElementById(labelId);
  if (!label) {
    label = document.createElement("div");
    label.id = labelId;
    document.documentElement.appendChild(label);
  }
  label.textContent = labelText;
})()`;
}

export const CONTROLLED_TAB_CLEAR_SCRIPT = `(() => {
  const badgeId = ${JSON.stringify(CONTROLLED_TAB_BADGE_ID)};
  const labelId = ${JSON.stringify(CONTROLLED_TAB_LABEL_ID)};
  const styleId = ${JSON.stringify(CONTROLLED_TAB_STYLE_ID)};
  const faviconAttr = ${JSON.stringify(CONTROLLED_TAB_FAVICON_ATTR)};

  document.getElementById(badgeId)?.remove();
  document.getElementById(labelId)?.remove();
  document.getElementById(styleId)?.remove();

  const icon = document.querySelector("link[" + faviconAttr + "]");
  if (icon) {
    if (icon.dataset.piAgentControlledTabCreated === "true") {
      icon.remove();
    } else {
      const originalHref = icon.dataset.piAgentControlledTabOriginalHref || "";
      if (originalHref) icon.setAttribute("href", originalHref);
      else icon.removeAttribute("href");
      icon.removeAttribute(faviconAttr);
      delete icon.dataset.piAgentControlledTabOriginalHref;
    }
  }
})()`;

// Compact, always-correct pill text: identifies the agent and the live target it's driving.
export function controlledTabLabel(target: string): string {
  return `pi agent · ${target}`;
}
