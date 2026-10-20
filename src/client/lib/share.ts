/** ファイルを保存する。iPhone では共有シート (「ファイルに保存」等) を出す */
export async function saveFile(blob: Blob, name: string, title: string) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    await navigator.share({ files: [file], title }).catch(() => {});
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const today = () => new Date().toISOString().slice(0, 10);
