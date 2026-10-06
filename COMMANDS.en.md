# Commands

Every command starts with `/` and is sent directly in chat. Most commands show their current status and usage when called without arguments.

There are three statuses:

- **Stable**: wired into the normal flow and ready to use after configuration.
- **Experimental**: implemented, but verification-only by default and not part of the normal conversation.
- **In development**: the command or diagnostic exists, but the capability is not finished.

## Stable: basics

| Command | Purpose |
|---|---|
| `/help` | Show help |
| `/menu` | Open the main menu |
| `/ping` | Test connectivity |
| `/status` | Show runtime status |
| `/dashboard` | Show configuration, sessions, and characters |
| `/whoami` | Show the current user ID |
| `/cancel` | Cancel the current operation |
| `/usage` | Show token usage and cache hit rate |
| `/pending` | Show messages waiting after a send failure; `/pending retry` sends them now |

## Stable: models

| Command | Purpose |
|---|---|
| `/provider` | Show or switch the model provider |
| `/key set <key>` | Set the API key for the active provider |
| `/key set <provider> <key>` | Set the key for a named provider |
| `/model` | List chat models |
| `/model use <number-or-name>` | Switch model |
| `/thinking` | Show the reasoning setting |
| `/thinking budget <n>` | Set the reasoning budget |
| `/balance` | Query balance when the provider supports it |
| `/embed` | Configure the embedding model |
| `/max` | Show generation limits for replies, memory extraction, and summaries |
| `/max reply\|extract\|summary <n\|max>` | Set one limit |

## Stable: sessions and context

| Command | Purpose |
|---|---|
| `/session` | List sessions |
| `/session new [name]` | Create a session |
| `/session use <number>` | Switch session |
| `/session rename <name>` | Rename the current session |
| `/session del <number>` | Delete a session |
| `/context` | Show the current context |
| `/reset` | Clear the current context without changing configuration |
| `/cot [count\|all]` | Show reasoning and tool calls |
| `/summary now` | Generate a summary |
| `/summary` | List summaries; `del <number>` deletes one and `clear` removes all |

## Stable: roleplay

| Command | Purpose |
|---|---|
| `/rp` | Show characters, lore, addressing, and prompts |
| `/char` | List character cards |
| `/char use <number>` | Use a card |
| `/char show <number>` | Show a card |
| `/char export <number>` | Export a card |
| `/char clone <number>` | Clone a card |
| `/char del <number>` | Delete a card |
| `/char claim` | Claim cards without an owner |
| `/user <name>` | Set the global form of address |
| `/user session <name>` | Set it for the current session only |
| `/user reset` | Restore the global form of address |
| `/lore` | List lore entries; `export` exports and `del <number>` deletes |
| `/prompt` | List prompts |
| `/prompt <key>` | Show one prompt |
| `/prompt char` | Show the prompt assembled for the current character |

Character cards and lore are added by importing JSON.

## Stable: memory

| Command | Purpose |
|---|---|
| `/mem` | Show memory status |
| `/mem list` | List memories in the current session |
| `/mem search <text>` | Search memories |
| `/mem add <text>` | Add a memory manually |
| `/mem extract` | Extract memories from recent messages |
| `/mem backfill` | Backfill memories from older history |
| `/mem global <number\|all>` | Make session memories visible to every session |
| `/mem del <number>` | Delete a memory |
| `/mem clear` | Clear memories in the current scope |
| `/mem vector` | Show the vector index |
| `/mem orphan` | Show memories without an owner |
| `/mem reembed` | Rebuild embeddings |
| `/mem prune` | Remove low-value memories |

## Stable: perception

| Command | Purpose |
|---|---|
| `/perc` | Show time and weather status |
| `/perc on\|off` | Enable or disable all perception |
| `/perc preview` | Show what will be injected this turn |
| `/perc now`, `/now` | Show the current time |
| `/perc time on\|off` | Toggle time perception |
| `/perc tz <IANA timezone>` | Set the timezone, for example `Asia/Shanghai` |
| `/perc gap <1-72>` | Set the scene-change hint threshold in hours |
| `/perc weather on\|off` | Toggle weather |
| `/perc weather provider <name>` | Switch the weather provider |
| `/perc weather ttl <minutes>` | Set the cache duration |
| `/perc weather key <key>` | Set a provider key; `clear` removes it |
| `/perc city` | List places |
| `/perc city <label> <latitude>,<longitude>` | Add a place, up to 8 |
| `/perc city del <number>` | Delete a place |
| `/perc city rename <number> <label>` | Rename a place |
| `/perc city clear` | Remove all places |

Weather is never inferred from the server IP. Swapped coordinates are corrected only when one order is impossible; if both orders are valid, the input order is kept. Place-name search shows candidates and never applies one automatically.

## Stable: replies, transfer, tools, and proactive messages

| Command | Purpose |
|---|---|
| `/reply on\|off` | Toggle segmented sending |
| `/reply delay <milliseconds>` | Set the delay between segments |
| `/reply merge <milliseconds>` | Set the burst-merge window; `0` disables it |
| `/reply tokens <n>` | Set the reply generation limit |
| `/import confirm` | Merge the received import |
| `/import replace` | Replace existing data with the import |
| `/import cancel` | Cancel the import |
| `/export [roleplay\|settings\|providers\|all]` | Export JSON |
| `/export providers full` | Export provider settings including keys |
| `/exportmode file\|text\|image` | Select the export transport; `file` is recommended |
| `/tools` | Show tool status |
| `/tools on\|off` | Toggle tools |
| `/tools test` | Test tools |
| `/tools web provider <name>` | Select the web-search provider |
| `/tools web key <key>` | Set the search key |
| `/tools web url <url>` | Set a self-hosted search URL |
| `/agent` | Show delegation status |
| `/agent on\|off` | Toggle delegation |
| `/agent key <key>` | Set the delegated model's key; `clear` falls back to the chat key |
| `/agent max <1-30>` | Set the maximum number of turns |
| `/agent timeout <10-900>` | Set the timeout in seconds |
| `/agent run <task>` | Delegate one task |
| `/agent log` | Show delegation logs |
| `/proactive` | Show proactive-message status |
| `/proactive on\|off` | Toggle proactive messages |
| `/proactive gap <min>-<max>` | Set the random interval in minutes |
| `/proactive silence <minutes>` | Set the minimum silence |
| `/proactive cap <0-50>` | Set the daily cap; `0` means unlimited |
| `/proactive quiet <start>-<end>` | Set quiet hours |
| `/proactive now` | Try once immediately |

## Experimental: speech to text

Speech recognition is implemented, but its default mode is `probe`: it returns the transcript for verification and does not write history or send the text into the model conversation. Switch to `/asr mode chat` after the result is confirmed.

| Command | Purpose |
|---|---|
| `/asr` | Show status |
| `/asr on\|off` | Toggle recognition |
| `/asr mode probe\|chat` | Switch between verification and normal chat |
| `/asr model <model>` | Select the recognition model |
| `/asr diar on\|off` | Toggle speaker detection |
| `/asr diar notify on\|off` | Include or omit the multiple-speaker note in chat |
| `/asr last` | Show the latest recognition |
| `/asr test` | Test the recognition setup |

## In development

These capabilities are not finished. Their commands are diagnostic or status-only and do not mean the feature is usable.

| Capability | Current state |
|---|---|
| Text to speech | Not implemented. It needs a synthesis service and an outbound voice-message format. |
| Video understanding | Not implemented. Incoming videos are retained only; their pictures are not understood. |
| Link understanding | Not implemented. Video and web links are not opened or interpreted automatically. |
| `/diag` | Diagnostic: send a test image and a test file. |
| `/resendimg` | Diagnostic: send back the most recent received image unchanged. |
| `/diagvideo [video_size\|len\|mid_size\|file]` | Diagnostic: resend a video with different fields to investigate transport compression. |
