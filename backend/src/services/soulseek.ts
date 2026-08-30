/**
 * Direct Soulseek integration using soulseek-ts
 * Replaces the SLSKD Docker container with native Node.js connection
 */

import path from "path";
import fs from "fs";
import PQueue from "p-queue";
import { getSystemSettings } from "../utils/systemSettings";
import { sessionLog } from "../utils/playlistLogger";
import { redisClient } from "../utils/redis";
import { slskdClient } from "./slskdClient";

// Where slskd writes finished downloads inside its downloads dir (shared with
// Lidify at /downloads). Files land at `${downloadPath}/${INCOMING}/<basename>`.
const SLSKD_INCOMING = "_incoming";

// Debug mode for verbose search/ranking logs
const SOULSEEK_DEBUG = process.env.SOULSEEK_DEBUG === "true";

function debugLog(message: string): void {
    if (SOULSEEK_DEBUG) {
        sessionLog("SOULSEEK", `[DEBUG] ${message}`);
    }
}

const BITRATE_ATTR = 0;

// =============================================================================
// Rate Limiter - Prevents Soulseek server bans from too many searches
// Based on slsk-batchdl's proven approach: 34 searches per 220 seconds
// =============================================================================

class RateLimitedSemaphore {
    private tokens: number;
    private readonly maxTokens: number;
    private readonly refillIntervalMs: number;
    private lastRefill: number;

    constructor(maxSearches: number = 34, windowSeconds: number = 220) {
        this.maxTokens = maxSearches;
        this.tokens = maxSearches;
        this.refillIntervalMs = windowSeconds * 1000;
        this.lastRefill = Date.now();
    }

    /**
     * Acquire a search token, waiting if rate limit is exceeded
     */
    async acquire(): Promise<void> {
        this.tryRefill();
        
        while (this.tokens <= 0) {
            const waitTime = this.refillIntervalMs - (Date.now() - this.lastRefill);
            if (waitTime > 0) {
                sessionLog(
                    "SOULSEEK",
                    `Rate limit reached, waiting ${Math.ceil(waitTime / 1000)}s for token refresh...`,
                    "WARN"
                );
                await new Promise(r => setTimeout(r, Math.min(waitTime, 5000)));
            }
            this.tryRefill();
        }
        
        this.tokens--;
    }

    /**
     * Refill tokens if the time window has passed
     */
    private tryRefill(): void {
        const now = Date.now();
        if (now - this.lastRefill >= this.refillIntervalMs) {
            this.tokens = this.maxTokens;
            this.lastRefill = now;
            sessionLog("SOULSEEK", `Search tokens refilled (${this.maxTokens} available)`);
        }
    }

    /**
     * Get current status for debugging
     */
    getStatus(): { tokens: number; maxTokens: number; nextRefillMs: number } {
        return {
            tokens: this.tokens,
            maxTokens: this.maxTokens,
            nextRefillMs: Math.max(0, this.refillIntervalMs - (Date.now() - this.lastRefill)),
        };
    }
}

// =============================================================================
// User Reputation System - Track download failures per user
// Stored in Redis with 24-hour TTL for automatic reset
// =============================================================================

const USER_REP_PREFIX = "slsk:user:rep:";
const USER_REP_TTL_SECONDS = 24 * 60 * 60; // 24 hours

// Thresholds for user reputation
const REP_DOWNRANK_THRESHOLD = 1;    // 1+ failures: sort results lower
const REP_STRONG_DOWNRANK_THRESHOLD = 3; // 3+ failures: push to bottom
const REP_SKIP_THRESHOLD = 4;        // 4+ failures: skip user entirely

interface UserReputation {
    failures: number;
    lastFailure: number;
}

async function getUserReputation(username: string): Promise<UserReputation> {
    try {
        const data = await redisClient.hGetAll(`${USER_REP_PREFIX}${username}`);
        if (!data || !data.failures) {
            return { failures: 0, lastFailure: 0 };
        }
        return {
            failures: parseInt(data.failures, 10) || 0,
            lastFailure: parseInt(data.lastFailure, 10) || 0,
        };
    } catch {
        return { failures: 0, lastFailure: 0 };
    }
}

async function recordUserFailure(username: string): Promise<void> {
    try {
        const key = `${USER_REP_PREFIX}${username}`;
        // Use individual commands since multi() chaining works differently in redis v4
        await redisClient.hIncrBy(key, "failures", 1);
        await redisClient.hSet(key, "lastFailure", Date.now().toString());
        await redisClient.expire(key, USER_REP_TTL_SECONDS);
        
        const rep = await getUserReputation(username);
        sessionLog(
            "SOULSEEK",
            `User ${username} failure recorded (total: ${rep.failures})`,
            "WARN"
        );
    } catch (err: any) {
        sessionLog(
            "SOULSEEK",
            `Failed to record user failure for ${username}: ${err?.message || err}`,
            "ERROR"
        );
    }
}

async function recordUserSuccess(username: string): Promise<void> {
    try {
        const key = `${USER_REP_PREFIX}${username}`;
        const current = await getUserReputation(username);
        
        if (current.failures > 0) {
            // Decrement failures on success (reward good behavior)
            await redisClient.hIncrBy(key, "failures", -1);
            await redisClient.expire(key, USER_REP_TTL_SECONDS);
            
            sessionLog(
                "SOULSEEK",
                `User ${username} success recorded (failures now: ${current.failures - 1})`
            );
        }
    } catch (err: any) {
        sessionLog(
            "SOULSEEK",
            `Failed to record user success for ${username}: ${err?.message || err}`,
            "ERROR"
        );
    }
}

async function shouldSkipUser(username: string): Promise<boolean> {
    const rep = await getUserReputation(username);
    return rep.failures >= REP_SKIP_THRESHOLD;
}

async function getReputationPenalty(username: string): Promise<number> {
    const rep = await getUserReputation(username);
    
    if (rep.failures >= REP_STRONG_DOWNRANK_THRESHOLD) {
        return -50; // Strong penalty
    } else if (rep.failures >= REP_DOWNRANK_THRESHOLD) {
        return -20; // Mild penalty
    }
    return 0;
}

// =============================================================================
// Diacritics removal for search fallbacks
// =============================================================================

const DIACRITICS_MAP: Record<string, string> = {
    'à': 'a', 'á': 'a', 'â': 'a', 'ã': 'a', 'ä': 'a', 'å': 'a', 'æ': 'ae',
    'ç': 'c', 'è': 'e', 'é': 'e', 'ê': 'e', 'ë': 'e', 'ì': 'i', 'í': 'i',
    'î': 'i', 'ï': 'i', 'ñ': 'n', 'ò': 'o', 'ó': 'o', 'ô': 'o', 'õ': 'o',
    'ö': 'o', 'ø': 'o', 'ù': 'u', 'ú': 'u', 'û': 'u', 'ü': 'u', 'ý': 'y',
    'ÿ': 'y', 'ß': 'ss', 'œ': 'oe',
    'À': 'A', 'Á': 'A', 'Â': 'A', 'Ã': 'A', 'Ä': 'A', 'Å': 'A', 'Æ': 'AE',
    'Ç': 'C', 'È': 'E', 'É': 'E', 'Ê': 'E', 'Ë': 'E', 'Ì': 'I', 'Í': 'I',
    'Î': 'I', 'Ï': 'I', 'Ñ': 'N', 'Ò': 'O', 'Ó': 'O', 'Ô': 'O', 'Õ': 'O',
    'Ö': 'O', 'Ø': 'O', 'Ù': 'U', 'Ú': 'U', 'Û': 'U', 'Ü': 'U', 'Ý': 'Y',
    'Ÿ': 'Y', 'Œ': 'OE',
};

function removeDiacritics(str: string): string {
    return str.replace(/[àáâãäåæçèéêëìíîïñòóôõöøùúûüýÿßœÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÑÒÓÔÕÖØÙÚÛÜÝŸŒ]/g, 
        char => DIACRITICS_MAP[char] || char
    );
}

function hasDiacritics(str: string): boolean {
    return /[àáâãäåæçèéêëìíîïñòóôõöøùúûüýÿßœÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÑÒÓÔÕÖØÙÚÛÜÝŸŒ]/.test(str);
}

export interface SearchResult {
    user: string;
    file: string;
    size: number;
    slots: boolean;
    bitrate?: number;
    speed: number;
}

export interface TrackMatch {
    username: string;
    filename: string;
    fullPath: string;
    size: number;
    bitRate?: number;
    quality: string;
    score: number;
}

export interface SearchTrackResult {
    found: boolean;
    bestMatch: TrackMatch | null;
    allMatches: TrackMatch[]; // All ranked matches for retry
}

class SoulseekService {
    // Legacy soulseek-ts client field, retained only so existing guards/counters
    // compile after the slskd cutover. Never instantiated now — slskd is the
    // engine. See slskdClient + the slskd* helpers below.
    private client: any = null;
    private connecting = false;
    // Push Lidify's DB config (creds + upload limits + the _incoming download
    // subdirectory) into slskd once per process, so downloads land in a
    // deterministic place without the admin having to re-save credentials.
    private configSynced = false;
    private connectPromise: Promise<void> | null = null;
    private lastConnectAttempt = 0;
    private readonly RECONNECT_COOLDOWN = 30000; // 30 seconds between reconnect attempts
    private readonly CONNECTION_TIMEOUT = 10000; // 10 seconds to establish connection
    private readonly INACTIVITY_TIMEOUT = 30000; // 30 seconds with no data = stalled
    private readonly MAX_DOWNLOAD_TIMEOUT = 300000; // 5 minutes absolute max (safety net)
    private readonly MAX_DOWNLOAD_RETRIES = 5; // Try up to 5 different users

    // Connection health tracking
    private connectedAt: Date | null = null;
    private lastSuccessfulSearch: Date | null = null;
    private consecutiveEmptySearches = 0;
    private consecutiveErrors = 0; // Separate counter for actual errors (not empty results)
    private totalSearches = 0;
    private totalSuccessfulSearches = 0;

    private readonly SEARCH_CACHE_TTL_SECONDS = 24 * 60 * 60;
    private readonly MAX_CONSECUTIVE_EMPTY = 3; // After 3 empty searches, force reconnect
    private readonly MAX_CONSECUTIVE_ERRORS = 2; // After 2 errors, force reconnect

    // Rate limiter: 34 searches per 220 seconds (slsk-batchdl proven safe values)
    private readonly searchRateLimiter = new RateLimitedSemaphore(34, 220);

    /**
     * Normalize track title for better search results
     * Extracts main song name by removing live performance details, remasters, etc.
     * e.g. "Santa Claus Is Comin' to Town (Live at C.W. Post College, NY - Dec 1975)" → "Santa Claus Is Comin' to Town"
     */
    private normalizeTrackTitle(title: string): string {
        // First, normalize Unicode characters to ASCII equivalents for better search matching
        let normalized = title
            .replace(/…/g, "")           // Remove ellipsis (U+2026) - files don't have this
            .replace(/[''′`]/g, "'")     // Smart apostrophes → ASCII apostrophe
            .replace(/[""]/g, '"')       // Smart quotes → ASCII quotes
            .replace(/\//g, " ")         // Slash → space (file names can't have /)
            .replace(/[–—]/g, "-")       // En/em dash → hyphen
            .replace(/[×]/g, "x");       // Multiplication sign → x

        // Remove content in parentheses that contains live/remaster/remix info
        const livePatterns =
            /\s*\([^)]*(?:live|remaster|remix|version|edit|demo|acoustic|radio|single|extended|instrumental|feat\.|ft\.|featuring)[^)]*\)\s*/gi;
        normalized = normalized.replace(livePatterns, " ");

        // Also try brackets
        const bracketPatterns =
            /\s*\[[^\]]*(?:live|remaster|remix|version|edit|demo|acoustic|radio|single|extended|instrumental|feat\.|ft\.|featuring)[^\]]*\]\s*/gi;
        normalized = normalized.replace(bracketPatterns, " ");

        // Remove trailing dash content (often contains year or version info)
        normalized = normalized.replace(
            /\s*-\s*(\d{4}|remaster|live|remix|version|edit|demo|acoustic).*$/i,
            ""
        );

        // Clean up whitespace
        normalized = normalized.replace(/\s+/g, " ").trim();

        // If we stripped too much, return original
        if (normalized.length < 3) {
            return title;
        }

        return normalized;
    }

    private normalizeForCacheKey(value: string): string {
        return value
            .toLowerCase()
            .replace(/[''′`]/g, "'")
            .replace(/[^a-z0-9\s]/g, " ")
            .replace(/\s+/g, " ")
            .trim();
    }

    private getSearchCacheKey(artistName: string, trackTitle: string): string {
        const artist = this.normalizeForCacheKey(artistName);
        const title = this.normalizeForCacheKey(this.normalizeTrackTitle(trackTitle));
        return `slsk:match:${artist}:${title}`;
    }

    private async getCachedMatches(
        artistName: string,
        trackTitle: string
    ): Promise<TrackMatch[] | null> {
        try {
            const key = this.getSearchCacheKey(artistName, trackTitle);
            const raw = await redisClient.get(key);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) return null;

            return parsed
                .filter(
                    (m: any) =>
                        m &&
                        typeof m.username === "string" &&
                        typeof m.fullPath === "string" &&
                        typeof m.filename === "string"
                )
                .map(
                    (m: any): TrackMatch => ({
                        username: m.username,
                        filename: m.filename,
                        fullPath: m.fullPath,
                        size: Number(m.size ?? 0),
                        bitRate: m.bitRate ?? undefined,
                        quality:
                            typeof m.quality === "string"
                                ? m.quality
                                : this.getQualityFromFilename(
                                      m.filename,
                                      m.bitRate
                                  ),
                        score: Number(m.score ?? 0),
                    })
                );
        } catch {
            return null;
        }
    }

    private async setCachedMatches(
        artistName: string,
        trackTitle: string,
        matches: TrackMatch[]
    ): Promise<void> {
        try {
            const key = this.getSearchCacheKey(artistName, trackTitle);
            // Keep a small payload
            const compact = matches.slice(0, 10).map((m) => ({
                username: m.username,
                filename: m.filename,
                fullPath: m.fullPath,
                size: m.size,
                bitRate: m.bitRate,
                quality: m.quality,
                score: m.score,
            }));
            await redisClient.setEx(
                key,
                this.SEARCH_CACHE_TTL_SECONDS,
                JSON.stringify(compact)
            );
        } catch {
            // Ignore cache errors
        }
    }

    private buildSearchQueries(artistName: string, trackTitle: string): string[] {
        const normalizedTitle = this.normalizeTrackTitle(trackTitle);

        // Extra aggressive cleanup for playlist titles (soundtrack naming is noisy)
        const titleNoFrom = normalizedTitle
            .replace(/\s*\(from[^)]*\)\s*/gi, " ")
            .replace(/\s*-\s*from\s+.*$/i, "")
            .replace(/\s*\(original\s+motion\s+picture\s+score\)\s*/gi, " ")
            .replace(/\s*\(original\s+soundtrack\)\s*/gi, " ")
            .replace(/\s*\boriginal\s+motion\s+picture\s+score\b/gi, " ")
            .replace(/\s*\boriginal\s+soundtrack\b/gi, " ")
            .replace(/\s+/g, " ")
            .trim();

        const base = `${artistName} ${titleNoFrom}`.trim();

        // Fallback query: first 6 words of title (reduces over-specific searches)
        const titleWords = titleNoFrom.split(/\s+/).slice(0, 6).join(" ");
        const short = `${artistName} ${titleWords}`.trim();

        const queries = [base];
        if (short !== base) queries.push(short);
        
        // Add diacritics-free variants if the query contains accented characters
        // e.g., "Bjork" instead of "Bjork", "Sigur Ros" instead of "Sigur Ros"
        if (hasDiacritics(base)) {
            const noDiacriticsBase = removeDiacritics(base);
            if (noDiacriticsBase !== base) {
                queries.push(noDiacriticsBase);
            }
        }
        
        // Title-only fallback for rare tracks where artist name might be wrong/different
        if (titleNoFrom.length >= 5) {
            const titleOnly = titleNoFrom;
            if (!queries.includes(titleOnly)) {
                queries.push(titleOnly);
            }
        }
        
        return Array.from(new Set(queries));
    }

    private flattenSearchResults(results: Array<any>): SearchResult[] {
        const flattened: SearchResult[] = [];
        for (const result of results || []) {
            const slots = Boolean(result.slotsFree);
            const speed = Number(result.avgSpeed || 0);
            for (const file of result.files || []) {
                const bitrate = file.attrs?.get?.(BITRATE_ATTR);
                const sizeValue =
                    typeof file.size === "bigint"
                        ? Number(file.size)
                        : Number(file.size ?? 0);
                flattened.push({
                    user: result.username,
                    file: file.filename,
                    size: Number.isFinite(sizeValue) ? sizeValue : 0,
                    slots,
                    bitrate: bitrate ?? undefined,
                    speed,
                });
            }
        }
        return flattened;
    }

    /**
     * Connect to Soulseek network
     */
    async connect(): Promise<void> {
        // slskd owns the Soulseek connection now. Just nudge it to connect;
        // credentials live in slskd's config (pushed from Settings save/Test).
        await slskdClient.connect();
    }

    /**
     * Force disconnect and clear client state
     */
    private forceDisconnect(): void {
        const uptime = this.connectedAt
            ? Math.round((Date.now() - this.connectedAt.getTime()) / 1000)
            : 0;
        sessionLog(
            "SOULSEEK",
            `Force disconnecting (was connected for ${uptime}s)`,
            "WARN"
        );
        this.client?.destroy();
        this.client = null;
        this.connectedAt = null;
        this.lastConnectAttempt = 0; // Allow immediate reconnect
    }

    /**
     * Ensure we have an active connection
     * @param force - If true, disconnect and reconnect even if client exists
     */
    private async ensureConnected(_force: boolean = false): Promise<void> {
        // slskd manages the Soulseek connection. Just make sure the sidecar is
        // reachable; if it's up but not connected, nudge it (best-effort).
        if (!(await slskdClient.isReachable())) {
            throw new Error("slskd sidecar not reachable");
        }
        await this.ensureSlskdConfigured();
        try {
            const state = await slskdClient.getServerState();
            if (!(state.isConnected && state.isLoggedIn)) {
                await slskdClient.connect().catch(() => undefined);
            }
        } catch {
            // Reachable but state check failed — let the caller proceed and fail
            // on the actual search/download if truly disconnected.
        }
    }

    /**
     * One-time (per process) reconciliation of slskd's config from Lidify's DB:
     * credentials + upload slots/speed + the fixed `_incoming` download
     * subdirectory. Ensures downloads land deterministically even if the admin
     * hasn't re-saved credentials since the slskd cutover. Best-effort.
     */
    private async ensureSlskdConfigured(): Promise<void> {
        if (this.configSynced) return;
        this.configSynced = true; // set first to avoid concurrent double-apply
        try {
            const settings = await getSystemSettings();
            if (settings?.soulseekUsername && settings?.soulseekPassword) {
                await slskdClient.applyConfig({
                    username: settings.soulseekUsername,
                    password: settings.soulseekPassword,
                    uploadSlots: settings.soulseekUploadSlots,
                    uploadSpeedLimitKbps: settings.soulseekUploadSpeedLimitKbps,
                });
                sessionLog(
                    "SOULSEEK",
                    "Synced slskd config from settings (creds, upload limits, _incoming)"
                );
            }
        } catch {
            // Allow a retry on the next call if the sync failed.
            this.configSynced = false;
        }
    }

    /**
     * Check if connected to Soulseek (via slskd). Async now; kept for callers
     * that await it. Returns false on any error.
     */
    async isConnected(): Promise<boolean> {
        try {
            const s = await slskdClient.getServerState();
            return Boolean(s.isConnected && s.isLoggedIn);
        } catch {
            return false;
        }
    }

    /**
     * Available when credentials are configured AND the slskd sidecar is up.
     */
    async isAvailable(): Promise<boolean> {
        try {
            const settings = await getSystemSettings();
            if (!(settings?.soulseekUsername && settings?.soulseekPassword)) {
                return false;
            }
            return await slskdClient.isReachable();
        } catch {
            return false;
        }
    }

    /**
     * Get connection status from slskd.
     */
    async getStatus(): Promise<{
        connected: boolean;
        username: string | null;
    }> {
        const settings = await getSystemSettings();
        let connected = false;
        try {
            const s = await slskdClient.getServerState();
            connected = Boolean(s.isConnected && s.isLoggedIn);
        } catch {
            // sidecar unreachable → not connected
        }
        return {
            connected,
            username: settings?.soulseekUsername || null,
        };
    }

    /**
     * Run a search via slskd and map its responses to the flattened SearchResult
     * shape the ranking pipeline expects. Drop-in for the old
     * client.search()+flattenSearchResults() path.
     */
    private async slskdSearch(
        query: string,
        timeoutMs: number
    ): Promise<SearchResult[]> {
        const responses = await slskdClient.search(query, { timeoutMs });
        const out: SearchResult[] = [];
        for (const r of responses || []) {
            for (const f of r.files || []) {
                if ((f as any).isLocked) continue;
                out.push({
                    user: r.username,
                    file: f.filename,
                    size: Number(f.size) || 0,
                    slots: Boolean(r.hasFreeUploadSlot),
                    bitrate:
                        typeof (f as any).bitRate === "number"
                            ? (f as any).bitRate
                            : undefined,
                    speed: Number(r.uploadSpeed) || 0,
                });
            }
        }
        return out;
    }

    /**
     * Recursively find the newest file matching `base` (basename) under `dir`.
     */
    /**
     * Case-insensitive, rename-tolerant lookup of `base` directly inside each of
     * `dirs` (non-recursive). slskd may write a different case than the remote
     * name, and its "exists: rename" appends " (1)" etc.
     */
    private findInDirs(dirs: string[], base: string): string | null {
        const lc = base.toLowerCase();
        const dot = lc.lastIndexOf(".");
        const ext = dot >= 0 ? lc.slice(dot) : "";
        const stem = dot >= 0 ? lc.slice(0, dot) : lc;
        for (const dir of dirs) {
            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch {
                continue;
            }
            // Exact (case-insensitive) match first.
            for (const e of entries) {
                if (e.isFile() && e.name.toLowerCase() === lc) {
                    return path.join(dir, e.name);
                }
            }
            // Rename-tolerant: "<stem> (1).<ext>".
            for (const e of entries) {
                const n = e.name.toLowerCase();
                if (e.isFile() && n.startsWith(stem) && n.endsWith(ext)) {
                    return path.join(dir, e.name);
                }
            }
        }
        return null;
    }

    /**
     * Bounded recursive (case-insensitive) search for `base` under `dir`,
     * skipping the given directory names (e.g. the Playlists library tree, where
     * already-moved files live). Returns the newest match.
     */
    private findFileRecursive(
        dir: string,
        base: string,
        skip: Set<string>,
        depth = 0
    ): string | null {
        const lc = base.toLowerCase();
        let best: { p: string; m: number } | null = null;
        if (depth > 4) return null;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return null;
        }
        for (const e of entries) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (skip.has(e.name)) continue;
                const r = this.findFileRecursive(p, base, skip, depth + 1);
                if (r) {
                    try {
                        const m = fs.statSync(r).mtimeMs;
                        if (!best || m > best.m) best = { p: r, m };
                    } catch {
                        /* ignore */
                    }
                }
            } else if (e.name.toLowerCase() === lc) {
                try {
                    const m = fs.statSync(p).mtimeMs;
                    if (!best || m > best.m) best = { p, m };
                } catch {
                    /* ignore */
                }
            }
        }
        return best?.p ?? null;
    }

    private moveTo(src: string, destPath: string): boolean {
        try {
            fs.mkdirSync(path.dirname(destPath), { recursive: true });
            try {
                fs.renameSync(src, destPath);
            } catch {
                // Cross-device or other rename failure → copy + unlink.
                fs.copyFileSync(src, destPath);
                fs.unlinkSync(src);
            }
            return true;
        } catch (e: any) {
            sessionLog(
                "SOULSEEK",
                `Failed to move ${src} -> ${destPath}: ${e.message}`,
                "WARN"
            );
            return false;
        }
    }

    /**
     * Locate a completed slskd download on disk and move it to destPath. Handles
     * both layouts: the fixed `${downloadBase}/${SLSKD_INCOMING}/` (when we've
     * pushed that config) and slskd's default `${SOURCE_DIRECTORY}` template
     * (`${downloadBase}/<remote parent folder>/`). Retries briefly because slskd
     * finalizes (incomplete→complete) a moment after "Completed, Succeeded".
     */
    private async locateAndMove(
        remoteFilename: string,
        downloadBase: string,
        destPath: string
    ): Promise<boolean> {
        const norm = remoteFilename.replace(/\\/g, "/");
        const base = path.basename(norm);
        const sourceDir = path.basename(path.dirname(norm)); // slskd ${SOURCE_DIRECTORY}
        const fastDirs = [
            path.join(downloadBase, SLSKD_INCOMING),
            sourceDir ? path.join(downloadBase, sourceDir) : downloadBase,
            downloadBase,
        ];
        // Skip the destination library tree so we never re-match an already-moved
        // file from a previous track.
        const skip = new Set<string>(["Playlists"]);
        for (let attempt = 0; attempt < 5; attempt++) {
            const hit =
                this.findInDirs(fastDirs, base) ||
                this.findFileRecursive(downloadBase, base, skip);
            if (hit) return this.moveTo(hit, destPath);
            await new Promise((r) => setTimeout(r, 600));
        }
        return false;
    }

    /**
     * Search for a track and return the best match plus alternatives for retry
     */
    async searchTrack(
        artistName: string,
        trackTitle: string,
        isRetry: boolean = false,
        options?: {
            timeoutMs?: number;
            queryOverride?: string;
            preferFlac?: boolean;
            allowMp3320Fallback?: boolean;
            allowMp3256Fallback?: boolean;
            skipCache?: boolean;
        }
    ): Promise<SearchTrackResult> {
        this.totalSearches++;
        const searchId = this.totalSearches;
        const connectionAge = this.connectedAt
            ? Math.round((Date.now() - this.connectedAt.getTime()) / 1000)
            : 0;

        try {
            await this.ensureConnected();
        } catch (err: any) {
            sessionLog(
                "SOULSEEK",
                `[Search #${searchId}] slskd not ready: ${err.message}`,
                "ERROR"
            );
            return { found: false, bestMatch: null, allMatches: [] };
        }

        if (!options?.skipCache) {
            const cached = await this.getCachedMatches(artistName, trackTitle);
            if (cached && cached.length > 0) {
                const qualityFiltered = this.selectMatchesByQuality(cached, options);
                if (qualityFiltered && qualityFiltered.length > 0) {
                    // Validate cached matches against the title using the basename.
                    // Older cache entries may be polluted by folder-name matches.
                    const hasTitleSignal = (filename: string, title: string): boolean => {
                        const normalizedTitle = title
                            .toLowerCase()
                            .replace(/[^a-z0-9\s]/g, "")
                            .replace(/^\d+\s*[-.]?\s*/, "");
                        const normalizedFilename = (filename || "")
                            .toLowerCase()
                            .replace(/[^a-z0-9]/g, "")
                            .replace(/^\d+[-.]?/, "");

                        const titleNoSpaces = normalizedTitle.replace(/\s/g, "");
                        if (
                            titleNoSpaces.length > 0 &&
                            normalizedFilename.includes(titleNoSpaces)
                        ) {
                            return true;
                        }

                        const titleWords = normalizedTitle
                            .split(/\s+/)
                            .filter((w) => w.length > 2)
                            .slice(0, 3);
                        if (
                            titleWords.length > 0 &&
                            titleWords.every((w) => normalizedFilename.includes(w))
                        ) {
                            return true;
                        }

                        return (
                            titleWords.length > 0 &&
                            titleWords.some(
                                (w) =>
                                    w.length > 4 &&
                                    normalizedFilename.includes(w)
                            )
                        );
                    };

                    const filtered = qualityFiltered.filter((m) =>
                        hasTitleSignal(m.filename, trackTitle)
                    );
                    if (filtered.length > 0) {
                        const best = filtered[0];
                        sessionLog(
                            "SOULSEEK",
                            `[Search #${searchId}] Cache hit: ${best.filename} | ${best.quality} | ${Math.round(
                                best.size / 1024 / 1024
                            )}MB | User: ${best.username} | Score: ${best.score}`
                        );
                        return {
                            found: true,
                            bestMatch: best,
                            allMatches: filtered,
                        };
                    }
                    // Cached matches exist but don't look like the requested title - fall back to live search.
                }
            }
        }

        const timeoutMs = options?.timeoutMs ?? 8000;
        const query = options?.queryOverride
            ? options.queryOverride
            : this.buildSearchQueries(artistName, trackTitle)[0];
        
        // Rate limit: acquire token before searching (prevents server bans)
        await this.searchRateLimiter.acquire();
        
        sessionLog(
            "SOULSEEK",
            `[Search #${searchId}] Searching: "${query}" (connected ${connectionAge}s, ${this.consecutiveEmptySearches} consecutive empty)`
        );
        try {
            const searchStartTime = Date.now();
            const results = await this.slskdSearch(query, timeoutMs);
            const searchDuration = Date.now() - searchStartTime;

            if (!results || results.length === 0) {
                this.consecutiveEmptySearches++;
                sessionLog(
                    "SOULSEEK",
                    `[Search #${searchId}] No results found after ${searchDuration}ms (${this.consecutiveEmptySearches}/${this.MAX_CONSECUTIVE_EMPTY} consecutive empty)`,
                    "WARN"
                );

                // Force reconnect if too many consecutive empty searches (zombie connection)
                if (this.consecutiveEmptySearches >= this.MAX_CONSECUTIVE_EMPTY) {
                    sessionLog(
                        "SOULSEEK",
                        `Too many empty searches (${this.consecutiveEmptySearches}) - forcing reconnect`,
                        "WARN"
                    );
                    this.forceDisconnect();
                    this.consecutiveEmptySearches = 0;
                }

                return { found: false, bestMatch: null, allMatches: [] };
            }

            this.consecutiveEmptySearches = 0;
            this.consecutiveErrors = 0;
            this.lastSuccessfulSearch = new Date();
            this.totalSuccessfulSearches++;

            sessionLog(
                "SOULSEEK",
                `[Search #${searchId}] Found ${
                    results.length
                } results in ${searchDuration}ms (success rate: ${Math.round(
                    (this.totalSuccessfulSearches / this.totalSearches) * 100
                )}%)`
            );

            const audioExtensions = [
                ".flac",
                ".mp3",
                ".m4a",
                ".ogg",
                ".opus",
                ".wav",
                ".aac",
            ];
            const audioFiles = results.filter((r) => {
                const filename = (r.file || "").toLowerCase();
                const isAudio = audioExtensions.some((ext) =>
                    filename.endsWith(ext)
                );
                return isAudio;
            });

            if (audioFiles.length === 0) {
                sessionLog(
                    "SOULSEEK",
                    `[Search #${searchId}] No audio files in ${results.length} results`,
                    "WARN"
                );
                return { found: false, bestMatch: null, allMatches: [] };
            }

            const rankedMatchesRaw = this.rankAllResults(
                audioFiles,
                artistName,
                trackTitle
            );

            // Apply user reputation penalties (downrank/skip users with failures)
            const reputationAdjusted = await this.applyReputationToMatches(rankedMatchesRaw);

            const rankedMatches = this.selectMatchesByQuality(
                reputationAdjusted,
                options
            );

            if (rankedMatches.length === 0) {
                sessionLog(
                    "SOULSEEK",
                    `[Search #${searchId}] No suitable match found from ${audioFiles.length} audio files`,
                    "WARN"
                );
                if (SOULSEEK_DEBUG && audioFiles.length > 0) {
                    // Show what we rejected when debug is on
                    debugLog(`Search #${searchId} rejected all ${audioFiles.length} candidates. Enable SOULSEEK_DEBUG=true to see scoring details above.`);
                }
                return { found: false, bestMatch: null, allMatches: [] };
            }

            const best = rankedMatches[0];
            sessionLog(
                "SOULSEEK",
                `[Search #${searchId}] ✓ MATCH: ${best.filename} | ${
                    best.quality
                } | ${Math.round(best.size / 1024 / 1024)}MB | User: ${
                    best.username
                } | Score: ${best.score}`
            );
            sessionLog(
                "SOULSEEK",
                `[Search #${searchId}] Found ${rankedMatches.length} alternative sources for retry`
            );

            await this.setCachedMatches(artistName, trackTitle, rankedMatchesRaw);

            return {
                found: true,
                bestMatch: best,
                allMatches: rankedMatches,
            };
        } catch (err: any) {
            sessionLog(
                "SOULSEEK",
                `[Search #${searchId}] Search error: ${err.message}`,
                "ERROR"
            );
            this.consecutiveErrors++;

            if (!isRetry && this.consecutiveErrors >= this.MAX_CONSECUTIVE_ERRORS) {
                sessionLog(
                    "SOULSEEK",
                    `[Search #${searchId}] Too many consecutive errors (${this.consecutiveErrors}), forcing reconnect and retry...`,
                    "WARN"
                );
                this.forceDisconnect();
                return await this.searchTrack(artistName, trackTitle, true);
            }

            return { found: false, bestMatch: null, allMatches: [] };
        }
    }

    /**
     * Search for files using a free-form query (returns raw results)
     */
    async searchQuery(query: string): Promise<SearchResult[]> {
        try {
            await this.ensureConnected();
        } catch {
            return [];
        }

        // Rate limit: acquire token before searching
        await this.searchRateLimiter.acquire();

        try {
            return await this.slskdSearch(query, 8000);
        } catch {
            return [];
        }
    }

    /**
     * Rank all search results and return sorted matches (best first)
     * Filters out matches below minimum score threshold
     */
    private rankAllResults(
        results: SearchResult[],
        artistName: string,
        trackTitle: string
    ): TrackMatch[] {
        // Normalize search terms for matching
        const normalizedArtist = artistName
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, "");
        const normalizedTitle = trackTitle
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, "")
            .replace(/^\d+\s*[-.]?\s*/, ""); // Remove leading track numbers

        // Get first word of artist for fuzzy matching
        const artistFirstWord = normalizedArtist.split(/\s+/)[0];
        // Get first few significant words of title
        const titleWords = normalizedTitle
            .split(/\s+/)
            .filter((w) => w.length > 2)
            .slice(0, 3);

        debugLog(`Ranking ${results.length} candidates for "${artistName} - ${trackTitle}"`);
        debugLog(`  Normalized: artist="${normalizedArtist}" (firstWord="${artistFirstWord}"), title="${normalizedTitle}" (words=${titleWords.join(",")})`);

        const scored = results.map((file) => {
            const filename = (file.file || "").toLowerCase();
            const shortFilename = filename.split(/[/\\]/).pop() || filename;
            const normalizedFilename = filename.replace(/[^a-z0-9]/g, "");
            const normalizedShortFilename = shortFilename.replace(/[^a-z0-9]/g, "");

            let score = 0;
            let titleMatched = false;
            const scoreBreakdown: string[] = [];

            // Prefer files with slots available (+40)
            // Most "download failed" cases are just no free slots.
            if (file.slots) {
                score += 40;
                scoreBreakdown.push("slots:+40");
            } else {
                score -= 10;
                scoreBreakdown.push("no-slots:-10");
            }

            // Check if filename contains artist (full or first word)
            if (
                normalizedFilename.includes(normalizedArtist.replace(/\s/g, ""))
            ) {
                score += 50; // Full artist match
                scoreBreakdown.push("artist-full:+50");
            } else if (
                artistFirstWord.length >= 3 &&
                normalizedFilename.includes(artistFirstWord)
            ) {
                score += 35; // Partial artist match (first word)
                scoreBreakdown.push("artist-partial:+35");
            } else {
                scoreBreakdown.push("artist:0");
            }

            // Check if *basename* contains title (full or partial)
            // Note: Using the full path here can cause false positives when the directory name
            // contains the title (e.g. album folder "Keasbey Nights"), making every track in the
            // folder look like a title match.
            const titleNoSpaces = normalizedTitle.replace(/\s/g, "");
            if (normalizedShortFilename.includes(titleNoSpaces)) {
                score += 50; // Full title match
                titleMatched = true;
                scoreBreakdown.push("title-full:+50");
            } else if (
                titleWords.length > 0 &&
                titleWords.every((w) => normalizedShortFilename.includes(w))
            ) {
                score += 40; // All significant title words match
                titleMatched = true;
                scoreBreakdown.push("title-allwords:+40");
            } else if (
                titleWords.length > 0 &&
                titleWords.some(
                    (w) => w.length > 4 && normalizedShortFilename.includes(w)
                )
            ) {
                score += 25; // At least one significant title word matches
                titleMatched = true;
                scoreBreakdown.push("title-somewords:+25");
            } else {
                scoreBreakdown.push("title:0");
            }

            // Guard against "artist-only" matches.
            // Without some title signal, we can end up downloading the wrong track from the same artist/album.
            if (!titleMatched) {
                score -= 80;
                scoreBreakdown.push("no-title-match:-80");
            }

            // Prefer FLAC (+35)
            if (filename.endsWith(".flac")) {
                score += 35;
                scoreBreakdown.push("flac:+35");
            }
            // Then high-quality MP3 (+20 for 320)
            else if (
                filename.endsWith(".mp3") &&
                ((file.bitrate || 0) >= 320 || filename.includes("320"))
            ) {
                score += 20;
                scoreBreakdown.push("mp3-320:+20");
            }

            // Prefer reasonable file sizes
            const sizeMB = (file.size || 0) / 1024 / 1024;
            if (sizeMB >= 3 && sizeMB <= 100) {
                score += 10;
                scoreBreakdown.push("size-ok:+10");
            }
            if (sizeMB >= 10 && sizeMB <= 50) {
                score += 5; // FLAC range
                scoreBreakdown.push("size-flac:+5");
            }

            // Prefer higher speed peers (helps overall throughput and success)
            if (file.speed > 3000000) {
                score += 25; // >3MB/s
                scoreBreakdown.push("speed-fast:+25");
            } else if (file.speed > 1500000) {
                score += 15; // >1.5MB/s
                scoreBreakdown.push("speed-med:+15");
            } else if (file.speed > 800000) {
                score += 8; // >0.8MB/s
                scoreBreakdown.push("speed-ok:+8");
            }

            const quality = this.getQualityFromFilename(
                file.file,
                file.bitrate
            );

            debugLog(`  Candidate: "${shortFilename}" by ${file.user}`);
            debugLog(`    Path: ${file.file}`);
            debugLog(`    Quality: ${quality}, Size: ${sizeMB.toFixed(1)}MB, Slots: ${file.slots ? "yes" : "no"}, Speed: ${((file.speed || 0) / 1000000).toFixed(1)}MB/s`);
            debugLog(`    Score: ${score} [${scoreBreakdown.join(", ")}]`);

            return {
                username: file.user,
                filename: shortFilename,
                fullPath: file.file,
                size: file.size,
                bitRate: file.bitrate,
                quality,
                score,
            };
        });

        // Sort by score descending, filter by minimum threshold
        // Score 20+ is acceptable: slots(20) OR artist match(35-50) OR title match(25-50)
        const passed = scored
            .filter((m) => m.score >= 20)
            .sort((a, b) => b.score - a.score)
            .slice(0, 10); // Keep top 10 for retry purposes

        const rejected = scored.filter((m) => m.score < 20);
        
        debugLog(`  Results: ${passed.length} passed (score >= 20), ${rejected.length} rejected`);
        if (passed.length > 0) {
            debugLog(`  Best match: "${passed[0].filename}" score=${passed[0].score}`);
        } else if (scored.length > 0) {
            const best = scored.sort((a, b) => b.score - a.score)[0];
            debugLog(`  All rejected - best was "${best.filename}" score=${best.score} (needed >= 20)`);
        }

        return passed;
    }

    /**
     * Apply user reputation penalties to ranked matches
     * - Users with failures get score penalties
     * - Users with 4+ failures are filtered out entirely
     */
    private async applyReputationToMatches(matches: TrackMatch[]): Promise<TrackMatch[]> {
        if (matches.length === 0) return matches;

        // Get unique usernames
        const usernames = [...new Set(matches.map(m => m.username))];
        
        // Fetch all reputations in parallel
        const reputations = new Map<string, number>();
        await Promise.all(
            usernames.map(async (username) => {
                const penalty = await getReputationPenalty(username);
                const shouldSkip = await shouldSkipUser(username);
                reputations.set(username, shouldSkip ? -1000 : penalty);
            })
        );

        // Apply penalties and filter
        const adjusted = matches
            .map(m => ({
                ...m,
                score: m.score + (reputations.get(m.username) || 0),
            }))
            .filter(m => m.score > -500) // Filter out skipped users
            .sort((a, b) => b.score - a.score);

        // Log if any users were penalized
        const penalized = usernames.filter(u => (reputations.get(u) || 0) < 0);
        if (penalized.length > 0) {
            sessionLog(
                "SOULSEEK",
                `Applied reputation penalties to ${penalized.length} users: ${penalized.join(", ")}`
            );
        }

        return adjusted;
    }

    private isFlac(match: TrackMatch): boolean {
        return match.filename.toLowerCase().endsWith(".flac");
    }

    private isMp3320(match: TrackMatch): boolean {
        if (!match.filename.toLowerCase().endsWith(".mp3")) return false;
        if ((match.bitRate || 0) >= 320) return true;
        return /\b320\b/.test(match.filename);
    }

    private isMp3256(match: TrackMatch): boolean {
        if (!match.filename.toLowerCase().endsWith(".mp3")) return false;
        const bitrate = match.bitRate || 0;
        if (bitrate >= 256 && bitrate < 320) return true;
        return /\b256\b/.test(match.filename);
    }

    private selectMatchesByQuality(
        matches: TrackMatch[],
        options?: {
            preferFlac?: boolean;
            allowMp3320Fallback?: boolean;
            allowMp3256Fallback?: boolean;
        }
    ): TrackMatch[] {
        const preferFlac = options?.preferFlac !== false;
        const allowMp3320Fallback = options?.allowMp3320Fallback !== false;
        const allowMp3256Fallback = options?.allowMp3256Fallback !== false;

        if (matches.length === 0) return matches;
        if (!preferFlac) return matches;

        // Keep only FLAC + MP3 320 + MP3 256 when in "quality preferred" mode.
        // Order: FLAC first, then 320, then 256 as last resort.
        const flacs = matches.filter((m) => this.isFlac(m));
        const mp3_320s = allowMp3320Fallback
            ? matches.filter((m) => this.isMp3320(m))
            : [];
        const mp3_256s = allowMp3256Fallback
            ? matches.filter((m) => this.isMp3256(m) && !this.isMp3320(m))
            : [];

        const combined = [...flacs, ...mp3_320s, ...mp3_256s];
        if (combined.length > 0) {
            // Preserve original ranking order within each tier.
            return combined;
        }

        return [];
    }

    /**
     * Download a track directly to the music library with timeout
     */
    async downloadTrack(
        match: TrackMatch,
        destPath: string
    ): Promise<{ success: boolean; error?: string }> {
        try {
            await this.ensureConnected();
        } catch (err: any) {
            // Don't record connection failures as user failures
            return { success: false, error: err.message };
        }

        const settings = await getSystemSettings();
        const downloadBase = settings?.downloadPath || "/downloads";
        fs.mkdirSync(path.dirname(destPath), { recursive: true });

        sessionLog(
            "SOULSEEK",
            `Downloading from ${match.username}: ${match.filename} -> ${destPath} (slskd)`
        );

        const result = await this.slskdDownloadToDest(
            match,
            match.fullPath,
            match.size || 0,
            downloadBase,
            destPath
        );

        // Record reputation based on download result
        if (result.success) {
            await recordUserSuccess(match.username);
        } else {
            await recordUserFailure(match.username);
        }

        return result;
    }

    /**
     * Enqueue a download via slskd, wait for completion, then move the finished
     * file to destPath. Mirrors the old per-source semantics so the caller's
     * retry loop can move to the next source: give up (failure) if the transfer
     * stays queued too long, stalls mid-transfer, or errors.
     */
    private async slskdDownloadToDest(
        match: TrackMatch,
        remote: string,
        size: number,
        downloadBase: string,
        destPath: string
    ): Promise<{ success: boolean; error?: string }> {
        try {
            await slskdClient.enqueueDownload(match.username, [
                { filename: remote, size },
            ]);
        } catch (e: any) {
            return {
                success: false,
                error: `enqueue failed: ${e?.message || e}`,
            };
        }

        const startedAt = Date.now();
        const MAX = this.MAX_DOWNLOAD_TIMEOUT; // absolute cap (5 min)
        const QUEUE_WAIT = 45000; // give up queueing after 45s → next source
        const INACT = this.INACTIVITY_TIMEOUT; // 30s no progress while transferring
        let lastBytes = -1;
        let lastProgressAt = Date.now();
        let transferId: string | undefined;

        while (Date.now() - startedAt < MAX) {
            await new Promise((r) => setTimeout(r, 1500));
            const t = await slskdClient.getDownloadTransfer(
                match.username,
                remote
            );
            if (!t) continue; // transfer not visible yet
            transferId = t.id;
            const state = String(t.state || "");
            const bytes = Number((t as any).bytesTransferred || 0);
            if (bytes !== lastBytes) {
                lastBytes = bytes;
                lastProgressAt = Date.now();
            }
            const transferring = /InProgress/i.test(state) || bytes > 0;

            if (/Completed,\s*Succeeded/i.test(state)) {
                const moved = await this.locateAndMove(
                    remote,
                    downloadBase,
                    destPath
                );
                await slskdClient
                    .cancelDownload(match.username, t.id)
                    .catch(() => undefined);
                if (moved) {
                    sessionLog("SOULSEEK", `✓ Downloaded: ${match.filename}`);
                    return { success: true };
                }
                return {
                    success: false,
                    error: "completed but file not found to move",
                };
            }
            if (/Completed/i.test(state)) {
                // Errored / Cancelled / Rejected / TimedOut
                await slskdClient
                    .cancelDownload(match.username, t.id)
                    .catch(() => undefined);
                return { success: false, error: `transfer ${state}` };
            }
            if (transferring) {
                if (Date.now() - lastProgressAt > INACT) {
                    await slskdClient
                        .cancelDownload(match.username, t.id)
                        .catch(() => undefined);
                    return { success: false, error: "download stalled" };
                }
            } else if (Date.now() - startedAt > QUEUE_WAIT) {
                // Still queued with no bytes after QUEUE_WAIT → move to next source.
                await slskdClient
                    .cancelDownload(match.username, t.id)
                    .catch(() => undefined);
                return { success: false, error: "still queued (no free slot)" };
            }
        }
        if (transferId) {
            await slskdClient
                .cancelDownload(match.username, transferId)
                .catch(() => undefined);
        }
        return { success: false, error: "download timed out" };
    }

    /**
     * Download a specific file path from a user (no search)
     */
    async downloadFile(
        username: string,
        filePath: string,
        destPath: string,
        size?: number,
        bitRate?: number
    ): Promise<{ success: boolean; error?: string }> {
        const filename = path.basename(filePath);
        const match: TrackMatch = {
            username,
            filename,
            fullPath: filePath,
            size: size ?? 0,
            bitRate,
            quality: this.getQualityFromFilename(filePath, bitRate),
            score: 0,
        };

        return this.downloadTrack(match, destPath);
    }

    /**
     * Search and download a track in one operation
     * Includes retry logic - tries multiple users if first fails/times out
     */
    async searchAndDownload(
        artistName: string,
        trackTitle: string,
        albumName: string,
        musicPath: string
    ): Promise<{ success: boolean; filePath?: string; error?: string }> {
        // Search for the track
        const searchResult = await this.searchTrack(artistName, trackTitle);

        if (!searchResult.found || searchResult.allMatches.length === 0) {
            return { success: false, error: "No suitable match found" };
        }

        const sanitize = (name: string) =>
            name.replace(/[<>:"/\\|?*]/g, "_").trim();
        const errors: string[] = [];

        // Try up to MAX_DOWNLOAD_RETRIES different users
        const matchesToTry = searchResult.allMatches.slice(
            0,
            this.MAX_DOWNLOAD_RETRIES
        );

        for (let attempt = 0; attempt < matchesToTry.length; attempt++) {
            const match = matchesToTry[attempt];

            // Add delay between retry attempts to reduce connection pressure
            if (attempt > 0) {
                await new Promise((resolve) => setTimeout(resolve, 1000));
            }

            sessionLog(
                "SOULSEEK",
                `[${artistName} - ${trackTitle}] Attempt ${attempt + 1}/${
                    matchesToTry.length
                }: Trying ${match.username}`
            );

            // Build destination path using configured downloadPath
            const settings = await getSystemSettings();
            const downloadBase =
                settings?.downloadPath || "/soulseek-downloads";
            const destPath = path.join(
                downloadBase,
                sanitize(artistName),
                sanitize(albumName),
                sanitize(match.filename)
            );

            // Download with timeout
            const downloadResult = await this.downloadTrack(match, destPath);

            if (downloadResult.success) {
                if (attempt > 0) {
                    sessionLog(
                        "SOULSEEK",
                        `✓ Success on attempt ${attempt + 1} (user: ${
                            match.username
                        })`
                    );
                }
                return { success: true, filePath: destPath };
            }

            // Log failure and try next user
            const errorMsg = downloadResult.error || "Unknown error";
            errors.push(`${match.username}: ${errorMsg}`);
            sessionLog(
                "SOULSEEK",
                `Attempt ${
                    attempt + 1
                } failed: ${errorMsg}, trying next user...`,
                "WARN"
            );
        }

        // All attempts failed
        sessionLog(
            "SOULSEEK",
            `All ${matchesToTry.length} download attempts failed for: ${artistName} - ${trackTitle}`,
            "ERROR"
        );
        return {
            success: false,
            error: `All ${matchesToTry.length} attempts failed: ${errors.join(
                "; "
            )}`,
        };
    }

    /**
     * Download best match from pre-searched results
     * Used when search was already done separately (e.g., for retry functionality)
     */
    async downloadBestMatch(
        artistName: string,
        trackTitle: string,
        albumName: string,
        allMatches: TrackMatch[],
        musicPath: string,
        options?: {
            downloadSubdir?: string;
        }
    ): Promise<{ success: boolean; filePath?: string; error?: string }> {
        if (allMatches.length === 0) {
            return { success: false, error: "No matches provided" };
        }

        const sanitize = (name: string) =>
            name.replace(/[<>:"/\\|?*]/g, "_").trim();
        const errors: string[] = [];

        const sanitizedSubdir = options?.downloadSubdir
            ? sanitize(path.basename(options.downloadSubdir))
            : null;

        // Try up to MAX_DOWNLOAD_RETRIES different users
        const matchesToTry = allMatches.slice(0, this.MAX_DOWNLOAD_RETRIES);

        for (let attempt = 0; attempt < matchesToTry.length; attempt++) {
            const match = matchesToTry[attempt];

            sessionLog(
                "SOULSEEK",
                `[${artistName} - ${trackTitle}] Attempt ${attempt + 1}/${
                    matchesToTry.length
                }: Trying ${match.username}`
            );

            // Build destination path using configured downloadPath
            const settings = await getSystemSettings();
            const downloadBase =
                settings?.downloadPath || "/soulseek-downloads";
            const destPath = sanitizedSubdir
                ? path.join(
                      downloadBase,
                      sanitizedSubdir,
                      sanitize(artistName),
                      sanitize(albumName),
                      sanitize(match.filename)
                  )
                : path.join(
                      downloadBase,
                      sanitize(artistName),
                      sanitize(albumName),
                      sanitize(match.filename)
                  );

            // Download with timeout
            const downloadResult = await this.downloadTrack(match, destPath);

            if (downloadResult.success) {
                if (attempt > 0) {
                    sessionLog(
                        "SOULSEEK",
                        `✓ Success on attempt ${attempt + 1} (user: ${
                            match.username
                        })`
                    );
                }
                return { success: true, filePath: destPath };
            }

            // Log failure and try next user
            const errorMsg = downloadResult.error || "Unknown error";
            errors.push(`${match.username}: ${errorMsg}`);
            sessionLog(
                "SOULSEEK",
                `Attempt ${attempt + 1} failed: ${errorMsg}`,
                "WARN"
            );
        }

        // All attempts failed
        return {
            success: false,
            error: `All ${matchesToTry.length} attempts failed: ${errors.join(
                "; "
            )}`,
        };
    }

    /**
     * Search and download multiple tracks in parallel
     * - Searches run in parallel (capped to reduce connection churn)
     * - Downloads run in parallel (20 concurrent by default)
     */
    async searchAndDownloadBatch(
        tracks: Array<{ artist: string; title: string; album: string }>,
        musicPath: string,
        concurrency: number = 20,
        options?: {
            /**
             * Optional subdirectory inside downloadPath.
             * Used to namespace playlist downloads (e.g. "Playlists") to avoid collisions with /music.
             */
            downloadSubdir?: string;

            /** Prefer lossless; fallback to MP3 320 if needed (default: true) */
            preferFlac?: boolean;
            /** Allow MP3 320 fallback when no FLAC available (default: true) */
            allowMp3320Fallback?: boolean;
            /** Allow MP3 256 fallback as last resort (default: true) */
            allowMp3256Fallback?: boolean;

            /** Fast-pass search timeout (default: 3500ms) */
            searchTimeoutMs?: number;
            /** Slow-pass search timeout for misses (default: 10000ms) */
            searchTimeoutLongMs?: number;

            /** Limit concurrent searches (default: 10) */
            searchConcurrency?: number;
        }
    ): Promise<{
        successful: number;
        failed: number;
        files: string[];
        errors: string[];
    }> {
        const downloadQueue = new PQueue({ concurrency });
        const results: {
            successful: number;
            failed: number;
            files: string[];
            errors: string[];
        } = {
            successful: 0,
            failed: 0,
            files: [],
            errors: [],
        };

        // Ensure connection is established before starting batch
        try {
            await this.ensureConnected();
        } catch (err: any) {
            sessionLog(
                "SOULSEEK",
                `Failed to connect before batch: ${err.message}`,
                "ERROR"
            );
            return {
                successful: 0,
                failed: tracks.length,
                files: [],
                errors: tracks.map(t => `${t.artist} - ${t.title}: Connection failed`),
            };
        }

        // Pipeline search -> download to reduce wall-clock time.
        sessionLog(
            "SOULSEEK",
            `Searching for ${tracks.length} tracks (pipelined)...`
        );

        const preferFlac = options?.preferFlac !== false;
        const allowMp3320Fallback = options?.allowMp3320Fallback !== false;
        const allowMp3256Fallback = options?.allowMp3256Fallback !== false;
        const fastTimeoutMs = options?.searchTimeoutMs ?? 3500;
        const slowTimeoutMs = options?.searchTimeoutLongMs ?? 10000;
        // Can now use higher concurrency since rate limiter handles throttling
        const searchConcurrency = Math.min(
            options?.searchConcurrency ?? 10,
            Math.max(tracks.length, 1)
        );

        const searchQueue = new PQueue({ concurrency: searchConcurrency });

        const searchTasks = tracks.map((track) =>
            searchQueue.add(async () => {
                // Rate limiting is now handled by searchRateLimiter.acquire() in searchTrack()
                const queries = this.buildSearchQueries(track.artist, track.title);

                let searchResult: SearchTrackResult = {
                    found: false,
                    bestMatch: null,
                    allMatches: [],
                };

                // Pass 1: fast searches
                for (const query of queries) {
                    searchResult = await this.searchTrack(
                        track.artist,
                        track.title,
                        false,
                        {
                            timeoutMs: fastTimeoutMs,
                            queryOverride: query,
                            preferFlac,
                            allowMp3320Fallback,
                            allowMp3256Fallback,
                        }
                    );
                    if (searchResult.found && searchResult.allMatches.length > 0) {
                        break;
                    }
                }

                // Pass 2: slower searches for misses
                if (!searchResult.found || searchResult.allMatches.length === 0) {
                    for (const query of queries) {
                        searchResult = await this.searchTrack(
                            track.artist,
                            track.title,
                            false,
                            {
                                timeoutMs: slowTimeoutMs,
                                queryOverride: query,
                                preferFlac,
                                allowMp3320Fallback,
                                allowMp3256Fallback,
                                // Avoid immediate cache-hit loops for problematic tracks
                                skipCache: true,
                            }
                        );
                        if (searchResult.found && searchResult.allMatches.length > 0) {
                            break;
                        }
                    }
                }

                if (!searchResult.found || searchResult.allMatches.length === 0) {
                    results.failed++;
                    results.errors.push(
                        `${track.artist} - ${track.title}: No match found on Soulseek`
                    );
                    return;
                }

                // Immediately queue download as soon as a match exists.
                void downloadQueue.add(async () => {
                    const downloadResult = await this.downloadWithRetry(
                        track.artist,
                        track.title,
                        track.album,
                        searchResult.allMatches,
                        musicPath,
                        options
                    );
                    if (downloadResult.success && downloadResult.filePath) {
                        results.successful++;
                        results.files.push(downloadResult.filePath);
                    } else {
                        results.failed++;
                        results.errors.push(
                            `${track.artist} - ${track.title}: ${
                                downloadResult.error || "Unknown error"
                            }`
                        );
                    }
                    // Add 1s delay between track downloads to reduce connection pressure
                    await new Promise((resolve) => setTimeout(resolve, 1000));
                });
            })
        );

        await Promise.all(searchTasks);
        await downloadQueue.onIdle();

        sessionLog(
            "SOULSEEK",
            `Batch complete: ${results.successful} succeeded, ${results.failed} failed`
        );

        return results;
    }

    /**
     * Download with retry logic (extracted for use by batch downloads)
     */
    private async downloadWithRetry(
        artistName: string,
        trackTitle: string,
        albumName: string,
        allMatches: TrackMatch[],
        musicPath: string,
        options?: {
            downloadSubdir?: string;
        }
    ): Promise<{ success: boolean; filePath?: string; error?: string }> {
        const sanitize = (name: string) =>
            name.replace(/[<>:"/\\|?*]/g, "_").trim();
        const errors: string[] = [];
        
        // Deduplicate matches by username - no point retrying same user who already failed
        const seenUsers = new Set<string>();
        const uniqueMatches = allMatches.filter((m) => {
            if (seenUsers.has(m.username)) return false;
            seenUsers.add(m.username);
            return true;
        });
        const matchesToTry = uniqueMatches.slice(0, this.MAX_DOWNLOAD_RETRIES);

        const sanitizedSubdir = options?.downloadSubdir
            ? sanitize(path.basename(options.downloadSubdir))
            : null;

        const failedUsers = new Set<string>();
        for (let attempt = 0; attempt < matchesToTry.length; attempt++) {
            const match = matchesToTry[attempt];

            // Skip users that already failed in this batch
            if (failedUsers.has(match.username)) continue;

            // Skip users with too many failures (reputation system)
            if (await shouldSkipUser(match.username)) {
                sessionLog(
                    "SOULSEEK",
                    `[${artistName} - ${trackTitle}] Skipping ${match.username} (too many failures)`,
                    "WARN"
                );
                continue;
            }

            // Add delay between retry attempts to reduce connection pressure
            if (attempt > 0) {
                await new Promise((resolve) => setTimeout(resolve, 500));
            }

            sessionLog(
                "SOULSEEK",
                `[${artistName} - ${trackTitle}] Attempt ${attempt + 1}/${
                    matchesToTry.length
                }: Trying ${match.username}`
            );

            // Build destination path using configured downloadPath
            const settings = await getSystemSettings();
            const downloadBase =
                settings?.downloadPath || "/soulseek-downloads";
            const destPath = sanitizedSubdir
                ? path.join(
                      downloadBase,
                      sanitizedSubdir,
                      sanitize(artistName),
                      sanitize(albumName),
                      sanitize(match.filename)
                  )
                : path.join(
                      downloadBase,
                      sanitize(artistName),
                      sanitize(albumName),
                      sanitize(match.filename)
                  );

            const result = await this.downloadTrack(match, destPath);
            if (result.success) {
                if (attempt > 0) {
                    sessionLog(
                        "SOULSEEK",
                        `[${artistName} - ${trackTitle}] ✓ Success on attempt ${
                            attempt + 1
                        }`
                    );
                }
                return { success: true, filePath: destPath };
            }
            errors.push(`${match.username}: ${result.error}`);
            failedUsers.add(match.username);
        }

        sessionLog(
            "SOULSEEK",
            `[${artistName} - ${trackTitle}] All ${matchesToTry.length} attempts failed`,
            "ERROR"
        );
        return { success: false, error: errors.join("; ") };
    }

    /**
     * Get quality string from filename/bitrate
     */
    private getQualityFromFilename(filename: string, bitRate?: number): string {
        const lowerFilename = filename.toLowerCase();
        if (lowerFilename.endsWith(".flac")) return "FLAC";
        if (lowerFilename.endsWith(".wav")) return "WAV";
        if (lowerFilename.endsWith(".mp3")) {
            if (bitRate && bitRate >= 320) return "MP3 320";
            if (bitRate && bitRate >= 256) return "MP3 256";
            if (bitRate && bitRate >= 192) return "MP3 192";
            return "MP3";
        }
        if (lowerFilename.endsWith(".m4a") || lowerFilename.endsWith(".aac"))
            return "AAC";
        if (lowerFilename.endsWith(".ogg")) return "OGG";
        if (lowerFilename.endsWith(".opus")) return "OPUS";
        return "Unknown";
    }

    /**
     * Disconnect from Soulseek
     */
    disconnect(): void {
        this.client?.destroy();
        this.client = null;
        sessionLog("SOULSEEK", "Disconnected");
    }
}

// Export singleton instance
export const soulseekService = new SoulseekService();
