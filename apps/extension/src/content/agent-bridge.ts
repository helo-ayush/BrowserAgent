import type {
  Action,
  ActionResponse,
  InteractiveTarget,
  TargetMapResponse,
  TargetBounds,
  ViewportInfo,
  BridgeErrorCode,
} from "../protocol";

const LOCK_ID = "agentbrow-page-lock";
let pageLocked = false;
let targetMapRevision = 0;
let lastViewportSignature = "";
let nextTargetNumber = 0;
let targetMap = new Map<string, TargetRecord>();
const elementRefs = new WeakMap<HTMLElement, string>();

type TargetRecord = InteractiveTarget & { element: HTMLElement; viewportSignature: string; revision: number };
type BridgeMessage = {
  type: string;
  action?: Action;
  locked?: boolean;
  target_map?: unknown;
  viewport?: unknown;
  viewport_revision?: number;
};

chrome.runtime.onMessage.addListener(
  (message: BridgeMessage, _sender, sendResponse) => {
    if (message.type === "SET_PAGE_LOCK") {
      pageLocked = Boolean(message.locked);
      renderPageLock(pageLocked);
      sendResponse({ ok: true, locked: pageLocked });
      return;
    }

    if (message.type === "GET_TARGET_MAP") {
      sendResponse(buildTargetMap());
      return;
    }

    if (message.type !== "EXECUTE_ACTION" || !message.action) return;
    void executeAction(message.action, Boolean(message.viewport || message.target_map)).then(sendResponse).catch((error: unknown) => {
      sendResponse(failure("EXECUTION_FAILED", error instanceof Error ? error.message : "Could not execute action."));
    });
    return true;
  },
);

function renderPageLock(locked: boolean) {
  let overlay = document.getElementById(LOCK_ID);
  if (!locked) {
    overlay?.remove();
    return;
  }

  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = LOCK_ID;
    overlay.setAttribute("role", "status");
    overlay.setAttribute("aria-live", "polite");
    overlay.innerHTML = '<span class="agentbrow-lock-label">Agent is working · page locked</span>';
    overlay.style.cssText = [
      "position:fixed",
      "inset:0",
      "z-index:2147483646",
      "border:2px solid #2f80ed",
      "background:rgba(47,128,237,.045)",
      "box-shadow:inset 0 0 0 1px rgba(255,255,255,.22), 0 0 0 1px rgba(47,128,237,.25)",
      "pointer-events:auto",
      "cursor:wait",
      "user-select:none",
      "touch-action:none",
      "font:600 12px/1.2 system-ui,sans-serif",
      "color:#165eb8",
      "text-align:center",
    ].join(";");
    const label = overlay.querySelector<HTMLElement>(".agentbrow-lock-label");
    if (label) {
      label.style.cssText = [
        "display:inline-block",
        "margin-top:10px",
        "padding:7px 12px",
        "border-radius:999px",
        "background:#fff",
        "box-shadow:0 2px 12px rgba(21,94,184,.2)",
      ].join(";");
    }
    overlay.addEventListener("pointerdown", preventUserInput, true);
    overlay.addEventListener("pointerup", preventUserInput, true);
    overlay.addEventListener("click", preventUserInput, true);
    overlay.addEventListener("wheel", preventUserInput, { capture: true, passive: false });
    overlay.addEventListener("touchmove", preventUserInput, { capture: true, passive: false });
    document.documentElement.appendChild(overlay);
  }
  overlay.style.display = "block";
}

function preventUserInput(event: Event) {
  if (!pageLocked) return;
  event.preventDefault();
  event.stopPropagation();
}

function preventUserKeyboard(event: KeyboardEvent) {
  if (!pageLocked) return;
  event.preventDefault();
  event.stopPropagation();
}

document.addEventListener("keydown", preventUserKeyboard, true);
document.addEventListener("keypress", preventUserKeyboard, true);
document.addEventListener("keyup", preventUserKeyboard, true);
document.addEventListener("wheel", preventUserInput, { capture: true, passive: false });
document.addEventListener("touchmove", preventUserInput, { capture: true, passive: false });

async function executeAction(action: Action, hasExecutionContext = false): Promise<ActionResponse> {
  const overlay = document.getElementById(LOCK_ID);

  try {
    if (action.type === "click" || action.type === "type") {
      let element: HTMLElement | null;
      let point: { x: number; y: number };
      if (action.ref) {
        const resolved = resolveTarget(action);
        if (!resolved.ok) return resolved.response;
        element = resolved.element;
        element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
        const bounds = readBounds(element);
        point = bounds ? centerOf(bounds) : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
      } else {
        const coordinate = resolveCoordinates(action.x, action.y, action.coordinateSpace, action.coordinate_space, hasExecutionContext);
        if (!coordinate) return failure("INVALID_COORDINATES", "Click coordinates are missing or outside the viewport.");
        point = coordinate;
        const prevPointerEvents = overlay?.style.pointerEvents;
        if (overlay) overlay.style.pointerEvents = "none";
        element = document.elementFromPoint(point.x, point.y) as HTMLElement | null;
        if (overlay) overlay.style.pointerEvents = prevPointerEvents || "auto";
        if (!element) return failure("NO_INTERACTIVE_TARGET", "No element is present at the requested coordinates.");
      }

      if (action.type === "type") {
        const input = findEditable(element);
        if (!input) return failure("NO_INTERACTIVE_TARGET", "The target is not editable.", { ref: action.ref });
        input.focus();
        setNativeValue(input, action.text);
        input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: action.text }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        const typeAction = action as Action & { press_enter?: boolean };
        if (typeAction.press_enter) {
          const enterInit = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
          input.dispatchEvent(new KeyboardEvent("keydown", enterInit));
          input.dispatchEvent(new KeyboardEvent("keypress", enterInit));
          input.dispatchEvent(new KeyboardEvent("keyup", enterInit));
          if (input instanceof HTMLInputElement && input.form) {
            input.form.requestSubmit?.();
          }
        }
      } else {
        simulateClick(element);
      }
      flash(point.x, point.y);
      return success(`${action.type === "type" ? "Typed into" : "Clicked"} ${action.ref ? `target ${action.ref}` : "the requested point"}.`, {
        targetValidated: Boolean(action.ref),
        x: round(point.x),
        y: round(point.y),
        devicePixelRatio: window.devicePixelRatio || 1,
      });
    } else if (action.type === "scroll") {
      window.scrollBy({ top: action.direction === "down" ? action.amount : -action.amount, behavior: "smooth" });
      return success(`Scrolled ${action.direction}.`, { targetValidated: false });
    }
    return success(`Ignored ${action.type} action in the page bridge.`, { targetValidated: false });
  } catch (error) {
    return failure("EXECUTION_FAILED", error instanceof Error ? error.message : "Could not execute action.");
  }
}

function buildTargetMap(): TargetMapResponse {
  const firstViewport = readViewport(targetMapRevision);
  if (firstViewport.signature !== lastViewportSignature) {
    targetMapRevision += 1;
    lastViewportSignature = firstViewport.signature;
  }
  const viewport = readViewport(targetMapRevision);
  const next = new Map<string, TargetRecord>();
  const targets: InteractiveTarget[] = [];

  const candidates = Array.from(document.querySelectorAll<HTMLElement>(interactiveSelector()));
  for (const candidate of candidates) {
    if (candidate.id === LOCK_ID || candidate.closest(`#${LOCK_ID}`)) continue;

    // Avoid duplicate clutter: if candidate is inside a mapped <button> or <a href>, prioritize the parent
    if (candidate.parentElement?.closest("button, a[href]")) continue;

    const bounds = readBounds(candidate);
    if (!bounds || !isVisible(candidate, bounds) || !isInteractive(candidate)) continue;

    let ref = elementRefs.get(candidate);
    if (!ref) {
      ref = `e${++nextTargetNumber}`;
      elementRefs.set(candidate, ref);
    }

    const target = buildInteractiveTarget(candidate, ref, bounds);
    const record: TargetRecord = { ...target, element: candidate, viewportSignature: viewport.signature, revision: viewport.revision };
    next.set(target.ref, record);
    targets.push(target);
  }

  targetMap = next;
  const semanticDom = buildPrunedSemanticDom(elementRefs);
  return {
    ok: true,
    summary: `${targets.length} visible interactive target${targets.length === 1 ? "" : "s"} mapped.`,
    targets,
    viewport,
    viewportSignature: viewport.signature,
    viewportRevision: viewport.revision,
    semantic_dom: semanticDom,
    semanticDom: semanticDom,
    target_map: { targets, revision: viewport.revision, viewport_signature: viewport.signature, semantic_dom: semanticDom },
    targetMap: { targets, revision: viewport.revision, viewport_signature: viewport.signature, semantic_dom: semanticDom },
    checks: { visibleOnly: true, coordinateSpace: "css", devicePixelRatio: viewport.devicePixelRatio },
  };
}

const PII_PATTERNS = [
  { regex: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g, mask: "[MASKED_CARD_01]" },
  { regex: /[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+/g, mask: "[MASKED_EMAIL_01]" },
  { regex: /\b[A-Z]{5}[0-9]{4}[A-Z]{1}\b|\b\d{4}\s?\d{4}\s?\d{4}\b/g, mask: "[MASKED_GOV_ID_01]" },
  { regex: /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g, mask: "[MASKED_PHONE_01]" },
];

function maskPII(text: string): string {
  if (!text) return "";
  let masked = text;
  for (const { regex, mask } of PII_PATTERNS) {
    masked = masked.replace(regex, mask);
  }
  return masked;
}

const DISCARD_TAGS = new Set([
  "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "LINK", "META", "HEAD",
  "IFRAME", "EMBED", "OBJECT", "CANVAS", "AUDIO", "VIDEO", "SOURCE", "TRACK"
]);

const LANDMARK_TAGS = new Set([
  "MAIN", "NAV", "HEADER", "FOOTER", "ARTICLE", "SECTION", "ASIDE", "FORM",
  "DIALOG", "TABLE", "THEAD", "TBODY", "TR", "TH", "TD", "UL", "OL", "LI",
  "FIELDSET", "LEGEND"
]);

function getDirectText(el: HTMLElement): string {
  let text = "";
  for (let i = 0; i < el.childNodes.length; i++) {
    const node = el.childNodes[i];
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent || "";
    }
  }
  return text.trim();
}

function isNodeVisible(element: HTMLElement): boolean {
  if (element.id === LOCK_ID || element.closest(`#${LOCK_ID}`)) return false;
  if (element.hasAttribute("hidden") || element.getAttribute("aria-hidden") === "true") return false;

  const style = window.getComputedStyle(element);
  if (
    style.display === "none" ||
    style.visibility === "hidden" ||
    style.visibility === "collapse" ||
    style.opacity === "0"
  ) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    return element.children.length > 0;
  }
  return true;
}

let semanticNodeCount = 0;
const MAX_SEMANTIC_NODES = 350;

function pruneNode(el: HTMLElement, elementRefs: WeakMap<HTMLElement, string>, depth: number): string[] {
  if (depth > 12 || semanticNodeCount >= MAX_SEMANTIC_NODES) return [];
  const tag = el.tagName.toUpperCase();

  // 1. Discard Rules
  if (DISCARD_TAGS.has(tag)) return [];
  if (!isNodeVisible(el)) return [];

  // SVG proxy or discard
  if (tag === "SVG") {
    const titleText = el.querySelector("title")?.textContent?.trim();
    const iconName = el.getAttribute("aria-label")?.trim() || el.getAttribute("title")?.trim() || titleText;
    if (iconName) {
      semanticNodeCount++;
      const ref = elementRefs.get(el) || (el.parentElement ? elementRefs.get(el.parentElement) : undefined);
      const refStr = ref ? ` ref="${ref}"` : "";
      return [`<icon${refStr} name="${escapeAttr(maskPII(iconName))}" />`];
    }
    return [];
  }

  // Hidden inputs discard
  if (tag === "INPUT" && (el as HTMLInputElement).type === "hidden") return [];

  // 2. Interactive Leaf Inputs
  if (tag === "INPUT") {
    semanticNodeCount++;
    const input = el as HTMLInputElement;
    const ref = elementRefs.get(el);
    const refStr = ref ? ` ref="${ref}"` : "";
    const idStr = input.id ? ` id="${escapeAttr(input.id)}"` : "";
    const typeStr = input.type ? ` type="${escapeAttr(input.type)}"` : "";
    const nameStr = input.name ? ` name="${escapeAttr(input.name)}"` : "";
    const checkStr = (input.type === "radio" || input.type === "checkbox") ? ` checked="${input.checked}"` : "";
    let valStr = "";
    if (input.type === "password") {
      valStr = ` value="[MASKED_PASSWORD]"`;
    } else if (input.value) {
      valStr = ` value="${escapeAttr(maskPII(input.value.slice(0, 50)))}"`;
    }
    const phStr = input.placeholder ? ` placeholder="${escapeAttr(maskPII(input.placeholder))}"` : "";
    const ariaLabel = input.getAttribute("aria-label");
    const ariaStr = ariaLabel ? ` aria-label="${escapeAttr(maskPII(ariaLabel))}"` : "";
    return [`<input${refStr}${idStr}${typeStr}${nameStr}${checkStr}${phStr}${valStr}${ariaStr} />`];
  }

  if (tag === "TEXTAREA") {
    semanticNodeCount++;
    const ta = el as HTMLTextAreaElement;
    const ref = elementRefs.get(el);
    const refStr = ref ? ` ref="${ref}"` : "";
    const idStr = ta.id ? ` id="${escapeAttr(ta.id)}"` : "";
    const phStr = ta.placeholder ? ` placeholder="${escapeAttr(maskPII(ta.placeholder))}"` : "";
    const text = maskPII(compactText(ta.value || ta.textContent || ""));
    return [`<textarea${refStr}${idStr}${phStr}>${escapeHtml(text.slice(0, 100))}</textarea>`];
  }

  if (tag === "SELECT") {
    semanticNodeCount++;
    const sel = el as HTMLSelectElement;
    const ref = elementRefs.get(el);
    const refStr = ref ? ` ref="${ref}"` : "";
    const idStr = sel.id ? ` id="${escapeAttr(sel.id)}"` : "";
    const options: string[] = [];
    for (const opt of Array.from(sel.options).slice(0, 15)) {
      const selected = opt.selected ? ` selected="true"` : "";
      options.push(`  <option value="${escapeAttr(opt.value)}"${selected}>${escapeHtml(maskPII(opt.text))}</option>`);
    }
    return [`<select${refStr}${idStr}>\n${options.join("\n")}\n</select>`];
  }

  // 3. Process Children for Container Elements
  const childLines: string[] = [];
  for (let i = 0; i < el.children.length; i++) {
    const child = el.children[i];
    if (child instanceof HTMLElement) {
      const res = pruneNode(child, elementRefs, depth + 1);
      for (const line of res) childLines.push(line);
      if (semanticNodeCount >= MAX_SEMANTIC_NODES) break;
    }
  }

  // 4. Buttons, Links, Labels
  if (tag === "BUTTON") {
    semanticNodeCount++;
    const ref = elementRefs.get(el);
    const refStr = ref ? ` ref="${ref}"` : "";
    const type = (el as HTMLButtonElement).type;
    const typeStr = type && type !== "button" ? ` type="${type}"` : "";
    const ariaLabel = el.getAttribute("aria-label");
    const ariaStr = ariaLabel ? ` aria-label="${escapeAttr(maskPII(ariaLabel))}"` : "";
    const text = maskPII(compactText(el.innerText || el.textContent || ""));
    const cleanText = text.length > 50 ? `${text.slice(0, 47)}…` : text;
    return [`<button${refStr}${typeStr}${ariaStr}>${escapeHtml(cleanText)}</button>`];
  }

  if (tag === "A") {
    semanticNodeCount++;
    const ref = elementRefs.get(el);
    const refStr = ref ? ` ref="${ref}"` : "";
    const rawHref = el.getAttribute("href");
    let hrefStr = "";
    if (rawHref && !rawHref.startsWith("javascript:") && rawHref !== "#") {
      const cleanHref = rawHref.length > 50 ? `${rawHref.slice(0, 47)}…` : rawHref;
      hrefStr = ` href="${escapeAttr(cleanHref)}"`;
    }
    const ariaLabel = el.getAttribute("aria-label");
    const ariaStr = ariaLabel ? ` aria-label="${escapeAttr(maskPII(ariaLabel))}"` : "";
    const text = maskPII(compactText(el.innerText || el.textContent || ""));
    const cleanText = text.length > 50 ? `${text.slice(0, 47)}…` : text;
    return [`<a${refStr}${hrefStr}${ariaStr}>${escapeHtml(cleanText)}</a>`];
  }

  if (tag === "LABEL") {
    semanticNodeCount++;
    const ref = elementRefs.get(el);
    const refStr = ref ? ` ref="${ref}"` : "";
    const htmlFor = (el as HTMLLabelElement).htmlFor || el.getAttribute("for");
    let forStr = htmlFor ? ` for="${escapeAttr(htmlFor)}"` : "";
    let extraAttrs = "";
    const targetInput = htmlFor ? document.getElementById(htmlFor) : el.querySelector("input[type='radio'], input[type='checkbox']");
    if (targetInput instanceof HTMLInputElement && (targetInput.type === "radio" || targetInput.type === "checkbox")) {
      extraAttrs = ` for-type="${targetInput.type}" checked="${targetInput.checked}"`;
    }
    if (childLines.length > 0 && !htmlFor) {
      return [`<label${refStr}${extraAttrs}>\n${childLines.map(l => "  " + l).join("\n")}\n</label>`];
    }
    const text = maskPII(compactText(el.innerText || el.textContent || ""));
    const cleanText = text.length > 50 ? `${text.slice(0, 47)}…` : text;
    return [`<label${refStr}${forStr}${extraAttrs}>${escapeHtml(cleanText)}</label>`];
  }

  // 5. Headings
  if (/^H[1-6]$/.test(tag)) {
    semanticNodeCount++;
    const text = maskPII(compactText(el.innerText || el.textContent || ""));
    const cleanText = text.length > 80 ? `${text.slice(0, 77)}…` : text;
    return [`<${tag.toLowerCase()}>${escapeHtml(cleanText)}</${tag.toLowerCase()}>`];
  }

  // 6. Paragraphs and Blockquotes
  if (tag === "P" || tag === "BLOCKQUOTE") {
    if (childLines.length > 0) {
      semanticNodeCount++;
      return [`<${tag.toLowerCase()}>\n${childLines.map(l => "  " + l).join("\n")}\n</${tag.toLowerCase()}>`];
    }
    const text = maskPII(compactText(el.innerText || el.textContent || ""));
    if (!text) return [];
    semanticNodeCount++;
    const cleanText = text.length > 150 ? `${text.slice(0, 147)}…` : text;
    return [`<${tag.toLowerCase()}>${escapeHtml(cleanText)}</${tag.toLowerCase()}>`];
  }

  // 7. Structural Landmarks
  if (LANDMARK_TAGS.has(tag)) {
    const lTag = tag.toLowerCase();
    const ref = elementRefs.get(el);
    const refStr = ref ? ` ref="${ref}"` : "";
    const idStr = el.id ? ` id="${escapeAttr(el.id)}"` : "";
    const ariaLabel = el.getAttribute("aria-label");
    const ariaStr = ariaLabel ? ` aria-label="${escapeAttr(maskPII(ariaLabel))}"` : "";

    if (childLines.length === 0) {
      const text = maskPII(compactText(el.innerText || el.textContent || ""));
      if (!text && !ref) return [];
      semanticNodeCount++;
      return [`<${lTag}${refStr}${idStr}${ariaStr}>${escapeHtml(text.slice(0, 60))}</${lTag}>`];
    }
    semanticNodeCount++;
    return [`<${lTag}${refStr}${idStr}${ariaStr}>\n${childLines.map(l => "  " + l).join("\n")}\n</${lTag}>`];
  }

  // 8. Presentational Containers (DIV, SPAN, etc.)
  const ref = elementRefs.get(el);
  if (ref) {
    semanticNodeCount++;
    const role = getRole(el) || el.getAttribute("role") || "button";
    const ariaLabel = el.getAttribute("aria-label");
    const ariaStr = ariaLabel ? ` aria-label="${escapeAttr(maskPII(ariaLabel))}"` : "";
    if (childLines.length === 0) {
      const text = maskPII(compactText(el.innerText || el.textContent || ""));
      return [`<${el.tagName.toLowerCase()} ref="${ref}" role="${role}"${ariaStr}>${escapeHtml(text.slice(0, 50))}</${el.tagName.toLowerCase()}>`];
    }
    return [`<${el.tagName.toLowerCase()} ref="${ref}" role="${role}"${ariaStr}>\n${childLines.map(l => "  " + l).join("\n")}\n</${el.tagName.toLowerCase()}>`];
  }

  // If not interactive:
  if (childLines.length === 0) {
    // Check for standalone text indicator (badges, prices, status messages)
    const directText = maskPII(compactText(getDirectText(el) || el.textContent || ""));
    if (directText && directText.length >= 2 && directText.length <= 100) {
      semanticNodeCount++;
      return [`<${el.tagName.toLowerCase()}>${escapeHtml(directText)}</${el.tagName.toLowerCase()}>`];
    }
    return []; // Empty container discarded
  }

  // Tree Un-nesting: promote child lines directly up the tree!
  return childLines;
}

function buildPrunedSemanticDom(elementRefs: WeakMap<HTMLElement, string>): string {
  try {
    semanticNodeCount = 0;
    const body = document.body;
    if (!body) return "";
    const lines = pruneNode(body, elementRefs, 0);
    const joined = lines.map(l => "  " + l).join("\n");
    return `<main>\n${joined}\n</main>`.slice(0, 16000);
  } catch {
    return "";
  }
}

function buildInteractiveTarget(candidate: HTMLElement, ref: string, bounds: TargetBounds): InteractiveTarget {
  let role = getRole(candidate);
  const name = getAccessibleName(candidate);
  const tag = candidate.tagName.toLowerCase();
  const type = candidate.getAttribute("type") || (candidate instanceof HTMLInputElement ? candidate.type : undefined);
  const placeholder = candidate.getAttribute("placeholder") || undefined;
  const value = candidate instanceof HTMLInputElement || candidate instanceof HTMLTextAreaElement ? candidate.value : undefined;
  const title = candidate.getAttribute("title") || undefined;
  const ariaLabel = candidate.getAttribute("aria-label") || undefined;
  const className = candidate.className && typeof candidate.className === "string" ? candidate.className.trim().split(/\s+/).slice(0, 3).join(" ") : undefined;
  const href = candidate instanceof HTMLAnchorElement ? candidate.getAttribute("href") || undefined : undefined;

  const attrs: string[] = [`ref="${ref}"`];
  if (role && role !== tag) attrs.push(`role="${escapeAttr(role)}"`);
  if (type) attrs.push(`type="${escapeAttr(type)}"`);
  if (candidate.id) attrs.push(`id="${escapeAttr(candidate.id)}"`);
  if (candidate.getAttribute("name")) attrs.push(`name="${escapeAttr(candidate.getAttribute("name")!)}"`);

  // Check / Selection status (critical for radio buttons and checkboxes)
  if (candidate instanceof HTMLInputElement && (candidate.type === "radio" || candidate.type === "checkbox")) {
    attrs.push(`checked="${candidate.checked}"`);
  } else if (candidate.hasAttribute("aria-checked")) {
    attrs.push(`aria-checked="${escapeAttr(candidate.getAttribute("aria-checked")!)}"`);
  } else if (candidate.hasAttribute("aria-selected")) {
    attrs.push(`aria-selected="${escapeAttr(candidate.getAttribute("aria-selected")!)}"`);
  }

  // Label handling: include for and target input's state
  if (tag === "label") {
    const htmlFor = candidate.getAttribute("for");
    let targetInput: HTMLElement | null = null;
    if (htmlFor) {
      attrs.push(`for="${escapeAttr(htmlFor)}"`);
      targetInput = document.getElementById(htmlFor);
    } else {
      targetInput = candidate.querySelector("input[type='radio'], input[type='checkbox']");
    }
    if (targetInput instanceof HTMLInputElement && (targetInput.type === "radio" || targetInput.type === "checkbox")) {
      attrs.push(`for-type="${targetInput.type}"`);
      attrs.push(`checked="${targetInput.checked}"`);
      if (!role) role = targetInput.type;
    }
  }

  // If input without accessible name, find associated label text
  if (candidate instanceof HTMLInputElement && !name) {
    const labelElem = candidate.labels?.[0] || (candidate.id ? document.querySelector(`label[for="${candidate.id}"]`) : null);
    if (labelElem?.textContent) {
      attrs.push(`label="${escapeAttr(compactText(labelElem.textContent))}"`);
    }
  }

  if (title) attrs.push(`title="${escapeAttr(title)}"`);
  if (ariaLabel) attrs.push(`aria-label="${escapeAttr(ariaLabel)}"`);
  if (placeholder) attrs.push(`placeholder="${escapeAttr(placeholder)}"`);
  if (value && tag === "input") attrs.push(`value="${escapeAttr(value.slice(0, 40))}"`);
  if (href) {
    const cleanHref = href.length > 50 ? `${href.slice(0, 47)}…` : href;
    attrs.push(`href="${escapeAttr(cleanHref)}"`);
  }
  if (className) attrs.push(`class="${escapeAttr(className)}"`);
  attrs.push(`bounds="[${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}]"`);

  let snippet = "";
  if (tag === "input" || tag === "img") {
    snippet = `<${tag} ${attrs.join(" ")} />`;
  } else {
    const textContent = name || compactText(candidate.innerText || candidate.textContent || "");
    const cleanContent = textContent.length > 50 ? `${textContent.slice(0, 47)}…` : textContent;
    snippet = `<${tag} ${attrs.join(" ")}>${escapeHtml(cleanContent)}</${tag}>`;
  }

  return {
    ref,
    role,
    name,
    id: candidate.id || undefined,
    tag,
    type,
    placeholder,
    value: value?.slice(0, 40),
    title,
    className,
    href,
    snippet,
    bounds,
    fingerprint: fingerprint(candidate, role, name),
  };
}

function escapeAttr(val: string): string {
  return val.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeHtml(val: string): string {
  return val.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function findClickableTarget(element: HTMLElement): HTMLElement {
  const clickable = element.closest<HTMLElement>(
    "button, a[href], [role='button'], [role='radio'], [role='checkbox'], [role='tab'], label, input, textarea, select, [tabindex]:not([tabindex='-1']), [onclick], summary, [contenteditable='true']"
  );
  return clickable || element;
}

function resolveTarget(action: Extract<Action, { type: "click" | "type" }>): { ok: true; element: HTMLElement } | { ok: false; response: ActionResponse } {
  const ref = action.ref!;
  const record = targetMap.get(ref);
  if (!record) {
    return { ok: false, response: failure("TARGET_NOT_FOUND", `Target ${ref} is not in the current target map.`, { ref }) };
  }

  // If the recorded element is still attached to the DOM, target it directly
  if (record.element.isConnected) {
    const clickable = findClickableTarget(record.element);
    clickable.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    return { ok: true, element: clickable };
  }

  // Fallback: look for an element with matching id or fingerprint in the active DOM
  if (record.id) {
    const freshById = document.getElementById(record.id);
    if (freshById) {
      const clickable = findClickableTarget(freshById);
      clickable.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      return { ok: true, element: clickable };
    }
  }

  return { ok: false, response: failure("TARGET_MISMATCH", `Target ${ref} was removed from the page DOM.`, { ref }) };
}

function resolveCoordinates(x: number | undefined, y: number | undefined, space?: "normalized" | "css" | "device-pixels", wireSpace?: "normalized_1000", hasExecutionContext = false) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const width = window.innerWidth;
  const height = window.innerHeight;
  const dpr = Math.max(window.devicePixelRatio || 1, 1);
  let cssX: number;
  let cssY: number;
  const normalized = space === "normalized" || wireSpace === "normalized_1000" || (!space && !wireSpace && !hasExecutionContext && x! >= 0 && x! <= 1000 && y! >= 0 && y! <= 1000);
  if (normalized) {
    cssX = (x! / 1000) * width;
    cssY = (y! / 1000) * height;
  } else if (space === "device-pixels" || (!space && !wireSpace && !hasExecutionContext && (x! > 1000 || y! > 1000))) {
    cssX = x! / dpr;
    cssY = y! / dpr;
  } else {
    cssX = x!;
    cssY = y!;
  }
  if (cssX < 0 || cssY < 0 || cssX >= width || cssY >= height) return null;
  return { x: cssX, y: cssY };
}

function readViewport(revision: number): ViewportInfo {
  const width = Math.max(0, Math.round(window.innerWidth));
  const height = Math.max(0, Math.round(window.innerHeight));
  const devicePixelRatio = Math.max(window.devicePixelRatio || 1, 1);
  const scale = window.visualViewport?.scale || 1;
  // Viewport signature based on dimensions and scale, excluding scroll coordinates so normal page scrolls don't invalidate
  const signature = `${width}x${height}@${devicePixelRatio}x${scale}`;
  return { width, height, devicePixelRatio, device_pixel_ratio: devicePixelRatio, signature, revision };
}

function interactiveSelector() {
  return "a[href],area[href],button,input,textarea,select,summary,[contenteditable='true'],[onclick],[tabindex]:not([tabindex='-1']),[role],[data-action],label";
}

function isInteractive(element: HTMLElement) {
  const role = getRole(element);
  const interactiveRoles = new Set([
    "button", "link", "checkbox", "combobox", "menuitem", "menuitemcheckbox",
    "menuitemradio", "option", "radio", "searchbox", "slider", "spinbutton",
    "switch", "tab", "textbox", "treeitem"
  ]);
  if (role && interactiveRoles.has(role)) return true;
  if (element.matches("a[href],area[href],button,input,textarea,select,summary,[contenteditable='true'],[onclick],[tabindex]:not([tabindex='-1']),[data-action],label")) {
    return true;
  }

  // Detect clickable controls with cursor: pointer (excluding document root / large container divs)
  const style = window.getComputedStyle(element);
  if (style.cursor === "pointer" && element.tagName !== "BODY" && element.tagName !== "HTML") {
    const rect = element.getBoundingClientRect();
    const area = rect.width * rect.height;
    const windowArea = window.innerWidth * window.innerHeight;
    if (area < windowArea * 0.75) return true;
  }

  return false;
}

function isVisible(element: HTMLElement, bounds: TargetBounds) {
  const style = getComputedStyle(element);
  const disabled = (element instanceof HTMLButtonElement || element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) && element.disabled;
  return style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse" && style.opacity !== "0"
    && bounds.width >= 3 && bounds.height >= 3 && bounds.x < window.innerWidth && bounds.y < window.innerHeight
    && bounds.x + bounds.width > 0 && bounds.y + bounds.height > 0
    && !element.hasAttribute("hidden") && !disabled;
}

function readBounds(element: HTMLElement): TargetBounds | null {
  if (!element.isConnected) return null;
  const rect = element.getBoundingClientRect();
  return { x: round(rect.x), y: round(rect.y), width: round(rect.width), height: round(rect.height) };
}

function centerOf(bounds: TargetBounds) {
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

function getRole(element: HTMLElement) {
  const explicit = element.getAttribute("role")?.trim().toLowerCase().split(/\s+/, 1)[0];
  if (explicit) return explicit;
  if (element instanceof HTMLAnchorElement || element instanceof HTMLAreaElement) return "link";
  if (element instanceof HTMLButtonElement || element.matches("[onclick]")) return "button";
  if (element instanceof HTMLTextAreaElement || element.isContentEditable) return "textbox";
  if (element instanceof HTMLSelectElement) return "combobox";
  if (element instanceof HTMLInputElement) {
    const type = element.type.toLowerCase();
    return type === "checkbox" ? "checkbox" : type === "radio" ? "radio" : type === "range" ? "slider" : type === "button" || type === "submit" || type === "reset" ? "button" : "textbox";
  }
  if (element instanceof HTMLElement && element.tabIndex >= 0) return "button";
  return "";
}

function getAccessibleName(element: HTMLElement): string {
  // 1. Explicit ARIA
  const ariaLabel = element.getAttribute("aria-label")?.trim();
  if (ariaLabel) return compactText(ariaLabel);

  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim();
    if (text) return compactText(text);
  }

  // 2. Title & Alt
  const title = element.getAttribute("title")?.trim();
  if (title) return compactText(title);

  const alt = element.getAttribute("alt")?.trim();
  if (alt) return compactText(alt);

  // 3. Form input specifics
  if (element instanceof HTMLInputElement) {
    if (element.labels?.[0]?.textContent) return compactText(element.labels[0].textContent);
    if (element.placeholder) return compactText(element.placeholder);
    if (element.value && (element.type === "submit" || element.type === "button" || element.type === "reset")) {
      return compactText(element.value);
    }
  }

  // 4. Children (SVG title, image alt, icon title)
  const childSvgTitle = element.querySelector("svg title")?.textContent?.trim();
  if (childSvgTitle) return compactText(childSvgTitle);

  const childSvgLabel = element.querySelector("svg")?.getAttribute("aria-label")?.trim();
  if (childSvgLabel) return compactText(childSvgLabel);

  const childImgAlt = element.querySelector("img")?.getAttribute("alt")?.trim() || element.querySelector("img")?.getAttribute("title")?.trim();
  if (childImgAlt) return compactText(childImgAlt);

  // 5. Direct text content
  const text = (element.innerText || element.textContent || "").trim();
  if (text) return compactText(text);

  // 6. Descriptive fallback from id or name
  const idOrName = element.id || element.getAttribute("name") || "";
  if (idOrName && !idOrName.startsWith(":")) {
    const readable = idOrName.replace(/[-_]/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
    if (readable.length > 2 && readable.length < 40) return compactText(readable);
  }

  return "";
}

function compactText(value: string) {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

function fingerprint(element: HTMLElement, role: string, name: string) {
  const identity = [element.tagName.toLowerCase(), role, name, element.id, element.getAttribute("name") || "", element.getAttribute("type") || "", element.getAttribute("href") || "", domPath(element)].join("|");
  let hash = 2166136261;
  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `f${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function domPath(element: HTMLElement) {
  const parts: string[] = [];
  let current: HTMLElement | null = element;
  while (current && current !== document.body && parts.length < 6) {
    let part = current.tagName.toLowerCase();
    if (current.id) part += `#${current.id}`;
    else if (current.parentElement) part += `:nth-child(${Array.from(current.parentElement.children).indexOf(current) + 1})`;
    parts.unshift(part);
    current = current.parentElement;
  }
  return parts.join(">");
}

function success(summary: string, checks: Record<string, string | number | boolean>): ActionResponse {
  return { ok: true, summary, checks: { ...checks, viewportRevision: targetMapRevision } };
}

function failure(code: BridgeErrorCode, message: string, details: Partial<Pick<import("../protocol").BridgeError, "ref" | "expected" | "actual">> = {}): ActionResponse {
  return {
    ok: false,
    summary: message,
    reason: message,
    error: { code, message, ...details },
    checks: { viewportRevision: targetMapRevision, devicePixelRatio: window.devicePixelRatio || 1 },
  };
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}

function findEditable(element: HTMLElement): HTMLInputElement | HTMLTextAreaElement | HTMLElement | null {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element.isContentEditable) return element;
  const closest = element.closest<HTMLElement>("input, textarea, [contenteditable='true']");
  if (closest) return closest;
  return element.querySelector<HTMLElement>("input:not([type='hidden']), textarea, [contenteditable='true']");
}

function setNativeValue(element: HTMLElement, value: string) {
  if (element instanceof HTMLInputElement) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    if (setter) {
      setter.call(element, value);
    } else {
      element.value = value;
    }
  } else if (element instanceof HTMLTextAreaElement) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    if (setter) {
      setter.call(element, value);
    } else {
      element.value = value;
    }
  } else {
    element.textContent = value;
  }
}

function simulateClick(element: HTMLElement) {
  const clickable = findClickableTarget(element);
  clickable.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const rect = clickable.getBoundingClientRect();
  const clientX = Math.round(rect.left + rect.width / 2);
  const clientY = Math.round(rect.top + rect.height / 2);
  const init: MouseEventInit = { bubbles: true, cancelable: true, view: window, clientX, clientY };

  clickable.dispatchEvent(new PointerEvent("pointerover", init));
  clickable.dispatchEvent(new MouseEvent("mouseover", init));
  clickable.dispatchEvent(new PointerEvent("pointerdown", init));
  clickable.dispatchEvent(new MouseEvent("mousedown", init));
  clickable.focus();
  clickable.dispatchEvent(new PointerEvent("pointerup", init));
  clickable.dispatchEvent(new MouseEvent("mouseup", init));
  clickable.dispatchEvent(new MouseEvent("click", init));

  if (typeof clickable.click === "function") {
    clickable.click();
  }
  if (element !== clickable && typeof element.click === "function") {
    element.click();
  }

  // Radio / Checkbox framework synchronization:
  const label = element instanceof HTMLLabelElement ? element : (element.closest("label") || clickable.closest("label"));
  let input: HTMLInputElement | null = null;
  if (element instanceof HTMLInputElement && (element.type === "radio" || element.type === "checkbox")) {
    input = element;
  } else if (clickable instanceof HTMLInputElement && (clickable.type === "radio" || clickable.type === "checkbox")) {
    input = clickable;
  } else if (label) {
    const htmlFor = label.htmlFor || label.getAttribute("for");
    if (htmlFor) {
      input = document.getElementById(htmlFor) as HTMLInputElement | null;
    }
    if (!input) {
      input = label.querySelector("input[type='radio'], input[type='checkbox']") as HTMLInputElement | null;
    }
  }

  if (input) {
    if (input.type === "radio") {
      input.checked = true;
    } else if (input.type === "checkbox") {
      input.checked = !input.checked;
    }
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    try {
      input.click();
    } catch {}
  }
}

function flash(x: number, y: number) {
  const marker = document.createElement("div");
  marker.style.cssText = `position:fixed;z-index:2147483647;left:${x - 10}px;top:${y - 10}px;width:20px;height:20px;border:3px solid #2f80ed;border-radius:50%;pointer-events:none;box-shadow:0 0 0 8px #2f80ed33;`;
  document.documentElement.appendChild(marker);
  setTimeout(() => marker.remove(), 700);
}
