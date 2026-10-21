import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

// Node's native test loader does not have Pi's host-package module mapping.
// Stub only the terminal component; all bridge and history code remains real.
export async function loadExtension() {
	const path = new URL("../index.ts", import.meta.url);
	const source = readFileSync(path, "utf8")
		.replace('import { Text } from "@earendil-works/pi-tui";', `class Text {
			constructor(text) { this.text = text; }
			render() { return this.text.split("\\n"); }
			invalidate() {}
		}`)
		.replace('"./history.ts"', JSON.stringify(new URL("../history.ts", import.meta.url).href));
	const javascript = stripTypeScriptTypes(source, { mode: "strip", sourceUrl: path.href });
	return (await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`)).default;
}
