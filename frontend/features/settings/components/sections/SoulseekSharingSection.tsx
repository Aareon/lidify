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
        api.getSoulseekSharing()
            .then((s) => {
                if (mounted) setStatus(s);
            })
            .catch(() => {
                if (mounted) setStatus(null);
            });
        return () => {
            mounted = false;
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
            {/* Capability banner: sharing is scaffolding until the serving layer
                exists. Be explicit so enabling it doesn't imply uploads happen. */}
            {status && !status.supported && (
                <div className="mb-4 p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 flex-shrink-0" />
                    <p className="text-sm text-amber-200">
                        Sharing isn&apos;t active yet. This build&apos;s Soulseek client can&apos;t
                        serve files to peers, so these settings are saved but nothing is uploaded.
                        The controls are here so the feature can be turned on once serving is implemented.
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
