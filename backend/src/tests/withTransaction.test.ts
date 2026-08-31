/**
 * Unit tests for the transaction retry helper (retryOnConflict / isRetryableTxError).
 * No database needed — the retry core is transaction-agnostic.
 *
 * Run with: npx tsx src/tests/withTransaction.test.ts
 */

import { Prisma } from "@prisma/client";
import { retryOnConflict, isRetryableTxError } from "../utils/withTransaction";

let failures = 0;
function assert(cond: boolean, msg: string) {
    if (cond) {
        console.log(`  ✓ ${msg}`);
    } else {
        failures++;
        console.error(`  ✗ ${msg}`);
    }
}

const noSleep = async () => {};
const p2034 = () =>
    new Prisma.PrismaClientKnownRequestError("write conflict", {
        code: "P2034",
        clientVersion: "test",
    });

async function main() {
    console.log("isRetryableTxError:");
    assert(isRetryableTxError(p2034()), "Prisma P2034 is retryable");
    assert(isRetryableTxError({ code: "40001" }), "pg 40001 serialization is retryable");
    assert(isRetryableTxError({ code: "40P01" }), "pg 40P01 deadlock is retryable");
    assert(
        isRetryableTxError(new Error("deadlock detected while updating")),
        "deadlock message is retryable"
    );
    assert(!isRetryableTxError(new Error("some other error")), "generic error is NOT retryable");
    assert(!isRetryableTxError({ code: "P2002" }), "unique-violation P2002 is NOT retryable");

    console.log("retryOnConflict:");

    // 1. Succeeds first try -> runs once.
    let calls = 0;
    const r1 = await retryOnConflict(async () => {
        calls++;
        return "ok";
    }, { sleepMs: noSleep });
    assert(r1 === "ok" && calls === 1, "returns value and runs once on success");

    // 2. Fails twice with P2034 then succeeds -> runs 3 times.
    calls = 0;
    const r2 = await retryOnConflict(
        async () => {
            calls++;
            if (calls < 3) throw p2034();
            return 42;
        },
        { sleepMs: noSleep }
    );
    assert(r2 === 42 && calls === 3, "retries transient conflicts then succeeds");

    // 3. Non-retryable error throws immediately (runs once).
    calls = 0;
    let threw = false;
    try {
        await retryOnConflict(async () => {
            calls++;
            throw new Error("fatal");
        }, { sleepMs: noSleep });
    } catch {
        threw = true;
    }
    assert(threw && calls === 1, "non-retryable error throws without retrying");

    // 4. Persistent conflict exhausts maxRetries (1 + maxRetries attempts).
    calls = 0;
    threw = false;
    try {
        await retryOnConflict(
            async () => {
                calls++;
                throw p2034();
            },
            { maxRetries: 3, sleepMs: noSleep }
        );
    } catch {
        threw = true;
    }
    assert(threw && calls === 4, "gives up after maxRetries (4 attempts for maxRetries=3)");

    console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
