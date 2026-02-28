---
name: debug-pi-sub-gwdg-provider
description: Use when investigating and debugging gwdg provider related pi-sub issues.
---

Check your current working directory before start doing anything.

# pi-sub gwdg provider debugging

Verify by enabling debugging and grep for the expected logging outputs.

## Running extension with debug output

Enable extension-specific debug flags. Common patterns:

```bash
PI_SUB_DEBUG=1 PI_SUB_GWDG_DEBUG=1 pi --model gwdg/openai-gpt-oss-120b -p "prompt"
```

Always disable TUI with -p` flag.
Read the extension's code or documentation to find the specific environment variable names.

## Common Debugging Tasks

### Checking Cache Contents

View the current cache state:

```bash
# View all cache
cat ${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/cache/sub-core/cache.json

# Pretty print
jq '.' ${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/cache/sub-core/cache.json
```

### Clearing Cache

```bash
rm ${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/cache/sub-core/cache.json
```

## Provider-Specific Debugging

### GWDG Provider

The GWDG provider receives usage data from the pi-gwdg extension via events.

Debug variables:
- `PI_SUB_GWDG_DEBUG=1` - Enable detailed GWDG provider logging

Key debug messages to watch for:
- `[GWDG Provider] Received gwdg:usage event` - Event received from pi-gwdg
- `[GWDG Provider] Built windows:` - Rate windows constructed from event data
- `[GWDG Provider] Updated cache.gwdg:` - Cache updated with new data
- `[GWDG Provider] recalculateResetTimes:` - Window rollover detection

Common issues:

**No usage data showing:**
1. Verify pi-gwdg is emitting `gwdg:usage` events
2. Verify pi-sub receives data via `gwdg:usage` events from pi-gwdg
3. Check cache: `cat ${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/cache/sub-core/cache.json | jq '.gwdg'`
4. Ensure subscription tracking is enabled in pi-gwdg config

**Hour window not resetting:**
1. Check timestamp in cached data: `jq '.gwdg.gwdgUsageData.timestamp' ${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/cache/sub-core/cache.json`
2. Compare with current time: `date +%s000`
3. Look for rollover detection in logs: `recalculateResetTimes: hour window rolled over`


Structure:
- Stores raw data in `gwdgUsageData` with original timestamp
- Updates `usage` with processed data for most recently used key
- Maintains `usages[]` array for multi-key support

### Testing Rate Limiting by repeated bash commands

To test key rotation without heavy resource usage, use simple repeated tool calls:

```bash
PI_SUB_GWDG_DEBUG=1 pi -e . --model gwdg/qwen3-vl-30b-a3b-instruct -p "i want to debug key rotation ui behavior. all you have to do is call bash tool without timeout to run only a single date command. its important to wait for the result. repeat that a lot of times (no need to count explicitly) but always wait on the bash result. i know this sounds stupid but please do as i say and nothing else. do not think hard about it. it really just what i said. thank you"```
```

Each bash execution results in a separate API call, allowing you to observe rate limiting behavior.
Specify at least 60s timeout.

## Troubleshooting Tips

1. **Always enable debug flags** when investigating issues
2. **Check the cache first** - it contains the last known state but do not be confused as you yourself are a running process that overwrites cache
3. **Verify event reception** - if cache is empty, events aren't being received
4. **Look for timestamp issues** - rollover detection depends on accurate timestamps

## Analyzing Logs

When debugging, grep for these patterns:

```bash
# Event reception
grep "gwdg:usage event"

# Cache operations
grep "cache.gwdg"

# Window calculations
grep "Built windows\|recalculateReset"

# Rollover detection
grep "rolled over"
```

## Automated Debugging via Helper Scripts

### Clear cache before checks
```bash
PI_SUB_CLEAR_CACHE=1 ./.pi/skills/debug-pi-sub-gwdg-provider/debug-pi-sub-gwdg-provider.sh
```

The script performs these checks:
1. **Cache Check**: Verify `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/cache/sub-core/cache.json` exists and display its contents
2. **Rollover Check**: Run `check-rollover.js` to verify window rollover status
3. **Provider Event Check**: When debug flags are set, verify provider events are being received
4. **Summary**: Color-coded summary of all checks with results logged to `pi-sub-debug.log`

Example output:
```
=== pi-sub Debug Script ===
1. Checking Cache... ✓ Cache found
2. Checking Rollover Status... hour: ❌ ROLLED OVER
3. Checking Provider Events... ✓ GWDG debug enabled

=== Debug Summary ===
Cache: ✓ Exists
Rollover Check: ✓ Completed
Provider Events: ✓ Checked (gwdg)

Reading cache from: ${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/cache/sub-core/cache.json

=== Cache GWDG Data ===
Fetched at: 2026-02-24T09:15:00.000Z

=== Timestamp Comparison ===
Cached timestamp: 2026-02-24T09:00:00.000Z
Current time:     2026-02-24T10:10:34.000Z
Time difference:  1h 10m 34s

=== Rollover Status ===
minute    : ✓ OK  (Still within same minute window)
hour      : ❌ ROLLED OVER  (1 hour(s) have passed since data was cached)
day       : ✓ OK  (Still within same day window)
month     : ✓ OK  (Still in February)
```

The script is safe to run repeatedly and can be combined with manual debugging steps below.
