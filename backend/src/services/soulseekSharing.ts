/**
 * Soulseek Sharing (backed by slskd)
 * ----------------------------------
 * Sharing/serving files back to the Soulseek network is handled by the slskd
 * sidecar (search-visible uploads that soulseek-ts cannot do). This module
 * exposes config (persisted on SystemSettings for the admin UI) plus live status
 * pulled from slskd's REST API. See project memory `lidify-soulseek-sharing`.
 */

import fs from "fs/promises";
import { getSystemSettings } from "../utils/systemSettings";
import { slskdClient } from "./slskdClient";

/** slskd can actually serve files, so sharing is supported. */
export const SHARING_SUPPORTED = true;

export interface SharingConfig {
    enabled: boolean;
    sharePath: string | null;
    uploadSlots: number;
    uploadSpeedLimitKbps: number; // 0 = unlimited
}

export interface SharingStatus extends SharingConfig {
    /** Build-level capability flag. */
    supported: boolean;
    /** slskd sidecar reachable at all. */
    reachable: boolean;
    /** Connected + logged in to the Soulseek network (i.e. actually sharing). */
    connected: boolean;
    /** Whether sharePath exists and is a readable directory. */
    pathExists: boolean;
    /** Number of files slskd is sharing (from its share index). */
    sharedFileCount: number | null;
    /** Number of uploads currently in flight (files we're serving to peers). */
    activeUploads: number | null;
}

/** Read the persisted sharing config off SystemSettings. */
export async function getSharingConfig(): Promise<SharingConfig> {
    const settings = await getSystemSettings();
    return {
        enabled: Boolean(settings?.soulseekSharingEnabled),
        sharePath: settings?.soulseekSharePath ?? null,
        uploadSlots:
            typeof settings?.soulseekUploadSlots === "number"
                ? settings.soulseekUploadSlots
                : 2,
        uploadSpeedLimitKbps:
            typeof settings?.soulseekUploadSpeedLimitKbps === "number"
                ? settings.soulseekUploadSpeedLimitKbps
                : 0,
    };
}

async function isReadableDir(p: string | null): Promise<boolean> {
    if (!p) return false;
    try {
        const stat = await fs.stat(p);
        return stat.isDirectory();
    } catch {
        return false;
    }
}

/**
 * Full status for the admin UI: config + live slskd facts. Degrades gracefully
 * (reachable:false, null counts) when the sidecar is down.
 */
export async function getSharingStatus(): Promise<SharingStatus> {
    const config = await getSharingConfig();
    const pathExists = await isReadableDir(config.sharePath);

    let reachable = false;
    let connected = false;
    let sharedFileCount: number | null = null;
    let activeUploads: number | null = null;

    try {
        reachable = await slskdClient.isReachable();
        if (reachable) {
            const [server, shares, uploads] = await Promise.all([
                slskdClient.getServerState().catch(() => null),
                slskdClient.getShares().catch(() => []),
                slskdClient.getUploads().catch(() => null),
            ]);
            connected = Boolean(server?.isConnected && server?.isLoggedIn);
            sharedFileCount = shares.reduce((sum, s) => sum + (s.files || 0), 0);
            activeUploads = Array.isArray(uploads) ? uploads.length : null;
        }
    } catch {
        // Leave defaults; the sidecar is unreachable.
    }

    return {
        ...config,
        supported: SHARING_SUPPORTED,
        reachable,
        connected,
        pathExists,
        sharedFileCount,
        activeUploads,
    };
}

/** Trigger a re-scan of slskd's shared directories. */
export async function rescanShare(): Promise<void> {
    await slskdClient.rescanShares();
}

/**
 * Kept for backwards compatibility with the route's error mapping. No longer
 * thrown now that slskd implements sharing.
 */
export class SharingNotImplementedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SharingNotImplementedError";
    }
}
