import { loadConfig } from "../src/lib/config.js";
import { fetchSource, prefilter, SOURCE_NAMES } from "../src/sources/index.js";
const cfg = loadConfig();
for (const s of SOURCE_NAMES) {
  const t = Date.now();
  try {
    const raw = await fetchSource(s, cfg);
    const f = prefilter(raw, cfg);
    console.log(`${s.padEnd(15)} raw=${String(raw.length).padEnd(5)} kept=${String(f.length).padEnd(4)} ${Date.now() - t}ms  ${f.slice(0, 4).map((x) => x.title.slice(0, 45)).join(" || ")}`);
  } catch (e) { console.log(`${s.padEnd(15)} ERROR ${(e as Error).message.slice(0, 150)}`); }
}
