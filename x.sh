cat > /tmp/xcheck.mjs <<'EOF'
import fs from "node:fs";
const c = JSON.parse(fs.readFileSync(".cache/search.json", "utf8"));
let xQueries = 0, xUrls = 0;
for (const [q, v] of Object.entries(c)) {
  if (/x\.com/i.test(q) === false) continue;
  xQueries++;
  console.log("\n" + q);
  const rows = v.results || [];
  if (rows.length === 0) { console.log("   (no results at all)"); continue; }
  for (const r of rows) {
    const url = r.url || "";
    const isX = /([a-z0-9.-]*\.)?(x|twitter)\.com\//i.test(url);
    if (isX) xUrls++;
    console.log("   " + (isX ? "[X] " : "    ") + url.slice(0, 76));
  }
}
console.log("\n" + "-".repeat(50));
console.log(xQueries + "
