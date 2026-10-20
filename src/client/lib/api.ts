import type { HealthInfo, OcrJob, UploadMode, Warlord, WarlordInput } from "../../shared/types.ts";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* JSON でないエラー本文は無視 */
    }
    throw new Error(message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const api = {
  health: () => request<HealthInfo>("/api/health"),
  warlords: () => request<Warlord[]>("/api/warlords"),
  createWarlord: (input: Partial<WarlordInput>) => request<Warlord>("/api/warlords", json("POST", input)),
  updateWarlord: (id: string, input: Partial<WarlordInput>) => request<Warlord>(`/api/warlords/${id}`, json("PUT", input)),
  deleteWarlord: (id: string) => request<void>(`/api/warlords/${id}`, { method: "DELETE" }),
  jobs: () => request<OcrJob[]>("/api/jobs"),
  retryJob: (id: string) => request<OcrJob>(`/api/jobs/${id}/retry`, { method: "POST" }),
  clearFinishedJobs: () => request<void>("/api/jobs/finished", { method: "DELETE" }),
  importData: (payload: unknown, mode: "merge" | "replace") =>
    request<{ created: number; updated: number; errors: string[] }>(`/api/import?mode=${mode}`, json("POST", payload)),

  /** 進捗を取得できるよう XHR でアップロードする */
  upload(files: File[], mode: UploadMode, targetId: string | null, onProgress: (ratio: number) => void) {
    return new Promise<OcrJob[]>((resolve, reject) => {
      const form = new FormData();
      for (const f of files) form.append("files", f);
      form.append("mode", mode);
      if (targetId) form.append("target_id", targetId);
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/uploads");
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onload = () => {
        try {
          const body = JSON.parse(xhr.responseText);
          if (xhr.status >= 200 && xhr.status < 300) resolve(body as OcrJob[]);
          else reject(new Error(body.error ?? `アップロードに失敗しました (${xhr.status})`));
        } catch {
          reject(new Error(`アップロードに失敗しました (${xhr.status})`));
        }
      };
      xhr.onerror = () => reject(new Error("サーバーに接続できませんでした"));
      xhr.send(form);
    });
  },
};
