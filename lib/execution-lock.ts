/**
 * CRON OVERLAP PROTECTION - PHASE 7
 * 
 * Prevents multiple cron cycles running simultaneously
 * Implements execution lock with watchdog timeout
 */

// ============================================================================
// EXECUTION LOCK - SINGLE CYCLE GUARANTEE
// ============================================================================

let executionLock = false;
let lockAcquiredAt = 0;
const LOCK_TIMEOUT_MS = 5 * 60_000; // 5 minute watchdog timeout

/**
 * Try to acquire execution lock
 * Returns true if lock acquired, false if already locked
 */
export function tryAcquireExecutionLock(): boolean {
  if (executionLock) {
    // Check if lock has timed out (stale lock recovery)
    const lockAge = Date.now() - lockAcquiredAt;
    if (lockAge > LOCK_TIMEOUT_MS) {
      console.warn(
        `[LOCK_TIMEOUT] Stale lock detected (${lockAge}ms > ${LOCK_TIMEOUT_MS}ms), recovering...`
      );
      executionLock = false;
      lockAcquiredAt = 0;
    } else {
      console.log(
        `[LOCK_BUSY] Execution already running (${lockAge}ms), skipping cycle`
      );
      return false;
    }
  }

  executionLock = true;
  lockAcquiredAt = Date.now();
  console.log("[LOCK_ACQUIRED] Execution cycle started");
  return true;
}

/**
 * Release execution lock
 */
export function releaseExecutionLock(): void {
  if (!executionLock) {
    console.warn("[LOCK_ERROR] Attempted to release lock that is not held");
    return;
  }

  const lockDuration = Date.now() - lockAcquiredAt;
  executionLock = false;
  lockAcquiredAt = 0;

  console.log(`[LOCK_RELEASED] Execution cycle completed (${lockDuration}ms)`);
}

/**
 * Check if currently locked
 */
export function isExecutionLocked(): boolean {
  return executionLock;
}

/**
 * Get lock status for debugging
 */
export function getExecutionLockStatus() {
  return {
    locked: executionLock,
    acquiredAt: lockAcquiredAt,
    ageMs: executionLock ? Date.now() - lockAcquiredAt : 0,
    timeoutMs: LOCK_TIMEOUT_MS,
  };
}
