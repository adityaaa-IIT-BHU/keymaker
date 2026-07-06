# vhs demo-full.tape → demo.mp4 — the 60-second full-loop demo
Output demo.mp4

Set FontSize 17
Set Width 1280
Set Height 720
Set Padding 14
Set TypingSpeed 30ms
Set Theme "Catppuccin Mocha"
Set Shell "bash"

Hide
Type "alias keymaker='node src/cli.js' && pkill -f 'cli.js serve' 2>/dev/null; pkill -f toy-api 2>/dev/null; rm -rf out/video /tmp/reg.json; clear"
Enter
Show

Type "# Agents pick APIs by docs quality, not API quality. Is yours even visible to them?"
Enter
Sleep 2.5s

Type "keymaker score https://petstore3.swagger.io/api/v3/openapi.json"
Enter
Sleep 6s

Type "# Even the official Swagger Petstore gets a B. Let's make an API fully agent-ready:"
Enter
Sleep 2s

Type "keymaker generate examples/todo-api.yaml -o out/video --base-url http://localhost:3456/v1"
Enter
Sleep 5.5s

Hide
Type "node examples/toy-api.mjs out/video >/dev/null 2>&1 &"
Enter
Type "clear"
Enter
Show

Type "keymaker serve out/video &"
Enter
Sleep 3s

Type "# Now an AI agent signs itself up. No human. No dashboard. One request:"
Enter
Sleep 2s

Type@12ms `curl -s -X POST localhost:8787/agent-auth -d '{"client_name":"my-agent","scopes":["read","write"]}' | tee /tmp/reg.json | jq`
Enter
Sleep 6s

Type `KEY=$(jq -r .api_key /tmp/reg.json)`
Enter
Sleep 1s

Type "# ...and immediately uses the API through the hosted MCP endpoint:"
Enter
Sleep 2s

Type@12ms `curl -s -X POST localhost:8787/mcp -H "authorization: Bearer $KEY" -H "content-type: application/json" -H "accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"createTask","arguments":{"title":"hello from an agent"}}}' | jq -r ".result.content[0].text"`
Enter
Sleep 5s

Type "# Discover → sign up → scoped key → tools. Hashed, metered, revocable. Zero humans."
Enter
Sleep 2s

Type "# github.com/adityaaa-IIT-BHU/keymaker   ·   npx agent-ready"
Enter
Sleep 4s
