# vhs pipeline.tape → pipeline.mp4 — the full five-stage pipeline
Output pipeline.mp4

Set FontSize 16
Set Width 1280
Set Height 720
Set Padding 14
Set TypingSpeed 30ms
Set Theme "Catppuccin Mocha"
Set Shell "bash"

Hide
Type "alias keymaker='node src/cli.js' && pkill -f 'cli.js serve' 2>/dev/null; pkill -f toy-api 2>/dev/null; rm -rf out/pipe /tmp/todo.improved.yaml /tmp/reg.json; clear"
Enter
Show

Type "# The full pipeline: diagnose, fix, generate, serve. Then an agent signs itself up."
Enter
Sleep 2.5s

Type "keymaker doctor stripe.com supabase.com"
Enter
Sleep 9s

Type "# Now our own API. Step 1 — grade the spec:"
Enter
Sleep 1.5s
Type "keymaker score examples/todo-api.yaml"
Enter
Sleep 6s

Type "# Step 2 — Claude drafts the missing docs:"
Enter
Sleep 1.5s
Type "keymaker improve examples/todo-api.yaml -o /tmp/todo.improved.yaml"
Enter
Sleep 18s

Type "# Step 3 — generate the agent surfaces from the fixed spec:"
Enter
Sleep 1.5s
Type@12ms "keymaker generate /tmp/todo.improved.yaml -o out/pipe --base-url http://localhost:3466/v1 --service-url http://localhost:8797"
Enter
Sleep 5s

Hide
Type "node examples/toy-api.mjs out/pipe 3466 >/dev/null 2>&1 &"
Enter
Show

Type "keymaker serve out/pipe -p 8797 &"
Enter
Sleep 3s

Type "# Step 4 — an AI agent signs itself up. No human anywhere:"
Enter
Sleep 1.5s
Type@12ms `curl -s -X POST localhost:8797/agent-auth -d '{"client_name":"demo-agent","scopes":["read","write"]}' | tee /tmp/reg.json | jq`
Enter
Sleep 5.5s

Type `KEY=$(jq -r .api_key /tmp/reg.json)`
Enter
Sleep 1s

Type "# ...and uses the API through hosted MCP:"
Enter
Sleep 1.5s
Type@12ms `curl -s -X POST localhost:8797/mcp -H "authorization: Bearer $KEY" -H "content-type: application/json" -H "accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"createTask","arguments":{"title":"hello from an agent"}}}' | jq -r ".result.content[0].text"`
Enter
Sleep 5s

Type "# Step 5 — the vendor's view of its new customer:"
Enter
Sleep 1.5s
Type "keymaker keys out/pipe"
Enter
Sleep 5s

Type "# diagnose → fix → generate → serve → agents become customers."
Enter
Type "# https://github.com/adityaaa-IIT-BHU/keymaker   ·   npx keymaker-cli"
Enter
Sleep 4s
