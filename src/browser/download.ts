import type { Download, Page } from "playwright";

/** Keep the click inside the serialized tool lifetime, even if the download wait fails first. */
export async function clickDownload(
  page: Page,
  click: () => Promise<void>,
  timeout: number,
): Promise<Download> {
  const observed: Download[] = [];
  let resolveDownload!: (download: Download) => void;
  let rejectDownload!: (error: Error) => void;
  const waiting = new Promise<Download>((resolve, reject) => {
    resolveDownload = resolve;
    rejectDownload = reject;
  });
  const record = (download: Download) => {
    observed.push(download);
    resolveDownload(download);
  };
  const closed = () => rejectDownload(new Error("Page closed while waiting for download"));
  const timer = setTimeout(
    () => rejectDownload(new Error(`Download timed out after ${timeout}ms`)),
    timeout,
  );
  page.on("download", record);
  page.on("close", closed);
  try {
    const [event, action] = await Promise.allSettled([
      waiting,
      Promise.resolve()
        .then(click)
        .catch((error) => {
          rejectDownload(error);
          throw error;
        }),
    ]);
    if (action.status === "rejected") throw action.reason;
    if (event.status === "rejected") throw event.reason;
    if (observed.length !== 1) throw new Error("Download control must produce exactly one file");
    return event.value;
  } catch (error) {
    for (const download of observed) {
      await download.cancel();
      await download.delete();
    }
    throw error;
  } finally {
    clearTimeout(timer);
    page.off("download", record);
    page.off("close", closed);
  }
}
