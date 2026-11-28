import { Directory } from 'expo-file-system';

/**
 * Save text as a file the person keeps: they choose the folder. Resolves `false`
 * when they back out of the folder picker.
 */
export async function saveTextFile(name: string, text: string, mimeType: string): Promise<boolean> {
  let directory: Directory;
  try {
    directory = await Directory.pickDirectoryAsync();
  } catch {
    return false;
  }
  directory.createFile(name, mimeType).write(text);
  return true;
}
