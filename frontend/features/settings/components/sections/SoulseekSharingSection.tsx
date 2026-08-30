"use client";

import { useEffect, useState } from "react";
import { SettingsSection, SettingsRow, SettingsInput, SettingsToggle } from "../ui";
import { SystemSettings } from "../../types";
import { api } from "@/lib/api";
import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";

interface SoulseekSharingSectionProps {
    settings: SystemSettings;
    onUpdate: (updates: Partial<SystemSettings>) => void;
}

interface SharingStatus {
    supported: boolean;
    reachable: boolean;
    connected: boolean;
    enabled: boolean;
    sharePath: string | null;
    uploadSlots: number;
    uploadSpeedLimitKbps: number;
    pathExists: boolean;
    sharedFileCount: number | null;
    activeUploads: number | null;
}

export function SoulseekSharingSection({ settings, onUpdate }: SoulseekSharingSectionProps) {
    const [status, setStatus] = useState<SharingStatus | null>(null);
    const sharingEnabled = settings.soulseekSharingEnabled === true;

    // Load runtime status (capability + path check). Re-fetch when the path or
    // enabled flag change locally so the "path exists" indicator stays useful.
    useEffect(() => {
        let mounted = true;
        const load = () =>
            api.getSoulseekSharing()
                .then((s) => {
                    if (mounted) setStatus(s);
                })
                .catch(() => {
                    if (mounted) setStatus(null);
                });
        load();
        // Poll so the connection/shared-count status reflects credential saves
        // and share rescans without a page reload.
        const timer = setInterval(load, 8000);
        return () => {
            mounted = false;
            clearInterval(timer);
        };
    }, [settings.soulseekSharePath, settings.soulseekSharingEnabled]);

    // Clamp helpers for the numeric inputs (stored as numbers on SystemSettings).
    const setSlots = (v: string) => {
        const n = parseInt(v, 10);
        onUpdate({ soulseekUploadSlots: Number.isFinite(n) ? Math.min(20, Math.max(1, n)) : 1 });
    };
    const setSpeed = (v: string) => {
        const n = parseInt(v, 10);
        onUpdate({ soulseekUploadSpeedLimitKbps: Number.isFinite(n) ? Math.max(0, n) : 0 });
    };

    return (
        <SettingsSection
            id="soulseek-sharing"
            title="Soulseek Sharing"
            description="Serve files back to the Soulseek network (uploads)"
        >
            {/* Live status from the slskd sidecar (the engine that serves files). */}
            {status && !status.reachable && (
                <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 text-red-400 mt-0.5 flex-shrink-0" />
                    <p className="text-sm text-red-200">
                        The slskd sharing engine isn&apos;t reachable. Make sure the
                        <code className="mx-1 px-1 py-0.5 bg-black/30 rounded text-xs">slskd</code>
                        container is running.
                    </p>
                </div>
            )}
            {status && status.reachable && !status.connected && (
                <div className="mb-4 p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 flex-shrink-0" />
                    <p className="text-sm text-amber-200">
                        slskd is running but not connected to Soulseek. Save your Soulseek
                        username &amp; password under <strong>Track Downloads</strong> and hit
                        Test &mdash; sharing goes live as soon as it connects.
                    </p>
                </div>
            )}
            {status && status.connected && (
                <div className="mb-4 p-3 bg-green-500/10 border border-green-500/30 rounded-lg flex items-start gap-2">
                    <CheckCircle2 className="w-4 h-4 text-green-400 mt-0.5 flex-shrink-0" />
                    <p className="text-sm text-green-200">
                        Sharing is live &mdash;{" "}
                        {status.sharedFileCount != null
                            ? status.sharedFileCount.toLocaleString()
                            : "?"}{" "}
                        files shared
                        {status.activeUploads != null && status.activeUploads > 0
                            ? `, ${status.activeUploads} uploading now`
                            : ""}
                        .
                    </p>
                </div>
            )}

            <SettingsRow
                label="Enable Sharing"
                description="Advertise and upload your files to other Soulseek users"
                htmlFor="soulseek-sharing-enabled"
            >
                <SettingsToggle
                    id="soulseek-sharing-enabled"
                    checked={sharingEnabled}
                    onChange={(checked) => onUpdate({ soulseekSharingEnabled: checked })}
                />
            </SettingsRow>

            {sharingEnabled && (
                <>
                    <SettingsRow
                        label="Share Folder"
                        description={
                            <span className="flex items-center gap-1.5">
                                Directory served to peers
                                {status && (
                                    status.pathExists ? (
                                        <span className="inline-flex items-center gap-1 text-green-400">
                                            <CheckCircle2 className="w-3 h-3" /> exists
                                        </span>
                                    ) : (
                                        <span className="inline-flex items-center gap-1 text-red-400">
                                            <XCircle className="w-3 h-3" /> not found
                                        </span>
                                    )
                                )}
                            </span>
                        }
                    >
                        <SettingsInput
                            value={settings.soulseekSharePath || ""}
                            onChange={(v) => onUpdate({ soulseekSharePath: v })}
                            placeholder="/music"
                            className="w-64"
                        />
                    </SettingsRow>

                    <SettingsRow
                        label="Upload Slots"
                        description="Max simultaneous uploads to peers (1–20)"
                    >
                        <SettingsInput
                            type="number"
                            value={String(settings.soulseekUploadSlots ?? 2)}
                            onChange={setSlots}
                            placeholder="2"
                            className="w-24"
                        />
                    </SettingsRow>

                    <SettingsRow
                        label="Upload Speed Limit"
                        description="Throttle uploads in KB/s (0 = unlimited)"
                    >
                        <SettingsInput
                            type="number"
                            value={String(settings.soulseekUploadSpeedLimitKbps ?? 0)}
                            onChange={setSpeed}
                            placeholder="0"
                            className="w-24"
                        />
                    </SettingsRow>
                </>
            )}

            <p className="text-xs text-white/40 mt-4">
                Sharing back to the network is good etiquette and can improve your download
                success rate, since some users refuse transfers to non-sharing accounts.
            </p>
        </SettingsSection>
    );
}
