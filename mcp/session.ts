// The document the MCP tools work on. Lives in the server process; when an editor is connected
// through the bridge, both sides keep the same document.

import { produce, type Draft } from "immer";
import { emptyDoc } from "../src/lib/importer";
import { isReferenceLayer } from "../src/lib/reference";
import type { Doc } from "../src/lib/types";

const HISTORY_LIMIT = 50;

export type Origin = "claude" | "editor";
type Listener = (doc: Doc, origin: Origin, label?: string) => void;

class Session {
  doc: Doc = emptyDoc(1000, 1000);
  past: Doc[] = [];
  future: Doc[] = [];
  /** Where the current reference photo came from (for messages). */
  referenceSource: string | null = null;
  /** Selection reported by the editor. */
  selection: string[] = [];
  editors = 0;
  private listeners = new Set<Listener>();

  onChange(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Replaces the document, keeping the previous one for undo. */
  setDoc(doc: Doc, origin: Origin, label?: string) {
    if (doc === this.doc) return;
    this.past = [...this.past, this.doc].slice(-HISTORY_LIMIT);
    this.future = [];
    this.doc = doc;
    for (const fn of this.listeners) fn(doc, origin, label);
  }

  /** Applies an undoable change made by a tool. Returns whatever the recipe returns. */
  mutate<T>(label: string, recipe: (draft: Doc) => T): T {
    let result!: T;
    const next = produce(this.doc, (d: Draft<Doc>) => {
      result = recipe(d as Doc);
    });
    this.setDoc(next, "claude", label);
    return result;
  }

  undo(steps = 1): number {
    let done = 0;
    while (done < steps && this.past.length) {
      this.future = [this.doc, ...this.future];
      this.doc = this.past.at(-1)!;
      this.past = this.past.slice(0, -1);
      done++;
    }
    if (done) for (const fn of this.listeners) fn(this.doc, "claude", "Deshacer");
    return done;
  }
}

export const session = new Session();

/** The document without the reference layer (for rendering the artwork alone and for export). */
export function withoutReference(doc: Doc): Doc {
  return { ...doc, layers: doc.layers.filter((l) => !isReferenceLayer(l)) };
}
