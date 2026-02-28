#!/bin/bash
# pi-sub-debug.sh - Automated debugging for pi-sub cache, rollover, and events
# Usage: [PI_SUB_GWDG_DEBUG=1] [PI_SUB_CLEAR_CACHE=1] ./pi-sub-debug.sh

# Config
CACHE_PATH="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/cache/sub-core/cache.json"
ROLLOVER_SCRIPT="./.pi/skills/debug-pi-sub/check-rollover.js"
DEBUG_LOG="pi-sub-debug.log"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Clear cache if requested
if [ "$PI_SUB_CLEAR_CACHE" = "1" ]; then
    echo -e "${YELLOW}Clearing cache: $CACHE_PATH${NC}"
    rm -f "$CACHE_PATH"
    echo -e "${GREEN}Cache cleared.${NC}\n"
fi

echo -e "${YELLOW}=== pi-sub Debug Script ===${NC}"
echo "Timestamp: $(date)"
echo "Cache: $CACHE_PATH"
echo "Log: $DEBUG_LOG"
echo -e "\n"

# --- Check 1: Cache Exists and Valid ---
echo -e "${YELLOW}1. Checking Cache...${NC}"
if [ ! -f "$CACHE_PATH" ]; then
    echo -e "${RED}❌ Cache not found: $CACHE_PATH${NC}"
else
    if command -v jq >/dev/null 2>&1; then
        echo -e "${GREEN}✓ Cache found. Contents:${NC}"
        jq '.' "$CACHE_PATH" | tee -a "$DEBUG_LOG"
    else
        echo -e "${YELLOW}⚠ jq not installed. Raw cache contents:${NC}"
        cat "$CACHE_PATH" | tee -a "$DEBUG_LOG"
    fi
    echo -e ""
fi

# --- Check 2: Rollover Status ---
echo -e "${YELLOW}2. Checking Rollover Status...${NC}"
if [ -f "$ROLLOVER_SCRIPT" ]; then
    if command -v node >/dev/null 2>&1; then
        echo -e "${GREEN}✓ Running rollover check:${NC}"
        node "$ROLLOVER_SCRIPT" 2>&1 | tee -a "$DEBUG_LOG"
    else
        echo -e "${RED}❌ Node.js not found. Cannot run rollover check.${NC}"
    fi
else
    echo -e "${RED}❌ Rollover script not found: $ROLLOVER_SCRIPT${NC}"
fi
echo -e "\n"

# --- Check 3: Provider Events (GWDG) ---
echo -e "${YELLOW}3. Checking Provider Events...${NC}"
PROVIDER=""
if [ "$PI_SUB_GWDG_DEBUG" = "1" ]; then
    PROVIDER="gwdg"
    echo -e "${GREEN}✓ GWDG debug enabled.${NC}"
    echo "Checking for 'gwdg:usage' events in logs..."
    grep -i "gwdg:usage\|GWDG Provider" "$DEBUG_LOG" 2>/dev/null || echo -e "${YELLOW}⚠ No GWDG events found in log.${NC}"
else
    echo -e "${YELLOW}ℹ No provider debug flag set. Skipping event check.${NC}"
    echo "To check provider events, run:"
    echo "  PI_SUB_GWDG_DEBUG=1 $0"  # $0 = this script
fi
echo -e "\n"
echo -e "\n"

# --- Summary ---
echo -e "${YELLOW}=== Debug Summary ===${NC}"
echo "1. Cache:" $([ -f "$CACHE_PATH" ] && echo -e "${GREEN}✓ Exists${NC}" || echo -e "${RED}❌ Missing${NC}")
echo "2. Rollover Check:" $(node "$ROLLOVER_SCRIPT" >/dev/null 2>&1 && echo -e "${GREEN}✓ Completed${NC}" || echo -e "${YELLOW}⚠ Not run${NC}")
echo "3. Provider Events:" $([ -n "$PROVIDER" ] && echo -e "${GREEN}✓ Checked ($PROVIDER)${NC}" || echo -e "${YELLOW}⚠ Skipped${NC}")

# Cleanup
echo -e "\n${GREEN}Debug log saved to: $DEBUG_LOG${NC}"