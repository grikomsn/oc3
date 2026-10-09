// Loaded before every test file. State and Codex directories point at a
// throwaway root, so no test can write to a real ~/.config/oc3 or ~/.codex.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "oc3-test-"));
process.env.OC3_HOME = join(root, "oc3");
process.env.CODEX_HOME = join(root, "codex");
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
