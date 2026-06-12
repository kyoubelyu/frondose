/**
 * P-11 / D-6 / D-21: download Telegram inbound media to FRONDOSE_UPLOAD_ALLOWLIST.
 * Two-step flow (getFile → binary). 20 MB hard cap. Filename collision policy:
 *   {YYYYMMDD_HHmmss}_{file_unique_id_last8}.{ext}
 *
 * No `child_process` import (lint-enforced under src/tools/**); pure node:fs + transport.
 *
 * CMR-2 fix (Step 3b): 5-param signature — `fileUniqueId` is the 3rd param,
 * used for filename collision suffix (Telegram's stable per-file identifier).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const MAX_GETFILE_BYTES = 20 * 1024 * 1024;

export interface DownloadResult {
  localPath: string;
  mimeType: string | null;
}

export type Transport = (url: string, init?: RequestInit) => Promise<Response>;

export async function downloadTelegramFile(
  token: string,
  fileId: string,
  fileUniqueId: string,
  allowlistRoot: string,
  transport: Transport,
): Promise<DownloadResult> {
  // Step 1: getFile
  const infoResp = await transport(`https://api.telegram.org/bot${token}/getFile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: fileId }),
  });
  const info = (await infoResp.json()) as {
    ok: boolean;
    result?: { file_path: string; file_size?: number };
    description?: string;
  };
  if (!info.ok || !info.result) {
    throw new Error(`getFile failed: ${info.description ?? JSON.stringify(info)}`);
  }
  if (info.result.file_size && info.result.file_size > MAX_GETFILE_BYTES) {
    throw new Error(`file exceeds 20 MB getFile limit (${info.result.file_size} bytes)`);
  }
  // Step 2: binary download
  const fileUrl = `https://api.telegram.org/file/bot${token}/${info.result.file_path}`;
  const fileResp = await transport(fileUrl);
  if (!fileResp.ok) {
    throw new Error(`binary download failed: HTTP ${fileResp.status}`);
  }
  const bytes = Buffer.from(await fileResp.arrayBuffer());
  // Write under allowlist
  const ext = path.extname(info.result.file_path) || "";
  const ts = new Date()
    .toISOString()
    .replace(/[:.\-T]/g, "")
    .slice(0, 14);
  const uniq8 = fileUniqueId.replace(/[^a-zA-Z0-9_-]/g, "").slice(-8);
  const filename = `${ts}_${uniq8}${ext}`;
  const targetDir = path.join(allowlistRoot, "telegram-inbox");
  mkdirSync(targetDir, { recursive: true });
  const localPath = path.join(targetDir, filename);
  writeFileSync(localPath, bytes);
  return { localPath, mimeType: fileResp.headers.get("content-type") };
}

/** Map a Telegram update message field to the canonical user-message tag. */
export function mediaTagFor(field: string, localPath: string): string {
  const map: Record<string, string> = {
    photo: "TG_PHOTO",
    voice: "TG_VOICE",
    document: "TG_DOCUMENT",
    audio: "TG_AUDIO",
    video: "TG_VIDEO",
    video_note: "TG_VIDEONOTE",
    sticker: "TG_STICKER",
    animation: "TG_ANIMATION",
  };
  const tag = map[field] ?? "TG_FILE";
  return `[${tag}=${localPath}]`;
}
