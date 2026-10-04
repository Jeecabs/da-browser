// Page scripts for handing the controlled tab to the person, injected via `agent-browser
// eval`. The ask shows as a bar across the top of the page, so they see what is wanted
// where they are looking. In pick mode the element under the pointer is outlined, and a
// click is captured (not delivered to the page) and described for the agent.

const ROOT_ID = "__da_browser_handoff__";
const RESULT_KEY = "__daBrowserHandoff";

export interface PickedElement {
  tag: string;
  role?: string;
  name?: string;
  text?: string;
  selector: string;
  href?: string;
  value?: string;
  rect: { x: number; y: number; width: number; height: number };
}

export type HandoffPageResult = { status: "picked"; element: PickedElement } | { status: "cancelled" };

export function handoffShowScript(ask: string, pick: boolean): string {
  return `(() => {
  const rootId = ${JSON.stringify(ROOT_ID)};
  const resultKey = ${JSON.stringify(RESULT_KEY)};
  const ask = ${JSON.stringify(ask)};
  const pick = ${JSON.stringify(pick)};
  document.getElementById(rootId)?.remove();
  window[resultKey] = undefined;

  const root = document.createElement("div");
  root.id = rootId;
  root.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;font:13px/1.4 -apple-system,system-ui,sans-serif";
  const bar = document.createElement("div");
  bar.style.cssText = "position:absolute;top:12px;left:50%;transform:translateX(-50%);max-width:min(720px,90vw);padding:8px 14px;border-radius:10px;background:#1f1e1d;color:#faf9f5;box-shadow:0 6px 24px rgba(0,0,0,.25);border:1px solid #D97757;pointer-events:auto";
  const title = document.createElement("div");
  title.textContent = pick ? "Claude asks you to point at something" : "Claude asks for your help";
  title.style.cssText = "color:#D97757;font-weight:600;margin-bottom:2px";
  const body = document.createElement("div");
  body.textContent = ask;
  const foot = document.createElement("div");
  foot.textContent = pick ? "Click the element. Esc cancels." : "Finish here, then press Done in Claude Code.";
  foot.style.cssText = "opacity:.6;margin-top:4px;font-size:12px";
  bar.append(title, body, foot);
  root.append(bar);
  document.documentElement.append(root);
  if (!pick) return "shown";

  const outline = document.createElement("div");
  outline.style.cssText = "position:fixed;border:2px solid #D97757;background:rgba(217,119,87,.12);border-radius:4px;pointer-events:none;transition:all 60ms;display:none";
  root.append(outline);

  const cssPath = el => {
    if (el.id && document.querySelectorAll("#" + CSS.escape(el.id)).length === 1) return "#" + CSS.escape(el.id);
    const testid = el.getAttribute("data-testid");
    if (testid) return '[data-testid="' + testid.replace(/"/g, '\\\\"') + '"]';
    const parts = [];
    for (let node = el; node && node.nodeType === 1 && node !== document.documentElement; node = node.parentElement) {
      let part = node.localName;
      const parent = node.parentElement;
      if (parent) {
        const same = [...parent.children].filter(child => child.localName === node.localName);
        if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
      }
      parts.unshift(part);
      if (node.id) { parts[0] = "#" + CSS.escape(node.id); break; }
    }
    return parts.join(" > ");
  };
  const implicitRole = el => {
    const tag = el.localName;
    if (tag === "a" && el.hasAttribute("href")) return "link";
    if (tag === "button" || (tag === "input" && ["button", "submit", "reset"].includes(el.type))) return "button";
    if (tag === "input" && el.type === "checkbox") return "checkbox";
    if (tag === "input" && el.type === "radio") return "radio";
    if (tag === "input" || tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "img") return "img";
    return undefined;
  };
  const describe = el => {
    const label = el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("title") || el.getAttribute("placeholder")
      || (el.labels && el.labels[0] && el.labels[0].innerText) || "";
    const text = (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim();
    const r = el.getBoundingClientRect();
    return {
      tag: el.localName,
      role: el.getAttribute("role") || implicitRole(el),
      name: (label || text).slice(0, 120) || undefined,
      text: text.slice(0, 300) || undefined,
      selector: cssPath(el),
      href: el.href || undefined,
      value: "value" in el && typeof el.value === "string" && el.type !== "password" ? el.value.slice(0, 120) || undefined : undefined,
      rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
    };
  };
  const target = event => {
    const el = event.target;
    return el && el.nodeType === 1 && !root.contains(el) ? el : undefined;
  };
  const onMove = event => {
    const el = target(event);
    if (!el) return;
    const r = el.getBoundingClientRect();
    outline.style.display = "block";
    outline.style.left = r.left - 2 + "px";
    outline.style.top = r.top - 2 + "px";
    outline.style.width = r.width + 4 + "px";
    outline.style.height = r.height + 4 + "px";
  };
  const swallow = event => { if (target(event)) { event.preventDefault(); event.stopPropagation(); } };
  const finish = result => {
    window[resultKey] = result;
    removeEventListener("mousemove", onMove, true);
    for (const type of ["click", "mousedown", "mouseup", "pointerdown", "pointerup"]) removeEventListener(type, type === "click" ? onClick : swallow, true);
    removeEventListener("keydown", onKey, true);
    root.remove();
  };
  const onClick = event => {
    const el = target(event);
    if (!el) return;
    event.preventDefault();
    event.stopPropagation();
    finish({ status: "picked", element: describe(el) });
  };
  const onKey = event => { if (event.key === "Escape") { event.preventDefault(); finish({ status: "cancelled" }); } };
  addEventListener("mousemove", onMove, true);
  for (const type of ["mousedown", "mouseup", "pointerdown", "pointerup"]) addEventListener(type, swallow, true);
  addEventListener("click", onClick, true);
  addEventListener("keydown", onKey, true);
  return "picking";
})()`;
}

/** Reads the person's answer: JSON once they picked or cancelled in the page, else "". */
export const HANDOFF_POLL_SCRIPT = `(() => { const r = window[${JSON.stringify(RESULT_KEY)}]; return r ? JSON.stringify(r) : ""; })()`;

/** Takes the bar (and any picker) down, for a handoff that ended outside the page. */
export const HANDOFF_CLEAR_SCRIPT = `(() => { document.getElementById(${JSON.stringify(ROOT_ID)})?.remove(); window[${JSON.stringify(RESULT_KEY)}] = { status: "cancelled" }; return "cleared"; })()`;

/** Parses the poll's output; agent-browser may print the eval result JSON-quoted. */
export function parseHandoffPoll(output: string): HandoffPageResult | undefined {
  let text = output.trim();
  if (!text) return undefined;
  try {
    if (text.startsWith('"')) text = JSON.parse(text) as string;
    if (!text) return undefined;
    const parsed = JSON.parse(text) as HandoffPageResult;
    return parsed && (parsed.status === "picked" || parsed.status === "cancelled") ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** The picked element in words the agent can act on: a browser_find locator first. */
export function describePicked(element: PickedElement): string {
  const lines = [`The user picked: <${element.tag}>${element.role ? ` role=${element.role}` : ""}${element.name ? ` name="${element.name}"` : ""}`];
  if (element.role && element.name) lines.push(`browser_find: locator=role value=${element.role} name="${element.name}"`);
  lines.push(`CSS selector: ${element.selector}`);
  if (element.text && element.text !== element.name) lines.push(`Text: ${element.text}`);
  if (element.href) lines.push(`href: ${element.href}`);
  if (element.value) lines.push(`Value: ${element.value}`);
  lines.push(`Box: ${element.rect.width}x${element.rect.height} at ${element.rect.x},${element.rect.y}`);
  return lines.join("\n");
}
