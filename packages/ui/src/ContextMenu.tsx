import { useEffect, useRef } from "react";

export interface MenuItem {
  label: string;
  onSelect: () => void;
  /** Destructive items are shown as such, as in every other menu. */
  danger?: boolean;
  disabled?: boolean;
}

export interface ContextMenuProps {
  /** Viewport coordinates of the click that opened it. */
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

/**
 * A right-click menu, because the actions on a page are worth having where the
 * page is and not only in a panel on the far side of the window.
 *
 * It is deliberately small: a list of buttons, closed by Escape, by a click
 * elsewhere, or by choosing something. Focus moves into it on open so the
 * keyboard can work it, and it is nudged back on screen when a click near the
 * right or bottom edge would otherwise put it half outside.
 */
export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    menu.current?.querySelector("button")?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const onDown = (event: MouseEvent) => {
      if (!menu.current?.contains(event.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    // Capture, so a click lands on the menu rather than on what is underneath.
    window.addEventListener("mousedown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown, true);
    };
  }, [onClose]);

  useEffect(() => {
    const box = menu.current?.getBoundingClientRect();
    if (!box || !menu.current) return;
    const overRight = box.right - window.innerWidth + 8;
    const overBottom = box.bottom - window.innerHeight + 8;
    if (overRight > 0) menu.current.style.left = `${Math.max(8, x - overRight)}px`;
    if (overBottom > 0) menu.current.style.top = `${Math.max(8, y - overBottom)}px`;
  }, [x, y]);

  return (
    <div
      ref={menu}
      className="menu"
      role="menu"
      data-testid="context-menu"
      style={{ left: `${x}px`, top: `${y}px` }}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className={item.danger ? "menu-item menu-item-danger" : "menu-item"}
          disabled={item.disabled ?? false}
          onClick={() => {
            onClose();
            item.onSelect();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
