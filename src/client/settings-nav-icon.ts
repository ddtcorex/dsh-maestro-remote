/**
 * Mark this plugin's row in the DSH settings navigation so a style block can
 * replace the shell's fallback gear with the maestro glyph.
 *
 * DSH 0.1.x projects only `id`, `order`, and `label` from a `settings.section`
 * registration and picks icons from a closed built-in list, so each external
 * plugin identifies its own localized row by visible text after the dialog
 * mounts. The marker owns no shell structure and is removed on disposal.
 */

/**
 * This package's own marker.
 *
 * The name MUST be unique across plugins. `registerSettingsNavIcon` clears its
 * marker from any row that is not its own section, so two plugins sharing one
 * name fight over the same attribute and only the last `sync()` survives. Four
 * wave-2 sections shipped the identical name copied from gateway, three of them
 * silently lost their nav icon, and nothing logged.
 */
export const SETTINGS_NAV_MARKER = 'data-maestro-remote-settings-nav'

/** Minimal DOM surface used here; tests inject a stub instead of `document`. */
type NodeSeq = Iterable<Element> & { forEach(fn: (el: Element) => void): unknown };

interface DomScope {
  querySelectorAll(selector: string): NodeSeq
}

type ElementLike = Element & {
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
  hasAttribute(name: string): boolean
};

export function registerSettingsNavIcon(
  label: () => string,
  root?: DomScope,
): () => void {
  if (typeof document === 'undefined' && root === undefined) {
    // Node-side import safety (tests inject a stub root instead).
    return () => {};
  }
  const scope = (root ?? document) as DomScope;

  let disposed = false;

  const sync = () => {
    if (disposed) return;
    const currentLabel = label().trim();
    const buttons = scope.querySelectorAll('[role="dialog"] nav button');
    for (const button of Array.from(buttons)) {
      const el = button as ElementLike;
      const matches =
        currentLabel.length > 0 &&
        button.textContent != null &&
        button.textContent.trim() === currentLabel;
      if (matches) el.setAttribute(SETTINGS_NAV_MARKER, '');
      // Only ever clear this plugin's own marker, and only from a row that
      // carries it. Touching rows that do not is how one plugin's icon steals
      // another's.
      else if (el.hasAttribute(SETTINGS_NAV_MARKER)) el.removeAttribute(SETTINGS_NAV_MARKER);
    }
  };

  sync();

  let observer: MutationObserver | null = null;
  if (typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  return () => {
    disposed = true;
    if (observer !== null) observer.disconnect();
    for (const element of Array.from(scope.querySelectorAll(`[${SETTINGS_NAV_MARKER}]`))) {
      (element as ElementLike).removeAttribute(SETTINGS_NAV_MARKER);
    }
  };
}
