/**
 * fetch + JSON with a single 403 retry.
 *
 * Several GET endpoints (/api/plugins, /api/prompts, /api/worktrees, …) gate
 * on the in-memory file-access allow-list. That list is rebuilt from sessions
 * and only extended synchronously by /api/cwd/validate — so a request racing
 * the validate call (or fired right after a server restart wiped the list)
 * can 403 even though the folder is perfectly legitimate. Panel loads have no
 * retry, so the "Access denied" error used to stick on screen until a manual
 * reload/restart.
 *
 * fetchJsonWithRetry retries 403 once after a short delay (the sibling
 * validate lands within a few hundred ms) and rethrows everything else
 * (400/404/500/network) untouched.
 */
export async function fetchJsonWithRetry<T>(
  url: string,
  options?: { init?: RequestInit; delayMs?: number },
): Promise<T> {
  const { init, delayMs = 600 } = options ?? {};

  const attempt = async (): Promise<T> => {
    const res = await fetch(url, init);
    const body = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok || body.error) {
      throw Object.assign(new Error(body.error ?? `HTTP ${res.status}`), {
        status: res.status,
      });
    }
    return body;
  };

  try {
    return await attempt();
  } catch (error) {
    const status = (error as Error & { status?: number }).status;
    if (status !== 403) throw error;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return attempt();
  }
}
