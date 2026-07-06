# vhs demo-full.tape → demo.mp4 — real APIs only: GitHub's spec + Peekalink's production API
Output demo.mp4

Set FontSize 17
Set Width 1280
Set Height 720
Set Padding 14
Set TypingSpeed 30ms
Set Theme "Catppuccin Mocha"
Set Shell "bash"

Hide
Type "alias keymaker='node src/cli.js' && pkill -f 'cli.js serve' 2>/dev/null; rm -rf out/peekalink /tmp/reg.json; clear"
Enter
Show

Type "# Agents pick APIs by docs quality, not API quality. Even the giants aren't ready:"
Enter
Sleep 2.5s

Type@12ms "keymaker score https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json"
Enter
Sleep 8s

Type "# 1,194 operations and even GitHub forgot to declare its auth schemes."
Enter
Sleep 2.5s

Type "# Now watch a real production API (peekalink.io) become fully agent-ready:"
Enter
Sleep 2s

Type "keymaker generate https://api.peekalink.io/mintlify -o out/peekalink"
Enter
Sleep 5s

Type "keymaker serve out/peekalink &"
Enter
Sleep 3s

Type "# An AI agent signs itself up. No human anywhere:"
Enter
Sleep 2s

Type@12ms `curl -s -X POST localhost:8787/agent-auth -d '{"client_name":"my-agent","scopes":["read","write"]}' | tee /tmp/reg.json | jq`
Enter
Sleep 6s

Type `KEY=$(jq -r .api_key /tmp/reg.json)`
Enter
Sleep 1s

Type "# ...and discovers Peekalink's real tools over the hosted MCP endpoint:"
Enter
Sleep 2s

Type@12ms `curl -s -X POST localhost:8787/mcp -H "authorization: Bearer $KEY" -H "content-type: application/json" -H "accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq ".result.tools"`
Enter
Sleep 5s

Type "# A real API, agent-ready in one command. Scoped, hashed, metered keys. Zero humans."
Enter
Sleep 2.5s

Type "# https://github.com/adityaaa-IIT-BHU/keymaker"
Enter
Sleep 4s
