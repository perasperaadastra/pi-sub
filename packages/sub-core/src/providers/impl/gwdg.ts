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

interface GwdgEventData {
	timestamp: number;
	rateLimits: {
		minute?: GwdgRateLimitWindow;
		hour?: GwdgRateLimitWindow;
		day?: GwdgRateLimitWindow;
		month?: GwdgRateLimitWindow;
	};
	resetSeconds?: number;
	endpoint: string;
	keyId?: string;
}

interface GwdgCacheEntry extends CacheEntry {
	gwdgEventData: Record<string, GwdgEventData>;
	lastKeyId: string;
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

/**
 * Get the start of a time window (local time based) for rollover detection
 */
function getWindowStart(timestamp: number, windowKey: keyof typeof WINDOW_SECONDS): number {
	const date = new Date(timestamp);

	switch (windowKey) {
		case "month":
			return new Date(date.getFullYear(), date.getMonth(), 1, 0, 0, 0).getTime();

		case "day":
			return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0).getTime();

		case "hour":
			return new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), 0, 0).getTime();

		case "minute":
			return new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes(), 0).getTime();

		default:
			// Fallback to UTC-based calculation for unknown window types
			const windowDuration = WINDOW_SECONDS[windowKey as keyof typeof WINDOW_SECONDS] || 86400;
			return Math.floor(timestamp / 1000 / windowDuration) * windowDuration * 1000;
	}
}

function calculateResetSeconds(windowKey: keyof typeof WINDOW_SECONDS): number {
	const now = Date.now();
	const windowStart = getWindowStart(now, windowKey);

	// For month, we need to calculate next month start since duration varies
	if (windowKey === "month") {
		const currentMonthDate = new Date(windowStart);
		const nextMonthStart = new Date(currentMonthDate.getFullYear(), currentMonthDate.getMonth() + 1, 1, 0, 0, 0, 0).getTime();
		return Math.max(1, Math.floor((nextMonthStart - now) / 1000));
	}

	const windowDuration = WINDOW_SECONDS[windowKey];
	const secondsElapsed = (now - windowStart) / 1000;
	// Ensure at least 1 second is returned to avoid undefined reset fields at window boundaries
	return Math.max(1, Math.floor(windowDuration - secondsElapsed));
}

function calculateResetFields(
	windowKey: keyof typeof WINDOW_SECONDS
): { resetDescription: string; resetAt: string } {
	const resetSeconds = calculateResetSeconds(windowKey);
	const resetAt = new Date(Date.now() + resetSeconds * 1000);
	const granular = formatGranularTime(resetSeconds, WINDOW_THRESHOLDS[windowKey]);
	const resetDescription = granular ?? formatReset(resetAt);
	return { resetDescription, resetAt: resetAt.toISOString() };
}

/**
 * Recalculate reset times for existing windows (for live countdown)
 * Also checks for window rollover and resets usedPercent to 0 if needed
 */
function recalculateResetTimes(windows: RateWindow[], dataTimestamp: number): RateWindow[] {
	return windows.map((window) => {
		const windowKey = window.label as keyof typeof WINDOW_SECONDS;
		let updatedWindow = window;

		// Check for window rollover and reset usedPercent if needed
		if (windowKey in WINDOW_SECONDS && dataTimestamp > 0) {
			const isRolledOver = (() => {
				if (windowKey === "month") {
					const dataDate = new Date(dataTimestamp);
					const now = new Date();
					return dataDate.getMonth() !== now.getMonth() ||
						dataDate.getFullYear() !== now.getFullYear();
				}
				// Use local time-based window starts for rollover detection
				const dataWindowStart = getWindowStart(dataTimestamp, windowKey);
				const currentWindowStart = getWindowStart(Date.now(), windowKey);
				return currentWindowStart > dataWindowStart;
			})();

			if (isRolledOver) {
				debug(`recalculateResetTimes: ${windowKey} window rolled over, resetting usedPercent from ${updatedWindow.usedPercent} to 0`);
				updatedWindow = { ...updatedWindow, usedPercent: 0 };
			}
		}

		// Update reset times regardless of rollover
		const resetFields = calculateResetFields(windowKey);
		return { ...updatedWindow, ...resetFields };
	});
}

/**
 * Build rate windows from GWDG usage data
 * Note: Reset times are calculated at build time. Use recalculateResetTimes() in fetchUsage for live countdown.
 */
function buildRateWindows(data: GwdgEventData): RateWindow[] {
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
		// Use local time-based window starts for rollover detection
		const dataWindowStart = getWindowStart(data.timestamp, windowKey);
		const currentWindowStart = getWindowStart(Date.now(), windowKey);

		const rolledOver = currentWindowStart > dataWindowStart;

		debug(`isWindowRolledOver(${windowKey}): dataWindowStart=${new Date(dataWindowStart).toISOString()}, currentWindowStart=${new Date(currentWindowStart).toISOString()}, rolledOver=${rolledOver}`);
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
		const gwdgEventData = data as GwdgEventData;
		debug("Received event data:", JSON.stringify(gwdgEventData, null, 2));

		// Update the cache with the received data so it persists across session/model changes
		try {
			const windows = buildRateWindows(gwdgEventData);
			debug("Built windows:", JSON.stringify(windows, null, 2));

			const cache = readCache();
			debug("Initial cache:", JSON.stringify(cache.gwdg, null, 2));

			const usage: UsageSnapshot = {
				provider: "gwdg",
				displayName: "GWDG",
				windows,
				lastSuccessAt: gwdgEventData.timestamp,
			};

			// pi-gwdg sends keyId as string: "0" for base key, "1", "2", etc. for numbered keys
			// We store all events by their keyId for later retrieval
			const eventKeyId = gwdgEventData.keyId ?? "0";

			const existingCacheEntry = cache.gwdg as GwdgCacheEntry | undefined;
			const existingGwdgEventData = existingCacheEntry?.gwdgEventData ?? {};

			// Create new cache entry with updated data
			const newCacheEntry: GwdgCacheEntry = {
				fetchedAt: gwdgEventData.timestamp,
				status: existingCacheEntry?.status,
				usage,
				gwdgEventData: {
					...existingGwdgEventData,
					[eventKeyId]: gwdgEventData,
				},
				lastKeyId: eventKeyId,
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

function getGwdgCache(): GwdgCacheEntry | undefined {
	debug("getGwdgCache called");
	const cache = readCache();
	const entry = cache.gwdg;
	if (!entry || !("gwdgEventData" in entry)) {
		return undefined;
	}
	return entry as GwdgCacheEntry;
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

		if (gwdgCache) {
			const lastGwdgData = gwdgCache.gwdgEventData[gwdgCache.lastKeyId];
			if (lastGwdgData) {
				debug(`fetchUsage - using cache for keyId: ${gwdgCache.lastKeyId}`);
				const windows = buildRateWindows(lastGwdgData);
				debug("Built windows:", JSON.stringify(windows, null, 2));
				const windowsWithLiveReset = recalculateResetTimes(windows, lastGwdgData.timestamp);
				debug("fetchUsage - rebuilt windows from cache:", JSON.stringify(windowsWithLiveReset, null, 2));
				// Include keyId in snapshot for display in the provider label
				return this.snapshot({
					windows: windowsWithLiveReset,
					keyId: lastGwdgData.keyId,
					lastSuccessAt: lastGwdgData.timestamp,
				});
			}
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

		if (gwdgCache) {
			const lastGwdgData = gwdgCache.gwdgEventData[gwdgCache.lastKeyId];
			if (lastGwdgData) {
				debug("fetchStatus - using cache");
				const age = Date.now() - lastGwdgData.timestamp;
				// Data older than 1 minute might be stale
				if (age < 60 * 1000) {
					debug("fetchStatus - fresh cache", age);
					return { indicator: "none" };
				}
				debug("fetchStatus - stale cache", age);
			}
		}

		debug("fetchStatus - no cache");
		// No data yet - unknown status (will show gray indicator)
		return { indicator: "unknown" };
	}
}