import { Prisma } from "@prisma/client";
import { prisma } from "./db";

/**
 * Postgres/Prisma errors that are safe to retry: a write conflict or deadlock
 * means the transaction was rolled back cleanly and can simply be re-run.
 *
 * - Prisma `P2034`: "Transaction failed due to a write conflict or a deadlock"
 * - Postgres `40001`: serialization_failure
 * - Postgres `40P01`: deadlock_detected
 */
export function isRetryableTxError(err: unknown): boolean {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2034") {
        return true;
    }
    const anyErr = err as any;
    const pgCode = String(anyErr?.code ?? anyErr?.meta?.code ?? "");
    if (pgCode === "40001" || pgCode === "40P01") return true;
    const msg = String(anyErr?.message ?? "");
    return /deadlock detected|could not serialize access|write conflict/i.test(msg);
}

export interface WithTransactionOptions {
    /** Max retry attempts after the first try (default 5). */
    maxRetries?: number;
    /** Interactive-transaction timeout in ms (default 15000). */
    timeout?: number;
    /** Interactive-transaction max wait to acquire a connection, ms (default 5000). */
    maxWait?: number;
    /** Optional isolation level; omit to use the database default (Read Committed). */
    isolationLevel?: Prisma.TransactionIsolationLevel;
    /** Short label for retry logs. */
    label?: string;
}

/**
 * Run `fn` inside a Prisma interactive transaction, automatically retrying the
 * WHOLE transaction with exponential backoff + jitter when it fails due to a
 * write conflict or deadlock. Non-retryable errors propagate immediately.
 *
 * Use for read-modify-write sequences that can race (e.g. download-job status
 * transitions driven by webhooks + timeouts + user actions at once). `fn`
 * MUST be idempotent/side-effect-free outside the passed `tx`, since it may run
 * more than once — do NOT send notifications or emit events inside it.
 */
/**
 * Retry `run` with exponential backoff + jitter while it throws a retryable
 * write-conflict/deadlock error. Transaction-agnostic core (testable without a
 * DB); `withTransaction` builds on it.
 */
export async function retryOnConflict<T>(
    run: () => Promise<T>,
    opts: { maxRetries?: number; label?: string; sleepMs?: (ms: number) => Promise<void> } = {}
): Promise<T> {
    const maxRetries = opts.maxRetries ?? 5;
    const sleep =
        opts.sleepMs ??
        ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    let attempt = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
        try {
            return await run();
        } catch (err) {
            attempt++;
            if (attempt > maxRetries || !isRetryableTxError(err)) {
                throw err;
            }
            const backoff =
                Math.min(1000, 50 * 2 ** (attempt - 1)) + Math.random() * 50;
            const code =
                (err as any)?.code ?? (err as any)?.message ?? "conflict";
            console.warn(
                `[withTransaction${opts.label ? `:${opts.label}` : ""}] ` +
                    `retry ${attempt}/${maxRetries} after ${Math.round(
                        backoff
                    )}ms (${code})`
            );
            await sleep(backoff);
        }
    }
}

export async function withTransaction<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    opts: WithTransactionOptions = {}
): Promise<T> {
    return retryOnConflict(
        () =>
            prisma.$transaction(fn, {
                timeout: opts.timeout ?? 15000,
                maxWait: opts.maxWait ?? 5000,
                ...(opts.isolationLevel
                    ? { isolationLevel: opts.isolationLevel }
                    : {}),
            }),
        { maxRetries: opts.maxRetries, label: opts.label }
    );
}
