/** The path of the notes of one app version, under the manifest's base_url. */
export const notesPath = (app: string, version: string) =>
  `/api/apps/${app}/releases/${encodeURIComponent(version)}/notes`;
