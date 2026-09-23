import { readFileSync } from "node:fs";

// Builders for the controlled-tab marker, injected via `agent-browser eval`.
// A stationary coral glow fades inward from the viewport edges. The transparent
// center and pointer-events:none keep page content and interactions unobstructed.
// Embed the packaged PNG so controlled pages never need to fetch a local asset.

const CONTROLLED_TAB_BADGE_ID = "__pi_agent_controlled_tab_badge__";
const CONTROLLED_TAB_STYLE_ID = "__pi_agent_controlled_tab_style__";
const CONTROLLED_TAB_FAVICON_ATTR = "data-pi-agent-controlled-tab-favicon";
const CONTROLLED_TAB_FAVICON_REL_ATTR = "data-pi-agent-controlled-tab-original-rel";
const CONTROLLED_TAB_FAVICON_ID = "__pi_agent_controlled_tab_favicon__";
const CONTROLLED_TAB_FAVICON_HREF = "data:image/png;base64," + readFileSync(
  new URL("../assets/controlled-tab/favicon-64.png", import.meta.url),
).toString("base64");

// Restore the previous marker's in-place favicon override, including after a reload
// from an older extension version. New markers use a separate icon link instead.
const RESTORE_LEGACY_FAVICON_SCRIPT = `
  const legacyIcon = document.querySelector("link[" + faviconAttr + "]:not([id='" + faviconId + "'])");
  if (legacyIcon) {
    if (legacyIcon.dataset.piAgentControlledTabCreated === "true") {
      legacyIcon.remove();
    } else {
      const originalHref = legacyIcon.dataset.piAgentControlledTabOriginalHref || "";
      if (originalHref) legacyIcon.setAttribute("href", originalHref);
      else legacyIcon.removeAttribute("href");
      legacyIcon.removeAttribute(faviconAttr);
      delete legacyIcon.dataset.piAgentControlledTabOriginalHref;
    }
  }`;

// Builds the inject script. `labelText` is intentionally unused now; the visible page marker
// is only the edge glow. Keep the parameter for call-site compatibility.
export function controlledTabMarkScript(_labelText: string): string {
  return `(() => {
  const badgeId = ${JSON.stringify(CONTROLLED_TAB_BADGE_ID)};
  const styleId = ${JSON.stringify(CONTROLLED_TAB_STYLE_ID)};
  const faviconAttr = ${JSON.stringify(CONTROLLED_TAB_FAVICON_ATTR)};
  const faviconRelAttr = ${JSON.stringify(CONTROLLED_TAB_FAVICON_REL_ATTR)};
  const faviconId = ${JSON.stringify(CONTROLLED_TAB_FAVICON_ID)};
  const faviconHref = ${JSON.stringify(CONTROLLED_TAB_FAVICON_HREF)};

  ${RESTORE_LEGACY_FAVICON_SCRIPT}

  // Temporarily suspend all tab-icon candidates, including alternate sizes/themes.
  // Preserve their href, type, sizes and media attributes exactly as the site set them.
  for (const original of document.querySelectorAll('link[rel~="icon" i]')) {
    if (original.id === faviconId) continue;
    if (!original.hasAttribute(faviconRelAttr)) {
      original.setAttribute(faviconRelAttr, original.getAttribute("rel"));
    }
    original.removeAttribute("rel");
  }
  let icon = document.getElementById(faviconId);
  if (!icon) {
    icon = document.createElement("link");
    icon.id = faviconId;
    icon.rel = "icon";
    icon.type = "image/png";
    icon.sizes = "64x64";
    icon.setAttribute(faviconAttr, "true");
    icon.href = faviconHref;
    (document.head || document.documentElement).appendChild(icon);
  }

  const sel = "#" + badgeId;
  let style = document.getElementById(styleId);
  if (!style) {
    style = document.createElement("style");
    style.id = styleId;
    (document.head || document.documentElement).appendChild(style);
  }
  const css = sel + "{all:initial!important;position:fixed!important;inset:0!important;" +
    "display:block!important;z-index:2147483647!important;pointer-events:none!important;" +
    "background:" +
      "radial-gradient(ellipse at 25% 0,rgba(255,182,153,.32),transparent 70%) top left/65% 28px no-repeat," +
      "radial-gradient(ellipse at 85% 0,rgba(249,112,102,.22),transparent 70%) top right/60% 24px no-repeat," +
      "linear-gradient(to bottom,rgba(239,92,80,.64),rgba(249,112,102,.2) 4px,transparent 22px) top/100% 22px no-repeat," +
      "linear-gradient(to right,rgba(239,92,80,.38),rgba(249,112,102,.1) 3px,transparent 12px) left/12px 100% no-repeat," +
      "linear-gradient(to left,rgba(239,92,80,.38),rgba(249,112,102,.1) 3px,transparent 12px) right/12px 100% no-repeat," +
      "linear-gradient(to top,rgba(239,92,80,.28),transparent 10px) bottom/100% 10px no-repeat!important;}" +
    "@media print{" + sel + "{display:none!important}}" +
    "@media (forced-colors:active){" + sel + "{background:none!important;outline:2px solid Highlight!important;outline-offset:-2px!important}}";
  if (style.textContent !== css) style.textContent = css;

  let root = document.getElementById(badgeId);
  if (!root) {
    root = document.createElement("div");
    root.id = badgeId;
    document.documentElement.appendChild(root);
  }
  root.setAttribute("aria-hidden", "true");

})()`;
}

export const CONTROLLED_TAB_CLEAR_SCRIPT = `(() => {
  const badgeId = ${JSON.stringify(CONTROLLED_TAB_BADGE_ID)};
  const styleId = ${JSON.stringify(CONTROLLED_TAB_STYLE_ID)};
  const faviconAttr = ${JSON.stringify(CONTROLLED_TAB_FAVICON_ATTR)};
  const faviconRelAttr = ${JSON.stringify(CONTROLLED_TAB_FAVICON_REL_ATTR)};
  const faviconId = ${JSON.stringify(CONTROLLED_TAB_FAVICON_ID)};

  document.getElementById(badgeId)?.remove();
  document.getElementById("__pi_agent_controlled_tab_label__")?.remove();
  document.getElementById(styleId)?.remove();

  document.getElementById(faviconId)?.remove();
  for (const original of document.querySelectorAll("link[" + faviconRelAttr + "]")) {
    original.setAttribute("rel", original.getAttribute(faviconRelAttr));
    original.removeAttribute(faviconRelAttr);
  }
  ${RESTORE_LEGACY_FAVICON_SCRIPT}
})()`;

// Compact, always-correct pill text: identifies the agent and the live target it's driving.
export function controlledTabLabel(target: string): string {
  return `pi agent · ${target}`;
}
