/**
 * Save text as a file the person keeps, through the browser's own download. The
 * web fork of `saveTextFile.ts`, so the web bundle carries no `expo-file-system`.
 */
export async function saveTextFile(name: string, text: string, mimeType: string): Promise<boolean> {
  const url = URL.createObjectURL(new Blob([text], { type: mimeType }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoking at once can cancel the download the click has only just queued.
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}
