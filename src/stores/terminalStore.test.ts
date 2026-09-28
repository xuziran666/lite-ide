import {
  DEBUG_TERMINAL_ID,
  useTerminalStore,
} from "./terminalStore.ts";

let failures = 0;

function equal(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    console.log(`  ok   ${message}`);
  } else {
    failures += 1;
    console.error(
      `  FAIL ${message}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`,
    );
  }
}

const store = useTerminalStore.getState();
store.reset();

console.log("Terminal sessions move independently between docks");
const bottomFirst = store.create();
const bottomActive = store.create();
const editorExisting = store.create("normal", "editor");
const rightExisting = store.create("normal", "right");

store.move(bottomFirst, "editor");
let state = useTerminalStore.getState();
equal(state.terminals.find((terminal) => terminal.id === bottomFirst)?.dock, "editor", "only the dragged record moves");
equal(state.terminals.find((terminal) => terminal.id === editorExisting)?.dock, "editor", "existing editor session is preserved");
equal(state.terminals.find((terminal) => terminal.id === bottomActive)?.dock, "bottom", "other bottom terminal stays in place");
equal(state.activeIdByDock.bottom, bottomActive, "moving an inactive terminal preserves the source selection");
equal(state.activeIdByDock.editor, bottomFirst, "moved terminal becomes active in its destination");

store.move(bottomActive, "right");
state = useTerminalStore.getState();
equal(state.activeIdByDock.bottom, null, "empty source dock has no active terminal");
equal(state.activeIdByDock.right, bottomActive, "moved terminal becomes active in the right dock");
equal(state.terminals.find((terminal) => terminal.id === rightExisting)?.dock, "right", "existing destination session is preserved");

store.close(bottomActive);
state = useTerminalStore.getState();
equal(state.activeIdByDock.right, rightExisting, "closing the active terminal selects a remaining session in that dock");
equal(state.activeIdByDock.editor, bottomFirst, "closing in one dock does not change another dock selection");

console.log("Debug terminal retains its selected dock on reveal");
store.ensureDebugTerminal();
store.move(DEBUG_TERMINAL_ID, "right");
store.ensureDebugTerminal();
state = useTerminalStore.getState();
equal(state.terminals.find((terminal) => terminal.id === DEBUG_TERMINAL_ID)?.dock, "right", "debug reveal does not move the session back to bottom");
equal(state.activeIdByDock.right, DEBUG_TERMINAL_ID, "debug reveal selects the debug session in its current dock");

store.reset();
if (failures > 0) {
  throw new Error(`${failures} terminal store tests failed`);
}
console.log("all terminal store tests passed");