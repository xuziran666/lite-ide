import { DebugOutputBuffer } from "./debugTerminalOutput.ts";

let failures = 0;

function ok(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ok   ${message}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${message}`);
  }
}

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

console.log("Debug Terminal output buffer");
{
  const buffer = new DebugOutputBuffer();
  buffer.append(1, bytes("0 1 2 3 4\n"));
  ok(text(buffer.consume(1)) === "0 1 2 3 4\n", "keeps a complete session output");
  ok(buffer.consume(1).length === 0, "consume clears the session buffer");
}

{
  const buffer = new DebugOutputBuffer();
  buffer.append(1, bytes("0 1 "));
  buffer.append(1, bytes("2 3 "));
  buffer.append(1, bytes("4\n"));
  ok(text(buffer.consume(1)) === "0 1 2 3 4\n", "preserves fragmented output order");
}

{
  const buffer = new DebugOutputBuffer();
  buffer.append(1, bytes("session A\n"));
  buffer.append(2, bytes("session B\n"));
  ok(text(buffer.consume(1)) === "session A\n", "session A receives only its own output");
  ok(text(buffer.consume(2)) === "session B\n", "session B receives only its own output");
  buffer.append(1, bytes("late A\n"));
  ok(text(buffer.consume(2)) === "", "late session A output cannot enter session B");
}

{
  const buffer = new DebugOutputBuffer();
  buffer.append(1, bytes("old output\n"));
  buffer.clear(1);
  buffer.append(2, bytes("new output\n"));
  ok(text(buffer.consume(1)) === "", "clearing an old session removes its pending output");
  ok(text(buffer.consume(2)) === "new output\n", "new session output remains available");
}

if (failures > 0) {
  throw new Error(`${failures} Debug Terminal output tests failed`);
} else {
  console.log("all Debug Terminal output tests passed");
}
