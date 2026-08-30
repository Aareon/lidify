/**
 * Soulseek Sharing (scaffolding)
 * ------------------------------
 * Config + status surface for serving files back to the Soulseek network.
 *
 * IMPORTANT: this is intentionally not wired to any real upload/serve behavior
 * yet. The current client library (soulseek-ts) advertises a hardcoded share
 * count on login but has NO code to answer browse requests or upload files to
 * peers — see the audit in the project history. Turning "sharing" on today does
 * nothing on the wire. These helpers exist so the admin routes + settings UI can
 * be built now; when a serving-capable client (or a patch to soulseek-ts) is
 * added, replace the stubbed sections below and flip `SHARING_SUPPORTED`.
 */

import fs from "fs/promises";
import { getSystemSettings } from "../utils/systemSettings";

/**
 * Whether the running build can actually serve files to peers. Flip to `true`
 * only once the upload/serve layer is implemented; the UI reads this to show an
 * honest "not active yet" state instead of implying uploads are happening.
 */
export const SHARING_SUPPORTED = false;

export interface SharingConfig {
    enabled: boolean;
    sharePath: string | null;
    uploadSlots: number;
    uploadSpeedLimitKbps: number; // 0 = unlimited
}

export interface SharingStatus extends SharingConfig {
    /** Build-level capability flag (see SHARING_SUPPORTED). */
    supported: boolean;
    /** Whether sharePath exists and is a readable directory right now. */
    pathExists: boolean;
    /**
     * Number of files currently advertised/shared. Null until the serving layer
     * is implemented and can enumerate the share.
     */
    sharedFileCount: number | null;
    /** Number of uploads in flight. Null until serving is implemented. */
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
 * Full status for the admin UI: config + live runtime facts. The runtime facts
 * are placeholders (null / not-supported) until the serving layer exists.
 */
export async function getSharingStatus(): Promise<SharingStatus> {
    const config = await getSharingConfig();
    const pathExists = await isReadableDir(config.sharePath);

    return {
        ...config,
        supported: SHARING_SUPPORTED,
        pathExists,
        // TODO(sharing): enumerate the share and report real counts once the
        // serving layer can build a shared file list.
        sharedFileCount: null,
        activeUploads: null,
    };
}

/**
 * Rebuild the shared file index from sharePath.
 * TODO(sharing): implement once a serving-capable client exists. For now this is
 * a stub so the admin "Rescan share" control can be wired without lying about
 * what it does.
 */
export async function rescanShare(): Promise<never> {
    throw new SharingNotImplementedError(
        "Soulseek sharing is not implemented yet — the current client cannot serve files to peers."
    );
}

/** Distinct error type so routes can map it to a 501 instead of a 500. */
export class SharingNotImplementedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SharingNotImplementedError";
    }
}
