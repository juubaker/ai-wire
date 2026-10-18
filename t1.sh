npm run check > /tmp/8b.log 2>&1
ollama pull qwen3:14b
npm run check -- --model qwen3:14b > /tmp/14b.log 2>&1

for f in /tmp/8b.log /tmp/14b.log; do echo "=== $f ==="; \
grep -aE -A25 '^  (searched|model returned|already known|unlisted url|kept) |^model said|^added=|^  \+ \[' $f; done
