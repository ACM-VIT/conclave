package conclave.module

import kotlinx.coroutines.CompletableDeferred

/**
 * Runs one operation at a time: a caller that arrives while another runs waits for it to finish, then runs.
 * Producer starts suspend for the SFU acknowledgement, so two overlapping starts would otherwise share the
 * same capture and close each other's producer. Every method is called from the main thread.
 */
internal class SingleFlightGate {
    private var inFlight: CompletableDeferred<Unit>? = null

    suspend fun <T> run(operation: suspend () -> T): T {
        while (true) {
            val running = inFlight ?: break
            running.await()
        }
        val gate = CompletableDeferred<Unit>()
        inFlight = gate
        try {
            return operation()
        } finally {
            if (inFlight === gate) inFlight = null
            gate.complete(Unit)
        }
    }

    /** A replaced session's starts no longer hold back the new session's. */
    fun reset() {
        inFlight = null
    }
}
