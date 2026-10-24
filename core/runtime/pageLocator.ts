/**
 * Host verification locators. Prefer role/name, label, or visible text for
 * behavior the story describes. Reserve CSS for baseline elements or IDs the
 * story itself requires.
 */
export type PageLocator =
  | { css: string }
  | { role: string; name: string }
  | { label: string }
  | { text: string };

export function parsePageLocator(raw: unknown): PageLocator | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  if (typeof record.css === 'string' && record.css.trim()) {
    return { css: record.css.trim() };
  }
  if (typeof record.role === 'string' && record.role.trim() && typeof record.name === 'string') {
    return { role: record.role.trim(), name: record.name };
  }
  if (typeof record.label === 'string') {
    return { label: record.label };
  }
  if (typeof record.text === 'string') {
    return { text: record.text };
  }
  return undefined;
}

export function resolveInspectLocator(step: {
  selector?: string;
  locator?: PageLocator | unknown;
}): PageLocator | null {
  const parsed = parsePageLocator(step.locator);
  if (parsed) return parsed;
  if (typeof step.selector === 'string' && step.selector.trim()) {
    return { css: step.selector.trim() };
  }
  return null;
}

export function locatorRef(locator: PageLocator): string {
  if ('css' in locator) return locator.css;
  const ordered: Record<string, string> = {};
  for (const key of Object.keys(locator).sort()) {
    ordered[key] = String((locator as Record<string, string>)[key]);
  }
  return JSON.stringify(ordered);
}

export function describeLocator(locator: PageLocator): string {
  if ('css' in locator) return locator.css;
  if ('role' in locator) return `${locator.role} "${locator.name}"`;
  if ('label' in locator) return `label "${locator.label}"`;
  return `text "${locator.text}"`;
}

/**
 * In-page finder used by CDP Runtime.evaluate. Keep this string free of
 * template interpolation so it can be injected verbatim.
 */
export const PAGE_LOCATOR_RUNTIME = `
function kdkVisibleText(el) {
  return String(el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
}
function kdkAccessibleName(el) {
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const parts = labelledBy.split(/\\s+/).map(function (id) {
      const node = document.getElementById(id);
      return node ? kdkVisibleText(node) : '';
    }).filter(Boolean);
    if (parts.length) return parts.join(' ');
  }
  const aria = el.getAttribute('aria-label');
  if (aria && aria.trim()) return aria.trim();
  if (el.id) {
    const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(el.id) : el.id.replace(/"/g, '\\\\"');
    const lab = document.querySelector('label[for="' + escaped + '"]');
    if (lab) return kdkVisibleText(lab);
  }
  const wrapping = el.closest && el.closest('label');
  if (wrapping) return kdkVisibleText(wrapping);
  const placeholder = el.getAttribute('placeholder');
  if (placeholder && placeholder.trim()) return placeholder.trim();
  const title = el.getAttribute('title');
  if (title && title.trim()) return title.trim();
  const alt = el.getAttribute('alt');
  if (alt && alt.trim()) return alt.trim();
  return kdkVisibleText(el);
}
function kdkImplicitRole(el) {
  const explicit = el.getAttribute('role');
  if (explicit && explicit.trim()) return explicit.trim().toLowerCase();
  const tag = el.tagName;
  if (tag === 'BUTTON') return 'button';
  if (tag === 'A') return 'link';
  if (tag === 'TEXTAREA') return 'textbox';
  if (tag === 'SELECT') return 'combobox';
  if (tag === 'IMG') return 'img';
  if (tag === 'NAV') return 'navigation';
  if (tag === 'MAIN') return 'main';
  if (tag === 'HEADER') return 'banner';
  if (tag === 'FOOTER') return 'contentinfo';
  if (tag === 'UL' || tag === 'OL') return 'list';
  if (tag === 'LI') return 'listitem';
  if (tag === 'H1' || tag === 'H2' || tag === 'H3' || tag === 'H4' || tag === 'H5' || tag === 'H6') return 'heading';
  if (tag === 'INPUT') {
    const t = String(el.type || 'text').toLowerCase();
    if (t === 'button' || t === 'submit' || t === 'reset') return 'button';
    if (t === 'checkbox') return 'checkbox';
    if (t === 'radio') return 'radio';
    if (t === 'hidden') return null;
    return 'textbox';
  }
  return null;
}
function kdkIsPressed(el) {
  if (el.getAttribute('aria-pressed') === 'true') return true;
  const current = el.getAttribute('aria-current');
  if (current === 'true' || current === 'page') return true;
  return el.getAttribute('aria-selected') === 'true';
}
function kdkNorm(value) {
  return String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
}
function kdkParseLocatorRef(ref) {
  if (typeof ref === 'string' && ref.charAt(0) === '{') {
    try { return JSON.parse(ref); } catch (err) { return { css: ref }; }
  }
  return { css: String(ref || '') };
}
function kdkFindByLocator(locator) {
  if (!locator) return null;
  if (locator.css) return document.querySelector(locator.css);
  const candidates = Array.prototype.slice.call(document.querySelectorAll('body *'));
  if (locator.role && locator.name != null) {
    const wantedRole = kdkNorm(locator.role);
    const wantedName = kdkNorm(locator.name);
    for (let i = 0; i < candidates.length; i += 1) {
      const el = candidates[i];
      if (kdkImplicitRole(el) !== wantedRole) continue;
      if (kdkNorm(kdkAccessibleName(el)) === wantedName) return el;
    }
    return null;
  }
  if (locator.label != null) {
    const wanted = kdkNorm(locator.label);
    for (let i = 0; i < candidates.length; i += 1) {
      const el = candidates[i];
      const tag = el.tagName;
      if (!/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(tag) && !el.getAttribute('role')) continue;
      if (kdkNorm(kdkAccessibleName(el)) === wanted) return el;
    }
    return null;
  }
  if (locator.text != null) {
    const wanted = kdkNorm(locator.text);
    const matches = [];
    for (let i = 0; i < candidates.length; i += 1) {
      const el = candidates[i];
      if (kdkNorm(kdkVisibleText(el)) === wanted) matches.push(el);
    }
    if (!matches.length) return null;
    matches.sort(function (a, b) {
      const aLen = kdkVisibleText(a).length;
      const bLen = kdkVisibleText(b).length;
      if (aLen !== bLen) return aLen - bLen;
      return a.querySelectorAll('*').length - b.querySelectorAll('*').length;
    });
    return matches[0];
  }
  return null;
}
function kdkProbeElement(el) {
  if (!el) {
    return {
      found: false, value: '', text: '', hiddenAttr: false,
      display: '', visibility: '', opacity: '', focused: false, pressed: false,
    };
  }
  const cs = getComputedStyle(el);
  return {
    found: true,
    value: typeof el.value === 'string' ? el.value : '',
    text: kdkVisibleText(el),
    hiddenAttr: Boolean(el.hidden),
    display: cs.display,
    visibility: cs.visibility,
    opacity: cs.opacity,
    focused: document.activeElement === el,
    pressed: kdkIsPressed(el),
  };
}
`;
