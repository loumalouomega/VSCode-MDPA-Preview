/**
 * Shared open/close plumbing for the webview's dropdown menus — the File menu
 * in the menubar and the toolbar's View / Advanced menus. Modelled on
 * CAD-Preview's `dropdownMenu.ts` so the two viewers behave identically:
 *
 *   - only one menu is open at a time (opening one closes the rest);
 *   - a pointerdown outside every menu dismisses the open one — captured on the
 *     window and swallowed, so the click that closes a menu never also reaches
 *     the live VTK canvas underneath (it would start an orbit or a pick);
 *   - Escape closes it and returns focus to the trigger that opened it;
 *   - ArrowDown / ArrowUp cycle the menu's buttons (wrapping), Home / End jump
 *     to the first / last.
 *
 * All DOM access happens inside `setupDropdown()`, never at module load, so the
 * module can be imported by a DOM-free test. Module scope holds plain JS values.
 *
 * Unlike CAD's, the toolbar's panels are SIBLINGS of `#toolbar`, not children of
 * a per-trigger wrapper (mesh's JS selects `#toolbar button[data-action=…]`, and
 * a flat row of buttons is what lets the toolbar wrap). So a panel can be
 * positioned by the menu itself: pass `anchor` and, on every open, the panel is
 * hung under that element and right-aligned with the trigger, the way CAD's
 * `right: 0` dropdown hangs off its wrapper. Without `anchor` the panel keeps
 * whatever position its stylesheet gives it (the File menu's is CSS-only).
 */

export interface DropdownHandle {
  readonly trigger: HTMLElement;
  readonly panel: HTMLElement;
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
}

export interface DropdownOptions {
  /**
   * Element the panel hangs below, and whose bottom edge it aligns to — the
   * whole toolbar, so a wrapped second row is cleared too. When set, the panel
   * is also right-aligned with the trigger and clamped to the container's left
   * edge on open.
   */
  anchor?: HTMLElement | null;
}

const registry = new Set<DropdownHandle>();
let globalsWired = false;

/** Gap between the anchor and the panel, in CSS px (CAD's `top: calc(100% + 4px)`). */
const ANCHOR_GAP = 4;

/** Closes every dropdown wired so far. */
export function closeAllDropdowns(): void {
  for (const handle of registry) handle.close();
}

function anyOpen(): boolean {
  for (const handle of registry) if (handle.isOpen()) return true;
  return false;
}

/** True when the event landed inside some registered menu (its panel or its trigger). */
function insideAnyMenu(target: Node | null): boolean {
  if (!target) return false;
  for (const handle of registry) {
    if (handle.trigger.contains(target) || handle.panel.contains(target)) return true;
  }
  return false;
}

function wireGlobals(): void {
  if (globalsWired) return;
  globalsWired = true;

  window.addEventListener(
    "pointerdown",
    (e) => {
      if (!anyOpen() || insideAnyMenu(e.target as Node | null)) return;
      e.preventDefault();
      e.stopPropagation();
      closeAllDropdowns();
    },
    true // capture: run before the canvas's own pointerdown listener
  );

  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    // Close AND hand focus back to the trigger: the panel is display:none once
    // closed, so focus would otherwise fall into <body> with no way back.
    for (const handle of registry) {
      if (!handle.isOpen()) continue;
      closeAllDropdowns();
      handle.trigger.focus();
      return;
    }
  });
}

/**
 * Focusable elements inside a menu panel, in DOM order, visibility-filtered —
 * the arrow-key menu items. Separators and group labels are not buttons, so
 * they are skipped by construction.
 */
function focusablesIn(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>("button")).filter(
    (el) => !el.hasAttribute("disabled") && el.offsetParent !== null
  );
}

function place(panel: HTMLElement, trigger: HTMLElement, anchor: HTMLElement): void {
  const parent = panel.offsetParent as HTMLElement | null;
  if (!parent) return;
  const pr = parent.getBoundingClientRect();
  const tr = trigger.getBoundingClientRect();
  const ar = anchor.getBoundingClientRect();
  panel.style.top = `${Math.round(ar.bottom - pr.top + ANCHOR_GAP)}px`;
  panel.style.left = "auto";
  let right = pr.right - tr.right;
  // Never let the panel's left edge leave the container (a narrow viewport with
  // a wide panel): pull it back in rather than clipping its labels.
  const overflow = panel.offsetWidth + right - pr.width;
  if (overflow > 0) right -= overflow;
  panel.style.right = `${Math.max(0, Math.round(right))}px`;
}

/**
 * Wires one trigger/panel pair (elements or ids). Returns `null` rather than
 * throwing when either is missing — callers run inside `main.ts`'s shared setup,
 * where a throw must never block the `ready` handshake.
 */
export function setupDropdown(
  triggerRef: string | HTMLElement | null,
  panelRef: string | HTMLElement | null,
  opts: DropdownOptions = {}
): DropdownHandle | null {
  const trigger = typeof triggerRef === "string" ? document.getElementById(triggerRef) : triggerRef;
  const panel = typeof panelRef === "string" ? document.getElementById(panelRef) : panelRef;
  if (!trigger || !panel) return null;

  const handle: DropdownHandle = {
    trigger,
    panel,
    isOpen: () => !panel.classList.contains("hidden"),
    open() {
      for (const other of registry) if (other !== handle) other.close();
      panel.classList.remove("hidden");
      trigger.setAttribute("aria-expanded", "true");
      if (opts.anchor) place(panel, trigger, opts.anchor);
    },
    close() {
      panel.classList.add("hidden");
      trigger.setAttribute("aria-expanded", "false");
    },
    toggle() {
      if (handle.isOpen()) handle.close();
      else handle.open();
    },
  };

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    handle.toggle();
  });

  // Roving arrow-key navigation. Registered on the TRIGGER as well as the panel:
  // right after keyboard-opening, focus is still on the trigger (a sibling of
  // the panel, not a descendant), so a panel-only listener never fires for the
  // first step. Tab stays native.
  const navigateByArrow = (e: KeyboardEvent): void => {
    if (!handle.isOpen()) return;
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    const items = focusablesIn(panel);
    if (items.length === 0) return;
    const idx = items.indexOf(document.activeElement as HTMLElement);
    let next: number;
    if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    else if (e.key === "ArrowUp") next = idx <= 0 ? items.length - 1 : idx - 1;
    else next = idx < 0 ? 0 : (idx + 1) % items.length;
    if (next === idx && idx >= 0) return;
    e.preventDefault();
    e.stopPropagation();
    items[next].focus();
  };
  panel.addEventListener("keydown", navigateByArrow);
  trigger.addEventListener("keydown", navigateByArrow);

  // Clicks *inside* the panel deliberately leave it open — a checkable item is
  // something you toggle several of in one visit. One-shot items close it
  // themselves (see the click handlers that own each menu's items).

  // A checkable item's state is the shared `.active` class (mesh's JS toggles it
  // from many places); mirror it into `aria-checked` so the menu is announced
  // correctly without touching each of those call sites.
  const checkables = Array.from(panel.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]'));
  if (checkables.length > 0 && typeof MutationObserver !== "undefined") {
    const sync = (el: HTMLElement): void => {
      el.setAttribute("aria-checked", String(el.classList.contains("active")));
    };
    checkables.forEach(sync);
    const observer = new MutationObserver((records) => {
      for (const r of records) sync(r.target as HTMLElement);
    });
    for (const el of checkables) observer.observe(el, { attributes: true, attributeFilter: ["class"] });
  }

  registry.add(handle);
  wireGlobals();
  return handle;
}
