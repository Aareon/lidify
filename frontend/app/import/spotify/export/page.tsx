"use client";

import { useState, useRef } from "react";
import Link from "next/link";
import { ArrowLeft, Upload, ListMusic, Loader2, Check, X } from "lucide-react";
import { api } from "@/lib/api";

interface OfflineTrack {
    title: string;
    artist: string;
    album: string | null;
    uri: string | null;
}
interface ParsedPlaylist {
    name: string;
    tracks: OfflineTrack[];
}
interface ImportResult {
    name: string;
    ok: boolean;
    summary?: { total: number; inLibrary: number; downloadable: number };
    error?: string;
}

/**
 * Parse a Spotify "Download your data" playlist export. The file looks like:
 *   { "playlists": [ { "name": "...", "items": [ { "track": { trackName, artistName, albumName, trackUri } } ] } ] }
 * Items with a null track (local files / episodes) are skipped.
 */
function parseSpotifyExport(json: unknown): ParsedPlaylist[] {
    const root = json as { playlists?: unknown[] };
    const playlists = Array.isArray(root?.playlists) ? root.playlists : [];
    return playlists
        .map((pl) => {
            const p = pl as { name?: string; items?: unknown[] };
            const items = Array.isArray(p?.items) ? p.items : [];
            const tracks: OfflineTrack[] = items
                .map((it) => (it as { track?: Record<string, string> })?.track)
                .filter((t): t is Record<string, string> => !!t)
                .map((t) => ({
                    title: t.trackName || "",
                    artist: t.artistName || "",
                    album: t.albumName || null,
                    uri: t.trackUri || null,
                }))
                .filter((t) => t.title && t.artist);
            return { name: p?.name || "Untitled Playlist", tracks };
        })
        .filter((p) => p.tracks.length > 0);
}

export default function SpotifyExportImportPage() {
    const fileRef = useRef<HTMLInputElement>(null);
    const [fileName, setFileName] = useState<string | null>(null);
    const [parseError, setParseError] = useState<string | null>(null);
    const [playlists, setPlaylists] = useState<ParsedPlaylist[] | null>(null);
    const [selected, setSelected] = useState<Set<number>>(new Set());
    const [skipDownload, setSkipDownload] = useState(false);

    const [importing, setImporting] = useState(false);
    const [progress, setProgress] = useState<{ current: number; total: number; name: string } | null>(null);
    const [results, setResults] = useState<ImportResult[]>([]);

    const handleFile = async (file: File) => {
        setParseError(null);
        setPlaylists(null);
        setResults([]);
        setFileName(file.name);
        try {
            const text = await file.text();
            const parsed = parseSpotifyExport(JSON.parse(text));
            if (parsed.length === 0) {
                setParseError(
                    "No playlists with matchable tracks found. Make sure this is the Playlist JSON from Spotify's 'Download your data' export."
                );
                return;
            }
            setPlaylists(parsed);
            setSelected(new Set(parsed.map((_, i) => i)));
        } catch {
            setParseError("Couldn't read this file as JSON. Pick your Spotify Playlist export (.json).");
        }
    };

    const toggle = (i: number) =>
        setSelected((prev) => {
            const next = new Set(prev);
            next.has(i) ? next.delete(i) : next.add(i);
            return next;
        });
    const allSelected = playlists ? selected.size === playlists.length : false;
    const toggleAll = () =>
        setSelected(allSelected ? new Set() : new Set((playlists || []).map((_, i) => i)));

    const runImport = async () => {
        if (!playlists) return;
        const chosen = playlists.filter((_, i) => selected.has(i));
        if (chosen.length === 0) return;

        setImporting(true);
        setResults([]);
        const out: ImportResult[] = [];
        for (let i = 0; i < chosen.length; i++) {
            const pl = chosen[i];
            setProgress({ current: i + 1, total: chosen.length, name: pl.name });
            try {
                const r = await api.post<{
                    jobId: string;
                    summary?: { total: number; inLibrary: number; downloadable: number; notFound: number };
                }>("/spotify/import/offline", {
                    playlistName: pl.name,
                    tracks: pl.tracks,
                    skipDownload,
                });
                out.push({ name: pl.name, ok: true, summary: r.summary });
            } catch (e) {
                out.push({ name: pl.name, ok: false, error: (e as Error)?.message || "Failed" });
            }
            setResults([...out]);
        }
        setProgress(null);
        setImporting(false);
    };

    const totalTracks = playlists
        ? playlists.filter((_, i) => selected.has(i)).reduce((s, p) => s + p.tracks.length, 0)
        : 0;

    return (
        <div className="min-h-screen bg-[#0a0a0a] text-white">
            <div className="max-w-3xl mx-auto px-4 py-8">
                <Link
                    href="/import/spotify"
                    className="inline-flex items-center gap-1.5 text-sm text-[#888] hover:text-white mb-6"
                >
                    <ArrowLeft className="w-4 h-4" /> Back to Spotify import
                </Link>

                <h1 className="text-2xl font-bold mb-1">Import from Spotify data export</h1>
                <p className="text-sm text-[#888] mb-6">
                    Rebuild all your playlists at once from Spotify&apos;s{" "}
                    <span className="text-[#aaa]">Account → Privacy → “Download your data”</span> export.
                    Upload the <code className="px-1 py-0.5 bg-[#262626] rounded text-xs">Playlist1.json</code> file — each
                    playlist is matched against your library, and missing tracks are queued for download.
                </p>

                {/* File picker */}
                <div
                    onClick={() => fileRef.current?.click()}
                    className="rounded-xl border border-dashed border-[#333] bg-[#111] hover:border-[#555]
                        cursor-pointer p-6 flex items-center gap-3 transition-colors"
                >
                    <Upload className="w-5 h-5 text-[#888]" />
                    <div className="text-sm">
                        <div className="text-white">{fileName || "Choose your Playlist JSON…"}</div>
                        <div className="text-xs text-[#666]">Parsed in your browser — nothing is uploaded until you import.</div>
                    </div>
                    <input
                        ref={fileRef}
                        type="file"
                        accept=".json,application/json"
                        className="hidden"
                        onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) handleFile(f);
                        }}
                    />
                </div>

                {parseError && <div className="mt-3 text-sm text-red-400">{parseError}</div>}

                {/* Playlist selection */}
                {playlists && (
                    <div className="mt-6">
                        <div className="flex items-center justify-between mb-3">
                            <button onClick={toggleAll} className="text-sm text-[#aaa] hover:text-white">
                                {allSelected ? "Deselect all" : "Select all"} · {selected.size}/{playlists.length} playlists · {totalTracks} tracks
                            </button>
                            <label className="flex items-center gap-2 text-sm text-[#aaa] cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={skipDownload}
                                    onChange={(e) => setSkipDownload(e.target.checked)}
                                    className="accent-white"
                                />
                                Match only (don&apos;t download missing)
                            </label>
                        </div>

                        <div className="space-y-1.5 max-h-[420px] overflow-y-auto pr-1">
                            {playlists.map((pl, i) => {
                                const r = results.find((x) => x.name === pl.name);
                                return (
                                    <label
                                        key={`${pl.name}-${i}`}
                                        className="flex items-center gap-3 rounded-lg border border-[#262626] bg-[#141414]
                                            px-3 py-2 cursor-pointer hover:border-[#333]"
                                    >
                                        <input
                                            type="checkbox"
                                            checked={selected.has(i)}
                                            onChange={() => toggle(i)}
                                            disabled={importing}
                                            className="accent-white"
                                        />
                                        <ListMusic className="w-4 h-4 text-[#666] flex-shrink-0" />
                                        <div className="flex-1 min-w-0">
                                            <div className="text-sm text-white truncate">{pl.name}</div>
                                            <div className="text-xs text-[#666]">{pl.tracks.length} tracks</div>
                                        </div>
                                        {r && (
                                            <div className="text-xs flex-shrink-0">
                                                {r.ok ? (
                                                    <span className="inline-flex items-center gap-1 text-green-400">
                                                        <Check className="w-3.5 h-3.5" />
                                                        {r.summary
                                                            ? `${r.summary.inLibrary} in library · ${r.summary.downloadable} to get`
                                                            : "Imported"}
                                                    </span>
                                                ) : (
                                                    <span className="inline-flex items-center gap-1 text-red-400">
                                                        <X className="w-3.5 h-3.5" /> {r.error}
                                                    </span>
                                                )}
                                            </div>
                                        )}
                                    </label>
                                );
                            })}
                        </div>

                        <div className="mt-5 flex items-center gap-3">
                            <button
                                onClick={runImport}
                                disabled={importing || selected.size === 0}
                                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-white text-black
                                    font-semibold hover:bg-white/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                            >
                                {importing ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                                {importing
                                    ? progress
                                        ? `Importing ${progress.current}/${progress.total}: ${progress.name}`
                                        : "Importing…"
                                    : `Import ${selected.size} playlist${selected.size === 1 ? "" : "s"}`}
                            </button>
                            {results.length > 0 && !importing && (
                                <Link href="/import/spotify" className="text-sm text-[#aaa] hover:text-white">
                                    View import progress →
                                </Link>
                            )}
                        </div>

                        {results.length > 0 && !importing && (
                            <div className="mt-4 text-sm text-[#888]">
                                Done — {results.filter((r) => r.ok).length}/{results.length} playlists started.
                                Downloads for missing tracks continue in the background; watch them on the{" "}
                                <Link href="/import/spotify" className="text-white underline">
                                    Spotify import
                                </Link>{" "}
                                page.
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
