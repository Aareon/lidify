"use client";

import { useState, useEffect, useCallback } from "react";
import { SettingsSection } from "../ui";
import { InlineStatus, StatusType } from "@/components/ui/InlineStatus";
import { api, Anomaly } from "@/lib/api";
import { RefreshCw, ArrowRight, Merge, X, CheckCircle2 } from "lucide-react";

/**
 * Library Health — surfaces detected data anomalies (currently likely-duplicate
 * artists) for an admin to resolve. High-confidence duplicates are auto-merged
 * by the background worker; the fuzzy/uncertain ones show up here for review.
 */
export function LibraryHealthSection() {
    const [anomalies, setAnomalies] = useState<Anomaly[] | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [busyKey, setBusyKey] = useState<string | null>(null);
    const [status, setStatus] = useState<StatusType>("idle");
    const [statusMsg, setStatusMsg] = useState("");

    const load = useCallback(() => {
        setAnomalies(null);
        setLoadError(null);
        api.getLibraryHealth()
            .then(({ anomalies }) => setAnomalies(anomalies))
            .catch((e) => setLoadError(e?.message || "Failed to load"));
    }, []);

    useEffect(() => {
        load();
    }, [load]);

    const remove = (key: string) =>
        setAnomalies((prev) => (prev ? prev.filter((a) => a.key !== key) : prev));

    const handleMerge = async (a: Anomaly) => {
        setBusyKey(a.key);
        setStatus("loading");
        setStatusMsg("Merging…");
        try {
            const { result } = await api.mergeArtists(a.data.keepId, a.data.mergeId);
            remove(a.key);
            setStatus("success");
            setStatusMsg(
                `Merged into "${result.keptName}" (${result.movedAlbums} album${result.movedAlbums === 1 ? "" : "s"} moved)`
            );
        } catch (e: any) {
            setStatus("error");
            setStatusMsg(e?.message || "Merge failed");
        } finally {
            setBusyKey(null);
        }
    };

    const handleIgnore = async (a: Anomaly) => {
        setBusyKey(a.key);
        try {
            await api.ignoreAnomaly(a.key, a.type);
            remove(a.key);
            setStatus("success");
            setStatusMsg("Dismissed");
        } catch (e: any) {
            setStatus("error");
            setStatusMsg(e?.message || "Failed to dismiss");
        } finally {
            setBusyKey(null);
        }
    };

    return (
        <SettingsSection
            id="library-health"
            title="Library Health"
            description="Review and resolve detected data anomalies, like duplicate artists"
        >
            <div className="flex items-center justify-between pb-2">
                <div className="text-sm text-[#888]">
                    {anomalies === null && !loadError
                        ? "Scanning…"
                        : loadError
                            ? `Error: ${loadError}`
                            : anomalies!.length === 0
                                ? "No issues detected — your library looks healthy."
                                : `${anomalies!.length} issue${anomalies!.length === 1 ? "" : "s"} to review`}
                </div>
                <div className="flex items-center gap-3">
                    <InlineStatus status={status} message={statusMsg} onClear={() => setStatus("idle")} />
                    <button
                        onClick={load}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-[#333] text-white
                            rounded-full hover:bg-[#404040] transition-colors"
                    >
                        <RefreshCw className="w-3.5 h-3.5" /> Rescan
                    </button>
                </div>
            </div>

            {anomalies && anomalies.length === 0 && !loadError && (
                <div className="flex items-center gap-2 px-1 py-3 text-sm text-[#888]">
                    <CheckCircle2 className="w-4 h-4 text-green-500" />
                    Nothing needs attention.
                </div>
            )}

            <div className="space-y-3">
                {anomalies?.map((a) => (
                    <div
                        key={a.key}
                        className="rounded-lg border border-[#333] bg-[#1a1a1a] p-3"
                    >
                        <div className="flex items-center gap-2 mb-2">
                            <span
                                className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${
                                    a.data.matchType === "fuzzy"
                                        ? "bg-amber-500/15 text-amber-400"
                                        : "bg-blue-500/15 text-blue-400"
                                }`}
                            >
                                {a.data.matchType === "fuzzy" ? "Likely typo" : "Variant"} · {a.data.similarity}% match
                            </span>
                        </div>

                        {/* keep <- merge */}
                        <div className="flex items-center gap-3 text-sm">
                            <div className="flex-1 min-w-0">
                                <div className="text-white truncate">{a.data.keepName}</div>
                                <div className="text-xs text-[#666] truncate">
                                    keep · {a.data.keepAlbums} album{a.data.keepAlbums === 1 ? "" : "s"} · real MBID
                                </div>
                            </div>
                            <ArrowRight className="w-4 h-4 text-[#555] flex-shrink-0 rotate-180" />
                            <div className="flex-1 min-w-0">
                                <div className="text-[#aaa] truncate line-through decoration-[#555]">
                                    {a.data.mergeName}
                                </div>
                                <div className="text-xs text-[#666] truncate">
                                    fold in · {a.data.mergeAlbums} album{a.data.mergeAlbums === 1 ? "" : "s"} · unmatched
                                </div>
                            </div>
                        </div>

                        <div className="flex items-center gap-2 pt-3">
                            <button
                                onClick={() => handleMerge(a)}
                                disabled={busyKey === a.key}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-white text-black
                                    rounded-full hover:bg-white/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                            >
                                <Merge className="w-3.5 h-3.5" />
                                {busyKey === a.key ? "Merging…" : `Merge into "${a.data.keepName}"`}
                            </button>
                            <button
                                onClick={() => handleIgnore(a)}
                                disabled={busyKey === a.key}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-[#262626] text-[#aaa]
                                    rounded-full hover:bg-[#333] hover:text-white disabled:opacity-50 transition-colors"
                            >
                                <X className="w-3.5 h-3.5" /> Not a duplicate
                            </button>
                        </div>
                    </div>
                ))}
            </div>
        </SettingsSection>
    );
}
