/** A non-2xx response; carries the status so callers can react to specific codes. */
export class UploadRejectedError extends Error {
  constructor(
    readonly status: number,
    detail?: string,
  ) {
    super(detail ?? `Upload rejected (${status})`);
  }
}

// The server answers rejections with a short plain-text reason. Anything else
// (an empty body, a proxy's HTML error page) falls back to the generic text.
function rejectionDetail(xhr: XMLHttpRequest): string | undefined {
  try {
    const text = typeof xhr.responseText === "string" ? xhr.responseText.trim() : "";
    return text !== "" && text.length <= 200 && !text.startsWith("<") ? text : undefined;
  } catch {
    return undefined;
  }
}

export function uploadXhr(input: {
  readonly url: string;
  readonly file: File;
  readonly contentType?: string;
  readonly timeoutMs: number;
  readonly onProgress: (progress: number) => void;
}): { readonly done: Promise<void>; readonly abort: () => void } {
  const xhr = new XMLHttpRequest();
  const done = new Promise<void>((resolve, reject) => {
    xhr.open("POST", input.url, true);
    xhr.timeout = input.timeoutMs;
    if (input.contentType !== undefined) {
      xhr.setRequestHeader("Content-Type", input.contentType);
    }
    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable && event.total > 0) {
        input.onProgress(event.loaded / event.total);
      }
    });
    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new UploadRejectedError(xhr.status, rejectionDetail(xhr)));
      }
    });
    xhr.addEventListener("error", () => reject(new Error("Upload failed")));
    xhr.addEventListener("timeout", () => reject(new Error("Upload timed out")));
    xhr.addEventListener("abort", () => reject(new Error("Upload cancelled")));
    xhr.send(input.file);
  });

  return { done, abort: () => xhr.abort() };
}
