// Pure builders for the "this tab is controlled by the pi agent" overlay, injected into the
// page via `agent-browser eval`. Kept dependency-free (like cdp-errors.ts / agent-browser-args.ts)
// so the generated scripts are unit-testable without a browser.
//
// The overlay stays deliberately quiet: a 2px red hairline along the top of the viewport
// and a red favicon mirrored in the tab strip. Everything overlays the page (position:fixed +
// pointer-events:none) so it never reflows or blocks content.

const CONTROLLED_TAB_BADGE_ID = "__pi_agent_controlled_tab_badge__";
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

// Builds the inject script. `labelText` is intentionally unused now; the visible page marker
// is only the top hairline. Keep the parameter for call-site compatibility.
export function controlledTabMarkScript(_labelText: string): string {
  return `(() => {
  const badgeId = ${JSON.stringify(CONTROLLED_TAB_BADGE_ID)};
  const styleId = ${JSON.stringify(CONTROLLED_TAB_STYLE_ID)};
  const faviconAttr = ${JSON.stringify(CONTROLLED_TAB_FAVICON_ATTR)};
  const faviconHref = "data:image/svg+xml," + encodeURIComponent(${JSON.stringify(CONTROLLED_TAB_FAVICON_SVG)});

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
  let style = document.getElementById(styleId);
  if (!style) {
    style = document.createElement("style");
    style.id = styleId;
    (document.head || document.documentElement).appendChild(style);
  }
  style.textContent =
    "@keyframes __pi_rec_slide{from{background-position:0 0}to{background-position:200% 0}}" +
    "@keyframes __pi_rec_pulse{0%,100%{opacity:.45}50%{opacity:1}}" +
    sel + "{position:fixed;top:0;left:0;right:0;height:2px;z-index:2147483647;pointer-events:none;opacity:.85;" +
      "background:linear-gradient(90deg,#991b1b,#dc2626 22%,#f87171 50%,#dc2626 78%,#991b1b);background-size:200% 100%;" +
      "animation:__pi_rec_slide 6s linear infinite;}" +
    "@media (prefers-reduced-motion: reduce){" +
      sel + "{animation:none}}";

  document.getElementById(badgeId)?.remove();
  const root = document.createElement("div");
  root.id = badgeId;
  document.documentElement.appendChild(root);

})()`;
}

export const CONTROLLED_TAB_CLEAR_SCRIPT = `(() => {
  const badgeId = ${JSON.stringify(CONTROLLED_TAB_BADGE_ID)};
  const styleId = ${JSON.stringify(CONTROLLED_TAB_STYLE_ID)};
  const faviconAttr = ${JSON.stringify(CONTROLLED_TAB_FAVICON_ATTR)};

  document.getElementById(badgeId)?.remove();
  document.getElementById("__pi_agent_controlled_tab_label__")?.remove();
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
