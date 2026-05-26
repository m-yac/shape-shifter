import { type HistoryEntry } from "../history/history";

/**
 * Right-side list of operations performed. The seed is the first line; each edit
 * below it is prefixed with "↳" and, if it produced a recognised polyhedron, the
 * name on an indented line in parentheses. Entries after the current point (the
 * redo tail) are dimmed; clicking any entry jumps the app to that state.
 */
export class HistoryPanel {
  private el: HTMLElement | null;

  constructor(private readonly onJump: (index: number) => void) {
    this.el = document.getElementById("history");
  }

  render(entries: readonly HistoryEntry[], current: number): void {
    if (!this.el) return;
    this.el.replaceChildren();

    entries.forEach((entry, i) => {
      const item = document.createElement("div");
      item.className = "history-item";
      if (i === current) item.classList.add("current");
      if (i > current) item.classList.add("future");
      if (entry.invalid) item.classList.add("invalid");

      const label = document.createElement("div");
      label.className = "history-label";
      label.textContent = entry.isSeed ? entry.label : `↳ ${entry.label}`;
      item.appendChild(label);

      // Show the resulting shape's name beneath operations (the seed line already
      // *is* its name, so it's not repeated). Invalid states have no name.
      if (!entry.isSeed && entry.name) {
        const name = document.createElement("div");
        name.className = "history-name";
        name.textContent = `(${entry.name})`;
        item.appendChild(name);
      }

      item.addEventListener("click", () => this.onJump(i));
      this.el!.appendChild(item);
    });

    // Keep the active entry in view as the list grows.
    const active = this.el.children[current] as HTMLElement | undefined;
    active?.scrollIntoView({ block: "nearest" });
  }
}
