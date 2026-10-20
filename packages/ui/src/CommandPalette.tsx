import { useEffect, useMemo, useRef, useState } from "react";

export interface Command {
  id: string;
  /** What it is called, which is what people will type. */
  label: string;
  /** Where it lives, shown beside the name: Pages, Marks, Protect. */
  group: string;
  /** Other words someone might reach for — "shrink" for Compress. */
  keywords?: string | undefined;
  /** The keystroke, where it has one. */
  shortcut?: string | undefined;
  disabled?: boolean | undefined;
  run: () => void;
}

export interface CommandPaletteProps {
  commands: Command[];
  onClose: () => void;
}

/**
 * Everything the app can do, by name.
 *
 * The tools panel has grown past the point where a reader can find things by
 * looking: there are sixty-odd actions, grouped sensibly, and the one you want
 * is in the group you did not guess. Typing two letters of its name is faster
 * than any arrangement of buttons, and it is how every editor this app's users
 * already use works.
 *
 * Matching is on the name, the group and a few extra words — so "shrink" finds
 * Compress and "pdf/a" finds the archive check — and it is forgiving of order:
 * "num page" finds "Add page numbers".
 */
export function CommandPalette({ commands, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const list = useRef<HTMLUListElement>(null);

  const matches = useMemo(() => {
    const words = query
      .toLowerCase()
      .split(/\s+/)
      .filter((word) => word !== "");
    const scored = commands
      .map((command) => {
        const haystack =
          `${command.label} ${command.group} ${command.keywords ?? ""}`.toLowerCase();
        if (!words.every((word) => haystack.includes(word))) return undefined;
        // A name that starts with what was typed beats one that merely contains
        // it, which is what makes the first result usually the right one.
        const starts = command.label.toLowerCase().startsWith(words[0] ?? "");
        return { command, score: (starts ? 0 : 1) + (command.disabled ? 10 : 0) };
      })
      .filter((row): row is { command: Command; score: number } => row !== undefined);

    scored.sort((a, b) => a.score - b.score || a.command.label.localeCompare(b.command.label));
    return scored.slice(0, 40).map((row) => row.command);
  }, [commands, query]);

  // A new search starts at the top, or the highlight ends up past the end.
  useEffect(() => setAt(0), [query]);

  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [at]);

  const choose = (command?: Command) => {
    if (!command || command.disabled) return;
    onClose();
    command.run();
  };

  return (
    <div className="palette-backdrop" data-testid="palette" onMouseDown={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-label="What do you want to do?"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <input
          className="palette-input"
          autoFocus
          placeholder="What do you want to do?"
          aria-label="Search the actions"
          data-testid="palette-input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setAt((index) => Math.min(matches.length - 1, index + 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setAt((index) => Math.max(0, index - 1));
            } else if (event.key === "Enter") {
              event.preventDefault();
              choose(matches[at]);
            } else if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          }}
        />
        <ul className="palette-list" ref={list} role="listbox" data-testid="palette-list">
          {matches.length === 0 ? (
            <li className="palette-none" data-testid="palette-none">
              Nothing matches that.
            </li>
          ) : (
            matches.map((command, index) => (
              <li
                key={command.id}
                role="option"
                aria-selected={index === at}
                aria-disabled={command.disabled ?? false}
                className={
                  "palette-item" +
                  (index === at ? " palette-item-on" : "") +
                  (command.disabled ? " palette-item-off" : "")
                }
                data-testid={`palette-${command.id}`}
                onMouseMove={() => setAt(index)}
                onClick={() => choose(command)}
              >
                <span className="palette-label">{command.label}</span>
                <span className="palette-group">{command.group}</span>
                {command.shortcut ? <kbd className="palette-key">{command.shortcut}</kbd> : null}
              </li>
            ))
          )}
        </ul>
        <p className="palette-hint">↑↓ to choose · Enter to run · Esc to close</p>
      </div>
    </div>
  );
}
