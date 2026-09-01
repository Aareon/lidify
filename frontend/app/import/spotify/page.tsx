"use client";

import { useState, useEffect, useRef, useCallback, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import Image from "next/image";
import Link from "next/link";
import {
    ArrowLeft,
    Check,
    X,
    Download,
    Loader2,
    ExternalLink,
    ChevronDown,
    ChevronUp,
} from "lucide-react";
import { api } from "@/lib/api";
import { refreshLibraryCaches } from "@/lib/library-refresh";
import { useToast } from "@/lib/toast-context";

// Types for Spotify Import
interface SpotifyTrack {
    spotifyId: string;
    title: string;
    artist: string;
    artistId: string;
    album: string;
    albumId: string;
    isrc: string | null;
    durationMs: number;
    trackNumber: number;
    previewUrl: string | null;
    coverUrl: string | null;
}

interface MatchedTrack {
    spotifyTrack: SpotifyTrack;
    localTrack: {
        id: string;
        title: string;
        albumId: string;
        albumTitle: string;
        artistName: string;
    } | null;
    matchType: "exact" | "fuzzy" | "none";
    matchConfidence: number;
}

interface ImportPreview {
    playlist: {
        id: string;
        name: string;
        description: string | null;
        owner: string;
        imageUrl: string | null;
        trackCount: number;
    };
    matchedTracks: MatchedTrack[];
    summary: {
        total: number;
        inLibrary: number;
        downloadable: number;
        notFound: number;
    };
}

interface ImportJob {
    id: string;
    status:
        | "pending"
        | "downloading"
        | "scanning"
        | "creating_playlist"
        | "matching_tracks"
        | "completed"
        | "failed"
        | "cancelled";
    progress: number;
    albumsTotal: number;
    albumsCompleted: number;
    tracksMatched: number;
    tracksTotal: number;
    tracksDownloadable: number;
    createdPlaylistId: string | null;
    error: string | null;
}

// A row in the "Your imports" list (GET /api/spotify/imports). Mirrors the
// backend ImportJob plus playlistName/createdAt that the list endpoint returns.
interface ImportListItem {
    id: string;
    playlistName: string;
    status: ImportJob["status"];
    progress: number;
    albumsTotal: number;
    albumsCompleted: number;
    tracksMatched: number;
    tracksTotal: number;
    tracksDownloadable: number;
    createdPlaylistId: string | null;
    error: string | null;
    createdAt: string;
}

const ACTIVE_IMPORT_STATUSES: ReadonlySet<ImportJob["status"]> = new Set<
    ImportJob["status"]
>(["pending", "downloading", "scanning", "creating_playlist", "matching_tracks"]);

const IMPORT_STATUS_META: Record<
    ImportJob["status"],
    { label: string; color: string }
> = {
    pending: { label: "Waiting for downloads", color: "text-amber-400" },
    downloading: { label: "Downloading", color: "text-spotify" },
    scanning: { label: "Scanning library", color: "text-spotify" },
    creating_playlist: { label: "Creating playlist", color: "text-spotify" },
    matching_tracks: { label: "Matching tracks", color: "text-spotify" },
    completed: { label: "Complete", color: "text-green-400" },
    failed: { label: "Failed", color: "text-red-400" },
    cancelled: { label: "Cancelled", color: "text-gray-400" },
};

type Step = "input" | "preview" | "importing" | "complete";

// Async preview job (matches backend GET /spotify/preview/:jobId).
type PreviewJobResp = {
    id: string;
    status: "fetching" | "matching" | "ready" | "failed";
    total: number;
    inLibrary: number;
    downloadable: number;
    preview: ImportPreview | null;
    error: string | null;
};

// Persist the in-flight preview job id so a browser refresh mid-preview resumes
// polling the same job instead of losing it.
const PREVIEW_JOB_LS_KEY = "lidify_active_preview_job";

function SpotifyImportPageContent() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const queryClient = useQueryClient();
    const { toast } = useToast();
    const hasAutoFetched = useRef(false);

    // State
    const [step, setStep] = useState<Step>("input");
    const [url, setUrl] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const [preview, setPreview] = useState<ImportPreview | null>(null);
    const [previewStatus, setPreviewStatus] = useState<string | null>(null);
    const [playlistName, setPlaylistName] = useState("");
    const [importJob, setImportJob] = useState<ImportJob | null>(null);
    const [refreshStatusMessage, setRefreshStatusMessage] = useState<
        string | null
    >(null);
    const [expandedSection, setExpandedSection] = useState<
        "matched" | "download" | null
    >("matched");

    // "Your imports" list — all of this user's import jobs (URL + offline bulk).
    // null = not loaded yet. Offline imports redirect here to watch progress, so
    // this list is how those background jobs surface. Polls while any is active.
    const [imports, setImports] = useState<ImportListItem[] | null>(null);

    // Poll an async preview job until it's ready/failed. Resolves with the
    // preview, or throws on failure/expiry. Updates the progress label.
    const pollPreviewJob = useCallback(
        async (jobId: string): Promise<ImportPreview> => {
            for (let i = 0; i < 320; i++) {
                // ~8 min at 1.5s
                let job: PreviewJobResp;
                try {
                    job = await api.get<PreviewJobResp>(
                        `/spotify/preview/${jobId}`
                    );
                } catch (e: any) {
                    if (e?.status === 404) {
                        try {
                            localStorage.removeItem(PREVIEW_JOB_LS_KEY);
                        } catch {}
                        throw new Error(
                            "Preview expired — please try again"
                        );
                    }
                    throw e;
                }
                if (job.status === "ready" && job.preview) {
                    try {
                        localStorage.removeItem(PREVIEW_JOB_LS_KEY);
                    } catch {}
                    return job.preview;
                }
                if (job.status === "failed") {
                    try {
                        localStorage.removeItem(PREVIEW_JOB_LS_KEY);
                    } catch {}
                    throw new Error(
                        job.error || "Failed to generate preview"
                    );
                }
                setPreviewStatus(
                    job.status === "fetching"
                        ? "Fetching playlist…"
                        : "Matching tracks to your library…"
                );
                await new Promise((r) => setTimeout(r, 1500));
            }
            throw new Error("Preview timed out");
        },
        []
    );

    // Start an async preview job and poll it to completion.
    const runPreview = useCallback(
        async (previewUrl: string) => {
            setIsLoading(true);
            setPreviewStatus("Starting…");
            try {
                const { jobId } = await api.post<{
                    jobId: string;
                    status: string;
                }>("/spotify/preview", { url: previewUrl });
                try {
                    localStorage.setItem(PREVIEW_JOB_LS_KEY, jobId);
                } catch {}
                const result = await pollPreviewJob(jobId);
                setPreview(result);
                setPlaylistName(result.playlist.name);
                setStep("preview");
            } catch (err) {
                const message =
                    err instanceof Error
                        ? err.message
                        : "Failed to fetch playlist";
                toast.error(message);
            } finally {
                setIsLoading(false);
                setPreviewStatus(null);
            }
        },
        [pollPreviewJob, toast]
    );

    // Resume a preview that was in flight when the page was refreshed.
    useEffect(() => {
        let jobId: string | null = null;
        try {
            jobId = localStorage.getItem(PREVIEW_JOB_LS_KEY);
        } catch {}
        if (!jobId) return;
        (async () => {
            setIsLoading(true);
            setPreviewStatus("Resuming preview…");
            try {
                const result = await pollPreviewJob(jobId!);
                setPreview(result);
                setPlaylistName(result.playlist.name);
                setStep("preview");
            } catch {
                // Job expired or failed while we were away — silently reset.
                try {
                    localStorage.removeItem(PREVIEW_JOB_LS_KEY);
                } catch {}
            } finally {
                setIsLoading(false);
                setPreviewStatus(null);
            }
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        let mounted = true;
        let timer: ReturnType<typeof setTimeout> | null = null;

        const tick = async () => {
            try {
                const jobs = await api.get<ImportListItem[]>(
                    "/spotify/imports"
                );
                if (!mounted) return;
                setImports(jobs);
                const anyActive = jobs.some((j) =>
                    ACTIVE_IMPORT_STATUSES.has(j.status)
                );
                // Poll fast while downloads are in flight; idle otherwise.
                timer = setTimeout(tick, anyActive ? 4000 : 30000);
            } catch (err) {
                console.error("Failed to fetch imports:", err);
                if (mounted) timer = setTimeout(tick, 30000);
            }
        };

        tick();
        const onChanged = () => tick();
        window.addEventListener("spotify-imports-changed", onChanged);

        return () => {
            mounted = false;
            if (timer) clearTimeout(timer);
            window.removeEventListener("spotify-imports-changed", onChanged);
        };
    }, []);

    // Auto-fetch preview if URL is provided in query params
    useEffect(() => {
        const urlParam = searchParams.get("url");
        if (urlParam && !hasAutoFetched.current) {
            hasAutoFetched.current = true;
            setUrl(urlParam);
            // Auto-trigger the async preview job.
            void runPreview(urlParam);
        }
    }, [searchParams, runPreview]);

    // Poll for import job status
    useEffect(() => {
        if (
            !importJob ||
            importJob.status === "completed" ||
            importJob.status === "failed" ||
            importJob.status === "cancelled"
        ) {
            return;
        }

        const interval = setInterval(async () => {
            try {
                const job = await api.get<ImportJob>(
                    `/spotify/import/${importJob.id}/status`
                );
                setImportJob(job);

                if (job.status === "completed") {
                    setStep("complete");
                    refreshLibraryCaches(queryClient);
                    window.dispatchEvent(
                        new CustomEvent("notifications-changed")
                    );
                    window.dispatchEvent(new CustomEvent("playlist-created"));
                    window.dispatchEvent(
                        new CustomEvent("spotify-imports-changed")
                    );
                } else if (job.status === "cancelled") {
                    setStep("complete");
                    refreshLibraryCaches(queryClient);
                    window.dispatchEvent(
                        new CustomEvent("notifications-changed")
                    );
                    window.dispatchEvent(new CustomEvent("playlist-created"));
                } else if (job.status === "failed") {
                    setStep("complete");
                    refreshLibraryCaches(queryClient);
                    window.dispatchEvent(
                        new CustomEvent("notifications-changed")
                    );
                }
            } catch (err) {
                console.error("Failed to poll job status:", err);
            }
        }, 2000);

        return () => clearInterval(interval);
    }, [importJob, queryClient, toast]);

    // Handle URL paste/change
    const handleUrlChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setUrl(e.target.value);
    };

    // Fetch preview (async job under the hood).
    const handleFetchPreview = async () => {
        if (!url.trim()) {
            toast.error("Please enter a playlist URL");
            return;
        }
        await runPreview(url);
    };

    // Start import
    const handleStartImport = async () => {
        if (!preview) return;

        setIsLoading(true);
        setRefreshStatusMessage(null);
        try {
            const response = await api.post<{ jobId: string; status: string }>(
                "/spotify/import",
                {
                    spotifyPlaylistId: preview.playlist.id,
                    url,
                    playlistName: playlistName || preview.playlist.name,
                    preview,
                }
            );

            setImportJob({
                id: response.jobId,
                status: "pending",
                progress: 0,
                albumsTotal: preview.summary.downloadable,
                albumsCompleted: 0,
                tracksMatched: preview.summary.inLibrary,
                tracksTotal: preview.summary.total,
                tracksDownloadable: preview.summary.downloadable,
                createdPlaylistId: null,
                error: null,
            });
            setStep("importing");
        } catch (err) {
            const message =
                err instanceof Error ? err.message : "Failed to start import";
            toast.error(message);
        } finally {
            setIsLoading(false);
        }
    };

    // Cancel import
    const [isCancelling, setIsCancelling] = useState(false);
    const handleCancelImport = async () => {
        if (!importJob) return;

        setIsCancelling(true);
        try {
            await api.post<{
                message: string;
                playlistId: string | null;
                tracksMatched: number;
            }>(`/spotify/import/${importJob.id}/cancel`, {});

            setImportJob((prev) =>
                prev
                    ? {
                          ...prev,
                          status: "cancelled",
                          createdPlaylistId: null,
                          tracksMatched: 0,
                      }
                    : prev
            );
            setStep("complete");

            // Only dispatch notifications-changed, not playlist-created since no playlist was made
            window.dispatchEvent(new CustomEvent("notifications-changed"));
        } catch (err) {
            const message =
                err instanceof Error ? err.message : "Failed to cancel import";
            toast.error(message);
        } finally {
            setIsCancelling(false);
        }
    };

    // Format duration
    const formatDuration = (ms: number) => {
        const minutes = Math.floor(ms / 60000);
        const seconds = Math.floor((ms % 60000) / 1000);
        return `${minutes}:${seconds.toString().padStart(2, "0")}`;
    };

    return (
        <div className="min-h-screen relative">
            {/* Quick gradient fade - yellow to purple like home page */}
            <div className="absolute inset-0 pointer-events-none">
                <div
                    className="absolute inset-0 bg-linear-to-b from-brand/15 via-purple-900/10 to-transparent"
                    style={{ height: "35vh" }}
                />
                <div
                    className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,var(--tw-gradient-stops))] from-brand/8 via-transparent to-transparent"
                    style={{ height: "25vh" }}
                />
            </div>

            <div className="relative max-w-3xl mx-auto px-6 py-6">
                {/* Header */}
                <div className="flex items-center gap-4 mb-6">
                    <button
                        onClick={() => router.back()}
                        className="p-2 hover:bg-white/5 rounded-full transition-colors"
                    >
                        <ArrowLeft className="w-5 h-5 text-gray-400" />
                    </button>
                    <div>
                        <h1 className="text-2xl font-bold text-white">
                            Import Playlist
                        </h1>
                        <p className="text-sm text-gray-400">
                            Import from Spotify or Deezer and download missing
                            albums
                        </p>
                    </div>
                </div>

                {/* Browse Link */}
                <div className="mb-6 p-4 bg-white/5 rounded-lg border border-white/10">
                    <p className="text-sm text-gray-300">
                        Looking for playlists to import?{" "}
                        <Link
                            href="/browse/playlists"
                            className="text-brand hover:underline font-medium"
                        >
                            Browse Deezer playlists & radio stations →
                        </Link>
                    </p>
                </div>

                {/* Bulk offline import from Spotify data export */}
                <div className="mb-6 p-4 bg-white/5 rounded-lg border border-white/10">
                    <p className="text-sm text-gray-300">
                        Rebuilding your whole Spotify library?{" "}
                        <Link
                            href="/import/spotify/export"
                            className="text-brand hover:underline font-medium"
                        >
                            Bulk-import all playlists from your data export →
                        </Link>
                    </p>
                </div>

                {/* Your imports — background job progress (URL + offline bulk) */}
                {step === "input" && imports && imports.length > 0 && (
                    <div className="mb-6">
                        <h2 className="text-sm font-semibold text-gray-300 mb-3">
                            Your imports
                        </h2>
                        <div className="space-y-2">
                            {imports.slice(0, 15).map((job) => {
                                const meta = IMPORT_STATUS_META[job.status];
                                const isActive = ACTIVE_IMPORT_STATUSES.has(
                                    job.status
                                );
                                return (
                                    <div
                                        key={job.id}
                                        className="p-3 rounded-lg bg-white/5 border border-white/10"
                                    >
                                        <div className="flex items-center gap-3">
                                            <div className="flex-1 min-w-0">
                                                <div className="text-sm text-white truncate">
                                                    {job.playlistName}
                                                </div>
                                                <div
                                                    className={`text-xs ${meta.color} flex items-center flex-wrap gap-x-1.5 gap-y-0.5 mt-0.5`}
                                                >
                                                    {isActive && (
                                                        <Loader2 className="w-3 h-3 animate-spin" />
                                                    )}
                                                    <span>{meta.label}</span>
                                                    <span className="text-gray-600">
                                                        ·
                                                    </span>
                                                    <span className="text-gray-500">
                                                        {job.tracksMatched}/
                                                        {job.tracksTotal} songs
                                                    </span>
                                                    {job.tracksDownloadable >
                                                        0 &&
                                                        job.status !==
                                                            "completed" && (
                                                            <>
                                                                <span className="text-gray-600">
                                                                    ·
                                                                </span>
                                                                <span className="text-gray-500">
                                                                    {
                                                                        job.tracksDownloadable
                                                                    }{" "}
                                                                    downloading
                                                                </span>
                                                            </>
                                                        )}
                                                </div>
                                                {job.error && (
                                                    <div className="text-xs text-red-400 mt-1 truncate">
                                                        {job.error}
                                                    </div>
                                                )}
                                            </div>
                                            {job.createdPlaylistId && (
                                                <Link
                                                    href={`/playlist/${job.createdPlaylistId}`}
                                                    className="shrink-0 px-3 py-1.5 rounded-full text-xs font-medium bg-white/10 text-white hover:bg-white/20 transition-colors"
                                                >
                                                    View
                                                </Link>
                                            )}
                                        </div>
                                        {isActive && (
                                            <div className="mt-2 w-full bg-white/10 rounded-full h-1">
                                                <div
                                                    className="bg-spotify h-1 rounded-full transition-all duration-500"
                                                    style={{
                                                        width: `${job.progress}%`,
                                                    }}
                                                />
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}

                {/* Step: Input */}
                {step === "input" && (
                    <div className="space-y-4">
                        <div>
                            <label className="block text-sm font-medium text-gray-300 mb-2">
                                Playlist URL
                            </label>
                            <input
                                type="text"
                                value={url}
                                onChange={handleUrlChange}
                                placeholder="Paste a Spotify, Deezer, or YouTube Music playlist URL..."
                                className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-brand/50 focus:border-brand transition-colors"
                                onKeyDown={(e) =>
                                    e.key === "Enter" && handleFetchPreview()
                                }
                            />
                            <p className="text-xs text-gray-500 mt-2">
                                Paste a public{" "}
                                <span className="text-[#AD47FF]">Deezer</span>,{" "}
                                <span className="text-spotify">Spotify</span>,{" "}
                                or{" "}
                                <span className="text-[#FF0000]">YouTube Music</span>{" "}
                                playlist URL
                            </p>
                        </div>
                        <button
                            onClick={handleFetchPreview}
                            disabled={isLoading || !url.trim()}
                            className="w-full py-3 rounded-full font-medium bg-brand text-black hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
                        >
                            {isLoading ? (
                                <>
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                    {previewStatus || "Loading…"}
                                </>
                            ) : (
                                "Continue"
                            )}
                        </button>
                        {isLoading && previewStatus && (
                            <p className="text-xs text-white/40 text-center">
                                Large playlists can take a moment — you can safely
                                refresh; this will pick back up.
                            </p>
                        )}
                    </div>
                )}

                {/* Step: Preview */}
                {step === "preview" && preview && (
                    <div className="space-y-4">
                        {/* Playlist Info */}
                        <div className="flex items-start gap-4 p-4 bg-white/5 rounded-lg">
                            {preview.playlist.imageUrl ? (
                                <Image
                                    src={preview.playlist.imageUrl}
                                    alt={preview.playlist.name}
                                    width={80}
                                    height={80}
                                    unoptimized
                                    className="rounded-md object-cover"
                                />
                            ) : (
                                <div className="w-20 h-20 rounded-md bg-white/10 flex items-center justify-center">
                                    <Image
                                        src="/assets/images/SpotIcon.png"
                                        alt="Spotify"
                                        width={32}
                                        height={32}
                                    />
                                </div>
                            )}
                            <div className="flex-1 min-w-0">
                                <h2 className="text-lg font-bold text-white truncate">
                                    {preview.playlist.name}
                                </h2>
                                <p className="text-sm text-gray-400">
                                    {preview.playlist.owner} ·{" "}
                                    {preview.playlist.trackCount} songs
                                </p>
                                {preview.playlist.description && (
                                    <p className="text-sm text-gray-500 mt-1 line-clamp-1">
                                        {preview.playlist.description}
                                    </p>
                                )}
                            </div>
                            <a
                                href={
                                    url ||
                                    `https://open.spotify.com/playlist/${preview.playlist.id}`
                                }
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-gray-400 hover:text-spotify transition-colors"
                            >
                                <ExternalLink className="w-4 h-4" />
                            </a>
                        </div>

                        {/* Summary Stats */}
                        <div className="grid grid-cols-4 gap-3">
                            <div className="text-center py-3 bg-white/5 rounded-lg">
                                <div className="text-xl font-bold text-white">
                                    {preview.summary.total}
                                </div>
                                <div className="text-xs text-gray-500">
                                    Total
                                </div>
                            </div>
                            <div className="text-center py-3 bg-green-500/10 rounded-lg">
                                <div className="text-xl font-bold text-green-400">
                                    {preview.summary.inLibrary}
                                </div>
                                <div className="text-xs text-gray-500">
                                    In Library
                                </div>
                            </div>
                            <div className="text-center py-3 bg-spotify/10 rounded-lg">
                                <div className="text-xl font-bold text-spotify">
                                    {preview.summary.downloadable}
                                </div>
                                <div className="text-xs text-gray-500">
                                    To Download
                                </div>
                            </div>
                            {preview.summary.notFound > 0 ? (
                                <div className="text-center py-3 bg-red-500/10 rounded-lg">
                                    <div className="text-xl font-bold text-red-400">
                                        {preview.summary.notFound}
                                    </div>
                                    <div className="text-xs text-gray-500">
                                        Not Found
                                    </div>
                                </div>
                            ) : (
                                <div className="text-center py-3 bg-green-500/10 rounded-lg">
                                    <div className="text-xl font-bold text-green-400">
                                        ✓
                                    </div>
                                    <div className="text-xs text-gray-500">
                                        All Matched
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* Tracks already in library */}
                        {preview.summary.inLibrary > 0 && (
                            <div className="bg-white/5 rounded-lg overflow-hidden">
                                <button
                                    onClick={() =>
                                        setExpandedSection(
                                            expandedSection === "matched"
                                                ? null
                                                : "matched"
                                        )
                                    }
                                    className="w-full flex items-center justify-between px-4 py-3 hover:bg-white/5 transition-colors"
                                >
                                    <div className="flex items-center gap-2">
                                        <Check className="w-4 h-4 text-green-400" />
                                        <span className="text-sm font-medium text-white">
                                            {preview.summary.inLibrary} songs in
                                            your library
                                        </span>
                                    </div>
                                    {expandedSection === "matched" ? (
                                        <ChevronUp className="w-4 h-4 text-gray-500" />
                                    ) : (
                                        <ChevronDown className="w-4 h-4 text-gray-500" />
                                    )}
                                </button>
                                {expandedSection === "matched" && (
                                    <div className="border-t border-white/5 max-h-48 overflow-y-auto">
                                        {preview.matchedTracks
                                            .filter((m) => m.localTrack)
                                            .map((match, i) => (
                                                <div
                                                    key={
                                                        match.spotifyTrack
                                                            .spotifyId
                                                    }
                                                    className="flex items-center gap-3 px-4 py-2 hover:bg-white/5"
                                                >
                                                    <span className="text-xs text-gray-600 w-5 text-right">
                                                        {i + 1}
                                                    </span>
                                                    <div className="flex-1 min-w-0">
                                                        <div className="text-sm text-white truncate">
                                                            {match.localTrack
                                                                ?.title ||
                                                                match
                                                                    .spotifyTrack
                                                                    .title}
                                                        </div>
                                                        <div className="text-xs text-gray-500 truncate">
                                                            {match.localTrack
                                                                ?.artistName ||
                                                                match
                                                                    .spotifyTrack
                                                                    .artist}
                                                        </div>
                                                    </div>
                                                    <span className="text-xs text-gray-600">
                                                        {formatDuration(
                                                            match.spotifyTrack
                                                                .durationMs
                                                        )}
                                                    </span>
                                                </div>
                                            ))}
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Songs to download via Soulseek */}
                        {preview.summary.downloadable > 0 && (
                            <div className="bg-white/5 rounded-lg overflow-hidden">
                                <button
                                    onClick={() =>
                                        setExpandedSection(
                                            expandedSection === "download"
                                                ? null
                                                : "download"
                                        )
                                    }
                                    className="w-full flex items-center justify-between px-4 py-3 hover:bg-white/5 transition-colors"
                                >
                                    <div className="flex items-center gap-2">
                                        <Download className="w-4 h-4 text-spotify" />
                                        <span className="text-sm font-medium text-white">
                                            {preview.summary.downloadable} songs
                                            to download
                                        </span>
                                    </div>
                                    {expandedSection === "download" ? (
                                        <ChevronUp className="w-4 h-4 text-gray-500" />
                                    ) : (
                                        <ChevronDown className="w-4 h-4 text-gray-500" />
                                    )}
                                </button>
                                {expandedSection === "download" && (
                                    <div className="border-t border-white/5 max-h-48 overflow-y-auto">
                                        {preview.matchedTracks
                                            .filter((m) => !m.localTrack)
                                            .map((match, i) => (
                                                <div
                                                    key={
                                                        match.spotifyTrack
                                                            .spotifyId
                                                    }
                                                    className="flex items-center gap-3 px-4 py-2 hover:bg-white/5"
                                                >
                                                    <span className="text-xs text-gray-600 w-5 text-right">
                                                        {i + 1}
                                                    </span>
                                                    <div className="flex-1 min-w-0">
                                                        <div className="text-sm text-white truncate">
                                                            {
                                                                match.spotifyTrack
                                                                    .title
                                                            }
                                                        </div>
                                                        <div className="text-xs text-gray-500 truncate">
                                                            {
                                                                match.spotifyTrack
                                                                    .artist
                                                            }
                                                        </div>
                                                    </div>
                                                    <span className="text-xs text-gray-600">
                                                        {formatDuration(
                                                            match.spotifyTrack
                                                                .durationMs
                                                        )}
                                                    </span>
                                                </div>
                                            ))}
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Playlist name input */}
                        <div>
                            <label className="block text-sm font-medium text-gray-300 mb-2">
                                Playlist Name
                            </label>
                            <input
                                type="text"
                                value={playlistName}
                                onChange={(e) =>
                                    setPlaylistName(e.target.value)
                                }
                                placeholder="Enter playlist name"
                                className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-spotify/50 focus:border-spotify transition-colors"
                            />
                        </div>

                        {/* Action buttons */}
                        <div className="flex items-center gap-3 pt-2">
                            <button
                                onClick={() => {
                                    setStep("input");
                                    setPreview(null);
                                }}
                                className="px-6 py-3 rounded-full text-sm font-medium text-gray-300 hover:text-white hover:bg-white/5 transition-colors"
                            >
                                Back
                            </button>
                            <button
                                onClick={handleStartImport}
                                disabled={
                                    isLoading ||
                                    (preview.summary.inLibrary === 0 &&
                                        preview.summary.downloadable === 0)
                                }
                                className="flex-1 py-3 rounded-full font-medium bg-spotify text-black hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
                            >
                                {isLoading ? (
                                    <>
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                        Starting...
                                    </>
                                ) : preview.summary.downloadable > 0 ? (
                                    `Import ${preview.summary.inLibrary} songs + Download ${preview.summary.downloadable} songs`
                                ) : (
                                    `Import ${preview.summary.inLibrary} songs`
                                )}
                            </button>
                        </div>
                    </div>
                )}

                {/* Step: Importing */}
                {step === "importing" && importJob && (
                    <div className="text-center py-12">
                        <Loader2 className="w-10 h-10 text-spotify animate-spin mx-auto mb-4" />
                        <h2 className="text-lg font-bold text-white mb-1">
                            {importJob.status === "downloading"
                                ? "Downloading Songs"
                                : importJob.status === "scanning"
                                ? "Scanning Library"
                                : importJob.status === "creating_playlist" ||
                                  importJob.status === "matching_tracks"
                                ? "Creating Playlist"
                                : importJob.status === "pending"
                                ? "Waiting for Downloads"
                                : "Starting Import"}
                        </h2>
                        <p className="text-sm text-gray-400 mb-6">
                            {importJob.status === "downloading" && (
                                <>
                                    Searching + downloading via Soulseek ({importJob.albumsTotal} songs)
                                </>
                            )}
                            {importJob.status === "pending" && (
                                <>
                                    Waiting for{" "}
                                    {importJob.albumsTotal -
                                        importJob.albumsCompleted}{" "}
                                    downloads to complete
                                </>
                            )}
                            {importJob.status === "scanning" && (
                                <>
                                    Downloaded {importJob.albumsCompleted}/
                                    {importJob.albumsTotal} · Failed{" "}
                                    {Math.max(
                                        0,
                                        importJob.albumsTotal -
                                            importJob.albumsCompleted
                                    )}
                                </>
                            )}
                            {(importJob.status === "creating_playlist" ||
                                importJob.status === "matching_tracks") && (
                                <>Adding {importJob.tracksMatched} songs</>
                            )}
                        </p>
                        <div className="w-full max-w-xs mx-auto bg-white/10 rounded-full h-1.5">
                            <div
                                className="bg-spotify h-1.5 rounded-full transition-all duration-500"
                                style={{ width: `${importJob.progress}%` }}
                            />
                        </div>
                        <p className="text-xs text-gray-500 mt-3">
                            {importJob.progress}% complete • downloads continue
                            in the background
                        </p>
                        {/* Cancel button */}
                        <button
                            onClick={handleCancelImport}
                            disabled={isCancelling}
                            className="mt-6 px-5 py-2 rounded-full text-sm font-medium text-gray-400 hover:text-white hover:bg-white/10 border border-white/10 transition-colors disabled:opacity-50"
                        >
                            {isCancelling ? (
                                <>
                                    <Loader2 className="w-3 h-3 animate-spin inline mr-2" />
                                    Cancelling...
                                </>
                            ) : (
                                "Cancel Import"
                            )}
                        </button>
                        <p className="text-xs text-gray-600 mt-2">
                            Playlist will be created with tracks downloaded so
                            far
                        </p>
                    </div>
                )}

                {/* Step: Complete */}
                {step === "complete" && importJob && (
                    <div className="text-center py-12">
                        <div
                            className={
                                "w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-4 " +
                                (importJob.status === "failed"
                                    ? "bg-red-500"
                                    : importJob.status === "cancelled"
                                    ? "bg-amber-500"
                                    : "bg-spotify")
                            }
                        >
                            {importJob.status === "failed" || importJob.status === "cancelled" ? (
                                <X className="w-7 h-7 text-white" />
                            ) : (
                                <Check className="w-7 h-7 text-black" />
                            )}
                        </div>

                        <h2 className="text-lg font-bold text-white mb-1">
                            {importJob.status === "failed"
                                ? "Import Failed"
                                : importJob.status === "cancelled"
                                ? "Import Cancelled"
                                : "Import Complete"}
                        </h2>

                        {importJob.status === "failed" ? (
                            <p className="text-sm text-gray-400">
                                {importJob.error ||
                                    "Something went wrong while importing."}
                            </p>
                        ) : importJob.status === "cancelled" ? (
                            <p className="text-sm text-gray-400">
                                Import was cancelled. No playlist was created.
                            </p>
                        ) : (
                            <>
                                <p className="text-sm text-gray-400">
                                    {importJob.tracksMatched > 0
                                        ? `Added ${importJob.tracksMatched} songs to your playlist`
                                        : "Playlist created (songs still downloading)"}
                                </p>
                                {importJob.tracksDownloadable > 0 &&
                                    importJob.tracksMatched < importJob.tracksTotal && (
                                        <p className="text-sm text-amber-400 mt-2">
                                            {importJob.tracksDownloadable} songs still
                                            downloading
                                        </p>
                                    )}
                            </>
                        )}
                        <div className="flex items-center justify-center gap-3 mt-6">
                            <button
                                onClick={() => {
                                    setStep("input");
                                    setUrl("");
                                    setPreview(null);
                                    setImportJob(null);
                                    setRefreshStatusMessage(null);
                                }}
                                className="px-5 py-2.5 rounded-full text-sm font-medium text-gray-300 hover:text-white hover:bg-white/5 transition-colors"
                            >
                                Import Another
                            </button>
                            {importJob.tracksDownloadable > 0 &&
                                importJob.tracksMatched <
                                    importJob.tracksTotal && (
                                    <button
                                        onClick={async () => {
                                            try {
                                                setIsLoading(true);
                                                setRefreshStatusMessage(null);
                                                const result = await api.post<{
                                                    added: number;
                                                    total: number;
                                                }>(
                                                    `/spotify/import/${importJob.id}/refresh`,
                                                    {}
                                                );
                                                if (result.added > 0) {
                                                    setRefreshStatusMessage(
                                                        `Added ${result.added} new song(s).`
                                                    );
                                                    setImportJob((prev) =>
                                                        prev
                                                            ? {
                                                                  ...prev,
                                                                  tracksMatched:
                                                                      result.total,
                                                              }
                                                            : prev
                                                    );
                                                } else {
                                                    setRefreshStatusMessage(
                                                        "Albums still downloading. Try again later."
                                                    );
                                                }
                                            } catch {
                                                setRefreshStatusMessage(
                                                    "Failed to refresh."
                                                );
                                            } finally {
                                                setIsLoading(false);
                                            }
                                        }}
                                        disabled={isLoading}
                                        className="px-5 py-2.5 rounded-full text-sm font-medium bg-#0a0a0a text-white hover:bg-white/20 disabled:opacity-50 transition-colors"
                                    >
                                        {isLoading
                                            ? "Refreshing..."
                                            : "Refresh"}
                                    </button>
                                )}
                            {refreshStatusMessage && (
                                <p className="text-xs text-gray-500 mt-3">
                                    {refreshStatusMessage}
                                </p>
                            )}
                            {importJob.createdPlaylistId && (
                                <button
                                    onClick={() =>
                                        router.push(
                                            `/playlist/${importJob.createdPlaylistId}`
                                        )
                                    }
                                    className="px-5 py-2.5 rounded-full text-sm font-medium bg-spotify text-black hover:brightness-110 transition-all"
                                >
                                    View Playlist
                                </button>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

export default function SpotifyImportPage() {
    return (
        <Suspense
            fallback={
                <div className="min-h-screen flex items-center justify-center">
                    <Loader2 className="w-8 h-8 text-brand animate-spin" />
                </div>
            }
        >
            <SpotifyImportPageContent />
        </Suspense>
    );
}
