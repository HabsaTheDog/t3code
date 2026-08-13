export const RESTRICTED_HTML_FILE_PREVIEW_SANDBOX = "allow-scripts";

export const INTERACTIVE_HTML_FILE_PREVIEW_SANDBOX = "allow-modals allow-same-origin allow-scripts";

export function htmlFilePreviewSandbox(previewUrl: string, hostUrl: string): string {
  const previewOrigin = new URL(previewUrl, hostUrl).origin;
  const hostOrigin = new URL(hostUrl).origin;

  // Combining scripts with same-origin access is safe only while the preview
  // cannot reach its host frame and remove the remaining sandbox restrictions.
  return previewOrigin === hostOrigin
    ? RESTRICTED_HTML_FILE_PREVIEW_SANDBOX
    : INTERACTIVE_HTML_FILE_PREVIEW_SANDBOX;
}
