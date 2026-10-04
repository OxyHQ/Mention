# Original authority and bounded SQL maintenance

The SDK decision POST now takes the optional delegated user from the same validated, frozen authority used by receipt recovery. Mutating the caller input cannot change either attribution. The unchanged SDK transport fixture reproduces the missing delegated POST header on the old source and proves exactly one POST followed by one GET after the fix, including the undelegated control.

Receipt maintenance now owns one canonical private database connection per cycle, with an absolute deadline. Server timeouts bound lock waits; cancellation forcibly closes this private connection, pending connection startup and queued statements. The ordinary classifier pool is untouched. Every repository boundary checks the original deadline, and persistence retains its row lock and transaction.

Two unchanged PostgreSQL fixtures hold an ACCESS EXCLUSIVE table lock or a row lock: old source misses the configured deadline, while corrected source completes ordinary classification before either lock is released and writes no receipt afterward. Additional controls cover cancellation of a queued mutation and a TCP connection whose server never completes the handshake.

Final validation:120 tests in three focal suites;214 in twelve related suites; backend build and92 inference-boundary controls pass. Owned PostgreSQL processes are stopped. Setup/fixture/type errors are preserved separately. The installed SDK is a byte-verified local candidate; public-registry adoption, CI and rollout remain pending.
