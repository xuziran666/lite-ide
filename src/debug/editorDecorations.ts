import * as monaco from "monaco-editor";
import { pathForModel } from "../editor/modelStore";
import { useDebugStore } from "../stores/debugStore";
import { useEditorStore } from "../stores/editorStore";
import { fileKey } from "../utils/pathIdentity";
import { toggleBreakpoint } from "./session";

/**
 * Rendering debug state into Monaco: breakpoint dots in the glyph margin, and the
 * line the program is currently stopped on.
 *
 * The glyph margin is *always* on (set with `glyphMargin: true` at editor
 * creation) so the click target never moves when a session starts — a user who
 * learns where to click does not have to re-learn it on the next run, and a
 * breakpoint set before starting the debugger is in the right place. Its width
 * is derived by Monaco from the font; there is no width knob to set.
 *
 * Decorations are recomputed from the store, never accumulated: every update
 * replaces the previous decoration ids, so toggling a breakpoint a hundred times
 * cannot leak decoration objects.
 */

let installed: {
  editor: monaco.editor.IStandaloneCodeEditor;
  breakpointIds: string[];
  locationIds: string[];
  /** Both unsubscribe functions (Zustand) and disposables (Monaco) are
   *  collected, so teardown is a single loop either way. */
  subscriptions: (() => void)[];
} | null = null;

/** A filled circle for a bound breakpoint, a hollow one for an unbound line. */
function breakpointGlyph(verified: boolean): monaco.editor.IModelDeltaDecoration {
  return {
    range: new monaco.Range(0, 0, 0, 0),
    options: {
      isWholeLine: false,
      glyphMarginClassName: verified ? "debug-breakpoint" : "debug-breakpoint-unverified",
      glyphMarginHoverMessage: verified
        ? { value: "Breakpoint" }
        : { value: "Breakpoint (not bound yet — the adapter has not resolved this line)" },
      stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
    },
  };
}

/** Recompute and apply every debug decoration for the editor's current model. */
export function refreshDebugDecorations(
  editor: monaco.editor.IStandaloneCodeEditor,
): void {
  if (!installed || installed.editor !== editor) return;
  const model = editor.getModel();
  const path = model ? pathForModel(model) : null;
  if (!model || !path) {
    clearDecorations(editor);
    return;
  }

  const file = useDebugStore.getState().breakpointsByFile[fileKey(path)];
  const lines = file ? file.lines : [];
  const verified = new Set(file ? file.verified : []);

  const nextBreakpoints = lines.map((line) =>
    breakpointGlyph(verified.has(line)),
  );
  installed.breakpointIds = editor.deltaDecorations(
    installed.breakpointIds,
    nextBreakpoints.map((decoration, index) => ({
      ...decoration,
      range: new monaco.Range(lines[index], 1, lines[index], 1),
    })),
  );

  // The current-line marker follows the *selected frame*, so clicking a frame in
  // the call stack moves the highlight, matching what the variables panel shows.
  const location = useDebugStore.getState().session.currentLocation;
  const showHere = location && fileKey(location.path) === fileKey(path);
  installed.locationIds = editor.deltaDecorations(
    installed.locationIds,
    showHere
      ? [
          {
            range: new monaco.Range(location.line, 1, location.line, 1),
            options: {
              isWholeLine: true,
              className: "debug-current-line",
              glyphMarginClassName: "debug-current-line-glyph",
              overviewRuler: {
                color: "#ffc107",
                position: monaco.editor.OverviewRulerLane.Full,
              },
            },
          },
        ]
      : [],
  );
}

function clearDecorations(editor: monaco.editor.IStandaloneCodeEditor): void {
  if (!installed) return;
  installed.breakpointIds = editor.deltaDecorations(installed.breakpointIds, []);
  installed.locationIds = editor.deltaDecorations(installed.locationIds, []);
}

/**
 * Attach debug rendering to an editor instance. Idempotent: calling it again for
 * the same editor only re-subscribes, and a different editor replaces the
 * previous binding (which happens when the editor is recreated).
 */
export function installDebugDecorations(
  editor: monaco.editor.IStandaloneCodeEditor,
): () => void {
  if (installed && installed.editor !== editor) {
    uninstallDebugDecorations();
  }
  editor.updateOptions({ glyphMargin: true });

  if (!installed) {
    installed = { editor, breakpointIds: [], locationIds: [], subscriptions: [] };
  }

  const debugStore = useDebugStore;

  // Monaco listeners are registered *now* and disposed on teardown. They must
  // not be deferred inside the teardown closures: doing so would register the
  // handler only when it is being torn down, so a gutter click would never reach
  // `toggleBreakpoint` during the editor's life.
  const modelSubscription = editor.onDidChangeModel(() =>
    refreshDebugDecorations(editor),
  );
  const mouseSubscription = editor.onMouseDown((event) => {
    const target = event.target;
    if (target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
    const lineNumber = target.position?.lineNumber;
    if (lineNumber === undefined) return;
    const model = editor.getModel();
    if (!model) return;
    const path = pathForModel(model);
    if (!path) return;
    // Monaco reports the clicked line 1-based, which is exactly what DAP and our
    // breakpoint map use, so no conversion happens here.
    void toggleBreakpoint(path, lineNumber);
  });

  installed.subscriptions.push(
    debugStore.subscribe((state, prev) => {
      // Any of these invalidate the decorations; comparing them keeps the update
      // from running on unrelated store writes.
      if (
        state.breakpointsByFile === prev.breakpointsByFile &&
        state.session.currentLocation === prev.session.currentLocation
      ) {
        return;
      }
      refreshDebugDecorations(editor);
    }),
    useEditorStore.subscribe((state, prev) => {
      if (state.activePath !== prev.activePath) refreshDebugDecorations(editor);
    }),
    () => modelSubscription.dispose(),
    () => mouseSubscription.dispose(),
  );

  refreshDebugDecorations(editor);
  return uninstallDebugDecorations;
}

export function uninstallDebugDecorations(): void {
  if (!installed) return;
  const { editor, breakpointIds, locationIds, subscriptions } = installed;
  editor.deltaDecorations(breakpointIds, []);
  editor.deltaDecorations(locationIds, []);
  for (const unsubscribe of subscriptions) unsubscribe();
  installed = null;
}
