/**
 * slskd REST API client
 * ---------------------
 * Thin, typed wrapper over the slskd sidecar's HTTP API. slskd is the Soulseek
 * engine for search, downloads, AND sharing/uploads (it replaces the download-
 * only soulseek-ts library — see project memory `lidify-soulseek-sharing`).
 *
 * VERIFIED against slskd v0.26.0.0:
 *   - API base is `/api/v0` (NOT v1).
 *   - Search + download require a live Soulseek connection (409/500 otherwise).
 *   - Auth: `X-API-Key` header when a key is configured; the sidecar runs with
 *     auth disabled and is only reachable on the internal compose network.
 *
 * Lidify reaches the sidecar at http://slskd:5030 over the compose network.
 */

const BASE_URL = (process.env.SLSKD_URL || "http://slskd:5030").replace(/\/+$/, "");
const API = `${BASE_URL}/api/v0`;
const API_KEY = process.env.SLSKD_API_KEY || "";
const DEFAULT_TIMEOUT_MS = 15000;

export interface SlskdServerState {
    state: string; // e.g. "Connected, LoggedIn" | "Disconnected" | "None"
    isConnected: boolean;
    isLoggedIn: boolean;
    isConnecting: boolean;
    isLoggingIn: boolean;
    isTransitioning: boolean;
}

export interface SlskdShareInfo {
    id: string;
    alias: string;
    localPath: string;
    remotePath: string;
    directories: number;
    files: number;
    isExcluded: boolean;
}

export interface SlskdFile {
    filename: string;
    size: number;
    bitRate?: number;
    length?: number; // seconds
    extension?: string;
}

export interface SlskdSearchResponse {
    username: string;
    fileCount: number;
    files: SlskdFile[];
    hasFreeUploadSlot: boolean;
    uploadSpeed: number;
    queueLength: number;
}

/** A transfer (download or upload) as reported by slskd. */
export interface SlskdTransfer {
    id: string;
    username: string;
    direction: "Download" | "Upload";
    filename: string;
    size: number;
    bytesTransferred: number;
    percentComplete: number;
    state: string; // e.g. "Completed, Succeeded" | "InProgress" | "Queued, Remotely"
    averageSpeed?: number;
}

class SlskdError extends Error {
    status: number;
    constructor(message: string, status: number) {
        super(message);
        this.name = "SlskdError";
        this.status = status;
    }
}

async function request<T = unknown>(
    path: string,
    init: RequestInit & { timeoutMs?: number } = {}
): Promise<T> {
    const { timeoutMs = DEFAULT_TIMEOUT_MS, headers, ...rest } = init;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(`${API}${path}`, {
            ...rest,
            signal: controller.signal,
            headers: {
                Accept: "application/json",
                ...(rest.body ? { "Content-Type": "application/json" } : {}),
                ...(API_KEY ? { "X-API-Key": API_KEY } : {}),
                ...(headers || {}),
            },
        });
        const text = await res.text();
        if (!res.ok) {
            throw new SlskdError(
                text?.slice(0, 300) || `slskd ${path} failed`,
                res.status
            );
        }
        if (!text) return undefined as T;
        try {
            return JSON.parse(text) as T;
        } catch {
            return text as unknown as T;
        }
    } finally {
        clearTimeout(timer);
    }
}

export const slskdClient = {
    /** True if the slskd sidecar is reachable at all (independent of Soulseek). */
    async isReachable(): Promise<boolean> {
        try {
            const res = await fetch(`${BASE_URL}/health`, {
                signal: AbortSignal.timeout(4000),
            });
            return res.ok;
        } catch {
            return false;
        }
    },

    /** Soulseek server connection/login state. */
    getServerState(): Promise<SlskdServerState> {
        return request<SlskdServerState>("/server");
    },

    /** Connect to the Soulseek network (requires credentials to be configured). */
    connect(): Promise<void> {
        return request<void>("/server", { method: "PUT" }).then(() => undefined);
    },

    /** Disconnect from the Soulseek network (best-effort). */
    disconnect(): Promise<void> {
        return request<void>("/server", { method: "DELETE" })
            .then(() => undefined)
            .catch(() => undefined);
    },

    /**
     * Push Soulseek credentials into slskd's live config (remote configuration)
     * so saving them in Lidify's web app connects immediately — no container
     * restart. slskd's config precedence is env > yaml, so the compose file must
     * NOT set SLSKD_SLSK_USERNAME/PASSWORD (env would shadow this yaml).
     *
     * Writes a minimal yaml containing only the soulseek credentials; everything
     * else (shares, downloads, listen port) comes from env and is unaffected.
     */
    async setCredentials(username: string, password: string): Promise<void> {
        // YAML double-quoted scalar: escape backslash and double-quote.
        const q = (s: string) =>
            '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
        const yaml = `soulseek:\n  username: ${q(username)}\n  password: ${q(
            password
        )}\n`;
        // Validate, then apply. Body is the JSON-encoded yaml string.
        await request("/options/yaml/validate", {
            method: "POST",
            body: JSON.stringify(yaml),
        });
        await request("/options/yaml", {
            method: "PUT",
            body: JSON.stringify(yaml),
        });
        // slskd reloads config on change; nudge a connect in case it doesn't
        // auto-reconnect. Best-effort — invalid creds simply won't connect.
        await this.connect().catch(() => undefined);
    },

    // ── Shares (sharing status) ──────────────────────────────────────────────

    /** Configured shares with directory/file counts. */
    async getShares(): Promise<SlskdShareInfo[]> {
        const res = await request<{ local?: SlskdShareInfo[] }>("/shares");
        return res?.local ?? [];
    },

    /** Trigger a re-scan of the shared directories. */
    rescanShares(): Promise<void> {
        return request<void>("/shares", { method: "PUT" }).then(() => undefined);
    },

    // ── Search ───────────────────────────────────────────────────────────────

    /**
     * Run a search and return the aggregated responses once it settles.
     * Creates the search, polls its responses until slskd marks it complete or
     * the timeout elapses. Requires a live Soulseek connection.
     */
    async search(
        query: string,
        opts: { timeoutMs?: number; responseLimit?: number } = {}
    ): Promise<SlskdSearchResponse[]> {
        const created = await request<{ id: string }>("/searches", {
            method: "POST",
            body: JSON.stringify({
                searchText: query,
                responseLimit: opts.responseLimit ?? 100,
            }),
        });
        const id = created.id;
        const deadline = Date.now() + (opts.timeoutMs ?? 12000);

        // Poll until the search is marked complete or we run out of time.
        // slskd keeps the search record; `isComplete`/`state` flips when done.
        while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 1000));
            const state = await request<{ isComplete?: boolean; state?: string }>(
                `/searches/${id}`
            ).catch(() => null);
            if (
                state &&
                (state.isComplete === true ||
                    (state.state && /complete/i.test(state.state)))
            ) {
                break;
            }
        }

        const responses = await request<SlskdSearchResponse[]>(
            `/searches/${id}/responses`
        ).catch(() => []);
        return Array.isArray(responses) ? responses : [];
    },

    // ── Downloads ────────────────────────────────────────────────────────────

    /**
     * Enqueue one or more files for download from a specific user.
     * Body shape verified: array of { filename, size }.
     */
    enqueueDownload(
        username: string,
        files: { filename: string; size: number }[]
    ): Promise<void> {
        return request<void>(
            `/transfers/downloads/${encodeURIComponent(username)}`,
            { method: "POST", body: JSON.stringify(files) }
        ).then(() => undefined);
    },

    /** All current/recent download transfers, flattened across users. */
    getDownloads(): Promise<unknown> {
        return request("/transfers/downloads");
    },

    /** All current/recent upload transfers (what we're serving to peers). */
    getUploads(): Promise<unknown> {
        return request("/transfers/uploads");
    },
};

export { SlskdError };
