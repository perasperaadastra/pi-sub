/**
 * GWDG usage provider - receives data via EventBus from pi-gwdg extension
 */

import type { Dependencies, RateWindow, UsageSnapshot, ProviderStatus } from "../../types.js";
import { BaseProvider } from "../../provider.js";
import { formatReset } from "../../utils.js";
import { readCache, writeCache } from "../../cache.js";
import type { CacheEntry } from "../../cache.js";
import { fetchFailed } from "../../errors.js";

const PI_SUB_GWDG_DEBUG = process.env.PI_SUB_GWDG_DEBUG === "1";

function debug(...args: unknown[]): void {
	if (PI_SUB_GWDG_DEBUG) {
		console.log("[GWDG Provider]", ...args);
	}
}

interface GwdgRateLimitWindow {
	used: number;
	limit: number;
	remaining: number;
}

interface GwdgUsageData {
	timestamp: number;
	rateLimits: {
		minute?: GwdgRateLimitWindow;
		hour?: GwdgRateLimitWindow;
		day?: GwdgRateLimitWindow;
		month?: GwdgRateLimitWindow;
	};
	resetSeconds?: number;
	endpoint: string;
}

const WINDOW_SECONDS = {
	minute: 60,
	hour: 3600,
	day: 86400,
	month: 2592000,
} as const;

const WINDOW_THRESHOLDS: Record<keyof typeof WINDOW_SECONDS, number[]> = {
	minute: [60],
	hour: [60],
	day: [60, 3600],
	month: [60, 3600, 86400],
};

function formatGranularTime(seconds: number, thresholds: number[]): string | null {
	if (seconds < thresholds[0]) return `${seconds}s`;
	if (seconds < thresholds[1]) return `${Math.floor(seconds / 60)}m`;
	if (thresholds[2] && seconds < thresholds[2]) return `${Math.floor(seconds / 3600)}h`;
	return null;
}

function calculateResetSeconds(windowKey: keyof typeof WINDOW_SECONDS): number {
	if (windowKey === "month") {
		const now = new Date();
		const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0);
		return Math.floor((endOfMonth.getTime() - now.getTime()) / 1000);
	}
	const windowDuration = WINDOW_SECONDS[windowKey];
	const now = Math.floor(Date.now() / 1000);
	const secondsIntoWindow = now % windowDuration;
	return windowDuration - secondsIntoWindow;
}

function calculateResetFields(
	windowKey: keyof typeof WINDOW_SECONDS
): { resetDescription: string; resetAt: string } | undefined {
	const resetSeconds = calculateResetSeconds(windowKey);
	if (resetSeconds <= 0) {
		return undefined;
	}
	const resetAt = new Date(Date.now() + resetSeconds * 1000);
	const granular = formatGranularTime(resetSeconds, WINDOW_THRESHOLDS[windowKey]);
	const resetDescription = granular ?? formatReset(resetAt);
	return { resetDescription, resetAt: resetAt.toISOString() };
}

/**
 * Recalculate reset times for existing windows (for live countdown)
 */
function recalculateResetTimes(windows: RateWindow[]): RateWindow[] {
	return windows.map((window) => {
		const windowKey = window.label as keyof typeof WINDOW_SECONDS;
		const resetFields = calculateResetFields(windowKey);
		if (resetFields) {
			return { ...window, ...resetFields };
		}
		return window;
	});
}

/**
 * Build rate windows from GWDG usage data
 * Note: Reset times are calculated at build time. Use recalculateResetTimes() in fetchUsage for live countdown.
 */
function buildRateWindows(data: GwdgUsageData): RateWindow[] {
	debug("buildRateWindows called with data:", JSON.stringify(data, null, 2));
	const windows: RateWindow[] = [];

	const isWindowRolledOver = (windowKey: keyof typeof WINDOW_SECONDS): boolean => {
		if (windowKey === "month") {
			const dataDate = new Date(data.timestamp);
			const now = new Date();
			const rolledOver = dataDate.getMonth() !== now.getMonth() ||
				dataDate.getFullYear() !== now.getFullYear();
			debug(`isWindowRolledOver(${windowKey}): dataMonth=${dataDate.getMonth()}, currentMonth=${now.getMonth()}, rolledOver=${rolledOver}`);
			return rolledOver;
		}
		const windowDuration = WINDOW_SECONDS[windowKey];
		const dataWindowStart = Math.floor(data.timestamp / 1000 / windowDuration) * windowDuration;
		const currentWindowStart = Math.floor(Date.now() / 1000 / windowDuration) * windowDuration;

		const rolledOver = currentWindowStart > dataWindowStart;

		debug(`isWindowRolledOver(${windowKey}): dataWindowStart=${dataWindowStart}, currentWindowStart=${currentWindowStart}, rolledOver=${rolledOver}`);
		return rolledOver;
	};

	const addWindow = (label: string, windowData: GwdgRateLimitWindow | undefined, windowKey?: keyof typeof WINDOW_SECONDS): void => {
		if (!windowData) {
			windows.push({ label, usedPercent: 0 });
			return;
		}

		let usedPercent = (windowData.used / windowData.limit) * 100;
		// Round to 2 decimal places
		usedPercent = Math.round(usedPercent * 100) / 100;

		if (windowKey && isWindowRolledOver(windowKey)) {
			debug(`addWindow: ${label} window rolled over, setting usedPercent to 0`);
			usedPercent = 0;
		}

		debug(`addWindow: final usedPercent for ${label}:`, usedPercent);

		// Build with initial reset times - will be recalculated in fetchUsage for live countdown
		const resetFields = windowKey ? calculateResetFields(windowKey) : undefined;

		windows.push({
			label,
			usedPercent,
			resetDescription: resetFields?.resetDescription,
			resetAt: resetFields?.resetAt,
		});
	};

	addWindow("minute", data.rateLimits.minute, "minute");
	addWindow("hour", data.rateLimits.hour, "hour");
	addWindow("day", data.rateLimits.day, "day");
	addWindow("month", data.rateLimits.month, "month");

	return windows;
}

// Event subscription tracking - ensures we only subscribe once per process
let globalEventUnsubscribe: (() => void) | null = null;
let globalSubscribed = false;

function ensureGlobalSubscription(deps: Dependencies): void {
	debug("ensureGlobalSubscription - subscribed:", globalSubscribed, "deps.pi:", !!deps?.pi);
	if (globalSubscribed || !deps?.pi) {
		debug("ensureGlobalSubscription - early return, globalSubscribed:", globalSubscribed, "deps.pi:", !!deps?.pi);
		return;
	}

	// Prevent overwriting existing unsubscribe function (race condition protection)
	if (globalEventUnsubscribe) {
		debug("ensureGlobalSubscription - cleaning up existing subscription before creating new one");
		globalEventUnsubscribe();
		globalEventUnsubscribe = null;
	}

	debug("ensureGlobalSubscription - subscribing to gwdg:usage:update");

	// Subscribe to usage updates from pi-gwdg
	globalEventUnsubscribe = deps.pi.events.on("gwdg:usage:update", (data: unknown) => {
		debug("GWDG EVENT RECEIVED!");
		const gwdgUsageData = data as GwdgUsageData;
		debug("Received event data:", JSON.stringify(gwdgUsageData, null, 2));

		// Update the cache with the received data so it persists across session/model changes
		try {
			const windows = buildRateWindows(gwdgUsageData);
			debug("Built windows:", JSON.stringify(windows, null, 2));

			const cache = readCache();
			debug("Initial cache:", JSON.stringify(cache.gwdg, null, 2));

			const usage: UsageSnapshot = {
				provider: "gwdg",
				displayName: "GWDG",
				windows,
				lastSuccessAt: Date.now(),
			};

			const existingCacheEntry = cache.gwdg;
			const newCacheEntry: CacheEntry & {
				gwdgUsageData: GwdgUsageData;
			} = {
				fetchedAt: gwdgUsageData.timestamp,
				status: existingCacheEntry?.status,
				usage,
				gwdgUsageData: gwdgUsageData
			};
			cache.gwdg = newCacheEntry;
			debug("Updated cache:", JSON.stringify(cache.gwdg, null, 2));

			writeCache(cache);
			debug("Cache updated");

		} catch (error) {
			console.warn("[GWDG Provider] Failed to update cache:", error);
		}
	});
	globalSubscribed = true;
	debug("Successfully subscribed to gwdg:usage:update");
}

/**
 * Unsubscribe from GWDG events and clean up resources
 */
export function unsubscribeGlobalGwdg(): void {
	debug("unsubscribeGlobalGwdg called");
	if (globalEventUnsubscribe) {
		debug("Unsubscribing from gwdg:usage:update");
		globalEventUnsubscribe();
		globalEventUnsubscribe = null;
		globalSubscribed = false;
		debug("Successfully unsubscribed from gwdg:usage:update");
	} else {
		debug("No active subscription to unsubscribe from");
	}
}

function getGwdgCache() {
	debug("getGwdgCache called");
	const cache = readCache();
	return cache.gwdg as CacheEntry & {gwdgUsageData: GwdgUsageData} | undefined;
}

export class GwdgProvider extends BaseProvider {
	readonly name = "gwdg" as const;
	readonly displayName = "GWDG";

	/**
	 * Subscribe to GWDG events if pi is available
	 */
	private ensureSubscribed(deps: Dependencies): void {
		ensureGlobalSubscription(deps);
	}

	/**
	 * Dispose of the provider and clean up resources
	 */
	dispose(): void {
		unsubscribeGlobalGwdg();
	}

	hasCredentials(_deps: Dependencies): boolean {
		// GWDG doesn't require explicit credentials check
		// The pi-gwdg extension handles auth via PI_GWDG_API_KEY env var
		return true;
	}

	async fetchUsage(deps: Dependencies): Promise<UsageSnapshot> {
		// Ensure we're subscribed to events
		this.ensureSubscribed(deps);

		debug("fetchUsage called");

		const gwdgCache = getGwdgCache();
		debug("gwdgCache:", JSON.stringify(gwdgCache, null, 2));

		if (gwdgCache?.gwdgUsageData) {
			debug("fetchUsage - using cache");
			const windows = buildRateWindows(gwdgCache.gwdgUsageData);
			debug("Built windows:", JSON.stringify(windows, null, 2));
			const windowsWithLiveReset = recalculateResetTimes(windows);
			debug("fetchUsage - rebuilt windows from cache:", JSON.stringify(windowsWithLiveReset, null, 2));
			return this.snapshot({ windows: windowsWithLiveReset });
		}

		// No data yet, return 0 for all windows
		debug("fetchUsage - no cache");

		return this.snapshot({
			windows: [
				{ label: "minute", usedPercent: 0 },
				{ label: "hour", usedPercent: 0 },
				{ label: "day", usedPercent: 0 },
				{ label: "month", usedPercent: 0 },
			],
			error: fetchFailed()
		});
	}

	async fetchStatus(_deps: Dependencies): Promise<ProviderStatus> {
		// Ensure we're subscribed to events (in case constructor wasn't called with deps)
		this.ensureSubscribed(_deps);

		debug("fetchStatus called");

		const gwdgCache = getGwdgCache();

		if (gwdgCache?.gwdgUsageData) {
			debug("fetchStatus - using cache");
			const age = Date.now() - gwdgCache.gwdgUsageData.timestamp;
			// Data older than 1 hour might be stale
			if (age < 60 * 60 * 1000) {
				debug("fetchStatus - stale cache", age)
				return { indicator: "none" };
			}
		}

		debug("fetchStatus - no cache");
		// No data yet - unknown status (will show gray indicator)
		return { indicator: "unknown" };
	}
}
