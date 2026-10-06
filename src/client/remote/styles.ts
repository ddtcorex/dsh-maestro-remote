/**
 * Token-native styling for the remote settings section. Every colour and
 * radius resolves through a `--dsw-*` alias, so the section follows the shell
 * theme instead of carrying a palette of its own.
 *
 * The iOS block holds text fields at 16px on coarse pointers: iOS WebKit
 * magnifies the viewport for a focused field below that size, and a magnified
 * sheet never blurs back.
 */
export const REMOTE_CSS = `
[data-remote-root], [data-remote-root] * { box-sizing: border-box; }
[data-remote-root] {
  display: flex; flex-direction: column; gap: 12px;
  color: var(--dsw-alias-label-primary);
  font-size: 13px; line-height: 1.5;
  min-width: 0; width: 100%; max-width: 640px;
}

/* House header: badge + title + one-line status. */
[data-remote-header] { display: flex; gap: 10px; align-items: flex-start; padding: 2px 2px 8px; }
[data-remote-heading] { display: flex; flex-direction: column; min-width: 0; }
[data-remote-title] { margin: 0; font-size: 15px; font-weight: 600; line-height: 22px; }
[data-remote-status] { font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
[data-remote-status] [data-remote-notice] { margin: 0; }
[data-remote-status] [data-remote-notice][data-tone="ok"] { color: var(--dsw-alias-state-success-primary); }
[data-remote-status] [data-remote-notice][data-tone="bad"] { color: var(--dsw-alias-state-error-primary); }

[data-remote-actions] { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
[data-remote-actions] button {
  min-height: 32px; padding: 0 12px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1);
  color: inherit; font: inherit; cursor: pointer;
}
[data-remote-actions] button:disabled { opacity: 0.55; cursor: default; }
[data-remote-actions] button:focus-visible { outline: 2px solid var(--dsw-alias-border-l2); outline-offset: 2px; }

/* House row: label and hint left, control held right, hairline between. */
[data-remote-row] {
  display: flex; align-items: center; gap: 8px;
  padding: 16px 0; border-bottom: 1px solid var(--dsw-alias-border-l2); min-width: 0;
}
[data-remote-row]:last-of-type { border-bottom: none; }
[data-remote-row-text] { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; padding-right: 48px; }
[data-remote-label] { font-size: 14px; font-weight: 400; line-height: 22px; color: var(--dsw-alias-label-primary); }
[data-remote-hint] { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
[data-remote-control] { flex: none; display: flex; align-items: center; justify-content: flex-end; gap: 8px; min-height: 36px; }

/* Every row control gets the same box — the shared settings field box, copied
   from the host's own form primitive (ui-primitives ConfigField) so this tab
   follows the shell instead of carrying a geometry of its own. Only
   min-height: 44px is Maestro's: it is the touch target AGENTS.md requires,
   which the host's line-box sizing does not give.
   The select takes the same box: this sheet draws no custom arrow (no
   appearance:none, no background-image), so the UA reserves its own space and
   an arrow-clearing padding override would only be a second geometry. */
[data-remote-control] input[type="text"], [data-remote-control] select {
  min-height: 44px; padding: 6px 12px; border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-primary); font: inherit;
}
[data-remote-control] input:focus-visible, [data-remote-control] select:focus-visible {
  outline: 2px solid var(--dsw-alias-border-l2); outline-offset: 2px;
}

/* The checkbox is the one control the harness draws at its own size; without
   this it rendered at the UA default 13px beside 32px fields in the same row. */
[data-remote-control] input[type="checkbox"] {
  width: 16px; height: 16px; margin: 0; flex: none;
  accent-color: var(--dsw-alias-brand-primary, #0A84FF);
}

[data-remote-pin], [data-remote-lan] { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
[data-remote-pin] code, [data-remote-lan] code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  padding: 2px 6px; border-radius: 6px; background: var(--dsw-alias-bg-layer-2);
}
[data-remote-pin] button, [data-remote-lan] button {
  min-height: 32px; padding: 0 10px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1);
  color: inherit; font: inherit; cursor: pointer;
}

@media (max-width: 640px) {
  /* Below the measure the row stacks: a right-held control has no room left,
     and a wrapped one reads as a third column. */
  [data-remote-row] { flex-direction: column; align-items: stretch; gap: 8px; }
  [data-remote-row-text] { padding-right: 0; }
  /* Every field takes the full row width, with or without a Save button: the
     button stays on the same row and the input takes the rest. */
  [data-remote-control] { justify-content: flex-start; width: 100%; }
  [data-remote-control] input[type="text"], [data-remote-control] input[type="password"], [data-remote-control] select { flex: 1 1 auto; min-width: 0; width: 100%; }
  /* A checkbox row does not stack: label and hint stay left, the box is held
     right as a 44px tap target on the same line. Stacked, it left a lone 16px
     box on a line of its own under the label. */
  [data-remote-row]:has(> [data-remote-control] > input[type="checkbox"]:only-child) { flex-direction: row; align-items: center; gap: 12px; }
  [data-remote-row]:has(> [data-remote-control] > input[type="checkbox"]:only-child) [data-remote-control] { flex: none; width: auto; min-width: 44px; min-height: 44px; justify-content: center; }
}

@media (max-width: 480px) {
  [data-remote-actions] button { flex: 1 1 auto; min-height: 40px; }
}

/* iOS 16px field floor: the magnifier fires below this on a focused field. */
@media (max-width: 1023px) and (pointer: coarse) {
  html[data-mobile-nav-ios] [data-remote-root] input,
  html[data-mobile-nav-ios] [data-remote-root] select { font-size: 16px !important; }
}
`