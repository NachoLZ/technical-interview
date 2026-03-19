import fs from "node:fs";
import path from "node:path";

const file = path.join(process.cwd(), "data", "persona-spec.md");

export const PERSONA_SPEC: string = fs.readFileSync(file, "utf8");
